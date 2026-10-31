"""Markdrop Guides additions to the docs-sites API: the all-scopes listing (the studio's home),
the import job reference on a site, dark-theme image versions, and redirects in settings.

The docs R2 bucket is in memory (tests/_docs_sites_env.py); nothing here reaches a network.
"""

from __future__ import annotations

import hashlib
import io
import unittest

from bson import ObjectId

from tests._docs_sites_env import BASE, DocsSitesCase, now

from app.services import docs_site_redirects as redirects


def png(color=(255, 255, 255), fmt="PNG") -> bytes:
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (4, 3), color).save(out, format=fmt)
    return out.getvalue()


class AllScopes(DocsSitesCase):
    async def test_every_site_you_can_open_grouped_by_workspace(self):
        ws_site = await self.create("acme")
        mine = await self.create("owners-own", workspace=False, name="Owner notes")
        await self.create("strangers", "stranger", workspace=False, name="Not yours")
        # A second workspace where the owner is only a viewer.
        other = str((await self.db["workspaces"].insert_one({
            "name": "Beta", "owner_id": self.uid["stranger"], "created_at": now(), "updated_at": now(),
            "branding": {"accent_color": "#0f766e", "logo_url": "https://beta.example/logo.png"},
            "settings": {}})).inserted_id)
        for who, role in (("stranger", "owner"), ("owner", "viewer")):
            await self.db["memberships"].insert_one({"workspace_id": other, "user_id": self.uid[who], "role": role,
                                                     "created_at": now()})
        await self.grant("owner", "viewer", other)  # a viewer in Markdrop Guides there
        beta =await self.call("POST", "", "stranger", 201, json={
            "workspace_id": other, "name": "Beta Docs", "slug": "beta", "source": {"kind": "blank"}})

        out = await self.get("", params={"scope": "all"})
        by_id = {s["id"]: s for s in out["sites"]}
        self.assertEqual(set(by_id), {ws_site["id"], mine["id"], beta["id"]})
        self.assertEqual(by_id[ws_site["id"]]["workspace"]["name"], "Acme")
        self.assertEqual(by_id[ws_site["id"]]["your_role"], "admin")
        self.assertIsNone(by_id[mine["id"]]["workspace"])
        self.assertEqual(by_id[mine["id"]]["your_role"], "admin")
        self.assertEqual(by_id[beta["id"]]["your_role"], "viewer")
        self.assertEqual(by_id[beta["id"]]["workspace"],
                         {"id": other, "name": "Beta", "accent": "#0f766e", "logo_url": "https://beta.example/logo.png"})
        wss = {w["id"]: w for w in out["workspaces"]}
        self.assertEqual((wss[self.ws]["can_create"], wss[self.ws]["usage"]["sites"]), (True, 1))
        self.assertEqual((wss[other]["can_create"], wss[other]["your_role"], wss[other]["workspace_role"]),
                         (False, "viewer", "viewer"))
        self.assertEqual(out["personal"]["usage"]["sites"], 1)
        self.assertTrue(out["personal"]["can_create"])

        # An editor of Acme sees its sites but can't create there.
        ed = await self.get("", "editor", params={"scope": "all"})
        self.assertEqual([s["id"] for s in ed["sites"]], [ws_site["id"]])
        self.assertEqual(ed["sites"][0]["your_role"], "editor")
        self.assertFalse(ed["workspaces"][0]["can_create"])
        # A workspace being deleted: no new sites there.
        await self.db["workspaces"].update_one({"_id": ObjectId(self.ws)}, {"$set": {"deleting": True}})
        out = await self.get("", params={"scope": "all"})
        self.assertFalse({w["id"]: w for w in out["workspaces"]}[self.ws]["can_create"])
        # Deleted sites drop out; other scopes are refused.
        await self.call("DELETE", f"/{mine['id']}")
        out = await self.get("", params={"scope": "all"})
        self.assertNotIn(mine["id"], {s["id"] for s in out["sites"]})
        await self.get("", params={"scope": "everything"}, expect=422)


class ImportJobReference(DocsSitesCase):
    async def test_gitbook_site_keeps_its_import_job(self):
        site = await self.create("acme", source={"kind": "gitbook", "url": "https://docs.acme.com"})
        self.assertTrue(site["job"]["id"])
        self.assertEqual(site["last_import_job_id"], site["job"]["id"])
        again = await self.get(f"/{site['id']}")
        self.assertEqual(again["last_import_job_id"], site["job"]["id"])
        job = await self.get(f"/{site['id']}/jobs/{again['last_import_job_id']}")
        self.assertEqual(job["kind"], "import")
        blank = await self.create("blank-one")
        self.assertIsNone(blank["last_import_job_id"])


class DarkVersions(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.sid = (await self.create("acme"))["id"]

    async def upload(self, data: bytes, name: str = "a.png", expect: int = 201, **form) -> dict:
        r = await self.http.post(f"{BASE}/{self.sid}/assets", files={"file": (name, data, "image/png")},
                                 data=form, headers=self.h["editor"])
        self.assertEqual(r.status_code, expect, r.text)
        return r.json()

    async def test_dark_version_lives_at_the_engines_address(self):
        light = await self.upload(png())
        digest = hashlib.sha256(png()).hexdigest()
        self.assertEqual(light["url"], f"/docs-assets/{digest}.png")
        dark_bytes = png((0, 0, 0))
        dark = await self.upload(dark_bytes, "dark.png", variant="dark", **{"for": light["url"]})
        # darkVariantPath("/docs-assets/<sha>.png") in the editor = "/docs-assets/<sha>.dark.png".
        self.assertEqual(dark["url"], f"/docs-assets/{digest}.dark.png")
        self.assertEqual((dark["variant"], dark["for"]), ("dark", light["url"]))
        key = f"sites/{self.sid}/assets/{digest}.dark.png"
        self.assertEqual(self.bucket.objects[key]["data"], dark_bytes)
        self.assertEqual(self.bucket.objects[key]["cache_control"], "public, max-age=3600")
        # Replacing it keeps one row and counts its bytes once.
        newer = png((20, 20, 20))
        await self.upload(newer, "dark2.png", variant="dark", **{"for": light["url"]})
        self.assertEqual(self.bucket.objects[key]["data"], newer)
        self.assertEqual(await self.db["docs_assets"].count_documents({"variant": "dark"}), 1)
        site = await self.get(f"/{self.sid}")
        self.assertEqual(site["counts"]["storage_bytes"], len(png()) + len(newer))
        # The editor's preview finds it by that name.
        r = await self.http.get(f"{BASE}/{self.sid}/assets/{digest}.dark.png")
        self.assertEqual((r.status_code, r.headers["location"]), (302, f"https://r2.example/{key}?sig=1"))

    async def test_other_formats_are_converted_to_the_images(self):
        light = await self.upload(png())
        digest = hashlib.sha256(png()).hexdigest()
        dark = await self.upload(png((0, 0, 0), "JPEG"), "dark.jpg", variant="dark", **{"for": light["url"]})
        self.assertEqual(dark["url"], f"/docs-assets/{digest}.dark.png")
        stored = self.bucket.objects[f"sites/{self.sid}/assets/{digest}.dark.png"]
        self.assertTrue(stored["data"].startswith(b"\x89PNG"))
        self.assertEqual(stored["content_type"], "image/png")
        # An SVG can't become a PNG.
        svg = b"<svg xmlns='http://www.w3.org/2000/svg'><rect width='1' height='1'/></svg>"
        await self.upload(svg, "dark.svg", 415, variant="dark", **{"for": light["url"]})

    async def test_only_for_this_sites_images(self):
        await self.upload(png(), "d.png", 422, variant="dark", **{"for": f"/docs-assets/{'0' * 64}.png"})
        await self.upload(png(), "d.png", 422, variant="dark", **{"for": "https://elsewhere.example/x.png"})
        await self.upload(png(), "d.png", 422, variant="dark", **{"for": "/docs-assets/../x.png"})
        await self.upload(png(), "d.png", 422, variant="dark")
        csv = await self.upload(b"a,b\n", "x.csv")
        await self.upload(png(), "d.png", 422, variant="dark", **{"for": csv["url"]})
        light = await self.upload(png())
        dark = await self.upload(png((1, 1, 1)), "d.png", variant="dark", **{"for": light["url"]})
        await self.upload(png(), "d.png", 422, variant="dark", **{"for": dark["url"]})  # no dark of a dark
        await self.upload(png(), "d.png", 422, variant="sepia", **{"for": light["url"]})

    async def test_imported_files_preview_by_path(self):
        site_id = ObjectId(self.sid)
        await self.db["docs_assets"].insert_one({
            "site_id": site_id, "sha256": "a" * 64, "ext": "png", "name": "import/intro/shot.png",
            "key": f"sites/{self.sid}/assets/import/intro/shot.png", "url": "/docs-assets/import/intro/shot.png",
            "size": 10, "content_type": "image/png", "source": "import", "created_at": now()})
        r = await self.http.get(f"{BASE}/{self.sid}/assets/import/intro/shot.png")
        self.assertEqual(r.status_code, 302)
        r = await self.http.get(f"{BASE}/{self.sid}/assets/import/intro/other.png")
        self.assertEqual(r.status_code, 404)
        r = await self.http.get(f"{BASE}/{self.sid}/assets/secret/intro/shot.png")
        self.assertEqual(r.status_code, 404)
        # A dark version of an imported image sits beside it.
        dark = await self.upload(png(), "d.png", variant="dark", **{"for": "/docs-assets/import/intro/shot.png"})
        self.assertEqual(dark["url"], "/docs-assets/import/intro/shot.dark.png")


class Redirects(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.site = await self.create("acme", source={"kind": "template", "template": "product"})
        self.sid = self.site["id"]

    async def patch(self, rows, expect=200, who="owner"):
        return await self.call("PATCH", f"/{self.sid}", who, expect, json={"settings": {"redirects": rows}})

    async def test_saved_and_checked_against_the_pages(self):
        ok = [{"from": "/old/start/", "to": "/getting-started/quickstart#install"},
              {"from": "/legacy.md", "to": "/getting-started/introduction"},
              {"from": "/blog", "to": "https://acme.example/blog"},
              {"from": "/news", "to": "/changelog"}]
        site = await self.patch(ok)
        self.assertEqual(site["settings"]["redirects"][0], {"from": "/old/start", "to": "/getting-started/quickstart#install"})
        self.assertEqual(len(site["settings"]["redirects"]), 4)
        # It counts as a change to publish.
        changes = await self.get(f"/{self.sid}/changes")
        self.assertIsInstance(changes, dict)

        def msg(r):
            d = r["detail"]
            return d[0]["msg"] if isinstance(d, list) else d

        cases = {
            "is a page of this site": [{"from": "/getting-started/quickstart", "to": "/help/faq"}],
            "own addresses": [{"from": "/sitemap.xml", "to": "/help/faq"}],
            "no page /nowhere": [{"from": "/x", "to": "/nowhere"}],
            "redirects again": [{"from": "/a", "to": "/b"}, {"from": "/b", "to": "/help/faq"}],
            "home page": [{"from": "/", "to": "/help/faq"}],
            "redirects to itself": [{"from": "/x/", "to": "/x#top"}],
            "twice": [{"from": "/x", "to": "/help/faq"}, {"from": "/x/", "to": "/help/faq"}],
            "plain path": [{"from": "/x?a=1", "to": "/help/faq"}],
            "start the old address": [{"from": "x", "to": "/help/faq"}],
            "https://": [{"from": "/x", "to": "http://insecure.example"}],
        }
        for want, rows in cases.items():
            r = await self.patch(rows, 422)
            self.assertIn(want, msg(r), rows)
        await self.patch(ok, 403, who="editor")
        # Clearing them is always fine.
        site = await self.patch([])
        self.assertEqual(site["settings"]["redirects"], [])

    async def test_a_page_cant_take_a_redirected_address(self):
        await self.patch([{"from": "/old/start", "to": "/getting-started/quickstart"}])
        r = await self.call("POST", f"/{self.sid}/pages", json={"path": "/old/start", "title": "Hidden"},
                            expect=409)
        self.assertIn("Remove that redirect", r["detail"])

    async def test_snapshot_carries_them(self):
        await self.patch([{"from": "/old", "to": "/help/faq"}])
        build = await self.call("POST", f"/{self.sid}/publish", expect=202, json={})
        snap = await self.db["docs_snapshots"].find_one({"_id": ObjectId(build["snapshot_id"])})
        self.assertEqual(snap["settings"]["redirects"], [{"from": "/old", "to": "/help/faq"}])
        # …which the build writes as the engine's redirects.json.
        from app.services import docs_snapshot

        site = await self.db["docs_sites"].find_one({"_id": ObjectId(self.sid)})
        files, _warnings = docs_snapshot.content_files(site, snap, url="https://acme.guides.markdrop.in",
                                                       ai_api="https://api.markdrop.in")
        import json

        self.assertEqual(json.loads(files["redirects.json"]), {"/old": "/help/faq"})


class RedirectsUnit(unittest.TestCase):
    def test_clean_and_problems(self):
        rows = redirects.clean([{"from": " /a/ ", "to": "/b"}])
        self.assertEqual(rows, [{"from": "/a", "to": "/b"}])
        self.assertEqual(redirects.problems_against(rows, {"/b"}), [])
        self.assertTrue(redirects.problems_against([{"from": "/b.md", "to": "/c"}], {"/b", "/c"}))
        with self.assertRaises(ValueError):
            redirects.clean([{"from": "/a", "to": "/b", "extra": 1}])
        with self.assertRaises(ValueError):
            redirects.clean("nope")


if __name__ == "__main__":
    unittest.main()
