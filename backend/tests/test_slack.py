"""Markdrop for Slack (services/slack*.py, routers/slack.py).

Every Slack request is signed here the way Slack signs it; every Slack Web API call goes to
:class:`FakeSlack` (an httpx.MockTransport), never the network.

Run: cd backend && MARKDROP_TEST_MONGODB_URI=mongodb://127.0.0.1:27019 .venv/bin/python -m unittest tests.test_slack -v
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

from tests._access_env import AccessWorld, now  # noqa: F401  (pins settings first)
from tests.test_pages_ai import AIEnv, prompt_of
from tests.test_search import SearchWorld

import httpx
import yaml
from bson import ObjectId

from app.config import get_settings
from app.services import (ai_usage, notifications, search_ai, slack, slack_api, slack_events,
                          slack_notify)
from app.utils import crypto

settings = get_settings()
FERNET = "8Kq0Qb3oQ1n3yYbqQh1w8sV9t6rXo5Wm2Zc4Jd7Lp0E="
SECRET = "test-signing-secret-1234"
TEAM, TEAM2 = "T0ACME", "T0OTHER"
BOT_TOKEN = "xoxb-test-bot-token-777"
USER_TOKEN = "xoxp-oidc-user-token-999"
HOOK = "https://slack.test/hooks/respond/1"
_SAVED = ("slack_client_id", "slack_client_secret", "slack_signing_secret", "slack_api_base", "slack_web_base",
          "token_encryption_key", "frontend_url")


class FakeSlack:
    """Slack's Web API and response URLs. ``calls``: [(method, data, token)]; ``responds``: [payload]."""

    def __init__(self):
        self.calls: list[tuple[str, dict, str | None]] = []
        self.responds: list[dict] = []
        self.delay = 0.0
        self.channel_info: dict = {"id": "C1", "is_ext_shared": False, "is_shared": False}
        self.oauth_team = TEAM
        self.oidc_team = TEAM
        self.oidc_user = "U0ADA"
        self.authed_user = "U0WO"
        self.fail: dict[str, str] = {}

    async def handler(self, request: httpx.Request) -> httpx.Response:
        if self.delay:
            await asyncio.sleep(self.delay)
        path = request.url.path
        body = request.content.decode() if request.content else ""
        if path.startswith("/hooks/"):
            self.responds.append(json.loads(body))
            return httpx.Response(200, text="ok")
        method = path.rsplit("/", 1)[-1]
        if request.headers.get("content-type", "").startswith("application/json"):
            data = json.loads(body or "{}")
        else:
            data = {k: v[0] for k, v in parse_qs(body).items()}
        token = request.headers.get("authorization", "").removeprefix("Bearer ") or None
        self.calls.append((method, data, token))
        if method in self.fail:
            return httpx.Response(200, json={"ok": False, "error": self.fail[method]})
        if method == "oauth.v2.access":
            return httpx.Response(200, json={
                "ok": True, "access_token": BOT_TOKEN, "token_type": "bot", "scope": ",".join(slack.BOT_SCOPES),
                "bot_user_id": "UBOT", "app_id": "A1", "team": {"id": self.oauth_team, "name": "Acme Slack"},
                "authed_user": {"id": self.authed_user}})
        if method == "openid.connect.token":
            return httpx.Response(200, json={"ok": True, "access_token": USER_TOKEN, "token_type": "Bearer",
                                             "id_token": "x.y.z"})
        if method == "openid.connect.userInfo":
            if token != USER_TOKEN:
                return httpx.Response(200, json={"ok": False, "error": "invalid_auth"})
            return httpx.Response(200, json={"ok": True, "sub": self.oidc_user, "name": "Ada in Slack",
                                             "https://slack.com/user_id": self.oidc_user,
                                             "https://slack.com/team_id": self.oidc_team})
        if method == "conversations.info":
            return httpx.Response(200, json={"ok": True, "channel": {**self.channel_info, "id": data.get("channel")}})
        if method == "conversations.list":
            return httpx.Response(200, json={"ok": True, "channels": [
                {"id": "C1", "name": "general", "is_private": False},
                {"id": "C2", "name": "meetings", "is_private": False},
                {"id": "G1", "name": "secret", "is_private": True, "is_member": False},
                {"id": "G2", "name": "leads", "is_private": True, "is_member": True}]})
        if method == "chat.postMessage":
            return httpx.Response(200, json={"ok": True, "channel": data.get("channel"), "ts": f"{len(self.calls)}.0001"})
        return httpx.Response(200, json={"ok": True})

    def of(self, method: str) -> list[dict]:
        return [d for m, d, _t in self.calls if m == method]


def sign(body: bytes, ts: int | None = None, secret: str = SECRET) -> dict:
    ts = int(time.time()) if ts is None else ts
    return {"X-Slack-Request-Timestamp": str(ts), "X-Slack-Signature": slack.signature_for(body, str(ts), secret)}


class SlackWorld(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self._saved_s = {k: getattr(settings, k) for k in _SAVED}
        settings.slack_client_id = "111.222"
        settings.slack_client_secret = "client-secret"
        settings.slack_signing_secret = SECRET
        settings.slack_api_base = "https://slack.test/api"
        settings.slack_web_base = "https://slack.test"
        settings.token_encryption_key = FERNET
        settings.frontend_url = "https://markdrop.in"
        crypto._fernet.cache_clear()
        await slack.ensure_indexes(self.db)
        await slack_notify.ensure_indexes(self.db)
        self.sk = FakeSlack()
        self._transport = slack_api.TRANSPORT
        slack_api.TRANSPORT = httpx.MockTransport(self.sk.handler)
        self.W = self.ws["W1"]

    async def asyncTearDown(self):
        await slack.drain()
        slack_api.TRANSPORT = self._transport
        for k, v in self._saved_s.items():
            setattr(settings, k, v)
        crypto._fernet.cache_clear()
        await super().asyncTearDown()

    # ── Helpers ──

    async def install(self, who: str = "wo", ws: str | None = None) -> dict:
        ws = ws or self.W
        r = await self.http.post("/api/v1/slack/install", json={"workspace_id": ws}, headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        state = parse_qs(urlsplit(r.json()["url"]).query)["state"][0]
        r = await self.http.post("/api/v1/slack/connect", json={"code": "c-1", "state": state}, headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def link(self, who: str, slack_user: str, team: str = TEAM) -> None:
        await slack.save_link(self.db, team, slack_user, self.uid[who], who)

    async def post_signed(self, path: str, body: bytes, *, ctype: str, headers: dict | None = None) -> httpx.Response:
        return await self.http.post(path, content=body, headers={"Content-Type": ctype,
                                                                 **(headers if headers is not None else sign(body))})

    async def command(self, text: str, slack_user: str = "U0WM", team: str = TEAM) -> httpx.Response:
        body = urlencode({"team_id": team, "user_id": slack_user, "command": "/markdrop", "text": text,
                          "response_url": HOOK, "channel_id": "C1", "trigger_id": str(time.time_ns())}).encode()
        return await self.post_signed("/api/v1/slack/commands", body, ctype="application/x-www-form-urlencoded")

    async def click(self, action_id: str, value: str, slack_user: str, team: str = TEAM) -> httpx.Response:
        payload = {"type": "block_actions", "team": {"id": team}, "user": {"id": slack_user},
                   "actions": [{"action_id": action_id, "value": value, "action_ts": str(time.time_ns())}],
                   "response_url": HOOK,
                   "container": {"channel_id": "C2", "message_ts": "9.0001"}}
        body = urlencode({"payload": json.dumps(payload)}).encode()
        return await self.post_signed("/api/v1/slack/interactivity", body, ctype="application/x-www-form-urlencoded")

    async def event(self, ev: dict, *, event_id: str = "Ev1", team: str = TEAM, ts: int | None = None) -> httpx.Response:
        body = json.dumps({"type": "event_callback", "team_id": team, "event_id": event_id, "event": ev}).encode()
        return await self.post_signed("/api/v1/slack/events", body, ctype="application/json", headers=sign(body, ts))


# ── Verification, replay, ack ─────────────────────────────────────────────────


class Verification(SlackWorld):
    async def test_signature_window_and_replay(self):
        body = json.dumps({"type": "url_verification", "challenge": "abc"}).encode()
        r = await self.post_signed("/api/v1/slack/events", body, ctype="application/json", headers={})
        self.assertEqual(r.status_code, 401)
        r = await self.post_signed("/api/v1/slack/events", body, ctype="application/json",
                                   headers=sign(body, secret="wrong-secret"))
        self.assertEqual((r.status_code, r.json()["detail"]), (401, "bad_signature"))
        r = await self.post_signed("/api/v1/slack/events", body, ctype="application/json",
                                   headers=sign(body, ts=int(time.time()) - 400))
        self.assertEqual((r.status_code, r.json()["detail"]), (401, "stale"))
        # A body changed after signing.
        h = sign(body)
        r = await self.post_signed("/api/v1/slack/events", body.replace(b"abc", b"abd"), ctype="application/json", headers=h)
        self.assertEqual(r.status_code, 401)
        h = sign(body)
        r = await self.post_signed("/api/v1/slack/events", body, ctype="application/json", headers=h)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"challenge": "abc"})
        # The exact same request again (a replay inside the 5-minute window).
        r = await self.post_signed("/api/v1/slack/events", body, ctype="application/json", headers=h)
        self.assertEqual((r.status_code, r.json()["detail"]), (401, "replay"))

    async def test_not_configured_is_503(self):
        settings.slack_signing_secret = ""
        body = b"{}"
        r = await self.post_signed("/api/v1/slack/events", body, ctype="application/json")
        self.assertEqual(r.status_code, 503)
        r = await self.command("help")
        self.assertEqual(r.status_code, 503)

    async def test_event_retries_are_acked_once(self):
        await self.install()
        doc = await self.mkdoc("L", grants=False)
        ev = {"type": "link_shared", "channel": "C1", "message_ts": "1.1",
              "links": [{"url": f"https://markdrop.in/{doc['slug']}", "domain": "markdrop.in"}]}
        r = await self.event(ev, event_id="EvRetry")
        self.assertEqual(r.json(), {"ok": True})
        await slack.drain()
        r = await self.event(ev, event_id="EvRetry", ts=int(time.time()) + 1)   # Slack's retry: new timestamp, signature
        self.assertEqual(r.json().get("duplicate"), True)
        await slack.drain()
        self.assertEqual(len(self.sk.of("chat.unfurl")), 1)

    async def test_ack_within_three_seconds_even_when_slack_is_slow(self):
        await self.install()
        await self.link("wm", "U0WM")
        self.sk.delay = 2.5
        t0 = time.monotonic()
        r = await self.command("search onboarding")
        took = time.monotonic() - t0
        self.assertEqual(r.status_code, 200)
        self.assertLess(took, 1.0, f"ack took {took:.2f}s")
        self.assertIn("Searching", r.json()["text"])
        self.assertEqual(self.sk.responds, [])
        await slack.drain()
        self.assertEqual(len(self.sk.responds), 1)
        # Events too: the unfurl work is after the 200.
        doc = await self.mkdoc("L", grants=False)
        t0 = time.monotonic()
        r = await self.event({"type": "link_shared", "channel": "C1", "message_ts": "1.2",
                              "links": [{"url": f"https://markdrop.in/{doc['slug']}"}]}, event_id="EvSlow")
        self.assertLess(time.monotonic() - t0, 1.0)
        await slack.drain()

    def test_signed_values(self):
        settings.slack_client_secret = "client-secret"
        v = slack.sign_value(TEAM, "done", "abc", "b-1234")
        self.assertEqual(slack.read_value(TEAM, v), ["done", "abc", "b-1234"])
        self.assertIsNone(slack.read_value(TEAM2, v))                       # another team's button
        self.assertIsNone(slack.read_value(TEAM, v.replace("b-1234", "b-9999")))
        self.assertIsNone(slack.read_value(TEAM, "done|abc|b-1234|AAAAAAAAAAAAAAAA"))
        self.assertIsNone(slack.read_value(TEAM, None))

    def test_manifest_matches_the_code(self):
        path = Path(__file__).resolve().parents[2] / "docs-platform" / "slack" / "manifest.yaml"
        m = yaml.safe_load(path.read_text())
        self.assertEqual(tuple(m["oauth_config"]["scopes"]["bot"]), slack.BOT_SCOPES)
        self.assertEqual(tuple(m["oauth_config"]["scopes"]["user"]), slack.USER_SCOPES)
        self.assertEqual(m["settings"]["event_subscriptions"]["request_url"], "https://api.markdrop.in/api/v1/slack/events")
        self.assertEqual(m["settings"]["interactivity"]["request_url"], "https://api.markdrop.in/api/v1/slack/interactivity")
        self.assertEqual(m["features"]["slash_commands"][0]["url"], "https://api.markdrop.in/api/v1/slack/commands")
        self.assertEqual(set(m["settings"]["event_subscriptions"]["bot_events"]),
                         {"link_shared", "app_uninstalled", "tokens_revoked"})
        self.assertIn("https://www.markdrop.in/integrations/slack/callback", m["oauth_config"]["redirect_urls"])
        self.assertNotRegex(path.read_text(), r"xox[abp]-|[0-9a-f]{32}")


# ── Install and links ─────────────────────────────────────────────────────────


class Install(SlackWorld):
    async def test_admins_install_and_the_token_is_encrypted(self):
        r = await self.http.post("/api/v1/slack/install", json={"workspace_id": self.W}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 403)
        r = await self.http.post("/api/v1/slack/install", json={"workspace_id": self.W}, headers=self.session("stranger"))
        self.assertEqual(r.status_code, 404)
        r = await self.http.post("/api/v1/slack/install", json={"workspace_id": self.W}, headers=self.session("wa"))
        url = r.json()["url"]
        q = parse_qs(urlsplit(url).query)
        self.assertTrue(url.startswith("https://slack.test/oauth/v2/authorize?"))
        self.assertEqual(q["scope"][0].split(","), list(slack.BOT_SCOPES))
        self.assertEqual(q["redirect_uri"][0], "https://markdrop.in/integrations/slack/callback")
        state = q["state"][0]
        # Someone else can't finish wa's round trip.
        r = await self.http.post("/api/v1/slack/connect", json={"code": "c", "state": state}, headers=self.session("wo"))
        self.assertEqual(r.status_code, 400)
        r = await self.http.post("/api/v1/slack/connect", json={"code": "c", "state": state}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        st = r.json()
        self.assertEqual(st["install"]["team_name"], "Acme Slack")
        self.assertTrue(st["install"]["token_ok"])
        # A state works once.
        r = await self.http.post("/api/v1/slack/connect", json={"code": "c", "state": state}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 400)
        row = await self.db[slack.INSTALLS].find_one({"_id": TEAM})
        self.assertEqual(row["workspace_id"], self.W)
        self.assertNotEqual(row["bot_token_enc"], BOT_TOKEN)
        self.assertEqual(crypto.decrypt(row["bot_token_enc"]), BOT_TOKEN)
        # The plaintext token is nowhere in the database.
        for coll in await self.db.list_collection_names():
            async for d in self.db[coll].find({}):
                self.assertNotIn(BOT_TOKEN, json.dumps(d, default=str), coll)
        # The installer's Slack account is linked.
        user = await slack.linked_user(self.db, TEAM, "U0WO")
        self.assertEqual(user.id, self.uid["wa"])
        self.assertEqual(st["me"]["linked"], True)
        # Members see the card, read-only.
        r = await self.http.get("/api/v1/slack/status", params={"workspace_id": self.W}, headers=self.session("wv"))
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["can_manage"])
        self.assertEqual(r.json()["install"]["team_name"], "Acme Slack")
        r = await self.http.get("/api/v1/slack/status", params={"workspace_id": self.W}, headers=self.session("stranger"))
        self.assertEqual(r.status_code, 404)

    async def test_one_team_one_workspace(self):
        await self.install()
        await self.add_member("W2", "wo", "admin")
        r = await self.http.post("/api/v1/slack/install", json={"workspace_id": self.ws["W2"]}, headers=self.session("wo"))
        state = parse_qs(urlsplit(r.json()["url"]).query)["state"][0]
        r = await self.http.post("/api/v1/slack/connect", json={"code": "c", "state": state}, headers=self.session("wo"))
        self.assertEqual(r.status_code, 409)
        self.assertEqual((await self.db[slack.INSTALLS].find_one({"_id": TEAM}))["workspace_id"], self.W)

    async def test_channels_settings_and_disconnect(self):
        await self.install()
        r = await self.http.get("/api/v1/slack/channels", params={"workspace_id": self.W}, headers=self.session("wo"))
        self.assertEqual([c["name"] for c in r.json()["channels"]], ["general", "leads", "meetings"])
        r = await self.http.patch("/api/v1/slack/settings", json={"workspace_id": self.W, "meetings_channel_id": "G1"},
                                  headers=self.session("wo"))
        self.assertEqual(r.status_code, 422)   # a private channel the app isn't in
        r = await self.http.patch("/api/v1/slack/settings", json={"workspace_id": self.W, "meetings_channel_id": "C2"},
                                  headers=self.session("wm"))
        self.assertEqual(r.status_code, 403)
        r = await self.http.patch("/api/v1/slack/settings", json={"workspace_id": self.W, "meetings_channel_id": "C2"},
                                  headers=self.session("wo"))
        self.assertEqual(r.json()["install"]["meetings_channel"]["name"], "meetings")
        await self.link("wm", "U0WM")
        r = await self.http.delete("/api/v1/slack/install", params={"workspace_id": self.W}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 403)
        r = await self.http.delete("/api/v1/slack/install", params={"workspace_id": self.W}, headers=self.session("wo"))
        self.assertIsNone(r.json()["install"])
        self.assertEqual(self.sk.of("apps.uninstall")[0]["client_id"], "111.222")
        self.assertEqual(await self.db[slack.LINKS].count_documents({}), 0)

    async def test_link_with_sign_in_with_slack(self):
        await self.install()
        r = await self.http.post("/api/v1/slack/link/start", json={"team_id": TEAM}, headers=self.session("stranger"))
        self.assertEqual(r.status_code, 200)       # anyone signed in, from the button in Slack
        r = await self.http.post("/api/v1/slack/link/start", json={"workspace_id": self.W}, headers=self.session("stranger"))
        self.assertEqual(r.status_code, 404)       # the settings card is for members
        r = await self.http.post("/api/v1/slack/link/start", json={"workspace_id": self.W}, headers=self.session("wm"))
        url = r.json()["url"]
        self.assertTrue(url.startswith("https://slack.test/openid/connect/authorize?"))
        q = parse_qs(urlsplit(url).query)
        self.assertEqual((q["scope"][0], q["team"][0]), ("openid", TEAM))
        # Signed in to another Slack workspace: refused.
        self.sk.oidc_team = TEAM2
        r = await self.http.post("/api/v1/slack/link/finish", json={"code": "c", "state": q["state"][0]},
                                 headers=self.session("wm"))
        self.assertEqual(r.status_code, 409)
        self.sk.oidc_team = TEAM
        r = await self.http.post("/api/v1/slack/link/start", json={"workspace_id": self.W}, headers=self.session("wm"))
        state = parse_qs(urlsplit(r.json()["url"]).query)["state"][0]
        r = await self.http.post("/api/v1/slack/link/finish", json={"code": "c", "state": state}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await slack.linked_user(self.db, TEAM, "U0ADA")).id, self.uid["wm"])
        # The Slack user token was used once and is kept nowhere.
        for coll in await self.db.list_collection_names():
            async for d in self.db[coll].find({}):
                self.assertNotIn(USER_TOKEN, json.dumps(d, default=str), coll)
        r = await self.http.delete("/api/v1/slack/link", params={"workspace_id": self.W}, headers=self.session("wm"))
        self.assertFalse(r.json()["me"]["linked"])

    async def test_uninstall_event_forgets_the_team(self):
        await self.install()
        await self.link("wm", "U0WM")
        await self.event({"type": "app_uninstalled"}, event_id="EvU")
        await slack.drain()
        self.assertIsNone(await self.db[slack.INSTALLS].find_one({"_id": TEAM}))
        self.assertEqual(await self.db[slack.LINKS].count_documents({"team_id": TEAM}), 0)


# ── /markdrop ─────────────────────────────────────────────────────────────────


class Commands(SearchWorld, SlackWorld, AIEnv):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await ai_usage.ensure_indexes(self.db)
        self.setup_ai()
        self.addCleanup(self.restore_ai)
        self.saved_ai = {k: getattr(settings, k) for k in ("search_ai_enabled", "search_ai_daily_usd", "search_ai_monthly_usd")}
        settings.search_ai_enabled, settings.search_ai_daily_usd, settings.search_ai_monthly_usd = True, 2.0, 20.0
        self.addCleanup(lambda: [setattr(settings, k, v) for k, v in self.saved_ai.items()])
        await self.put("onboarding", "Onboarding Playbook", "# Onboarding Playbook\n\nContractors get a laptop on day one.",
                       state="W", grants=False)
        await self.put("onboarding-pay", "Onboarding salaries", "Secret pay grid emu-77.", owner="wo", state="P",
                       grants=False)
        await self.index_all()
        await self.install()

        def script(kw):
            if "Return only JSON" in kw["system"][0]["text"]:
                return '{"terms": ["onboarding", "contractor"], "titles": ["Onboarding Playbook"]}'
            return "<ranking>1</ranking>\n\nContractors get a laptop on day one [1]."

        self.fake.script = script  # the model (AIEnv); Slack is self.sk

    async def test_unlinked_people_get_a_link_button(self):
        r = await self.command("search onboarding", slack_user="U0NEW")
        body = r.json()
        self.assertEqual(body["response_type"], "ephemeral")
        url = body["blocks"][1]["elements"][0]["url"]
        self.assertEqual(url, f"https://markdrop.in/integrations/slack/link?team={TEAM}")
        await slack.drain()
        self.assertEqual(self.sk.responds, [])

    async def test_not_connected_team(self):
        r = await self.command("help", team="T0NOPE")
        self.assertIn("isn't connected", r.json()["text"])

    async def test_help_and_unlink(self):
        await self.link("wm", "U0WM")
        r = await self.command("")
        self.assertIn("/markdrop search", json.dumps(r.json()))
        r = await self.command("unlink")
        self.assertIn("isn't linked", r.json()["blocks"][0]["text"]["text"])
        self.assertIsNone(await slack.linked_user(self.db, TEAM, "U0WM"))

    async def test_search_uses_only_what_the_person_can_open(self):
        await self.link("wm", "U0WM")
        await self.link("wo", "U0WO")
        await self.command("search onboarding")
        await slack.drain()
        wm = json.dumps(self.sk.responds[-1])
        self.assertEqual(self.sk.responds[-1]["response_type"], "ephemeral")
        self.assertIn("Onboarding Playbook", wm)
        self.assertNotIn("salaries", wm)       # wo's private page
        await self.command("search onboarding", slack_user="U0WO")
        await slack.drain()
        self.assertIn("Onboarding salaries", json.dumps(self.sk.responds[-1]))

    async def test_ask_answers_privately_with_sources(self):
        await self.link("wm", "U0WM")
        r = await self.command("ask how do contractors get a laptop?")
        self.assertIn("only you", r.json()["text"])
        await slack.drain()
        out = self.sk.responds[-1]
        self.assertEqual(out["response_type"], "ephemeral")
        self.assertTrue(out["replace_original"])
        text = json.dumps(out)
        self.assertIn("laptop on day one [1]", text)
        self.assertIn("https://docs.acme.test/onboarding|Onboarding Playbook", text)  # W1's own domain
        # The model never saw what wm can't open.
        for call in self.fake.calls:
            self.assertNotIn("emu-77", prompt_of(call))
        row = await self.db[ai_usage.REQUESTS].find_one({"feature": search_ai.FEATURE}, sort=[("ts", -1)])
        self.assertEqual(row["via"], "slack")

    async def test_a_question_without_a_subcommand_is_ask(self):
        self.assertEqual(slack_events.parse_command("how do we onboard contractors?")[0], "ask")
        self.assertEqual(slack_events.parse_command("onboarding playbook")[0], "search")
        self.assertEqual(slack_events.parse_command("SEARCH x"), ("search", "x"))


# ── Unfurls ───────────────────────────────────────────────────────────────────


class Unfurls(SlackWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.install()

    async def unfurled(self, doc: dict | str, *, channel: str = "C1", source: str | None = None, eid: str | None = None) -> dict:
        url = doc if isinstance(doc, str) else f"https://markdrop.in/{doc['slug']}"
        ev = {"type": "link_shared", "channel": channel, "message_ts": "1.1", "links": [{"url": url}]}
        if source:
            ev.update(source=source, unfurl_id="UF1")
        n = len(self.sk.of("chat.unfurl"))
        await self.event(ev, event_id=eid or f"Ev{time.time_ns()}")
        await slack.drain()
        calls = self.sk.of("chat.unfurl")
        if len(calls) == n:
            return {}
        return calls[-1]["unfurls"][url]

    async def test_link_public_items_unfurl_with_a_preview(self):
        doc = await self.mkdoc("L", grants=False, title="Launch plan", content="# Launch plan\n\nWe launch on **Friday**.")
        card = json.dumps(await self.unfurled(doc))
        self.assertIn("Launch plan", card)
        self.assertIn("We launch on Friday.", card)

    async def test_workspace_items_unfurl_only_in_the_teams_own_channels(self):
        doc = await self.mkdoc("W", grants=False, title="Team roadmap", content="Q3 roadmap body")
        self.assertIn("Team roadmap", json.dumps(await self.unfurled(doc)))
        # A Slack Connect channel (shared with another organization): minimal.
        self.sk.channel_info = {"is_ext_shared": True}
        card = json.dumps(await self.unfurled(doc))
        self.assertNotIn("roadmap", card.lower())
        self.assertIn("sign in to view", card)
        # The composer (no channel yet): link-public only.
        self.sk.channel_info = {"is_ext_shared": False}
        self.assertNotIn("roadmap", json.dumps(await self.unfurled(doc, channel="COMPOSER", source="composer")).lower())
        # Another workspace's audience.
        other = await self.mkdoc("W", ws="W2", owner="wm2", grants=False, title="W2 roadmap")
        self.assertNotIn("roadmap", json.dumps(await self.unfurled(other)).lower())

    async def test_private_password_and_missing_items_are_minimal(self):
        for state, title in (("P", "Salary review"), ("LP", "Password plan")):
            doc = await self.mkdoc(state, grants=False, title=title, content=f"secret {title}")
            card = json.dumps(await self.unfurled(doc))
            self.assertNotIn(title, card)
            self.assertNotIn("secret", card)
            self.assertIn("sign in to view", card)
        card = json.dumps(await self.unfurled("https://markdrop.in/nope-not-here"))
        self.assertIn("sign in to view", card)
        # A workspace that requires sign-in: its link-level items aren't public.
        rdoc = await self.mkdoc("RL", grants=False, title="Behind sign-in")
        self.assertNotIn("Behind sign-in", json.dumps(await self.unfurled(rdoc)))
        # App pages and other sites are left alone.
        self.assertEqual(await self.unfurled("https://markdrop.in/dashboard"), {})
        self.assertEqual(await self.unfurled("https://example.com/abc"), {})

    async def test_folder_shares(self):
        fid = (await self.db["folders"].insert_one({"workspace_id": self.W, "name": "Handbook", "parent_id": None,
                                                    "share": {"id": "shr1", "level": "link"}})).inserted_id
        self.assertIn("Handbook", json.dumps(await self.unfurled("https://markdrop.in/f/shr1")))
        await self.db["folders"].update_one({"_id": fid}, {"$set": {"share.level": "workspace"}})
        self.assertIn("Handbook", json.dumps(await self.unfurled("https://markdrop.in/f/shr1")))
        self.sk.channel_info = {"is_shared": True}
        self.assertNotIn("Handbook", json.dumps(await self.unfurled("https://markdrop.in/f/shr1")))


# ── DMs: notifications and access requests ────────────────────────────────────


class DirectMessages(SlackWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.install()
        await self.link("owner", "U0OWN")
        await self.link("wm", "U0WM")

    async def test_mention_dm_respects_access_and_prefs(self):
        doc = await self.mkdoc("W", grants=False, title="Plan")
        n = await notifications.notify(self.db, self.uid["owner"], "mention", doc, None, actor=self.uid["wm"],
                                       extra={"excerpt": "can you check this"})
        self.assertIsNotNone(n)
        self.assertEqual(await slack_notify.flush(self.db), 1)
        dm = self.sk.of("chat.postMessage")[-1]
        self.assertEqual(dm["channel"], "U0OWN")
        self.assertIn("mentioned you", json.dumps(dm))
        self.assertIn("can you check this", json.dumps(dm))
        # Turned off: nothing queued.
        r = await self.http.patch("/api/v1/slack/me/prefs", json={"mention": False}, headers=self.session("owner"))
        self.assertFalse(r.json()["prefs"]["mention"])
        doc2 = await self.mkdoc("W", grants=False)
        await notifications.notify(self.db, self.uid["owner"], "mention", doc2, None, actor=self.uid["wm"])
        self.assertEqual(await self.db[slack_notify.OUTBOX].count_documents({"state": "pending"}), 0)

    async def test_access_lost_before_sending_is_skipped(self):
        doc = await self.mkdoc("W", grants=False)
        await notifications.notify(self.db, self.uid["owner"], "shared", doc, None, actor=self.uid["wm"])
        await self.remove_member("W1", "owner")
        await self.db["documents"].update_one({"_id": doc["_id"]}, {"$set": {"owner_id": self.uid["wo"]}})
        self.assertEqual(await slack_notify.flush(self.db), 0)
        self.assertEqual((await self.db[slack_notify.OUTBOX].find_one({}))["state"], "skipped")

    async def test_access_request_approve_and_decline_in_slack(self):
        doc = await self.mkdoc("P", grants=False, title="Budget")
        await self.link("stranger", "U0STR")
        r = await self.http.post(f"/api/v1/documents/{doc['slug']}/access-requests", json={"message": "please"},
                                 headers=self.session("stranger"))
        self.assertEqual(r.status_code, 201, r.text)
        req_id = r.json()["id"]
        await slack_notify.flush(self.db)
        dm = self.sk.of("chat.postMessage")[-1]
        self.assertEqual(dm["channel"], "U0OWN")
        buttons = [e for b in dm["blocks"] if b["type"] == "actions" for e in b["elements"]]
        approve = next(b for b in buttons if b["action_id"] == "md_ar_ok")
        decline = next(b for b in buttons if b["action_id"] == "md_ar_no")
        # A forged value (the MAC doesn't match) changes nothing.
        forged = approve["value"].rsplit("|", 1)[0] + "|AAAAAAAAAAAAAAAA"
        await self.click("md_ar_ok", forged, "U0OWN")
        await slack.drain()
        self.assertEqual((await self.db["access_requests"].find_one({"_id": ObjectId(req_id)}))["status"], "pending")
        self.assertIn("isn't valid", json.dumps(self.sk.responds[-1]))
        # The same button from another Slack team: refused (signed for this team).
        await self.click("md_ar_ok", approve["value"], "U0OWN", team=TEAM2)
        await slack.drain()
        self.assertEqual((await self.db["access_requests"].find_one({"_id": ObjectId(req_id)}))["status"], "pending")
        # Someone linked who can't decide it (wm): refused by access_requests.decide.
        await self.click("md_ar_ok", approve["value"], "U0WM")
        await slack.drain()
        self.assertEqual((await self.db["access_requests"].find_one({"_id": ObjectId(req_id)}))["status"], "pending")
        # The owner approves.
        await self.click("md_ar_ok", approve["value"], "U0OWN")
        await slack.drain()
        row = await self.db["access_requests"].find_one({"_id": ObjectId(req_id)})
        self.assertEqual((row["status"], row["role_granted"]), ("approved", "viewer"))
        grant = await self.db["document_grants"].find_one({"document_id": str(doc["_id"]), "email": self.email["stranger"]})
        self.assertEqual(grant["role"], "viewer")
        self.assertIn("Approved by you", json.dumps(self.sk.of("chat.update")[-1]))
        # Declining after approving: "already answered".
        await self.click("md_ar_no", decline["value"], "U0OWN")
        await slack.drain()
        self.assertIn("already answered", json.dumps(self.sk.responds[-1]))

    async def test_signoff_dm_buttons(self):
        page = await self.mkdoc("W", grants=False, editor="blocks", title="Spec",
                                content=f':::signoff{{#b-5161a0ff person="{self.uid["owner"]}" label="Spec v2"}}\n:::\n')
        await notifications.notify(self.db, self.uid["owner"], "signoff_requested", page, "b-5161a0ff", actor=self.uid["wm"],
                                   extra={"label": "Spec v2"})
        await slack_notify.flush(self.db)
        dm = self.sk.of("chat.postMessage")[-1]
        btn = dm["blocks"][1]["elements"][0]
        self.assertEqual(btn["text"]["text"], "Approved")
        await self.click(btn["action_id"], btn["value"], "U0WM")         # not the named person
        await slack.drain()
        self.assertIsNone(await self.db["signoffs"].find_one({"doc_id": str(page["_id"])}))
        await self.click(btn["action_id"], btn["value"], "U0OWN")
        await slack.drain()
        so = await self.db["signoffs"].find_one({"doc_id": str(page["_id"])})
        self.assertEqual((so["option"], so["via"]), ("Approved", "slack"))


# ── Meeting posts and Done ────────────────────────────────────────────────────

from tests.test_meetings import MeetingsWorld  # noqa: E402


class MeetingPosts(MeetingsWorld, SlackWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.install()
        await self.db[slack.INSTALLS].update_one({"_id": TEAM}, {"$set": {"meetings_channel": {"id": "C2", "name": "meetings"}}})

    async def imported(self, **kw) -> dict:
        m = await MeetingsWorld.imported(self, **kw)
        await slack.drain()
        return m

    async def test_post_then_done_ticks_the_page(self):
        await self.link("wm", "U0WM")
        await self.link("wv", "U0WV")
        m = await self.imported()
        posts = [d for d in self.sk.of("chat.postMessage") if d["channel"] == "C2"]
        self.assertEqual(len(posts), 1)
        text = json.dumps(posts[0])
        self.assertIn("Weekly product sync", text)
        self.assertIn("Decisions", text)
        self.assertIn("<@U0WV> Email the Senseloaf team", text)   # a linked assignee is @mentioned
        self.assertIn("<@U0WM> Update the onboarding docs", text)
        self.assertIn("Zed Nobody Book the launch party", text)
        done = [b["accessory"] for b in posts[0]["blocks"] if b.get("accessory", {}).get("action_id") == "md_done"]
        self.assertEqual(len(done), 3)
        value = done[1]["value"]
        block = value.split("|")[2]
        # Not linked: a link button, nothing changes.
        await self.click("md_done", value, "U0NOBODY")
        await slack.drain()
        self.assertIn("Link my Markdrop account", json.dumps(self.sk.responds[-1]))
        page = await self.doc(m["slug"])
        self.assertIn(f"- [ ] ", page["content"])
        # Forged (another post's id with this MAC): refused.
        await self.click("md_done", value.replace(block, "b-00000000"), "U0WM")
        await slack.drain()
        self.assertNotIn("- [x]", (await self.doc(m["slug"]))["content"])
        # A workspace viewer can't edit the page.
        await self.click("md_done", value, "U0WV")
        await slack.drain()
        self.assertIn("can't edit", json.dumps(self.sk.responds[-1]))
        self.assertNotIn("- [x]", (await self.doc(m["slug"]))["content"])
        # A member can.
        await self.click("md_done", value, "U0WM")
        await slack.drain()
        page = await self.doc(m["slug"])
        self.assertRegex(page["content"], rf"- \[x\] .*\{{#{block}\}}")
        self.assertEqual(page["content"].count("- [x]"), 1)
        upd = self.sk.of("chat.update")[-1]
        self.assertIn("Done by Bo Chen", json.dumps(upd))
        # Again: already done, the page unchanged.
        await self.click("md_done", value, "U0WM")
        await slack.drain()
        self.assertIn("already done", json.dumps(self.sk.responds[-1]))

    async def test_restricted_meetings_are_never_posted(self):
        await self.imported(restricted=True)
        self.assertEqual([d for d in self.sk.of("chat.postMessage") if d["channel"] == "C2"], [])

    async def test_no_post_in_a_shared_channel_for_a_workspace_meeting(self):
        self.sk.channel_info = {"is_ext_shared": True}
        await self.imported()
        self.assertEqual([d for d in self.sk.of("chat.postMessage") if d["channel"] == "C2"], [])

    async def test_post_again_by_hand(self):
        m = await self.imported()
        r = await self.http.post(f"/api/v1/slack/meetings/{m['id']}/post", headers=self.session("wv"))
        self.assertEqual(r.status_code, 403)
        r = await self.http.post(f"/api/v1/slack/meetings/{m['id']}/post", headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len([d for d in self.sk.of("chat.postMessage") if d["channel"] == "C2"]), 2)


if __name__ == "__main__":
    import unittest

    unittest.main()
