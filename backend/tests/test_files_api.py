"""The files API: multipart upload with sha256 verification, replace behind the
same link, versions, restore, quota and cleanup. R2 is FakeR2 (in memory)."""

from __future__ import annotations

import asyncio
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from tests._files_env import KB, MB, FilesTestCase, settings, sha

from app.services import file_uploads, file_versions

VIDEO = b"\x00\x00\x00\x18ftypmp42" + bytes(range(256)) * 40  # ~10 KB of "video"


def blob(tag: str, size: int = 4 * KB) -> bytes:
    return (tag.encode() * (size // len(tag) + 1))[:size]


class Presign(unittest.TestCase):
    """The real boto3 presigner (local HMAC, no network) with dummy credentials."""

    def test_part_url_signs_only_the_host(self):
        from urllib.parse import parse_qs, urlsplit

        from app.services import r2

        dummy = {"r2_account_id": "acct", "r2_access_key_id": "AKIDTEST", "r2_secret_access_key": "secret",
                 "r2_bucket": "bucket"}
        with mock.patch.multiple(settings, **dummy):
            r2._client.cache_clear()
            try:
                url = r2.presign_upload_part("art/u/x.mp4", "UPLOAD123", 7, 3600)
            finally:
                r2._client.cache_clear()
        q = parse_qs(urlsplit(url).query)
        self.assertEqual((q["partNumber"], q["uploadId"]), (["7"], ["UPLOAD123"]))
        self.assertEqual(q["X-Amz-SignedHeaders"], ["host"])  # no Content-Type to match
        self.assertEqual(q["X-Amz-Expires"], ["3600"])
        self.assertTrue(urlsplit(url).netloc.startswith("acct.r2.cloudflarestorage.com"))


class Upload(FilesTestCase):
    async def test_new_file_single_part(self):
        r = await self.start(VIDEO, "Launch Demo.mp4", title="Launch demo")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(set(body), {"upload_id", "part_size", "parts", "expires_at"})
        self.assertEqual(body["part_size"], 32 * MB)
        self.assertEqual([p["part_number"] for p in body["parts"]], [1])
        self.assertIn("partNumber=1", body["parts"][0]["url"])
        parts = await self.send_parts(body["upload_id"], VIDEO)
        r = await self.http.post(f"/api/v1/files/uploads/{body['upload_id']}/complete",
                                 json={"parts": parts}, headers=self.auth)
        self.assertEqual(r.status_code, 200, r.text)
        res = r.json()
        self.assertEqual(set(res), {"url", "markdrop_url", "workspace_url", "workspace_error", "slug",
                                    "version", "size_bytes", "content_type", "sha256"})
        self.assertEqual((res["markdrop_url"], res["workspace_url"], res["workspace_error"]),
                         ("https://markdrop.in/launch-demo", None, None))
        self.assertEqual(res["slug"], "launch-demo")
        self.assertEqual(res["url"], "https://markdrop.in/launch-demo")
        self.assertEqual((res["version"], res["size_bytes"], res["content_type"], res["sha256"]),
                         (1, len(VIDEO), "video/mp4", sha(VIDEO)))

        raw = await self.doc("launch-demo")
        self.assertEqual((raw["kind"], raw["owner_id"], raw["title"], raw["access_level"]),
                         ("artifact", self.user_id, "Launch demo", "link"))
        self.assertEqual((raw["sha256"], raw["file_version"], raw["size_bytes"]), (sha(VIDEO), 1, len(VIDEO)))
        self.assertTrue(self.r2.objects[raw["blob_key"]]["public"])
        self.assertEqual(self.r2.objects[raw["blob_key"]]["data"], VIDEO)
        rows = await self.rows("launch-demo")
        self.assertEqual([(r["version"], r["sha256"]) for r in rows], [(1, sha(VIDEO))])
        ev = await self.db["file_events"].find_one({"slug": "launch-demo"})
        self.assertEqual((ev["action"], ev["new_sha256"], ev["version"]), ("upload", sha(VIDEO), 1))
        self.assertEqual(self.probed[0][1:], (1, raw["blob_key"], "video/mp4"))

        # Idempotent: completing again returns the same result.
        r = await self.http.post(f"/api/v1/files/uploads/{body['upload_id']}/complete",
                                 json={"parts": parts}, headers=self.auth)
        self.assertEqual((r.status_code, r.json()), (200, res))
        st = (await self.http.get(f"/api/v1/files/uploads/{body['upload_id']}", headers=self.auth)).json()
        self.assertEqual((st["state"], st["result"]), ("done", res))

    async def test_multipart_resume_with_status_and_fresh_urls(self):
        data = blob("abcdefg", 2 * KB + 100)
        with mock.patch.object(file_uploads, "MIN_PART", KB), \
                mock.patch.object(settings, "file_part_size", KB):
            self.r2.min_part = KB
            r = await self.start(data, "clip.webm", content_type="video/webm")
            self.assertEqual(r.status_code, 200, r.text)
            up = r.json()
            self.assertEqual((up["part_size"], len(up["parts"])), (KB, 3))
            await self.send_parts(up["upload_id"], data, numbers=[1, 3])

            st = (await self.http.get(f"/api/v1/files/uploads/{up['upload_id']}", headers=self.auth)).json()
            self.assertEqual(st["state"], "uploading")
            self.assertEqual([p["part_number"] for p in st["parts_uploaded"]], [1, 3])
            self.assertEqual((st["size_bytes"], st["part_size"], st["part_count"]), (len(data), KB, 3))
            self.assertIsNone(st["target_slug"])
            self.assertIsNone(st["result"])

            # No body: URLs for the parts storage hasn't got yet.
            r = await self.http.post(f"/api/v1/files/uploads/{up['upload_id']}/urls", headers=self.auth)
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual([p["part_number"] for p in r.json()["parts"]], [2])
            r = await self.http.post(f"/api/v1/files/uploads/{up['upload_id']}/urls",
                                     json={"part_numbers": [1, 2]}, headers=self.auth)
            self.assertEqual([p["part_number"] for p in r.json()["parts"]], [1, 2])
            r = await self.http.post(f"/api/v1/files/uploads/{up['upload_id']}/urls",
                                     json={"part_numbers": [4]}, headers=self.auth)
            self.assertEqual(r.status_code, 422)

            await self.send_parts(up["upload_id"], data, numbers=[2])
            # Parts omitted: the server uses what storage received.
            r = await self.http.post(f"/api/v1/files/uploads/{up['upload_id']}/complete", headers=self.auth)
            self.assertEqual(r.status_code, 200, r.text)
            raw = await self.doc(r.json()["slug"])
            self.assertEqual(self.r2.objects[raw["blob_key"]]["data"], data)

    async def test_cli_contract_api_token_and_quoted_etags(self):
        """What the CLI relies on: an mdk_ API token works (and /auth/me accepts
        it), ETags may arrive quoted exactly as R2 returned them, and part URLs
        aren't signed for a Content-Type."""
        from app.services import api_token

        raw, _ = await api_token.create_token(self.db, self.user_id, "cli")
        cli = {"Authorization": f"Bearer {raw}"}
        me = await self.http.get("/api/v1/auth/me", headers=cli)
        self.assertEqual((me.status_code, me.json()["email"]), (200, "priya@example.com"))
        r = await self.start(VIDEO, "cli.mp4", auth=cli)
        self.assertEqual(r.status_code, 200, r.text)
        up = r.json()
        self.assertNotIn("Content-Type", up["parts"][0]["url"])
        parts = [{"part_number": p["part_number"], "etag": f'"{p["etag"]}"'}
                 for p in await self.send_parts(up["upload_id"], VIDEO)]
        r = await self.http.post(f"/api/v1/files/uploads/{up['upload_id']}/complete",
                                 json={"parts": parts}, headers=cli)
        self.assertEqual(r.status_code, 200, r.text)
        r = await self.http.post(f"/api/v1/files/uploads/{up['upload_id']}/urls", headers=cli)
        self.assertEqual(r.status_code, 409)
        self.assertIn("detail", r.json())

    async def test_same_request_again_reuses_the_session(self):
        a = (await self.start(VIDEO)).json()
        b = (await self.start(VIDEO)).json()
        self.assertEqual(a["upload_id"], b["upload_id"])
        c = (await self.start(VIDEO, title="Other title")).json()
        self.assertNotEqual(a["upload_id"], c["upload_id"])

    async def test_sha256_mismatch_changes_nothing(self):
        r = await self.start(VIDEO, digest="0" * 64)
        up = r.json()
        parts = await self.send_parts(up["upload_id"], VIDEO)
        r = await self.http.post(f"/api/v1/files/uploads/{up['upload_id']}/complete",
                                 json={"parts": parts}, headers=self.auth)
        self.assertEqual(r.status_code, 422, r.text)
        self.assertIn("sha256 mismatch", r.json()["detail"])
        sess = await self.session(up["upload_id"])
        self.assertEqual(sess["state"], "failed")
        self.assertIn(sess["key"], self.r2.deleted)
        self.assertNotIn(sess["key"], self.r2.objects)
        self.assertEqual(await self.db["documents"].count_documents({}), 0)
        st = (await self.http.get(f"/api/v1/files/uploads/{up['upload_id']}", headers=self.auth)).json()
        self.assertEqual(st["state"], "failed")
        self.assertIn("sha256 mismatch", st["error"])
        # Calling complete again reports the same failure.
        r = await self.http.post(f"/api/v1/files/uploads/{up['upload_id']}/complete", headers=self.auth)
        self.assertEqual(r.status_code, 422)

    async def test_size_mismatch(self):
        r = await self.start(VIDEO, size=len(VIDEO) + 1)
        up = r.json()
        parts = await self.send_parts(up["upload_id"], VIDEO)
        r = await self.http.post(f"/api/v1/files/uploads/{up['upload_id']}/complete",
                                 json={"parts": parts}, headers=self.auth)
        self.assertEqual(r.status_code, 422, r.text)
        self.assertIn("declared", r.json()["detail"])
        self.assertEqual(await self.db["documents"].count_documents({}), 0)

    async def test_bad_parts(self):
        data = blob("xyz", 2 * KB + 1)
        with mock.patch.object(file_uploads, "MIN_PART", KB), \
                mock.patch.object(settings, "file_part_size", KB):
            self.r2.min_part = KB
            up = (await self.start(data, "a.mp4")).json()
            parts = await self.send_parts(up["upload_id"], data)
            r = await self.http.post(f"/api/v1/files/uploads/{up['upload_id']}/complete",
                                     json={"parts": parts[:2]}, headers=self.auth)
            self.assertEqual(r.status_code, 422)
            self.assertIn("missing part(s) [3]", r.json()["detail"])
            wrong = [dict(p) for p in parts]
            wrong[1]["etag"] = "deadbeef"
            r = await self.http.post(f"/api/v1/files/uploads/{up['upload_id']}/complete",
                                     json={"parts": wrong}, headers=self.auth)
            self.assertEqual(r.status_code, 400, r.text)
            self.assertIn("InvalidPart", r.json()["detail"])
            self.assertEqual((await self.session(up["upload_id"]))["state"], "uploading")
            r = await self.http.post(f"/api/v1/files/uploads/{up['upload_id']}/complete",
                                     json={"parts": parts}, headers=self.auth)
            self.assertEqual(r.status_code, 200, r.text)

    async def test_verifying_then_poll(self):
        self.r2.hash_delay = 0.4
        with mock.patch.object(settings, "file_complete_wait_seconds", 0.05):
            up = (await self.start(VIDEO)).json()
            parts = await self.send_parts(up["upload_id"], VIDEO)
            r = await self.http.post(f"/api/v1/files/uploads/{up['upload_id']}/complete",
                                     json={"parts": parts}, headers=self.auth)
            self.assertEqual(r.status_code, 202, r.text)
            self.assertEqual(r.json(), {"state": "verifying", "upload_id": up["upload_id"]})
            # A second complete while verifying is also a 202, not a second verification.
            r = await self.http.post(f"/api/v1/files/uploads/{up['upload_id']}/complete",
                                     json={"parts": parts}, headers=self.auth)
            self.assertEqual(r.status_code, 202)
            for _ in range(50):
                st = (await self.http.get(f"/api/v1/files/uploads/{up['upload_id']}", headers=self.auth)).json()
                if st["state"] != "verifying":
                    break
                self.assertIn("verified_bytes", st)
                await asyncio.sleep(0.05)
            self.assertEqual(st["state"], "done")
            self.assertEqual(st["result"]["version"], 1)
            r = await self.http.post(f"/api/v1/files/uploads/{up['upload_id']}/complete", headers=self.auth)
            self.assertEqual((r.status_code, r.json()), (200, st["result"]))
        self.assertEqual(await self.db["documents"].count_documents({}), 1)

    async def test_stalled_verification_is_resumed(self):
        up = (await self.start(VIDEO)).json()
        parts = await self.send_parts(up["upload_id"], VIDEO)
        # As if the server died mid-verification: parts stitched, state stuck.
        sess = await self.session(up["upload_id"])
        self.r2.complete_multipart(sess["key"], sess["r2_upload_id"], parts)
        old = datetime.now(timezone.utc) - timedelta(minutes=10)
        await self.db["file_uploads"].update_one({"_id": up["upload_id"]}, {"$set": {
            "state": "verifying", "heartbeat_at": old, "verify_started_at": old, "complete_parts": parts}})
        r = await self.http.get(f"/api/v1/files/uploads/{up['upload_id']}", headers=self.auth)
        self.assertEqual(r.json()["state"], "verifying")
        for _ in range(50):
            await asyncio.sleep(0.02)
            if (await self.session(up["upload_id"]))["state"] == "done":
                break
        self.assertEqual((await self.session(up["upload_id"]))["state"], "done")

    async def test_type_size_and_quota_refusals(self):
        r = await self.start(b"x", "tool.exe", content_type="application/x-msdownload")
        self.assertEqual(r.status_code, 415)
        r = await self.start(b"x", "site.zip", content_type="application/zip")
        self.assertEqual(r.status_code, 415)
        r = await self.start(b"x", "big.mp4", size=2 * 1024 ** 3 + 1)
        self.assertEqual(r.status_code, 413)
        self.assertIn("2 GB", r.json()["detail"])
        r = await self.start(b"x", "ok.mp4", size=2 * 1024 ** 3)
        self.assertEqual(r.status_code, 200, r.text)
        r = await self.start(b"x", "doc.pdf", content_type="application/pdf", size=settings.artifact_max_bytes + 1)
        self.assertEqual(r.status_code, 413)
        r = await self.start(b"x", "song.mp3", content_type="audio/mpeg", size=600 * MB)
        self.assertEqual(r.status_code, 200, r.text)
        with mock.patch.object(settings, "artifact_user_quota_bytes", 10 * KB):
            r = await self.start(b"x", "huge.mp4", size=11 * KB)
            self.assertEqual(r.status_code, 507)
            self.assertIn("quota", r.json()["detail"])
        r = await self.start(b"x", "a.mp4", digest="nothex")
        self.assertEqual(r.status_code, 422)
        r = await self.start(b"x", "a.mp4", access="password")
        self.assertEqual(r.status_code, 422)
        r = await self.start(b"x", "a.mp4", access="workspace")
        self.assertEqual(r.status_code, 422)
        r = await self.start(b"x", "a.mp4", access="private", password="pw")
        self.assertEqual(r.status_code, 422)
        r = await self.http.post("/api/v1/files/uploads", json={"file_name": "a.mp4", "size_bytes": 1,
                                                                "sha256": sha(b"x")})
        self.assertEqual(r.status_code, 401)

    async def test_private_and_password_uploads(self):
        res = await self.upload(VIDEO, "secret.mp4", access="private")
        raw = await self.doc(res["slug"])
        self.assertEqual(raw["access_level"], "private")
        self.assertFalse(self.r2.objects[raw["blob_key"]]["public"])
        info = (await self.http.get(f"/api/v1/files/{res['slug']}", headers=self.auth)).json()
        self.assertEqual(info["access"], "private")
        self.assertIn("?t=", info["download_url"])

        res = await self.upload(blob("pw"), "pw.mp4", access="password", password="hunter2")
        raw = await self.doc(res["slug"])
        self.assertEqual(raw["access_level"], "link")
        self.assertTrue(raw["read_password_hash"])
        self.assertFalse(self.r2.objects[raw["blob_key"]]["public"])

    async def test_sessions_are_private_and_expire(self):
        up = (await self.start(VIDEO)).json()
        for method, path in (("get", ""), ("post", "/complete"), ("post", "/urls"), ("delete", "")):
            r = await getattr(self.http, method)(f"/api/v1/files/uploads/{up['upload_id']}{path}",
                                                 headers=self.other_auth)
            self.assertEqual(r.status_code, 404, (method, path))
        sess = await self.session(up["upload_id"])
        await self.db["file_uploads"].update_one(
            {"_id": up["upload_id"]}, {"$set": {"expires_at": datetime.now(timezone.utc) - timedelta(seconds=1)}})
        st = (await self.http.get(f"/api/v1/files/uploads/{up['upload_id']}", headers=self.auth)).json()
        self.assertEqual(st["state"], "expired")
        self.assertIn(sess["r2_upload_id"], self.r2.aborted)
        r = await self.http.post(f"/api/v1/files/uploads/{up['upload_id']}/urls", headers=self.auth)
        self.assertEqual(r.status_code, 410)

        up = (await self.start(blob("cancel"))).json()
        r = await self.http.delete(f"/api/v1/files/uploads/{up['upload_id']}", headers=self.auth)
        self.assertEqual(r.status_code, 204)
        self.assertEqual((await self.session(up["upload_id"]))["state"], "cancelled")

    async def test_upload_storage_forgot_is_expired(self):
        # R2's lifecycle rule (or an abort) cleared the multipart upload: the
        # session can never complete, so it reads as expired and the client
        # starts over rather than retrying forever.
        up = (await self.start(VIDEO)).json()
        sess = await self.session(up["upload_id"])
        parts = await self.send_parts(up["upload_id"], VIDEO)
        del self.r2.uploads[sess["r2_upload_id"]]
        r = await self.http.post(f"/api/v1/files/uploads/{up['upload_id']}/complete",
                                 json={"parts": parts}, headers=self.auth)
        self.assertEqual(r.status_code, 410, r.text)
        st = (await self.http.get(f"/api/v1/files/uploads/{up['upload_id']}", headers=self.auth)).json()
        self.assertEqual(st["state"], "expired")

        up = (await self.start(blob("again"))).json()
        sess = await self.session(up["upload_id"])
        del self.r2.uploads[sess["r2_upload_id"]]
        st = (await self.http.get(f"/api/v1/files/uploads/{up['upload_id']}", headers=self.auth)).json()
        self.assertEqual(st["state"], "expired")
        self.assertIn("start a new one", st["error"])
        r = await self.http.post(f"/api/v1/files/uploads/{up['upload_id']}/urls", headers=self.auth)
        self.assertEqual(r.status_code, 410)

    async def test_create_sweeps_expired_sessions(self):
        up = (await self.start(VIDEO)).json()
        sess = await self.session(up["upload_id"])
        await self.db["file_uploads"].update_one(
            {"_id": up["upload_id"]}, {"$set": {"expires_at": datetime.now(timezone.utc) - timedelta(hours=1)}})
        await self.start(blob("next"))
        self.assertEqual((await self.session(up["upload_id"]))["state"], "expired")
        self.assertIn(sess["r2_upload_id"], self.r2.aborted)


class Replace(FilesTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.v1 = blob("version-one")
        first = await self.upload(self.v1, "demo.mp4", title="Demo")
        self.slug = first["slug"]
        await self.db["documents"].update_one({"slug": self.slug}, {"$set": {"views": 42}})

    async def replace(self, data: bytes, slug: str | None = None, **extra) -> dict:
        return await self.upload(data, "demo-v2.mp4", target_slug=slug or self.slug, **extra)

    async def test_replace_keeps_the_link(self):
        before = await self.doc(self.slug)
        v2 = blob("version-two", 6 * KB)
        res = await self.replace(v2)
        self.assertEqual((res["slug"], res["version"], res["size_bytes"], res["sha256"]),
                         (self.slug, 2, len(v2), sha(v2)))
        after = await self.doc(self.slug)
        for field in ("_id", "slug", "title", "views", "access_level", "created_at", "edit_secret_hash"):
            self.assertEqual(after[field], before[field], field)
        self.assertEqual(after["rev"], before["rev"] + 1)
        self.assertEqual((after["file_version"], after["sha256"], after["size_bytes"]), (2, sha(v2), len(v2)))
        self.assertNotEqual(after["blob_key"], before["blob_key"])
        # The old bytes are kept, and no longer public.
        self.assertEqual(self.r2.objects[before["blob_key"]]["data"], self.v1)
        self.assertFalse(self.r2.objects[before["blob_key"]]["public"])
        self.assertTrue(self.r2.objects[after["blob_key"]]["public"])
        self.assertIn(self.slug, self.revalidated)
        ev = await self.db["file_events"].find_one({"slug": self.slug, "action": "replace"})
        self.assertEqual((ev["old_sha256"], ev["new_sha256"], ev["version"]), (sha(self.v1), sha(v2), 2))

        vs = (await self.http.get(f"/api/v1/files/{self.slug}/versions", headers=self.auth)).json()["versions"]
        self.assertEqual([(v["version"], v["current"], v["sha256"]) for v in vs],
                         [(2, True, sha(v2)), (1, False, sha(self.v1))])
        self.assertEqual(set(vs[0]), {"version", "size_bytes", "sha256", "content_type", "created_at",
                                      "current", "media", "filename"})

        info = (await self.http.get(f"/api/v1/files/{self.slug}", headers=self.auth)).json()
        self.assertEqual((info["version"], info["sha256"], info["size_bytes"], info["content_type"]),
                         (2, sha(v2), len(v2), "video/mp4"))
        for key in ("slug", "url", "content_type", "size_bytes", "sha256", "version", "updated_at",
                    "created_at", "media", "poster_url"):
            self.assertIn(key, info)

    async def test_replace_sets_title_only_when_given(self):
        await self.replace(blob("t2"))
        self.assertEqual((await self.doc(self.slug))["title"], "Demo")
        await self.replace(blob("t3"), title="New title")
        self.assertEqual((await self.doc(self.slug))["title"], "New title")

    async def test_replace_of_a_private_file_stays_private(self):
        await self.db["documents"].update_one({"slug": self.slug}, {"$set": {"access_level": "private"}})
        up = (await self.start(blob("p2"), "p.mp4", target_slug=self.slug)).json()
        sess = await self.session(up["upload_id"])
        self.assertFalse(sess["public_at_create"])
        self.assertFalse(self.r2.uploads[sess["r2_upload_id"]]["public"])
        parts = await self.send_parts(up["upload_id"], blob("p2"))
        r = await self.http.post(f"/api/v1/files/uploads/{up['upload_id']}/complete",
                                 json={"parts": parts}, headers=self.auth)
        self.assertEqual(r.status_code, 200, r.text)
        raw = await self.doc(self.slug)
        self.assertFalse(self.r2.objects[raw["blob_key"]]["public"])
        # Already private: no 2 GB self-copy to "make" it private.
        self.assertNotIn((raw["blob_key"], False), self.r2.public_calls)

    async def test_target_checks_happen_before_any_url(self):
        now = datetime.now(timezone.utc)
        base = {"edit_secret_hash": "x", "created_at": now, "updated_at": now, "views": 0, "rev": 1}
        await self.db["documents"].insert_many([
            {**base, "slug": "my-notes", "content": "# hi", "owner_id": self.user_id},
            {**base, "slug": "sams-video", "content": "v.mp4", "owner_id": self.other_id, "kind": "artifact",
             "mime": "video/mp4", "blob_key": f"art/{self.other_id}/x.mp4", "size_bytes": 10},
            {**base, "slug": "sams-secret", "content": "v.mp4", "owner_id": self.other_id, "kind": "artifact",
             "mime": "video/mp4", "blob_key": f"art/{self.other_id}/y.mp4", "size_bytes": 10,
             "access_level": "private"},
            {**base, "slug": "my-site", "content": "site.zip", "owner_id": self.user_id, "kind": "artifact",
             "mime": "text/html", "blob_key": f"art/{self.user_id}/s/index.html",
             "bundle_prefix": f"art/{self.user_id}/s/", "size_bytes": 10},
        ])
        cases = {
            "my-notes": (409, "markdown document"),
            "sams-video": (403, "only replace files you own"),
            "sams-secret": (404, "no document"),
            "nope-nope": (404, "no document"),
            "my-site": (409, "zipped website"),
        }
        for slug, (status, text) in cases.items():
            r = await self.start(blob("x"), "x.mp4", target_slug=slug)
            self.assertEqual(r.status_code, status, (slug, r.text))
            self.assertIn(text, r.json()["detail"])
        self.assertIn("update_document", (await self.start(blob("x"), "x.mp4", target_slug="my-notes")).json()["detail"])
        r = await self.start(blob("x"), "x.mp4", target_slug=self.slug, access="private")
        self.assertEqual(r.status_code, 422)
        self.assertEqual(self.r2.uploads, {})

    async def test_keeps_five_versions(self):
        datas = [self.v1] + [blob(f"v{i}-") for i in range(2, 8)]
        for d in datas[1:]:
            await self.replace(d)
        rows = await self.rows(self.slug)
        self.assertEqual([r["version"] for r in rows], [3, 4, 5, 6, 7])
        raw = await self.doc(self.slug)
        self.assertEqual(raw["file_version"], 7)
        kept = {r["blob_key"] for r in rows}
        live = {k for k, o in self.r2.objects.items() if k.startswith(f"art/{self.user_id}/")}
        self.assertEqual(live, kept)
        # The two oldest blobs were deleted.
        self.assertEqual(len([k for k in self.r2.deleted if k not in kept]), 2)

    async def test_restore(self):
        v2 = blob("second")
        await self.replace(v2)
        raw2 = await self.doc(self.slug)
        r = await self.http.post(f"/api/v1/files/{self.slug}/versions/1/restore", headers=self.auth)
        self.assertEqual(r.status_code, 200, r.text)
        info = r.json()
        self.assertEqual((info["version"], info["sha256"], info["slug"]), (3, sha(self.v1), self.slug))
        raw = await self.doc(self.slug)
        rows = await self.rows(self.slug)
        self.assertEqual([r["version"] for r in rows], [1, 2, 3])
        self.assertEqual(rows[2]["blob_key"], rows[0]["blob_key"])  # no copy
        self.assertEqual(raw["blob_key"], rows[0]["blob_key"])
        self.assertTrue(self.r2.objects[raw["blob_key"]]["public"])
        self.assertFalse(self.r2.objects[raw2["blob_key"]]["public"])
        self.assertEqual(raw["rev"], raw2["rev"] + 1)
        ev = await self.db["file_events"].find_one({"action": "restore"})
        self.assertEqual(ev["version"], 3)

        # Restoring the current version changes nothing.
        r = await self.http.post(f"/api/v1/files/{self.slug}/versions/3/restore", headers=self.auth)
        self.assertEqual(r.json()["version"], 3)
        self.assertEqual(len(await self.rows(self.slug)), 3)
        r = await self.http.post(f"/api/v1/files/{self.slug}/versions/9/restore", headers=self.auth)
        self.assertEqual(r.status_code, 404)
        self.assertIn("Kept versions: [1, 2, 3]", r.json()["detail"])
        r = await self.http.post(f"/api/v1/files/{self.slug}/versions/2/restore", headers=self.other_auth)
        self.assertEqual(r.status_code, 403)

    async def test_shared_blob_survives_pruning_one_row(self):
        await self.replace(blob("b2"))
        await self.http.post(f"/api/v1/files/{self.slug}/versions/1/restore", headers=self.auth)  # v3 → v1's blob
        v1_key = (await self.rows(self.slug))[0]["blob_key"]
        for i in range(4, 7):  # v4..v6: v1 is pruned, v3 still points at its blob
            await self.replace(blob(f"b{i}"))
        versions = [r["version"] for r in await self.rows(self.slug)]
        self.assertNotIn(1, versions)
        self.assertIn(3, versions)
        self.assertIn(v1_key, self.r2.objects)
        self.assertNotIn(v1_key, self.r2.deleted)

    async def test_usage_counts_each_blob_once(self):
        v2 = blob("u2", 5 * KB)
        await self.replace(v2)
        used = await file_versions.usage_bytes(self.db, self.user_id)
        self.assertEqual(used, len(self.v1) + len(v2))
        await self.http.post(f"/api/v1/files/{self.slug}/versions/1/restore", headers=self.auth)
        self.assertEqual(await file_versions.usage_bytes(self.db, self.user_id), len(self.v1) + len(v2))
        status = (await self.http.get("/api/v1/artifacts/status", headers=self.auth)).json()
        self.assertEqual(status["used_bytes"], len(self.v1) + len(v2))
        self.assertEqual(status["quota_bytes"], 20 * 1024 ** 3)
        self.assertEqual(status["max_video_bytes"], 2 * 1024 ** 3)

    async def test_quota_drops_oldest_versions_of_that_file_first(self):
        size = 4 * KB
        for i in range(2, 4):
            await self.replace(blob(f"q{i}", size))  # v1..v3 = 12 KB
        await self.upload(blob("other", size), "other.mp4")  # 16 KB in all
        with mock.patch.object(settings, "artifact_user_quota_bytes", 18 * KB):
            # +4 KB: 20 KB > 18 KB → v1 (the oldest of this file) is dropped.
            await self.replace(blob("q4", size))
            self.assertEqual([r["version"] for r in await self.rows(self.slug)], [2, 3, 4])
            self.assertLessEqual(await file_versions.usage_bytes(self.db, self.user_id), 18 * KB)
            # A replace may give up every old version, the outgoing current one
            # included: 12 KB fits (other 4 + new 12), 15 KB can't (4 + 15 > 18).
            r = await self.start(blob("big", 15 * KB), "big.mp4", target_slug=self.slug)
            self.assertEqual(r.status_code, 507, r.text)
            plan = await file_versions.quota_plan(self.db, self.user_id, await self.doc(self.slug), 12 * KB)
            self.assertEqual([r["version"] for r in plan], [2, 3, 4])
            # Nothing was dropped by the refused attempt.
            self.assertEqual([r["version"] for r in await self.rows(self.slug)], [2, 3, 4])

    async def test_legacy_artifact_gets_its_row_on_first_replace(self):
        now = datetime.now(timezone.utc)
        key = f"art/{self.user_id}/legacy.mp4"
        self.r2.put_bytes(key, b"legacy-bytes", "video/mp4", True)
        await self.db["documents"].insert_one({
            "slug": "old-video", "content": "old.mp4", "edit_secret_hash": "x", "created_at": now,
            "updated_at": now, "views": 7, "rev": 3, "owner_id": self.user_id, "kind": "artifact",
            "mime": "video/mp4", "blob_key": key, "size_bytes": 12, "original_filename": "old.mp4",
        })
        vs = (await self.http.get("/api/v1/files/old-video/versions", headers=self.auth)).json()["versions"]
        self.assertEqual([(v["version"], v["current"], v["sha256"]) for v in vs], [(1, True, None)])
        self.assertEqual(await self.db["file_versions"].count_documents({}), 1)  # still only Replace's own
        info = (await self.http.get("/api/v1/files/old-video", headers=self.auth)).json()
        self.assertEqual((info["version"], info["sha256"]), (1, None))
        res = await self.replace(blob("new"), slug="old-video")
        self.assertEqual(res["version"], 2)
        rows = await self.rows("old-video")
        self.assertEqual([(r["version"], r["sha256"], r["blob_key"]) for r in rows],
                         [(1, None, key), (2, sha(blob("new")), (await self.doc("old-video"))["blob_key"])])
        self.assertEqual((await self.doc("old-video"))["views"], 7)

    async def test_deleting_the_document_deletes_every_version(self):
        await self.replace(blob("d2"))
        await self.replace(blob("d3"))
        keys = {r["blob_key"] for r in await self.rows(self.slug)}
        await self.db["documents"].update_one({"slug": self.slug}, {"$set": {"poster_key": f"art/{self.user_id}/p.poster.jpg"}})
        self.r2.put_bytes(f"art/{self.user_id}/p.poster.jpg", b"\xff\xd8", "image/jpeg")
        r = await self.http.delete(f"/api/v1/documents/{self.slug}", headers=self.auth)
        self.assertEqual(r.status_code, 204, r.text)
        self.assertEqual(await self.db["file_versions"].count_documents({}), 0)
        for k in keys | {f"art/{self.user_id}/p.poster.jpg"}:
            self.assertNotIn(k, self.r2.objects)

    async def test_info_and_versions_access(self):
        r = await self.http.get(f"/api/v1/files/{self.slug}", headers=self.other_auth)
        self.assertEqual(r.status_code, 200)  # a link file: anyone signed in who has the link
        r = await self.http.get(f"/api/v1/files/{self.slug}/versions", headers=self.other_auth)
        self.assertEqual(r.status_code, 403)
        await self.db["documents"].update_one({"slug": self.slug}, {"$set": {"access_level": "private"}})
        r = await self.http.get(f"/api/v1/files/{self.slug}", headers=self.other_auth)
        self.assertEqual(r.status_code, 404)
        r = await self.http.get(f"/api/v1/files/{self.slug}/versions", headers=self.other_auth)
        self.assertEqual(r.status_code, 404)
        await self.db["documents"].insert_one({"slug": "a-note", "content": "x", "edit_secret_hash": "x",
                                               "created_at": datetime.now(timezone.utc),
                                               "updated_at": datetime.now(timezone.utc),
                                               "owner_id": self.user_id})
        r = await self.http.get("/api/v1/files/a-note", headers=self.auth)
        self.assertEqual(r.status_code, 409)


class WebReplace(FilesTestCase):
    """PUT /api/v1/artifacts/{slug}/file keeps the old file as a version too."""

    def put_object(self, name: str, data: bytes, mime: str = "video/mp4") -> str:
        key = f"art/{self.user_id}/{name}"
        self.r2.objects[key] = {"data": data, "content_type": mime, "public": False}
        return key

    async def test_web_replace_creates_a_version(self):
        key1 = self.put_object("one.mp4", b"one")
        r = await self.http.post("/api/v1/artifacts", headers=self.auth,
                                 json={"blob_key": key1, "filename": "one.mp4", "custom_slug": "web-video"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertIn("poster_url", r.json())
        self.assertIn("media", r.json())
        key2 = self.put_object("two.mp4", b"two-two")
        r = await self.http.put("/api/v1/artifacts/web-video/file", headers=self.auth,
                                json={"blob_key": key2, "filename": "two.mp4"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["size_bytes"], 7)
        self.assertIn(key1, self.r2.objects)  # kept, not deleted
        self.assertFalse(self.r2.objects[key1]["public"])
        self.assertTrue(self.r2.objects[key2]["public"])
        rows = await self.rows("web-video")
        self.assertEqual([(r["version"], r["blob_key"], r["sha256"]) for r in rows],
                         [(1, key1, None), (2, key2, None)])
        self.assertIn("web-video", self.revalidated)
        r = await self.http.post("/api/v1/files/web-video/versions/1/restore", headers=self.auth)
        self.assertEqual(r.json()["version"], 3)
        self.assertEqual((await self.doc("web-video"))["blob_key"], key1)

    async def test_poster_follows_access_changes(self):
        key = self.put_object("p.mp4", b"vid")
        r = await self.http.post("/api/v1/artifacts", headers=self.auth,
                                 json={"blob_key": key, "filename": "p.mp4", "custom_slug": "with-poster"})
        self.assertEqual(r.status_code, 201, r.text)
        poster = f"art/{self.user_id}/abc.poster.jpg"
        self.r2.put_bytes(poster, b"\xff\xd8jpg", "image/jpeg", True)
        await self.db["documents"].update_one({"slug": "with-poster"}, {"$set": {
            "poster_key": poster, "media": {"duration_s": 2.0, "width": 640, "height": 360,
                                            "video_codec": "h264", "audio_codec": "aac"}}})
        doc = (await self.http.get("/api/v1/documents/with-poster", headers=self.auth)).json()
        self.assertEqual(doc["poster_url"], f"https://markdrop-artifacts.example.workers.dev/r/{poster}")
        self.assertEqual(doc["media"]["width"], 640)
        r = await self.http.patch("/api/v1/artifacts/with-poster", headers=self.auth, json={"read_password": "pw"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(self.r2.objects[poster]["public"])
        self.assertIn("?t=", r.json()["poster_url"])
