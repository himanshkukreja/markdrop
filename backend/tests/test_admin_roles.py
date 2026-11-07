"""Owners and admins of the admin console (services/admin_roles, routers/admin_roles).

Owners are MARKDROP_ADMIN_EMAILS; admins are rows an owner adds in Admin › Admins. Both open the
console with the same session rules (routers/admin.require_admin); only owners add or remove admins,
with a session signed in within a day; every change is audited and emailed to every owner (and to the
new admin). /auth/me carries `admin` only for an admin, and only on a credential the console takes.
Email is never sent: ``mailer._post`` is captured.
"""

from __future__ import annotations

from tests import _access_env as aenv  # noqa: F401  (pins settings first)

import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock
from urllib.parse import quote

from app.config import get_settings
from app.limiter import limiter
from app.services import admin_roles, mailer
from tests.test_admin_sso import ROUTES, session_at

settings = get_settings()
ADMIN = "/api/v1/admin"
ADMINS = f"{ADMIN}/admins"


class AdminRoles(aenv.AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self._saved_admin = (settings.admin_emails, settings.admin_session_max_age_days,
                             settings.admin_role_change_max_age_hours)
        # "wo" is the owner; "wa" will be made an admin; "stranger" is nobody.
        settings.admin_emails = self.email["wo"]
        settings.admin_session_max_age_days = 7
        settings.admin_role_change_max_age_hours = 24
        await self.db["admins"].create_index("email", unique=True)
        self.sent: list[tuple[dict, str]] = []

        async def capture(payload, *, kind, ref=None):
            self.sent.append((payload, kind))
            return "sent"

        p = mock.patch.object(mailer, "_post", capture)
        p.start()
        self.addCleanup(p.stop)

    async def asyncTearDown(self):
        (settings.admin_emails, settings.admin_session_max_age_days,
         settings.admin_role_change_max_age_hours) = self._saved_admin
        await super().asyncTearDown()

    async def call(self, method: str, path: str, headers: dict | None = None, **kw):
        return await self.http.request(method, path, headers=headers or {}, **kw)

    async def statuses(self, headers: dict | None) -> set[int]:
        return {(await self.call(m, p, headers)).status_code for m, p in ROUTES}

    async def add(self, email: str, who: str = "wo", note: str | None = None):
        return await self.call("POST", ADMINS, self.session(who), json={"email": email, "note": note})

    async def me(self, headers: dict) -> dict:
        r = await self.call("GET", "/api/v1/auth/me", headers)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    # ── the guard ──

    async def test_added_admin_opens_every_admin_router_and_removal_closes_it(self):
        self.assertEqual(await self.statuses(self.session("wa")), {404})
        r = await self.add(self.email["wa"].upper(), note="Runs support")
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json(), {"email": self.email["wa"], "pending": False})
        self.assertEqual(await self.statuses(self.session("wa")), {200})
        me = (await self.call("GET", f"{ADMIN}/session", self.session("wa"))).json()
        self.assertEqual(me["role"], "admin")
        self.assertEqual((await self.call("GET", f"{ADMIN}/session", self.session("wo"))).json()["role"], "owner")
        # Removed: the very next request is refused, as if the console didn't exist.
        r = await self.call("DELETE", f"{ADMINS}/{quote(self.email['wa'])}", self.session("wo"))
        self.assertEqual(r.status_code, 204, r.text)
        self.assertEqual(await self.statuses(self.session("wa")), {404})

    async def test_pending_admin_becomes_admin_on_first_sign_in(self):
        r = await self.add("new.person@example.com")
        self.assertEqual(r.json(), {"email": "new.person@example.com", "pending": True})
        data = (await self.call("GET", ADMINS, self.session("wo"))).json()
        row = next(a for a in data["admins"] if a["email"] == "new.person@example.com")
        self.assertFalse(row["has_account"])
        uid = await self.make_user("New.Person@example.com".lower(), "New")
        h = session_at(uid, "new.person@example.com", datetime.now(timezone.utc))
        self.assertEqual((await self.call("GET", f"{ADMIN}/session", h)).status_code, 200)

    async def test_same_session_rules_for_added_admins(self):
        await self.add(self.email["wa"])
        # Tenant token, studio session, API and MCP tokens of an admin: never the console.
        self.assertEqual(await self.statuses(self.tenant("wa", "W1")), {404})
        tok = (await self.http.post("/api/v1/auth/studio-token", headers=self.session("wa"))).json()["token"]
        self.assertEqual(await self.statuses({"Authorization": f"Bearer {tok}"}), {404})
        self.assertEqual(await self.statuses(await self.api_token("wa")), {404})
        self.assertEqual(await self.statuses({"Authorization": f"Bearer {await self.mcp_token('wa')}"}), {404})
        # Old session: sign in again. Disabled account: not found.
        old = session_at(self.uid["wa"], self.email["wa"], datetime.now(timezone.utc) - timedelta(days=8))
        r = await self.call("GET", f"{ADMIN}/session", old)
        self.assertEqual((r.status_code, r.headers.get("x-admin-reauth")), (401, "1"))
        await self.db["users"].update_one({"_id": aenv.ObjectId(self.uid["wa"])}, {"$set": {"disabled": True}})
        self.assertEqual(await self.statuses(self.session("wa")), {404})

    async def test_non_admins_get_not_found_on_the_admins_routes(self):
        for m, p, kw in (("GET", ADMINS, {}), ("GET", f"{ADMINS}/candidates?q=ex", {}),
                         ("POST", ADMINS, {"json": {"email": "x@y.zz"}}), ("DELETE", f"{ADMINS}/x@y.zz", {})):
            self.assertEqual((await self.call(m, p, self.session("stranger"), **kw)).status_code, 404, p)
            self.assertEqual((await self.call(m, p, None, **kw)).status_code, 401, p)
        self.assertEqual(await self.db["admins"].count_documents({}), 0)

    # ── who may change roles ──

    async def test_admins_see_the_list_but_only_owners_change_it(self):
        await self.add(self.email["wa"])
        data = (await self.call("GET", ADMINS, self.session("wa"))).json()
        self.assertEqual((data["role"], data["can_manage"], data["you"]), ("admin", False, self.email["wa"]))
        self.assertEqual([o["email"] for o in data["owners"]], [self.email["wo"]])
        self.assertEqual([a["email"] for a in data["admins"]], [self.email["wa"]])
        for m, p, kw in (("GET", f"{ADMINS}/candidates?q=ex", {}), ("POST", ADMINS, {"json": {"email": self.email["wm"]}}),
                         ("DELETE", f"{ADMINS}/{self.email['wa']}", {})):
            r = await self.call(m, p, self.session("wa"), **kw)
            self.assertEqual(r.status_code, 403, (p, r.text))
        self.assertEqual(await self.db["admins"].count_documents({}), 1)
        owner_view = (await self.call("GET", ADMINS, self.session("wo"))).json()
        self.assertEqual((owner_view["role"], owner_view["can_manage"]), ("owner", True))

    async def test_refusals(self):
        self.assertEqual((await self.add("not-an-email")).status_code, 400)
        self.assertEqual((await self.add(self.email["wo"])).status_code, 409)          # an owner already
        self.assertEqual((await self.add(self.email["wa"])).status_code, 201)
        self.assertEqual((await self.add(f" {self.email['wa'].upper()} ")).status_code, 409)  # an admin already
        await self.db["users"].update_one({"_id": aenv.ObjectId(self.uid["wm"])}, {"$set": {"disabled": True}})
        self.assertEqual((await self.add(self.email["wm"])).status_code, 409)
        r = await self.call("DELETE", f"{ADMINS}/{self.email['wo']}", self.session("wo"))
        self.assertEqual(r.status_code, 403)                                           # owners live in the env
        self.assertEqual((await self.call("DELETE", f"{ADMINS}/nobody@x.yz", self.session("wo"))).status_code, 404)
        self.assertEqual(await self.db["admins"].count_documents({}), 1)

    async def test_last_admin_cannot_be_removed_when_there_is_no_owner(self):
        actor = {"email": "op@server"}
        await admin_roles.grant(self.db, actor, self.email["wa"])
        await admin_roles.grant(self.db, actor, self.email["wm"])
        settings.admin_emails = ""
        await admin_roles.revoke(self.db, actor, self.email["wm"])
        with self.assertRaises(admin_roles.RoleError) as cm:
            await admin_roles.revoke(self.db, actor, self.email["wa"])
        self.assertEqual(cm.exception.status, 409)
        self.assertEqual(await self.db["admins"].count_documents({}), 1)

    async def test_role_changes_need_a_fresh_session(self):
        two_days = session_at(self.uid["wo"], self.email["wo"], datetime.now(timezone.utc) - timedelta(days=2))
        self.assertEqual((await self.call("GET", ADMINS, two_days)).status_code, 200)   # reading is fine
        for m, p, kw in (("POST", ADMINS, {"json": {"email": self.email["wa"]}}), ("DELETE", f"{ADMINS}/{self.email['wa']}", {})):
            r = await self.call(m, p, two_days, **kw)
            self.assertEqual((r.status_code, r.headers.get("x-admin-reauth")), (401, "fresh"), p)
        self.assertEqual(await self.db["admins"].count_documents({}), 0)
        settings.admin_role_change_max_age_hours = 0
        self.assertEqual((await self.call("POST", ADMINS, two_days, json={"email": self.email["wa"]})).status_code, 201)

    async def test_changes_are_rate_limited(self):
        limiter.reset()
        codes = [(await self.add(f"p{i}@example.com")).status_code for i in range(12)]
        self.assertEqual(codes[:10], [201] * 10)
        self.assertIn(429, codes[10:])
        limiter.reset()

    # ── audit and email ──

    async def test_changes_are_audited_and_emailed(self):
        settings.admin_emails = f"{self.email['wo']},{self.email['owner']}"
        r = await self.call("POST", ADMINS, {**self.session("wo"), "X-Real-IP": "203.0.113.9"},
                            json={"email": self.email["wa"], "note": "  Runs   support "})
        self.assertEqual(r.status_code, 201)
        row = await self.db["admin_access_log"].find_one({"action": "admin_add"})
        self.assertEqual((row["admin"], row["target"], row["note"], row["via"]),
                         (self.email["wo"], self.email["wa"], "Runs support", "console"))
        self.assertTrue(row["ip_hash"] and "203.0.113.9" not in row["ip_hash"])
        added = await self.db["admins"].find_one({"email": self.email["wa"]})
        self.assertEqual(added["added_by"], self.email["wo"])
        # Every owner, and the new admin, all as admin_change from notifications@ (not login@).
        to = sorted(p["to"][0] for p, _ in self.sent)
        self.assertEqual(to, sorted([self.email["wo"], self.email["owner"], self.email["wa"]]))
        self.assertEqual({k for _, k in self.sent}, {"admin_change"})
        mine = next(p for p, _ in self.sent if p["to"] == [self.email["wa"]])
        self.assertEqual(mine["subject"], "You're now an admin of Markdrop")
        self.assertIn("/admin", mine["html"])
        owner_mail = next(p for p, _ in self.sent if p["to"] == [self.email["owner"]])
        self.assertIn(self.email["wa"], owner_mail["subject"])
        self.sent.clear()
        await self.call("DELETE", f"{ADMINS}/{self.email['wa']}", self.session("wo"))
        self.assertEqual(sorted(p["to"][0] for p, _ in self.sent), sorted([self.email["wo"], self.email["owner"]]))
        self.assertIn("no longer", self.sent[0][0]["subject"])
        hist = (await self.call("GET", ADMINS, self.session("wo"))).json()["history"]
        self.assertEqual([(h["action"], h["target"], h["actor"]) for h in hist],
                         [("remove", self.email["wa"], self.email["wo"]), ("add", self.email["wa"], self.email["wo"])])

    async def test_a_mail_failure_never_undoes_the_change(self):
        async def boom(payload, **_kw):
            raise RuntimeError("provider down")

        with mock.patch.object(mailer, "_post", boom):
            self.assertEqual((await self.add(self.email["wa"])).status_code, 201)
        self.assertEqual(await self.statuses(self.session("wa")), {200})

    async def test_listing_shows_accounts_and_last_visits(self):
        await self.add(self.email["wa"], note="Support")
        await self.call("GET", f"{ADMIN}/session", self.session("wa"))
        data = (await self.call("GET", ADMINS, self.session("wo"))).json()
        a = data["admins"][0]
        self.assertEqual((a["email"], a["name"], a["has_account"], a["note"], a["added_by"]),
                         (self.email["wa"], "WA", True, "Support", self.email["wo"]))
        self.assertIsNotNone(a["last_visit_at"])
        self.assertIsNotNone(data["owners"][0]["last_visit_at"])

    async def test_candidates_search(self):
        await self.add(self.email["wa"])

        async def find(q: str) -> list[dict]:
            r = await self.call("GET", f"{ADMINS}/candidates", self.session("wo"), params={"q": q})
            self.assertEqual(r.status_code, 200, r.text)
            return r.json()

        self.assertEqual([(c["email"], c["role"]) for c in await find("WO@")], [(self.email["wo"], "owner")])
        self.assertEqual([(c["email"], c["role"]) for c in await find("wa@")], [(self.email["wa"], "admin")])
        self.assertEqual([(c["email"], c["role"]) for c in await find("STRANGER")], [(self.email["stranger"], None)])
        self.assertEqual(len(await find("example.com")), 8)        # capped
        self.assertEqual(await find(".*"), [])                      # regex characters are literal
        self.assertEqual(await find("w"), [])                       # too short to search

    # ── the flag in /auth/me ──

    async def test_me_carries_admin_only_for_admins_on_a_console_credential(self):
        await self.add(self.email["wa"])
        self.assertEqual((await self.me(self.session("wo")))["admin"], "owner")
        self.assertEqual((await self.me(self.session("wa")))["admin"], "admin")
        # Everyone else: no key at all (not false).
        self.assertNotIn("admin", await self.me(self.session("stranger")))
        # Not on a tenant domain, the studio host, an API or MCP token.
        self.assertNotIn("admin", await self.me(self.tenant("wo", "W1")))
        tok = (await self.http.post("/api/v1/auth/studio-token", headers=self.session("wo"))).json()["token"]
        self.assertNotIn("admin", await self.me({"Authorization": f"Bearer {tok}"}))
        self.assertNotIn("admin", await self.me(await self.api_token("wo")))
        # A stale session still shows the link (the console asks them to sign in again).
        old = session_at(self.uid["wa"], self.email["wa"], datetime.now(timezone.utc) - timedelta(days=10))
        self.assertEqual((await self.me(old))["admin"], "admin")
        # Removed or disabled: gone.
        await self.call("DELETE", f"{ADMINS}/{self.email['wa']}", self.session("wo"))
        self.assertNotIn("admin", await self.me(self.session("wa")))
        await self.db["users"].update_one({"_id": aenv.ObjectId(self.uid["wo"])}, {"$set": {"disabled": True}})
        self.assertNotIn("admin", await self.me(self.session("wo")))

    # ── break-glass script ──

    async def test_break_glass_grant_revoke_list(self):
        from scripts import admin_access

        r = await admin_roles.grant(self.db, admin_access.OPERATOR, self.email["wa"], "night shift", via="break_glass")
        self.assertFalse(r["pending"])
        self.assertEqual(await self.statuses(self.session("wa")), {200})
        lines = await admin_access.admins(self.db)
        self.assertTrue(any(self.email["wa"] in ln and "active" in ln for ln in lines))
        self.assertTrue(any(self.email["wo"] in ln for ln in lines))
        row = await self.db["admin_access_log"].find_one({"action": "admin_add"})
        self.assertEqual((row["via"], row["admin"]), ("break_glass", None))
        self.assertTrue(any("admin_add" in ln for ln in await admin_access.recent(self.db, 1)))
        # Owners are told, by the operator's name.
        self.assertTrue(any("server operator" in p["html"] for p, _ in self.sent if p["to"] == [self.email["wo"]]))
        with self.assertRaises(admin_roles.RoleError):
            await admin_roles.revoke(self.db, admin_access.OPERATOR, self.email["wo"])
        await admin_roles.revoke(self.db, admin_access.OPERATOR, self.email["wa"], via="break_glass")
        self.assertEqual(await self.statuses(self.session("wa")), {404})
        # Minting a session stays owners-only.
        await admin_roles.grant(self.db, admin_access.OPERATOR, self.email["wm"])
        with self.assertRaises(admin_access.BreakGlassError):
            await admin_access.mint_session(self.db, self.email["wm"])


if __name__ == "__main__":
    unittest.main()
