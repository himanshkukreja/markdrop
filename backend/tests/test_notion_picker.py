"""Connect Notion's picker as Notion nests it, choosing inside a page or database (``exclude``), and the
"Imported from Notion" provenance on imported pages (services/notion_import/api_source.py shared /
database_rows, jobs.py, sync.py, writer.py, source.py; scripts/backfill_notion_source.py).

Every Notion call goes to tests/_notion_api_fake.FakeNotion (an httpx.MockTransport). Never backend/.env.
"""

from __future__ import annotations

from tests._access_env import now  # noqa: F401  (pins settings first)
from tests import _notion_api_fake as N
from tests.test_notion_connect import NotionWorld, para

from app.services.notion_import import api_source, connect
from app.services.notion_import import source as SRC
from app.services.notion_import import sync as S


class PickerWorld(NotionWorld):
    def build(self) -> None:
        super().build()
        f = self.fn
        # Handbook › a column with a page in it (Notion: parent block_id, the column).
        f.add_block(self.root, {"type": "column_list", "column_list": {}, "children": [
            {"type": "column", "column": {}, "id": N.nid("colA"), "children": [para("Left")]}]})
        self.incol = f.page("incol", "In a column", parent=self.root, block=N.nid("colA"), blocks=[para("Col page")])
        # A database row with a sub-page of its own.
        self.rownotes = f.page("rownotes", "Row notes", parent=self.row1, blocks=[para("Notes of a row")])
        # A database whose page isn't shared: it sits at the top level; and a row shared on its own (its
        # database isn't shared): a page of its own at the top level.
        hidden = f.page("hidden", "Private space")
        f.unshared.add(hidden)
        self.docs = f.database("docs", "Docs", parent=hidden, properties={"Name": {"id": "title", "type": "title", "title": {}}})
        self.doc1 = f.row(self.docs, "doc1", "Style guide", {})
        secret_db = f.database("secretdb", "Secret DB", parent=hidden, properties={"Name": {"id": "title", "type": "title", "title": {}}})
        f.unshared.add(secret_db)
        self.lonely = f.row(secret_db, "lonely", "Lonely row", {})

    async def listing(self, conn: dict) -> dict:
        r = await self.http.get(f"/api/v1/notion/connections/{conn['id']}/pages", headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()


class Picker(PickerWorld):
    async def test_tree_is_notions_hierarchy(self):
        conn = await self.connect()
        out = await self.listing(conn)
        ids = [i["id"] for i in out["items"]]
        self.assertEqual(len(ids), len(set(ids)))                      # nothing twice
        items = {i["id"]: i for i in out["items"]}
        # Database rows aren't items: they're counted on their database and come when it's opened.
        for row in (self.row1, self.row2, self.doc1):
            self.assertNotIn(row, items)
        self.assertEqual(items[self.tasks]["row_count"], 2)
        self.assertEqual(items[self.docs]["row_count"], 1)
        # A row's own sub-page sits under the row (shown when the database's rows are loaded).
        self.assertEqual((items[self.rownotes]["parent_id"], items[self.rownotes]["parent_kind"]), (self.row1, "row"))
        self.assertEqual(out["row_parents"], {self.row1: self.tasks})
        # A page in a column sits under the page the column is in, not at the top level.
        self.assertEqual((items[self.incol]["parent_id"], items[self.incol]["parent_kind"]), (self.root, "page"))
        self.assertEqual((items[self.child]["parent_id"], items[self.tasks]["parent_id"]), (self.root, self.root))
        # Parent not shared: top level (and never under the wrong item).
        self.assertIsNone(items[self.docs]["parent_id"])
        self.assertIsNone(items[self.root]["parent_id"])
        # A row shared without its database is a page of its own.
        self.assertEqual((items[self.lonely]["kind"], items[self.lonely]["parent_id"]), ("page", None))
        tops = {i["title"] for i in out["items"] if i["parent_id"] is None}
        self.assertEqual(tops, {"Handbook", "Unrelated", "Docs", "Lonely row"})

    async def test_database_rows_paged_and_owned(self):
        conn = await self.connect()
        r = await self.http.get(f"/api/v1/notion/connections/{conn['id']}/databases/{self.tasks}/rows",
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        rows = r.json()["items"]
        self.assertEqual([x["title"] for x in rows], ["Write docs", "Review"])
        self.assertEqual({(x["kind"], x["parent_id"]) for x in rows}, {("row", self.tasks)})
        self.assertIsNone(r.json()["next_cursor"])
        row = await self.db[connect.CONNS].find_one({"_id": conn["id"]})
        c = await connect.client(self.db, row)
        try:
            first = await api_source.database_rows(c, self.tasks, size=1)
            self.assertEqual([x["id"] for x in first["items"]], [self.row1])
            nxt = await api_source.database_rows(c, self.tasks, first["next_cursor"], size=1)
            self.assertEqual([x["id"] for x in nxt["items"]], [self.row2])
            self.assertIsNone(nxt["next_cursor"])
        finally:
            await c.close()
        # Someone else's connection: not found; a bad id: not found.
        r = await self.http.get(f"/api/v1/notion/connections/{conn['id']}/databases/{self.tasks}/rows",
                                headers=self.session("wm"))
        self.assertEqual(r.status_code, 404)
        r = await self.http.get(f"/api/v1/notion/connections/{conn['id']}/databases/nope/rows",
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 404)


class Exclude(PickerWorld):
    async def test_exclude_honoured_by_import_and_sync(self):
        await self.connect()
        r = await self.http.post("/api/v1/notion/import", json={
            "pages": [{"id": self.root}], "destination": {"workspace": self.ws["W1"]}, "keep_in_sync": True,
            "exclude": [self.child, self.row1, N.dashed(self.incol), self.root, "not-an-id"]},
            headers=self.session("owner"))
        self.assertEqual(r.status_code, 201, r.text)
        from app.services.notion_import import jobs

        await jobs.tick(self.db)
        out = (await self.http.get(f"/api/v1/imports/notion/{r.json()['import']['id']}", headers=self.session("owner"))).json()
        self.assertEqual(out["state"], "done", out)
        titles = {d["title"] async for d in self.db["documents"].find({"notion_imported": True, "deleted_at": None})}
        self.assertIn("Handbook", titles)
        self.assertIn("Review", titles)                             # the ticked row
        for gone in ("Onboarding", "Write docs", "Row notes", "In a column"):   # unticked, and what's under them
            self.assertNotIn(gone, titles)
        row = await self.db[S.COLL].find_one({})
        self.assertEqual(sorted(row["exclude"]), sorted([self.child, self.row1, self.incol]))  # never the root
        self.assertEqual((await self.sync_row())["left_out"], 3)
        # The database's table in Markdrop has only the ticked row.
        folder = await self.db["folders"].find_one({"workspace_id": self.ws["W1"], "name": "Tasks"})
        rows = [d["title"] async for d in self.db["documents"].find({"folder_id": str(folder["_id"]), "deleted_at": None})]
        self.assertEqual(rows, ["Review"])
        # Later in Notion: the left-out pages change and a row is added. A sync never brings the left-out
        # ones back; new rows come (exclusions are a list of what to leave out, not of what to bring).
        self.fn.edit(self.child, blocks=[para("Changed")])
        self.fn.edit(self.row1, blocks=[para("Changed row")])
        self.fn.row(self.tasks, "row3", "Plan", {}, minutes_ago=3)
        await self.due()
        s = await self.sync_row()
        self.assertEqual(s["state"], "done", s)
        sid = s["id"]
        r = await self.http.post(f"/api/v1/notion/syncs/{sid}/run", headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        await jobs.tick(self.db)
        titles = {d["title"] async for d in self.db["documents"].find({"notion_imported": True, "deleted_at": None})}
        self.assertIn("Plan", titles)
        for gone in ("Onboarding", "Write docs", "Row notes", "In a column"):
            self.assertNotIn(gone, titles)
        # Without exclude: everything (today's behaviour), into another place.
        r = await self.http.post("/api/v1/notion/import", json={"pages": [{"id": self.root}], "destination": {}},
                                 headers=self.session("owner"))
        self.assertEqual(r.status_code, 201, r.text)
        await jobs.tick(self.db)
        n = await self.db["documents"].count_documents({"title": {"$in": ["Onboarding", "Row notes", "In a column"]},
                                                         "deleted_at": None})
        self.assertEqual(n, 3)

    async def test_mcp_exclude_and_rows(self):
        await self.connect()
        tok = await self.mcp_token("owner", write=True)
        _st, res = await self.mcp_call(tok, "notion_status", {"list_pages": True, "database": self.tasks})
        self.assertFalse(res["isError"], res)
        self.assertEqual([x["id"] for x in res["structuredContent"]["rows"]], [self.row1, self.row2])
        _st, res = await self.mcp_call(tok, "import_notion", {"source": "api", "pages": [self.root],
                                                              "exclude": [self.row2, self.child]})
        self.assertFalse(res["isError"], res)
        from app.services.notion_import import jobs

        await jobs.tick(self.db)
        self.assertIsNone(await self.db["documents"].find_one({"title": "Review", "notion_imported": True}))
        self.assertIsNone(await self.db["documents"].find_one({"title": "Onboarding", "notion_imported": True}))
        raw = await self.page("Write docs")
        _st, res = await self.mcp_call(tok, "get_page", {"document": raw["slug"]})
        self.assertFalse(res["isError"], res)
        src = res["structuredContent"]["source"]
        self.assertEqual((src["kind"], src["url"]), ("notion", f"https://www.notion.so/{self.row1}"))


class Provenance(PickerWorld):
    async def read(self, slug: str, who: str | None) -> dict:
        r = await self.http.get(f"/api/v1/documents/{slug}", headers=self.session(who) if who else {})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def test_indicator_by_role(self):
        await self.connect()
        out = await self.import_("owner", [{"id": self.root}], {"workspace": self.ws["W1"]})
        self.assertEqual(out["state"], "done", out)
        child = await self.page("Onboarding")
        src = child["source"]
        self.assertEqual((src["kind"], src["via"], src["notion_id"]), ("notion", "api", self.child))
        self.assertEqual(src["url"], f"https://www.notion.so/{self.child}")
        sid = (await self.sync_row())["id"]
        self.assertEqual(src["sync_id"], sid)                       # the sync of the root it came under
        self.assertEqual((await self.page("Write docs"))["source"]["sync_id"], sid)
        # Stamping it is never an edit: a sync after it keeps every page in sync (none "edited in Markdrop").
        await self.due()
        self.assertEqual((await self.sync_row())["counts"].get("kept_edited"), 0)
        # The importer (can edit, their sync): status and Sync now.
        body = await self.read(child["slug"], "owner")
        self.assertEqual(body["source"]["sync"]["state"], "on")
        self.assertEqual(body["source"]["sync"]["id"], sid)
        self.assertTrue(body["source"]["sync"]["last_synced_at"])
        self.assertEqual(body["source"]["url"], f"https://www.notion.so/{self.child}")
        # Someone else who can edit: the status, never the sync's id (or anything about the connection).
        other = await self.read(child["slug"], "wa")
        self.assertTrue(other["can"]["edit"])
        self.assertEqual(other["source"]["sync"], {"state": "on", "last_synced_at": body["source"]["sync"]["last_synced_at"]})
        self.assertNotIn("connection", str(other["source"]))
        # A reader without edit: provenance only.
        viewer = await self.read(child["slug"], "wv")
        self.assertFalse(viewer["can"]["edit"])
        self.assertEqual(set(viewer["source"]), {"kind", "url", "imported_at", "sync"})
        self.assertIsNone(viewer["source"]["sync"])
        # Published to anyone with the link: anonymous readers see where it came from too.
        root = await self.page("Handbook")
        await self.set_level(root["slug"], "link")
        anon = await self.read(root["slug"], None)
        self.assertEqual(anon["source"]["url"], f"https://www.notion.so/{self.root}")
        self.assertIsNone(anon["source"]["sync"])
        # Keep in sync off: "Not synced"; edited in Markdrop: "edited".
        await self.http.patch(f"/api/v1/notion/syncs/{sid}", json={"keep_in_sync": False}, headers=self.session("owner"))
        self.assertEqual((await self.read(child["slug"], "owner"))["source"]["sync"]["state"], "off")
        await self.db["notion_links"].update_one({"doc_id": child["_id"]}, {"$set": {"detached": True}})
        self.assertEqual((await self.read(child["slug"], "owner"))["source"]["sync"]["state"], "edited")

    async def test_export_import_has_provenance_without_sync(self):
        from tests import _notion_fixture as F
        from app.services.notion_import import jobs

        data = F.export_zip()
        r = await self.http.post("/api/v1/imports/notion", json={"file_name": "Projects.zip", "size_bytes": len(data),
                                                                "destination": {}}, headers=self.session("owner"))
        self.assertEqual(r.status_code, 201, r.text)
        jid = r.json()["import"]["id"]
        job = await self.db[jobs.COLL].find_one({"_id": jid})
        self.r2.put_bytes(job["key"], data, "application/zip", public=False)
        r = await self.http.post(f"/api/v1/imports/notion/{jid}/start", headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        await jobs.tick(self.db)
        raw = await self.page("Roadmap")
        self.assertEqual(raw["source"]["via"], "zip")
        self.assertIsNone(raw["source"]["sync_id"])
        body = await self.read(raw["slug"], "owner")
        self.assertEqual(body["source"]["url"], f"https://www.notion.so/{raw['source']['notion_id']}")
        self.assertIsNone(body["source"]["sync"])


class Backfill(PickerWorld):
    async def test_dry_run_then_apply(self):
        await self.connect()
        out = await self.import_("owner", [{"id": self.root}], {"workspace": self.ws["W1"]})
        self.assertEqual(out["state"], "done", out)
        sid = (await self.sync_row())["id"]
        n = await self.db["documents"].count_documents({"source.kind": "notion"})
        self.assertGreaterEqual(n, 5)
        await self.db["documents"].update_many({}, {"$unset": {"source": ""}})
        dry = await SRC.backfill(self.db)
        self.assertEqual((dry["would_set"], dry["set"], dry["api"], dry["with_sync"]), (n, 0, n, n), dry)
        self.assertEqual(await self.db["documents"].count_documents({"source.kind": "notion"}), 0)  # dry run
        done = await SRC.backfill(self.db, apply=True)
        self.assertEqual(done["set"], n)
        row = await self.page("Review")                              # a row, found through its database folder
        self.assertEqual((row["source"]["sync_id"], row["source"]["via"]), (sid, "api"))
        self.assertEqual(row["source"]["url"], f"https://www.notion.so/{self.row2}")
        again = await SRC.backfill(self.db, apply=True)
        self.assertEqual((again["would_set"], again["already"]), (0, n))

    async def test_script_dry_run(self):
        import io
        from contextlib import redirect_stdout
        from unittest import mock

        from scripts import backfill_notion_source as script

        await self.connect()
        await self.import_("owner", [{"id": self.other}], {})
        await self.db["documents"].update_many({}, {"$unset": {"source": ""}})

        async def no_connect():
            return None

        buf = io.StringIO()
        with mock.patch.object(script, "connect", no_connect), mock.patch.object(script, "get_database", lambda: self.db), \
                redirect_stdout(buf):
            self.assertEqual(await script.main(False), 0)
        self.assertIn("Would mark: 1", buf.getvalue())
        self.assertIn("Dry run", buf.getvalue())
        self.assertIsNone((await self.page("Unrelated")).get("source"))
