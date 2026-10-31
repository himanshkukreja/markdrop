"""Who else is in a guide's editor (routers/docs_site_editor.py, services/docs_presence.py):
two people, the caller left out, expiry, one entry per person, the editing flag from the
page lock, leaving, someone else's session, and other guides kept apart."""

from __future__ import annotations

from datetime import timedelta

from bson import ObjectId

from tests._docs_sites_env import DocsSitesCase, now

from app.services import docs_presence


class Presence(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.site = await self.create("acme")
        self.sid = self.site["id"]
        self.page = await self.home(self.sid)

    async def beat(self, who: str, session: str, page_id: str | None = None, expect: int = 200,
                   site: str | None = None) -> list[dict]:
        r = await self.call("POST", f"/{site or self.sid}/presence", who, expect,
                            json={"session": session, "page_id": page_id})
        return r.get("people") if expect == 200 else r

    async def test_two_people(self):
        self.assertEqual(await self.beat("editor", "tab-editor-1", self.page["id"]), [])
        people = await self.beat("viewer", "tab-viewer-1")
        self.assertEqual(people, [{"user_id": self.uid["editor"], "name": "Editor", "page_id": self.page["id"],
                                   "page_title": self.page["title"], "page_path": "/", "editing": False}])
        people = await self.beat("editor", "tab-editor-1", self.page["id"])
        self.assertEqual([(p["user_id"], p["page_id"], p["page_path"]) for p in people],
                         [(self.uid["viewer"], None, None)])
        await self.beat("stranger", "tab-stranger", expect=404)

    async def test_editing_flag_follows_the_lock(self):
        await self.beat("editor", "tab-editor-1", self.page["id"])
        self.assertFalse((await self.beat("admin", "tab-admin-1"))[0]["editing"])
        await self.call("POST", f"/{self.sid}/pages/{self.page['id']}/lock", "editor")
        self.assertTrue((await self.beat("admin", "tab-admin-1"))[0]["editing"])
        # A lock on a page they aren't on doesn't count; a lapsed one doesn't either.
        p2 = await self.call("POST", f"/{self.sid}/pages", "editor", 201, json={"path": "/two", "title": "Two"})
        await self.beat("editor", "tab-editor-1", p2["id"])
        self.assertFalse((await self.beat("admin", "tab-admin-1"))[0]["editing"])
        await self.beat("editor", "tab-editor-1", self.page["id"])
        await self.db["docs_pages"].update_one({"_id": ObjectId(self.page["id"])},
                                               {"$set": {"lock.expires_at": now() - timedelta(seconds=1)}})
        self.assertFalse((await self.beat("admin", "tab-admin-1"))[0]["editing"])

    async def test_expiry_and_dedupe(self):
        await self.beat("editor", "tab-editor-1", self.page["id"])
        await self.beat("editor", "tab-editor-2")  # a second tab, newer: that one wins
        people = await self.beat("admin", "tab-admin-1")
        self.assertEqual([(p["user_id"], p["page_id"]) for p in people], [(self.uid["editor"], None)])
        row = await self.db[docs_presence.PRESENCE].find_one({"_id": f"{self.sid}:tab-editor-2"})
        self.assertEqual(row["user_id"], self.uid["editor"])
        self.assertAlmostEqual((row["expires_at"] - row["at"]).total_seconds(), 75, delta=1)
        await self.db[docs_presence.PRESENCE].update_many(
            {"user_id": self.uid["editor"]}, {"$set": {"expires_at": now() - timedelta(seconds=1)}})
        self.assertEqual(await self.beat("admin", "tab-admin-1"), [])

    async def test_leave_and_someone_elses_session(self):
        await self.beat("editor", "tab-editor-1")
        # Someone else naming that session neither takes it over nor removes it.
        await self.beat("admin", "tab-editor-1")
        row = await self.db[docs_presence.PRESENCE].find_one({"_id": f"{self.sid}:tab-editor-1"})
        self.assertEqual(row["user_id"], self.uid["editor"])
        self.assertEqual(await self.call("DELETE", f"/{self.sid}/presence?session=tab-editor-1", "admin"),
                         {"ok": True})
        self.assertEqual(len(await self.beat("viewer", "tab-viewer-1")), 1)
        await self.call("DELETE", f"/{self.sid}/presence?session=tab-editor-1", "editor")
        self.assertEqual(await self.beat("viewer", "tab-viewer-1"), [])
        await self.call("DELETE", f"/{self.sid}/presence?session=bad", "editor", 422)

    async def test_bad_input(self):
        for session in ("short", "has space in it", "x" * 41, "semi;colon-123"):
            await self.beat("editor", session, expect=422)
        # A page id that isn't one is just "no page".
        await self.beat("editor", "tab-editor-1", "not-a-page")
        people = await self.beat("admin", "tab-admin-1")
        self.assertEqual(people[0]["page_id"], None)

    async def test_other_guides_are_separate(self):
        other = await self.create("other")
        await self.beat("editor", "tab-editor-1", site=other["id"])
        self.assertEqual(await self.beat("admin", "tab-admin-1"), [])
        self.assertEqual(len(await self.beat("admin", "tab-admin-1", site=other["id"])), 1)
        # A page of this guide named on the other one isn't shown there.
        await self.beat("editor", "tab-editor-1", self.page["id"], site=other["id"])
        people = await self.beat("admin", "tab-admin-1", site=other["id"])
        self.assertEqual((people[0]["page_id"], people[0]["page_title"]), (None, None))
