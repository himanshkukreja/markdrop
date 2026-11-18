"""Import from Notion (services/notion_import/, routers/notion_import.py, mcp/notion_tools.py).

Synthetic exports (tests/_notion_fixture.py) through the real stack: the access-policy world's test
MongoDB (or mongomock) and an in-memory R2 (tests._files_env.FakeR2) — never backend/.env, never a bucket.
A client's PUT of the zip is FakeR2.put_bytes; the background run is ``jobs.tick`` called directly.
"""

from __future__ import annotations

import os
import tempfile

from tests._access_env import now  # noqa: F401  (pins settings first)
from tests import _notion_fixture as F
from tests.test_pages import PageWorld

from app.services.notion_import import export_zip, jobs, notion_md, props, render


# ── The parser, the adapter and the renderer (no database) ────────────────────


def _tree(data: bytes, name: str = "export.zip"):
    d = tempfile.mkdtemp()
    p = os.path.join(d, "x.zip")
    with open(p, "wb") as f:
        f.write(data)
    ez = export_zip.ExportZip(p, d)
    return export_zip.build_tree(ez, name)


class _R:
    def __init__(self, tree):
        self.tree = tree

    def page(self, nid):
        n = self.tree.nodes.get(nid)
        if n is None:
            return None
        if n.kind == "database":
            return {"url": "/w/W/f/F", "title": n.title}
        return {"slug": "p-" + nid[:6], "title": n.title}

    def asset(self, path):
        return {"image": "img1"} if path.endswith(".png") else {"file": "spec-file"}


class Parse(PageWorld):
    async def test_tree_shape(self):
        t = _tree(F.export_zip())
        kinds = {n.title: (n.kind, n.parent_id) for n in t.nodes.values()}
        self.assertEqual(kinds["Projects"], ("page", None))
        self.assertEqual(kinds["Other"], ("page", None))
        self.assertEqual(kinds["Roadmap"], ("page", F.ROOT))
        self.assertEqual(kinds["Tasks"], ("database", F.ROOT))
        self.assertEqual(kinds["Ship v2"], ("row", F.TASKS))
        self.assertEqual(kinds["Fix bug"], ("row", F.TASKS))
        # The _all CSV wins (both rows), with the CSV's values; sub-pages in the order the page lists them.
        self.assertEqual(t.nodes[F.ROW2].values["Status"], "Done")
        self.assertEqual([n.title for n in t.children(F.ROOT)], ["Roadmap", "Notes", "Tasks"])
        self.assertEqual(t.name, "export")

    async def test_workspace_export_zip_of_zips(self):
        t = _tree(F.workspace_export(), "Export-12345678-1234-1234-1234-123456789abc.zip")
        self.assertEqual(len(t.nodes), 7)
        self.assertEqual(t.name, "Notion import")

    async def test_html_export_and_garbage_refused(self):
        with self.assertRaises(export_zip.ExportError) as e:
            _tree(F.html_export())
        self.assertIn("HTML export", str(e.exception))
        with self.assertRaises(export_zip.ExportError):
            _tree(b"not a zip")
        with self.assertRaises(export_zip.ExportError):
            _tree(F.zip_bytes({"readme.txt": b"hi"}))

    async def test_render_blocks(self):
        t = _tree(F.export_zip())
        md = render.render(t.nodes[F.ROOT].blocks, _R(t))
        for want in (':::note{icon="💡"}', ':markdrop[Notes]{src="p-c3c3c3"}', '::page{src="p-b2b2b2"}',
                     "[Tasks](/w/W/f/F)", "![Team photo](asset:img1)", '::markdrop{src="spec-file" mode="card"}',
                     "- [ ] Write the plan", "- [x] Pick a name\n  - nested bullet", "1. First",
                     ':::details{summary="More details"}', "> A quote from someone.", "```python",
                     "$$\n\\int_0^1 x\\,dx\n$$", "| Grace | [Ops](https://ops.example) |", "---",
                     '::embed{src="https://www.youtube.com/watch?v=dQw4w9WgXcQ"}',
                     '::bookmark{url="https://news.example.com/post"}', ':markdrop[Other]{src="p-0a0a0a"}',
                     "$E=mc^2$"):
            self.assertIn(want, md)
        # The row's property lines are taken out (the CSV has them).
        self.assertEqual(render.render(t.nodes[F.ROW1].blocks, _R(t)), "The release plan.")

    async def test_nested_containers_and_columns(self):
        p = notion_md.Parser(lambda h: ("url", h))
        blocks = p.parse("""<details>
<summary><h2>Outer</h2></summary>

<aside>
⚠️ Careful

</aside>

</details>""".split("\n"))
        self.assertEqual(blocks[0]["heading"], 2)
        md = render.render(blocks + [{"type": "columns", "columns": [[{"type": "paragraph", "text": "L"}],
                                                                       [{"type": "paragraph", "text": "R"}]]},
                                     {"type": "synced_block", "notion_type": "synced_block", "text": "x"}], _R(None))
        self.assertIn('::::details{summary="Outer" heading=2}\n:::note{icon="⚠️"}\nCareful\n:::\n::::', md)
        self.assertIn("::::columns\n:::column\nL\n:::\n:::column\nR\n:::\n::::", md)
        self.assertIn("x *(from Notion: synced_block)*", md)

    async def test_types_inferred(self):
        cols = [props.Column(n) for n in ("Name", "Status", "Tags", "Due", "Done", "Estimate", "Owner", "Website", "Related")]
        t = _tree(F.export_zip(extra_row=True))
        rows = [n.values for n in t.children(F.TASKS)]
        people = props.People([{"id": "a" * 24, "name": "Ada Lovelace", "email": "ada@x.test"},
                               {"id": "b" * 24, "name": "Grace Hopper", "email": "g@x.test"}])
        items, extra = props.schema_for(cols, rows, people)
        types = {i["name"]: i["type"] for i in items}
        self.assertEqual(types, {"Status": "select", "Tags": "multi_select", "Due": "date", "Done": "checkbox",
                                 "Estimate": "number", "Owner": "person", "Website": "link", "Related": "relation"})
        self.assertEqual(extra, [])
        self.assertEqual(props.parse_date("November 18, 2026 → November 19, 2026"), ("2026-11-18", "November 19, 2026"))
        self.assertEqual(props.parse_number("12%"), 0.12)


# ── Through the API: upload, run, report, idempotency, access ────────────────


class Import(PageWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        from app.services.notion_import import jobs as J

        await J.ensure_indexes(self.db)
        await self.db["users"].update_one({"email": self.email["wm"]}, {"$set": {"name": "Ada Lovelace"}})
        from bson import ObjectId

        await self.db["memberships"].update_many({"user_id": self.uid["wm"]}, {"$set": {"name": "Ada Lovelace"}})
        _ = ObjectId

    async def start(self, who: str, data: bytes, destination: dict, name: str = "Projects.zip") -> dict:
        r = await self.http.post("/api/v1/imports/notion", json={"file_name": name, "size_bytes": len(data),
                                                                  "destination": destination}, headers=self.session(who))
        self.assertEqual(r.status_code, 201, r.text)
        body = r.json()
        self.assertEqual(body["upload"]["method"], "PUT")
        job = await self.db["notion_imports"].find_one({"_id": body["import"]["id"]})
        self.r2.put_bytes(job["key"], data, "application/zip", public=False)   # the client's PUT
        r = await self.http.post(f"/api/v1/imports/notion/{body['import']['id']}/start", headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["state"], "queued")
        await jobs.tick(self.db)
        r = await self.http.get(f"/api/v1/imports/notion/{body['import']['id']}", headers=self.session(who))
        self.assertEqual(r.status_code, 200)
        return r.json()

    async def page(self, title: str) -> dict:
        raw = await self.db["documents"].find_one({"title": title, "notion_imported": True, "deleted_at": None})
        self.assertIsNotNone(raw, title)
        return raw

    async def test_into_workspace_folder_with_database(self):
        out = await self.start("owner", F.export_zip(), {"workspace": self.ws["W1"]})
        self.assertEqual(out["state"], "done", out)
        c = out["counts"]
        self.assertEqual((c["pages"], c["databases"], c["rows"], c["images"], c["files"], c["errors"]),
                         (4, 1, 2, 1, 1, 0), out)
        fid = out["result"]["folder_id"]
        folder = await self.db["folders"].find_one({"workspace_id": self.ws["W1"], "notion_import_root": True})
        self.assertEqual(str(folder["_id"]), fid)
        self.assertEqual(folder["name"], "Projects")
        root = await self.page("Projects")
        self.assertEqual(root["folder_id"], fid)
        self.assertNotEqual(root.get("access_level"), "link")     # never public
        roadmap = await self.page("Roadmap")
        self.assertEqual(roadmap["parent_id"], root["_id"])
        self.assertIn(f'::page{{src="{roadmap["slug"]}"}}', root["content"])
        self.assertIn(f':markdrop[Projects]{{src="{root["slug"]}"}}', roadmap["content"])
        self.assertRegex(root["content"], r"!\[Team photo\]\(asset:[0-9a-f]+\)")
        self.assertRegex(root["content"], r'::markdrop\{src="[^"]+" mode="card"\}')
        # The database: a folder with typed properties beside its page, rows filed in it with their values.
        db_folder = await self.db["folders"].find_one({"workspace_id": self.ws["W1"], "name": "Tasks"})
        types = {p["name"]: p["type"] for p in db_folder["properties"]}
        self.assertEqual(types["Status"], "select")
        self.assertEqual(types["Owner"], "person")
        self.assertEqual(types["Related"], "link")
        self.assertEqual([v["type"] for v in db_folder["views"]], ["table", "board"])
        self.assertIn(f"[Tasks](/w/{self.ws['W1']}/f/{db_folder['_id']})", root["content"])
        ship = await self.page("Ship v2")
        fix = await self.page("Fix bug")
        self.assertEqual(ship["folder_id"], str(db_folder["_id"]))
        from app.services import page_db

        vals = page_db.read_values(ship["content"])
        keys = {p["name"]: p["key"] for p in db_folder["properties"]}
        self.assertEqual(vals[keys["Status"]], "In progress")
        self.assertEqual(vals[keys["Tags"]], ["web", "api"])
        self.assertEqual(vals[keys["Due"]], "2026-11-20")
        self.assertEqual(vals[keys["Done"]], False)
        self.assertEqual(vals[keys["Estimate"]], 3)
        self.assertEqual(vals[keys["Owner"]], self.uid["wm"])
        self.assertEqual(vals[keys["Related"]], fix["slug"])
        self.assertIn("The release plan.", ship["content"])
        fvals = page_db.read_values(fix["content"])
        self.assertEqual(fvals[keys["Due"]], "2026-11-18")
        self.assertIn("until November 19, 2026", fix["content"])   # the range's end, kept in the page
        self.assertIn("Grace Hopper", fix["content"])              # not a member: in the page instead
        # Another member can read it (workspace access); a stranger can't.
        self.assertEqual((await self.get(root["slug"], self.session("wv"))).status_code, 200)
        self.assertNotEqual((await self.get(root["slug"], self.session("stranger"))).status_code, 200)
        # The zip is gone from storage.
        self.assertFalse(any(k.startswith("imports/notion/") for k in self.r2.objects))

    async def test_reimport_merges_and_keeps_edited_pages(self):
        first = await self.start("owner", F.export_zip(), {"workspace": self.ws["W1"]})
        self.assertEqual(first["state"], "done")
        n_docs = await self.db["documents"].count_documents({"notion_imported": True})
        notes = await self.page("Notes")
        # Someone edits Notes in Markdrop.
        r = await self.http.put(f"/api/v1/documents/{notes['slug']}", json={"title": "Notes", "content": "Mine now.\n"},
                                headers=self.session("owner"))
        self.assertIn(r.status_code, (200, 204), r.text)
        second = await self.start("owner", F.export_zip(roadmap_text="We ship in **Q2**.", extra_row=True),
                                  {"workspace": self.ws["W1"]})
        self.assertEqual(second["state"], "done", second)
        c = second["counts"]
        self.assertEqual(c["kept_edited"], 1)
        self.assertGreaterEqual(c["updated"], 1)
        self.assertGreaterEqual(c["unchanged"], 3)
        self.assertEqual(c["rows"], 1)                               # only the new row is new
        self.assertEqual(await self.db["documents"].count_documents({"notion_imported": True}), n_docs + 1)
        self.assertEqual(await self.db["folders"].count_documents({"notion_import_root": True}), 1)
        self.assertIn("Q2", (await self.page("Roadmap"))["content"])
        self.assertEqual((await self.page("Notes"))["content"], "Mine now.\n")

    async def test_team_space_and_my_files(self):
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/teams",
                                 json={"name": "Sales", "visibility": "private", "member_ids": [self.uid["owner"]]},
                                 headers=self.session("wo"))
        self.assertIn(r.status_code, (200, 201), r.text)
        tid = r.json().get("id") or r.json().get("team", {}).get("id")
        dests = (await self.http.get("/api/v1/imports/notion/destinations", headers=self.session("owner"))).json()
        self.assertIn(tid, [p["team_id"] for p in dests["places"]])
        # Not in the team: refused.
        r = await self.http.post("/api/v1/imports/notion", json={"file_name": "x.zip", "size_bytes": 10, "destination": {
            "workspace": self.ws["W1"], "team": tid}}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 403, r.text)
        out = await self.start("owner", F.export_zip(), {"workspace": self.ws["W1"], "team": tid,
                                                        "folder_name": "From Notion"})
        self.assertEqual(out["state"], "done", out)
        root = await self.page("Projects")
        self.assertEqual(root.get("team_ids"), [tid])
        self.assertEqual((await self.page("Roadmap")).get("team_ids"), [tid])
        folder = await self.db["folders"].find_one({"_id": __import__("bson").ObjectId(out["result"]["folder_id"])})
        self.assertEqual(folder["name"], "From Notion")
        self.assertEqual(folder.get("team_ids"), [tid])
        # A workspace member outside the private team doesn't see it.
        self.assertNotEqual((await self.get(root["slug"], self.session("wv"))).status_code, 200)

    async def test_my_files_private(self):
        out = await self.start("stranger", F.workspace_export(), {"new_folder": False},
                               name="Export-12345678-1234-1234-1234-123456789abc.zip")
        self.assertEqual(out["state"], "done", out)
        root = await self.page("Projects")
        self.assertIsNone(root.get("workspace_id"))
        self.assertEqual(root["access_level"], "private")
        tasks = await self.page("Tasks")                   # a page with a table of rows in My files
        ship = await self.page("Ship v2")
        self.assertEqual(ship["parent_id"], tasks["_id"])
        self.assertIn(f':markdrop[Ship v2]{{src="{ship["slug"]}"}}', tasks["content"])
        self.assertIn("| Status | In progress |", ship["content"])
        self.assertNotEqual((await self.get(root["slug"], self.session("owner"))).status_code, 200)

    async def test_html_export_fails_with_message_and_cancel(self):
        out = await self.start("owner", F.html_export(), {"workspace": self.ws["W1"]})
        self.assertEqual(out["state"], "failed")
        self.assertIn("Markdown & CSV", out["error"])
        r = await self.http.post("/api/v1/imports/notion", json={"file_name": "x.zip", "size_bytes": 10},
                                 headers=self.session("owner"))
        jid = r.json()["import"]["id"]
        r = await self.http.post(f"/api/v1/imports/notion/{jid}/start", headers=self.session("owner"))
        self.assertEqual(r.status_code, 409)                 # nothing uploaded yet
        r = await self.http.post(f"/api/v1/imports/notion/{jid}/cancel", headers=self.session("owner"))
        self.assertEqual(r.json()["state"], "cancelled")
        # Someone else's import doesn't exist for them.
        r = await self.http.get(f"/api/v1/imports/notion/{jid}", headers=self.session("wm"))
        self.assertEqual(r.status_code, 404)
        r = await self.http.post("/api/v1/imports/notion", json={"file_name": "x.html", "size_bytes": 10},
                                 headers=self.session("owner"))
        self.assertEqual(r.status_code, 415)
        r = await self.http.post("/api/v1/imports/notion", json={"file_name": "x.zip", "size_bytes": 3 * 1024 ** 3},
                                 headers=self.session("owner"))
        self.assertEqual(r.status_code, 413)

    async def test_resumes_a_run_that_stopped(self):
        from datetime import timedelta

        out = await self.start("owner", F.export_zip(), {"workspace": self.ws["W1"]})
        n = await self.db["documents"].count_documents({"notion_imported": True})
        # A job left "running" by a process that died (heartbeat gone quiet) is picked up and finishes
        # without duplicating anything.
        await self.db["notion_imports"].update_one({"_id": out["id"]}, {"$set": {
            "state": "running", "heartbeat_at": jobs.now_utc() - timedelta(minutes=10)}})
        job = await self.db["notion_imports"].find_one({"_id": out["id"]})
        self.r2.put_bytes(job["key"], F.export_zip(), "application/zip", public=False)
        self.assertEqual(await jobs.tick(self.db), 1)
        job = await self.db["notion_imports"].find_one({"_id": out["id"]})
        self.assertEqual(job["state"], "done")
        self.assertEqual(await self.db["documents"].count_documents({"notion_imported": True}), n)

    async def test_mcp(self):
        data = F.export_zip()
        tok = await self.mcp_token("owner", write=True)
        status, res = await self.mcp_call(tok, "import_notion", {"file_name": "Projects.zip", "size_bytes": len(data),
                                                                  "workspace": self.ws["W1"]})
        self.assertFalse(res["isError"], res)
        sc = res["structuredContent"]
        self.assertIn("curl", sc["curl"])
        job = await self.db["notion_imports"].find_one({"_id": sc["import_id"]})
        self.r2.put_bytes(job["key"], data, "application/zip", public=False)
        status, res = await self.mcp_call(tok, "import_notion", {"import_id": sc["import_id"]})
        self.assertFalse(res["isError"], res)
        await jobs.tick(self.db)
        status, res = await self.mcp_call(tok, "get_notion_import", {"import_id": sc["import_id"]})
        self.assertFalse(res["isError"], res)
        self.assertEqual(res["structuredContent"]["import"]["state"], "done")
        self.assertIn("Imported 4 pages", res["content"][0]["text"])
        status, res = await self.mcp_call(tok, "get_notion_import", {})
        self.assertEqual(len(res["structuredContent"]["imports"]), 1)
