"""Markdrop files embedded in docs pages (services/docs_embeds.py, routers/docs_embeds.py).

The public resolve (only files anyone with the link can open; every other state carries no title,
no size, no address; renamed files follow; a pinned version only for the guide it was pinned for,
signed), CORS `*`, the studio's picker / link check / "anyone with the link" / version pins and
their roles, the beacons (the guide's own addresses only; the file's creator analytics get a view
from the "Guides" channel with the guide as campaign), the guide's Insights events (k "embed" in the
Insights beacon format: stable block ids, quartiles, drop-off, PDF pages; the Fix list reads them),
the Insights tab's per-block numbers, the text versions (a PDF's text and outline extracted once per
blob, public files only, in the build's embeds.json and the Ask AI index) and site.json's `markdrop`.
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
        await self.db[de.TEXTS].delete_many({})
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


def tiny_pdf(lines: list[str], outline: list[str] = ()) -> bytes:
    """A small, valid PDF: one page per line of text (Helvetica), with bookmarks."""
    objs: list[bytes] = []
    n_pages = len(lines)
    font = 3 + 2 * n_pages
    outline_root = font + 1 if outline else None
    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(n_pages))
    objs.append(b"<</Type/Catalog/Pages 2 0 R" + (f"/Outlines {outline_root} 0 R".encode() if outline else b"") + b">>")
    objs.append(f"<</Type/Pages/Kids[{kids}]/Count {n_pages}>>".encode())
    for i, text in enumerate(lines):
        stream = f"BT /F1 18 Tf 72 720 Td ({text}) Tj ET".encode()
        objs.append(f"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 {font} 0 R>>>>/Contents {4 + 2 * i} 0 R>>".encode())
        objs.append(b"<</Length " + str(len(stream)).encode() + b">>stream\n" + stream + b"\nendstream")
    objs.append(b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>")
    if outline:
        first = outline_root + 1
        last = outline_root + len(outline)
        objs.append(f"<</Type/Outlines/First {first} 0 R/Last {last} 0 R/Count {len(outline)}>>".encode())
        for j, title in enumerate(outline):
            me = first + j
            prev = f"/Prev {me - 1} 0 R" if j else ""
            nxt = f"/Next {me + 1} 0 R" if j < len(outline) - 1 else ""
            objs.append(f"<</Title({title})/Parent {outline_root} 0 R{prev}{nxt}/Dest[3 0 R/Fit]>>".encode())
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs):
        offsets.append(len(out))
        out += f"{i + 1} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<</Size {len(objs) + 1}/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


class BeaconTests(EmbedsCase):
    async def test_a_view_counts_for_the_creator_from_the_guides_channel(self):
        d = await self.doc("acme-pricing")
        r = await self.beacon("acme-pricing", {"p": "/pricing?x=1", "a": "view"})
        self.assertEqual((r.status_code, r.json()), (202, {"status": "ok"}))
        self.assertEqual(r.headers["access-control-allow-origin"], "*")
        self.assertEqual((await self.db["documents"].find_one({"_id": d["_id"]}))["views"], 1)
        [ev] = await self.db["events"].find({"doc_id": str(d["_id"])}).to_list(10)
        self.assertEqual((ev["type"], ev["channel"], ev["utm_source"], ev["utm_medium"], ev["utm_campaign"]),
                         ("view", "Guides", "markdrop-guides", "embed", "Acme Docs"))
        # Only views reach the creator; the guide's own events go through the Insights beacon.
        self.assertEqual((await self.beacon("acme-pricing", {"p": "/pricing", "a": "fullscreen"})).json(), {"status": "ignored"})
        self.assertEqual(await self.db["events"].count_documents({}), 1)

    async def test_only_from_the_guides_own_address_and_only_public_files(self):
        await self.doc("acme-pricing")
        await self.doc("acme-secret", access_level="private")
        for origin in (None, "https://evil.example", "http://" + self.origin[8:]):
            self.assertEqual((await self.beacon("acme-pricing", {"p": "/", "a": "view"}, origin=origin)).json(), {"status": "ignored"}, origin)
        self.assertEqual((await self.beacon("acme-secret", {"p": "/", "a": "view"})).json(), {"status": "ignored"})
        self.assertEqual((await self.beacon("acme-pricing", {"p": "/", "a": "view"}, ua="curl/8")).json(), {"status": "ignored"})
        self.assertEqual((await self.beacon("acme-pricing", {"p": "/", "a": "steal"})).json(), {"status": "ignored"})
        self.assertEqual(await self.db["events"].count_documents({}), 0)

    async def test_markdrops_own_docs(self):
        d = await self.doc("acme-pricing")
        h = {"Content-Type": "text/plain", "User-Agent": DESKTOP, "Origin": settings.docs_cors_origins[0] if settings.docs_cors_origins else "http://docs.localhost:3000"}
        r = await self.http.post(f"{EMB}/acme-pricing/beacon", content=json.dumps({"site": "markdrop", "p": "/guides/embed", "a": "view"}), headers=h)
        self.assertEqual(r.json(), {"status": "ok"})
        [ev] = await self.db["events"].find({"doc_id": str(d["_id"])}).to_list(10)
        self.assertEqual(ev["utm_campaign"], "Markdrop Docs")


INS = "/api/v1/docs/insights"


class InsightTests(EmbedsCase):
    async def event(self, body: dict, origin: str | None = "own", dnt: bool = False):
        h = {"Content-Type": "text/plain;charset=UTF-8", "User-Agent": DESKTOP}
        if origin:
            h["Origin"] = self.origin if origin == "own" else origin
        if dnt:
            h["DNT"] = "1"
        return await self.http.post(f"{INS}/{self.sid}/event", content=json.dumps({"k": "embed", **body}), headers=h)

    async def raw(self) -> list[dict]:
        return await self.db[gi.RAW].find({"site": self.sid, "k": "embed"}).sort([("ts", 1), ("_id", 1)]).to_list(1000)

    async def test_events_in_the_insights_format_with_a_stable_block_id(self):
        r = await self.event({"p": "/start/tour?x=1", "e": "acme-tour", "s": "acme-tour", "a": "view"})
        self.assertEqual((r.status_code, r.json()), (202, {"status": "ok"}))
        for body in ({"a": "play"}, {"a": "quartile", "qt": 25}, {"a": "quartile", "qt": 50},
                     {"a": "leave", "t": 42.4, "w": 40, "d": 125.0}, {"a": "pages", "pg": 3, "n": 12, "e": "acme-prices", "s": "acme-prices"}):
            r = await self.event({"p": "/start/tour", "e": "acme-tour", "s": "acme-tour", **body})
            self.assertEqual(r.json(), {"status": "ok"}, body)
        evs = await self.raw()
        self.assertEqual([(e["a"], e["p"], e["e"]) for e in evs][:2], [("view", "/start/tour", "acme-tour"), ("play", "/start/tour", "acme-tour")])
        leave = next(e for e in evs if e["a"] == "leave")
        self.assertEqual((leave["t"], leave["w"], leave["d"]), (42.4, 40, 125.0))
        self.assertEqual(next(e for e in evs if e["a"] == "pages")["pg"], 3)
        self.assertEqual(len(evs[0]["v"]), 24)  # the Insights visitor hash, nothing else about the reader
        stored = json.dumps(evs, default=str)
        self.assertNotIn("Mozilla", stored)
        self.assertNotIn("x=1", stored)

    async def test_bad_events_dnt_and_foreign_origins(self):
        for body in ({"e": "x", "s": "x", "a": "steal"}, {"e": "<x>", "s": "x", "a": "view"}, {"e": "x", "s": "x", "a": "quartile", "qt": 33},
                     {"e": "x", "s": "x", "a": "leave"}, {"e": "x", "s": "../x", "a": "view"}):
            self.assertEqual((await self.event({"p": "/a", **body})).json(), {"status": "ignored"}, body)
        r = await self.event({"p": "/a", "e": "x", "s": "x", "a": "view"}, origin="https://evil.example")
        self.assertEqual(r.status_code, 403)
        await self.event({"p": "/a", "e": "x", "s": "x", "a": "view"}, dnt=True)
        [ev] = await self.raw()
        self.assertIsNone(ev["v"])  # Do Not Track: counted, without a visitor hash

    async def test_the_insights_tab_ranks_blocks_and_finds_the_drop_off(self):
        await self.doc("acme-pricing")
        await self.doc("acme-tour", mime=MP4)
        await self.doc("acme-prices", mime=PDF)
        tour = {"p": "/start", "e": "acme-tour", "s": "acme-tour"}
        for _ in range(3):
            await self.event({"p": "/pricing", "e": "acme-pricing", "s": "acme-pricing", "a": "view"})
        await self.event({"p": "/pricing", "e": "acme-pricing", "s": "acme-pricing", "a": "interact"})
        await self.event({"p": "/pricing", "e": "acme-pricing~2", "s": "acme-pricing", "a": "view"})
        for t in (42.0, 43.5, 44.9, 90.0, 124.0):
            await self.event({**tour, "a": "view"})
            await self.event({**tour, "a": "play"})
            await self.event({**tour, "a": "leave", "t": t, "w": int(t), "d": 125.0})
        await self.event({**tour, "a": "quartile", "qt": 25})
        for pg in (2, 3, 3):
            await self.event({"p": "/pricing", "e": "acme-prices", "s": "acme-prices", "a": "pages", "pg": pg, "n": 12})
        out = await self.get(f"/{self.sid}/insights/embeds?range=7d", who="viewer")
        tour_b = next(b for b in out["embeds"] if b["embed"] == "acme-tour")
        self.assertEqual((tour_b["views"], tour_b["plays"], tour_b["page"], tour_b["renderer"]), (5, 5, "/start", "video"))
        self.assertEqual(tour_b["drop_off"], {"at": 40, "stopped": 3, "of": 5})
        self.assertEqual(tour_b["quartiles"]["25"], 1)
        price = next(b for b in out["embeds"] if b["embed"] == "acme-pricing")
        self.assertEqual((price["views"], price["interaction_rate"], price["title"]), (3, 0.333, "Acme Pricing"))
        self.assertTrue(any(b["embed"] == "acme-pricing~2" for b in out["embeds"]))
        pdf = next(b for b in out["embeds"] if b["embed"] == "acme-prices")
        self.assertEqual(pdf["pdf"], {"median_page": 3.0, "pages": 12, "readers": 3})
        self.assertEqual(out["totals"]["files"], 3)
        # No longer public: listed, without its title.
        await self.db["documents"].update_one({"slug": "acme-pricing"}, {"$set": {"access_level": "private"}})
        price = next(b for b in (await self.get(f"/{self.sid}/insights/embeds"))["embeds"] if b["embed"] == "acme-pricing")
        self.assertEqual((price["title"], price["public"]), (None, False))
        await self.get(f"/{self.sid}/insights/embeds", who="stranger", expect=404)
        # Clearing Insights clears these too (they are the guide's raw events).
        await self.call("DELETE", f"/{self.sid}/insights")
        self.assertEqual(await self.raw(), [])


class TextVersionTests(EmbedsCase):
    def test_pdf_text_and_outline(self):
        out = de.extract_pdf(tiny_pdf(["Acme price list", "Starter 9 dollars a month"], ["Plans", "Add-ons"]))
        self.assertEqual(out["pages"], 2)
        self.assertEqual(out["outline"], ["Plans", "Add-ons"])
        self.assertIn("Acme price list", out["text"])
        self.assertIn("Starter 9 dollars", out["text"])
        self.assertEqual(de.extract_pdf(b"not a pdf"), {})

    async def test_build_writes_embeds_json_for_public_files_only(self):
        pdf = await self.doc("acme-prices", mime=PDF)
        await self.doc("acme-tour", mime=MP4, media={"duration_s": 125.4})
        await self.doc("acme-secret", access_level="private")
        data = tiny_pdf(["Acme price list"], ["Plans"])
        calls = []

        def get_bytes(key, max_bytes):
            calls.append(key)
            return data if key == pdf["blob_key"] else None

        pages = [{"path": "/start", "markdown": '::markdrop{src="https://markdrop.in/acme-prices"}\n\n::markdrop{src="https://markdrop.in/acme-tour" summary="x"}\n\n'
                  '::markdrop{src="https://markdrop.in/acme-secret"}\n\n::markdrop{src="https://markdrop.in/acme-prices"}'}]
        with mock.patch.object(r2, "get_bytes", get_bytes):
            infos = await de.text_infos(self.db, pages)
            again = await de.text_infos(self.db, pages)
        self.assertEqual(sorted(infos), ["acme-prices", "acme-tour"])  # nothing at all about the private file
        self.assertEqual((infos["acme-prices"]["type"], infos["acme-prices"]["pages"], infos["acme-prices"]["outline"]), ("PDF", 1, ["Plans"]))
        self.assertIn("Acme price list", infos["acme-prices"]["text"])
        self.assertEqual((infos["acme-tour"]["type"], infos["acme-tour"]["duration"]), ("Video", 125.4))
        self.assertEqual(again, infos)
        self.assertEqual(calls, [pdf["blob_key"]])  # extracted once per blob
        # The Ask AI index reads the same text version.
        from app.services import docs_index

        plain = docs_index.to_plain_markdown('::markdrop{src="https://markdrop.in/acme-prices" summary="Plans and prices."}', embeds=infos)
        self.assertIn("[PDF: Acme Prices](https://markdrop.in/acme-prices) (1 page)", plain)
        self.assertIn("Plans and prices.", plain)
        self.assertIn("Text: Acme price list", plain)
        self.assertEqual(docs_index.to_plain_markdown('::markdrop{src="https://markdrop.in/acme-secret"}', embeds=infos),
                         "[Markdrop file: acme-secret](https://markdrop.in/acme-secret)")

    async def test_content_files_carry_embeds_json(self):
        row = {"_id": ObjectId(), "name": "Acme", "slug": "acme", "settings": {}, "engine_extra": {}, "domains": []}
        files, _ = docs_snapshot.content_files(row, {"pages": [], "settings": {}, "embeds": {"a": {"title": "A"}}}, url="https://u", ai_api="https://a")
        self.assertEqual(json.loads(files["embeds.json"]), {"a": {"title": "A"}})
        files, _ = docs_snapshot.content_files(row, {"pages": [], "settings": {}}, url="https://u", ai_api="https://a")
        self.assertNotIn("embeds.json", files)


if __name__ == "__main__":
    unittest.main()
