"""Short upload links (PUT /u/<token>, services/upload_links.py) and the batch
upload tools: create_uploads / complete_uploads, create_page_image_uploads /
complete_page_image_uploads, and POST /api/v1/files/uploads/batch(/complete).

R2 is FakeR2 (tests/_files_env.py): nothing here reaches a bucket or the network."""

from __future__ import annotations

from datetime import timedelta
from unittest import mock

from tests._files_env import MB, FilesTestCase, settings, sha
from tests import test_page_image_upload as piu
from tests import test_pages

from app.mcp import schema, tools
from app.services import file_uploads, upload_links
from app.services import user as user_service

PDF = b"%PDF-1.4\n" + b"q3 numbers " * 400


def token_of(url: str) -> str:
    assert url.startswith("https://api.markdrop.in/u/"), url
    return url.rsplit("/", 1)[-1]


class UploadLinks(FilesTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        user = await user_service.get_user_by_id(self.db, self.user_id)
        self.ctx = tools.Context(db=self.db, user=user, client_id="c", scopes=["documents:read", "documents:write"])

    async def tool(self, name: str, **args):
        t = tools.BY_NAME[name]
        problem = schema.validate(t.input_schema, args)
        if problem:
            raise tools.ToolError(problem)
        return await t.handler(self.ctx, args)

    async def put(self, url: str, data: bytes, **headers):
        return await self.http.put(url.replace("https://api.markdrop.in", ""), content=data, headers=headers)

    def file(self, data: bytes, name: str, **extra) -> dict:
        return {"file_name": name, "size_bytes": len(data), "sha256": sha(data), **extra}

    # ── The link itself ──

    async def test_a_short_link_takes_the_part_once_then_complete_publishes(self):
        _t, out = await self.tool("create_upload", **self.file(PDF, "q3.pdf"))
        link = out["parts"][0]["short_url"]
        self.assertLess(len(link), 50)
        r = await self.put(link, PDF)
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual((body["ok"], body["part_number"], body["part_count"], body["size"]), (True, 1, 1, len(PDF)))
        self.assertEqual(r.headers["etag"], f'"{body["etag"]}"')
        # Single use.
        again = await self.put(link, PDF)
        self.assertEqual(again.status_code, 410)
        self.assertIn("already used", again.json()["detail"])
        _t, res = await self.tool("complete_upload", upload_id=out["upload_id"])
        self.assertEqual((res["state"], res["sha256"]), ("done", sha(PDF)))

    async def test_wrong_size_wrong_bytes_and_chunked_are_refused_and_the_link_survives(self):
        _t, out = await self.tool("create_upload", **self.file(PDF, "q3.pdf"))
        link = out["parts"][0]["short_url"]
        r = await self.put(link, PDF + b"x")
        self.assertEqual(r.status_code, 413)
        r = await self.put(link, PDF[:-1])
        self.assertEqual(r.status_code, 400)
        self.assertIn(f"exactly {len(PDF):,} bytes", r.json()["detail"])
        wrong = bytes(reversed(PDF))
        r = await self.put(link, wrong)
        self.assertEqual(r.status_code, 422)
        self.assertIn("sha256 mismatch", r.json()["detail"])
        sess = await self.session(out["upload_id"])
        self.assertEqual(self.r2.uploads[sess["r2_upload_id"]]["parts"], {})  # nothing reached storage

        async def chunks():
            yield PDF

        r = await self.http.put("/u/" + token_of(link), content=chunks())
        self.assertEqual(r.status_code, 411)
        # Every refusal gave the link back: the right bytes still go in.
        r = await self.put(link, PDF)
        self.assertEqual(r.status_code, 200, r.text)

    async def test_unknown_expired_and_ended_links(self):
        r = await self.put("/u/nope-nope-nope-1", PDF)
        self.assertEqual(r.status_code, 404)
        _t, out = await self.tool("create_upload", **self.file(PDF, "q3.pdf"))
        token = token_of(out["parts"][0]["short_url"])
        await self.db[upload_links.LINKS].update_one(
            {"_id": token}, {"$set": {"expires_at": upload_links._now() - timedelta(seconds=1)}})
        r = await self.put("/u/" + token, PDF)
        self.assertEqual(r.status_code, 410)
        self.assertIn("expired", r.json()["detail"])
        row = await self.db[upload_links.LINKS].find_one({"_id": token})
        self.assertEqual(row["state"], "open")
        # A cancelled upload's links no longer take files.
        _t, out = await self.tool("create_upload", **self.file(PDF, "other.pdf"))
        await self.http.delete(f"/api/v1/files/uploads/{out['upload_id']}", headers=self.auth)
        r = await self.put(out["parts"][0]["short_url"], PDF)
        self.assertEqual(r.status_code, 410)

    async def test_links_never_outlive_60_minutes(self):
        _t, out = await self.tool("create_upload", **self.file(PDF, "q3.pdf"))
        row = await self.db[upload_links.LINKS].find_one({"_id": token_of(out["parts"][0]["short_url"])})
        life = upload_links.file_uploads._aware(row["expires_at"]) - upload_links._now()
        self.assertLessEqual(life, timedelta(minutes=60))
        self.assertGreater(life, timedelta(minutes=59))

    async def test_multi_part_file_through_short_links(self):
        self.r2.min_part = 1
        data = b"0123456789" * 1100
        with mock.patch.object(upload_links.file_uploads, "part_size_for", lambda size: 5000):
            text, out = await self.tool("create_upload", **self.file(data, "clip.mp4"))
        self.assertEqual(len(out["parts"]), 3)
        self.assertIn("split -b 5000", text)
        for p in out["parts"]:
            n = p["part_number"]
            r = await self.put(p["short_url"], data[(n - 1) * 5000: n * 5000])
            self.assertEqual(r.status_code, 200, r.text)
        _t, res = await self.tool("complete_upload", upload_id=out["upload_id"])
        self.assertEqual((res["state"], res["size_bytes"]), ("done", len(data)))

    async def test_switched_off_the_tools_hand_out_presigned_urls(self):
        with mock.patch.object(settings, "upload_short_links", False):
            text, out = await self.tool("create_upload", **self.file(PDF, "q3.pdf"))
            self.assertNotIn("short_url", out["parts"][0])
            self.assertIn("r2.example", text)
            _t, many = await self.tool("create_uploads", files=[self.file(PDF, "q3.pdf")])
            self.assertIn("r2.example", many["uploads"][0]["url"])

    # ── create_uploads / complete_uploads ──

    async def test_sixteen_files_one_create_one_script_one_complete(self):
        blobs = [PDF + bytes([i]) * (i + 1) for i in range(16)]
        files = [self.file(b, f"doc-{i}.pdf", path=f"out/doc-{i}.pdf") for i, b in enumerate(blobs)]
        text, out = await self.tool("create_uploads", files=files, access="private")
        self.assertEqual((out["count"], out["failed"]), (16, 0))
        self.assertEqual(len(out["upload_ids"]), 16)
        curls = [l for l in out["script"].splitlines() if l.startswith("curl ")]
        self.assertEqual(len(curls), 16)
        self.assertIn("curl -sS --fail-with-body -T out/doc-0.pdf 'https://api.markdrop.in/u/", curls[0])
        self.assertIn(out["script"], text)
        self.assertIn("complete_uploads", text)
        for row, b in zip(out["uploads"], blobs):
            self.assertEqual(row["url"], row["parts"][0]["url"])
            r = await self.put(row["url"], b)
            self.assertEqual(r.status_code, 200, r.text)
        text, done = await self.tool("complete_uploads", upload_ids=out["upload_ids"])
        self.assertEqual((done["done"], done["verifying"], done["failed"]), (16, 0, 0))
        for res, b in zip(done["results"], blobs):
            self.assertEqual((res["state"], res["sha256"]), ("done", sha(b)))
            self.assertEqual(file_uploads.access_of(await self.doc(res["slug"])), "private")
        self.assertIn("16 of 16 upload(s) done", text)

    async def test_one_bad_file_never_sinks_the_others(self):
        files = [
            self.file(PDF, "good.pdf", slug="q3-report"),
            self.file(b"MZ\x90\x00", "virus.exe"),
            self.file(PDF + b"2", "dup.pdf", slug="q3-report"),
            {"file_name": "nosize.pdf", "sha256": sha(PDF)},
        ]
        text, out = await self.tool("create_uploads", files=files)
        oks = [r["ok"] for r in out["uploads"]]
        self.assertEqual(oks, [True, False, False, False])
        self.assertIn("Unsupported file type", out["uploads"][1]["error"])
        self.assertIn("asked for twice", out["uploads"][2]["error"])
        self.assertIn("virus.exe", text)
        await self.put(out["uploads"][0]["url"], PDF)
        _t, done = await self.tool("complete_uploads", upload_ids=out["upload_ids"] + ["up_unknown123"])
        self.assertEqual([r["state"] for r in done["results"]], ["done", "error"])
        self.assertEqual(done["results"][0]["slug"], "q3-report")
        self.assertIn("not found", done["results"][1]["error"])

    async def test_complete_before_the_bytes_says_so_and_can_be_retried(self):
        _t, out = await self.tool("create_uploads", files=[self.file(PDF, "late.pdf")])
        _t, first = await self.tool("complete_uploads", upload_ids=out["upload_ids"])
        self.assertEqual((first["done"], first["failed"]), (0, 1))
        self.assertEqual(first["results"][0]["state"], "uploading")
        self.assertIn("Waiting for the bytes: 0 of 1", first["results"][0]["error"])
        # The same call again returns the same session with fresh links.
        _t, again = await self.tool("create_uploads", files=[self.file(PDF, "late.pdf")])
        self.assertEqual(again["upload_ids"], out["upload_ids"])
        self.assertTrue(again["uploads"][0]["resumed"])
        await self.put(again["uploads"][0]["url"], PDF)
        _t, done = await self.tool("complete_uploads", upload_ids=out["upload_ids"])
        self.assertEqual(done["done"], 1)

    async def test_batch_limits(self):
        with self.assertRaises(tools.ToolError):
            await self.tool("create_uploads", files=[self.file(PDF, f"{i}.pdf") for i in range(51)])
        with self.assertRaises(tools.ToolError):
            await self.tool("complete_uploads", upload_ids=[])
        self.assertIn("create_uploads", tools.BY_NAME["create_upload"].description)

    # ── REST, for the CLI ──

    async def test_rest_batch_create_and_complete(self):
        body = {"files": [
            {"file_name": "a.pdf", "size_bytes": len(PDF), "sha256": sha(PDF), "content_type": "application/pdf"},
            {"file_name": "b.exe", "size_bytes": 4, "sha256": "a" * 64},
        ], "short_links": True}
        r = await self.http.post("/api/v1/files/uploads/batch", json=body, headers=self.auth)
        self.assertEqual(r.status_code, 200, r.text)
        ups = r.json()["uploads"]
        self.assertEqual([u["ok"] for u in ups], [True, False])
        self.assertEqual(ups[1]["status"], 415)
        part = ups[0]["parts"][0]
        self.assertIn("r2.example", part["url"])
        self.assertTrue(part["short_url"].startswith("https://api.markdrop.in/u/"))
        sess = await self.session(ups[0]["upload_id"])
        self.r2.put_part(sess["r2_upload_id"], 1, PDF)  # the CLI PUTs to the presigned URL
        r = await self.http.post("/api/v1/files/uploads/batch/complete",
                                 json={"upload_ids": [ups[0]["upload_id"]]}, headers=self.auth)
        self.assertEqual(r.status_code, 200, r.text)
        res = r.json()["results"][0]
        self.assertEqual((res["status"], res["state"], res["result"]["sha256"]), (200, "done", sha(PDF)))
        # Someone else's upload id is just "not found".
        r = await self.http.post("/api/v1/files/uploads/batch/complete",
                                 json={"upload_ids": [ups[0]["upload_id"]]}, headers=self.other_auth)
        self.assertEqual(r.json()["results"][0]["status"], 404)


class PageImageBatch(test_pages.PageWorld):
    call = piu.PageImageUpload.call
    ok = piu.PageImageUpload.ok
    rows = piu.PageImageUpload.rows

    async def test_many_images_in_one_go(self):
        page = await self.mkdoc("W")
        imgs = [test_pages.png(), piu.big_png(64 * 1024)]
        args = {"document": page["slug"], "images": [
            {"file_name": f"shot-{i}.png", "size_bytes": len(d), "sha256": sha(d), "alt": f"Shot {i}"}
            for i, d in enumerate(imgs)] + [{"file_name": "logo.svg", "size_bytes": 10, "sha256": "a" * 64}]}
        out = await self.ok("wm", "create_page_image_uploads", args)
        self.assertEqual((out["count"], out["failed"]), (2, 1))
        self.assertIn("PNG, JPEG, GIF or WebP", out["uploads"][2]["error"])
        self.assertEqual(len([l for l in out["script"].splitlines() if l.startswith("curl ")]), 2)
        for row, d in zip(out["uploads"], imgs):
            r = await self.http.put(row["url"].replace("https://api.markdrop.in", ""), content=d)
            self.assertEqual(r.status_code, 200, r.text)
        done = await self.ok("wm", "complete_page_image_uploads", {"upload_ids": out["upload_ids"]})
        self.assertEqual((done["done"], done["failed"]), (2, 0))
        self.assertEqual(done["results"][0]["markdown"], f"![Shot 0]({done['results'][0]['asset']})")
        self.assertEqual(await self.rows(), 2)
