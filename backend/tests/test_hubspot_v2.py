"""HubSpot Phase 2 (services/hubspot_deals.py, hubspot_accounts.py, hubspot_notify.py; brief
.work/briefs/hubspot-v2.md): suggested deal updates (validated, evidence, never applied on their own, Apply
and Dismiss remembered, the write scope), account pages (team-only, edits outside the section kept),
pre-call briefs (Slack + inbox, once, opt-out), the host's Slack Log / Create tasks buttons, the pipeline
(at risk, the weekly brief's section, Ask, only for people who may use HubSpot) and the MCP tools.

HubSpot, Slack and the model are fakes (tests/_hubspot_fake.py, tests/test_slack.FakeSlack,
tests/_thinking_fake via AIEnv): nothing leaves the machine.

Run: cd backend && MARKDROP_TEST_MONGODB_URI=mongodb://127.0.0.1:27019 .venv/bin/python -m unittest tests.test_hubspot_v2 -v
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone

from bson import ObjectId

from app.services import (access, ask_markdrop, hubspot, hubspot_accounts, hubspot_deals, hubspot_notify, meetings_ai,
                          notifications, slack, slack_action_items as sai, team_briefs)
from app.services import teams as T
from app.services.user import get_user_by_id
from tests._hubspot_fake import ms
from tests._zoom_fake import iso_days_ago
from tests.test_hubspot import START, HubSpotWorld
from tests.test_slack import HOOK, TEAM, SlackWorld


def sug_reply(user: str) -> str:
    """The fake model's suggestions: a valid stage move, close date, competitor and decision maker; and what
    must be dropped (another pipeline's stage, an unknown field, the current amount, no evidence)."""
    segs = re.findall(r"\[(s\d+)\]", user.split("<untrusted_transcript>", 1)[-1])
    ev = [segs[0]] if segs else ["n1"]
    return json.dumps({"updates": [
        {"field": "dealstage", "value": "renewalstage", "why": "x", "evidence": ev},          # not this deal's pipeline
        {"field": "dealstage", "value": "proposal", "why": "They asked for a proposal.", "evidence": ev},
        {"field": "closedate", "value": "2026-12-31", "why": "They want to sign by year end.", "evidence": ["n1"]},
        {"field": "amount", "value": "48000", "why": "Same as now", "evidence": ev},             # the current value
        {"field": "hs_next_step", "value": "Send the proposal", "why": "x", "evidence": ["s99999"]},  # no evidence
        {"field": "hs_is_closed", "value": "true", "why": "x", "evidence": ev},                 # not offered
        {"field": "competitor", "value": "Globex", "why": "They compared us with Globex.", "evidence": ev},
        {"field": "decision_maker_name", "value": "Grace Hopper", "why": "Grace signs off.", "evidence": ["n2"]}],
        "account": {"objections": [{"text": "Security review is a blocker", "cite": ev[0]}],
                    "risks": [{"text": "Globex is cheaper", "cite": "n1"}]}})


S1, S2 = iso_days_ago(1, 6), iso_days_ago(1, 8)     # yesterday: not a past meeting (those get none of this)


class V2World(HubSpotWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.fh.pipelines[0]["stages"].insert(2, {"id": "proposal", "label": "Proposal sent", "metadata": {"isClosed": "false"}})
        self.fh.pipelines.append({"id": "renewals", "label": "Renewals", "stages": [
            {"id": "renewalstage", "label": "Renewal due", "metadata": {"isClosed": "false"}}]})
        self.assertEqual((await self.hs_connect()).status_code, 200)
        self.sug_calls = 0

    def script(self, params: dict) -> str:
        system = params["system"][0]["text"]
        if system.startswith("You keep a HubSpot deal up to date"):
            self.sug_calls += 1
            user = "\n".join(b["text"] for b in params["messages"][-1]["content"] if b.get("type") == "text")
            return sug_reply(user)
        return super().script(params)

    async def fresh(self, mid: str) -> None:
        """Forget what the import's own background work did, so a test drives the hook itself."""
        await self.db["meetings"].update_one({"_id": ObjectId(mid)}, {"$unset": {
            "hubspot.suggestions": "", "hubspot.offer": "", "hubspot.logged": ""}})

    async def ready(self, mid: str) -> None:
        await meetings_ai._slack_ready(self.db, await self.db["meetings"].find_one({"_id": ObjectId(mid)}))
        await hubspot.drain()

    def booked(self, start: str | None = None, owner: str | None = None, **props):
        return super().booked(start or S1, owner, **props)

    async def ready_call(self, **kw) -> str:
        kw.setdefault("start", S1)
        mid = await self.call(**kw)
        await self.fresh(mid)
        await self.ready(mid)
        return mid

    async def post(self, path: str, who: str = "wm", **kw):
        return await self.http.post(path, headers=self.session(who), **kw)


class Suggestions(V2World):
    async def test_suggested_validated_never_applied_alone_then_applied_and_remembered(self):
        _m, _c, _co, d = self.booked()
        await self.http.put("/api/v1/hubspot/settings", headers=self.session("wa"), json={"workspace_id": self.W, "deal_updates": True})   # Apply changes deals only when turned on
        mid = await self.ready_call()
        p = await self.panel(mid)
        items = {i["field"]: i for i in p["suggestions"]["items"]}
        self.assertEqual(set(items), {"dealstage", "closedate", "competitor", "decision_maker_name"}, items)
        self.assertEqual((items["dealstage"]["value"], items["dealstage"]["display"], items["dealstage"]["current"]),
                         ("proposal", "Proposal sent", "Qualified to buy"))
        self.assertEqual(items["competitor"]["value"], "globex")                   # the option's value, from its label
        self.assertTrue(all(i["state"] == "open" and i["evidence"] for i in items.values()))
        self.assertTrue(items["dealstage"]["evidence"][0]["quote"])
        self.assertFalse(any(m_ == "PATCH" and "/deals/" in p_ for m_, p_ in self.fh.calls))   # nothing applied
        self.assertEqual(self.fh.objects["deals"][d]["properties"]["dealstage"], "qualifiedtobuy")
        # Someone outside the private team can't see or apply them.
        r = await self.post(f"/api/v1/hubspot/meetings/{mid}/suggestions/{items['dealstage']['id']}/apply", "wv")
        self.assertEqual(r.status_code, 404)
        # Apply: one PATCH of one property; again: nothing more.
        r = await self.post(f"/api/v1/hubspot/meetings/{mid}/suggestions/{items['dealstage']['id']}/apply")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.fh.objects["deals"][d]["properties"]["dealstage"], "proposal")
        r = await self.post(f"/api/v1/hubspot/meetings/{mid}/suggestions/{items['dealstage']['id']}/apply", "owner")
        self.assertEqual(r.status_code, 200, r.text)
        patches = [b for m_, p_, b in self.fh.bodies if m_ == "PATCH" and p_ == f"/crm/v3/objects/deals/{d}"]
        self.assertEqual(patches, [{"properties": {"dealstage": "proposal"}}])
        r = await self.post(f"/api/v1/hubspot/meetings/{mid}/suggestions/{items['closedate']['id']}/apply")
        self.assertEqual(self.fh.objects["deals"][d]["properties"]["closedate"], str(ms("2026-12-31T00:00:00Z")))
        r = await self.post(f"/api/v1/hubspot/meetings/{mid}/suggestions/{items['competitor']['id']}/dismiss")
        st = {i["field"]: i["state"] for i in r.json()["suggestions"]["items"]}
        self.assertEqual(st, {"dealstage": "applied", "closedate": "applied", "competitor": "dismissed", "decision_maker_name": "open"})
        # Asking again keeps what people decided.
        r = await self.post(f"/api/v1/hubspot/meetings/{mid}/suggestions")
        self.assertEqual(r.status_code, 200, r.text)
        st = {i["field"]: i["state"] for i in r.json()["suggestions"]["items"]}
        self.assertEqual((st["dealstage"], st["closedate"], st["competitor"]), ("applied", "applied", "dismissed"))
        # Without the write scope: refused, the card lists it as missing.
        self.fh.scopes.remove("crm.objects.deals.write")
        r = await self.post(f"/api/v1/hubspot/meetings/{mid}/suggestions/{items['decision_maker_name']['id']}/apply")
        self.assertEqual(r.status_code, 409, r.text)
        self.assertIn("crm.objects.deals.write", r.json()["detail"])
        st = (await self.http.get("/api/v1/hubspot/status", headers=self.session("wa"), params={"workspace_id": self.W})).json()
        self.assertIn("crm.objects.deals.write", [x["scope"] for x in st["connection"]["missing_scopes"]])
        self.assertEqual(st["deals_write"], "missing")
        self.assertIsNone(self.fh.objects["deals"][d]["properties"].get("decision_maker_name"))
        p = await self.panel(mid)
        self.assertEqual(next(i for i in p["suggestions"]["items"] if i["field"] == "decision_maker_name")["state"], "failed")

    async def test_switch_off_and_low_confidence_ask_nothing(self):
        await self.http.put("/api/v1/hubspot/settings", headers=self.session("wa"), json={"workspace_id": self.W, "suggest": False})
        self.booked()
        mid = await self.ready_call()
        self.assertEqual(self.sug_calls, 0)
        self.assertFalse((await self.panel(mid))["suggestions"]["enabled"])
        st = (await self.http.get("/api/v1/hubspot/status", headers=self.session("wa"), params={"workspace_id": self.W})).json()
        self.assertEqual(st["switches"], {"auto_log": False, "suggest": False, "accounts": True, "precall": True, "approve": True, "deal_updates": False})
        r = await self.http.put("/api/v1/hubspot/settings", headers=self.session("wm"), json={"workspace_id": self.W, "suggest": True})
        self.assertEqual(r.status_code, 403)


class Accounts(V2World):
    async def test_account_page_in_the_team_and_edits_outside_the_section_stay(self):
        _m, _c, co, _d = self.booked()
        mid = await self.ready_call()
        # Deals replaced account pages (2026-11-18): a call doesn't make one any more; an existing one is kept up to date.
        self.assertIsNone(await self.db[hubspot_accounts.ACCOUNTS].find_one({"company_id": co}))
        conn = await hubspot.get(self.db, self.W)
        await hubspot_accounts.refresh(self.db, conn, co, user_id=self.uid["owner"])
        acc = await self.db[hubspot_accounts.ACCOUNTS].find_one({"company_id": co})
        self.assertIsNotNone(acc)
        raw = await self.db["documents"].find_one({"_id": acc["doc_id"]})
        self.assertEqual(raw["team_ids"], [self.sales])
        self.assertEqual(raw["title"], "Acme Corp")
        body = raw["content"]
        for want in (hubspot_accounts.START, "Acme annual", "Acme discovery call", "Go with the annual plan",
                     "Security review is a blocker", "Send the proposal to Acme", hubspot_accounts.END):
            self.assertIn(want, body)
        self.assertEqual((await self.get(raw["slug"], self.session("wm"))).status_code, 200)
        self.assertNotEqual((await self.get(raw["slug"], self.session("wv"))).status_code, 200)   # private team
        p = await self.panel(mid)
        self.assertEqual(p["account"]["slug"], raw["slug"])
        # People's notes around the section stay; a second call for the company rewrites only the section.
        edited = "Our champion is Grace.\n\n" + body + "\nRenewal is in March.\n"
        await self.db["documents"].update_one({"_id": raw["_id"]}, {"$set": {"content": edited}})
        m2 = self.fh.add("meetings", hs_meeting_title="Acme follow-up", hs_meeting_start_time=S2,
                         hubspot_owner_id=self.ada)
        self.fh.link("meetings", m2, "companies", co)
        self.fh.link("meetings", m2, "deals", _d)
        mid2 = await self.ready_call(start=S2, topic="Acme follow-up")
        r = await self.post(f"/api/v1/hubspot/meetings/{mid2}/account")          # Update on request
        self.assertEqual(r.status_code, 200, r.text)
        body = (await self.db["documents"].find_one({"_id": acc["doc_id"]}))["content"]
        self.assertIn("Our champion is Grace.", body)
        self.assertIn("Renewal is in March.", body)
        self.assertEqual(body.count(hubspot_accounts.START), 1)
        self.assertIn("Acme follow-up", body)
        self.assertEqual(await self.db[hubspot_accounts.ACCOUNTS].count_documents({}), 1)

    def test_merge(self):
        sec = f"{hubspot_accounts.START}\n\nnew\n\n{hubspot_accounts.END}"
        self.assertEqual(hubspot_accounts.merge("Mine", sec), "Mine\n\n" + sec + "\n")
        cur = f"Top\n\n{hubspot_accounts.START}\n\nold\n\n{hubspot_accounts.END}\n\nBottom"
        self.assertEqual(hubspot_accounts.merge(cur, sec), f"Top\n\n{sec}\n\nBottom")
        cur = f"Top\n\n{hubspot_accounts.START}\n\nold\n\n## Mine\n\nkept"
        self.assertEqual(hubspot_accounts.merge(cur, sec), f"Top\n\n{sec}\n## Mine\n\nkept")


class SlackV2(V2World, SlackWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        sai._NAMES.clear()
        await self.install()

    async def fresh(self, mid: str) -> None:
        await super().fresh(mid)
        self.sk.calls.clear()          # the import's own messages: the test drives the hook itself

    def dms(self, eyebrow: str, sid: str | None = None) -> list[dict]:
        return [d for d in self.sk.of("chat.postMessage") if d["channel"].startswith("U") and (sid is None or d["channel"] == sid)
                and eyebrow in json.dumps(d.get("blocks"), ensure_ascii=False)]

    @staticmethod
    def buttons(msg: dict, action_id: str) -> list[dict]:
        return [e for b in msg["blocks"] for e in b.get("elements", []) if e.get("action_id") == action_id]


class PreCall(SlackV2):
    def upcoming(self, owner: str, minutes: int, now: datetime, deal: str | None, contact: str | None, title="Acme pricing call"):
        m = self.fh.add("meetings", hs_meeting_title=title, hubspot_owner_id=owner,
                        hs_meeting_start_time=(now + timedelta(minutes=minutes)).isoformat().replace("+00:00", "Z"))
        if deal:
            self.fh.link("meetings", m, "deals", deal)
        if contact:
            self.fh.link("meetings", m, "contacts", contact)
        return m

    async def test_brief_once_in_slack_and_inbox_with_opt_out(self):
        self.in_slack("owner", "U0ADA")
        self.in_slack("wm", "U0BO")
        _m, c, _co, d = self.booked()
        await self.ready_call()                                            # the last call, matched to the deal
        now = datetime.now(timezone.utc)
        self.upcoming(self.ada, 40, now, d, c)
        self.upcoming(self.ada, 120, now, d, c, title="Too far ahead")
        self.upcoming(self.bo, 30, now, None, None, title="No contact")    # nothing to brief about
        n = await hubspot_notify.tick(self.db, now)
        self.assertEqual(n, 1)
        dm = self.dms("Pre-call brief", "U0ADA")
        self.assertEqual(len(dm), 1)
        text = json.dumps(dm[0]["blocks"], ensure_ascii=False)
        for want in ("Acme pricing call", "Acme annual", "Qualified to buy", "Acme discovery call", "Send the proposal to Acme"):
            self.assertIn(want, text)
        self.assertNotIn("Too far ahead", json.dumps(self.sk.of("chat.postMessage")))
        self.assertEqual(self.dms("Pre-call brief", "U0BO"), [])
        got = await notifications.listing(self.db, self.uid["owner"])
        pre = [i for i in got["items"] if i["kind"] == "hubspot_precall"]
        self.assertEqual(len(pre), 1)
        self.assertIn("Acme pricing call", pre[0]["text"])
        self.assertTrue(pre[0]["available"])
        # Once.
        self.assertEqual(await hubspot_notify.tick(self.db, now + timedelta(minutes=5)), 0)
        self.assertEqual(len(self.dms("Pre-call brief", "U0ADA")), 1)
        # Stop these → nothing more for Ada; Bo turned his off in settings.
        stop = self.buttons(dm[0], "md_hs_stop")[0]
        await self.click("md_hs_stop", stop["value"], "U0ADA")
        await slack.drain()
        self.assertIn("won't get", json.dumps(self.sk.responds[-1]))
        r = await self.http.get("/api/v1/hubspot/me", headers=self.session("owner"))
        self.assertFalse(r.json()["precall"])
        self.assertEqual(r.json()["teams"][0]["team"], "Sales")
        r = await self.http.put("/api/v1/hubspot/me", headers=self.session("wm"), json={"precall": False})
        self.assertFalse(r.json()["precall"])
        self.upcoming(self.ada, 45, now, d, c, title="Second call")
        self.upcoming(self.bo, 45, now, d, c, title="Bo's call")
        self.assertEqual(await hubspot_notify.tick(self.db, now), 0)
        self.assertEqual(len(self.dms("Pre-call brief")), 1)

    async def test_workspace_switch_off_sends_nothing(self):
        self.in_slack("owner", "U0ADA")
        _m, c, _co, d = self.booked()
        await self.http.put("/api/v1/hubspot/settings", headers=self.session("wa"), json={"workspace_id": self.W, "precall": False})
        now = datetime.now(timezone.utc)
        self.upcoming(self.ada, 40, now, d, c)
        self.assertEqual(await hubspot_notify.tick(self.db, now), 0)
        self.assertEqual(self.dms("Pre-call brief"), [])


class Approve(SlackV2):
    async def test_host_logs_and_creates_tasks_from_slack(self):
        self.in_slack("owner", "U0ADA")
        self.in_slack("wm", "U0BO")
        m, _c, _co, _d = self.booked()
        mid = await self.ready_call()
        dm = self.dms("HubSpot", "U0ADA")
        self.assertEqual(len(dm), 1, self.sk.of("chat.postMessage"))
        self.assertEqual(self.dms("HubSpot", "U0BO"), [])                  # only the host
        self.assertNotIn("hs_internal_meeting_notes", self.fh.objects["meetings"][m]["properties"])   # nothing before a click
        self.assertEqual(self.fh.objects["tasks"], {})
        log_b = self.buttons(dm[0], "md_hs_log")[0]
        tasks_b = self.buttons(dm[0], "md_hs_tasks")[0]
        self.assertIn("2 tasks", tasks_b["text"]["text"])
        # Someone else's click does nothing.
        await self.click("md_hs_log", log_b["value"], "U0BO")
        await slack.drain()
        self.assertIn("Only the person", json.dumps(self.sk.responds[-1]))
        self.assertNotIn("hs_internal_meeting_notes", self.fh.objects["meetings"][m]["properties"])
        await self.click("md_hs_log", log_b["value"], "U0ADA")
        await slack.drain()
        self.assertIn(hubspot.MARK_START, self.fh.objects["meetings"][m]["properties"]["hs_internal_meeting_notes"])
        await self.click("md_hs_tasks", tasks_b["value"], "U0ADA")
        await slack.drain()
        self.assertEqual(len(self.fh.objects["tasks"]), 2)
        await self.click("md_hs_tasks", tasks_b["value"], "U0ADA")
        await slack.drain()
        self.assertEqual(len(self.fh.objects["tasks"]), 2)                  # never twice
        self.assertTrue(any("2 tasks created" in json.dumps(u, ensure_ascii=False) for u in self.sk.of("chat.update")))
        p = await self.panel(mid)
        self.assertTrue(p["logged"])
        # Opted out: the next call sends nothing.
        await self.http.put("/api/v1/hubspot/me", headers=self.session("owner"), json={"approve": False})
        self.booked(S2)
        mid2 = await self.ready_call(start=S2, topic="Acme second call")
        self.assertEqual(self.dms("HubSpot", "U0ADA"), [])
        self.assertNotIn("offer", (await self.db["meetings"].find_one({"_id": ObjectId(mid2)}))["hubspot"])


class Pipeline(V2World):
    async def test_pipeline_risks_brief_and_ask_only_for_hubspot_people(self):
        _m, _c, co, d = self.booked()
        await self.ready_call()
        quiet = self.fh.add("deals", dealname="Globex rollout", dealstage="proposal", hs_is_closed="false",
                            closedate="2026-10-01T00:00:00Z", amount="9000", hs_lastmodifieddate="2026-10-01T00:00:00Z")
        r = await self.http.get("/api/v1/hubspot/pipeline", headers=self.session("wm"), params={"workspace_id": self.W})
        self.assertEqual(r.status_code, 200, r.text)
        by = {x["name"]: x for x in r.json()["deals"]}
        self.assertEqual(by["Acme annual"]["last_call"]["title"], "Acme discovery call")
        self.assertTrue(any("close date 2026-10-01 passed" in x for x in by["Globex rollout"]["risks"]))
        self.assertTrue(any(x.startswith("no call") for x in by["Globex rollout"]["risks"]))
        r = await self.http.get("/api/v1/hubspot/pipeline", headers=self.session("wv"), params={"workspace_id": self.W})
        self.assertEqual(r.status_code, 403)
        # The weekly brief: a snapshot, then the moves since.
        team = await self.db[T.TEAMS].find_one({"_id": ObjectId(self.sales)})
        first = await hubspot_deals.brief_lines(self.db, team, "2026-W45")
        self.assertFalse(any("moved" in ln["text"] for ln in first))
        self.assertTrue(any("At risk: Globex rollout" in ln["text"] for ln in first))
        self.fh.objects["deals"][d]["properties"]["dealstage"] = "proposal"
        nxt = await hubspot_deals.brief_lines(self.db, team, "2026-W46")
        self.assertIn("Acme annual moved from Qualified to buy to Proposal sent", [ln["text"] for ln in nxt])
        eng = await self.db[T.TEAMS].find_one({"_id": ObjectId(self.eng)})
        self.assertEqual(await hubspot_deals.brief_lines(self.db, eng, "2026-W46"), [])
        # Only people who may use HubSpot see those lines of the brief (every member reads the brief itself).
        row = {"_id": ObjectId(), "workspace_id": self.W, "team_id": self.sales, "week": "2026-W46", "label": "Week",
               "lines": [{"id": "a1", "kind": "update", "text": "Shipped the deck", "sources": []},
                         {"id": "a2", "kind": "pipeline", "text": nxt[0]["text"], "sources": []}]}
        await self.db[T.BRIEFS].insert_one(row)
        for who, see in (("wm", True), ("wa", True), ("wv", False)):
            role = await self.db["memberships"].find_one({"workspace_id": self.W, "user_id": self.uid[who]})
            view = await T.load_view(self.db, self.W, self.uid[who], (role or {}).get("role"))
            actor = access.Actor.of(await get_user_by_id(self.db, self.uid[who]))
            out = await team_briefs.brief_out(self.db, actor, access.Ctx(self.db), view, row, {})
            self.assertEqual(any(ln["kind"] == "pipeline" for ln in out["lines"]), see, who)
        srcs = await ask_markdrop._brief_sources(self.db, self.W, 0)
        self.assertNotIn("moved", json.dumps([s.text for s in srcs]))
        # Ask: the pipeline for a question about deals, only for the HubSpot team.
        q = "Which proposal-stage deals had no call in two weeks?"
        mine = await hubspot_deals.ask_sources(self.db, self.uid["wm"], q, [self.W])
        self.assertEqual(len(mine), 1)
        self.assertIn("Globex rollout", mine[0]["text"])
        self.assertIn("at risk", mine[0]["text"])
        self.assertEqual(await hubspot_deals.ask_sources(self.db, self.uid["wv"], q, [self.W]), [])
        self.assertEqual(await hubspot_deals.ask_sources(self.db, self.uid["wm"], "What did Ravi ship?", [self.W]), [])
        self.assertTrue(await hubspot_deals.may_see_pipeline(self.db, self.W, self.uid["wm"]))
        self.assertFalse(await hubspot_deals.may_see_pipeline(self.db, self.W, self.uid["wv"]))
        _ = quiet, co


class MCP(V2World):
    async def test_mcp_tools(self):
        _m, _c, _co, d = self.booked()
        await self.http.put("/api/v1/hubspot/settings", headers=self.session("wa"), json={"workspace_id": self.W, "deal_updates": True})   # Apply changes deals only when turned on
        mid = await self.ready_call()
        token = await self.mcp_token("wm")
        code, res = await self.mcp_call(token, "hubspot_suggestions", {"meeting": mid})
        self.assertFalse(res.get("isError"), res)
        sug = {i["field"]: i for i in res["structuredContent"]["suggestions"]}
        self.assertIn("dealstage", sug)
        code, res = await self.mcp_call(token, "hubspot_suggestions", {"meeting": mid, "action": "apply", "id": sug["dealstage"]["id"]})
        self.assertFalse(res.get("isError"), res)
        self.assertEqual(self.fh.objects["deals"][d]["properties"]["dealstage"], "proposal")
        code, res = await self.mcp_call(token, "hubspot_account", {"meeting": mid})
        self.assertTrue(res.get("isError"), res)                                  # no new account pages
        await hubspot_accounts.refresh(self.db, await hubspot.get(self.db, self.W), _co, user_id=self.uid["owner"])
        code, res = await self.mcp_call(token, "hubspot_account", {"meeting": mid})
        self.assertFalse(res.get("isError"), res)
        self.assertIn("Acme annual", res["structuredContent"]["content"])
        code, res = await self.mcp_call(token, "hubspot_pipeline", {"workspace": self.W})
        self.assertFalse(res.get("isError"), res)
        self.assertEqual([x["name"] for x in res["structuredContent"]["deals"]], ["Acme annual"])
        code, res = await self.mcp_call(token, "hubspot_notifications", {"action": "set", "precall": False})
        self.assertFalse(res["structuredContent"]["precall"])
        self.assertTrue(res["structuredContent"]["approve"])
        token = await self.mcp_token("wv")
        code, res = await self.mcp_call(token, "hubspot_pipeline", {"workspace": self.W})
        self.assertTrue(res.get("isError"), res)
        code, res = await self.mcp_call(token, "hubspot_suggestions", {"meeting": mid})
        self.assertTrue(res.get("isError"), res)
        _ = HOOK, TEAM, START
