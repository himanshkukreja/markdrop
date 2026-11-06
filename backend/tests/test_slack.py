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
import unittest
from datetime import timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

from tests._access_env import AccessWorld, now  # noqa: F401  (pins settings first)
from tests.test_pages_ai import AIEnv, prompt_of
from tests.test_search import SearchWorld

import httpx
import yaml
from bson import ObjectId

from app.config import get_settings
from app.services import (ai_usage, meetings, notifications, search_ai, slack, slack_api, slack_events,
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
        # users.lookupByEmail: email -> Slack user (profile.email set the way Slack returns it).
        self.directory: dict[str, dict] = {}

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
        if method == "users.lookupByEmail":
            u = self.directory.get(str(data.get("email") or "").lower())
            if u is None:
                return httpx.Response(200, json={"ok": False, "error": "users_not_found"})
            return httpx.Response(200, json={"ok": True, "user": u})
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

    async def link(self, who: str, slack_user: str, team: str = TEAM, *, match: str = "oauth") -> None:
        await slack.save_link(self.db, team, slack_user, self.uid[who], who, match=match)

    async def opt_in(self, *who: str) -> None:
        """Slack notifications on (they're off by default), as the switch in Settings › Account stores it."""
        for w in who:
            await self.db["users"].update_one({"_id": ObjectId(self.uid[w])}, {"$set": {"slack_notify.on": True}})

    def in_slack(self, who: str, slack_user: str, **extra) -> None:
        """``who`` is in the fake Slack team under their Markdrop email."""
        self.sk.directory[self.email[who].lower()] = {
            "id": slack_user, "name": who, "deleted": False, "is_bot": False, "is_email_confirmed": True,
            "profile": {"email": self.email[who], "real_name": who.upper() + " in Slack"}, **extra}

    async def turn(self, who: str, on: bool = True, **body) -> httpx.Response:
        return await self.http.put("/api/v1/slack/me/notifications", json={"on": on, **body}, headers=self.session(who))

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
        # The redirect_uri the backend actually sends (production's frontend_url has no www): Slack refuses
        # an install whose redirect_uri isn't listed in the app's redirect_urls.
        settings.frontend_url = "https://markdrop.in"
        self.assertEqual(slack.redirect_uri(), "https://markdrop.in/integrations/slack/callback")
        self.assertIn(slack.redirect_uri(), m["oauth_config"]["redirect_urls"])
        self.assertNotRegex(path.read_text(), r"xox[abp]-|[0-9a-f]{32}")


class SwitchOn(unittest.TestCase):
    """Production today has no Slack keys; the owner adds the three (plus the encryption key) to .env and restarts."""

    def test_three_keys_in_env_file_switch_it_on(self):
        import tempfile

        from app.config import Settings

        with tempfile.TemporaryDirectory() as d:
            env = Path(d) / ".env"
            env.write_text("MARKDROP_TOKEN_ENCRYPTION_KEY=" + FERNET + "\n")
            self.assertFalse(Settings(_env_file=env).slack_configured)
            env.write_text(env.read_text() + "MARKDROP_SLACK_CLIENT_ID=111.222\nMARKDROP_SLACK_CLIENT_SECRET=cs\n")
            self.assertFalse(Settings(_env_file=env).slack_configured)          # all three, or it stays off
            env.write_text(env.read_text() + "MARKDROP_SLACK_SIGNING_SECRET=ss\n")
            s = Settings(_env_file=env)
            self.assertTrue(s.slack_configured)
            self.assertEqual((s.slack_client_id, s.slack_client_secret, s.slack_signing_secret), ("111.222", "cs", "ss"))
            # The names SETUP.md and .env.example tell the owner to use are the ones read here.
            root = Path(__file__).resolve().parents[2]
            for doc in (root / "docs-platform" / "slack" / "SETUP.md", root / "backend" / ".env.example"):
                for key in ("MARKDROP_SLACK_CLIENT_ID", "MARKDROP_SLACK_CLIENT_SECRET", "MARKDROP_SLACK_SIGNING_SECRET"):
                    self.assertIn(key, doc.read_text(), f"{key} in {doc.name}")


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
        await self.opt_in("owner", "wm")

    async def later(self, seconds: int = 90) -> int:
        """The DM flush once a mention's minute has passed (slack_notify.SLOW_WAIT)."""
        return await slack_notify.flush(self.db, now=now() + timedelta(seconds=seconds))

    async def test_mention_dm_respects_access_and_prefs(self):
        doc = await self.mkdoc("W", grants=False, title="Plan",
                               content=f':person[Owner]{{id="{self.uid["owner"]}"}} can you check this')
        n = await notifications.notify(self.db, self.uid["owner"], "mention", doc, None, actor=self.uid["wm"],
                                       extra={"excerpt": "can you check this"})
        self.assertIsNotNone(n)
        self.assertEqual(await slack_notify.flush(self.db), 0)   # a mention waits a minute
        self.assertEqual(await self.later(), 1)
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

    async def test_a_mention_taken_out_before_the_minute_is_not_sent(self):
        doc = await self.mkdoc("W", grants=False, title="Plan", editor="blocks",
                               content=f':person[Owner]{{id="{self.uid["owner"]}"}} check this')
        await notifications.notify(self.db, self.uid["owner"], "mention", doc, None, actor=self.uid["wm"])
        await self.db["documents"].update_one({"_id": doc["_id"]}, {"$set": {"content": "check this"}})
        self.assertEqual(await self.later(), 0)
        self.assertEqual((await self.db[slack_notify.OUTBOX].find_one({}))["state"], "skipped")
        # Taken out by a save: withdrawn at once.
        doc2 = await self.mkdoc("W", grants=False, title="Plan 2", editor="blocks", content="# Plan\n")
        before = await self.db["documents"].find_one({"_id": doc2["_id"]})
        after = {**before, "content": f':person[Owner]{{id="{self.uid["owner"]}"}} check this'}
        await self.db["documents"].update_one({"_id": doc2["_id"]}, {"$set": {"content": after["content"]}})
        self.assertEqual(await notifications.on_page_saved(self.db, before, after, self.uid["wm"]), 1)
        await notifications.on_page_saved(self.db, after, before, self.uid["wm"])
        row = await self.db[slack_notify.OUTBOX].find_one({"ref": {"$exists": True}}, sort=[("created_at", -1)])
        self.assertEqual((row["state"], row.get("error")), ("skipped", "withdrawn"))

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
        await self.later()
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


# ── Slack notifications: opt-in, found by email ───────────────────────────────


class OptIn(SlackWorld):
    """Direct messages are off until the person turns them on; turning them on finds them in Slack by
    their own Markdrop email (users.lookupByEmail), no Sign in with Slack needed (owner, 2026-11-06)."""

    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.install()

    async def later(self, seconds: int = 90) -> int:
        return await slack_notify.flush(self.db, now=now() + timedelta(seconds=seconds))

    async def mention(self, who: str, title: str = "Plan") -> dict:
        doc = await self.mkdoc("W", grants=False, title=title,
                               content=f':person[{who}]{{id="{self.uid[who]}"}} can you check this')
        await notifications.notify(self.db, self.uid[who], "mention", doc, None, actor=self.uid["wo"])
        return doc

    async def me(self, who: str) -> dict:
        r = await self.http.get("/api/v1/slack/me", headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def test_off_by_default_even_when_linked(self):
        # Linked with Sign in with Slack (for /markdrop) or as the installer: still no DMs until turned on.
        await self.link("wm", "U0WM")
        self.assertIsNotNone(await slack.linked_user(self.db, TEAM, "U0WO"))   # the installer
        me = await self.me("wm")
        self.assertFalse(me["on"])
        self.assertEqual([(t["team_name"], t["linked"], t["match"]) for t in me["teams"]], [("Acme Slack", True, "oauth")])
        st = (await self.http.get("/api/v1/slack/status", params={"workspace_id": self.W}, headers=self.session("wm"))).json()
        self.assertFalse(st["me"]["on"])
        await self.mention("wm")
        await self.mention("wa")
        self.assertEqual(await self.db[slack_notify.OUTBOX].count_documents({}), 0)
        self.assertEqual(await self.later(), 0)
        self.assertEqual(self.sk.of("chat.postMessage"), [])
        # Matched by email for someone else's sake? Never: nobody is looked up who didn't turn it on.
        self.assertEqual(self.sk.of("users.lookupByEmail"), [])

    async def test_turn_on_finds_me_by_my_email(self):
        self.in_slack("wm", "U0WMS")
        self.in_slack("wv", "U0WVS")
        # The body can't pick whose email is looked up: only the caller's own.
        r = await self.turn("wm", email=self.email["wv"], user_id=self.uid["wv"])
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertTrue(out["on"])
        self.assertEqual([(x["team_id"], x["result"]) for x in out["results"]], [(TEAM, "matched")])
        self.assertIn("Found you in Acme Slack as WM in Slack", out["results"][0]["message"])
        self.assertEqual([d["email"] for d in self.sk.of("users.lookupByEmail")], [self.email["wm"]])
        row = await self.db[slack.LINKS].find_one({"user_id": self.uid["wm"]})
        self.assertEqual((row["slack_user_id"], row["match"], row["team_id"]), ("U0WMS", "email", TEAM))
        self.assertIsNone(await self.db[slack.LINKS].find_one({"user_id": self.uid["wv"]}))
        self.assertFalse((await self.me("wv"))["on"])
        # DMs now arrive: after the mention's minute, with the footer that says how to stop them.
        await self.mention("wm")
        self.assertEqual(await slack_notify.flush(self.db), 0)
        self.assertEqual(await self.later(), 1)
        dm = self.sk.of("chat.postMessage")[-1]
        self.assertEqual(dm["channel"], "U0WMS")
        foot = dm["blocks"][-1]
        self.assertEqual(foot["type"], "context")
        self.assertIn("You turned these on in Markdrop", foot["elements"][0]["text"])
        self.assertIn("https://markdrop.in/settings/account#slack|Turn off", foot["elements"][0]["text"])
        # Per kind still applies once on.
        r = await self.http.patch("/api/v1/slack/me/prefs", json={"mention": False}, headers=self.session("wm"))
        self.assertFalse(r.json()["prefs"]["mention"])
        await self.mention("wm", "Plan 2")
        self.assertEqual(await self.db[slack_notify.OUTBOX].count_documents({"state": "pending"}), 0)
        # Turning it on again: already linked, Slack isn't asked again.
        n = len(self.sk.of("users.lookupByEmail"))
        self.assertEqual((await self.turn("wm")).json()["results"][0]["result"], "linked")
        self.assertEqual(len(self.sk.of("users.lookupByEmail")), n)

    async def test_not_found_says_so_and_link_is_the_fallback(self):
        r = await self.turn("wm")
        self.assertEqual(r.status_code, 200, r.text)
        res = r.json()["results"][0]
        self.assertEqual(res["result"], "not_found")
        self.assertEqual(res["message"], f"No one in Acme Slack uses {self.email['wm']}. Link your Slack account instead.")
        self.assertTrue(r.json()["on"])                 # their choice is kept: linking is all that's missing
        self.assertFalse(r.json()["teams"][0]["linked"])
        await self.mention("wm")
        self.assertEqual(await self.db[slack_notify.OUTBOX].count_documents({}), 0)
        # Sign in with Slack (the fallback) links them, and DMs flow.
        r = await self.http.post("/api/v1/slack/link/start", json={"workspace_id": self.W}, headers=self.session("wm"))
        state = parse_qs(urlsplit(r.json()["url"]).query)["state"][0]
        r = await self.http.post("/api/v1/slack/link/finish", json={"code": "c", "state": state}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self.me("wm"))["teams"][0]["match"], "oauth")
        await self.mention("wm", "Plan 2")
        self.assertEqual(await self.later(), 1)
        self.assertEqual(self.sk.of("chat.postMessage")[-1]["channel"], "U0ADA")

    async def test_unconfirmed_bot_or_deactivated_accounts_are_not_matched(self):
        for extra in ({"is_email_confirmed": False}, {"is_bot": True}, {"deleted": True}):
            self.in_slack("wm", "U0X", **extra)
            self.assertEqual((await self.turn("wm")).json()["results"][0]["result"], "not_found", extra)
        # Slack's profile email differing from the address asked for: not them.
        self.in_slack("wm", "U0X")
        self.sk.directory[self.email["wm"]]["profile"]["email"] = "someone-else@example.com"
        self.assertEqual((await self.turn("wm")).json()["results"][0]["result"], "not_found")
        self.assertIsNone(await self.db[slack.LINKS].find_one({"user_id": self.uid["wm"]}))

    async def test_an_install_without_the_new_scopes_needs_an_update(self):
        self.in_slack("wm", "U0WMS")
        # Installed before users:read.email was added: the settings card asks an admin to update it.
        await self.db[slack.INSTALLS].update_one({"_id": TEAM}, {"$pull": {"scopes": {"$in": list(slack.EMAIL_SCOPES)}}})
        st = (await self.http.get("/api/v1/slack/status", params={"workspace_id": self.W}, headers=self.session("wo"))).json()
        self.assertFalse(st["install"]["can_find_by_email"])
        # Slack says missing_scope: "needs an update", and the team is NOT forgotten (missing_scope is
        # one of slack_api.DEAD_TOKEN's errors elsewhere).
        self.sk.fail["users.lookupByEmail"] = "missing_scope"
        res = (await self.turn("wm")).json()["results"][0]
        self.assertEqual(res["result"], "needs_update")
        self.assertIn("a workspace admin updates it in Workspace settings", res["message"])
        self.assertIsNotNone(await self.db[slack.INSTALLS].find_one({"_id": TEAM}))
        self.assertIsNone(await self.db[slack.LINKS].find_one({"user_id": self.uid["wm"]}))
        # The scope list said yes: Slack's answer corrects it (the settings card then asks for the update).
        await self.db[slack.INSTALLS].update_one({"_id": TEAM}, {"$set": {"scopes": list(slack.BOT_SCOPES)}})
        await self.turn("wm")
        self.assertFalse(slack.can_find_by_email(await self.db[slack.INSTALLS].find_one({"_id": TEAM})))
        # Reinstalled from Slack's own app page (not through Markdrop): Slack now answers, the list is corrected.
        self.sk.fail.clear()
        self.in_slack("wa", "U0WAS")
        self.assertEqual((await self.turn("wa")).json()["results"][0]["result"], "matched")
        self.assertTrue(slack.can_find_by_email(await self.db[slack.INSTALLS].find_one({"_id": TEAM})))
        await self.db[slack.LINKS].delete_many({"user_id": self.uid["wa"]})
        # The admin updates the app through Markdrop (Add to Slack again): the same team, new scopes, and
        # wm, who had turned it on, is found by email on its own.
        self.sk.fail["users.lookupByEmail"] = "missing_scope"
        await self.turn("wm")
        self.sk.fail.clear()
        await self.install()
        self.assertTrue(slack.can_find_by_email(await self.db[slack.INSTALLS].find_one({"_id": TEAM})))
        await slack.drain()
        # wm had turned it on: the update found them by email on its own.
        self.assertEqual((await self.db[slack.LINKS].find_one({"user_id": self.uid["wm"]}))["match"], "email")

    async def test_a_slack_account_linked_to_someone_else_is_not_taken_over(self):
        self.in_slack("wm", "U0SHARED")
        await self.link("wv", "U0SHARED")
        res = (await self.turn("wm")).json()["results"][0]
        self.assertEqual(res["result"], "taken")
        self.assertEqual((await slack.linked_user(self.db, TEAM, "U0SHARED")).id, self.uid["wv"])

    async def test_only_members_of_a_connected_workspace(self):
        r = await self.turn("stranger")
        self.assertEqual(r.status_code, 409)
        self.assertIn("None of your workspaces has Slack connected", r.json()["detail"])
        self.assertFalse((await self.me("stranger"))["on"])
        self.assertEqual((await self.me("stranger"))["teams"], [])
        self.assertEqual(self.sk.of("users.lookupByEmail"), [])
        r = await self.http.put("/api/v1/slack/me/notifications", json={"on": True})
        self.assertEqual(r.status_code, 401)

    async def test_every_connected_team_is_matched(self):
        await self.add_member("W2", "wm", "member")
        self.sk.oauth_team = TEAM2
        await self.install(who="wm2", ws=self.ws["W2"])
        self.in_slack("wm", "U0WMS")
        out = (await self.turn("wm")).json()
        self.assertEqual(sorted((x["team_id"], x["result"]) for x in out["results"]), [(TEAM, "matched"), (TEAM2, "matched")])
        self.assertEqual(len(out["teams"]), 2)
        await self.mention("wm")
        self.assertEqual(await self.later(), 2)

    async def test_turning_off_drops_whats_waiting(self):
        self.in_slack("wm", "U0WMS")
        await self.turn("wm")
        await self.mention("wm")
        self.assertEqual(await self.db[slack_notify.OUTBOX].count_documents({"state": "pending"}), 1)
        r = await self.turn("wm", on=False)
        self.assertFalse(r.json()["on"])
        self.assertTrue(r.json()["teams"][0]["linked"])     # the link stays (for /markdrop)
        self.assertEqual(await self.later(), 0)
        row = await self.db[slack_notify.OUTBOX].find_one({})
        self.assertEqual((row["state"], row["error"]), ("skipped", "off"))

    async def test_people_linked_before_opt_in_keep_their_dms(self):
        # A link row from before (no "match"), and the person never chose: still on.
        await self.db[slack.LINKS].insert_one({"_id": f"{TEAM}:U0OLD", "team_id": TEAM, "slack_user_id": "U0OLD",
                                               "user_id": self.uid["wm"], "slack_name": "wm", "linked_at": now()})
        me = await self.me("wm")
        self.assertTrue(me["on"])
        self.assertEqual(me["teams"][0]["match"], "legacy")
        await self.mention("wm")
        self.assertEqual(await self.later(), 1)
        # Linking again (which replaces that row) keeps it on.
        await self.link("wm", "U0NEW")
        self.assertTrue((await self.me("wm"))["on"])
        self.assertEqual((await self.db["users"].find_one({"_id": ObjectId(self.uid["wm"])}))["slack_notify"]["on"], True)
        # Their own choice wins.
        await self.turn("wm", on=False)
        await self.mention("wm", "Plan 2")
        self.assertEqual(await self.db[slack_notify.OUTBOX].count_documents({"state": "pending"}), 0)

    async def test_help_says_how_to_turn_them_on(self):
        r = await self.command("help")
        self.assertIn("Settings › Account › Slack notifications", json.dumps(r.json(), ensure_ascii=False))


# ── Meeting posts and Done ────────────────────────────────────────────────────

from tests.test_meetings import MeetingsWorld  # noqa: E402


class MeetingPosts(MeetingsWorld, SlackWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.install()
        await self.db[slack.INSTALLS].update_one({"_id": TEAM}, {"$set": {"meetings_channel": {"id": "C2", "name": "meetings"}}})

    async def imported(self, **kw) -> dict:
        # Held today: a meeting more than a day old is history and isn't posted on its own.
        kw.setdefault("date", meetings.now_utc().date().isoformat())
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

    async def test_once_per_meeting_and_a_failed_post_is_retried(self):
        self.sk.fail["chat.postMessage"] = "not_in_channel"
        m = await self.imported()
        self.assertEqual(len([d for d in self.sk.of("chat.postMessage") if d["channel"] == "C2"]), 1)
        self.assertEqual((await self.db[slack_notify.POSTS].find_one({}))["state"], "failed")
        self.sk.fail.clear()
        r = await self.http.post(f"/api/v1/meetings/{m['id']}/regenerate", headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        await slack.drain()
        self.assertEqual(len([d for d in self.sk.of("chat.postMessage") if d["channel"] == "C2"]), 2)
        # Writing the summary again doesn't post it again.
        r = await self.http.post(f"/api/v1/meetings/{m['id']}/regenerate", headers=self.session("owner"))
        await slack.drain()
        self.assertEqual(len([d for d in self.sk.of("chat.postMessage") if d["channel"] == "C2"]), 2)

    async def test_restricted_meetings_are_never_posted(self):
        await self.imported(restricted=True)
        self.assertEqual([d for d in self.sk.of("chat.postMessage") if d["channel"] == "C2"], [])

    async def test_no_post_in_a_shared_channel_for_a_workspace_meeting(self):
        self.sk.channel_info = {"is_ext_shared": True}
        await self.imported()
        self.assertEqual([d for d in self.sk.of("chat.postMessage") if d["channel"] == "C2"], [])

    async def test_past_meetings_from_a_backfill_are_not_posted(self):
        from app.services import meeting_backfill as bf, meetings as meetings_service
        from tests.test_meetings import fixture

        owner = await bf._owner(self.db, {"user_id": self.uid["owner"], "workspace_id": self.W})
        inc = [meetings_service.Incoming(name="Weekly product sync (2026-11-04 10:00 GMT+05:30) - Transcript",
                                         text=fixture("google_meet_transcript.txt"), origin="upload")]
        rows = await meetings_service.import_meetings(self.db, owner, self.W, inc, wait=True,
                                                      via="backfill", notify=False)
        await slack.drain()
        self.assertTrue(rows[0].get("history"))
        self.assertEqual([d for d in self.sk.of("chat.postMessage") if d["channel"] == "C2"], [])
        # By hand it still can be.
        r = await self.http.post(f"/api/v1/slack/meetings/{rows[0]['_id']}/post", headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len([d for d in self.sk.of("chat.postMessage") if d["channel"] == "C2"]), 1)

    async def test_post_again_by_hand(self):
        m = await self.imported()
        r = await self.http.post(f"/api/v1/slack/meetings/{m['id']}/post", headers=self.session("wv"))
        self.assertEqual(r.status_code, 403)
        r = await self.http.post(f"/api/v1/slack/meetings/{m['id']}/post", headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len([d for d in self.sk.of("chat.postMessage") if d["channel"] == "C2"]), 2)


class McpTools(MeetingsWorld, SlackWorld):
    """slack_status and post_meeting_to_slack (app/mcp/slack_tools.py): the REST routes' rules."""

    async def call(self, who: str, name: str, args: dict, *, write: bool = True) -> dict:
        code, res = await self.mcp_call(await self.mcp_token(who, write=write), name, args)
        self.assertEqual(code, 200)
        return res

    def ok(self, res: dict) -> dict:
        self.assertFalse(res["isError"], res["content"][0]["text"])
        return res["structuredContent"]

    def refused(self, res: dict, words: str) -> None:
        self.assertTrue(res["isError"], res)
        self.assertIn(words, res["content"][0]["text"])

    async def test_status_for_members_only_and_never_a_token(self):
        out = self.ok(await self.call("wv", "slack_status", {"workspace": self.W}))
        self.assertEqual((out["available"], out["connected"], out["can_manage"]), (True, False, False))
        await self.install()
        await self.db[slack.INSTALLS].update_one({"_id": TEAM}, {"$set": {"meetings_channel": {"id": "C2", "name": "meetings"}}})
        await self.link("wm", "U0WM")
        res = await self.call("wm", "slack_status", {"workspace": self.W})
        out = self.ok(res)
        self.assertTrue(out["connected"])
        self.assertEqual(out["slack_workspace"], "Acme Slack")
        self.assertEqual(out["meetings_channel"], {"id": "C2", "name": "meetings"})
        self.assertTrue(out["post_meetings"])
        self.assertTrue(out["me"]["linked"])
        self.assertEqual((out["me"]["notifications_on"], out["me"]["found_by"]), (False, "oauth"))   # off by default
        self.assertIn("Your Slack notifications are off", res["content"][0]["text"])
        self.assertFalse(out["can_manage"])
        self.assertIn("#meetings", res["content"][0]["text"])
        await self.opt_in("wm")
        res = await self.call("wm", "slack_status", {"workspace": self.W})
        self.assertTrue(self.ok(res)["me"]["notifications_on"])
        self.assertIn("Your Slack notifications are on", res["content"][0]["text"])
        self.assertNotIn(BOT_TOKEN, json.dumps(res))
        self.assertNotIn("bot_token", json.dumps(res))
        self.assertTrue(self.ok(await self.call("wa", "slack_status", {"workspace": self.W}))["can_manage"])
        # Not a member: refused like the REST route.
        self.refused(await self.call("stranger", "slack_status", {"workspace": self.W}), "")
        self.refused(await self.call("wm2", "slack_status", {"workspace": self.W}), "")
        # Another workspace isn't connected.
        self.assertFalse(self.ok(await self.call("wm2", "slack_status", {"workspace": self.ws["W2"]}))["connected"])

    async def test_status_when_slack_isnt_set_up_on_the_server(self):
        settings.slack_signing_secret = ""
        res = await self.call("wm", "slack_status", {"workspace": self.W})
        self.assertFalse(self.ok(res)["available"])
        self.assertIn("isn't available", res["content"][0]["text"])
        self.refused(await self.call("wm", "post_meeting_to_slack", {"meeting": "0" * 24}), "isn't set up")

    async def test_post_needs_edit_access_and_a_channel(self):
        await self.install()
        m = await self.imported()
        await slack.drain()
        posts = lambda: [d for d in self.sk.of("chat.postMessage") if d["channel"] == "C2"]  # noqa: E731
        # No channel chosen yet.
        self.refused(await self.call("wm", "post_meeting_to_slack", {"meeting": m["id"]}), "Choose a meetings channel")
        await self.db[slack.INSTALLS].update_one({"_id": TEAM}, {"$set": {"meetings_channel": {"id": "C2", "name": "meetings"}}})
        # A viewer can't; a stranger can't see it; a read-only token can't write.
        self.refused(await self.call("wv", "post_meeting_to_slack", {"meeting": m["id"]}), "meetings you can edit")
        self.refused(await self.call("stranger", "post_meeting_to_slack", {"meeting": m["id"]}), "not found")
        _code, res = await self.mcp_call(await self.mcp_token("wm", write=False), "post_meeting_to_slack", {"meeting": m["id"]})
        self.assertTrue(res is None or res.get("isError"), res)
        self.assertEqual(posts(), [])
        # A member who can edit posts it (by its page's slug too); twice in a minute posts once.
        out = self.ok(await self.call("wm", "post_meeting_to_slack", {"meeting": m["slug"]}))
        self.assertEqual((out["posted"], out["channel"]["name"]), (True, "meetings"))
        self.assertEqual(len(posts()), 1)
        self.assertIn("md_done", json.dumps(posts()[0]))
        self.refused(await self.call("wm", "post_meeting_to_slack", {"meeting": m["id"]}), "less than a minute ago")
        self.assertEqual(len(posts()), 1)

    async def test_restricted_meetings_are_never_posted(self):
        await self.install()
        await self.db[slack.INSTALLS].update_one({"_id": TEAM}, {"$set": {"meetings_channel": {"id": "C2", "name": "meetings"}}})
        m = await self.imported(restricted=True)
        await slack.drain()
        self.refused(await self.call("owner", "post_meeting_to_slack", {"meeting": m["id"]}), "restricted")
        self.assertEqual([d for d in self.sk.of("chat.postMessage") if d["channel"] == "C2"], [])
        # A failed post doesn't hold the minute.
        self.refused(await self.call("owner", "post_meeting_to_slack", {"meeting": m["id"]}), "restricted")


class Drain(unittest.TestCase):
    def test_finished_work_of_a_closed_loop_doesnt_hang_drain(self):
        # A test's loop that closes before a finished task's done callbacks run leaves it in _bg; the
        # next test's drain() gathered it (returns at once, never yields) and spun forever (CI hangs).
        old = asyncio.new_event_loop()

        async def nothing():
            return 1

        t = old.create_task(nothing())
        old.run_until_complete(t)
        old.close()
        slack._bg.add(t)
        try:
            asyncio.run(asyncio.wait_for(slack.drain(), 5))
            self.assertNotIn(t, slack._bg)
        finally:
            slack._bg.discard(t)


if __name__ == "__main__":
    import unittest

    unittest.main()
