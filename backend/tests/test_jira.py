"""Jira Cloud (services/jira*.py, routers/jira.py, mcp/jira_tools.py, the Ask hook).

Every Atlassian call goes to :class:`tests._jira_fake.FakeJira` (an httpx.MockTransport), never the
network; the model is the test fake (tests/test_pages_ai.AIEnv).

Run: cd backend && MARKDROP_TEST_MONGODB_URI=mongodb://127.0.0.1:27019 .venv/bin/python -m unittest tests.test_jira -v
"""

from __future__ import annotations

import json
import time
import unittest
from datetime import timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from tests._access_env import AccessWorld, now  # noqa: F401  (pins settings first)
from tests.test_pages_ai import AIEnv, prompt_of

from bson import ObjectId

from app.config import get_settings
from app.services import ai_usage, jira, jira_api, jira_links, jira_team
from app.utils import crypto
from tests._jira_fake import API, AUTH, CLOUD, FakeJira, today_plus

settings = get_settings()
FERNET = "8Kq0Qb3oQ1n3yYbqQh1w8sV9t6rXo5Wm2Zc4Jd7Lp0E="
SECRET = "atlassian-client-secret-xyz"
_SAVED = ("atlassian_client_id", "atlassian_client_secret", "atlassian_auth_base", "atlassian_api_base",
          "token_encryption_key", "frontend_url", "api_base_url", "jira_ai_enabled", "jira_ai_daily_usd",
          "jira_ai_monthly_usd")

MEETING = """---
icon: 🎙️
---
:::note[Summary]{{icon="✨"}}
We planned the payments launch.
:::

## Decisions

- Ship the new checkout on Friday [00:12](/{t}#b-t0002)

## Action items

- [ ] :person[WM]{{id="{wm}"}} Migrate the billing webhooks to v2 · due 2026-12-01 [00:42](/{t}#b-t0004) {{#b-act1}}
- [ ] :person[WA]{{id="{wa}"}} Write the rollout runbook {{#b-act2}}
- [x] Book the launch room {{#b-act3}}

## Open questions

- Who signs off the pricing page?
"""


class JiraWorld(AccessWorld, AIEnv):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self._saved_j = {k: getattr(settings, k) for k in _SAVED}
        settings.atlassian_client_id = "client-123"
        settings.atlassian_client_secret = SECRET
        settings.atlassian_auth_base = AUTH
        settings.atlassian_api_base = API
        settings.token_encryption_key = FERNET
        settings.frontend_url = "https://markdrop.in"
        settings.api_base_url = "https://api.markdrop.in"
        settings.jira_ai_enabled, settings.jira_ai_daily_usd, settings.jira_ai_monthly_usd = True, 1.0, 10.0
        crypto._fernet.cache_clear()
        await jira.ensure_indexes(self.db)
        await ai_usage.ensure_indexes(self.db)
        self.setup_ai()
        self.addCleanup(self.restore_ai)
        self.fj = FakeJira()
        self._transport = jira_api.TRANSPORT
        jira_api.TRANSPORT = self.fj.transport()
        self.W = self.ws["W1"]
        # Jira people: the admin (wa), a member (wm), the owner (wo); "wv" has an account that can't see PAY.
        for who in ("wa", "wm", "wo"):
            self.fj.add_account(f"acc-{who}", who.upper(), self.email[who])
        self.fj.add_account("acc-wv", "WV", self.email["wv"], projects={"WEB"})
        self.fj.add_account("acc-ext", "Outsider", "ext@elsewhere.test")
        self.fake.script = lambda kw: json.dumps({
            "summary": "Migrate billing webhooks to v2", "description": "Move every billing webhook to the v2 API.",
            "issue_type": "Task", "priority": "High", "assignee": "WM", "due": "2026-12-01", "labels": ["billing"]})

    async def asyncTearDown(self):
        await jira.drain()
        jira_api.TRANSPORT = self._transport
        for k, v in self._saved_j.items():
            setattr(settings, k, v)
        crypto._fernet.cache_clear()
        jira._locks.clear()
        await super().asyncTearDown()

    # ── Helpers ──

    async def connect(self, who: str, kind: str = "me", ws: str | None = None) -> dict:
        r = await self.http.post("/api/v1/jira/connect/start", json={"kind": kind, "workspace_id": ws},
                                 headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        q = parse_qs(urlsplit(r.json()["url"]).query)
        r = await self.http.post("/api/v1/jira/connect/finish", json={"code": f"code-acc-{who}", "state": q["state"][0]},
                                 headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def connect_site(self, projects=("PAY",), default="PAY") -> dict:
        await self.connect("wa", "site", self.W)
        r = await self.http.put("/api/v1/jira/site", json={"workspace_id": self.W, "cloud_id": CLOUD, "projects": list(projects),
                                                          "default_project": default, "default_issue_type": "Task"},
                                headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        await jira.drain()
        return r.json()

    async def meeting(self, *, level: str = "workspace") -> dict:
        t = await self.mkdoc("W", owner="wo", grants=False, slug="standup-transcript", content="**00:42 · WM** Migrate it {#b-t0004}",
                             editor="blocks")
        mid = (await self.db["meetings"].insert_one({"workspace_id": self.W, "title": "Payments standup", "date": "2026-11-05",
                                                     "transcript_slug": t["slug"], "transcript_doc_id": str(t["_id"]),
                                                     "created_at": now()})).inserted_id
        body = MEETING.format(t=t["slug"], wm=self.uid["wm"], wa=self.uid["wa"])
        doc = await self.mkdoc("W", owner="wo", grants=False, slug="standup", content=body, editor="blocks",
                               meeting_id=str(mid), meeting_role="page", access_level=level)
        await self.db["meetings"].update_one({"_id": mid}, {"$set": {"doc_id": str(doc["_id"])}})
        return doc

    async def create(self, who: str, block: str = "b-act1", **fields) -> dict:
        f = {"project": "PAY", "summary": "Migrate billing webhooks to v2", "issue_type": "Task", "description": "Do it."}
        f.update(fields)
        r = await self.http.post("/api/v1/jira/issues", json={"slug": "standup", "block": block, "fields": f},
                                 headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def save(self, who: str, slug: str, content: str) -> None:
        d = await self.doc(slug)
        r = await self.http.put(f"/api/v1/documents/{slug}", json={"title": d["title"], "content": content,
                                                                    "base_rev": d.get("rev", 1)},
                                headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        await jira.drain()

    async def hook(self, payload: dict, *, token: str | None = None, ws: str | None = None):
        tok = token if token is not None else FakeJira.jwt(SECRET)
        return await self.http.post(f"/api/v1/jira/webhook/{ws or self.W}", content=json.dumps(payload).encode(),
                                    headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"})


# ── Connecting ────────────────────────────────────────────────────────────────


class Connect(JiraWorld):
    async def test_state_is_signed_bound_and_used_once(self):
        r = await self.http.post("/api/v1/jira/connect/start", json={"kind": "site", "workspace_id": self.W},
                                 headers=self.session("wm"))
        self.assertEqual(r.status_code, 403)       # only admins connect the site
        r = await self.http.post("/api/v1/jira/connect/start", json={"kind": "me"}, headers=self.session("wm"))
        url = r.json()["url"]
        q = parse_qs(urlsplit(url).query)
        self.assertTrue(url.startswith(AUTH + "/authorize?"))
        self.assertEqual(q["audience"], ["api.atlassian.com"])
        self.assertEqual(q["prompt"], ["consent"])
        self.assertEqual(q["redirect_uri"], ["https://markdrop.in/integrations/jira/callback"])
        self.assertEqual(set(q["scope"][0].split()), set(jira.SCOPES))
        self.assertIn("offline_access", q["scope"][0])
        state = q["state"][0]
        # Someone else can't finish it; a forged state is refused; it works once.
        r = await self.http.post("/api/v1/jira/connect/finish", json={"code": "code-acc-wm", "state": state},
                                 headers=self.session("wa"))
        self.assertEqual(r.status_code, 400)
        r = await self.http.post("/api/v1/jira/connect/finish", json={"code": "code-acc-wm", "state": state[:-2] + "xx"},
                                 headers=self.session("wm"))
        self.assertEqual(r.status_code, 400)
        r = await self.http.post("/api/v1/jira/connect/finish", json={"code": "code-acc-wm", "state": state},
                                 headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["account"]["account_id"], "acc-wm")
        r = await self.http.post("/api/v1/jira/connect/finish", json={"code": "code-acc-wm", "state": state},
                                 headers=self.session("wm"))
        self.assertEqual(r.status_code, 400)
        self.assertIn("already used", r.json()["detail"])
        # An old state (over 15 minutes) is refused.
        old = jira.sign_state("me", self.uid["wm"], None, at=time.time() - 16 * 60)
        self.assertIsNone(jira.read_state(old, self.uid["wm"]))

    async def test_tokens_are_encrypted_at_rest(self):
        await self.connect("wm")
        row = await self.db["jira_accounts"].find_one({"_id": self.uid["wm"]})
        blob = json.dumps(row, default=str)
        self.assertNotIn("at-acc-wm", blob)
        self.assertNotIn("rt-acc-wm", blob)
        self.assertTrue(crypto.decrypt(row["access_enc"]).startswith("at-acc-wm"))
        self.assertTrue(crypto.decrypt(row["refresh_enc"]).startswith("rt-acc-wm"))
        self.assertEqual(row["sites"][0]["id"], CLOUD)

    async def test_refresh_tokens_rotate_and_a_spent_one_breaks_the_connection(self):
        await self.connect("wm")
        first_rt = crypto.decrypt((await self.db["jira_accounts"].find_one({"_id": self.uid["wm"]}))["refresh_enc"])
        await self.db["jira_accounts"].update_one({"_id": self.uid["wm"]}, {"$set": {"expires_at": now() - timedelta(minutes=1)}})
        tok = await jira.access_token(self.db, self.uid["wm"], CLOUD)
        row = await self.db["jira_accounts"].find_one({"_id": self.uid["wm"]})
        second_rt = crypto.decrypt(row["refresh_enc"])
        self.assertNotEqual(first_rt, second_rt)            # rotated, and the new one is stored
        self.assertEqual(crypto.decrypt(row["access_enc"]), tok)
        self.assertIn(first_rt, self.fj.spent)
        # Two refreshes at once: one call to Atlassian (the second waits and reads the stored token).
        await self.db["jira_accounts"].update_one({"_id": self.uid["wm"]}, {"$set": {"expires_at": now()}})
        import asyncio

        n0 = len(self.fj.of("POST", "/oauth/token"))
        a, b = await asyncio.gather(jira.access_token(self.db, self.uid["wm"]), jira.access_token(self.db, self.uid["wm"]))
        self.assertEqual(a, b)
        self.assertEqual(len(self.fj.of("POST", "/oauth/token")) - n0, 1)
        # A refresh token Atlassian refuses (reused / revoked): the connection is marked broken.
        row = await self.db["jira_accounts"].find_one({"_id": self.uid["wm"]})
        await self.db["jira_accounts"].update_one({"_id": self.uid["wm"]}, {"$set": {
            "expires_at": now(), "refresh_enc": crypto.encrypt(first_rt)}})
        with self.assertRaises(jira.NotConnected) as ctx:
            await jira.access_token(self.db, self.uid["wm"])
        self.assertEqual(ctx.exception.why, "broken")
        r = await self.http.get("/api/v1/jira/me", headers=self.session("wm"))
        self.assertTrue(r.json()["broken"])

    async def test_admin_connects_the_site_and_a_webhook_is_registered(self):
        st = await self.connect_site(projects=("PAY", "WEB"), default="PAY")
        self.assertEqual(st["site"]["name"], "Acme Jira")
        self.assertEqual(st["site"]["projects"], ["PAY", "WEB"])
        self.assertEqual(st["site"]["default_project"], "PAY")
        hooks = list(self.fj.webhooks.values())
        self.assertEqual(len(hooks), 1)
        self.assertEqual(hooks[0]["url"], f"https://api.markdrop.in/api/v1/jira/webhook/{self.W}")
        self.assertEqual(hooks[0]["jql"], 'project in ("PAY", "WEB")')
        self.assertEqual(set(hooks[0]["events"]), set(jira.WEBHOOK_EVENTS))
        st = (await self.http.get(f"/api/v1/jira/status?workspace_id={self.W}", headers=self.session("wa"))).json()
        self.assertTrue(st["site"]["webhook"]["ok"])
        self.assertTrue(st["me"]["reaches_site"])
        # Members see it; non-members don't; members can't change it.
        r = await self.http.get(f"/api/v1/jira/status?workspace_id={self.W}", headers=self.session("stranger"))
        self.assertEqual(r.status_code, 404)
        r = await self.http.put("/api/v1/jira/site", json={"workspace_id": self.W, "cloud_id": CLOUD, "projects": ["PAY"],
                                                          "default_project": "PAY"}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 403)
        # A project the admin can't see in Jira can't be chosen; no Team project is allowed (the board prompts).
        r = await self.http.put("/api/v1/jira/site", json={"workspace_id": self.W, "cloud_id": CLOUD, "projects": [],
                                                          "default_project": "NOPE"}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 422)
        r = await self.http.put("/api/v1/jira/site", json={"workspace_id": self.W, "cloud_id": CLOUD, "projects": [],
                                                          "default_project": "WEB"}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["site"]["projects"], [])
        await jira.drain()
        self.assertEqual([h["jql"] for h in self.fj.webhooks.values()], ['project in ("WEB")'])   # old one removed
        # Disconnect removes the webhook.
        r = await self.http.delete(f"/api/v1/jira/site?workspace_id={self.W}", headers=self.session("wa"))
        self.assertIsNone(r.json()["site"])
        self.assertEqual(self.fj.webhooks, {})

    async def test_webhook_refresh_extends_and_reregisters(self):
        await self.connect_site()
        await self.db["jira_sites"].update_one({"_id": self.W}, {"$set": {"webhook.expires_at": now() + timedelta(days=2)}})
        self.assertEqual(await jira.refresh_webhooks(self.db), 1)
        self.assertEqual(len(self.fj.of("PUT", "webhook/refresh")), 1)
        row = await self.db["jira_sites"].find_one({"_id": self.W})
        self.assertGreater(row["webhook"]["expires_at"].replace(tzinfo=None), (now() + timedelta(days=20)).replace(tzinfo=None))

    def test_two_keys_switch_it_on(self):
        import tempfile

        from app.config import Settings

        with tempfile.TemporaryDirectory() as d:
            env = Path(d) / ".env"
            env.write_text("MARKDROP_TOKEN_ENCRYPTION_KEY=" + FERNET + "\n")
            self.assertFalse(Settings(_env_file=env).jira_configured)
            env.write_text(env.read_text() + "MARKDROP_ATLASSIAN_CLIENT_ID=abc\n")
            self.assertFalse(Settings(_env_file=env).jira_configured)
            env.write_text(env.read_text() + "MARKDROP_ATLASSIAN_CLIENT_SECRET=def\n")
            s = Settings(_env_file=env)
            self.assertTrue(s.jira_configured)
            self.assertEqual((s.jira_ai_daily_usd, s.jira_ai_monthly_usd), (1.0, 10.0))


# ── Drafts and create ─────────────────────────────────────────────────────────


class Create(JiraWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.connect_site()
        await self.meeting()

    async def test_draft_reads_only_the_item_and_matches_the_assignee(self):
        r = await self.http.post("/api/v1/jira/draft", json={"slug": "standup", "block": "b-act1"}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 409)                    # wm hasn't connected their own account
        self.assertIn("Connect your Atlassian account", r.json()["detail"])
        await self.connect("wm")
        r = await self.http.post("/api/v1/jira/draft", json={"slug": "standup", "block": "b-act1"}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertTrue(d["ai"])
        self.assertEqual(d["draft"]["summary"], "Migrate billing webhooks to v2")
        self.assertEqual(d["draft"]["priority"], "High")
        self.assertEqual(d["draft"]["labels"], ["billing"])
        self.assertEqual(d["draft"]["due"], "2026-12-01")
        self.assertEqual(d["draft"]["assignee"]["user_id"], self.uid["wm"])   # the :person mention
        self.assertEqual(d["draft"]["assignee"]["account_id"], "acc-wm")
        self.assertEqual(d["source"]["kind"], "action_item")
        self.assertEqual(d["source"]["moment"]["url"], "https://markdrop.in/standup-transcript#b-t0004")
        self.assertEqual(d["meta"]["backlink"], "From Payments standup · Nov 5, 2026 at 00:42")
        self.assertIsNone(d["notice"])
        prompt = prompt_of(self.fake.calls[-1])
        self.assertIn("Migrate the billing webhooks to v2", prompt)
        self.assertNotIn("Write the rollout runbook", prompt)     # only the item, never the rest
        self.assertNotIn("Who signs off", prompt)
        rows = await self.db["ai_requests"].find({"feature": "jira_ai"}).to_list(10)
        self.assertEqual([r["outcome"] for r in rows], ["ok"])
        # The decision's kind comes from its section; an open question without a block id by its offset.
        page = (await self.doc("standup"))["content"]
        body = page.split("---\n", 2)[2]
        off = body.index("- Who signs off")
        r = await self.http.post("/api/v1/jira/draft", json={"slug": "standup", "offset": off}, headers=self.session("wm"))
        self.assertEqual(r.json()["source"]["kind"], "open_question")
        self.assertIsNone(r.json()["source"]["block"])

    async def test_a_model_suggesting_anything_outside_the_lists_is_cleaned(self):
        await self.connect("wm")
        self.fake.script = lambda kw: json.dumps({"summary": "x" * 400, "description": "d", "issue_type": "Epic",
                                                  "priority": "Urgent!!", "assignee": "Somebody Else", "due": "soon",
                                                  "labels": ["Billing Team", "a/b"]})
        d = (await self.http.post("/api/v1/jira/draft", json={"slug": "standup", "block": "b-act2"},
                                  headers=self.session("wm"))).json()["draft"]
        self.assertEqual(len(d["summary"]), 255)
        self.assertEqual(d["issue_type"], "Task")
        self.assertIsNone(d["priority"])
        self.assertEqual(d["assignee"]["user_id"], self.uid["wa"])   # the item's own mention wins
        self.assertIsNone(d["due"])
        self.assertEqual(d["labels"], ["billing-team", "a-b"])

    async def test_cap_reached_gives_a_plain_draft(self):
        await self.connect("wm")
        settings.jira_ai_daily_usd = 0.0
        ai_usage.invalidate_settings()
        d = (await self.http.post("/api/v1/jira/draft", json={"slug": "standup", "block": "b-act1"},
                                  headers=self.session("wm"))).json()
        self.assertFalse(d["ai"])
        self.assertIn("budget", d["note"])
        self.assertTrue(d["draft"]["summary"].startswith("WM Migrate the billing webhooks"))
        self.assertEqual(self.fake.calls, [])

    async def test_create_as_the_person_with_the_link_back(self):
        await self.connect("wm")
        out = await self.create("wm", priority="High", assignee_user_id=self.uid["wm"], due="2026-12-01", labels=["billing"])
        key = out["key"]
        self.assertEqual(key, "PAY-1")
        it = self.fj.issues[key]["fields"]
        self.assertEqual(it["reporter"]["accountId"], "acc-wm")          # created as them
        self.assertEqual(it["assignee"]["accountId"], "acc-wm")
        self.assertEqual(it["duedate"], "2026-12-01")
        adf = it["description"]
        self.assertEqual(adf["type"], "doc")
        quote = adf["content"][1]
        self.assertEqual(quote["type"], "blockquote")
        self.assertIn("Migrate the billing webhooks to v2", quote["content"][0]["content"][0]["text"])
        back = adf["content"][-1]["content"][0]
        self.assertEqual(back["text"], "From Payments standup · Nov 5, 2026 at 00:42")
        self.assertEqual(back["marks"][0]["attrs"]["href"], "https://markdrop.in/standup-transcript#b-t0004")
        self.assertEqual(out["link"]["issue"]["status"]["category"], "new")
        # The item is linked: a second issue for it is refused.
        r = await self.http.post("/api/v1/jira/issues", json={"slug": "standup", "block": "b-act1",
                                                              "fields": {"project": "PAY", "summary": "again"}},
                                 headers=self.session("wm"))
        self.assertEqual(r.status_code, 409)

    async def test_chips_only_for_viewers_who_can_open_the_issue(self):
        await self.connect("wm")
        await self.create("wm")
        r = (await self.http.get("/api/v1/jira/page?slug=standup", headers=self.session("wm"))).json()
        chip = r["links"]["b-act1"]
        self.assertEqual((chip["key"], chip["issue"]["status"]["name"], chip["issue"]["assignee"]), ("PAY-1", "To Do", None))
        # Not connected: the key only, no summary or status.
        r = (await self.http.get("/api/v1/jira/page?slug=standup", headers=self.session("wo"))).json()
        self.assertIsNone(r["links"]["b-act1"]["issue"])
        self.assertEqual(r["links"]["b-act1"]["key"], "PAY-1")
        self.assertFalse(r["connected"])
        # Connected, but their Jira account can't see PAY: still the key only.
        await self.connect("wv")
        r = (await self.http.get("/api/v1/jira/page?slug=standup", headers=self.session("wv"))).json()
        self.assertTrue(r["connected"])
        self.assertIsNone(r["links"]["b-act1"]["issue"])
        # Someone who can't read the page: 404.
        r = await self.http.get("/api/v1/jira/page?slug=standup", headers=self.session("stranger"))
        self.assertEqual(r.status_code, 404)

    async def test_restricted_meeting(self):
        await self.db["documents"].update_one({"slug": "standup"}, {"$set": {"access_level": "private"}})
        await self.db["document_grants"].insert_one({"document_id": str((await self.doc("standup"))["_id"]),
                                                     "email": self.email["wm"], "role": "editor", "created_at": now()})
        await self.connect("wm")
        await self.connect("wo")
        d = (await self.http.post("/api/v1/jira/draft", json={"slug": "standup", "block": "b-act1"},
                                  headers=self.session("wm"))).json()
        self.assertIn("restricted", d["notice"])
        # A member it isn't shared with can't draft from it, and gets the same 404 as for a missing page.
        await self.connect("wa")
        r = await self.http.post("/api/v1/jira/draft", json={"slug": "standup", "block": "b-act1"}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 404)
        r = await self.http.post("/api/v1/jira/issues", json={"slug": "standup", "block": "b-act1",
                                                              "fields": {"project": "PAY", "summary": "x"}}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 404)

    async def test_an_item_without_a_block_id_gets_one(self):
        await self.connect("wm")
        body = (await self.doc("standup"))["content"].split("---\n", 2)[2]
        off = body.index("- Who signs off")
        r = await self.http.post("/api/v1/jira/issues", json={"slug": "standup", "offset": off,
                                                              "fields": {"project": "PAY", "summary": "Decide pricing sign-off"}},
                                 headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        bid = r.json()["link"]["block"]
        self.assertRegex(bid, r"^b-[0-9a-f]{8}$")
        self.assertIn(f"Who signs off the pricing page? {{#{bid}}}", (await self.doc("standup"))["content"])

    async def test_selection_creates_without_linking(self):
        await self.connect("wm")
        r = await self.http.post("/api/v1/jira/issues", json={"slug": "standup", "selection": "We planned the payments launch.",
                                                              "fields": {"project": "PAY", "summary": "Plan launch"}},
                                 headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIsNone(r.json()["link"])
        self.assertEqual(self.fj.issues["PAY-1"]["fields"]["description"]["content"][-1]["content"][0]["text"],
                         "From Payments standup · Nov 5, 2026")

    async def test_bulk_drafts_open_action_items_only(self):
        await self.connect("wm")
        await self.create("wm", block="b-act2", summary="Runbook")
        self.fake.script = lambda kw: json.dumps({"drafts": [
            {"n": 1, "summary": "Migrate billing webhooks", "description": "", "issue_type": "Task", "priority": "",
             "assignee": "WM", "due": "", "labels": []}]})
        r = await self.http.post("/api/v1/jira/draft/all", json={"slug": "standup"}, headers=self.session("wm"))
        items = r.json()["items"]
        self.assertEqual([i["source"]["block"] for i in items], ["b-act1"])   # act2 linked, act3 done
        self.assertEqual(len(self.fake.calls), 1)
        r = await self.http.post("/api/v1/jira/issues/bulk", json={"slug": "standup", "items": [
            {"block": "b-act1", "fields": {"project": "PAY", "summary": "Migrate billing webhooks"}},
            {"block": "b-act2", "fields": {"project": "PAY", "summary": "dup"}}]}, headers=self.session("wm"))
        self.assertEqual([x["ok"] for x in r.json()["results"]], [True, False])


# ── Both-way sync ─────────────────────────────────────────────────────────────


class Sync(JiraWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.connect_site()
        await self.meeting()
        await self.connect("wm")
        await self.connect("wa")
        self.key = (await self.create("wm"))["key"]

    def status(self) -> str:
        return self.fj.issues[self.key]["fields"]["status"]["name"]

    async def test_ticking_closes_the_issue_and_the_webhook_echo_does_nothing(self):
        d = await self.doc("standup")
        await self.save("wa", "standup", d["content"].replace("- [ ] :person[WM]", "- [x] :person[WM]"))
        self.assertEqual(self.status(), "Done")
        posts = self.fj.of("POST", f"issue/{self.key}/transitions")
        self.assertEqual(posts, [{"transition": {"id": "31"}}])
        moved_by = [w for m, p, _b, w in self.fj.calls if m == "POST" and p.endswith("/transitions")]
        self.assertEqual(moved_by, ["acc-wa"])                     # as the person who ticked it
        rev = (await self.doc("standup"))["rev"]
        # Jira reports that very change: nothing is written to the page, no second transition.
        payload = self.fj.move(self.key, "Done", by="acc-wa")
        r = await self.hook(payload)
        self.assertEqual(r.json()["moved"], 0)
        self.assertEqual((await self.doc("standup"))["rev"], rev)
        self.assertEqual(len(self.fj.of("POST", f"issue/{self.key}/transitions")), 1)
        # Unticked: reopened to a To-do status.
        d = await self.doc("standup")
        await self.save("wa", "standup", d["content"].replace("- [x] :person[WM]", "- [ ] :person[WM]"))
        self.assertEqual(self.status(), "To Do")

    async def test_done_in_jira_ticks_the_page_via_jira(self):
        payload = self.fj.move(self.key, "Done", by="acc-wa")
        r = await self.hook(payload)
        self.assertEqual(r.json()["moved"], 1)
        content = (await self.doc("standup"))["content"]
        self.assertIn("- [x] :person[WM]", content)
        # No transition was sent back.
        self.assertEqual(self.fj.of("POST", f"issue/{self.key}/transitions"), [])
        link = await self.db["jira_links"].find_one({"key": self.key})
        self.assertEqual((link["done"], link["jira_done"]), (True, True))
        # Version history says who, via Jira.
        from app.services import page_history

        rows = await self.db[page_history.COLL].find({"doc_id": str((await self.doc("standup"))["_id"])}).to_list(20)
        self.assertIn("jira", [r.get("author_kind") for r in rows])
        jira_row = next(r for r in rows if r.get("author_kind") == "jira")
        self.assertEqual(jira_row["author_id"], self.uid["wa"])
        # The same delivery again: de-duplicated.
        r = await self.hook(payload)
        self.assertTrue(r.json().get("duplicate"))
        # Reopened in Jira: unticked.
        r = await self.hook(self.fj.move(self.key, "In Progress", by="acc-wm"))
        self.assertIn("- [ ] :person[WM]", (await self.doc("standup"))["content"])

    async def test_moved_by_someone_outside_ticks_as_the_linker(self):
        r = await self.hook(self.fj.move(self.key, "Done", by="acc-ext"))
        self.assertEqual(r.json()["moved"], 1)
        rows = await self.db["document_versions"].find({"author_kind": "jira"}).to_list(5)
        self.assertEqual(rows[0]["author_id"], self.uid["wm"])

    async def test_ticker_without_a_connection_or_permission(self):
        d = await self.doc("standup")
        await self.save("wo", "standup", d["content"].replace("- [ ] :person[WM]", "- [x] :person[WM]"))
        self.assertEqual(self.status(), "To Do")
        link = await self.db["jira_links"].find_one({"key": self.key})
        self.assertEqual(link["sync"]["state"], "error")
        self.assertIn("Atlassian account connected", link["sync"]["message"])
        r = (await self.http.get("/api/v1/jira/page?slug=standup", headers=self.session("wm"))).json()
        self.assertEqual(r["links"]["b-act1"]["sync"]["state"], "error")
        # Retry from the chip, as someone who is connected.
        r = await self.http.post(f"/api/v1/jira/links/{link['_id']}/retry", headers=self.session("wm"))
        self.assertEqual(r.json()["state"], "ok")
        self.assertEqual(self.status(), "Done")
        # A Jira account without permission to move it.
        self.fj.accounts["acc-wa"]["can_transition"] = False
        d = await self.doc("standup")
        await self.save("wa", "standup", d["content"].replace("- [x] :person[WM]", "- [ ] :person[WM]"))
        link = await self.db["jira_links"].find_one({"key": self.key})
        self.assertEqual(link["sync"]["state"], "error")
        self.assertIn("can't move", link["sync"]["message"])
        self.assertEqual(self.status(), "Done")
        self.assertEqual(link["jira_done"], True)              # put back: Jira didn't change

    async def test_webhook_verification(self):
        payload = self.fj.move(self.key, "Done", by="acc-wa")
        r = await self.http.post(f"/api/v1/jira/webhook/{self.W}", content=json.dumps(payload).encode())
        self.assertEqual((r.status_code, r.json()["detail"]), (401, "unsigned"))
        r = await self.hook(payload, token=FakeJira.jwt("another-secret"))
        self.assertEqual((r.status_code, r.json()["detail"]), (401, "bad_signature"))
        r = await self.hook(payload, token=FakeJira.jwt(SECRET, exp_in=-600))
        self.assertEqual((r.status_code, r.json()["detail"]), (401, "expired"))
        self.assertIn("- [ ] :person[WM]", (await self.doc("standup"))["content"])
        # Another workspace's webhook id: ignored.
        r = await self.hook({**payload, "matchedWebhookIds": [99999]})
        self.assertTrue(r.json().get("ignored"))
        settings.atlassian_client_secret = ""
        r = await self.hook(payload)
        self.assertEqual(r.status_code, 503)

    async def test_deleted_in_jira(self):
        r = await self.hook({"webhookEvent": "jira:issue_deleted", "timestamp": 1, "issue": {"key": self.key, "fields": {}}})
        self.assertEqual(r.json()["deleted"], self.key)
        link = await self.db["jira_links"].find_one({"key": self.key})
        self.assertIn("deleted", link["sync"]["message"])

    async def test_someone_editing_the_page_defers_the_tick(self):
        await self.db["documents"].update_one({"slug": "standup"}, {"$set": {"edit_lock": {
            "user_id": self.uid["wo"], "name": "WO", "at": now(), "edited_at": now(), "expires_at": now() + timedelta(minutes=5)}}})
        r = await self.hook(self.fj.move(self.key, "Done", by="acc-wa"))
        self.assertEqual(r.json()["moved"], 0)
        link = await self.db["jira_links"].find_one({"key": self.key})
        self.assertEqual(link["sync"]["state"], "pending")
        await self.db["documents"].update_one({"slug": "standup"}, {"$unset": {"edit_lock": ""}})
        self.assertEqual(await jira_links.retry_pending(self.db), 1)
        self.assertIn("- [x] :person[WM]", (await self.doc("standup"))["content"])
        self.assertEqual(self.fj.of("POST", f"issue/{self.key}/transitions"), [])


# ── Team, Ask, links ──────────────────────────────────────────────────────────


class Team(JiraWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.connect_site(projects=("PAY",))
        self.fj.add_issue("PAY", "Refund flow", status="In Progress", assignee="acc-wm")
        self.fj.add_issue("PAY", "Card vault", status="To Do", assignee="acc-wm", due=today_plus(-2))
        self.fj.add_issue("PAY", "Chargebacks", status="Blocked", assignee="acc-wa")
        self.fj.add_issue("PAY", "Old thing", status="Done", assignee="acc-wa")
        self.fj.add_issue("WEB", "Landing page", status="To Do", assignee="acc-wm")   # not a Team project

    async def test_connected_viewer_sees_details_others_counts_only(self):
        await self.connect("wm")
        b = (await self.http.get(f"/api/v1/jira/team/{self.W}", headers=self.session("wm"))).json()
        self.assertEqual(b["mode"], "details")
        me = b["people"][self.uid["wm"]]
        self.assertEqual((me["counts"]["in_progress"], me["counts"]["todo"], me["counts"]["overdue"]), (1, 1, 1))
        self.assertEqual(me["top"][0]["summary"], "Card vault")             # overdue first
        self.assertNotIn("Landing page", json.dumps(b))
        self.assertEqual(b["people"][self.uid["wa"]]["counts"]["blocked"], 1)
        self.assertEqual(b["team"]["overdue_issues"][0]["key"], "PAY-2")
        # wv isn't connected: counts only — no key, summary or link anywhere.
        b = (await self.http.get(f"/api/v1/jira/team/{self.W}", headers=self.session("wv"))).json()
        self.assertEqual(b["mode"], "counts")
        dump = json.dumps(b)
        for secret in ("PAY-1", "Refund flow", "atlassian.net/browse"):
            self.assertNotIn(secret, dump)
        self.assertEqual(b["people"][self.uid["wm"]]["counts"]["todo"], 1)
        # A person's page, grouped.
        p = (await self.http.get(f"/api/v1/jira/team/{self.W}/people/{self.uid['wm']}", headers=self.session("wm"))).json()
        self.assertEqual([g["key"] for g in p["groups"]], ["overdue", "in_progress"])
        # Non-members: 404.
        r = await self.http.get(f"/api/v1/jira/team/{self.W}", headers=self.session("stranger"))
        self.assertEqual(r.status_code, 404)

    async def test_viewer_whose_jira_hides_a_project_never_sees_it(self):
        await self.connect("wv")       # acc-wv sees WEB only
        b = (await self.http.get(f"/api/v1/jira/team/{self.W}", headers=self.session("wv"))).json()
        self.assertEqual(b["mode"], "details")
        self.assertNotIn("Refund flow", json.dumps(b))
        self.assertEqual(b["team"]["todo"] + b["team"]["in_progress"], 0)

    async def test_no_team_projects_prompts(self):
        await self.db["jira_sites"].update_one({"_id": self.W}, {"$set": {"projects": []}})
        await self.connect("wm")
        b = (await self.http.get(f"/api/v1/jira/team/{self.W}", headers=self.session("wm"))).json()
        self.assertEqual(b["mode"], "no_projects")
        self.assertEqual(b["people"], {})

    async def test_webhook_keeps_cached_details_fresh(self):
        await self.connect("wm")
        await self.http.get(f"/api/v1/jira/team/{self.W}", headers=self.session("wm"))
        await self.hook(self.fj.move("PAY-1", "Done", by="acc-wm"))
        b = (await self.http.get(f"/api/v1/jira/team/{self.W}", headers=self.session("wm"))).json()
        self.assertEqual(b["people"][self.uid["wm"]]["counts"]["done_recent"], 1)

    async def test_members_matched_by_email_without_connecting(self):
        await self.connect("wm")
        got = await jira.member_accounts(self.db, self.W, CLOUD, lookup_as=self.uid["wm"])
        self.assertEqual(got[self.uid["wa"]], "acc-wa")        # found by their Markdrop email
        self.assertNotIn(self.uid["gv"], got)

    async def test_ask_reads_jira_through_the_asker_only(self):
        from app.services import access

        actor = access.Actor.of(await self._user("wm"))
        self.assertEqual(await jira_team.ask_issues(self.db, actor, "which tickets are blocked?", [self.W]), [])  # not connected
        await self.connect("wm")
        got = await jira_team.ask_issues(self.db, actor, "which tickets are blocked?", [self.W])
        self.assertEqual([i["key"] for i in got], ["PAY-3"])
        got = await jira_team.ask_issues(self.db, actor, "status of PAY-1", [self.W])
        self.assertEqual([i["key"] for i in got], ["PAY-1"])
        self.assertIn("Status: In Progress (in progress)", jira_team.ask_text(got[0]))
        got = await jira_team.ask_issues(self.db, actor, "what is WA working on in jira", [self.W])
        self.assertEqual({i["key"] for i in got}, {"PAY-3"})
        self.assertEqual(await jira_team.ask_issues(self.db, actor, "what did we decide about pricing", [self.W]), [])
        # Cited issues stay readable while the asker's connection reaches the site.
        from app.services import ask_markdrop

        ok = await ask_markdrop.still_readable(self.db, actor, access.Ctx(self.db), [f"j:{CLOUD}:PAY-1"])
        self.assertEqual(ok, {f"j:{CLOUD}:PAY-1"})
        await jira.disconnect_me(self.db, await self._user("wm"))
        ok = await ask_markdrop.still_readable(self.db, actor, access.Ctx(self.db), [f"j:{CLOUD}:PAY-1"])
        self.assertEqual(ok, set())

    async def _user(self, who: str):
        from app.services.user import get_user_by_id

        return await get_user_by_id(self.db, self.uid[who])

    async def test_pasted_links_render_for_viewers_who_can_open_them(self):
        await self.connect("wm")
        await self.connect("wv")
        urls = ["https://acme.atlassian.net/browse/PAY-1", "https://acme.atlassian.net/browse/WEB-1",
                "https://evil.example/browse/PAY-1"]
        r = (await self.http.post("/api/v1/jira/lookup", json={"urls": urls}, headers=self.session("wm"))).json()
        self.assertEqual(set(r["issues"]), set(urls[:2]))
        self.assertEqual(r["issues"][urls[0]]["summary"], "Refund flow")
        r = (await self.http.post("/api/v1/jira/lookup", json={"urls": urls}, headers=self.session("wv"))).json()
        self.assertEqual(set(r["issues"]), {urls[1]})
        r = (await self.http.post("/api/v1/jira/lookup", json={"urls": urls}, headers=self.session("wo"))).json()
        self.assertEqual(r, {"connected": False, "issues": {}})


# ── MCP ───────────────────────────────────────────────────────────────────────


class Mcp(JiraWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.connect_site()
        await self.meeting()

    async def call(self, who: str, name: str, args: dict, *, write: bool = True) -> dict:
        status, res = await self.mcp_call(await self.mcp_token(who, write=write), name, args)
        self.assertEqual(status, 200, name)
        return res

    async def test_status_draft_create_link_list_transition(self):
        res = await self.call("wm", "jira_status", {"workspace": self.W}, write=False)
        self.assertFalse(res["isError"])
        self.assertTrue(res["structuredContent"]["connected"])
        self.assertFalse(res["structuredContent"]["me"]["connected"])
        self.assertIn("isn't connected", res["content"][0]["text"])
        res = await self.call("wm", "create_jira_issue", {"page": "standup", "item": "billing webhooks"})
        self.assertTrue(res["isError"])
        self.assertIn("Connect your Atlassian account", res["content"][0]["text"])
        await self.connect("wm")
        res = await self.call("wm", "create_jira_issue", {"page": "standup", "item": "billing webhooks"})
        self.assertFalse(res["isError"], res["content"][0]["text"])
        self.assertFalse(res["structuredContent"]["created"])
        self.assertEqual(self.fj.issues, {})                      # a draft creates nothing
        self.assertEqual(res["structuredContent"]["draft"]["summary"], "Migrate billing webhooks to v2")
        res = await self.call("wm", "create_jira_issue", {"page": "standup", "item": "billing webhooks", "draft": False,
                                                          "summary": "Billing webhooks v2"})
        self.assertFalse(res["isError"], res["content"][0]["text"])
        self.assertEqual(res["structuredContent"]["key"], "PAY-1")
        self.assertTrue(res["structuredContent"]["linked"])
        self.assertEqual(self.fj.issues["PAY-1"]["fields"]["summary"], "Billing webhooks v2")
        # Ambiguous words are refused with the candidates.
        res = await self.call("wm", "create_jira_issue", {"page": "standup", "item": "the"})
        self.assertTrue(res["isError"])
        # Link an existing issue to another item.
        other = self.fj.add_issue("PAY", "Runbook", assignee="acc-wa")
        res = await self.call("wm", "link_jira_issue", {"page": "standup", "item": "b-act2",
                                                        "issue": f"https://acme.atlassian.net/browse/{other}"})
        self.assertFalse(res["isError"], res["content"][0]["text"])
        res = await self.call("wm", "list_jira_issues", {"workspace": self.W, "person": "WA"}, write=False)
        self.assertEqual([i["key"] for i in res["structuredContent"]["issues"]], [other])
        # Move it in Jira as the user: the linked to-do follows.
        res = await self.call("wm", "transition_jira_issue", {"workspace": self.W, "issue": other, "to": "done"})
        self.assertFalse(res["isError"], res["content"][0]["text"])
        self.assertIn("- [x] :person[WA]", (await self.doc("standup"))["content"])
        # Someone who can't read the page can't draft from it.
        await self.connect("wo")
        res = await self.call("stranger", "create_jira_issue", {"page": "standup", "item": "billing"})
        self.assertTrue(res["isError"])


class Parsing(unittest.TestCase):
    def test_item_at_and_plain(self):
        content = "---\nicon: x\n---\n## Action items\n\n- [ ] :person[Ada]{id=\"0123456789abcdef01234567\"} Ship **it** · due Fri [00:12](/t#b-t0002) {#b-1}\n"
        it = jira_links.item_at(content, block="b-1")
        self.assertEqual(it.text, "Ada Ship it · due Fri")
        self.assertEqual(it.people, ["0123456789abcdef01234567"])
        self.assertEqual(it.moment, {"clock": "00:12", "path": "/t#b-t0002"})
        self.assertEqual((it.section, it.mark, it.due), ("Action items", " ", "Fri"))
        self.assertIs(jira_links.todo_mark(content.replace("[ ]", "[x]"), "b-1"), True)
        self.assertIsNone(jira_links.todo_mark(content, "b-2"))
        self.assertEqual(jira_links.find_item(content, "ship it")[:2], ("b-1", None))

    def test_adf(self):
        doc = jira_links.adf("One\ntwo\n\nThree", "The item", "From X", "https://markdrop.in/x#b-1")
        self.assertEqual([c["type"] for c in doc["content"]], ["paragraph", "paragraph", "blockquote", "paragraph"])
        self.assertEqual(doc["content"][0]["content"][1], {"type": "hardBreak"})

    def test_pick_transition(self):
        ts = [{"id": "1", "to": {"statusCategory": {"key": "indeterminate"}}}, {"id": "2", "to": {"statusCategory": {"key": "done"}}},
              {"id": "3", "to": {"statusCategory": {"key": "new"}}}]
        self.assertEqual(jira_links._pick(ts, True)["id"], "2")
        self.assertEqual(jira_links._pick(ts, False)["id"], "3")
        self.assertEqual(jira_links._pick(ts[:1], False)["id"], "1")
        self.assertIsNone(jira_links._pick(ts[:1], True))


if __name__ == "__main__":
    unittest.main()
