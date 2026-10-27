"""Custom domains v2 (workspaces-v2 spec, workstream A): S2–S6, T1, T3, T4.

Lifecycle (scheduled re-check, lapse after ≥72 h of failures with a fake
clock, "Check DNS again" dropping a gone TXT record), squatting (partial unique
index on verified hosts, pending TTL, first to verify wins, 409 not 500, safe
index migration), tenant tokens (Origin must match the `host` claim, consent,
/auth/me without an address), tenant CORS, the internal rate-limit exemption,
the OG poster card and media signed-URL lifetimes.

DNS and the hosting provider are always mocked: `check_txt` / `check_routing`
and `_vercel_attach` / `detach_from_hosting` are patched per test. No network.
Real MongoDB (mongodb://localhost:27018) or MARKDROP_TEST_MONGOMOCK=1.
"""

from __future__ import annotations

import time
import unittest
from datetime import datetime, timedelta, timezone
from io import BytesIO
from unittest import mock

import jwt
from bson import ObjectId

from tests._mcp_env import API, McpTestCase, settings

from app.middleware import internal as internal_mw
from app.middleware import tenant_cors
from app.services import artifact, domain as domain_service, domain_monitor, og_render
from app.utils.auth import create_tenant_token

# Real "now" (to the second): pending rows carry a TTL `expires_at` computed
# from the fake clock, and a clock in the past would have them expire on read.
T0 = datetime.now(timezone.utc).replace(microsecond=0)


class Clock:
    """A movable `domain._now`."""

    def __init__(self, at: datetime):
        self.at = at

    def __call__(self) -> datetime:
        return self.at

    def advance(self, **kw) -> datetime:
        self.at = self.at + timedelta(**kw)
        return self.at


class DnsFake:
    """What `check_txt` / `check_routing` answer, per host."""

    def __init__(self):
        self.txt: dict[str, str] = {}
        self.routing: dict[str, str] = {}

    def check_txt(self, host, token):
        state = self.txt.get(host, "missing")
        return state, None if state == "ok" else f"txt {state}"

    def check_routing(self, host):
        state = self.routing.get(host, "missing")
        return state, None if state == "ok" else f"routing {state}"


class DomainCase(McpTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await domain_service.ensure_indexes(self.db)
        tenant_cors.clear_cache()
        self.dns = DnsFake()
        self.clock = Clock(T0)
        self.detached: list[str] = []
        self.attached: list[str] = []

        async def detach(host):
            self.detached.append(host)
            return True

        async def attach(host):
            self.attached.append(host)
            return True, None

        self._patches = [
            mock.patch.object(domain_service, "check_txt", self.dns.check_txt),
            mock.patch.object(domain_service, "check_routing", self.dns.check_routing),
            mock.patch.object(domain_service, "_now", self.clock),
            mock.patch.object(domain_service, "detach_from_hosting", detach),
            mock.patch.object(domain_service, "_vercel_attach", attach),
        ]
        for p in self._patches:
            p.start()
        self.auth = {"Authorization": f"Bearer {self.session}"}
        self.ws = await self.workspace("Acme", self.auth)

    async def asyncTearDown(self):
        for p in reversed(self._patches):
            p.stop()
        tenant_cors.clear_cache()
        await super().asyncTearDown()

    async def workspace(self, name: str, auth: dict) -> str:
        r = await self.http.post("/api/v1/workspaces", json={"name": name}, headers=auth)
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["id"]

    async def add(self, host: str, ws: str | None = None, auth: dict | None = None,
                  kind: str = "app"):
        return await self.http.post(f"/api/v1/workspaces/{ws or self.ws}/domains",
                                    json={"host": host, "kind": kind}, headers=auth or self.auth)

    async def verify(self, domain_id: str, ws: str | None = None, auth: dict | None = None):
        return await self.http.post(f"/api/v1/workspaces/{ws or self.ws}/domains/{domain_id}/verify",
                                    headers=auth or self.auth)

    async def live_domain(self, host: str = "docs.acme.com", kind: str = "app") -> dict:
        r = await self.add(host, kind=kind)
        self.assertEqual(r.status_code, 201, r.text)
        self.dns.txt[host] = "ok"
        self.dns.routing[host] = "ok"
        r = await self.verify(r.json()["id"])
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def row(self, host: str, ws: str | None = None) -> dict | None:
        q = {"host": host}
        if ws:
            q["workspace_id"] = ws
        return await self.db["domains"].find_one(q)

    async def resolve(self, host: str):
        r = await self.http.get("/api/v1/host", params={"host": host})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()


class Squatting(DomainCase):
    async def test_pending_claim_blocks_nobody_first_verifier_wins(self):
        other_user = await self.make_user("mallory@example.com", "Mallory")
        from app.utils.auth import create_access_token

        mallory = {"Authorization": f"Bearer {create_access_token(other_user, 'mallory@example.com')[0]}"}
        evil_ws = await self.workspace("Evil", mallory)

        # Mallory claims first, but can't prove it.
        r = await self.add("docs.acme.com", ws=evil_ws, auth=mallory)
        self.assertEqual(r.status_code, 201, r.text)
        mallory_id = r.json()["id"]
        self.assertIsNotNone(r.json()["expires_at"])  # pending claims expire

        # The real owner can still add it (no 409 from a pending squat).
        r = await self.add("docs.acme.com")
        self.assertEqual(r.status_code, 201, r.text)
        mine = r.json()
        self.assertEqual(mine["status"], "pending")

        # Mallory's check fails (the TXT holds the owner's token, not hers).
        r = await self.verify(mallory_id, ws=evil_ws, auth=mallory)
        self.assertEqual(r.json()["status"], "pending")

        self.dns.txt["docs.acme.com"] = "ok"
        self.dns.routing["docs.acme.com"] = "ok"
        r = await self.verify(mine["id"])
        body = r.json()
        self.assertEqual((body["status"], body["live"], body["is_primary"]), ("verified", True, True))
        self.assertIsNone(body["expires_at"])
        # The loser's pending row is gone, and she can't claim it again.
        self.assertIsNone(await self.db["domains"].find_one({"workspace_id": evil_ws}))
        r = await self.add("docs.acme.com", ws=evil_ws, auth=mallory)
        self.assertEqual((r.status_code, r.json()["detail"]), (409, "docs.acme.com is already claimed."))

    async def test_verify_race_is_409_not_500(self):
        ws2 = await self.workspace("Acme 2", self.auth)
        a = (await self.add("docs.acme.com")).json()
        b = (await self.add("docs.acme.com", ws=ws2)).json()
        # Simulate b losing the race: a is verified in between b's read and write.
        raw_b = await self.db["domains"].find_one({"_id": ObjectId(b["id"])})
        await self.db["domains"].update_one({"_id": ObjectId(a["id"])}, {"$set": {"status": "verified"}})
        from fastapi import HTTPException

        with self.assertRaises(HTTPException) as ctx:
            await domain_service._promote(self.db, raw_b, T0)
        self.assertEqual(ctx.exception.status_code, 409)

    async def test_same_workspace_duplicate_is_409(self):
        self.assertEqual((await self.add("docs.acme.com")).status_code, 201)
        r = await self.add("DOCS.acme.com.")
        self.assertEqual(r.status_code, 409)
        self.assertIn("already in this workspace", r.json()["detail"])


class IndexMigration(DomainCase):
    async def test_migrates_old_unique_index_and_backfills_once(self):
        coll = self.db["domains"]
        await self.db.drop_collection("domains")
        await self.db.drop_collection("migrations")
        await coll.create_index("host", unique=True)  # the old index
        await coll.create_index("workspace_id")
        old_pending = {"host": "p.example.com", "workspace_id": "w1", "kind": "app", "status": "pending",
                       "verification_token": "t", "created_at": T0 - timedelta(days=90), "attached": False}
        old_verified = {"host": "v.example.com", "workspace_id": "w1", "kind": "app", "status": "verified",
                        "verification_token": "t", "created_at": T0 - timedelta(days=90),
                        "verified_at": T0 - timedelta(days=80), "attached": False}
        await coll.insert_many([old_pending, old_verified])

        await domain_service.ensure_indexes(self.db)
        info = await coll.index_information()
        self.assertTrue(info["host_verified_unique"]["unique"])
        self.assertEqual(info["host_verified_unique"]["partialFilterExpression"], {"status": "verified"})
        self.assertFalse(info["host_1"].get("unique", False))
        self.assertIn("expires_at_1", info)

        p = await coll.find_one({"host": "p.example.com"})
        v = await coll.find_one({"host": "v.example.com"})
        # A full TTL from the migration, not from creation (90 days ago).
        self.assertEqual(domain_service._aware(p["expires_at"]), T0 + timedelta(days=7))
        self.assertEqual((v["attached"], v["attached_via"]), (True, "legacy"))
        # Still live after the migration (legacy verified rows keep serving).
        self.assertEqual((await domain_service.resolve_host(self.db, "v.example.com")).workspace_id, "w1")

        # Pending duplicates are now allowed; verified ones are not.
        await coll.insert_one({**old_pending, "_id": ObjectId(), "workspace_id": "w2"})
        from pymongo.errors import DuplicateKeyError

        with self.assertRaises(DuplicateKeyError):
            await coll.insert_one({**old_verified, "_id": ObjectId(), "workspace_id": "w2"})

        # Idempotent, and the legacy backfill never runs twice: a domain
        # verified after the migration without being attached stays unattached.
        await coll.insert_one({"host": "new.example.com", "workspace_id": "w1", "kind": "app",
                               "status": "verified", "verification_token": "t", "created_at": T0,
                               "attached": False})
        await domain_service.ensure_indexes(self.db)
        self.assertFalse((await coll.find_one({"host": "new.example.com"}))["attached"])
        self.assertIsNone(await domain_service.resolve_host(self.db, "new.example.com"))


class Lifecycle(DomainCase):
    async def test_check_again_drops_verified_when_txt_is_gone(self):
        d = await self.live_domain()
        self.assertTrue(d["live"])
        self.assertIsNotNone(await self.resolve("docs.acme.com"))
        self.dns.txt["docs.acme.com"] = "missing"
        r = await self.verify(d["id"])
        body = r.json()
        self.assertEqual((body["status"], body["live"], body["attached"], body["is_primary"]),
                         ("pending", False, False, False))
        self.assertEqual(self.detached, ["docs.acme.com"])
        self.assertIsNone(await self.resolve("docs.acme.com"))

    async def test_lookup_error_on_check_again_keeps_verified(self):
        d = await self.live_domain()
        self.dns.txt["docs.acme.com"] = "error"
        body = (await self.verify(d["id"])).json()
        self.assertEqual((body["status"], body["live"]), ("verified", True))
        self.assertEqual(body["last_error"], "txt error")

    async def test_verified_without_hosting_credentials_goes_live_on_routing(self):
        with mock.patch.object(type(settings), "vercel_domains_configured",
                               new_callable=mock.PropertyMock, return_value=False):
            r = await self.add("docs.acme.com")
            self.dns.txt["docs.acme.com"] = "ok"
            self.dns.routing["docs.acme.com"] = "missing"
            body = (await self.verify(r.json()["id"])).json()
            self.assertEqual((body["status"], body["live"], body["routing_ok"]), ("verified", False, False))
            self.assertIsNone(await self.resolve("docs.acme.com"))
            self.dns.routing["docs.acme.com"] = "ok"
            body = (await self.verify(r.json()["id"])).json()
            self.assertEqual((body["live"], body["routing_ok"]), (True, True))
        self.assertEqual(self.attached, [])

    async def test_auto_attach_with_hosting_credentials(self):
        with mock.patch.object(type(settings), "vercel_domains_configured",
                               new_callable=mock.PropertyMock, return_value=True):
            d = await self.live_domain()
        self.assertTrue(d["live"])
        self.assertEqual(self.attached, ["docs.acme.com"])

    async def test_scheduled_recheck_lapses_after_72h_of_failures(self):
        await self.live_domain()
        db = self.db

        async def tick():
            return await domain_monitor.tick(db, owner="w1", now=self.clock())

        # First pass: healthy.
        self.assertEqual(await tick(), {"ok": 1})
        # Not due again within the interval.
        self.clock.advance(hours=23)
        self.assertIsNone(await tick())

        # The routing record is repointed elsewhere. Failures accumulate…
        self.dns.routing["docs.acme.com"] = "missing"
        self.clock.advance(hours=1)
        failed_at = self.clock()
        self.assertEqual(await tick(), {"failing": 1})
        for hours in (24, 48):
            self.clock.advance(hours=24)
            self.assertEqual(await tick(), {"failing": 1})
            row = await self.row("docs.acme.com")
            self.assertEqual(row["status"], "verified")  # still live before 72 h
            self.assertIsNotNone(await self.resolve("docs.acme.com"))
        self.assertEqual(row["failures"], 3)
        self.assertEqual(domain_service._aware(row["first_failed_at"]), failed_at)

        # …and the pass that sees them span 72 h lapses it.
        self.clock.advance(hours=24)
        self.assertEqual(await tick(), {"lapsed": 1})
        row = await self.row("docs.acme.com")
        self.assertEqual((row["status"], row["attached"], row["is_primary"], row["failures"]),
                         ("lapsed", False, False, 4))
        self.assertEqual(self.detached, ["docs.acme.com"])

        # Lapsed: not resolved, no tenant token, no CORS, not a card host.
        self.assertIsNone(await self.resolve("docs.acme.com"))
        r = await self.http.post("/api/v1/auth/tenant-token", json={"host": "docs.acme.com", "consent": True},
                                 headers=self.auth)
        self.assertEqual(r.status_code, 404)
        r = await self.http.options("/api/v1/documents/x", headers={
            "Origin": "https://docs.acme.com", "Access-Control-Request-Method": "GET"})
        self.assertNotEqual(r.headers.get("access-control-allow-origin"), "https://docs.acme.com")
        self.assertIsNone(await domain_service.primary_host(db, self.ws))
        # A recently lapsed host still can't be claimed by someone else.
        ws2 = await self.workspace("Other", self.auth)
        self.assertEqual((await self.add("docs.acme.com", ws=ws2)).status_code, 409)

        # Check DNS again with only TXT back: still lapsed. With both: live again.
        d_id = str(row["_id"])
        body = (await self.verify(d_id)).json()
        self.assertEqual(body["status"], "lapsed")
        self.dns.routing["docs.acme.com"] = "ok"
        body = (await self.verify(d_id)).json()
        self.assertEqual((body["status"], body["live"], body["failures"], body["is_primary"]),
                         ("verified", True, 0, True))
        self.assertIsNotNone(await self.resolve("docs.acme.com"))

    async def test_recovery_resets_the_failure_window(self):
        await self.live_domain()
        self.dns.txt["docs.acme.com"] = "error"
        self.assertEqual(await domain_monitor.tick(self.db, owner="w", now=self.clock()), {"failing": 1})
        self.clock.advance(hours=48)
        self.dns.txt["docs.acme.com"] = "ok"
        self.assertEqual(await domain_monitor.tick(self.db, owner="w", now=self.clock()), {"ok": 1})
        row = await self.row("docs.acme.com")
        self.assertEqual((row["failures"], row["first_failed_at"]), (0, None))
        # A new failure 48 h later starts a fresh 72 h window.
        self.dns.txt["docs.acme.com"] = "missing"
        self.clock.advance(hours=48)
        self.assertEqual(await domain_monitor.tick(self.db, owner="w", now=self.clock()), {"failing": 1})

    async def test_lease_lets_one_worker_run(self):
        now = T0
        self.assertTrue(await domain_monitor.acquire_lease(self.db, "a", now))
        self.assertFalse(await domain_monitor.acquire_lease(self.db, "b", now))
        self.assertTrue(await domain_monitor.acquire_lease(self.db, "a", now))  # re-entrant
        later = now + timedelta(seconds=domain_monitor.LEASE_SECONDS + 1)
        self.assertTrue(await domain_monitor.acquire_lease(self.db, "b", later))  # expired → taken over
        # While b holds it, a's tick does nothing.
        self.assertIsNone(await domain_monitor.tick(self.db, owner="a", now=later))
        await domain_monitor.release_lease(self.db, "b", None)
        self.assertEqual(await domain_monitor.tick(self.db, owner="a", now=later), {})

    async def test_interval_is_configurable(self):
        await self.live_domain()
        with mock.patch.object(settings, "domain_recheck_interval_seconds", 3600):
            self.assertEqual(await domain_monitor.tick(self.db, owner="w", now=self.clock()), {"ok": 1})
            self.clock.advance(minutes=59)
            self.assertIsNone(await domain_monitor.tick(self.db, owner="w", now=self.clock()))
            self.clock.advance(minutes=1)
            self.assertEqual(await domain_monitor.tick(self.db, owner="w", now=self.clock()), {"ok": 1})

    async def test_trailing_dot_and_case_resolve_the_same_host(self):
        await self.live_domain()
        self.assertIsNotNone(await self.resolve("Docs.Acme.com."))
        self.assertIsNotNone(await self.resolve("docs.acme.com:443"))


class TenantTokens(DomainCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.live_domain()
        self.reader_id = await self.make_user("reader@example.com", "Rita Reader")
        from app.utils.auth import create_access_token

        self.reader = {"Authorization": f"Bearer {create_access_token(self.reader_id, 'reader@example.com')[0]}"}

    async def test_origin_must_match_host_claim(self):
        token, _ = create_tenant_token(self.reader_id, "reader@example.com", self.ws, "docs.acme.com")
        h = {"Authorization": f"Bearer {token}"}
        r = await self.http.get("/api/v1/auth/me", headers={**h, "Origin": "https://docs.acme.com"})
        self.assertEqual(r.status_code, 200, r.text)
        me = r.json()
        self.assertEqual((me["email"], me["name"], me["picture"]), ("", "Rita Reader", None))
        for origin in ("https://evil.example", "https://markdrop.in", None):
            hdrs = {**h, **({"Origin": origin} if origin else {})}
            r = await self.http.get("/api/v1/auth/me", headers=hdrs)
            self.assertEqual(r.status_code, 401, origin)
        # Optional-auth routes refuse it too rather than downgrading to anonymous.
        r = await self.http.get("/api/v1/documents/nope", headers={**h, "Origin": "https://evil.example"})
        self.assertEqual(r.status_code, 401)
        # Never accepted outside the allowlist, even from the right origin.
        r = await self.http.get("/api/v1/workspaces", headers={**h, "Origin": "https://docs.acme.com"})
        self.assertEqual(r.status_code, 401)

    async def test_consent_required_for_non_members_and_remembered(self):
        r = await self.http.get("/api/v1/auth/tenant-token/consent", params={"host": "docs.acme.com"},
                                headers=self.reader)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["needs_consent"], r.json()["email"]), (True, "reader@example.com"))

        r = await self.http.post("/api/v1/auth/tenant-token", json={"host": "docs.acme.com"}, headers=self.reader)
        self.assertEqual((r.status_code, r.json()["detail"]), (403, "consent_required"))

        r = await self.http.post("/api/v1/auth/tenant-token", json={"host": "docs.acme.com.", "consent": True},
                                 headers=self.reader)
        self.assertEqual(r.status_code, 200, r.text)
        payload = jwt.decode(r.json()["token"], options={"verify_signature": False})
        self.assertEqual((payload["typ"], payload["host"], payload["ws"]), ("tenant", "docs.acme.com", self.ws))
        self.assertNotIn("email", payload)  # the token sits on the customer's origin

        # Remembered: silent next time.
        r = await self.http.post("/api/v1/auth/tenant-token", json={"host": "docs.acme.com"}, headers=self.reader)
        self.assertEqual(r.status_code, 200, r.text)

    async def test_members_are_not_asked(self):
        r = await self.http.get("/api/v1/auth/tenant-token/consent", params={"host": "docs.acme.com"},
                                headers=self.auth)
        self.assertFalse(r.json()["needs_consent"])
        r = await self.http.post("/api/v1/auth/tenant-token", json={"host": "docs.acme.com"}, headers=self.auth)
        self.assertEqual(r.status_code, 200, r.text)

    async def test_no_token_for_cdn_or_unattached_hosts(self):
        await self.live_domain("files.acme.com", kind="cdn")
        r = await self.http.post("/api/v1/auth/tenant-token", json={"host": "files.acme.com", "consent": True},
                                 headers=self.auth)
        self.assertEqual(r.status_code, 404)
        await self.db["domains"].update_one({"host": "docs.acme.com"}, {"$set": {"attached": False}})
        r = await self.http.post("/api/v1/auth/tenant-token", json={"host": "docs.acme.com"}, headers=self.auth)
        self.assertEqual(r.status_code, 404)

    async def test_outstanding_tokens_die_with_the_domain(self):
        token, _ = create_tenant_token(self.reader_id, "reader@example.com", self.ws, "docs.acme.com")
        h = {"Authorization": f"Bearer {token}", "Origin": "https://docs.acme.com"}
        self.assertEqual((await self.http.get("/api/v1/auth/me", headers=h)).status_code, 200)
        await self.db["domains"].update_one({"host": "docs.acme.com"}, {"$set": {"status": "lapsed"}})
        self.assertEqual((await self.http.get("/api/v1/auth/me", headers=h)).status_code, 401)
        # A token naming another workspace for this host is refused too.
        await self.db["domains"].update_one({"host": "docs.acme.com"}, {"$set": {"status": "verified"}})
        other, _ = create_tenant_token(self.reader_id, "reader@example.com", "someone-else", "docs.acme.com")
        r = await self.http.get("/api/v1/auth/me", headers={**h, "Authorization": f"Bearer {other}"})
        self.assertEqual(r.status_code, 401)

    async def test_tenant_token_cannot_mint_or_read_consent(self):
        token, _ = create_tenant_token(self.reader_id, "reader@example.com", self.ws, "docs.acme.com")
        h = {"Authorization": f"Bearer {token}", "Origin": "https://docs.acme.com"}
        r = await self.http.post("/api/v1/auth/tenant-token", json={"host": "docs.acme.com", "consent": True},
                                 headers=h)
        self.assertEqual(r.status_code, 401)


class TenantCors(DomainCase):
    async def preflight(self, origin: str):
        return await self.http.options("/api/v1/documents/x", headers={
            "Origin": origin, "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization"})

    async def test_live_app_https_origin_gets_explicit_headers(self):
        await self.live_domain()
        r = await self.preflight("https://docs.acme.com")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["access-control-allow-origin"], "https://docs.acme.com")
        allow = [h.strip().lower() for h in r.headers["access-control-allow-headers"].split(",")]
        self.assertIn("authorization", allow)
        self.assertNotIn("*", allow)
        self.assertNotIn("*", r.headers["access-control-allow-methods"])
        self.assertIn("X-Markdrop-Gate", r.headers["access-control-expose-headers"])

    async def test_http_cdn_and_unattached_origins_get_nothing(self):
        await self.live_domain()
        await self.live_domain("files.acme.com", kind="cdn")
        for origin in ("http://docs.acme.com", "https://files.acme.com", "https://docs.acme.com:8443"):
            r = await self.preflight(origin)
            self.assertNotEqual(r.headers.get("access-control-allow-origin"), origin, origin)
        await self.db["domains"].update_one({"host": "docs.acme.com"}, {"$set": {"attached": False}})
        tenant_cors.clear_cache()
        r = await self.preflight("https://docs.acme.com")
        self.assertIsNone(r.headers.get("access-control-allow-origin"))


class InternalExemption(McpTestCase):
    async def test_signed_server_requests_skip_per_ip_limits(self):
        secret = "s3cret-internal"
        with mock.patch.object(settings, "internal_secret", secret):
            sig = internal_mw.sign(int(time.time() // internal_mw.WINDOW_SECONDS), secret)
            for _ in range(70):
                r = await self.http.get("/api/v1/documents/nope-nope", headers={"X-Markdrop-Internal": sig})
                self.assertEqual(r.status_code, 404)
            # A forged or stale signature is just another anonymous caller.
            stale = internal_mw.sign(int(time.time() // internal_mw.WINDOW_SECONDS) - 5, secret)
            codes = [
                (await self.http.get("/api/v1/documents/nope-nope", headers={"X-Markdrop-Internal": h})).status_code
                for h in (["v1.1.deadbeef", stale] * 31)
            ]
            self.assertIn(429, codes)

    def test_signature_checks(self):
        now = 1_800_000_000.0
        b = int(now // 600)
        self.assertTrue(internal_mw.is_valid(internal_mw.sign(b, "k"), "k", now))
        self.assertTrue(internal_mw.is_valid(internal_mw.sign(b - 1, "k"), "k", now))
        self.assertFalse(internal_mw.is_valid(internal_mw.sign(b - 2, "k"), "k", now))
        self.assertFalse(internal_mw.is_valid(internal_mw.sign(b, "other"), "k", now))
        self.assertFalse(internal_mw.is_valid(internal_mw.sign(b, "k"), "", now))  # no secret: nothing exempt


def _png(w=640, h=360) -> bytes:
    from PIL import Image

    buf = BytesIO()
    Image.new("RGB", (w, h), (200, 30, 30)).save(buf, format="PNG")
    return buf.getvalue()


class OgPoster(McpTestCase):
    async def doc(self, slug: str, **extra):
        await self.db["documents"].insert_one({
            "slug": slug, "kind": "artifact", "mime": "video/mp4", "title": "Launch",
            "content": "launch.mp4", "size_bytes": 1000, "access_level": "link",
            "poster_key": f"art/u/{slug}-poster.jpg", "blob_key": f"art/u/{slug}.mp4",
            "created_at": datetime.now(timezone.utc), **extra,
        })

    async def test_link_level_video_card_reads_poster_from_r2(self):
        await self.doc("vid")
        await self.doc("locked", read_password_hash="x")
        await self.doc("priv", access_level="private")
        calls = []

        def get_bytes(key, cap):
            calls.append(key)
            return _png()

        from app.services import r2

        with mock.patch.object(r2, "is_configured", return_value=True), \
                mock.patch.object(r2, "get_bytes", get_bytes):
            r = await self.http.get("/api/v1/og/vid.png")
            self.assertEqual((r.status_code, r.headers["content-type"]), (200, "image/png"))
            for slug in ("locked", "priv"):
                self.assertEqual((await self.http.get(f"/api/v1/og/{slug}.png")).status_code, 200)
        self.assertEqual(calls, ["art/u/vid-poster.jpg"])

    def test_render_with_and_without_poster(self):
        base = og_render.Card(kind="artifact", title="Launch demo", slug="vid",
                              artifact_renderer="video", artifact_label="Video")
        plain = og_render.render_og_png(base)
        framed = og_render.render_og_png(og_render.Card(**{**base.__dict__, "poster": _png()}))
        broken = og_render.render_og_png(og_render.Card(**{**base.__dict__, "poster": b"not an image"}))
        self.assertNotEqual(plain, framed)
        self.assertEqual(plain, broken)  # an undecodable poster falls back to the glyph card
        from PIL import Image

        img = Image.open(BytesIO(framed)).convert("RGB")
        self.assertEqual(img.size, (1200, 630))
        # The poster's red shows inside the frame.
        r, g, b = img.getpixel((og_render._POSTER_X + 30, og_render._POSTER_Y + 30))
        self.assertGreater(r, 150)
        self.assertLess(g, 80)


class MediaUrlTtl(unittest.TestCase):
    def test_video_and_audio_tokens_outlive_playback(self):
        # Lifetime follows the type (publicity.ttl_for), applied when byte URLs are minted.
        from app.services import publicity

        with mock.patch.object(settings, "artifact_signing_key", "k"):
            for mime, ttl in (("video/mp4", 4 * 3600), ("audio/mpeg", 4 * 3600),
                              ("application/pdf", 900), ("", 900), ("image/jpeg", 900)):
                key = "art/u/x"
                token = artifact.sign_access_token(key, epoch=0, ttl=publicity.ttl_for(mime))
                claims = jwt.decode(token, "k", algorithms=["HS256"])
                self.assertEqual(claims["exp"] - claims["iat"], ttl, mime)


class ApexGuess(unittest.TestCase):
    def test_guesses(self):
        g = domain_service.apex_guess
        self.assertEqual(g("acme.com"), (True, True))
        self.assertEqual(g("docs.acme.com"), (False, True))
        self.assertEqual(g("acme.co.uk"), (True, False))
        self.assertEqual(g("docs.acme.co.uk"), (False, True))
        self.assertEqual(g("acme.ab.cd"), (False, False))
        self.assertEqual(g("Acme.com."), (True, True))

    def test_response_offers_both_records_when_unsure(self):
        from app.routers.domains import _routing_options

        certain, opts = _routing_options("acme.co.uk")
        self.assertFalse(certain)
        self.assertEqual([o.type for o in opts], ["A", "CNAME"])
        certain, opts = _routing_options("docs.acme.com")
        self.assertEqual((certain, [o.type for o in opts]), (True, ["CNAME"]))

    def test_clean_host(self):
        c = domain_service.clean_host
        self.assertEqual(c("HTTPS://Docs.Acme.com.:443/x"), "docs.acme.com")
        self.assertEqual(c("docs.acme.com."), "docs.acme.com")
        self.assertEqual(c(None), "")


if __name__ == "__main__":
    unittest.main()
