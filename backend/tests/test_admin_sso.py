"""The admin console opens for the owner's own Markdrop session (routers/admin.require_admin).

No admin username or password any more: a full session signed in on markdrop.in, for an account
whose email is in MARKDROP_ADMIN_EMAILS (case-insensitive, exact), not disabled, signed in within
MARKDROP_ADMIN_SESSION_MAX_AGE_DAYS. Signed out: 401. Anyone else signed in: 404, as if the route
didn't exist. Tenant tokens, the studio host's session, API and MCP tokens never open it.
"""

from __future__ import annotations

from tests import _access_env as aenv  # noqa: F401  (pins settings first)

import unittest
from datetime import datetime, timedelta, timezone

import jwt

from app.config import get_settings
from app.utils.auth import create_access_token, decode_access_token, session_issued_at

settings = get_settings()
ADMIN = "/api/v1/admin"
# A sample of every admin router (admin, analytics, journeys, email, AI).
ROUTES = [
    ("GET", f"{ADMIN}/session"),
    ("GET", f"{ADMIN}/documents"),
    ("GET", f"{ADMIN}/users"),
    ("GET", f"{ADMIN}/feedback"),
    ("GET", f"{ADMIN}/analytics/realtime"),
    ("GET", f"{ADMIN}/email/templates"),
    ("GET", f"{ADMIN}/ai/budgets"),
]


def session_at(uid: str, email: str, issued: datetime, *, via: str | None = None, with_iat: bool = True) -> dict:
    """A session as if signed in at `issued` (the 30-day lifetime from then)."""
    exp = issued + timedelta(hours=settings.access_token_ttl_hours)
    payload = {"sub": uid, "email": email, "typ": "access", "exp": exp}
    if with_iat:
        payload["iat"] = issued
    if via:
        payload["via"] = via
    return {"Authorization": f"Bearer {jwt.encode(payload, settings.auth_secret, algorithm='HS256')}"}


class AdminSso(aenv.AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self._saved_admin = (settings.admin_emails, settings.admin_session_max_age_days)
        # The W1 owner is the site admin here; addresses are listed loosely on purpose.
        settings.admin_emails = f"  {self.email['wo'].upper()} , someone@else.test,"
        settings.admin_session_max_age_days = 7

    async def asyncTearDown(self):
        settings.admin_emails, settings.admin_session_max_age_days = self._saved_admin
        await super().asyncTearDown()

    async def call(self, method: str, path: str, headers: dict | None = None):
        return await self.http.request(method, path, headers=headers or {})

    async def statuses(self, headers: dict | None) -> set[int]:
        return {(await self.call(m, p, headers)).status_code for m, p in ROUTES}

    # ── who gets in ──

    async def test_allowlisted_session_opens_every_admin_router(self):
        h = self.session("wo")
        for m, p in ROUTES:
            r = await self.call(m, p, h)
            self.assertEqual(r.status_code, 200, (p, r.text))
        me = (await self.call("GET", f"{ADMIN}/session", h)).json()
        self.assertEqual(me["email"], self.email["wo"].lower())

    async def test_signed_out_and_bad_tokens_are_401(self):
        self.assertEqual(await self.statuses(None), {401})
        self.assertEqual(await self.statuses({"Authorization": "Bearer nope"}), {401})
        expired = session_at(self.uid["wo"], self.email["wo"], datetime.now(timezone.utc) - timedelta(days=40))
        self.assertEqual(await self.statuses(expired), {401})

    async def test_other_signed_in_users_get_not_found(self):
        for who in ("stranger", "wa", "owner"):
            self.assertEqual(await self.statuses(self.session(who)), {404}, who)
        r = await self.call("GET", f"{ADMIN}/documents", self.session("stranger"))
        self.assertEqual(r.json(), {"detail": "Not Found"})

    async def test_email_match_is_case_insensitive_and_exact(self):
        # A row written with capitals (accounts are stored lowercase, but a hand edit might not be).
        await self.db["users"].update_one({"_id": aenv.ObjectId(self.uid["wo"])},
                                          {"$set": {"email": self.email["wo"].title()}})
        self.assertEqual((await self.call("GET", f"{ADMIN}/session", self.session("wo"))).status_code, 200)
        # Near misses never match: a longer address, a suffix, a substring.
        for near in (f"x{self.email['wo']}", f"{self.email['wo']}.evil", self.email["wo"].split("@")[0]):
            await self.db["users"].update_one({"_id": aenv.ObjectId(self.uid["wo"])}, {"$set": {"email": near}})
            self.assertEqual((await self.call("GET", f"{ADMIN}/session", self.session("wo"))).status_code, 404, near)

    async def test_empty_allowlist_admits_nobody(self):
        settings.admin_emails = " , "
        self.assertEqual(await self.statuses(self.session("wo")), {404})

    async def test_disabled_account_is_refused(self):
        for flag in ({"disabled": True}, {"disabled_at": datetime.now(timezone.utc)}, {"deleted_at": datetime.now(timezone.utc)}):
            await self.db["users"].update_one({"_id": aenv.ObjectId(self.uid["wo"])}, {"$set": flag})
            self.assertEqual(await self.statuses(self.session("wo")), {404}, flag)
            await self.db["users"].update_one({"_id": aenv.ObjectId(self.uid["wo"])}, {"$unset": {k: "" for k in flag}})
        self.assertEqual((await self.call("GET", f"{ADMIN}/session", self.session("wo"))).status_code, 200)

    async def test_deleted_account_is_401(self):
        await self.db["users"].delete_one({"_id": aenv.ObjectId(self.uid["wo"])})
        self.assertEqual(await self.statuses(self.session("wo")), {401})

    # ── which sessions count ──

    async def test_tenant_token_of_the_admin_never_opens_it(self):
        # On a workspace's own domain, from that domain: still not the console.
        self.assertEqual(await self.statuses(self.tenant("wo", "W1")), {404})

    async def test_studio_host_session_never_opens_it(self):
        r = await self.http.post("/api/v1/auth/studio-token", headers=self.session("wo"))
        self.assertEqual(r.status_code, 200, r.text)
        tok = r.json()["token"]
        self.assertEqual(decode_access_token(tok).get("via"), "studio")
        h = {"Authorization": f"Bearer {tok}"}
        self.assertEqual(await self.statuses(h), {404})
        # It is still a working session everywhere else.
        self.assertEqual((await self.call("GET", "/api/v1/auth/me", h)).status_code, 200)
        # And a studio session can't launder itself into an untagged one.
        again = await self.http.post("/api/v1/auth/studio-token", headers=h)
        self.assertEqual(decode_access_token(again.json()["token"]).get("via"), "studio")

    async def test_api_and_mcp_tokens_never_open_it(self):
        self.assertEqual(await self.statuses(await self.api_token("wo")), {404})
        mcp = await self.mcp_token("wo")
        self.assertEqual(await self.statuses({"Authorization": f"Bearer {mcp}"}), {404})

    async def test_other_tokens_signed_with_the_auth_secret_never_open_it(self):
        for typ in ("oauth_state", "gdocs_state", "tenant", None):
            body = {"sub": self.uid["wo"], "exp": datetime.now(timezone.utc) + timedelta(hours=1)}
            if typ:
                body["typ"] = typ
            tok = jwt.encode(body, settings.auth_secret, algorithm="HS256")
            self.assertEqual(await self.statuses({"Authorization": f"Bearer {tok}"}), {404}, typ)

    async def test_the_old_admin_jwt_is_dead(self):
        old = jwt.encode({"sub": "admin", "exp": datetime.now(timezone.utc) + timedelta(hours=1)},
                         "test-admin-secret", algorithm="HS256")
        self.assertEqual(await self.statuses({"Authorization": f"Bearer {old}"}), {401})
        r = await self.http.post(f"{ADMIN}/login", json={"username": "admin", "password": "changeme"})
        self.assertIn(r.status_code, (404, 405))

    async def test_no_query_param_or_cookie_credential(self):
        tok = self.session("wo")["Authorization"].removeprefix("Bearer ")
        r = await self.http.get(f"{ADMIN}/session", params={"token": tok}, cookies={"markdrop_token": tok})
        self.assertEqual(r.status_code, 401)

    # ── session age ──

    async def test_session_must_be_recent(self):
        now = datetime.now(timezone.utc)
        fresh = session_at(self.uid["wo"], self.email["wo"], now - timedelta(days=6))
        self.assertEqual((await self.call("GET", f"{ADMIN}/session", fresh)).status_code, 200)
        for h in (session_at(self.uid["wo"], self.email["wo"], now - timedelta(days=8)),
                  # Made before sessions carried iat: dated from expiry less the 30-day lifetime.
                  session_at(self.uid["wo"], self.email["wo"], now - timedelta(days=8), with_iat=False)):
            r = await self.call("GET", f"{ADMIN}/session", h)
            self.assertEqual(r.status_code, 401, r.text)
            self.assertEqual(r.headers.get("x-admin-reauth"), "1")
            # Still a perfectly good app session.
            self.assertEqual((await self.call("GET", "/api/v1/auth/me", h)).status_code, 200)
        # A non-admin's old session gets 404, not a hint that re-signing-in would help.
        old_other = session_at(self.uid["stranger"], self.email["stranger"], now - timedelta(days=20))
        self.assertEqual((await self.call("GET", f"{ADMIN}/session", old_other)).status_code, 404)
        settings.admin_session_max_age_days = 0
        old = session_at(self.uid["wo"], self.email["wo"], now - timedelta(days=20))
        self.assertEqual((await self.call("GET", f"{ADMIN}/session", old)).status_code, 200)

    def test_new_sessions_carry_iat(self):
        tok, exp = create_access_token("u1", "a@b.c")
        p = decode_access_token(tok)
        self.assertIn("iat", p)
        self.assertNotIn("via", p)
        self.assertLess(abs((session_issued_at(p) - datetime.now(timezone.utc)).total_seconds()), 5)

    # ── audit ──

    async def test_access_is_logged_with_who_and_ip_hash(self):
        h = {**self.session("wo"), "X-Real-IP": "203.0.113.7"}
        for _ in range(3):
            await self.call("GET", f"{ADMIN}/session", h)
        rows = await self.db["admin_access_log"].find({"action": "access", "outcome": "ok"}).to_list(None)
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["email"], rows[0]["user_id"], rows[0]["count"]), (self.email["wo"].lower(), self.uid["wo"], 3))
        self.assertTrue(rows[0]["ip_hash"] and "203.0.113.7" not in rows[0]["ip_hash"])
        await self.call("GET", f"{ADMIN}/documents", {**self.session("stranger"), "X-Real-IP": "198.51.100.1"})
        denied = await self.db["admin_access_log"].find_one({"action": "access", "outcome": "denied"})
        self.assertEqual(denied["user_id"], self.uid["stranger"])
        # Moderation actions name the admin.
        d = await self.mkdoc("P", ws=None)
        await self.call("GET", f"{ADMIN}/documents/{d['slug']}", h)
        row = await self.db["admin_access_log"].find_one({"slug": d["slug"]})
        self.assertEqual((row["action"], row["admin"]), ("read", self.email["wo"].lower()))
        self.assertEqual(row["ip_hash"], rows[0]["ip_hash"])


    # ── break-glass (server-side script; nothing on the web) ──

    async def test_break_glass_session_opens_the_console_and_is_logged(self):
        from scripts import admin_access

        tok, exp = await admin_access.mint_session(self.db, f"  {self.email['wo'].upper()} ", hours=1)
        self.assertLess(exp - datetime.now(timezone.utc), timedelta(hours=1, minutes=1))
        h = {"Authorization": f"Bearer {tok}"}
        self.assertEqual((await self.call("GET", f"{ADMIN}/session", h)).status_code, 200)
        row = await self.db["admin_access_log"].find_one({"action": "break_glass"})
        self.assertEqual((row["email"], row["user_id"]), (self.email["wo"].lower(), self.uid["wo"]))
        lines = await admin_access.status(self.db)
        self.assertTrue(any(self.email["wo"].lower() in ln and self.uid["wo"] in ln for ln in lines))
        self.assertTrue(any("break_glass" in ln for ln in await admin_access.recent(self.db, 1)))

    async def test_break_glass_refuses_what_the_console_would(self):
        from scripts import admin_access

        for email, kw in ((self.email["stranger"], {}), (self.email["wo"], {"hours": 48}), (self.email["wo"], {"hours": 0}),
                          ("someone@else.test", {})):
            with self.assertRaises(admin_access.BreakGlassError, msg=(email, kw)):
                await admin_access.mint_session(self.db, email, **kw)
        # --create makes the allowlisted account that didn't exist yet.
        tok, _ = await admin_access.mint_session(self.db, "someone@else.test", create=True)
        self.assertEqual((await self.call("GET", f"{ADMIN}/session", {"Authorization": f"Bearer {tok}"})).status_code, 200)
        await self.db["users"].update_one({"_id": aenv.ObjectId(self.uid["wo"])}, {"$set": {"disabled": True}})
        with self.assertRaises(admin_access.BreakGlassError):
            await admin_access.mint_session(self.db, self.email["wo"])
        self.assertEqual(await self.db["admin_access_log"].count_documents({"action": "break_glass"}), 1)


if __name__ == "__main__":
    unittest.main()
