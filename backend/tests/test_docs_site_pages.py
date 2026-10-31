"""Docs site pages: create, save with base_rev (409), locks (423, heartbeat,
expiry, admin takeover), versions (50 kept, restore), delete, hidden pages and
the sidebar order (routers/docs_site_pages.py)."""

from __future__ import annotations

from datetime import timedelta
from unittest import mock

from bson import ObjectId

from tests._docs_sites_env import BASE, DocsSitesCase, now, settings

from app.services import docs_site_pages


class Pages(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.site = await self.create("acme")
        self.sid = self.site["id"]
        self.home_page = await self.home(self.sid)

    async def new_page(self, path: str, who: str = "editor", expect: int = 201, **extra) -> dict:
        title = extra.pop("title", path.strip("/").rsplit("/", 1)[-1] or "x")
        return await self.call("POST", f"/{self.sid}/pages", who, expect, json={"path": path, "title": title, **extra})

    async def save(self, page: dict, who: str = "editor", expect: int = 200, **fields) -> dict:
        body = {"base_rev": fields.pop("base_rev", page["rev"]), **fields}
        return await self.call("PUT", f"/{self.sid}/pages/{page['id']}", who, expect, json=body)

    async def nav(self) -> list[dict]:
        return (await self.get(f"/{self.sid}/pages"))["nav"]

    async def test_create_and_place_in_nav(self):
        await self.new_page("/guides/a", "viewer", 403)
        await self.new_page("/guides/a", "stranger", 404)
        a = await self.new_page("/guides/a", group="Guides", markdown="# A\n", description="About A")
        self.assertEqual((a["path"], a["title"], a["rev"], a["markdown"], a["description"], a["has_changes"]),
                         ("/guides/a", "a", 1, "# A\n", "About A", True))
        self.assertEqual(a["updated_by_name"], "Editor")
        b = await self.new_page("/Guides/B/", group="Guides")  # normalised
        self.assertEqual(b["path"], "/guides/b")
        c = await self.new_page("/guides/c", after_page_id=a["id"])
        d = await self.new_page("/reference/d")  # no group: the last one
        nav = await self.nav()
        self.assertEqual(nav, [{"group": "Getting started", "pages": [self.home_page["id"]]},
                               {"group": "Guides", "pages": [a["id"], c["id"], b["id"], d["id"]]}])
        await self.new_page("/guides/a", expect=409)
        for bad in ("/a b", "/a/../b", "/x_y", "/" + "/".join(["a"] * 7), "/docs-assets/x", "/changelog",
                    "/mcp", "/-a"):
            await self.new_page(bad, expect=422)
        listing = await self.get(f"/{self.sid}/pages", "viewer")
        self.assertEqual(len(listing["pages"]), 5)
        self.assertEqual(set(listing["pages"][0]), {"id", "path", "title", "icon", "hidden", "has_changes", "lock",
                                                    "rev", "updated_at", "updated_by"})
        await self.get(f"/{self.sid}/pages/{ObjectId()}", expect=404)
        await self.get(f"/{self.sid}/pages/nope", expect=404)

    async def test_page_limit(self):
        with mock.patch.object(settings, "docs_pages_per_site", 2):
            await self.new_page("/one")
            r = await self.http.post(f"{BASE}/{self.sid}/pages", json={"path": "/two", "title": "Two"},
                                     headers=self.h["editor"])
            self.assertEqual(r.status_code, 429)

    async def test_save_with_base_rev(self):
        page = self.home_page
        saved = await self.save(page, markdown="Hello", title="Home", description="Desc", icon="home",
                                frontmatter_extra={"keywords": ["a"]})
        self.assertEqual((saved["rev"], saved["markdown"], saved["title"], saved["icon"]), (2, "Hello", "Home", "home"))
        self.assertEqual(saved["frontmatter_extra"], {"keywords": ["a"]})
        self.assertEqual(saved["lock"]["user_id"], self.uid["editor"])  # saving takes the lock
        # A stale base_rev is a 409 with the current rev.
        r = await self.http.put(f"{BASE}/{self.sid}/pages/{page['id']}", json={"base_rev": 1, "markdown": "x"},
                                headers=self.h["editor"])
        self.assertEqual(r.status_code, 409)
        body = r.json()
        self.assertEqual((body["detail"], body["rev"], body["updated_by_name"]),
                         ("This page changed since you opened it.", 2, "Editor"))
        # Only the fields sent change.
        saved = await self.save(saved, title="Home 2")
        self.assertEqual((saved["rev"], saved["markdown"], saved["title"]), (3, "Hello", "Home 2"))
        await self.save(saved, "viewer", 403, markdown="x")
        await self.save(saved, frontmatter_extra={"title": "x"}, expect=422)
        await self.save(saved, path="/moved", expect=422)  # home can't move
        await self.save(saved, hidden=True, expect=422)  # nor be hidden
        with mock.patch.object(settings, "docs_page_max_chars", 10):
            await self.save(saved, markdown="x" * 11, expect=413)

    async def test_moving_a_page(self):
        a = await self.new_page("/guides/a")
        await self.new_page("/guides/b")
        moved = await self.save(a, path="/guides/b", expect=409)
        moved = await self.save(a, path="/guides/renamed")
        self.assertEqual(moved["path"], "/guides/renamed")
        await self.save(moved, path="/", expect=409)

    async def test_addresses_the_build_skips_are_refused(self):
        for bad in ("/public/x", "/api-reference", "/api-reference/payments", "/video-scenes/a", "/guides/video-scenes/a",
                    "/node_modules/x"):
            r = await self.http.post(f"{BASE}/{self.sid}/pages", json={"path": bad, "title": "x"}, headers=self.h["editor"])
            self.assertEqual(r.status_code, 422, bad)
        r = await self.http.post(f"{BASE}/{self.sid}/pages", json={"path": "/api-reference/x", "title": "x"},
                                 headers=self.h["editor"])
        self.assertEqual(r.json()["detail"], "/api-reference is used by the guide itself. Start the address with another word.")
        a = await self.new_page("/guides/a")
        await self.save(a, path="/public/a", expect=422)
        await self.new_page("/api/payments")  # close, but fine

    async def redirects(self) -> list[dict]:
        return (await self.get(f"/{self.sid}"))["settings"]["redirects"]

    async def test_moving_a_page_redirects_its_published_address(self):
        a = await self.new_page("/guides/a")
        a = await self.save(a, path="/guides/a2")
        self.assertEqual(await self.redirects(), [])  # never published: nobody has links to it
        b = await self.call("POST", f"/{self.sid}/publish", expect=202, json={})
        await self.mark_live(b["id"])
        a = await self.save(a, path="/guides/a3")
        self.assertEqual(await self.redirects(), [{"from": "/guides/a2", "to": "/guides/a3"}])
        # Another move (autosave while typing): the redirect is re-pointed, no chain, no stale entry.
        a = await self.save(a, path="/guides/a4")
        self.assertEqual(await self.redirects(), [{"from": "/guides/a2", "to": "/guides/a4"}])
        await self.call("PATCH", f"/{self.sid}", json={"settings": {"redirects": [
            {"from": "/guides/a2", "to": "/guides/a4"}, {"from": "/old-x", "to": "/guides/a4#sec"}]}})
        a = await self.save(a, path="/guides/a5")
        self.assertEqual(await self.redirects(), [{"from": "/guides/a2", "to": "/guides/a5"},
                                                  {"from": "/old-x", "to": "/guides/a5#sec"}])
        # Back to the published address: the redirect away from it goes (it led to this page).
        a = await self.save(a, path="/guides/a2")
        self.assertEqual(await self.redirects(), [{"from": "/old-x", "to": "/guides/a2#sec"}])
        # An address redirected to another page is still refused.
        await self.new_page("/guides/b")
        await self.call("PATCH", f"/{self.sid}", json={"settings": {"redirects": [{"from": "/gone", "to": "/guides/b"}]}})
        await self.save(a, path="/gone", expect=409)
        # The redirects Settings shows are valid as they are: saving them again passes the checks.
        cur = await self.redirects()
        await self.call("PATCH", f"/{self.sid}", json={"settings": {"redirects": cur}})

    async def test_locks(self):
        page = await self.new_page("/guides/a")
        lock = (await self.call("POST", f"/{self.sid}/pages/{page['id']}/lock", "editor"))["lock"]
        self.assertEqual((lock["user_id"], lock["name"]), (self.uid["editor"], "Editor"))
        await self.call("POST", f"/{self.sid}/pages/{page['id']}/lock", "viewer", 403)
        # Someone else: 423 with the lock, for saving, locking and deleting.
        r = await self.http.put(f"{BASE}/{self.sid}/pages/{page['id']}", json={"base_rev": 1, "markdown": "x"},
                                headers=self.h["admin"])
        self.assertEqual(r.status_code, 423)
        self.assertEqual(r.json()["detail"], "Editor is editing this page.")
        self.assertEqual(r.json()["lock"]["user_id"], self.uid["editor"])
        await self.call("POST", f"/{self.sid}/pages/{page['id']}/lock", "admin", 423)
        await self.call("DELETE", f"/{self.sid}/pages/{page['id']}", "admin", 423)
        # Heartbeat renews.
        before = await self.db["docs_pages"].find_one({"_id": ObjectId(page["id"])})
        again = (await self.call("POST", f"/{self.sid}/pages/{page['id']}/lock", "editor"))["lock"]
        self.assertGreaterEqual(again["expires_at"], lock["expires_at"])
        self.assertTrue(before["lock"])
        # Only admins take over.
        await self.db["memberships"].insert_one({"workspace_id": self.ws, "user_id": self.uid["stranger"],
                                                 "role": "member"})
        await self.grant("stranger", "editor")
        await self.call("POST", f"/{self.sid}/pages/{page['id']}/lock", "stranger", 403, params={"takeover": 1})
        took = (await self.call("POST", f"/{self.sid}/pages/{page['id']}/lock", "admin",
                                params={"takeover": 1}))["lock"]
        self.assertEqual(took["user_id"], self.uid["admin"])
        await self.save(page, "editor", 423, markdown="mine")
        # Releasing someone else's lock does nothing for an editor; an admin may.
        await self.call("DELETE", f"/{self.sid}/pages/{page['id']}/lock", "editor")
        self.assertIsNotNone((await self.get(f"/{self.sid}/pages/{page['id']}"))["lock"])
        await self.call("DELETE", f"/{self.sid}/pages/{page['id']}/lock", "admin")
        self.assertIsNone((await self.get(f"/{self.sid}/pages/{page['id']}"))["lock"])

    async def test_lock_expires_two_minutes_after_heartbeat(self):
        page = await self.new_page("/guides/a")
        await self.call("POST", f"/{self.sid}/pages/{page['id']}/lock", "editor")
        raw = await self.db["docs_pages"].find_one({"_id": ObjectId(page["id"])})
        ttl = raw["lock"]["expires_at"] - raw["draft"]["updated_at"]
        self.assertTrue(timedelta(seconds=110) < ttl <= timedelta(seconds=125), ttl)
        await self.db["docs_pages"].update_one({"_id": ObjectId(page["id"])},
                                               {"$set": {"lock.expires_at": now() - timedelta(seconds=1)}})
        listing = await self.get(f"/{self.sid}/pages")
        self.assertIsNone(next(p for p in listing["pages"] if p["id"] == page["id"])["lock"])
        saved = await self.save(page, "admin", markdown="admin's now")
        self.assertEqual(saved["lock"]["user_id"], self.uid["admin"])

    async def test_versions_kept_and_restored(self):
        page = await self.new_page("/guides/a", markdown="v1")
        with mock.patch.object(docs_site_pages, "VERSIONS_KEPT", 5):
            for i in range(2, 9):
                page = await self.save(page, markdown=f"v{i}")
        versions = await self.get(f"/{self.sid}/pages/{page['id']}/versions", "viewer")
        self.assertEqual([v["rev"] for v in versions], [8, 7, 6, 5, 4])
        self.assertEqual((versions[0]["by_name"], versions[0]["kind"], versions[0]["chars"]), ("Editor", "save", 2))
        self.assertNotIn("markdown", versions[0])
        v5 = await self.get(f"/{self.sid}/pages/{page['id']}/versions/5")
        self.assertEqual(v5["markdown"], "v5")
        await self.get(f"/{self.sid}/pages/{page['id']}/versions/1", expect=404)
        await self.call("POST", f"/{self.sid}/pages/{page['id']}/versions/5/restore", "viewer", 403)
        restored = await self.call("POST", f"/{self.sid}/pages/{page['id']}/versions/5/restore", "editor")
        self.assertEqual((restored["rev"], restored["markdown"]), (9, "v5"))
        top = (await self.get(f"/{self.sid}/pages/{page['id']}/versions"))[0]
        self.assertEqual((top["rev"], top["kind"]), (9, "restore"))
        await self.call("POST", f"/{self.sid}/pages/{page['id']}/versions/1/restore", "editor", 404)

    async def test_fifty_versions_by_default(self):
        page = await self.new_page("/guides/a")
        for i in range(52):
            await self.db["docs_page_versions"].insert_one({
                "page_id": ObjectId(page["id"]), "site_id": ObjectId(self.sid), "rev": 100 + i, "markdown": "",
                "title": "t", "description": "", "by": self.uid["editor"], "at": now(), "kind": "save"})
        await self.db["docs_pages"].update_one({"_id": ObjectId(page["id"])}, {"$set": {"draft.rev": 151}})
        await self.save({**page, "rev": 151}, markdown="latest")
        self.assertEqual(await self.db["docs_page_versions"].count_documents({"page_id": ObjectId(page["id"])}), 50)

    async def test_delete_page(self):
        a = await self.new_page("/guides/a", group="Guides")
        await self.call("DELETE", f"/{self.sid}/pages/{a['id']}", "viewer", 403)
        await self.call("DELETE", f"/{self.sid}/pages/{a['id']}", "editor")
        await self.get(f"/{self.sid}/pages/{a['id']}", expect=404)
        self.assertNotIn(a["id"], [p for g in await self.nav() for p in g["pages"]])
        again = await self.new_page("/guides/a")  # the address is free again
        self.assertNotEqual(again["id"], a["id"])
        await self.call("DELETE", f"/{self.sid}/pages/{self.home_page['id']}", expect=422)
        raw = await self.db["docs_pages"].find_one({"_id": ObjectId(a["id"])})
        self.assertEqual((raw.get("path"), raw["deleted_path"]), (None, "/guides/a"))

    async def test_hidden_pages_and_nav(self):
        a = await self.new_page("/guides/a", group="Guides")
        b = await self.new_page("/guides/b", group="Guides")
        hidden = await self.save(a, hidden=True)
        self.assertTrue(hidden["hidden"])
        self.assertEqual(await self.nav(), [{"group": "Getting started", "pages": [self.home_page["id"]]},
                                            {"group": "Guides", "pages": [b["id"]]}])
        bad_navs = [
            [{"group": "G", "pages": [a["id"]]}],                 # hidden
            [{"group": "G", "pages": [str(ObjectId())]}],         # not a page
            [{"group": "G", "pages": [b["id"], b["id"]]}],        # twice
            [{"group": "", "pages": []}],                         # no name
        ]
        for nav in bad_navs:
            r = await self.http.put(f"{BASE}/{self.sid}/nav", json={"nav": nav}, headers=self.h["editor"])
            self.assertEqual(r.status_code, 422, nav)
        await self.call("PUT", f"/{self.sid}/nav", "viewer", 403, json={"nav": []})
        out = await self.call("PUT", f"/{self.sid}/nav", "editor", json={"nav": [
            {"group": "Guides", "pages": [b["id"]]}, {"group": "Start", "pages": [self.home_page["id"]]}]})
        self.assertEqual([g["group"] for g in out["nav"]], ["Guides", "Start"])
        self.assertEqual(await self.nav(), out["nav"])
        shown = await self.save(hidden, hidden=False)
        self.assertFalse(shown["hidden"])
        self.assertEqual((await self.nav())[-1]["pages"], [self.home_page["id"], a["id"]])
