"""Typed page properties and folder database views (Senseloaf request 7):
services/page_db.py, routers/page_db.py, MCP set_folder_properties /
list_folder_pages / set_page_properties(properties=…) / get_page.

The access-policy world (tests/_access_env.py): the test MongoDB (or
mongomock), an in-memory R2. Never backend/.env.

People: wo owns W1, wa admin, wm / owner members, wv / ownv viewers, gv / ge
hold grants on the owner's documents (not members), stranger is nobody.
"""

from __future__ import annotations

import unittest

from tests._access_env import AccessWorld, now  # noqa: F401  (pins settings first)

from app.services import page_db, viewers

STATUS = ["Proposed", "In build", "In QA", "Released"]
PRD_SCHEMA = [
    {"name": "Status", "type": "select", "options": STATUS},
    {"name": "Owner", "type": "person"},
    {"name": "Approver", "type": "person"},
    {"name": "Target date", "type": "date"},
    {"name": "Feature ID", "type": "text"},
    {"name": "Related", "type": "link"},
]


class World(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        from app.limiter import limiter

        limiter.enabled = False
        self.addCleanup(setattr, limiter, "enabled", True)
        viewers.clear()

    async def folder(self, name: str, parent: str | None = None, who: str = "wa", ws: str = "W1") -> str:
        r = await self.http.post(f"/api/v1/workspaces/{self.ws[ws]}/folders",
                                 json={"name": name, "parent_id": parent}, headers=self.session(who))
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["id"]

    async def call(self, who: str, name: str, args: dict, *, write: bool = True):
        status, res = await self.mcp_call(await self.mcp_token(who, write=write), name, args)
        self.assertEqual(status, 200)
        return res

    async def ok(self, who: str, name: str, args: dict, *, write: bool = True) -> dict:
        res = await self.call(who, name, args, write=write)
        self.assertFalse(res["isError"], res["content"][0]["text"])
        return res["structuredContent"]

    async def text(self, who: str, name: str, args: dict) -> str:
        res = await self.call(who, name, args)
        self.assertFalse(res["isError"], res["content"][0]["text"])
        return res["content"][0]["text"]

    async def err(self, who: str, name: str, args: dict) -> str:
        res = await self.call(who, name, args)
        self.assertTrue(res["isError"], res)
        return res["content"][0]["text"]

    async def prds(self) -> str:
        """product-hub/02-prds with the Senseloaf schema (set by a member)."""
        hub = await self.folder("product-hub")
        prds = await self.folder("02-prds", hub)
        await self.ok("wm", "set_folder_properties", {"workspace": self.ws["W1"], "folder": "product-hub/02-prds",
                                                      "properties": PRD_SCHEMA})
        return prds

    async def page_in(self, folder_id: str, state: str = "W", *, owner: str = "owner", content: str = "# Body\n",
                      **kw) -> dict:
        return await self.mkdoc(state, owner=owner, editor="blocks", folder_id=folder_id, content=content, **kw)

    def url(self, folder_id: str, tail: str = "database") -> str:
        return f"/api/v1/workspaces/{self.ws['W1']}/folders/{folder_id}/{tail}"


# ── The front-matter line ─────────────────────────────────────────────────────


class Line(unittest.TestCase):
    def test_line_matches_the_frontend(self):
        # frontend/src/components/pages/props/model.test.mjs pins the same line.
        values = {"status": "In build", "owner": "0123456789abcdef01234567",
                  "related": ["prd-x", "https://a.b/c"], "n": 3, "done": True}
        line = ('props: {status: "In build", owner: "0123456789abcdef01234567", '
                'related: ["prd-x", "https://a.b/c"], n: 3, done: true}')
        self.assertEqual(page_db.format_line(values), line)
        self.assertEqual(page_db.read_values(f"---\n{line}\n---\nBody"), values)

    def test_write_keeps_everything_else(self):
        md = "---\nicon: 🚀\nprops: {a: 1}\ncover: gallery:dawn\n---\n# T\n\nBody\n"
        self.assertEqual(page_db.write_values(md, {"b": "x"}),
                         '---\nicon: 🚀\nprops: {a: 1, b: "x"}\ncover: gallery:dawn\n---\n# T\n\nBody\n')
        self.assertEqual(page_db.write_values(md, {"a": None}), "---\nicon: 🚀\ncover: gallery:dawn\n---\n# T\n\nBody\n")
        self.assertEqual(page_db.write_values("---\nprops: {a: 1}\n---\nBody", {"a": None}), "Body")
        self.assertEqual(page_db.write_values("Body", {"s": "v"}), '---\nprops: {s: "v"}\n---\nBody')
        # A hand-written block mapping is read, and put back on one line.
        block = "---\nprops:\n  status: In build\n  due: 2026-11-20\ntitle: X\n---\nB"
        self.assertEqual(page_db.read_values(block), {"status": "In build", "due": "2026-11-20"})
        self.assertEqual(page_db.write_values(block, {"status": "Done"}),
                         '---\nprops: {status: "Done", due: "2026-11-20"}\ntitle: X\n---\nB')
        # Junk never breaks a page.
        self.assertEqual(page_db.read_values("---\nprops: {a: [unclosed\n---\n"), {})
        self.assertEqual(page_db.read_values("---\nprops: !!python/object:os.system ls\n---\n"), {})

    def test_schema_rules(self):
        s = page_db.clean_schema(PRD_SCHEMA)
        self.assertEqual([p["key"] for p in s], ["status", "owner", "approver", "target_date", "feature_id", "related"])
        self.assertEqual([o["name"] for o in s[0]["options"]], STATUS)
        # Resent without keys: matched by name, keys and colours kept.
        s[0]["options"][0]["color"] = "red"
        again = page_db.clean_schema([{"name": "status", "type": "select",
                                       "options": ["Proposed", "In build"]}], s)
        self.assertEqual((again[0]["key"], again[0]["options"][0]["color"]), ("status", "red"))
        for bad, msg in (([{"name": "A", "type": "rich"}], "type must be"),
                         ([{"name": "A", "type": "text"}, {"name": "a", "type": "date"}], "Two properties"),
                         ([{"name": "A", "key": "icon", "type": "text"}], "reserved"),
                         ([{"name": "Title", "type": "text"}], "title"),
                         ([{"name": "S", "type": "select", "options": ["x", "X"]}], "twice"),
                         ([{"name": f"P{i}", "type": "text"} for i in range(31)], "at most 30")):
            with self.assertRaises(page_db.PropsError) as cm:
                page_db.clean_schema(bad)
            self.assertIn(msg, str(cm.exception))
        # A board needs a select to group by.
        with self.assertRaises(page_db.PropsError):
            page_db.clean_views([{"name": "B", "type": "board"}], page_db.clean_schema([{"name": "D", "type": "date"}]))
        v = page_db.clean_views([{"name": "Board", "type": "board"}], s)
        self.assertEqual(v[0]["group"], "status")


# ── Schema: who may change it ─────────────────────────────────────────────────


class Schema(World):
    async def test_members_and_admins_define_it_viewers_and_outsiders_cant(self):
        fid = await self.folder("Specs")
        body = {"properties": [{"name": "Status", "type": "select", "options": ["Open", "Done"]}]}
        r = await self.http.put(self.url(fid, "properties"), json=body, headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["properties"][0]["key"], "status")
        self.assertEqual(r.json()["rev"], 1)
        r = await self.http.put(self.url(fid, "properties"), json=body, headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self.http.put(self.url(fid, "properties"), json=body,
                                              headers=self.session("wv"))).status_code, 403)
        for who in ("stranger", "gv", "wm2"):
            self.assertEqual((await self.http.put(self.url(fid, "properties"), json=body,
                                                  headers=self.session(who))).status_code, 404, who)
            self.assertEqual((await self.http.get(self.url(fid), headers=self.session(who))).status_code, 404, who)
        self.assertEqual((await self.http.put(self.url(fid, "properties"), json=body)).status_code, 401)
        # A folder of another workspace answers like a missing one.
        other = await self.folder("Theirs", who="wm2", ws="W2")
        r = await self.http.put(f"/api/v1/workspaces/{self.ws['W1']}/folders/{other}/properties", json=body,
                                headers=self.session("wa"))
        self.assertEqual(r.status_code, 404)
        # Stale base_rev → 409; invalid → 422.
        r = await self.http.put(self.url(fid, "properties"), json={**body, "base_rev": 0}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 409)
        r = await self.http.put(self.url(fid, "properties"), json={"properties": [{"name": "X", "type": "nope"}]},
                                headers=self.session("wa"))
        self.assertEqual(r.status_code, 422)
        # The viewer reads it.
        r = await self.http.get(self.url(fid), headers=self.session("wv"))
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["can_edit_schema"])
        # MCP: same rules.
        self.assertIn("members and admins", await self.err("wv", "set_folder_properties", {
            "workspace": self.ws["W1"], "folder": "specs", "properties": body["properties"]}))
        self.assertIn("isn't in any workspace", await self.err("stranger", "set_folder_properties", {
            "workspace": self.ws["W1"], "folder": "specs", "properties": body["properties"]}))

    async def test_views_saved_and_limited(self):
        fid = await self.prds()
        views = [{"name": "Board", "type": "board", "group": "status"},
                 {"name": "Mine", "type": "table", "filter": [{"key": "owner", "op": "is", "value": "x"}],
                  "sort": [{"key": "target_date", "dir": "desc"}], "hidden": ["related"]}]
        r = await self.http.put(self.url(fid, "views"), json={"views": views}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        got = r.json()["views"]
        self.assertEqual([(v["name"], v["type"], v["group"]) for v in got],
                         [("Board", "board", "status"), ("Mine", "table", None)])
        self.assertTrue(all(len(v["id"]) >= 4 for v in got))
        self.assertEqual((await self.http.put(self.url(fid, "views"), json={"views": views},
                                              headers=self.session("wv"))).status_code, 403)
        too_many = [{"name": f"V{i}", "type": "table"} for i in range(21)]
        self.assertEqual((await self.http.put(self.url(fid, "views"), json={"views": too_many},
                                              headers=self.session("wm"))).status_code, 422)
        # Taking Status out of the schema turns the board into a table; its values stay in pages.
        page = await self.page_in(fid)
        await self.ok("wm", "set_page_properties", {"document": page["slug"], "properties": {"Status": "In QA"}})
        r = await self.http.put(self.url(fid, "properties"), json={"properties": [PRD_SCHEMA[1]]},
                                headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["views"][0]["type"], "table")
        self.assertIn('status: "In QA"', (await self.doc(page["slug"]))["content"])
        # Re-adding it (same name) brings the values back.
        await self.ok("wm", "set_folder_properties", {"workspace": self.ws["W1"], "folder": fid,
                                                      "properties": PRD_SCHEMA})
        got = await self.ok("wm", "list_folder_pages", {"workspace": self.ws["W1"], "folder": fid})
        self.assertEqual(got["pages"][0]["properties"]["status"], "In QA")


class BaseRev(World):
    async def test_mcp_property_writes_take_base_rev(self):
        """set_folder_properties / set_page_properties with base_rev: refused when it moved on (REST parity)."""
        fid = await self.prds()
        got = await self.ok("wm", "list_folder_pages", {"workspace": self.ws["W1"], "folder": fid})
        rev = got["rev"]
        self.assertIsInstance(rev, int)
        out = await self.ok("wm", "set_folder_properties", {"workspace": self.ws["W1"], "folder": fid,
                                                            "properties": PRD_SCHEMA, "base_rev": rev})
        self.assertGreater(out["rev"], rev)
        self.assertIn("changed this folder's properties", await self.err("wm", "set_folder_properties", {
            "workspace": self.ws["W1"], "folder": fid, "properties": PRD_SCHEMA[:1], "base_rev": rev}))
        self.assertEqual(len((await self.ok("wm", "list_folder_pages", {"workspace": self.ws["W1"], "folder": fid}))["properties"]),
                         len(PRD_SCHEMA))
        page = await self.page_in(fid)
        prev = (await self.doc(page["slug"]))["rev"]
        await self.ok("wm", "set_page_properties", {"document": page["slug"], "properties": {"Status": "In QA"},
                                                    "base_rev": prev})
        self.assertIn("changed since revision", await self.err("wm", "set_page_properties", {
            "document": page["slug"], "properties": {"Status": "Released"}, "base_rev": prev}))
        self.assertIn('status: "In QA"', (await self.doc(page["slug"]))["content"])
        # Without base_rev it still writes over the newest revision.
        await self.ok("wm", "set_page_properties", {"document": page["slug"], "properties": {"Status": "Released"}})


# ── Values ───────────────────────────────────────────────────────────────────


class Values(World):
    async def test_values_are_checked_against_the_schema(self):
        fid = await self.prds()
        page = await self.page_in(fid)
        s = page["slug"]
        e = lambda props: self.err("wm", "set_page_properties", {"document": s, "properties": props})  # noqa: E731
        self.assertIn("isn't one of its options", await e({"Status": "Shipped"}))
        self.assertIn("YYYY-MM-DD", await e({"target_date": "Nov 20"}))
        self.assertIn("isn't a real date", await e({"target_date": "2026-02-30"}))
        self.assertIn("No property 'Colour'", await e({"Colour": "red"}))
        self.assertIn("http(s) address or a Markdrop page", await e({"related": "javascript:alert(1)"}))
        # A person must be a member of the page's workspace.
        self.assertIn("isn't a member", await e({"owner": self.uid["stranger"]}))
        self.assertIn("isn't a member", await e({"owner": self.uid["gv"]}))
        self.assertIn("user id", await e({"owner": "Ada"}))
        # A linked page must exist and be readable by the writer; same answer either way.
        private = await self.mkdoc("P", owner="wo")
        self.assertIn("couldn't find a page", await e({"related": private["slug"]}))
        self.assertIn("couldn't find a page", await e({"related": "no-such-page"}))
        self.assertNotIn("props:", (await self.doc(s))["content"])
        # Good values, by key or by name, case-insensitive options.
        out = await self.ok("wm", "set_page_properties", {"document": s, "properties": {
            "Status": "in build", "owner": self.uid["wm"], "Approver": self.uid["wa"],
            "Target date": "2026-11-20", "feature_id": "SL-142",
            "related": ["https://linear.app/x", page["slug"]]}})
        self.assertEqual(out["properties"]["status"], "In build")
        self.assertEqual(out["properties"]["feature_id"], "SL-142")
        self.assertEqual(out["properties"]["icon"], None)  # the page's own, still there
        content = (await self.doc(s))["content"]
        self.assertTrue(content.startswith('---\nprops: {status: "In build", owner: "'), content)
        # null clears; the others stay.
        await self.ok("wm", "set_page_properties", {"document": s, "properties": {"Feature ID": None},
                                                    "full_width": True})
        vals = page_db.read_values((await self.doc(s))["content"])
        self.assertNotIn("feature_id", vals)
        self.assertEqual(vals["status"], "In build")
        self.assertIn("full_width: true", (await self.doc(s))["content"])

    async def test_who_may_set_values(self):
        fid = await self.prds()
        page = await self.page_in(fid, owner="owner")
        for who in ("wm", "ge"):  # a member; an editor grant
            await self.ok(who, "set_page_properties", {"document": page["slug"], "properties": {"Status": "In QA"}})
        for who in ("wv", "gv"):
            msg = await self.err(who, "set_page_properties", {"document": page["slug"],
                                                              "properties": {"Status": "Released"}})
            self.assertNotIn("Released", page_db.read_values((await self.doc(page["slug"]))["content"]).get("status", ""))
            self.assertTrue(msg)
        r = await self.http.patch(f"/api/v1/documents/{page['slug']}/properties", json={"values": {"status": "Released"}},
                                  headers=self.session("wv"))
        self.assertEqual(r.status_code, 403)
        r = await self.http.patch(f"/api/v1/documents/{page['slug']}/properties", json={"values": {"status": "Released"}},
                                  headers=self.session("stranger"))
        self.assertEqual(r.status_code, 404)
        r = await self.http.patch(f"/api/v1/documents/{page['slug']}/properties", json={"values": {"status": "Released"}},
                                  headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["values"]["status"], "Released")
        self.assertEqual(r.json()["page_properties"]["values"]["status"], "Released")
        # Stale base_rev → 409; a bad value → 422; a locked page: owner and admins only.
        r = await self.http.patch(f"/api/v1/documents/{page['slug']}/properties",
                                  json={"values": {"status": "Proposed"}, "base_rev": 1}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 409)
        r = await self.http.patch(f"/api/v1/documents/{page['slug']}/properties",
                                  json={"values": {"status": "Nope"}}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 422)
        await self.ok("owner", "set_page_properties", {"document": page["slug"], "locked": True})
        r = await self.http.patch(f"/api/v1/documents/{page['slug']}/properties",
                                  json={"values": {"status": "Proposed"}}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 423)
        r = await self.http.patch(f"/api/v1/documents/{page['slug']}/properties",
                                  json={"values": {"status": "Proposed"}}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)

    async def test_someone_editing_the_page(self):
        fid = await self.prds()
        page = await self.page_in(fid)
        r = await self.http.post(f"/api/v1/documents/{page['slug']}/lock", headers=self.session("owner"))
        self.assertIn(r.status_code, (200, 201), r.text)
        r = await self.http.patch(f"/api/v1/documents/{page['slug']}/properties", json={"values": {"status": "In QA"}},
                                  headers=self.session("wm"))
        self.assertEqual(r.status_code, 423)
        self.assertIn("editing", await self.err("wm", "set_page_properties", {"document": page["slug"],
                                                                             "properties": {"Status": "In QA"}}))

    async def test_editor_saves_are_checked_only_for_changed_values(self):
        fid = await self.prds()
        page = await self.page_in(fid)
        await self.ok("wm", "set_page_properties", {"document": page["slug"], "properties": {
            "Status": "In build", "Owner": self.uid["wm"]}})
        raw = await self.doc(page["slug"])

        async def save(content: str, who: str = "owner"):
            cur = await self.doc(page["slug"])
            return await self.http.put(f"/api/v1/documents/{page['slug']}", headers=self.session(who),
                                       json={"title": cur["title"], "content": content, "base_rev": cur["rev"]})

        bad = page_db.write_values(raw["content"], {"owner": self.uid["stranger"]})
        r = await save(bad)
        self.assertEqual(r.status_code, 422)
        self.assertIn("isn't a member", r.json()["detail"])
        r = await save(page_db.write_values(raw["content"], {"status": "Done!"}))
        self.assertEqual(r.status_code, 422)
        # wm leaves the workspace and Status loses "In build": the stale values never block an edit.
        await self.remove_member("W1", "wm")
        await self.ok("wa", "set_folder_properties", {"workspace": self.ws["W1"], "folder": fid, "properties": [
            {**PRD_SCHEMA[0], "options": ["Proposed", "Released"]}, *PRD_SCHEMA[1:]]})
        r = await save(raw["content"] + "\nMore text.\n")
        self.assertEqual(r.status_code, 200, r.text)
        # A key the schema doesn't have is free data.
        r = await save(page_db.write_values(raw["content"], {"legacy": "anything"}))
        self.assertEqual(r.status_code, 200, r.text)

    async def test_create_page_with_typed_properties(self):
        await self.prds()
        out = await self.ok("wm", "create_page", {
            "title": "Search v2", "workspace": self.ws["W1"], "folder": "product-hub/02-prds",
            "properties": {"Status": "Proposed", "Owner": self.uid["wm"], "feature_id": "SL-200", "icon": "🔎"}})
        vals = page_db.read_values((await self.doc(out["slug"]))["content"])
        self.assertEqual(vals, {"status": "Proposed", "owner": self.uid["wm"], "feature_id": "SL-200"})
        self.assertIn("icon: 🔎", (await self.doc(out["slug"]))["content"])
        # Checked before anything is created.
        before = await self.db["documents"].count_documents({})
        self.assertIn("isn't one of its options", await self.err("wm", "create_page", {
            "title": "Bad", "workspace": self.ws["W1"], "folder": "product-hub/02-prds",
            "properties": {"Status": "Shipped"}}))
        self.assertEqual(await self.db["documents"].count_documents({}), before)
        # A folder without properties: ignored, as before, with a note.
        txt = await self.text("wm", "create_page", {"title": "Loose", "workspace": self.ws["W1"],
                                                    "folder": "product-hub", "properties": {"Status": "x"}})
        self.assertIn("Ignored Status", txt)


# ── Reading: lists filter by access, no title leaks ──────────────────────────


class Reading(World):
    async def test_lists_only_readable_pages_and_no_locked_titles(self):
        fid = await self.prds()
        team = await self.page_in(fid, "W", owner="owner", title="Team PRD")
        mine = await self.page_in(fid, "P", owner="wm", title="WM private PRD")
        secret = await self.page_in(fid, "P", owner="wo", title="Secret PRD")
        public = await self.page_in(fid, "L", owner="owner", title="Public PRD")
        await self.page_in(fid, "W", owner="owner", title="Sub-page", parent_id=team["_id"])
        await self.mkdoc("W", owner="owner", kind="artifact", folder_id=fid, title="A file")
        await self.page_in(fid, "W", owner="owner", title="Encrypted", encrypted=True)
        # Team PRD links the secret page and the public one.
        await self.ok("owner", "set_page_properties", {"document": team["slug"], "properties": {
            "Status": "In build", "Owner": self.uid["owner"], "Related": [public["slug"], "https://x.test/a"]}})
        await self.db["documents"].update_one({"_id": team["_id"]}, {"$set": {"content": page_db.write_values(
            (await self.doc(team["slug"]))["content"], {"related": [secret["slug"], public["slug"]]})}})

        def titles(out):
            return sorted(p["title"] for p in out["pages"])

        out = await self.ok("wm", "list_folder_pages", {"workspace": self.ws["W1"], "folder": "product-hub/02-prds"},
                            write=False)
        self.assertEqual(titles(out), ["Public PRD", "Team PRD", "WM private PRD"])
        out_admin = await self.ok("wa", "list_folder_pages", {"workspace": self.ws["W1"], "folder": fid})
        self.assertEqual(titles(out_admin), ["Public PRD", "Team PRD"])  # never a redacted row
        row = next(p for p in out_admin["pages"] if p["title"] == "Team PRD")
        self.assertEqual(row["display"]["Related"], "a page you can't open, Public PRD")
        self.assertEqual(out_admin["links"][secret["slug"]], {"state": "missing"})
        self.assertNotIn("Secret PRD", str(out_admin))
        self.assertEqual(row["display"]["Owner"], "OWNER")
        # The REST view: the same rows, links without titles.
        r = await self.http.get(self.url(fid), headers=self.session("wv"))
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(sorted(x["title"] for x in body["rows"]), ["Public PRD", "Team PRD"])
        self.assertNotIn("Secret PRD", r.text)
        self.assertEqual(body["links"][secret["slug"]]["state"], "missing")
        # The List view asks for the schema and views alone.
        r = await self.http.get(self.url(fid), params={"rows": "false"}, headers=self.session("wv"))
        self.assertEqual((r.json()["rows"], len(r.json()["properties"])), ([], 6))
        self.assertEqual(body["links"][public["slug"]]["title"], "Public PRD")
        self.assertEqual(body["people"][self.uid["owner"]]["name"], "OWNER")
        self.assertTrue(next(x for x in body["rows"] if x["title"] == "Team PRD")["can_edit"] is False)  # viewer
        # Not members: no listing at all.
        self.assertIn("isn't in any workspace", await self.err("ge", "list_folder_pages", {
            "workspace": self.ws["W1"], "folder": fid}))

    async def test_filter_sort_limit(self):
        fid = await self.prds()
        for i, (st, d) in enumerate([("Released", "2026-12-01"), ("In build", "2026-11-20"),
                                     ("In build", "2026-11-10"), ("Proposed", None)]):
            p = await self.page_in(fid, title=f"P{i}")
            props = {"Status": st, "Owner": self.uid["wm" if i % 2 else "wa"]}
            if d:
                props["Target date"] = d
            await self.ok("wm", "set_page_properties", {"document": p["slug"], "properties": props})
        base = {"workspace": self.ws["W1"], "folder": fid}
        out = await self.ok("wm", "list_folder_pages", {**base, "filter": {"Status": "In build"},
                                                        "sort": "target_date"})
        self.assertEqual([p["title"] for p in out["pages"]], ["P2", "P1"])
        out = await self.ok("wm", "list_folder_pages", {**base, "sort": ["status", "-target_date"]})
        self.assertEqual([p["title"] for p in out["pages"]], ["P3", "P1", "P2", "P0"])
        out = await self.ok("wm", "list_folder_pages", {**base, "filter": [
            {"property": "Target date", "op": "before", "value": "2026-11-30"}], "limit": 1, "sort": "-target_date"})
        self.assertEqual(([p["title"] for p in out["pages"]], out["total"], out["truncated"]), (["P1"], 2, True))
        out = await self.ok("wm", "list_folder_pages", {**base, "filter": [{"property": "target_date",
                                                                            "op": "is_empty"}]})
        self.assertEqual([p["title"] for p in out["pages"]], ["P3"])
        self.assertIn("No property", await self.err("wm", "list_folder_pages", {**base, "filter": {"Colour": "x"}}))

    async def test_get_page_and_the_panel(self):
        fid = await self.prds()
        public = await self.page_in(fid, "L", owner="owner", title="Public PRD")
        await self.ok("owner", "set_page_properties", {"document": public["slug"], "properties": {
            "Status": "In QA", "Owner": self.uid["wm"], "Target date": "2026-11-20"}})
        got = await self.ok("wm", "get_page", {"document": public["slug"]}, write=False)
        self.assertEqual(got["properties"]["status"], "In QA")
        self.assertIn("icon", got["properties"])
        pv = {x["key"]: x for x in got["property_values"]}
        self.assertEqual(list(pv), ["status", "owner", "approver", "target_date", "feature_id", "related"])
        self.assertEqual((pv["owner"]["value"], pv["owner"]["display"]), (self.uid["wm"], "WM"))
        self.assertEqual(pv["approver"]["value"], None)
        # The document read carries the panel: names inside the circle only.
        r = await self.get(public["slug"], self.session("wm"))
        panel = r.json()["page_properties"]
        self.assertEqual(panel["values"]["status"], "In QA")
        self.assertEqual(panel["people"][self.uid["wm"]]["name"], "WM")
        self.assertTrue(panel["can_edit_schema"])
        self.assertEqual(panel["folder"]["name"], "02-prds")
        r = await self.get(public["slug"])
        panel = r.json()["page_properties"]
        self.assertEqual(panel["people"], {})
        self.assertTrue(panel["people_hidden"])
        self.assertIsNone(panel["folder"])
        self.assertFalse(panel["can_edit_schema"])
        self.assertNotIn("WM", r.json()["page_properties"].__repr__())
        r = await self.http.get(f"/api/v1/documents/{public['slug']}/properties", headers=self.session("stranger"))
        self.assertEqual(r.json()["page_properties"]["values"]["status"], "In QA")
        # A page in a folder without properties: the panel only for members (to add one).
        plain = await self.folder("Notes")
        note = await self.page_in(plain, "L")
        self.assertIsNotNone((await self.get(note["slug"], self.session("wm"))).json()["page_properties"])
        self.assertIsNone((await self.get(note["slug"])).json()["page_properties"])
        # A private page stays 404 for strangers, properties included.
        priv = await self.page_in(fid, "P", owner="wo")
        r = await self.http.get(f"/api/v1/documents/{priv['slug']}/properties", headers=self.session("stranger"))
        self.assertEqual(r.status_code, 404)


    async def test_custom_domain_folder_index_shows_values_read_only(self):
        await self.prds()
        fid = (await self.db["folders"].find_one({"name": "02-prds"}))["_id"].__str__()
        public = await self.page_in(fid, "L", owner="owner", title="Public PRD")
        secret = await self.page_in(fid, "P", owner="wo", title="Secret PRD")
        await self.ok("owner", "set_page_properties", {"document": public["slug"], "properties": {
            "Status": "In QA", "Owner": self.uid["wm"], "Feature ID": "SL-7"}})
        await self.db["documents"].update_one({"_id": public["_id"]}, {"$set": {"content": page_db.write_values(
            (await self.doc(public["slug"]))["content"], {"related": [secret["slug"]]})}})
        r = await self.http.get("/api/v1/host/folder", params={"host": "docs.acme.test", "path": "product-hub/02-prds"})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual([p["key"] for p in body["properties"]][:2], ["status", "owner"])
        (row,) = [d for d in body["documents"] if d["slug"] == public["slug"]]
        shown = {p["name"]: p["text"] for p in row["props"]}
        self.assertEqual(shown["Status"], "In QA")
        self.assertEqual(next(p for p in row["props"] if p["name"] == "Status")["color"], "orange")
        self.assertEqual(shown["Owner"], "a person")  # not a member: no names
        self.assertEqual(shown["Related"], "a page you can't open")
        self.assertNotIn("Secret PRD", r.text)
        self.assertNotIn(secret["slug"], [d["slug"] for d in body["documents"]])
        # A member (a session from the workspace's domain) sees names.
        r = await self.http.get("/api/v1/host/folder", params={"host": "docs.acme.test", "path": "product-hub/02-prds"},
                                headers=self.tenant("wm", "W1"))
        (row,) = [d for d in r.json()["documents"] if d["slug"] == public["slug"]]
        self.assertEqual({p["name"]: p["text"] for p in row["props"]}["Owner"], "WM")


# ── Templates and the Senseloaf done-when ────────────────────────────────────


class Senseloaf(World):
    async def test_template_carries_defaults(self):
        fid = await self.prds()
        templates = await self.folder("templates", (await self.db["folders"].find_one({"name": "product-hub"}))["_id"].__str__())
        tpl = await self.ok("wm", "create_page", {"title": "PRD template", "workspace": self.ws["W1"],
                                                  "folder": "product-hub/templates", "content": "## Problem\n"})
        await self.ok("wm", "set_page_properties", {"document": tpl["slug"], "template": True})
        r = await self.http.put(f"/api/v1/workspaces/{self.ws['W1']}/folders/{fid}/default-template",
                                json={"template": tpl["slug"]}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(templates)
        # The template's panel holds the defaults of the folder that uses it.
        await self.ok("wm", "set_page_properties", {"document": tpl["slug"], "properties": {"Status": "Proposed"}})
        panel = (await self.get(tpl["slug"], self.session("wm"))).json()["page_properties"]
        self.assertEqual((panel["mode"], panel["values"]), ("template", {"status": "Proposed"}))
        # A new page there starts with them; given ones win.
        a = await self.ok("wm", "create_page", {"title": "A", "workspace": self.ws["W1"], "folder": fid})
        self.assertEqual(page_db.read_values((await self.doc(a["slug"]))["content"]), {"status": "Proposed"})
        b = await self.ok("wm", "create_page", {"title": "B", "workspace": self.ws["W1"], "folder": fid,
                                                "properties": {"Status": "In build"}})
        self.assertEqual(page_db.read_values((await self.doc(b["slug"]))["content"]), {"status": "In build"})

    async def test_done_when(self):
        """product-hub/02-prds: Status (Proposed, In build, In QA, Released), Owner, Approver, Target
        date, Feature ID, Related; a board grouped by Status; MCP sets and lists them."""
        fid = await self.prds()
        out = await self.ok("wm", "set_folder_properties", {
            "workspace": self.ws["W1"], "folder": "product-hub/02-prds", "properties": PRD_SCHEMA,
            "views": [{"name": "By status", "type": "board", "group": "status"}]})
        self.assertEqual([(p["name"], p["type"]) for p in out["properties"]],
                         [("Status", "select"), ("Owner", "person"), ("Approver", "person"),
                          ("Target date", "date"), ("Feature ID", "text"), ("Related", "link")])
        self.assertEqual([o["name"] for o in out["properties"][0]["options"]], STATUS)
        made = []
        for i, st in enumerate(STATUS):
            p = await self.ok("wm", "create_page", {"title": f"PRD {i}", "workspace": self.ws["W1"],
                                                    "folder": "product-hub/02-prds"})
            made.append(p["slug"])
            await self.ok("wm", "set_page_properties", {"document": p["slug"], "properties": {
                "Status": st, "Owner": self.uid["wm"], "Approver": self.uid["wa"],
                "Target date": f"2026-12-0{i + 1}", "Feature ID": f"SL-14{i}",
                "Related": [made[0], "https://linear.app/senseloaf/SL-14" + str(i)]}})
        listed = await self.ok("wm", "list_folder_pages", {"workspace": self.ws["W1"],
                                                           "folder": "product-hub/02-prds", "sort": "status"})
        self.assertEqual([p["properties"]["status"] for p in listed["pages"]], STATUS)
        self.assertEqual(listed["pages"][2]["display"], {
            "Status": "In QA", "Owner": "WM", "Approver": "WA", "Target date": "2026-12-03",
            "Feature ID": "SL-142", "Related": "PRD 0, https://linear.app/senseloaf/SL-142"})
        self.assertEqual(listed["views"][0]["group"], "status")
        # The board: grouped by Status; dragging a card to "Released" sets the value.
        board = (await self.http.get(self.url(fid), headers=self.session("wm"))).json()
        self.assertEqual(board["views"][0]["type"], "board")
        r = await self.http.patch(f"/api/v1/documents/{made[1]}/properties", json={"values": {"status": "Released"}},
                                  headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        listed = await self.ok("wm", "list_folder_pages", {"workspace": self.ws["W1"], "folder": fid,
                                                           "filter": {"Status": "Released"}})
        self.assertEqual(sorted(p["title"] for p in listed["pages"]), ["PRD 1", "PRD 3"])
        txt = await self.text("wm", "list_folder_pages", {"workspace": self.ws["W1"], "folder": fid})
        self.assertIn("| Page | Status | Owner | Approver | Target date | Feature ID | Related |", txt)


if __name__ == "__main__":
    unittest.main()
