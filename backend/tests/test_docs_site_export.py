"""Settings › Export & self-host (routers/docs_site_export.py, services/docs_site_export.py).

The docs bucket is the in-memory fake (tests/_docs_sites_env.py) with list and read added here.
"""

from __future__ import annotations

import io
import json
import time
import unittest
import zipfile
from unittest import mock
from urllib.parse import parse_qs, urlsplit

from PIL import Image

from tests._docs_sites_env import API, BASE, DocsSitesCase

from app.services import docs_page_access as pa
from app.services import docs_site_assets
from app.services import docs_site_export as export


def png(w: int, h: int) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (w, h), (200, 30, 30)).save(out, format="PNG")
    return out.getvalue()


class ExportTests(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        objects = self.bucket.objects
        for p in (
            mock.patch.object(docs_site_assets, "list_objects",
                              lambda prefix: [{"key": k, "size": len(v["data"])} for k, v in objects.items() if k.startswith(prefix)]),
            mock.patch.object(docs_site_assets, "get_bytes", lambda key: (objects.get(key) or {}).get("data")),
        ):
            p.start()
            self.addCleanup(p.stop)
        self.site = await self.create("acme", source={"kind": "template", "template": "product"})
        self.sid = self.site["id"]

    # ── helpers ──

    async def pages(self) -> list[dict]:
        return (await self.get(f"/{self.sid}/pages"))["pages"]

    async def set_page(self, path: str, *, markdown: str | None = None, access_rule: str | None = None) -> None:
        p = next(x for x in await self.pages() if x["path"] == path)
        full = await self.get(f"/{self.sid}/pages/{p['id']}")
        body: dict = {"base_rev": full["rev"]}
        if markdown is not None:
            body["markdown"] = markdown
        if access_rule is not None:
            body["frontmatter_extra"] = {**full["frontmatter_extra"], "access": access_rule}
        await self.call("PUT", f"/{self.sid}/pages/{p['id']}", json=body)

    async def upload(self, data: bytes, name: str = "shot.png") -> str:
        r = await self.http.post(f"{BASE}/{self.sid}/assets", headers=self.h["owner"],
                                 files={"file": (name, data, "image/png")})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["url"]

    async def start(self, who: str = "owner", expect: int = 200, **body) -> dict:
        return await self.call("POST", f"/{self.sid}/export", who, expect, json=body)

    async def download(self, url: str, expect: int = 200) -> zipfile.ZipFile | None:
        u = urlsplit(url)
        self.assertEqual(f"{u.scheme}://{u.netloc}", API.rstrip("/"))
        r = await self.http.get(f"{u.path}?{u.query}")  # no Authorization header: the token is it
        self.assertEqual(r.status_code, expect, r.text[:300])
        if expect != 200:
            return None
        self.assertEqual(r.headers["content-type"], "application/zip")
        self.assertIn('attachment; filename="acme.zip"', r.headers["content-disposition"])
        zf = zipfile.ZipFile(io.BytesIO(r.content))
        self.assertIsNone(zf.testzip())
        return zf

    @staticmethod
    def read(zf: zipfile.ZipFile, rel: str) -> str:
        return zf.read(f"acme/{rel}").decode()

    # ── tests ──

    async def test_admins_only(self):
        await self.start("viewer", 403, source="drafts")
        await self.start("editor", 403, source="drafts")
        await self.start("stranger", 404, source="drafts")
        out = await self.start("admin", source="drafts")
        self.assertEqual(out["filename"], "acme.zip")
        await self.start("owner", 422, source="everything")

    async def test_published_needs_a_publish_and_drafts_dont(self):
        r = await self.start(expect=409, source="published")
        self.assertIn("hasn't been published", r["detail"])
        out = await self.start(source="drafts")
        self.assertEqual((out["source"], out["private"]), ("drafts", "omit"))
        self.assertGreater(out["pages"], 0)

    async def test_the_folder_is_what_the_builder_reads_and_self_hosts_cleanly(self):
        await self.call("PATCH", f"/{self.sid}", json={"settings": {"ai": {"enabled": True}, "theme": {"preset": "minimal"}}})
        used = await self.upload(png(40, 20))
        await self.upload(png(8, 8)[:-12] + b"unused-file!", name="other.png")  # not on any page
        await self.set_page("/", markdown=f"Welcome.\n\n![A shot]({used})\n")
        out = await self.start(source="drafts")
        self.assertEqual(out["files"], 1)
        self.assertTrue(any("Ask AI is off" in n for n in out["notes"]))
        zf = await self.download(out["url"])
        names = set(zf.namelist())
        self.assertTrue({"acme/site.json", "acme/index.md", "acme/README.txt", "acme/media.json"} <= names, names)
        rel = used[len("/docs-assets/"):]
        self.assertIn(f"acme/public/docs-assets/{rel}", names)
        self.assertEqual(sum(n.startswith("acme/public/") for n in names), 1)
        self.assertTrue(all(n.startswith("acme/") for n in names))
        sj = json.loads(self.read(zf, "site.json"))
        self.assertEqual(sj["ai"], {"enabled": False})
        for gone in ("feedback", "insights", "signals", "access"):
            self.assertNotIn(gone, sj)
        self.assertEqual(sj["theme"]["preset"], "minimal")
        self.assertTrue(sj["nav"])
        for g in sj["nav"]:
            for path in g["pages"]:
                self.assertIn(f"acme/{path[1:]}.md", names)
        self.assertIn(f"![A shot]({used})", self.read(zf, "index.md"))
        self.assertTrue(self.read(zf, "index.md").startswith("---\ntitle: "))
        media = json.loads(self.read(zf, "media.json"))
        self.assertEqual(media[used], {"w": 40, "h": 20, "bytes": len(zf.read(f"acme/public/docs-assets/{rel}")), "kind": "image"})
        self.assertIn("ghcr.io/himanshkukreja/markdrop-guides", self.read(zf, "README.txt"))
        # The download is counted (ids and counts only).
        ev = await self.db["docs_events"].find_one({"kind": "docs_exported"})
        self.assertEqual((ev["meta"]["source"], ev["meta"]["files"]), ("drafts", 1))

    async def test_published_is_the_live_publish_not_the_drafts(self):
        await self.set_page("/", markdown="Live words.\n")
        b = await self.call("POST", f"/{self.sid}/publish", json={}, expect=202)
        await self.mark_live(b["id"])
        await self.set_page("/", markdown="Draft words.\n")
        live = await self.download((await self.start(source="published"))["url"])
        self.assertIn("Live words.", self.read(live, "index.md"))
        drafts = await self.download((await self.start(source="drafts"))["url"])
        self.assertIn("Draft words.", self.read(drafts, "index.md"))
        # Unpublished: its last publish still exports.
        await self.call("POST", f"/{self.sid}/unpublish")
        again = await self.download((await self.start(source="published"))["url"])
        self.assertIn("Live words.", self.read(again, "index.md"))

    async def test_private_pages_and_sections_left_out_or_made_public(self):
        await self.call("POST", f"/{self.sid}/private/rules", json={"kind": "people", "name": "Northwind", "emails": ["jane@partner.io"]})
        target = next(p for p in await self.pages() if p["path"] != "/")
        await self.set_page(target["path"], access_rule="northwind")
        await self.set_page("/", markdown="Welcome.\n\n:::private[Rates]{access=\"members\"}\nTeam only text.\n:::\n\nAfter.\n")
        out = await self.start(source="drafts")
        self.assertTrue(any("1 private page and 1 private section left out" in n for n in out["notes"]), out["notes"])
        zf = await self.download(out["url"])
        names = zf.namelist()
        self.assertNotIn(f"acme/{target['path'][1:]}.md", names)
        sj = json.loads(self.read(zf, "site.json"))
        self.assertNotIn(target["path"], json.dumps(sj["nav"]))
        home = self.read(zf, "index.md")
        self.assertNotIn("Team only", home)
        self.assertNotIn("Private section", home)
        self.assertIn("After.", home)
        self.assertNotIn("jane@partner.io", json.dumps({n: zf.read(n).decode("utf-8", "replace") for n in names}))

        pub = await self.download((await self.start(source="drafts", private="public"))["url"])
        home = self.read(pub, "index.md")
        self.assertIn("Team only text.", home)
        self.assertNotIn(":::private", home)
        self.assertNotIn("\n:::\n", home)
        page = self.read(pub, f"{target['path'][1:]}.md")
        self.assertNotIn("access:", page)
        self.assertNotIn("access", json.loads(self.read(pub, "site.json")))

    async def test_a_private_guide_is_flagged(self):
        await self.call("PATCH", f"/{self.sid}", json={"settings": {"access": {"level": "members"}}})
        out = await self.start(source="drafts")
        self.assertTrue(any("members-only" in n for n in out["notes"]))

    async def test_links_expire_name_one_guide_and_need_an_admin_still(self):
        out = await self.start(source="drafts")
        q = parse_qs(urlsplit(out["url"]).query)
        token = q["token"][0]
        await self.download(f"{API}{BASE}/{self.sid}/export/download?token={token}x", expect=404)
        other = await self.create("other-guide")
        await self.download(f"{API}{BASE}/{other['id']}/export/download?token={token}", expect=404)
        with mock.patch.object(time, "time", lambda: out["expires_at"] + 1):
            await self.download(out["url"], expect=404)
        # The admin loses the role: the link stops working.
        await self.db["memberships"].update_one({"workspace_id": self.ws, "user_id": self.uid["admin"]}, {"$set": {"role": "member"}})
        out2 = await self.start("owner", source="drafts")
        tok, _ = export.sign(self.sid, self.uid["admin"], "drafts", "omit")
        await self.download(f"{API}{BASE}/{self.sid}/export/download?token={tok}", expect=404)
        await self.download(out2["url"])

    async def test_too_large(self):
        with mock.patch.object(export, "MAX_BYTES", 10):
            r = await self.start(expect=413, source="drafts")
        self.assertIn("at most", r["detail"])


class SplitPrivateForExport(unittest.TestCase):
    def test_default_unchanged_and_export_modes(self):
        src = "a\n:::private[Plan]\nsecret\n::::tip\nnested\n::::\n:::\nb"
        self.assertEqual(pa.split_private(src, None)[0], "a\n_Private section: Plan._\nb")
        self.assertEqual(pa.split_private(src, None, placeholder=False)[0], "a\nb")
        shown = pa.split_private(src, export._Everything(), unwrap=True)[0]
        self.assertEqual(shown, "a\nsecret\n::::tip\nnested\n::::\nb")
        # A fence inside code is text.
        code = "```md\n:::private\nx\n:::\n```"
        self.assertEqual(pa.split_private(code, export._Everything(), unwrap=True)[0], code)
        # Revealing without unwrap keeps the closing fence, as Ask AI always has.
        self.assertEqual(pa.split_private(src, {"members"})[0], "a\nsecret\n::::tip\nnested\n::::\n:::\nb")

    def test_referenced_files(self):
        objs = [{"key": f"sites/s1/assets/{n}", "size": 1} for n in ("a.png", "a.dark.png", "clip.mp4", "clip.webp", "zzz.png")]
        objs.append({"key": "sites/s2/assets/a.png", "size": 1})
        got = [o["rel"] for o in export.referenced(objs, "s1", "![x](/docs-assets/a.png) ::clip{src=\"/docs-assets/clip\"}")]
        self.assertEqual(got, ["a.dark.png", "a.png", "clip.mp4", "clip.webp"])
        videos = {"/docs-assets/clip"}
        self.assertEqual(export.media_entry("clip.webp", png(4, 2), videos)["kind"], "poster")
        self.assertEqual(export.media_entry("clip.mp4", b"0" * 9, videos), {"bytes": 9, "kind": "clip"})
        self.assertIsNone(export.media_entry("notes.pdf", b"%PDF", videos))


if __name__ == "__main__":
    unittest.main()
