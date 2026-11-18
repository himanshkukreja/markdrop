"""Connect Notion (services/notion_import/connect.py, api.py, api_source.py, sync.py; routers/notion_connect.py;
mcp/notion_tools.py): OAuth, the picker, imports through Notion's API, Keep in sync (one way), detach,
rate limits, expiring file links, and that a person's connection only imports where they can add pages.

Every Notion call goes to tests/_notion_api_fake.FakeNotion (an httpx.MockTransport); MongoDB is the test
server or mongomock and R2 is in memory (tests/_access_env.py). Never backend/.env.
"""

from __future__ import annotations

from datetime import timedelta
from urllib.parse import parse_qs, urlsplit

from tests._access_env import now  # noqa: F401  (pins settings first)
from tests import _notion_api_fake as N
from tests.test_pages import PageWorld

from app.config import get_settings
from app.services.notion_import import api, api_source, connect, jobs
from app.services.notion_import import sync as S
from app.utils import crypto

settings = get_settings()
FERNET = "8Kq0Qb3oQ1n3yYbqQh1w8sV9t6rXo5Wm2Zc4Jd7Lp0E="
_SAVED = ("notion_client_id", "notion_client_secret", "notion_api_base", "token_encryption_key", "frontend_url")


def para(text: str) -> dict:
    return {"type": "paragraph", "paragraph": {"rich_text": [N.rt(text)]}}


class NotionWorld(PageWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self._saved_n = {k: getattr(settings, k) for k in _SAVED}
        settings.notion_client_id, settings.notion_client_secret = N.CLIENT_ID, N.CLIENT_SECRET
        settings.notion_api_base = N.API
        settings.token_encryption_key = FERNET
        settings.frontend_url = "https://markdrop.in"
        crypto._fernet.cache_clear()
        self.fn = N.FakeNotion()
        self._t, self._mi, self._sl = api.TRANSPORT, api.MIN_INTERVAL, api.SLEEP
        api.TRANSPORT = self.fn.transport()
        api.MIN_INTERVAL = 0
        self.waits: list[float] = []

        async def sleep(s):
            self.waits.append(s)

        api.SLEEP = sleep
        await jobs.ensure_indexes(self.db)
        await self.db["users"].update_one({"email": self.email["wm"]}, {"$set": {"name": "Ada Lovelace"}})
        await self.db["memberships"].update_many({"user_id": self.uid["wm"]}, {"$set": {"name": "Ada Lovelace"}})
        self.build()

    async def asyncTearDown(self):
        api.TRANSPORT, api.MIN_INTERVAL, api.SLEEP = self._t, self._mi, self._sl
        for k, v in self._saved_n.items():
            setattr(settings, k, v)
        crypto._fernet.cache_clear()
        await super().asyncTearDown()

    def build(self) -> None:
        f = self.fn
        f.files["covers/c1/cover.png"] = N.PNG
        self.root = f.page("root", "Handbook", icon="📘", cover_file="covers/c1/cover.png", blocks=[
            {"type": "heading_1", "heading_1": {"rich_text": [N.rt("Welcome")], "is_toggleable": False}},
            {"type": "paragraph", "paragraph": {"rich_text": [N.rt("Read "), N.rt("this", bold=True), N.rt(" first.")]}},
            {"type": "callout", "callout": {"rich_text": [N.rt("Be kind")], "icon": {"type": "emoji", "emoji": "💡"}}},
            {"type": "toggle", "toggle": {"rich_text": [N.rt("More")]}, "children": [para("Hidden text")]},
            {"type": "to_do", "to_do": {"rich_text": [N.rt("Ship it")], "checked": True}},
            {"type": "code", "code": {"rich_text": [N.rt("print(1)")], "language": "python"}},
            {"type": "image", "image": {**f.file("img/k1/photo.png"), "caption": [N.rt("Team")]}},
            {"type": "table", "table": {"table_width": 2, "has_column_header": True}, "children": [
                {"type": "table_row", "table_row": {"cells": [[N.rt("A")], [N.rt("B")]]}},
                {"type": "table_row", "table_row": {"cells": [[N.rt("1")], [N.rt("2")]]}}]},
            {"type": "column_list", "column_list": {}, "children": [
                {"type": "column", "column": {}, "children": [para("Left")]},
                {"type": "column", "column": {}, "children": [para("Right")]}]},
            {"type": "equation", "equation": {"expression": "E=mc^2"}},
            {"type": "bookmark", "bookmark": {"url": "https://example.com/post", "caption": []}},
            {"type": "breadcrumb", "breadcrumb": {}},
        ])
        self.child = f.page("child", "Onboarding", parent=self.root, blocks=[
            {"type": "paragraph", "paragraph": {"rich_text": [N.rt("Back to "), N.mention_page("Handbook", self.root)]}}])
        self.tasks = f.database("tasks", "Tasks", parent=self.root, properties={
            "Name": {"id": "title", "type": "title", "title": {}},
            "Status": {"id": "s", "type": "status", "status": {}},
            "Due": {"id": "d", "type": "date", "date": {}},
            "Done": {"id": "c", "type": "checkbox", "checkbox": {}},
            "Owner": {"id": "o", "type": "people", "people": {}},
            "Related": {"id": "r", "type": "relation", "relation": {}}})
        self.row1 = f.row(self.tasks, "row1", "Write docs", {
            "Status": {"type": "status", "status": {"name": "In progress"}},
            "Due": {"type": "date", "date": {"start": "2026-11-20", "end": None}},
            "Done": {"type": "checkbox", "checkbox": False},
            "Owner": {"type": "people", "people": [{"object": "user", "id": "u", "name": "Ada Lovelace"}]},
            "Related": {"type": "relation", "relation": []}}, blocks=[para("Row body")])
        self.row2 = f.row(self.tasks, "row2", "Review", {
            "Status": {"type": "status", "status": {"name": "Done"}},
            "Due": {"type": "date", "date": {"start": "2026-11-18", "end": "2026-11-19"}},
            "Done": {"type": "checkbox", "checkbox": True},
            "Owner": {"type": "people", "people": []},
            "Related": {"type": "relation", "relation": [{"id": N.dashed(self.row1)}]}})
        self.other = f.page("other", "Unrelated", blocks=[para("Not picked")])

    # ── helpers ──

    async def connect(self, who: str = "owner") -> dict:
        r = await self.http.post("/api/v1/notion/connect/start", json={"back": "/dashboard"}, headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        url = r.json()["url"]
        q = parse_qs(urlsplit(url).query)
        self.assertTrue(url.startswith(N.API + "/v1/oauth/authorize?"))
        self.assertEqual(q["owner"], ["user"])
        self.assertEqual(q["client_id"], [N.CLIENT_ID])
        self.assertEqual(q["redirect_uri"], ["https://markdrop.in/integrations/notion/callback"])
        code = self.fn.grant(f"code-{who}")
        r = await self.http.post("/api/v1/notion/connect/finish", json={"code": code, "state": q["state"][0]},
                                 headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        self.state = q["state"][0]
        return r.json()["connection"]

    async def import_(self, who: str, pages: list[dict], destination: dict, keep: bool = True,
                      expect: int = 201) -> dict:
        r = await self.http.post("/api/v1/notion/import", json={"pages": pages, "destination": destination,
                                                                "keep_in_sync": keep}, headers=self.session(who))
        self.assertEqual(r.status_code, expect, r.text)
        if expect != 201:
            return r.json()
        await jobs.tick(self.db)
        r = await self.http.get(f"/api/v1/imports/notion/{r.json()['import']['id']}", headers=self.session(who))
        return r.json()

    async def page(self, title: str) -> dict:
        raw = await self.db["documents"].find_one({"title": title, "notion_imported": True, "deleted_at": None})
        self.assertIsNotNone(raw, title)
        return raw

    async def due(self) -> None:
        """Make every sync due and run the scheduler and the import loop."""
        await self.db[S.COLL].update_many({}, {"$set": {"next_at": S.now_utc() - timedelta(seconds=1)}})
        await S.tick(self.db)
        await jobs.tick(self.db)

    async def sync_row(self) -> dict:
        r = await self.http.get("/api/v1/notion/status", headers=self.session("owner"))
        syncs = r.json()["syncs"]
        self.assertEqual(len(syncs), 1, syncs)
        return syncs[0]


class Connect(NotionWorld):
    async def test_oauth_tokens_encrypted_state_once_and_disconnect(self):
        r = await self.http.get("/api/v1/notion/status", headers=self.session("owner"))
        self.assertEqual(r.json(), {"configured": True, "connections": [], "syncs": [], "sync_minutes": 15})
        conn = await self.connect()
        self.assertEqual(conn["workspace_name"], "Acme Notion")
        self.assertEqual(conn["owner_email"], "ada@notion.test")
        row = await self.db[connect.CONNS].find_one({"_id": conn["id"]})
        self.assertEqual(row["user_id"], self.uid["owner"])
        self.assertNotIn("secret_at_", row["access_enc"])                  # encrypted at rest
        self.assertTrue(crypto.decrypt(row["access_enc"]).startswith("secret_at_"))
        self.assertNotIn("access_enc", str((await self.http.get("/api/v1/notion/status", headers=self.session("owner"))).json()))
        # The state is used once, and only by whoever started it.
        code = self.fn.grant("again")
        r = await self.http.post("/api/v1/notion/connect/finish", json={"code": code, "state": self.state},
                                 headers=self.session("owner"))
        self.assertEqual(r.status_code, 400)
        r = await self.http.post("/api/v1/notion/connect/start", json={}, headers=self.session("owner"))
        st = parse_qs(urlsplit(r.json()["url"]).query)["state"][0]
        r = await self.http.post("/api/v1/notion/connect/finish", json={"code": code, "state": st},
                                 headers=self.session("wm"))
        self.assertEqual(r.status_code, 400)
        # Someone else can't see, list or disconnect it.
        self.assertEqual((await self.http.get(f"/api/v1/notion/connections/{conn['id']}/pages",
                                              headers=self.session("wm"))).status_code, 404)
        self.assertEqual((await self.http.delete(f"/api/v1/notion/connections/{conn['id']}",
                                                 headers=self.session("wm"))).status_code, 404)
        # The picker: pages and databases (rows come with their database), nested under shared parents.
        r = await self.http.get(f"/api/v1/notion/connections/{conn['id']}/pages", headers=self.session("owner"))
        items = {i["id"]: i for i in r.json()["items"]}
        self.assertEqual(set(items), {self.root, self.child, self.tasks, self.other})
        self.assertEqual(items[self.tasks]["kind"], "database")
        self.assertEqual(items[self.tasks]["parent_id"], self.root)
        self.assertEqual(items[self.child]["parent_id"], self.root)
        self.assertIsNone(items[self.root]["parent_id"])
        self.assertEqual(items[self.root]["icon"], "📘")
        # Disconnect: Notion is asked to revoke, the row and syncs go; pages imported stay.
        out = await self.import_("owner", [{"id": self.other}], {})
        self.assertEqual(out["state"], "done", out)
        r = await self.http.delete(f"/api/v1/notion/connections/{conn['id']}", headers=self.session("owner"))
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["revoked"])
        self.assertEqual(r.json()["syncs_stopped"], 1)
        self.assertEqual(len(self.fn.revoked), 1)
        self.assertIsNone(await self.db[connect.CONNS].find_one({"_id": conn["id"]}))
        self.assertEqual(await self.db[S.COLL].count_documents({}), 0)
        await self.page("Unrelated")

    async def test_not_configured_hides_it(self):
        settings.notion_client_secret = ""
        r = await self.http.get("/api/v1/notion/status", headers=self.session("owner"))
        self.assertFalse(r.json()["configured"])
        r = await self.http.post("/api/v1/notion/connect/start", json={}, headers=self.session("owner"))
        self.assertEqual(r.status_code, 503)


class Import(NotionWorld):
    async def test_import_tree_database_and_assets_into_workspace(self):
        await self.connect()
        out = await self.import_("owner", [{"id": self.root}], {"workspace": self.ws["W1"]})
        self.assertEqual(out["state"], "done", out)
        self.assertEqual(out["source"], "api")
        c = out["counts"]
        self.assertEqual((c["pages"], c["databases"], c["rows"], c["images"], c["errors"]), (2, 1, 2, 2, 0), (out["skipped"], out["errors"]))
        root = await self.page("Handbook")
        body = root["content"]
        for want in ("# Welcome", "Read **this** first.", ':::note{icon="💡"}', ':::details{summary="More"}',
                     "- [x] Ship it", "```python\nprint(1)\n```", "| A | B |", "::::columns", "$$\nE=mc^2\n$$",
                     '::bookmark{url="https://example.com/post"}', "icon: 📘"):
            self.assertIn(want, body)
        self.assertRegex(body, r"!\[Team\]\(asset:[0-9a-f]+")             # the image, stored as a page image
        self.assertRegex(body, r"cover: asset:[0-9a-f]+")
        self.assertNotIn("files.notion.test", body)                        # never the expiring link
        child = await self.page("Onboarding")
        self.assertEqual(child["parent_id"], root["_id"])
        self.assertIn(f'::page{{src="{child["slug"]}"}}', body)
        self.assertIn(f':markdrop[Handbook]{{src="{root["slug"]}"}}', child["content"])
        folder = await self.db["folders"].find_one({"workspace_id": self.ws["W1"], "name": "Tasks"})
        types = {p["name"]: p["type"] for p in folder["properties"]}
        self.assertEqual((types["Status"], types["Due"], types["Done"], types["Owner"], types["Related"]),
                         ("select", "date", "checkbox", "person", "link"))
        from app.services import page_db

        keys = {p["name"]: p["key"] for p in folder["properties"]}
        w = await self.page("Write docs")
        rv = await self.page("Review")
        vals = page_db.read_values(w["content"])
        self.assertEqual(vals[keys["Status"]], "In progress")
        self.assertEqual(vals[keys["Owner"]], self.uid["wm"])
        self.assertIn("Row body", w["content"])
        rvals = page_db.read_values(rv["content"])
        self.assertEqual(rvals[keys["Related"]], w["slug"])
        self.assertTrue(rvals[keys["Done"]])
        self.assertNotEqual(root.get("access_level"), "link")
        # A sync row per picked root, kept in sync, pointing at the folder the import made.
        s = await self.sync_row()
        self.assertTrue(s["keep_in_sync"])
        self.assertEqual(s["state"], "done")
        self.assertEqual(s["destination"]["folder_id"], out["result"]["folder_id"])
        self.assertIsNone(await self.db["documents"].find_one({"title": "Unrelated"}))

    async def test_rate_limit_backoff_and_expired_file_links(self):
        await self.connect()
        self.fn.expire_in_listings = True          # every file link in a listing has already expired
        self.fn.throttle = 3
        self.fn.retry_after = "2"
        out = await self.import_("owner", [{"id": self.root}], {"workspace": self.ws["W1"]})
        self.assertEqual(out["state"], "done", out)
        self.assertEqual(out["counts"]["images"], 1)                        # the image, through a fresh link
        self.assertTrue(self.fn.of("GET", "/v1/blocks/") and any(p.count("/") == 3 for p in self.fn.of("GET", "/v1/blocks/")))
        self.assertGreaterEqual(len([w for w in self.waits if w >= 2]), 3)  # waited Retry-After each time
        self.assertTrue(any("cover" in (s.get("path") or "") for s in out["skipped"]))  # the cover's link stayed dead

    async def test_access_only_where_the_person_can_add(self):
        await self.connect("owner")
        await self.connect("wm")
        theirs = await self.db[connect.CONNS].find_one({"user_id": self.uid["owner"]})
        # Someone else's connection doesn't exist for you.
        r = await self.http.post("/api/v1/notion/import", json={"connection_id": theirs["_id"], "pages": [{"id": self.other}]},
                                 headers=self.session("wm"))
        self.assertEqual(r.status_code, 404, r.text)
        # A private team you're not in: refused.
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/teams",
                                 json={"name": "Sales", "visibility": "private", "member_ids": [self.uid["owner"]]},
                                 headers=self.session("wo"))
        tid = r.json().get("id") or r.json().get("team", {}).get("id")
        await self.import_("wm", [{"id": self.other}], {"workspace": self.ws["W1"], "team": tid}, expect=403)
        # A workspace you're not in: not found.
        await self.import_("stranger", [{"id": self.other}], {"workspace": self.ws["W1"]}, expect=404)
        # wm imports into the workspace, keeps it in sync, then leaves: the sync pauses, nothing is written.
        out = await self.import_("wm", [{"id": self.other}], {"workspace": self.ws["W1"]})
        self.assertEqual(out["state"], "done", out)
        await self.db["memberships"].delete_many({"user_id": self.uid["wm"], "workspace_id": self.ws["W1"]})
        self.fn.edit(self.other, blocks=[para("Changed in Notion")])
        await self.due()
        row = await self.db[S.COLL].find_one({"user_id": self.uid["wm"]})
        self.assertEqual(row["paused"], "access")
        self.assertNotIn("Changed in Notion", (await self.page("Unrelated"))["content"])
        # Their syncs aren't anyone else's.
        r = await self.http.post(f"/api/v1/notion/syncs/{row['_id']}/run", headers=self.session("owner"))
        self.assertEqual(r.status_code, 404)


class Sync(NotionWorld):
    async def test_incremental_sync_detach_and_refresh(self):
        await self.connect()
        out = await self.import_("owner", [{"id": self.root}], {"workspace": self.ws["W1"]})
        self.assertEqual(out["state"], "done", out)
        # Nothing changed in Notion: a scheduled sync asks search, reads no page's blocks, writes nothing.
        self.fn.calls.clear()
        await self.due()
        s = await self.sync_row()
        self.assertEqual(s["state"], "done", s)
        self.assertEqual(s["counts"]["updated"], 0)
        self.assertGreaterEqual(s["counts"]["unchanged"], 4)
        self.assertEqual(self.fn.of("GET", f"/v1/blocks/{N.dashed(self.root)}/children"), [])
        self.assertEqual(self.fn.of("GET", f"/v1/pages/{N.dashed(self.child)}"), [])
        self.assertTrue(self.fn.of("POST", "/v1/search"))
        # Notion edits Onboarding and a row: only those are read again and updated.
        self.fn.calls.clear()
        self.fn.edit(self.child, blocks=[para("Version two")])
        self.fn.edit(self.row1, props={"Status": {"type": "status", "status": {"name": "Done"}}})
        await self.due()
        self.assertIn("Version two", (await self.page("Onboarding"))["content"])
        self.assertEqual(self.fn.of("GET", f"/v1/blocks/{N.dashed(self.root)}/children"), [])
        s = await self.sync_row()
        self.assertEqual(s["counts"]["updated"], 2, s)
        # Edited in Markdrop: never overwritten, listed as such, and no longer synced.
        child = await self.page("Onboarding")
        r = await self.http.put(f"/api/v1/documents/{child['slug']}", json={"title": "Onboarding", "content": "Mine.\n"},
                                headers=self.session("owner"))
        self.assertIn(r.status_code, (200, 204), r.text)
        self.fn.edit(self.child, blocks=[para("Version three")])
        r = await self.http.post(f"/api/v1/notion/syncs/{s['id']}/run", headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        await jobs.tick(self.db)
        self.assertEqual((await self.page("Onboarding"))["content"], "Mine.\n")
        s = await self.sync_row()
        self.assertEqual([d["title"] for d in s["edited_in_markdrop"]], ["Onboarding"])
        link = await self.db["notion_links"].find_one({"notion_id": self.child})
        self.assertTrue(link["detached"])
        # Notion stops accepting the token: refreshed once, and the sync carries on.
        self.fn.deny_access.update(self.fn.access)
        self.fn.edit(self.root, blocks=[para("New intro")])
        await self.due()
        self.assertIn("New intro", (await self.page("Handbook"))["content"])
        row = await self.db[connect.CONNS].find_one({})
        self.assertIsNone(row.get("broken"))
        # The refresh refused too: the connection is broken and the sync pauses until reconnecting.
        self.fn.deny_access.update(self.fn.access)
        self.fn.deny_refresh = True
        self.fn.edit(self.root, blocks=[para("Newer intro")])
        await self.due()
        self.assertIsNotNone((await self.db[connect.CONNS].find_one({}))["broken"])
        self.assertEqual((await self.db[S.COLL].find_one({}))["paused"], "connection")
        # Keep in sync off: nothing is queued.
        await self.connect()
        r = await self.http.patch(f"/api/v1/notion/syncs/{s['id']}", json={"keep_in_sync": False},
                                  headers=self.session("owner"))
        self.assertFalse(r.json()["keep_in_sync"])
        await self.db[S.COLL].update_many({}, {"$set": {"next_at": S.now_utc() - timedelta(seconds=1)}})
        self.assertEqual(await S.tick(self.db), 0)

    async def test_deleted_in_markdrop_stays_deleted(self):
        await self.connect()
        await self.import_("owner", [{"id": self.root}], {"workspace": self.ws["W1"]})
        child = await self.page("Onboarding")
        r = await self.http.delete(f"/api/v1/documents/{child['slug']}", headers=self.session("owner"))
        self.assertIn(r.status_code, (200, 204), r.text)
        await self.due()
        self.assertIsNone(await self.db["documents"].find_one({"title": "Onboarding", "deleted_at": None}))
        self.assertEqual((await self.sync_row())["state"], "done")

    async def test_personal_destination_and_mcp(self):
        await self.connect()
        tok = await self.mcp_token("owner", write=True)
        _st, res = await self.mcp_call(tok, "notion_status", {"list_pages": True})
        self.assertFalse(res["isError"], res)
        self.assertIn(self.root, res["content"][0]["text"])
        _st, res = await self.mcp_call(tok, "import_notion", {"source": "api", "pages": [self.root], "keep_in_sync": True})
        self.assertFalse(res["isError"], res)
        await jobs.tick(self.db)
        root = await self.page("Handbook")
        self.assertIsNone(root.get("workspace_id"))
        tasks = await self.page("Tasks")                    # My files: a database is a page with its rows' table
        self.assertIn("Write docs", tasks["content"])
        holder = await self.db["documents"].find_one({"_id": root["parent_id"]})
        self.assertEqual(holder["title"], "Handbook")       # the import's own page, named after the root
        self.assertEqual(holder["access_level"], "private")
        _st, res = await self.mcp_call(tok, "notion_status", {})
        sid = res["structuredContent"]["syncs"][0]["id"]
        self.fn.edit(self.child, blocks=[para("Via MCP")])
        _st, res = await self.mcp_call(tok, "notion_sync", {"sync_id": sid})
        self.assertFalse(res["isError"], res)
        await jobs.tick(self.db)
        self.assertIn("Via MCP", (await self.page("Onboarding"))["content"])
        # Same place again: no second holder page, no duplicates.
        n = await self.db["documents"].count_documents({"notion_imported": True})
        _st, res = await self.mcp_call(tok, "notion_sync", {"sync_id": sid})
        await jobs.tick(self.db)
        self.assertEqual(await self.db["documents"].count_documents({"notion_imported": True}), n)
        _st, res = await self.mcp_call(tok, "notion_sync", {"sync_id": sid, "action": "remove"})
        self.assertFalse(res["isError"], res)
        self.assertEqual(await self.db[S.COLL].count_documents({}), 0)


class Units(NotionWorld):
    async def test_rich_text_and_values(self):
        md = api_source.md([N.rt("a "), N.rt("b", bold=True, italic=True), N.link("site", "https://x.test"),
                            N.link("p", "/" + "a" * 32), {"type": "equation", "equation": {"expression": "x^2"},
                                                          "plain_text": "x^2"}])
        self.assertEqual(md, f"a ***b***[site](https://x.test)[p](notion://{'a' * 32})$x^2$")
        self.assertEqual(api_source.prop_text({"type": "multi_select", "multi_select": [{"name": "a"}, {"name": "b"}]}),
                         "a, b")
        self.assertEqual(api_source.prop_text({"type": "number", "number": 3.0}), "3")
        self.assertEqual(api_source.prop_text({"type": "formula", "formula": {"type": "boolean", "boolean": True}}), "Yes")
        self.assertEqual(api_source.prop_text({"type": "unique_id", "unique_id": {"prefix": "T", "number": 7}}), "T-7")
