"""Markdrop files embedded in docs pages (services/docs_embeds.py, routers/docs_embeds.py).

The public resolve (only files anyone with the link can open; every other state carries no title,
no size, no address; renamed files follow; a pinned version only for the guide it was pinned for,
signed), CORS `*`, the studio's picker / link check / "anyone with the link" / version pins and
their roles, the beacons (the guide's own addresses only; the file's creator analytics get a view
from the "Guides" channel with the guide as campaign; the guide's Insights get daily counts and
nothing per reader), the Insights tab's per-file numbers and site.json's `markdrop` block.
"""

from __future__ import annotations

from tests import _docs_sites_env as base  # noqa: F401  (pins settings first)

import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from bson import ObjectId

from app.limiter import limiter
from app.services import docs_embeds as de
from app.services import docs_sites, docs_snapshot, r2, traffic
from app.services import guide_insights as gi
from tests._docs_sites_env import DocsSitesCase, settings

ORIGIN = "https://markdrop-artifacts.example.workers.dev"
EMB = "/api/v1/embeds"
DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"
HTML = "text/html"
PDF = "application/pdf"
MP4 = "video/mp4"


def now() -> datetime:
    return datetime.now(timezone.utc)


class PureTests(unittest.TestCase):
    def test_links(self):
        self.assertEqual(de.slug_from_src("https://markdrop.in/acme-pricing"), "acme-pricing")
        self.assertEqual(de.slug_from_src("https://www.markdrop.in/acme_1/?x=1#y"), "acme_1")
        self.assertEqual(de.slug_from_src("acme-pricing"), "acme-pricing")
        self.assertEqual(de.slug_from_src(f"{settings.frontend_url.rstrip('/')}/acme"), "acme")
        for bad in ("http://markdrop.in/acme", "https://markdrop.in/w/a/b", "https://evil.example/acme",
                    "https://user:pw@markdrop.in/acme", "https://markdrop.in/", "a b", "", None, "x" * 3000):
            self.assertIsNone(de.slug_from_src(bad), bad)

    def test_excerpt(self):
        md = "---\ntitle: x\n---\n# Pricing\n\nThe **Acme** plans, with [links](https://x.y) and `code`.\n\n```js\nsecret()\n```\n- one\n- two"
        self.assertEqual(de.excerpt(md), "Pricing The Acme plans, with links and code. one two")
        self.assertTrue(de.excerpt("word " * 200).endswith("…"))
        self.assertIsNone(de.excerpt("   "))

    def test_beacon_parsing(self):
        p = lambda d: de.parse_beacon(json.dumps(d).encode())  # noqa: E731
        self.assertEqual(p({"site": "s", "p": "/a", "a": "view"})["a"], "view")
        self.assertEqual(p({"site": "s", "a": "watch", "s": 99999})["s"], 4 * 3600)
        for bad in ({"site": "s", "a": "steal"}, {"a": "view"}, {"site": "s", "a": "watch"}, {"site": "s", "a": "watch", "s": -1},
                    {"site": "s" * 65, "a": "view"}, [1]):
            self.assertIsNone(p(bad), bad)
        self.assertIsNone(de.parse_beacon(b"x" * 3000))
        self.assertIsNone(de.parse_beacon(b"not json"))

    def test_channel(self):
        self.assertEqual(traffic.channel_for(None, "markdrop-guides", "embed"), "Guides")

    def test_site_json_names_where_files_resolve(self):
        row = {"_id": ObjectId(), "name": "Acme", "slug": "acme", "settings": {}, "engine_extra": {}, "domains": []}
        with mock.patch.object(settings, "artifact_origin", ORIGIN):
            files, _ = docs_snapshot.content_files(row, {"pages": [], "settings": {}}, url="https://acme.guides.markdrop.in",
                                                   ai_api="https://api.markdrop.in")
        sj = json.loads(files["site.json"])
        self.assertEqual(sj["markdrop"], {"api": "https://api.markdrop.in", "app": settings.frontend_url.rstrip("/"), "files": ORIGIN})


class EmbedsCase(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.saved = docs_sites.STUDIO_TTL_S
        docs_sites.STUDIO_TTL_S = 0.0
        docs_sites.reset()
        await de.ensure_indexes(self.db)
        await gi.ensure_indexes(self.db)
        await self.db["documents"].create_index("slug", unique=True)
        await self.db["file_versions"].create_index([("doc_id", 1), ("version", -1)], unique=True)
        self.objects: dict[str, dict] = {}
        for p in (mock.patch.object(settings, "artifact_origin", ORIGIN), mock.patch.object(settings, "artifact_signing_key", "k"),
                  mock.patch.object(r2, "is_configured", lambda: True), mock.patch.object(r2, "head", self.head),
                  mock.patch.object(r2, "set_public", self.set_public)):
            p.start()
            self.addCleanup(p.stop)
        de._ae_cache.clear()
        de._rows_seen.clear()
        self.site = await self.create("acme")
        self.sid = self.site["id"]
        limiter.reset()
        b = await self.call("POST", f"/{self.sid}/publish", json={}, expect=202)
        await self.mark_live(b["id"])
        self.origin = "https://" + docs_snapshot.host_for("acme", self.sid)

    async def asyncTearDown(self):
        docs_sites.STUDIO_TTL_S = self.saved
        docs_sites.reset()
        await super().asyncTearDown()

    def head(self, key):
        o = self.objects.get(key)
        return {"size": 1, "content_type": "x", "etag": "x", "public": bool(o and o.get("public")), "ae": (o or {}).get("ae")} if o else None

    def set_public(self, key, public, content_type=None, epoch=None):
        o = self.objects.setdefault(key, {})
        o["public"] = public
        if epoch is not None:
            o["ae"] = str(epoch)
        return True

    async def doc(self, slug: str, who: str = "owner", *, mime: str | None = HTML, **extra) -> dict:
        row = {"slug": slug, "title": slug.replace("-", " ").title(), "owner_id": self.uid[who], "access_level": "link",
               "created_at": now(), "updated_at": now(), "views": 0, "rev": 1, "workspace_id": None, "folder_path": [],
               "content": "", "read_password_hash": None, "expires_at": None, "encrypted": False}
        if mime:
            ext = {HTML: "html", PDF: "pdf", MP4: "mp4"}.get(mime, "bin")
            row.update(kind="artifact", mime=mime, blob_key=f"art/{self.uid[who]}/{slug}.{ext}", size_bytes=20480,
                       original_filename=f"{slug}.{ext}", file_version=1)
        else:
            row.update(kind="markdown", content="# Handbook\n\nWelcome to **Acme**. " + "More words. " * 10)
        row.update(extra)
        res = await self.db["documents"].insert_one(row)
        row["_id"] = res.inserted_id
        return row

    async def resolve(self, slug: str, **q):
        return await self.http.get(f"{EMB}/{slug}", params=q, headers={"Origin": self.origin})

    async def beacon(self, slug: str, body: dict, origin: str | None = "own", ua: str = DESKTOP):
        h = {"Content-Type": "text/plain", "User-Agent": ua}
        if origin:
            h["Origin"] = self.origin if origin == "own" else origin
        return await self.http.post(f"{EMB}/{slug}/beacon", content=json.dumps({"site": self.sid, **body}), headers=h)


class ResolveTests(EmbedsCase):
    async def test_public_files_answer_with_their_artifact_origin_addresses(self):
        await self.doc("acme-pricing")
        r = await self.resolve("acme-pricing")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["access-control-allow-origin"], "*")
        self.assertNotIn("access-control-allow-credentials", r.headers)
        self.assertIn("max-age=30", r.headers["cache-control"])
        b = r.json()
        self.assertEqual((b["state"], b["renderer"], b["kind"], b["title"]), ("ok", "html", "artifact", "Acme Pricing"))
        self.assertEqual(b["frame_url"], f"{ORIGIN}/r/art/{self.uid['owner']}/acme-pricing.html")
        self.assertNotIn("?t=", b["frame_url"])
        self.assertEqual((b["version"], b["pinned"], b["url"]), (1, False, "https://markdrop.in/acme-pricing"))
        await self.doc("acme-prices", mime=PDF)
        b = (await self.resolve("acme-prices")).json()
        self.assertEqual(b["frame_url"], f"{ORIGIN}/v/pdf/art/{self.uid['owner']}/acme-prices.pdf")
        self.assertEqual(b["raw_url"], f"{ORIGIN}/r/art/{self.uid['owner']}/acme-prices.pdf")
        await self.doc("acme-tour", mime=MP4, media={"duration_s": 125.4, "width": 1920, "height": 1080, "video_codec": "h264"},
                       poster_key=f"art/{self.uid['owner']}/t.poster.jpg")
        b = (await self.resolve("acme-tour")).json()
        self.assertEqual(b["media"], {"duration": 125.4, "width": 1920, "height": 1080})
        self.assertEqual(b["poster_url"], f"{ORIGIN}/r/art/{self.uid['owner']}/t.poster.jpg")

    async def test_nothing_about_a_file_readers_cant_open(self):
        ws = self.ws
        await self.db["workspaces"].update_one({"_id": ObjectId(ws)}, {"$set": {"settings": {}}})
        cases = {
            "p-private": ({"access_level": "private"}, "private"),
            "p-password": ({"read_password_hash": "$2b$12$abc"}, "password"),
            "p-ws": ({"access_level": "workspace", "workspace_id": ws}, "signin"),
            "p-expired": ({"expires_at": now() - timedelta(minutes=1)}, "unavailable"),
        }
        for slug, (extra, state) in cases.items():
            await self.doc(slug, **extra)
            r = await self.resolve(slug)
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json(), {"state": state, "slug": slug}, slug)
        await self.doc("p-enc", mime=None, encrypted=True, content="ciphertext")
        self.assertEqual((await self.resolve("p-enc")).json(), {"state": "encrypted", "slug": "p-enc"})
        self.assertEqual((await self.resolve("nope")).json(), {"state": "unavailable", "slug": "nope"})
        self.assertEqual((await self.resolve("bad.slug")).json()["state"], "unavailable")
        # A workspace that requires sign-in keeps even its link documents in.
        ws2 = (await self.db["workspaces"].insert_one({"name": "Closed", "owner_id": self.uid["owner"], "settings": {"require_auth_to_view": True},
                                                        "branding": {}, "created_at": now(), "updated_at": now()})).inserted_id
        await self.doc("p-closed", workspace_id=str(ws2))
        self.assertEqual((await self.resolve("p-closed")).json(), {"state": "signin", "slug": "p-closed"})
        await self.doc("p-zip", mime="application/x-msdownload")
        self.assertEqual((await self.resolve("p-zip")).json(), {"state": "unsupported", "slug": "p-zip"})

    async def test_documents_renames_and_privacy_changes(self):
        await self.doc("acme-handbook", mime=None)
        b = (await self.resolve("acme-handbook")).json()
        self.assertEqual((b["state"], b["renderer"], b["kind"]), ("ok", "doc", "document"))
        self.assertTrue(b["excerpt"].startswith("Handbook Welcome to Acme."))
        self.assertNotIn("frame_url", b)
        await self.doc("acme-new", old_slugs=["acme-old"])
        b = (await self.resolve("acme-old")).json()
        self.assertEqual((b["state"], b["slug"]), ("ok", "acme-new"))
        # Made private on Markdrop: every guide stops showing it, at once.
        await self.db["documents"].update_one({"slug": "acme-new"}, {"$set": {"access_level": "private"}})
        self.assertEqual((await self.resolve("acme-old")).json(), {"state": "private", "slug": "acme-old"})


class StudioTests(EmbedsCase):
    async def test_check_share_and_roles(self):
        await self.doc("own-private", access_level="private")
        path = f"/{self.sid}/embeds/check"
        info = await self.call("POST", path, json={"src": "https://markdrop.in/own-private"})
        self.assertEqual((info["public"], info["reason"], info["can_share"], info["renderer"]), (False, "private", True, "html"))
        self.assertIn("private", info["reason_text"])
        # The site's editor can't read the owner's private file: it doesn't exist for them.
        r = await self.call("POST", path, who="editor", expect=404, json={"src": "own-private"})
        self.assertIn("couldn't find", r["detail"])
        await self.call("POST", path, who="viewer", expect=403, json={"src": "own-private"})
        await self.call("POST", path, expect=422, json={"src": "https://example.com/x"})
        after = await self.call("POST", f"/{self.sid}/embeds/share", json={"src": "own-private"})
        self.assertEqual((after["public"], after["access_level"]), (True, "link"))
        self.assertEqual((await self.resolve("own-private")).json()["state"], "ok")
        # A password isn't an access level: sharing can't fix it.
        await self.doc("own-pw", read_password_hash="$2b$12$abc")
        info = await self.call("POST", path, json={"src": "own-pw"})
        self.assertEqual((info["reason"], info["can_share"]), ("password", False))
        await self.call("POST", f"/{self.sid}/embeds/share", expect=403, json={"src": "own-pw"})

    async def test_library(self):
        await self.doc("lib-html")
        await self.doc("lib-pdf", mime=PDF, access_level="private")
        await self.doc("lib-doc", mime=None)
        await self.doc("lib-other", who="admin")
        await self.doc("lib-ws", who="admin", workspace_id=self.ws)
        got = await self.get(f"/{self.sid}/embeds/library")
        self.assertEqual(sorted(i["slug"] for i in got["items"]), ["lib-doc", "lib-html", "lib-pdf"])
        pdf = next(i for i in got["items"] if i["slug"] == "lib-pdf")
        self.assertEqual((pdf["public"], pdf["reason"], pdf["renderer"]), (False, "private", "pdf"))
        self.assertEqual([i["slug"] for i in (await self.get(f"/{self.sid}/embeds/library?type=pdf"))["items"]], ["lib-pdf"])
        self.assertEqual([i["slug"] for i in (await self.get(f"/{self.sid}/embeds/library?type=doc"))["items"]], ["lib-doc"])
        self.assertEqual([i["slug"] for i in (await self.get(f"/{self.sid}/embeds/library?q=html"))["items"]], ["lib-html"])
        ws = await self.get(f"/{self.sid}/embeds/library?scope=workspace")
        self.assertEqual([i["slug"] for i in ws["items"]], ["lib-ws"])
        self.assertEqual(ws["workspace"]["name"], "Acme")
        await self.get(f"/{self.sid}/embeds/library", who="viewer", expect=403)
        await self.get(f"/{self.sid}/embeds/library", who="stranger", expect=404)

    async def test_pinned_versions_only_for_the_guide_that_pinned_them(self):
        d = await self.doc("acme-tour", mime=MP4, file_version=2, blob_key=f"art/{self.uid['owner']}/v2.mp4")
        old_key = f"art/{self.uid['owner']}/v1.mp4"
        self.objects[old_key] = {"public": False, "ae": "3"}
        await self.db["file_versions"].insert_many([
            {"doc_id": str(d["_id"]), "slug": "acme-tour", "version": 1, "blob_key": old_key, "mime": MP4, "size_bytes": 10,
             "filename": "v1.mp4", "created_at": now() - timedelta(days=1)},
            {"doc_id": str(d["_id"]), "slug": "acme-tour", "version": 2, "blob_key": d["blob_key"], "mime": MP4, "size_bytes": 20,
             "filename": "v2.mp4", "created_at": now()},
        ])
        # Asking for v1 without a pin: the current version, unsigned.
        b = (await self.resolve("acme-tour", site=self.sid, v=1)).json()
        self.assertEqual((b["version"], b["pinned"]), (2, False))
        self.assertNotIn("?t=", b["raw_url"])
        info = await self.call("POST", f"/{self.sid}/embeds/check", json={"src": "acme-tour"})
        self.assertTrue(info["can_pin"])
        self.assertEqual([v["version"] for v in info["versions"]], [2, 1])
        await self.call("POST", f"/{self.sid}/embeds/pins", who="viewer", expect=403, json={"src": "acme-tour", "version": 1})
        await self.call("POST", f"/{self.sid}/embeds/pins", expect=404, json={"src": "acme-tour", "version": 7})
        pin = await self.call("POST", f"/{self.sid}/embeds/pins", json={"src": "acme-tour", "version": 1})
        self.assertEqual((pin["version"], pin["current_version"]), (1, 2))
        r = await self.resolve("acme-tour", site=self.sid, v=1)
        b = r.json()
        self.assertEqual((b["version"], b["pinned"], b["filename"]), (1, True, "v1.mp4"))
        self.assertTrue(b["raw_url"].startswith(f"{ORIGIN}/r/{old_key}?t="))
        self.assertEqual(r.headers["cache-control"], "private, no-store")
        import jwt

        claims = jwt.decode(b["raw_url"].split("?t=")[1], "k", algorithms=["HS256"])
        self.assertEqual((claims["k"], claims["e"]), (old_key, 3))  # the object's own epoch
        # Another guide (or none) gets the current version.
        self.assertEqual((await self.resolve("acme-tour", site=str(ObjectId()), v=1)).json()["pinned"], False)
        self.assertEqual((await self.resolve("acme-tour", v=1)).json()["pinned"], False)
        # Made private: the pin opens nothing.
        await self.db["documents"].update_one({"slug": "acme-tour"}, {"$set": {"access_level": "private"}})
        self.assertEqual((await self.resolve("acme-tour", site=self.sid, v=1)).json(), {"state": "private", "slug": "acme-tour"})


class BeaconTests(EmbedsCase):
    async def test_views_count_for_the_creator_and_the_guide(self):
        d = await self.doc("acme-pricing")
        r = await self.beacon("acme-pricing", {"p": "/pricing?x=1", "a": "view"})
        self.assertEqual((r.status_code, r.json()), (202, {"status": "ok"}))
        self.assertEqual(r.headers["access-control-allow-origin"], "*")
        self.assertEqual((await self.db["documents"].find_one({"_id": d["_id"]}))["views"], 1)
        [ev] = await self.db["events"].find({"doc_id": str(d["_id"])}).to_list(10)
        self.assertEqual((ev["type"], ev["channel"], ev["utm_source"], ev["utm_medium"], ev["utm_campaign"]),
                         ("view", "Guides", "markdrop-guides", "embed", "Acme Docs"))
        for body in ({"p": "/pricing", "a": "fullscreen"}, {"p": "/pricing", "a": "open"}, {"p": "/tour", "a": "view"},
                     {"p": "/pricing", "a": "watch", "s": 42.6}):
            self.assertEqual((await self.beacon("acme-pricing", body)).json(), {"status": "ok"})
        rows = {r["path"]: r for r in await self.db[de.DAILY].find({"site": self.sid}).to_list(10)}
        self.assertEqual((rows["/pricing"]["views"], rows["/pricing"]["fullscreen"], rows["/pricing"]["opens"], rows["/pricing"]["watch_s"]),
                         (1, 1, 1, 42))
        self.assertEqual(rows["/tour"]["views"], 1)
        stored = json.dumps(rows, default=str)
        self.assertNotIn("Mozilla", stored)  # nothing per reader
        self.assertEqual(set(rows["/pricing"]) - {"_id"}, {"site", "day", "slug", "path", "views", "fullscreen", "opens", "watch_s", "doc_id", "expires_at"})

    async def test_only_from_the_guides_own_address_and_only_public_files(self):
        await self.doc("acme-pricing")
        await self.doc("acme-secret", access_level="private")
        for origin in (None, "https://evil.example", "http://" + self.origin[8:]):
            self.assertEqual((await self.beacon("acme-pricing", {"p": "/", "a": "view"}, origin=origin)).json(), {"status": "ignored"}, origin)
        self.assertEqual((await self.beacon("acme-secret", {"p": "/", "a": "view"})).json(), {"status": "ignored"})
        self.assertEqual((await self.beacon("acme-pricing", {"p": "/", "a": "view"}, ua="curl/8")).json(), {"status": "ignored"})
        self.assertEqual((await self.beacon("acme-pricing", {"p": "/", "a": "steal"})).json(), {"status": "ignored"})
        self.assertEqual(await self.db["events"].count_documents({}), 0)
        self.assertEqual(await self.db[de.DAILY].count_documents({}), 0)

    async def test_insights_off_still_counts_for_the_creator(self):
        d = await self.doc("acme-pricing")
        await self.db["docs_sites"].update_one({"_id": ObjectId(self.sid)}, {"$set": {"settings.insights.enabled": False}})
        docs_sites.reset()
        self.assertEqual((await self.beacon("acme-pricing", {"p": "/", "a": "view"})).json(), {"status": "ok"})
        self.assertEqual(await self.db["events"].count_documents({"doc_id": str(d["_id"])}), 1)
        self.assertEqual(await self.db[de.DAILY].count_documents({}), 0)

    async def test_markdrops_own_docs(self):
        d = await self.doc("acme-pricing")
        h = {"Content-Type": "text/plain", "User-Agent": DESKTOP, "Origin": settings.docs_cors_origins[0] if settings.docs_cors_origins else "http://docs.localhost:3000"}
        r = await self.http.post(f"{EMB}/acme-pricing/beacon", content=json.dumps({"site": "markdrop", "p": "/guides/embed", "a": "view"}), headers=h)
        self.assertEqual(r.json(), {"status": "ok"})
        [ev] = await self.db["events"].find({"doc_id": str(d["_id"])}).to_list(10)
        self.assertEqual(ev["utm_campaign"], "Markdrop Docs")

    async def test_the_insights_tab(self):
        await self.doc("acme-pricing")
        await self.doc("acme-tour", mime=MP4)
        for _ in range(3):
            await self.beacon("acme-pricing", {"p": "/pricing", "a": "view"})
        await self.beacon("acme-tour", {"p": "/start", "a": "play"})
        await self.beacon("acme-tour", {"p": "/start", "a": "watch", "s": 120})
        out = await self.get(f"/{self.sid}/insights/embeds?range=7d", who="viewer")
        self.assertEqual([e["slug"] for e in out["embeds"]], ["acme-pricing", "acme-tour"])
        first = out["embeds"][0]
        self.assertEqual((first["views"], first["title"], first["renderer"], first["pages"]), (3, "Acme Pricing", "html", [{"path": "/pricing", "views": 3}]))
        self.assertEqual((out["totals"]["views"], out["totals"]["plays"], out["totals"]["watch_s"], out["totals"]["files"]), (3, 1, 120, 2))
        # No longer public: listed, without its title.
        await self.db["documents"].update_one({"slug": "acme-pricing"}, {"$set": {"access_level": "private"}})
        first = (await self.get(f"/{self.sid}/insights/embeds"))["embeds"][0]
        self.assertEqual((first["title"], first["public"]), (None, False))
        await self.get(f"/{self.sid}/insights/embeds", who="stranger", expect=404)
        # Clearing Insights clears these too.
        await self.call("DELETE", f"/{self.sid}/insights")
        self.assertEqual(await self.db[de.DAILY].count_documents({}), 0)


if __name__ == "__main__":
    unittest.main()
