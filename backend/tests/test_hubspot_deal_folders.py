"""HubSpot deal folders (services/hubspot_folders.py, brief .work/briefs/hubspot-deal-folders.md): a hidden Deals
folder in the HubSpot team with a folder per OPEN deal ("<Company> — <Deal>"), its Deal overview page (people's
notes kept), renames and closes followed, incremental syncs, the deal's calls moved in (team access unchanged),
"Pick the deal" for a company with several open deals, optional scopes degrading, the Deals board / Deal page /
chip / team cards, the MCP tools and the backfill — and HubSpot only ever READ (GET, search, batch read).

HubSpot, Zoom and the model are fakes (tests/_hubspot_fake.py, tests/_zoom_fake.py, tests/_thinking_fake):
nothing leaves the machine.

Run: cd backend && MARKDROP_TEST_MONGODB_URI=mongodb://127.0.0.1:27019 .venv/bin/python -m unittest tests.test_hubspot_deal_folders -v
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from bson import ObjectId

from app.services import hubspot, hubspot_accounts, hubspot_folders as HF
from tests.test_hubspot_v2 import S1, S2, V2World


def later(minutes: int) -> str:
    """A HubSpot change time after the sync started (HubSpot stamps a change with the time it happened)."""
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat().replace("+00:00", "Z")


def reads_only(calls: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Every HubSpot request that isn't a read (GET, a search or a batch read)."""
    return [(m, p) for m, p in calls if not (m == "GET" or (m == "POST" and (p.endswith("/search") or p.endswith("/batch/read")
                                                                          or "access-token-info" in p)))]


class DealWorld(V2World):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.conn = await hubspot.get(self.db, self.W)

    async def sync(self, **kw) -> dict:
        got = await HF.sync(self.db, await hubspot.get(self.db, self.W), force=True, **kw)
        await hubspot.drain()
        return got

    def world(self) -> dict:
        """Acme (one open deal, booked meeting), a deal without a company, a closed deal, and HubSpot history."""
        m, c, co, d = self.booked()
        self.fh.objects["contacts"][c]["properties"]["jobtitle"] = "CTO"
        solo = self.fh.add("deals", dealname="Solo deal", dealstage="appointmentscheduled", hs_lastmodifieddate="2026-11-03T00:00:00Z")
        won = self.fh.add("deals", dealname="Old win", dealstage="closedwon", hs_lastmodifieddate="2026-11-04T00:00:00Z")
        self.fh.files["555"] = {"id": "555", "name": "Security questionnaire", "extension": "pdf", "size": 2048}
        note = self.fh.add("notes", hs_note_body="<p>Champion is <b>Grace</b>; budget approved.</p>", hs_timestamp="2026-11-05T10:00:00Z",
                           hs_attachment_ids="555")
        email = self.fh.add("emails", hs_email_subject="Pricing for Acme", hs_email_text="Here is the annual pricing we discussed.",
                            hs_email_direction="EMAIL", hs_timestamp="2026-11-06T10:00:00Z")
        task = self.fh.add("tasks", hs_task_subject="Send MSA", hs_task_status="NOT_STARTED", hs_timestamp="2026-11-07T10:00:00Z")
        for kind, rid in (("notes", note), ("emails", email), ("tasks", task)):
            self.fh.link("deals", d, kind, rid)
        return {"meeting": m, "contact": c, "company": co, "deal": d, "solo": solo, "won": won}

    async def deal_row(self, deal_id: str) -> dict | None:
        return await self.db[HF.DEALS].find_one({"_id": HF.key_of(self.conn, deal_id)})

    async def folder(self, fid: str) -> dict:
        return await self.db["folders"].find_one({"_id": ObjectId(fid)})

    async def page_of(self, mid: str) -> dict:
        row = await self.db["meetings"].find_one({"_id": ObjectId(mid)})
        return await self.db["documents"].find_one({"_id": row["doc_id"]})


class Sync(DealWorld):
    async def test_open_deals_get_hidden_team_folders_and_an_overview_reading_only(self):
        w = self.world()
        got = await self.sync()
        self.assertEqual(got["state"], "idle")
        rows = await self.db[HF.DEALS].find({}).to_list(length=10)
        self.assertEqual({r["deal_id"] for r in rows}, {w["deal"], w["solo"]})          # never the closed one
        acme, solo = await self.deal_row(w["deal"]), await self.deal_row(w["solo"])
        self.assertEqual(acme["title"], "Acme Corp — Acme annual")
        self.assertEqual(solo["title"], "Solo deal")                                     # no company: the deal's name
        f = await self.folder(acme["folder_id"])
        root = await self.folder(f["parent_id"])
        self.assertEqual(root["name"], "Deals")
        for x in (f, root):
            self.assertTrue(x["hidden"])
            self.assertEqual(x["team_ids"], [self.sales])
        # The Deal overview page: in the folder, the team's, every fact and HubSpot's history.
        raw = await self.db["documents"].find_one({"_id": acme["doc_id"]})
        self.assertEqual((raw["title"], raw["folder_id"], raw["team_ids"]), ("Deal overview", acme["folder_id"], [self.sales]))
        body = raw["content"]
        for want in (HF.START, "Qualified to buy", "48,000 USD", "Rita Rep", "Sales Pipeline", "Acme Corp", "Grace Hopper", "CTO",
                     "grace@acme.test", "Pricing for Acme", "Email sent", "Champion is Grace", "Send MSA",
                     "Security questionnaire.pdf", HF.END):
            self.assertIn(want, body)
        self.assertLess(body.index("Send MSA"), body.index("Pricing for Acme"))           # newest first
        self.assertEqual((await self.get(raw["slug"], self.session("wm"))).status_code, 200)
        self.assertNotEqual((await self.get(raw["slug"], self.session("wv"))).status_code, 200)   # private team
        # Hidden from the file tree, the rail and browse; reachable by id.
        r = await self.http.get(f"/api/v1/workspaces/{self.W}/tree", headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse({acme["folder_id"], root["_id"].__str__()} & {x["id"] for x in r.json()["folders"]})
        r = await self.http.get(f"/api/v1/workspaces/{self.W}/nav", headers=self.session("wm"))
        self.assertNotIn(raw["slug"], [i["slug"] for i in r.json()["items"]])
        r = await self.http.get(f"/api/v1/workspaces/{self.W}/items", headers=self.session("wm"))
        self.assertNotIn(raw["slug"], [i["slug"] for i in r.json()["items"]])
        r = await self.http.get(f"/api/v1/workspaces/{self.W}/items", headers=self.session("wm"), params={"folder": acme["folder_id"]})
        self.assertIn(raw["slug"], [i["slug"] for i in r.json()["items"]])
        # People's notes outside the section stay on the next pass.
        await self.db["documents"].update_one({"_id": raw["_id"]}, {"$set": {"content": "Our plan: land and expand.\n\n" + body}})
        self.fh.objects["deals"][w["deal"]]["properties"].update(amount="52000", hs_lastmodifieddate=later(1))
        await self.sync()
        body = (await self.db["documents"].find_one({"_id": acme["doc_id"]}))["content"]
        self.assertIn("Our plan: land and expand.", body)
        self.assertIn("52,000 USD", body)
        self.assertEqual(body.count(HF.START), 1)
        self.assertEqual(reads_only(self.fh.calls), [])                                  # HubSpot is only read

    async def test_renames_closes_and_incremental_passes(self):
        w = self.world()
        await self.sync()
        first = self.fh.searches[-1]
        self.assertIn({"propertyName": "hs_is_closed", "operator": "EQ", "value": "false"}, first["filterGroups"][0]["filters"])
        self.assertEqual(first["sorts"], [{"propertyName": "hs_lastmodifieddate", "direction": "ASCENDING"}])
        # Renamed in HubSpot (deal and company): the folder follows.
        self.fh.objects["deals"][w["deal"]]["properties"].update(dealname="Acme platform", hs_lastmodifieddate=later(2))
        self.fh.objects["companies"][w["company"]]["properties"]["name"] = "Acme Inc"
        await self.sync()
        inc = self.fh.searches[-1]
        self.assertTrue(any(f["propertyName"] == "hs_lastmodifieddate" and f["operator"] == "GTE"
                            for g in inc["filterGroups"] for f in g["filters"]), inc)
        self.assertNotIn({"propertyName": "hs_is_closed", "operator": "EQ", "value": "false"}, inc["filterGroups"][0]["filters"])
        acme = await self.deal_row(w["deal"])
        self.assertEqual((await self.folder(acme["folder_id"]))["name"], "Acme Inc — Acme platform")
        # A new open deal shows up on the next pass.
        new = self.fh.add("deals", dealname="Fresh one", dealstage="qualifiedtobuy", hs_lastmodifieddate=later(3))
        await self.sync()
        self.assertIsNotNone((await self.deal_row(new) or {}).get("folder_id"))
        # Closed lost: the folder stays, marked; then it stops syncing.
        self.fh.objects["deals"][w["deal"]]["properties"].update(dealstage="closedlost", hs_is_closed="true", hs_is_closed_won="false",
                                                                  hs_lastmodifieddate=later(4))
        await self.sync()
        acme = await self.deal_row(w["deal"])
        self.assertTrue(acme["closed"])
        self.assertEqual(acme["closed_label"], "Closed lost")
        self.assertIsNotNone(await self.folder(acme["folder_id"]))
        self.assertIn("closed lost", (await self.db["documents"].find_one({"_id": acme["doc_id"]}))["content"])
        self.fh.objects["deals"][w["deal"]]["properties"].update(dealname="Renamed after closing", hs_lastmodifieddate=later(5))
        await self.sync()
        self.assertEqual((await self.deal_row(w["deal"]))["name"], "Acme platform")
        # A big account fills in over several capped passes.
        for i in range(5):
            self.fh.add("deals", dealname=f"Bulk {i}", dealstage="qualifiedtobuy", hs_lastmodifieddate=later(10 + i))
        got = await self.sync(cap=2)
        self.assertTrue(got["more"])
        for _ in range(4):
            await self.sync(cap=2)
        names = {r["name"] for r in await self.db[HF.DEALS].find({}).to_list(length=50)}
        self.assertTrue({f"Bulk {i}" for i in range(5)} <= names, names)
        self.assertEqual(reads_only(self.fh.calls), [])


class Calls(DealWorld):
    async def test_matched_call_moves_into_its_deal_folder_and_stays_the_teams(self):
        w = self.world()
        await self.sync()
        mid = await self.ready_call()
        acme = await self.deal_row(w["deal"])
        raw = await self.page_of(mid)
        self.assertEqual(raw["folder_id"], acme["folder_id"])
        self.assertEqual(raw["team_ids"], [self.sales])                                   # team access unchanged
        row = await self.db["meetings"].find_one({"_id": ObjectId(mid)})
        self.assertEqual(row["hubspot"]["filed"]["deal_id"], w["deal"])
        if row.get("transcript_doc_id"):
            t = await self.db["documents"].find_one({"_id": row["transcript_doc_id"]})
            self.assertEqual(t["folder_id"], acme["folder_id"])
        self.assertIn(mid, await self.listed_meetings("wm"))                              # still in Meetings
        self.assertNotIn(mid, await self.listed_meetings("wv"))
        body = (await self.db["documents"].find_one({"_id": acme["doc_id"]}))["content"]
        for want in ("Acme discovery call", "Go with the annual plan", "Send the proposal to Acme", "Security review is a blocker"):
            self.assertIn(want, body)
        # The chip, the board and the deal page.
        r = await self.http.get(f"/api/v1/hubspot/meetings/{mid}/chip", headers=self.session("wm"))
        self.assertEqual(r.json()["workspace_id"], self.W)
        self.assertEqual(r.json()["deal"], {"id": w["deal"], "name": "Acme annual", "company": "Acme Corp", "stage": "Qualified to buy",
                                            "closed_label": None, "href": f"/deals/{self.W}/{w['deal']}"})
        r = await self.http.get("/api/v1/hubspot/deals/board", headers=self.session("wm"), params={"workspace_id": self.W})
        self.assertEqual(r.status_code, 200, r.text)
        b = r.json()
        card = next(d for d in b["deals"] if d["id"] == w["deal"])
        self.assertEqual((card["calls"], card["last_call"]["title"], card["quiet"], card["company"]["name"]),
                         (1, "Acme discovery call", False, "Acme Corp"))
        self.assertFalse(b["can_sync"])
        self.assertIn("Qualified to buy", [s["label"] for s in b["stages"]])
        r = await self.http.get(f"/api/v1/hubspot/deals/{w['deal']}", headers=self.session("wm"), params={"workspace_id": self.W})
        self.assertEqual(r.status_code, 200, r.text)
        dd = r.json()
        self.assertEqual([c["meeting_id"] for c in dd["calls"]], [mid])
        self.assertEqual(dd["deal"]["contacts"][0]["title"], "CTO")
        self.assertIn("Go with the annual plan", [x["text"] for x in dd["rollup"]["decisions"]])
        self.assertTrue(dd["suggestions"] and dd["suggestions"][0]["meeting_id"] == mid)
        self.assertEqual({a["kind"] for a in dd["activity"]["items"]}, {"note", "email", "task", "meeting"})
        self.assertEqual(dd["attachments"]["items"][0]["name"], "Security questionnaire.pdf")
        self.assertTrue(dd["attachments"]["items"][0]["url"].endswith(f"/record/0-3/{w['deal']}"))
        self.assertEqual(dd["overview"]["slug"], (await self.db["documents"].find_one({"_id": acme["doc_id"]}))["slug"])
        # A person who moves it elsewhere keeps it there (filed once).
        await self.db["documents"].update_one({"_id": raw["_id"]}, {"$set": {"folder_id": None}})
        await HF.file_call(self.db, self.conn, await self.db["meetings"].find_one({"_id": ObjectId(mid)}))
        self.assertIsNone((await self.page_of(mid))["folder_id"])
        self.assertEqual(reads_only(self.fh.calls), [])

    async def test_several_open_deals_wait_for_a_person_and_a_pick_moves_it(self):
        self.world()
        globex = self.fh.add("companies", name="Globex", domain="globex.test")
        g1 = self.fh.add("deals", dealname="Globex pilot", dealstage="qualifiedtobuy", hs_lastmodifieddate="2026-11-08T00:00:00Z")
        g2 = self.fh.add("deals", dealname="Globex expansion", dealstage="appointmentscheduled", hs_lastmodifieddate="2026-11-09T00:00:00Z")
        hank = self.fh.add("contacts", email="hank@globex.test", firstname="Hank", lastname="Scorpio")
        self.fh.link("contacts", hank, "companies", globex)
        for d in (g1, g2):
            self.fh.link("deals", d, "companies", globex)
            self.fh.link("companies", globex, "deals", d)
        await self.sync()
        mid = await self.call(start=S2, topic="Globex sync", host="wm")
        await self.db["meetings"].update_one({"_id": ObjectId(mid)}, {"$set": {"attendees": [
            {"name": "Hank Scorpio", "email": "hank@globex.test"}, {"name": "A", "email": "a@x.test"}, {"name": "B", "email": "b@x.test"}]}, "$unset": {"hubspot": ""}})
        await self.fresh(mid)
        await self.ready(mid)
        row = await self.db["meetings"].find_one({"_id": ObjectId(mid)})
        self.assertEqual(row["hubspot"]["match"]["confidence"], "low")
        self.assertNotIn("filed", row["hubspot"])                                         # never moved on a guess
        before = (await self.page_of(mid))["folder_id"]
        r = await self.http.get(f"/api/v1/hubspot/meetings/{mid}/chip", headers=self.session("wm"))
        self.assertEqual(r.json(), {"deal": None, "pick": True, "workspace_id": self.W})
        for d in (g1, g2):
            r = await self.http.get(f"/api/v1/hubspot/deals/{d}", headers=self.session("wm"), params={"workspace_id": self.W})
            self.assertEqual([c["meeting_id"] for c in r.json()["pick"]], [mid], (d, row["hubspot"]["match"], row.get("restricted"), row["team_ids"]))
        b = (await self.http.get("/api/v1/hubspot/deals/board", headers=self.session("wm"), params={"workspace_id": self.W})).json()
        self.assertEqual({d["id"]: d["pick"] for d in b["deals"] if d["id"] in (g1, g2)}, {g1: 1, g2: 1})
        # Pick the deal: filed there; picking the other one moves it across; none puts it back with the meetings.
        r = await self.http.put(f"/api/v1/hubspot/meetings/{mid}/match", headers=self.session("wm"), json={"deal_id": g2})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self.page_of(mid))["folder_id"], (await self.deal_row(g2))["folder_id"])
        r = await self.http.put(f"/api/v1/hubspot/meetings/{mid}/match", headers=self.session("wm"), json={"deal_id": g1})
        self.assertEqual((await self.page_of(mid))["folder_id"], (await self.deal_row(g1))["folder_id"])
        g1_body = (await self.db["documents"].find_one({"_id": (await self.deal_row(g1))["doc_id"]}))["content"]
        g2_body = (await self.db["documents"].find_one({"_id": (await self.deal_row(g2))["doc_id"]}))["content"]
        self.assertIn("Globex sync", g1_body)
        self.assertNotIn("Globex sync", g2_body)
        r = await self.http.put(f"/api/v1/hubspot/meetings/{mid}/match", headers=self.session("wm"), json={"deal_id": None})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self.page_of(mid))["folder_id"], before)
        self.assertEqual(reads_only([c for c in self.fh.calls]), [])


class Scopes(DealWorld):
    async def test_missing_read_scopes_degrade_and_are_listed(self):
        self.fh.scopes.remove("sales-email-read")
        self.fh.scopes.remove("files.ui_hidden.read")
        w = self.world()
        await self.sync()
        body = (await self.db["documents"].find_one({"_id": (await self.deal_row(w["deal"]))["doc_id"]}))["content"]
        self.assertIn("Add sales-email-read", body)
        self.assertNotIn("Pricing for Acme", body)
        self.assertIn("Champion is Grace", body)                                          # the rest still there
        dd = (await self.http.get(f"/api/v1/hubspot/deals/{w['deal']}", headers=self.session("wa"),
                                  params={"workspace_id": self.W, "fresh": True})).json()
        self.assertIn({"scope": "sales-email-read", "what": "emails"}, dd["activity"]["missing"])
        self.assertEqual(dd["attachments"]["items"][0]["name"], "Attachment")
        self.assertEqual(dd["attachments"]["missing"], [{"scope": "files.ui_hidden.read", "what": "attachment names"}])
        st = (await self.http.get("/api/v1/hubspot/status", headers=self.session("wa"), params={"workspace_id": self.W})).json()
        missing = {m["scope"]: m["required"] for m in st["connection"]["missing_scopes"]}
        self.assertEqual(missing, {"sales-email-read": False, "files.ui_hidden.read": False})
        self.assertIsNone(st["connection"]["broken"])                                     # optional: still working
        b = (await self.http.get("/api/v1/hubspot/deals/board", headers=self.session("wa"), params={"workspace_id": self.W})).json()
        self.assertEqual({m["scope"] for m in b["missing_scopes"]}, {"sales-email-read", "files.ui_hidden.read"})
        # Without the contacts read scope at all: no history, the deal folders still sync.
        self.fh.scopes.remove("crm.objects.contacts.read")
        self.fh.objects["deals"][w["deal"]]["properties"].update(amount="1000", hs_lastmodifieddate=later(6))
        got = await self.sync()
        self.assertEqual(got["state"], "idle")
        self.assertEqual(reads_only(self.fh.calls), [])


class Access(DealWorld):
    async def test_only_the_hubspot_team_sees_deals(self):
        w = self.world()
        await self.sync()
        for who, code in (("wv", 403), ("ownv", 403)):
            r = await self.http.get("/api/v1/hubspot/deals/board", headers=self.session(who), params={"workspace_id": self.W})
            self.assertEqual(r.status_code, code, (who, r.text))
            r = await self.http.get(f"/api/v1/hubspot/deals/{w['deal']}", headers=self.session(who), params={"workspace_id": self.W})
            self.assertEqual(r.status_code, code)
        r = await self.http.post("/api/v1/hubspot/deals/sync", headers=self.session("wm"), json={"workspace_id": self.W})
        self.assertEqual(r.status_code, 403)
        r = await self.http.post("/api/v1/hubspot/deals/sync", headers=self.session("wa"), json={"workspace_id": self.W})
        self.assertEqual(r.status_code, 200, r.text)
        await hubspot.drain()
        # Team cards: the Sales team is the HubSpot one (Zoom too); no other team is.
        r = await self.http.get(f"/api/v1/workspaces/{self.W}/teams", headers=self.session("owner"))
        cards = {t["id"]: t for t in r.json()["teams"]}
        self.assertTrue(cards[self.sales]["hubspot"])
        self.assertEqual(cards[self.sales]["linked"], ["Zoom", "HubSpot"])
        self.assertFalse(any(t["hubspot"] for tid, t in cards.items() if tid != self.sales))
        r = await self.http.get(f"/api/v1/workspaces/{self.W}/teams", headers=self.session("wv"))
        self.assertFalse(any(t["hubspot"] for t in r.json()["teams"]))
        # Not connected any more: no deals.
        await self.http.delete("/api/v1/hubspot/connection", headers=self.session("wa"), params={"workspace_id": self.W})
        r = await self.http.get("/api/v1/hubspot/deals/board", headers=self.session("wm"), params={"workspace_id": self.W})
        self.assertEqual(r.status_code, 404)
        acme = await self.deal_row(w["deal"])                    # the folders stay, back in the file tree
        self.assertFalse((await self.folder(acme["folder_id"])).get("hidden"))
        r = await self.http.get(f"/api/v1/workspaces/{self.W}/tree", headers=self.session("wm"))
        self.assertIn(acme["folder_id"], {x["id"] for x in r.json()["folders"]})


class McpAndBackfill(DealWorld):
    async def test_mcp_tools(self):
        w = self.world()
        await self.sync()
        mid = await self.ready_call()
        token = await self.mcp_token("wm")
        code, res = await self.mcp_call(token, "hubspot_list_deals", {"workspace": self.W})
        self.assertFalse(res.get("isError"), res)
        self.assertEqual({d["id"] for d in res["structuredContent"]["deals"]}, {w["deal"], w["solo"]})
        self.assertIn("Acme Corp — Acme annual", res["content"][0]["text"])
        code, res = await self.mcp_call(token, "hubspot_deal_folder", {"workspace": self.W, "deal": w["deal"]})
        self.assertFalse(res.get("isError"), res)
        self.assertEqual([c["meeting_id"] for c in res["structuredContent"]["calls"]], [mid])
        self.assertIn("Pricing for Acme", res["content"][0]["text"])
        code, res = await self.mcp_call(token, "hubspot_sync_deals", {"workspace": self.W})
        self.assertTrue(res.get("isError"), res)                                          # admins only
        code, res = await self.mcp_call(await self.mcp_token("wa"), "hubspot_sync_deals", {"workspace": self.W})
        self.assertFalse(res.get("isError"), res)
        await hubspot.drain()
        code, res = await self.mcp_call(await self.mcp_token("wv"), "hubspot_list_deals", {"workspace": self.W})
        self.assertTrue(res.get("isError"), res)
        self.assertEqual(reads_only(self.fh.calls), [])

    async def test_backfill_dry_run_then_apply(self):
        w = self.world()
        # Before deal folders: a call matched to the deal, and a company account page (Phase 2).
        mid = await self.ready_call()
        await self.db["meetings"].update_one({"_id": ObjectId(mid)}, {"$unset": {"hubspot.filed": ""}})
        await hubspot_accounts.refresh(self.db, self.conn, w["company"], user_id=self.uid["owner"])
        acc = await self.db[hubspot_accounts.ACCOUNTS].find_one({})
        await self.db[HF.DEALS].delete_many({})
        await self.db[hubspot.CONNS].update_one({"_id": self.W}, {"$unset": {"deals_sync": ""}})
        folders_before = await self.db["folders"].count_documents({})
        n_calls = len(self.fh.calls)
        lines: list[str] = []
        got = await HF.backfill(self.db, self.W, apply=False, on_line=lines.append)
        self.assertEqual((got["new_folders"], got["calls_to_move"], got["account_pages"]), (2, 1, 1), got)
        self.assertEqual(await self.db[HF.DEALS].count_documents({}), 0)                 # dry: nothing written
        self.assertEqual(await self.db["folders"].count_documents({}), folders_before)
        self.assertEqual(reads_only(self.fh.calls[n_calls:]), [])
        got = await HF.backfill(self.db, self.W, apply=True, on_line=lines.append)
        self.assertEqual((got["deal_folders"], got["account_pages_archived"]), (2, 1), got)
        acme = await self.deal_row(w["deal"])
        self.assertEqual((await self.page_of(mid))["folder_id"], acme["folder_id"])
        page = await self.db["documents"].find_one({"_id": acc["doc_id"]})
        archive = await self.folder(page["folder_id"])
        self.assertEqual(archive["name"], "Accounts (archived)")
        self.assertEqual(archive["team_ids"], [self.sales])
        self.assertEqual((await self.get(page["slug"], self.session("wm"))).status_code, 200)   # still readable
        # Account pages aren't made any more: a new call doesn't make one.
        await self.db[hubspot_accounts.ACCOUNTS].delete_many({})
        await self.ready_call(start=S1, topic="Acme again")
        self.assertEqual(await self.db[hubspot_accounts.ACCOUNTS].count_documents({}), 0)
        self.assertEqual(reads_only(self.fh.calls), [])
