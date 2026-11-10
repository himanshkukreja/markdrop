"""Workspace custom domains on Cloudflare for SaaS (services/cf_saas.py, scripts/cf_saas_migrate.py).

The provider switch (MARKDROP_DOMAIN_PROVIDER), create / status / delete of custom hostnames and their
Worker routes, the pre-validation records the Domains card shows (admins only), the HTTP ownership
token served on the host, the Guides' hostnames left alone, and the migration script's dry run / apply.
Cloudflare is an httpx.MockTransport (nothing reaches the network); DNS checks are faked.
"""

from __future__ import annotations

import itertools
import json
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlparse

import httpx

from tests._mcp_env import McpTestCase, settings
from tests.test_domains_lifecycle import T0, Clock, DnsFake

from app.middleware import tenant_cors
from app.services import cf_saas, domain as domain_service
from scripts import cf_saas_migrate

ZONE = "f659211bf294127beb6fef68eeeffa85"


class CfFake:
    """The custom hostnames and Worker routes API of one zone."""

    def __init__(self):
        self.hostnames: dict[str, dict] = {}
        self.routes: list[dict] = []
        self.calls: list[tuple[str, str]] = []
        self._ids = itertools.count(1)

    def activate(self, host: str, *, ownership: bool = True, ssl: bool = True):
        r = self.hostnames[host]
        if ownership:
            r["status"] = "active"
        if ssl:
            r["ssl"]["status"] = "active"

    @staticmethod
    def ok(result, status: int = 200) -> httpx.Response:
        return httpx.Response(status, json={"success": True, "errors": [], "result": result})

    def handler(self, request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        self.calls.append((method, path))
        assert request.headers["authorization"] == "Bearer test-token"
        base = f"/client/v4/zones/{ZONE}"
        if path == f"{base}/custom_hostnames":
            if method == "GET":
                want = parse_qs(urlparse(str(request.url)).query).get("hostname", [""])[0]
                return self.ok([r for h, r in self.hostnames.items() if h == want])
            body = json.loads(request.content)
            host = body["hostname"]
            if host in self.hostnames:
                return httpx.Response(409, json={"success": False, "errors": [{"code": 1406, "message": "Duplicate custom hostname found."}]})
            cid = f"ch-{next(self._ids)}"
            self.hostnames[host] = {
                "id": cid, "hostname": host, "status": "pending",
                "ssl": {**body["ssl"], "status": "pending_validation",
                        "validation_records": [{"txt_name": f"_acme-challenge.{host}", "txt_value": f"dcv-{host}"}]},
                "ownership_verification": {"type": "txt", "name": f"_cf-custom-hostname.{host}", "value": f"own-{host}"},
                "ownership_verification_http": {
                    "http_url": f"http://{host}/.well-known/cf-custom-hostname-challenge/{cid}", "http_body": f"body-{host}"},
            }
            return self.ok(self.hostnames[host], 201)
        if path.startswith(f"{base}/custom_hostnames/"):
            cid = path.rsplit("/", 1)[1]
            host = next((h for h, r in self.hostnames.items() if r["id"] == cid), None)
            if host is None:
                return httpx.Response(404, json={"success": False, "errors": [{"code": 1436, "message": "not found"}]})
            if method == "DELETE":
                del self.hostnames[host]
                return self.ok({"id": cid})
            if method == "PATCH":
                self.hostnames[host]["ssl"].update(json.loads(request.content)["ssl"])
            return self.ok(self.hostnames[host])
        if path == f"{base}/workers/routes":
            if method == "GET":
                return self.ok(list(self.routes))
            body = json.loads(request.content)
            self.routes.append({"id": f"rt-{next(self._ids)}", **body})
            return self.ok(self.routes[-1])
        if path.startswith(f"{base}/workers/routes/") and method == "DELETE":
            rid = path.rsplit("/", 1)[1]
            self.routes = [r for r in self.routes if r["id"] != rid]
            return self.ok({"id": rid})
        return httpx.Response(404, json={"success": False, "errors": [{"code": 0, "message": f"no {method} {path}"}]})

    def writes(self) -> list[tuple[str, str]]:
        return [c for c in self.calls if c[0] != "GET"]


class CfCase(McpTestCase):
    PROVIDER = "cloudflare_saas"
    CONFIGURED = True

    async def asyncSetUp(self):
        await super().asyncSetUp()
        await domain_service.ensure_indexes(self.db)
        tenant_cors.clear_cache()
        self.dns = DnsFake()
        self.cf = CfFake()
        self.vercel_attached: list[str] = []

        async def vercel_attach(host):
            self.vercel_attached.append(host)
            return True, None

        self._patches = [
            mock.patch.object(domain_service, "check_txt", self.dns.check_txt),
            mock.patch.object(domain_service, "check_routing", self.dns.check_routing),
            mock.patch.object(domain_service, "_now", Clock(T0)),
            mock.patch.object(domain_service, "_vercel_attach", vercel_attach),
            mock.patch.object(type(settings), "vercel_domains_configured", new_callable=mock.PropertyMock, return_value=True),
            mock.patch.object(domain_service, "_vercel_detach", mock.AsyncMock(return_value=True)),
            mock.patch.object(cf_saas, "_TRANSPORT", httpx.MockTransport(self.cf.handler)),
            mock.patch.object(settings, "domain_provider", self.PROVIDER),
            mock.patch.object(settings, "cf_zone_id", ZONE if self.CONFIGURED else ""),
            mock.patch.object(settings, "cf_saas_token", "test-token" if self.CONFIGURED else ""),
            mock.patch.object(cf_saas_migrate, "_nameservers", lambda host: ["ns-1.awsdns-01.com"]),
            mock.patch.object(cf_saas_migrate, "_routing", lambda host: "ok"),
        ]
        for p in self._patches:
            p.start()
        self.auth = {"Authorization": f"Bearer {self.session}"}
        r = await self.http.post("/api/v1/workspaces", json={"name": "Acme"}, headers=self.auth)
        self.assertEqual(r.status_code, 201, r.text)
        self.ws = r.json()["id"]

    async def asyncTearDown(self):
        for p in reversed(self._patches):
            p.stop()
        tenant_cors.clear_cache()
        await super().asyncTearDown()

    async def live_domain(self, host: str = "docs.acme.com") -> dict:
        r = await self.http.post(f"/api/v1/workspaces/{self.ws}/domains", json={"host": host, "kind": "app"}, headers=self.auth)
        self.assertEqual(r.status_code, 201, r.text)
        self.dns.txt[host] = "ok"
        self.dns.routing[host] = "ok"
        return await self.verify(r.json()["id"])

    async def verify(self, domain_id: str) -> dict:
        r = await self.http.post(f"/api/v1/workspaces/{self.ws}/domains/{domain_id}/verify", headers=self.auth)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def listing(self, auth: dict | None = None) -> dict[str, dict]:
        r = await self.http.get(f"/api/v1/workspaces/{self.ws}/domains", headers=auth or self.auth)
        self.assertEqual(r.status_code, 200, r.text)
        return {d["host"]: d for d in r.json()["domains"]}


class CloudflareProvider(CfCase):
    async def test_attach_creates_hostname_and_route_and_shows_records(self):
        d = await self.live_domain()
        self.assertTrue(d["attached"] and d["live"])
        self.assertEqual(self.vercel_attached, [])
        ch = self.cf.hostnames["docs.acme.com"]
        self.assertEqual((ch["ssl"]["method"], ch["ssl"]["type"]), ("txt", "dv"))
        self.assertEqual(self.cf.routes, [{"id": mock.ANY, "pattern": "docs.acme.com/*", "script": "markdrop-web"}])
        row = await self.db["domains"].find_one({"host": "docs.acme.com"})
        self.assertEqual(row["attached_via"], "cloudflare_saas")
        self.assertEqual(row["cf_saas"]["id"], ch["id"])
        self.assertEqual(d["hosting_provider"], "cloudflare_saas")
        self.assertFalse(d["hosting_ready"])
        recs = {r["purpose"]: r for r in d["hosting_records"]}
        self.assertEqual((recs["certificate"]["name"], recs["certificate"]["value"], recs["certificate"]["needed"]),
                         ("_acme-challenge.docs.acme.com", "dcv-docs.acme.com", True))
        self.assertEqual(recs["ownership"]["name"], "_cf-custom-hostname.docs.acme.com")

    async def test_check_dns_reads_status_and_nudges_until_ready(self):
        d = await self.live_domain()
        self.cf.calls.clear()
        d = await self.verify(d["id"])
        self.assertIn(("PATCH", f"/client/v4/zones/{ZONE}/custom_hostnames/{self.cf.hostnames['docs.acme.com']['id']}"),
                      self.cf.calls)
        self.cf.activate("docs.acme.com", ssl=False)
        d = await self.verify(d["id"])
        recs = {r["purpose"]: r["needed"] for r in d["hosting_records"]}
        self.assertEqual(recs, {"certificate": True, "ownership": False})
        self.cf.activate("docs.acme.com")
        self.cf.calls.clear()
        d = await self.verify(d["id"])
        self.assertTrue(d["hosting_ready"])
        self.assertFalse(any(r["needed"] for r in d["hosting_records"]))
        self.assertNotIn("PATCH", [m for m, _ in self.cf.calls])  # ready: no nudge

    async def test_hostname_gone_on_cloudflare_is_recreated_for_a_serving_domain(self):
        d = await self.live_domain()
        self.cf.hostnames.clear()
        await self.verify(d["id"])
        self.assertIn("docs.acme.com", self.cf.hostnames)

    async def test_detach_and_remove_delete_route_and_hostname(self):
        d = await self.live_domain()
        r = await self.http.post(f"/api/v1/workspaces/{self.ws}/domains/{d['id']}/detach", headers=self.auth)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((self.cf.hostnames, self.cf.routes), ({}, []))
        self.assertNotIn("cf_saas", await self.db["domains"].find_one({"host": "docs.acme.com"}))
        r = await self.http.post(f"/api/v1/workspaces/{self.ws}/domains/{d['id']}/attach", headers=self.auth)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("docs.acme.com", self.cf.hostnames)
        r = await self.http.delete(f"/api/v1/workspaces/{self.ws}/domains/{d['id']}", headers=self.auth)
        self.assertEqual(r.status_code, 204, r.text)
        self.assertEqual((self.cf.hostnames, self.cf.routes), ({}, []))

    async def test_route_of_another_worker_is_refused_and_left_alone(self):
        self.cf.routes.append({"id": "rt-x", "pattern": "docs.acme.com/*", "script": "markdrop-docs-edge"})
        d = await self.live_domain()
        self.assertFalse(d["attached"])
        self.assertIn("another Worker", d["last_error"])
        self.assertEqual(len(self.cf.routes), 1)
        self.assertTrue(await cf_saas.remove("docs.acme.com"))
        self.assertEqual(self.cf.routes[0]["script"], "markdrop-docs-edge")

    async def test_a_guides_domain_is_never_touched(self):
        await self.db["docs_sites"].insert_one({"domains": [{"host": "help.acme.com", "status": "live"}]})
        with self.assertRaises(cf_saas.CfSaasRefused):
            await cf_saas.ensure("help.acme.com", db=self.db)
        self.cf.hostnames["help.acme.com"] = {"id": "ch-guide", "hostname": "help.acme.com"}
        self.assertTrue(await cf_saas.remove("help.acme.com", db=self.db))
        self.assertIn("help.acme.com", self.cf.hostnames)
        # through the domain service too (no db in hand: the app's database is used)
        self.assertTrue(await domain_service.detach_from_hosting("help.acme.com"))
        self.assertIn("help.acme.com", self.cf.hostnames)

    async def test_own_names_are_refused_before_any_call(self):
        for host in ("markdrop.in", "edge.markdrop.in", "1.2.3.4", "nodot"):
            with self.subTest(host=host), self.assertRaises(cf_saas.CfSaasRefused):
                await cf_saas.ensure(host)
        self.assertEqual(self.cf.calls, [])

    async def test_records_are_admin_only(self):
        await self.live_domain()
        uid = await self.make_user("member@example.com", "Member")
        await self.db["memberships"].insert_one({"workspace_id": self.ws, "user_id": uid, "role": "member",
                                                 "email": "member@example.com", "created_at": T0})
        from app.utils.auth import create_access_token

        member = {"Authorization": f"Bearer {create_access_token(uid, 'member@example.com')[0]}"}
        d = (await self.listing(member))["docs.acme.com"]
        self.assertEqual((d["hosting_provider"], d["hosting_records"]), (None, []))
        self.assertTrue((await self.listing())["docs.acme.com"]["hosting_records"])


class HostnameChallenge(CfCase):
    async def test_serves_the_exact_token_for_its_host_only(self):
        await self.live_domain()
        ch = self.cf.hostnames["docs.acme.com"]
        path = f"/.well-known/cf-custom-hostname-challenge/{ch['id']}"
        r = await self.http.get("/api/v1/host/challenge", params={"host": "Docs.Acme.com.", "path": path})
        self.assertEqual((r.status_code, r.text), (200, "body-docs.acme.com"))
        self.assertEqual(r.headers["cache-control"], "no-store")
        for host, p in (("docs.acme.com", path + "x"), ("other.acme.com", path), ("docs.acme.com", "/x")):
            with self.subTest(host=host, path=p):
                r = await self.http.get("/api/v1/host/challenge", params={"host": host, "path": p})
                self.assertEqual(r.status_code, 404)


class VercelProviderBeforeTheMove(CfCase):
    PROVIDER = "vercel"

    async def test_attach_stays_on_vercel_and_creates_nothing_on_cloudflare(self):
        d = await self.live_domain()
        self.assertTrue(d["attached"])
        self.assertEqual(self.vercel_attached, ["docs.acme.com"])
        self.assertEqual(self.cf.writes(), [])
        self.assertIsNone(d["hosting_provider"])
        row = await self.db["domains"].find_one({"host": "docs.acme.com"})
        self.assertEqual(row["attached_via"], "vercel")

    async def test_migration_dry_run_writes_nothing_then_apply_prevalidates(self):
        await self.live_domain()
        await self.live_domain("cdn.acme.com")
        items = await cf_saas_migrate.plan(self.db, "dry-run")
        self.assertEqual([(i["host"], i["action"]) for i in items],
                         [("cdn.acme.com", "would create"), ("docs.acme.com", "would create")])
        self.assertEqual(self.cf.writes(), [])
        self.assertIsNone((await self.db["domains"].find_one({"host": "docs.acme.com"})).get("cf_saas"))

        items = await cf_saas_migrate.plan(self.db, "apply")
        self.assertEqual(sorted(self.cf.hostnames), ["cdn.acme.com", "docs.acme.com"])
        self.assertEqual(sorted(r["pattern"] for r in self.cf.routes), ["cdn.acme.com/*", "docs.acme.com/*"])
        out = cf_saas_migrate.render(items, "apply")
        self.assertIn("customer adds: TXT _acme-challenge.docs.acme.com = dcv-docs.acme.com", out)
        self.assertIn("0/2 ready", out)
        # idempotent
        await cf_saas_migrate.plan(self.db, "apply")
        self.assertEqual((len(self.cf.hostnames), len(self.cf.routes)), (2, 2))
        # the Domains card shows the records while Vercel still serves the host
        d = (await self.listing())["docs.acme.com"]
        self.assertEqual(d["hosting_provider"], "cloudflare_saas")
        self.assertIn("_acme-challenge.docs.acme.com", [r["name"] for r in d["hosting_records"]])
        # still attached via Vercel
        self.assertEqual((await self.db["domains"].find_one({"host": "docs.acme.com"}))["attached_via"], "vercel")

        self.cf.activate("docs.acme.com")
        self.cf.activate("cdn.acme.com")
        items = await cf_saas_migrate.plan(self.db, "dry-run")
        self.assertTrue(all(i["ready"] and i["records"] == [] for i in items))
        self.assertIn("2/2 ready", cf_saas_migrate.render(items, "dry-run"))
        d = await self.verify((await self.listing())["docs.acme.com"]["id"])
        self.assertTrue(d["hosting_ready"])

    async def test_removing_a_prevalidated_domain_releases_its_hostname(self):
        d = await self.live_domain()
        await cf_saas_migrate.plan(self.db, "apply")
        r = await self.http.delete(f"/api/v1/workspaces/{self.ws}/domains/{d['id']}", headers=self.auth)
        self.assertEqual(r.status_code, 204, r.text)
        self.assertEqual((self.cf.hostnames, self.cf.routes), ({}, []))

    async def test_after_cutover_needs_the_provider_switch(self):
        rc = await cf_saas_migrate.main(["--after-cutover"])
        self.assertEqual(rc, 2)


class AfterTheMove(CfCase):
    async def test_after_cutover_marks_ready_rows(self):
        with mock.patch.object(settings, "domain_provider", "vercel"):
            await self.live_domain()
            await cf_saas_migrate.plan(self.db, "apply")
        self.cf.activate("docs.acme.com")
        items = await cf_saas_migrate.plan(self.db, "after-cutover")
        self.assertEqual(items[0]["action"], "marked attached_via cloudflare_saas")
        self.assertEqual((await self.db["domains"].find_one({"host": "docs.acme.com"}))["attached_via"], "cloudflare_saas")


class NotConfigured(CfCase):
    PROVIDER = "vercel"
    CONFIGURED = False

    async def test_dry_run_without_credentials_says_so_and_calls_nothing(self):
        await self.live_domain()
        items = await cf_saas_migrate.plan(self.db, "dry-run")
        self.assertIn("credentials not set", items[0]["action"])
        self.assertEqual(self.cf.calls, [])
        self.assertIn("Cloudflare credentials NOT set", cf_saas_migrate.render(items, "dry-run"))

    async def test_cloudflare_provider_without_credentials_is_attach_unavailable(self):
        with mock.patch.object(settings, "domain_provider", "cloudflare_saas"):
            self.assertFalse(domain_service.hosting_configured())


if __name__ == "__main__":
    unittest.main()
