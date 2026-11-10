"""Jira inside pages (services/jira_pages.py, routers/jira_pages.py, mcp/jira_page_tools.py).

Every Atlassian call goes to tests._jira_fake.FakeJira (no network); the model is the test fake.

Run: cd backend && MARKDROP_TEST_MONGODB_URI=mongodb://127.0.0.1:27019 .venv/bin/python -m unittest tests.test_jira_pages -v
"""

from __future__ import annotations

import unittest
from datetime import timedelta
from unittest import mock

from tests.test_jira import JiraWorld, now  # noqa: F401  (pins settings first)

from bson import ObjectId

from app.services import jira, jira_pages
from tests._jira_fake import FakeJira

HOST = "acme.atlassian.net"


def page_body(k1: str, k2: str) -> str:
    return (f"# Launch\n\nBlocked on :jira[{k1}] until Friday.\n\n"
            f"::jira{{key={k2} site={HOST}}}\n\n"
            "```\n:jira[PAY-999] in code is not a chip\n```\n\n"
            '::jira-list{project=PAY title="Payments"}\n')


class Parsing(unittest.TestCase):
    def test_refs_and_attrs(self):
        md = ('Text :jira[pay-12]{site="https://ACME.atlassian.net/"} and \\:jira[NOPE-1]\n'
              "::jira{#b-k3x9 key=WEB-3}\n"
              '::jira-list{jql="project = &quot;PAY&quot; AND status = Done" cols="status,due,bogus" limit=500}\n'
              "~~~\n::jira{key=X-1}\n~~~\n"
              "::jira-list{filter=10042}\n::jira-list{project=lower}\n")
        rs = jira_pages.refs(md)
        self.assertEqual([(r.kind, r.key, r.host) for r in rs],
                         [("chip", "PAY-12", HOST), ("card", "WEB-3", None), ("list", None, None), ("list", None, None),
                          ("list", None, None)])
        self.assertEqual(rs[2].spec["jql"], 'project = "PAY" AND status = Done')
        self.assertEqual(rs[2].spec["cols"], ["status", "due"])
        self.assertEqual(rs[2].spec["limit"], jira_pages.LIST_MAX)
        self.assertEqual(rs[3].spec["filter"], "10042")
        self.assertEqual(rs[4].spec["project"], "LOWER")
        self.assertIsNone(jira_pages.list_spec({"jql": "x" * (jira_pages.MAX_JQL + 1)}))
        self.assertEqual(jira_pages.host_of("https://acme.atlassian.net/browse/PAY-1"), HOST)
        self.assertIsNone(jira_pages.host_of("javascript:alert(1)"))
        # What the serialisers write reads back the same.
        spec = jira_pages.list_spec({"jql": 'project = "PAY"', "cols": ["status", "sprint"], "limit": 10, "title": 'My "list"'})
        back = jira_pages.refs(jira_pages.list_md(spec, HOST))[0]
        self.assertEqual((back.spec["jql"], back.spec["cols"], back.spec["limit"], back.spec["title"], back.host),
                         ('project = "PAY"', ["status", "sprint"], 10, 'My "list"', HOST))
        self.assertEqual(jira_pages.refs(jira_pages.card_md("PAY-1", HOST))[0].kind, "card")

    def test_plain_markdown(self):
        snaps = {f"{HOST}/PAY-1": {"title": "Fix *login*"}}
        out = jira_pages.plain_markdown(page_body("PAY-1", "PAY-2"), snaps, HOST)
        self.assertIn(f"[PAY-1 · Fix \\*login\\*](https://{HOST}/browse/PAY-1)", out)
        self.assertIn(f"[PAY-2](https://{HOST}/browse/PAY-2)", out)
        self.assertIn(":jira[PAY-999] in code", out)
        self.assertIn("[Payments: project = \"PAY\" ORDER BY updated DESC](https://acme.atlassian.net/issues/?jql=", out)


class PagesWorld(JiraWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.connect_site(projects=("PAY", "WEB"))
        self.k1 = self.fj.add_issue("PAY", "Billing webhooks v2", status="In Progress", assignee="acc-wm", due="2026-12-01")
        self.k2 = self.fj.add_issue("PAY", "Runbook for the launch", priority="High")
        self.fj.issues[self.k2]["fields"][jira.SPRINT_FIELD] = [{"name": "Sprint 4", "state": "closed"},
                                                                 {"name": "Sprint 5", "state": "active"}]
        self.web = self.fj.add_issue("WEB", "New landing page")
        self.page = await self.mkdoc("L", owner="wo", grants=False, slug="launch", content="# Launch\n", editor="blocks")
        self.events: list[tuple[str, dict]] = []
        p = mock.patch("app.services.live.notify", side_effect=lambda slug, ev: self.events.append((slug, ev)))
        p.start()
        self.addCleanup(p.stop)

    async def items(self, who: str | None, slug: str = "launch") -> dict:
        r = await self.http.get(f"/api/v1/jira/pages/{slug}/items", headers=self.session(who) if who else {})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def searches(self) -> int:
        return len(self.fj.of("POST", "search/jql"))


class Privacy(PagesWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.connect("wa")
        await self.save("wa", "launch", page_body(self.k1, self.k2))     # an editor saves: snapshots get titles

    async def test_snapshots_written_under_the_editors_token(self):
        rows = {r["key"]: r async for r in self.db[jira_pages.SNAPS].find({"doc_id": str(self.page["_id"])})}
        self.assertEqual(set(rows), {self.k1, self.k2})
        self.assertEqual(rows[self.k1]["title"], "Billing webhooks v2")
        # The key left the page: its snapshot goes too.
        await self.save("wa", "launch", page_body(self.k1, self.k1))
        self.assertEqual({r["key"] async for r in self.db[jira_pages.SNAPS].find({})}, {self.k1})

    async def test_anonymous_gets_key_and_title_only_and_costs_no_jira_call(self):
        before = len(self.fj.calls)
        with mock.patch.object(jira, "account", side_effect=AssertionError("no account lookup for anonymous")):
            out = await self.items(None)
        self.assertEqual(len(self.fj.calls), before)
        self.assertFalse(out["signed_in"])
        it = out["items"][f"{HOST}/{self.k1}"]
        self.assertEqual((it["key"], it["title"], it["issue"]), (self.k1, "Billing webhooks v2", None))
        self.assertEqual(it["url"], f"https://{HOST}/browse/{self.k1}")
        self.assertNotIn("In Progress", str(out))
        self.assertNotIn("WM", str(out))
        self.assertEqual(out["lists"], 1)

    async def test_signed_in_without_jira_gets_the_snapshot(self):
        before = len(self.fj.calls)
        out = await self.items("wm")
        self.assertEqual(len(self.fj.calls), before)
        self.assertTrue(out["signed_in"])
        self.assertFalse(out["connected"])
        self.assertIsNone(out["items"][f"{HOST}/{self.k1}"]["issue"])
        self.assertEqual(out["items"][f"{HOST}/{self.k1}"]["title"], "Billing webhooks v2")

    async def test_connected_without_permission_gets_the_snapshot(self):
        await self.connect("wv")                     # his Jira sees WEB only
        out = await self.items("wv")
        self.assertTrue(out["connected"])
        self.assertIsNone(out["items"][f"{HOST}/{self.k1}"]["issue"])
        self.assertNotIn("In Progress", str(out))
        # …and his view never writes a snapshot (he can't edit the page anyway).
        await self.db[jira_pages.SNAPS].update_many({}, {"$set": {"title": None}})
        await self.items("wv")
        self.assertEqual(await self.db[jira_pages.SNAPS].count_documents({"title": {"$ne": None}}), 0)

    async def test_connected_with_permission_gets_live_details_in_one_batch(self):
        await self.connect("wm")
        before = self.searches()
        out = await self.items("wm")
        self.assertEqual(self.searches() - before, 1)                     # both keys, one search
        a = out["items"][f"{HOST}/{self.k1}"]["issue"]
        b = out["items"][f"{HOST}/{self.k2}"]["issue"]
        self.assertEqual((a["status"]["name"], a["assignee"]["name"], a["due"]), ("In Progress", "WM", "2026-12-01"))
        self.assertEqual((b["priority"], b["sprint"]), ("High", "Sprint 5"))
        # Cached per person and issue: no Jira call within the minute.
        await self.items("wm")
        self.assertEqual(self.searches() - before, 1)
        # A minute later, asked again (one search).
        await self.db["jira_views"].update_many({}, {"$set": {"at": now() - timedelta(seconds=61)}})
        await self.items("wm")
        self.assertEqual(self.searches() - before, 2)

    async def test_webhook_refreshes_details_title_and_nudges_the_page(self):
        await self.connect("wm")
        await self.items("wm")
        self.fj.issues[self.k1]["fields"]["summary"] = "Billing webhooks v2 (renamed)"
        before = self.searches()
        self.events.clear()
        r = await self.hook(self.fj.move(self.k1, "Done", by="acc-wa"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn(("launch", {"type": "jira", "keys": [self.k1]}), self.events)
        out = await self.items("wm")
        self.assertEqual(self.searches(), before)                         # from the cache the webhook refreshed
        self.assertEqual(out["items"][f"{HOST}/{self.k1}"]["issue"]["status"]["name"], "Done")
        anon = await self.items(None)
        self.assertEqual(anon["items"][f"{HOST}/{self.k1}"]["title"], "Billing webhooks v2 (renamed)")
        self.assertNotIn("Done", str(anon))

    async def test_password_and_restricted_pages(self):
        await self.db["documents"].update_one({"slug": "launch"}, {"$set": {"access_level": "private"}})
        r = await self.http.get("/api/v1/jira/pages/launch/items")
        self.assertEqual(r.status_code, 404)
        r = await self.http.get("/api/v1/jira/pages/launch/items", headers=self.session("stranger"))
        self.assertEqual(r.status_code, 404)

    async def test_rate_limited_jira_serves_the_cache(self):
        await self.connect("wm")
        await self.items("wm")
        await self.db["jira_views"].update_many({}, {"$set": {"at": now() - timedelta(seconds=61)}})
        self.fj.fail["POST search/jql"] = 429
        self.fj.retry_after = "40"
        out = await self.items("wm")
        self.assertEqual(out["items"][f"{HOST}/{self.k1}"]["issue"]["key"], self.k1)   # last known
        self.assertTrue(await jira.busy(self.db, "cloud-acme"))
        before = len(self.fj.calls)
        await self.items("wm")
        self.assertEqual(len(self.fj.calls), before)                     # waits: no call at all
        r = await self.http.post(f"/api/v1/jira/issue/{self.k1}/transition", json={"site": HOST, "transition": "Done"},
                                 headers=self.session("wm"))
        self.assertEqual(r.status_code, 429)

    async def test_remember_is_for_editors(self):
        await self.connect("wv")
        r = await self.http.post("/api/v1/jira/pages/launch/remember", json={"key": self.web, "site": HOST},
                                 headers=self.session("wv"))
        self.assertEqual(r.status_code, 403)                              # a viewer can read, not edit, this page
        r = await self.http.post("/api/v1/jira/pages/launch/remember", json={"key": self.web, "site": HOST},
                                 headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["title"], "New landing page")


class Lists(PagesWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.connect("wa")
        await self.save("wa", "launch", page_body(self.k1, self.k2))
        for i in range(30):
            self.fj.add_issue("PAY", f"Bulk {i}")

    async def run_list(self, who: str | None, body: dict):
        return await self.http.post("/api/v1/jira/pages/launch/list", json=body, headers=self.session(who) if who else {})

    async def test_reader_runs_saved_lists_under_their_own_token(self):
        r = await self.run_list(None, {"project": "PAY"})
        self.assertEqual(r.status_code, 401)
        r = await self.run_list("wm", {"project": "PAY"})
        self.assertEqual(r.status_code, 409)                             # not connected: "Connect Jira"
        await self.connect("wm")
        r = await self.run_list("wm", {"project": "PAY", "site": HOST})
        self.assertEqual(r.status_code, 200, r.text)
        page1 = r.json()
        self.assertEqual(len(page1["issues"]), jira_pages.LIST_PAGE)
        self.assertTrue(page1["next"])
        self.assertIn("/issues/?jql=", page1["url"])
        r = await self.run_list("wm", {"project": "PAY", "page_token": page1["next"]})
        self.assertEqual(len(r.json()["issues"]), 32 - jira_pages.LIST_PAGE)
        # As the viewer: the person whose Jira sees WEB only gets nothing from PAY.
        await self.connect("wv")
        r = await self.run_list("wv", {"project": "PAY"})
        self.assertEqual(r.json()["issues"], [])
        # Cached for a minute per person and query.
        n = self.searches()
        await self.run_list("wm", {"project": "PAY"})
        self.assertEqual(self.searches(), n)

    async def test_webhook_reruns_list_pages_with_no_jira_data_in_the_nudge(self):
        await self.mkdoc("L", owner="wo", grants=False, slug="board", content="# Board\n", editor="blocks")
        await self.save("wa", "board", f"# Board\n\n::jira-list{{jql=\"assignee = currentUser()\" site={HOST}}}\n")
        await self.mkdoc("L", owner="wo", grants=False, slug="web-only", content="# Web\n", editor="blocks")
        await self.save("wa", "web-only", f"# Web\n\n::jira-list{{project=WEB site={HOST}}}\n")
        rows = {r["doc_id"]: r async for r in self.db[jira_pages.LIST_PAGES].find({"host": HOST})}
        self.assertEqual(len(rows), 3)
        await self.connect("wm")
        await self.run_list("wm", {"project": "PAY", "site": HOST})
        n = self.searches()
        await self.run_list("wm", {"project": "PAY", "site": HOST})
        self.assertEqual(self.searches(), n)                              # cached
        self.events.clear()
        fresh = self.fj.add_issue("PAY", "Fresh one")
        r = await self.hook(self.fj.move(fresh, "Done", by="acc-wa"))
        self.assertEqual(r.status_code, 200, r.text)
        slugs = {s for s, _ in self.events}
        self.assertIn(("board", {"type": "jira", "lists": True}), self.events)   # a JQL list: any issue of the site
        self.assertIn(("launch", {"type": "jira", "lists": True}), self.events)  # its PAY list
        self.assertNotIn("web-only", slugs)                                       # a WEB list can't hold PAY-n
        self.assertNotIn(fresh, str(self.events))                                 # never the key, never details
        await self.run_list("wm", {"project": "PAY", "site": HOST})
        self.assertEqual(self.searches(), n + 1)                          # re-run under the viewer's own token
        # The list leaves a page: no more nudges for it.
        await self.save("wa", "web-only", "# Web\n")
        self.assertEqual(await self.db[jira_pages.LIST_PAGES].count_documents({"host": HOST}), 2)

    async def test_list_pages_backfill_once(self):
        await self.db[jira_pages.LIST_PAGES].delete_many({})
        self.assertEqual(await jira_pages.backfill_list_pages(self.db), 1)
        row = await self.db[jira_pages.LIST_PAGES].find_one({"doc_id": str(self.page["_id"])})
        self.assertEqual((row["host"], row["projects"], row["any"]), (HOST, ["PAY"], False))
        self.assertEqual(await jira_pages.backfill_list_pages(self.db), 0)
        # A page that never went through a save (created as it is): its first list run indexes it.
        await self.db[jira_pages.LIST_PAGES].delete_many({"doc_id": str(self.page["_id"])})
        await self.connect("wm")
        await self.run_list("wm", {"project": "PAY", "site": HOST})
        self.assertTrue(await self.db[jira_pages.LIST_PAGES].find_one({"doc_id": str(self.page["_id"])}))

    async def test_jql_safety(self):
        await self.connect("wv")
        # A reader (a workspace viewer) can't run a query that isn't on the page.
        r = await self.run_list("wv", {"jql": "project = SEC"})
        self.assertEqual(r.status_code, 403)
        # An editor can preview one before saving it, still as themselves.
        r = await self.run_list("wa", {"jql": "project = WEB"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([i["key"] for i in r.json()["issues"]], [self.web])
        r = await self.run_list("wa", {"jql": "BADJQL = 1"})
        self.assertEqual(r.status_code, 422)
        self.assertIn("BADJQL", r.json()["detail"])
        r = await self.run_list("wa", {"jql": "x" * (jira_pages.MAX_JQL + 1)})
        self.assertEqual(r.status_code, 422)
        self.fj.filters["10042"] = ["WEB"]
        r = await self.run_list("wa", {"filter": "10042"})
        self.assertEqual([i["key"] for i in r.json()["issues"]], [self.web])


class Actions(PagesWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.connect("wa")
        await self.connect("wm")
        await self.save("wa", "launch", page_body(self.k1, self.k2))
        self.fj.extra_transitions.append(("61", "Resolve", "Done", {
            "resolution": {"name": "Resolution", "required": True, "schema": {"type": "resolution"},
                           "allowedValues": [{"id": "1", "name": "Fixed"}, {"id": "2", "name": "Won't do"}]}}))

    async def post(self, who: str, path: str, body: dict, method: str = "POST"):
        return await self.http.request(method, f"/api/v1/jira/issue/{path}", json=body, headers=self.session(who))

    async def test_all_transitions_with_required_fields(self):
        r = await self.http.get(f"/api/v1/jira/issue/{self.k1}/transitions", params={"site": HOST}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        steps = {t["name"]: t for t in r.json()["transitions"]}
        self.assertEqual(set(steps), {"To Do", "Done", "Blocked", "Resolve"})
        self.assertEqual(steps["Resolve"]["fields"][0]["key"], "resolution")
        self.assertTrue(steps["Resolve"]["fields"][0]["required"])
        self.assertEqual([o["name"] for o in steps["Resolve"]["fields"][0]["options"]], ["Fixed", "Won't do"])
        # Missing the screen's required field: said plainly, nothing sent.
        r = await self.post("wm", f"{self.k1}/transition", {"site": HOST, "transition": "Resolve", "slug": "launch"})
        self.assertEqual(r.status_code, 422)
        self.assertIn("Resolution", r.json()["detail"])
        self.assertEqual(self.fj.of("POST", f"issue/{self.k1}/transitions"), [])
        self.events.clear()
        r = await self.post("wm", f"{self.k1}/transition", {"site": HOST, "transition": "Resolve", "slug": "launch",
                                                           "fields": {"resolution": "Fixed"}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["issue"]["status"]["name"], "Done")
        self.assertEqual(self.fj.of("POST", f"issue/{self.k1}/transitions")[-1],
                         {"transition": {"id": "61"}, "fields": {"resolution": {"id": "1"}}})
        self.assertIn(("launch", {"type": "jira", "keys": [self.k1]}), self.events)
        # By the status it leads to, as the person (Jira's reporter of the change).
        r = await self.post("wm", f"{self.k1}/transition", {"site": HOST, "transition": "blocked"})
        self.assertEqual(r.json()["issue"]["status"]["name"], "Blocked")
        moved_by = [w for m, p, _b, w in self.fj.calls if m == "POST" and p.endswith("/transitions")]
        self.assertEqual(set(moved_by), {"acc-wm"})
        r = await self.post("wm", f"{self.k1}/transition", {"site": HOST, "transition": "Teleport"})
        self.assertEqual(r.status_code, 422)
        self.assertIn("Available", r.json()["detail"])

    async def test_jira_permissions_decide(self):
        self.fj.accounts["acc-wm"]["can_transition"] = False
        r = await self.http.get(f"/api/v1/jira/issue/{self.k1}/transitions", params={"site": HOST}, headers=self.session("wm"))
        self.assertEqual(r.json()["transitions"], [])
        self.fj.accounts["acc-wm"]["read_only"] = True
        r = await self.post("wm", f"{self.k1}/assignee", {"site": HOST, "account_id": "acc-wa"}, "PUT")
        self.assertEqual(r.status_code, 403)
        self.assertIn("permission", r.json()["detail"])
        # Not connected: 409 with "Connect"; anonymous: 401.
        r = await self.post("wo", f"{self.k1}/comment", {"site": HOST, "body": "hi"})
        self.assertEqual(r.status_code, 409)
        self.assertIn("Connect", r.json()["detail"])
        r = await self.http.post(f"/api/v1/jira/issue/{self.k1}/comment", json={"site": HOST, "body": "hi"})
        self.assertEqual(r.status_code, 401)
        # A site the person's Jira doesn't reach.
        r = await self.post("wm", f"{self.k1}/comment", {"site": "other.atlassian.net", "body": "hi"})
        self.assertEqual(r.status_code, 409)

    async def test_assign_comment_edit(self):
        r = await self.http.get(f"/api/v1/jira/issue/{self.k2}/assignable", params={"site": HOST, "q": "w"},
                                headers=self.session("wm"))
        names = {p["name"] for p in r.json()["people"]}
        self.assertIn("WA", names)
        r = await self.post("wm", f"{self.k2}/assignee", {"site": HOST, "account_id": "acc-wa", "slug": "launch"}, "PUT")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["issue"]["assignee"]["name"], "WA")
        r = await self.post("wm", f"{self.k2}/assignee", {"site": HOST, "account_id": None}, "PUT")
        self.assertIsNone(r.json()["issue"]["assignee"])
        r = await self.post("wm", f"{self.k2}/comment", {"site": HOST, "body": "Looks good\n\nShip it"})
        self.assertEqual(r.status_code, 200, r.text)
        c = self.fj.comments[self.k2][0]
        self.assertEqual((c["by"], c["body"]["content"][1]["content"][0]["text"]), ("acc-wm", "Ship it"))
        r = await self.post("wm", self.k2, {"site": HOST, "summary": "Runbook v2", "priority": "Low", "due": "2026-12-24"}, "PATCH")
        self.assertEqual(r.status_code, 200, r.text)
        it = r.json()["issue"]
        self.assertEqual((it["summary"], it["priority"], it["due"]), ("Runbook v2", "Low", "2026-12-24"))
        # The page's snapshot title follows an edit made from it.
        snap = await self.db[jira_pages.SNAPS].find_one({"key": self.k2})
        self.assertEqual(snap["title"], "Runbook v2")
        r = await self.post("wm", self.k2, {"site": HOST, "due": None}, "PATCH")
        self.assertIsNone(r.json()["issue"]["due"])
        r = await self.post("wm", self.k2, {"site": HOST, "priority": "Ultra"}, "PATCH")
        self.assertEqual(r.status_code, 422)
        self.assertIn("priority", r.json()["detail"])

    async def test_picker_search(self):
        r = await self.http.get("/api/v1/jira/search", params={"site": HOST, "q": "runbook"}, headers=self.session("wm"))
        self.assertEqual([i["key"] for i in r.json()["issues"]], [self.k2])
        r = await self.http.get("/api/v1/jira/search", params={"site": HOST, "q": self.k1.lower()}, headers=self.session("wm"))
        self.assertEqual([i["key"] for i in r.json()["issues"]], [self.k1])
        r = await self.http.get("/api/v1/jira/search", params={"site": HOST, "q": ""}, headers=self.session("wm"))
        self.assertEqual([i["key"] for i in r.json()["issues"]], [self.k1])          # assigned to WM


class Exports(PagesWorld):
    async def test_get_page_renders_plain_links(self):
        await self.connect("wa")
        await self.save("wa", "launch", page_body(self.k1, self.k2))
        r = await self.http.get("/api/v1/documents/launch/export", params={"format": "md"}, headers=self.session("wo"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn(f"[{self.k1} · Billing webhooks v2](https://{HOST}/browse/{self.k1})", r.text)
        self.assertIn(f"[{self.k2} · Runbook for the launch](https://{HOST}/browse/{self.k2})", r.text)
        self.assertIn("[Payments](https://acme.atlassian.net/issues/?jql=project%20%3D%20PAY)", r.text)
        self.assertNotIn("::jira", r.text)
        r = await self.http.get("/api/v1/documents/launch/export", params={"format": "html"}, headers=self.session("wo"))
        self.assertIn(f'href="https://{HOST}/browse/{self.k1}"', r.text)
        self.assertIn("Billing webhooks v2", r.text)
        self.assertNotIn("In Progress", r.text)                          # snapshots only, never live details
        status, res = await self.mcp_call(await self.mcp_token("wo", write=False), "get_page", {"document": "launch"})
        self.assertFalse(res["isError"], res)
        items = res["structuredContent"]["jira"]
        self.assertEqual([i["as"] for i in items], ["chip", "card", "list"])
        self.assertEqual(items[0]["text"], f"{self.k1} · Billing webhooks v2")
        self.assertIn(f"{self.k1} · Billing webhooks v2 (https://{HOST}/browse/{self.k1})", res["content"][0]["text"])
        self.assertIn(":jira[", res["structuredContent"]["markdown"])  # the Markdown itself stays editable


class Mcp(PagesWorld):
    async def call(self, who: str, name: str, args: dict, *, write: bool = True) -> dict:
        status, res = await self.mcp_call(await self.mcp_token(who, write=write), name, args)
        self.assertEqual(status, 200, name)
        return res

    async def test_insert_update_transitions(self):
        await self.connect("wo")
        res = await self.call("wo", "insert_jira", {"document": "launch", "issue": f"https://{HOST}/browse/{self.k1}"})
        self.assertFalse(res["isError"], res["content"][0]["text"])
        self.assertEqual(res["structuredContent"]["markdown"], f":jira[{self.k1}]")
        self.assertEqual(res["structuredContent"]["title"], "Billing webhooks v2")
        res = await self.call("wo", "insert_jira", {"document": "launch", "issue": self.k2, "as": "card",
                                                     "after_heading": "Launch"})
        self.assertFalse(res["isError"], res["content"][0]["text"])
        res = await self.call("wo", "insert_jira", {"document": "launch", "jql": 'project = "WEB"', "title": "Web"})
        self.assertFalse(res["isError"], res["content"][0]["text"])
        content = (await self.doc("launch"))["content"]
        self.assertIn(f":jira[{self.k1}]", content)
        self.assertIn(f"::jira{{key={self.k2}}}", content)
        self.assertIn('::jira-list{jql="project = &quot;WEB&quot;" title="Web"}', content)
        self.assertEqual([r.kind for r in jira_pages.refs(content)], ["chip", "card", "list"])
        # A reader who can't edit can't insert.
        res = await self.call("stranger", "insert_jira", {"document": "launch", "issue": self.k1})
        self.assertTrue(res["isError"])
        self.fj.extra_transitions.append(("61", "Resolve", "Done", {
            "resolution": {"name": "Resolution", "required": True, "allowedValues": [{"id": "1", "name": "Fixed"}]}}))
        res = await self.call("wo", "list_jira_transitions", {"issue": self.k1, "page": "launch"}, write=False)
        self.assertFalse(res["isError"], res["content"][0]["text"])
        self.assertIn("Resolve → Done; needs Resolution (Fixed)", res["content"][0]["text"])
        res = await self.call("wo", "update_jira_issue", {"issue": self.k1, "page": "launch", "transition": "Resolve"})
        self.assertTrue(res["isError"])
        self.assertIn("Resolution", res["content"][0]["text"])
        res = await self.call("wo", "update_jira_issue", {"issue": self.k1, "page": "launch", "transition": "Resolve",
                                                           "fields": {"resolution": "Fixed"}, "assignee": "me",
                                                           "comment": "Done from Markdrop", "priority": "Low"})
        self.assertFalse(res["isError"], res["content"][0]["text"])
        it = res["structuredContent"]["issue"]
        self.assertEqual((it["status"]["name"], it["assignee"]["name"], it["priority"]), ("Done", "WO", "Low"))
        self.assertEqual(self.fj.comments[self.k1][0]["by"], "acc-wo")
        res = await self.call("wo", "update_jira_issue", {"issue": self.k1, "assignee": None})
        self.assertIsNone(res["structuredContent"]["issue"]["assignee"])

    async def test_create_from_selection_puts_the_chip(self):
        await self.connect("wo")
        await self.db["documents"].update_one({"slug": "launch"}, {"$set": {
            "content": "# Launch\n\nWe still need to migrate the billing webhooks before Friday.\n"}})
        res = await self.call("wo", "create_jira_issue", {"page": "launch", "selection": "migrate the billing webhooks",
                                                           "draft": False, "summary": "Migrate billing webhooks"})
        self.assertFalse(res["isError"], res["content"][0]["text"])
        key = res["structuredContent"]["key"]
        self.assertTrue(res["structuredContent"]["chip"])
        self.assertIn(f"We still need to :jira[{key}] before Friday.", (await self.doc("launch"))["content"])


class Threads(PagesWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.connect("wm")
        doc = await self.doc("launch")
        self.tid = (await self.db["comment_threads"].insert_one({
            "doc_id": str(doc["_id"]), "workspace_id": self.W, "item_kind": "page", "status": "open",
            "anchor": {"type": "text", "quote": {"exact": "the billing webhooks"}, "block_text": "Migrate the billing webhooks"},
            "original": {"exact": "the billing webhooks", "block_text": None}, "created_by": self.uid["wm"],
            "created_at": now(), "updated_at": now(), "participants": [self.uid["wm"]], "mentions": [], "message_count": 2,
            "history": [], "suggestion": None, "deleted_at": None})).inserted_id
        for who, body in (("WM", "Should this be a ticket?"), ("WA", "Yes, for the next sprint.")):
            await self.db["comment_messages"].insert_one({"thread_id": self.tid, "doc_id": str(doc["_id"]), "author_id": None,
                                                          "author_name": who, "body": body, "mentions": [], "reactions": {},
                                                          "created_at": now(), "deleted_at": None, "kind": "comment"})

    async def test_thread_to_issue(self):
        base = f"/api/v1/jira/pages/launch/threads/{self.tid}"
        r = await self.http.post(f"{base}/draft", json={}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("Should this be a ticket?", r.json()["source"]["text"])
        r = await self.http.post(f"{base}/issue", json={"fields": {"project": "PAY", "summary": "Billing webhooks from the thread"}},
                                 headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        key = r.json()["key"]
        desc = str(self.fj.issues[key]["fields"]["description"])
        self.assertIn(f"/launch#c-{self.tid}", desc)                     # the issue links back to the discussion
        self.assertIn("WA: Yes, for the next sprint.", desc)
        r = await self.http.post(f"{base}/issue", json={"fields": {"project": "PAY", "summary": "again"}},
                                 headers=self.session("wm"))
        self.assertEqual(r.status_code, 409)
        # Everyone who sees the discussion sees "KEY · title"; live details only through their own Jira.
        r = await self.http.get("/api/v1/jira/pages/launch/threads", headers=self.session("wm"))
        row = r.json()["threads"][str(self.tid)]
        self.assertEqual((row["key"], row["title"], row["issue"]["status"]["name"]), (key, "Billing webhooks from the thread", "To Do"))
        r = await self.http.get("/api/v1/jira/pages/launch/threads", headers=self.session("wv"))
        self.assertIsNone(r.json()["threads"][str(self.tid)]["issue"])
        # Anonymous readers of a page without public comments: nothing.
        r = await self.http.get("/api/v1/jira/pages/launch/threads")
        self.assertEqual(r.json()["threads"], {})
        r = await self.http.delete(f"{base}/link", headers=self.session("wm"))
        self.assertTrue(r.json()["unlinked"])
        r = await self.http.post(f"{base}/link", json={"key": self.k2}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["key"], self.k2)
        r = await self.http.post(f"/api/v1/jira/pages/launch/threads/{ObjectId()}/link", json={"key": self.k2},
                                 headers=self.session("wm"))
        self.assertEqual(r.status_code, 404)


if __name__ == "__main__":
    unittest.main()
