"""A guide on its own domain (services/docs_custom_domains.py, routers/docs_site_domains.py): Cloudflare
for SaaS custom hostnames. Cloudflare is an httpx.MockTransport here; nothing reaches the network,
and the docs bucket is a folder (MARKDROP_DOCS_STORE_DIR)."""

from __future__ import annotations

from tests import _email_env as env  # noqa: F401  (pins settings first)

import json
import os
import uuid
from unittest import mock

import httpx
from bson import ObjectId

from app.config import get_settings
from app.services import docs_build, docs_custom_domains as cd, docs_dispatch, docs_jobs, docs_site_store, docs_snapshot
from app.services.docs_jobs import BUILDS, JOBS, SITES
from tests._docs_sites_env import DocsSitesCase
from tests.test_docs_build_worker import JS, DbCase, utc

TOKEN = "cf-saas-test-token-never-logged"
ZONE = "0123456789abcdef0123456789abcdef"
HOST = "help.acme.com"
BAD = ["markdrop.in", "www.markdrop.in", "x.y.markdrop.in", "acme.guides.markdrop.in", "guides.markdrop.in",
       "cname.guides.markdrop.in", "evilmarkdrop.in", "api.markdrop.in", "1.2.3.4", "[::1]", "::1", "localhost",
       "foo", "acme.com", "acme.co.uk", "help.acme.local", "x.workers.dev", "docs.vercel.app", "-a.acme.com",
       "a_b.acme.com", "help.acme.123", "ünicode.acme.com", "a..acme.com", "", None, 42, ("a" * 64) + ".acme.com",
       "help.acme.com\n", "help.example.com"]
GOOD = ["help.acme.com", "docs.acme.co.uk", "help.xn--bcher-kva.de", "a1-b2.docs.acme.io"]


class FakeSaaS:
    """The custom hostnames API of one zone, in memory."""

    def __init__(self):
        self.rows: dict[str, dict] = {}
        self.calls: list[tuple[str, str]] = []
        self.fail = 0  # this many next calls answer 500
        self.nudges = 0

    def handler(self, req: httpx.Request) -> httpx.Response:
        assert req.url.host == "api.cloudflare.com"
        assert req.headers["authorization"] == f"Bearer {TOKEN}"
        self.calls.append((req.method, req.url.path))
        if self.fail:
            self.fail -= 1
            return httpx.Response(500, json={"success": False, "errors": [{"code": 1000, "message": "boom"}]})
        base = f"/client/v4/zones/{ZONE}/custom_hostnames"
        ok = lambda res: httpx.Response(200, json={"success": True, "errors": [], "messages": [], "result": res})  # noqa: E731
        if req.method == "GET" and req.url.path == base:
            host = req.url.params.get("hostname")
            return ok([r for r in self.rows.values() if not host or r["hostname"] == host])
        if req.method == "POST" and req.url.path == base:
            body = json.loads(req.content)
            assert set(body) == {"hostname", "ssl"}, body
            assert body["ssl"]["method"] == "http" and body["ssl"]["type"] == "dv", body
            if any(r["hostname"] == body["hostname"] for r in self.rows.values()):
                return httpx.Response(409, json={"success": False, "errors": [{"code": 1406, "message": "Duplicate custom hostname found."}]})
            rid = str(uuid.uuid4())
            r = {"id": rid, "hostname": body["hostname"], "status": "pending",
                 "ssl": {"status": "initializing", "method": "http", "type": "dv", "validation_records": []},
                 "ownership_verification": {"type": "txt", "name": f"_cf-custom-hostname.{body['hostname']}", "value": str(uuid.uuid4())},
                 "verification_errors": ["custom hostname does not CNAME to this zone."]}
            self.rows[rid] = r
            return ok(r)
        if req.url.path.startswith(base + "/"):
            rid = req.url.path.rsplit("/", 1)[1]
            r = self.rows.get(rid)
            if r is None:
                return httpx.Response(404, json={"success": False, "errors": [{"code": 1436, "message": "not found"}]})
            if req.method == "GET":
                return ok(r)
            if req.method == "PATCH":
                assert set(json.loads(req.content)) == {"ssl"}
                self.nudges += 1
                return ok(r)
            if req.method == "DELETE":
                del self.rows[rid]
                return ok({"id": rid})
        return httpx.Response(400, json={"success": False, "errors": [{"code": 1, "message": "bad"}]})

    def by_host(self, host: str) -> dict | None:
        return next((r for r in self.rows.values() if r["hostname"] == host), None)

    def activate(self, host: str) -> None:
        r = self.by_host(host)
        r.update(status="active", verification_errors=[])
        r["ssl"]["status"] = "active"

    def writes(self) -> list[tuple[str, str]]:
        return [c for c in self.calls if c[0] != "GET"]


def _configure(case, cf: FakeSaaS | None) -> None:
    for k, v in {"docs_cf_api_token": TOKEN, "docs_cf_zone_id": ZONE, "docs_cf_zone_name": "markdrop.in",
                 "docs_custom_domain_target": "cname.guides.markdrop.in"}.items():
        p = mock.patch.object(JS, k, v)
        p.start()
        case.addCleanup(p.stop)
    if cf is not None:
        p = mock.patch.object(cd, "_TRANSPORT", httpx.MockTransport(cf.handler))
        p.start()
        case.addCleanup(p.stop)


class DomainCase(DbCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.cf = FakeSaaS()
        _configure(self, self.cf)

    async def site(self, s) -> dict:
        return await self.db[SITES].find_one({"_id": s["_id"]})

    async def entry(self, s, host=HOST) -> dict | None:
        return next((d for d in (await self.site(s)).get("domains") or [] if d["host"] == host), None)

    async def run_domain_jobs(self) -> list[dict]:
        """Every queued domain job, run the way the API does (inline, through the dispatcher)."""
        out = []
        for job in await self.db[JOBS].find({"kind": "domain", "status": "queued"}).to_list(50):
            self.assertTrue(await docs_dispatch.run_server_job_here(self.db, job))
            out.append(await self.db[JOBS].find_one({"_id": job["_id"]}))
        return out

    async def go_live(self, s) -> dict:
        await self.make_page(s, "/")
        build, job = await self.publish(s)
        out = await self.run_build(job, {"ok": True, "manifest_hash": os.urandom(32).hex()})
        self.assertTrue(out["ok"], out)
        return build

    def mapping(self, host=HOST) -> str | None:
        f = os.path.join(self.store, "hosts", f"{host}.json")
        if not os.path.exists(f):
            return None
        with open(f) as fh:
            return json.load(fh)["site"]

    async def due_now(self, s, host=HOST) -> None:
        await self.db[SITES].update_one({"_id": s["_id"], "domains.host": host},
                                        {"$set": {"domains.$.next_check_at": utc(seconds=-1)}})


class HostnameRulesTests(DomainCase):
    async def test_refused_names(self):
        for h in BAD:
            self.assertIsNotNone(cd.host_problem(h), repr(h))
        for h in GOOD:
            self.assertIsNone(cd.host_problem(h), h)
        self.assertIn("subdomain", cd.host_problem("acme.com"))
        self.assertIn("IP address", cd.host_problem("1.2.3.4"))
        self.assertIn("Markdrop", cd.host_problem("docs.markdrop.in"))

    async def test_clean(self):
        self.assertEqual(cd.clean("https://Help.Acme.com:443/x?y#z"), "help.acme.com")
        self.assertEqual(cd.clean("  HELP.acme.com.  "), "help.acme.com")
        self.assertEqual(cd.clean(None), "")

    async def test_refused_names_never_reach_cloudflare(self):
        async with cd._client() as c:
            for h in BAD:
                for call in (cd.cf_create(c, h), cd.cf_find(c, h), cd.cf_delete(c, h, "abc")):
                    with self.assertRaises(cd.DomainRefused, msg=repr(h)):
                        await call
        self.assertEqual(self.cf.calls, [])

    async def test_add_validates(self):
        s = await self.make_site("acme")
        for h in ("markdrop.in", "acme.com", "10.0.0.1", "nonsense"):
            with self.assertRaises(ValueError, msg=h):
                await cd.add(self.db, s, h, "u1")
        self.assertEqual((await self.site(s))["domains"], [])
        self.assertEqual(await self.db[JOBS].count_documents({"kind": "domain"}), 0)


class LifecycleTests(DomainCase):
    async def test_add_check_live_remove(self):
        s = await self.make_site("acme")
        live_build = await self.go_live(s)
        host = await cd.add(self.db, await self.site(s), "https://HELP.acme.com/", "u1")
        self.assertEqual(host, HOST)
        e = await self.entry(s)
        self.assertEqual((e["status"], e["stage"]), ("pending", "dns"))
        self.assertEqual(e["records"], [{"type": "CNAME", "name": HOST, "value": "cname.guides.markdrop.in",
                                         "purpose": "route", "optional": False}])
        # The job creates the hostname right away and records what Cloudflare says.
        [job] = await self.run_domain_jobs()
        self.assertEqual(job["status"], "done", job)
        self.assertEqual(self.cf.writes(), [("POST", f"/client/v4/zones/{ZONE}/custom_hostnames")])
        e = await self.entry(s)
        self.assertEqual(e["cf_id"], self.cf.by_host(HOST)["id"])
        self.assertEqual(e["status"], "pending")
        self.assertIn("CNAME", e["message"])
        self.assertEqual([r["purpose"] for r in e["records"]], ["route", "ownership"])
        self.assertEqual(e["records"][1]["name"], f"_cf-custom-hostname.{HOST}")
        self.assertTrue(e["records"][1]["optional"])
        self.assertGreater(docs_jobs.aware(e["next_check_at"]), utc(seconds=30))
        self.assertIsNone(self.mapping())
        self.assertEqual(docs_snapshot.site_hosts(await self.site(s)), ["acme.guides.markdrop.in"])

        # Not due yet: the sweeper leaves it alone.
        self.assertEqual(await cd.requeue_due(self.db), 0)
        # Due, still pending: checked again, backoff grows.
        await self.due_now(s)
        self.assertEqual(await cd.requeue_due(self.db), 1)
        self.assertEqual(await cd.requeue_due(self.db), 0)  # one waiting job covers it
        await self.run_domain_jobs()
        e = await self.entry(s)
        self.assertEqual(e["checks"], 2)
        self.assertGreater(docs_jobs.aware(e["next_check_at"]), utc(minutes=4))
        self.assertEqual(len([c for c in self.cf.writes() if c[0] == "POST"]), 1)  # read, not created again

        # Cloudflare issues the certificate: live, mapped, and the live version published again.
        self.cf.activate(HOST)
        await self.due_now(s)
        await cd.requeue_due(self.db)
        await self.run_domain_jobs()
        e = await self.entry(s)
        self.assertEqual((e["status"], e["stage"], e["message"]), ("live", None, None))
        self.assertIsNone(e["next_check_at"])
        self.assertEqual(self.mapping(), str(s["_id"]))
        site = await self.site(s)
        self.assertEqual(docs_snapshot.site_hosts(site), ["acme.guides.markdrop.in", HOST])
        self.assertEqual(docs_snapshot.site_url(site), f"https://{HOST}")
        again = await self.db[BUILDS].find_one({"site_id": s["_id"], "republish": "domain_live"})
        self.assertIsNotNone(again)
        self.assertEqual(again["snapshot_id"], live_build["snapshot_id"])
        self.assertEqual(again["note"], cd.REPUBLISH_NOTE)
        job = await self.db[JOBS].find_one({"_id": again["job_id"]})
        spec = await docs_build.build_spec(self.db, job)
        self.assertEqual(spec["publish"]["hosts"], ["acme.guides.markdrop.in", HOST])
        self.assertEqual(json.loads(spec["bundle"]["files"]["site.json"])["url"], f"https://{HOST}")
        events = {r["kind"] async for r in self.db["docs_events"].find({"site_id": s["_id"]})}
        self.assertIn("docs_domain_live", events)
        # Nothing more to check while live.
        self.assertEqual(await cd.requeue_due(self.db), 0)
        # Re-check while live: no second republish.
        await self.db[JOBS].update_one({"_id": job["_id"]}, {"$set": {"status": "done"}})
        self.assertTrue(await cd.check_now(self.db, site, HOST))
        self.assertEqual(await self.db[BUILDS].count_documents({"site_id": s["_id"], "republish": "domain_live"}), 1)

        # Remove: Cloudflare hostname and mapping gone, entry dropped, published again at the free address.
        self.assertTrue(await cd.remove(self.db, site, HOST, "u1"))
        self.assertEqual((await self.entry(s))["status"], "removing")
        await self.run_domain_jobs()
        self.assertIsNone(await self.entry(s))
        self.assertIsNone(self.cf.by_host(HOST))
        self.assertIsNone(self.mapping())
        site = await self.site(s)
        self.assertEqual(docs_snapshot.site_url(site), "https://acme.guides.markdrop.in")
        back = await self.db[BUILDS].find_one({"site_id": s["_id"], "republish": "domain_removed"})
        self.assertIsNotNone(back)
        # The name is free for another guide.
        other = await self.make_site("other")
        await cd.add(self.db, other, HOST, "u1")

    async def test_a_draft_guide_maps_its_domain_at_its_first_publish(self):
        s = await self.make_site("acme")
        await cd.add(self.db, s, HOST, "u1")
        await self.run_domain_jobs()
        self.cf.activate(HOST)
        self.assertTrue(await cd.check_now(self.db, await self.site(s), HOST))
        self.assertEqual((await self.entry(s))["status"], "live")
        self.assertIsNone(self.mapping())  # not live: nothing to serve yet
        self.assertEqual(await self.db[BUILDS].count_documents({"site_id": s["_id"]}), 0)  # no republish
        await self.make_page(s, "/")
        _build, job = await self.publish(s)
        spec = await docs_build.build_spec(self.db, job)
        self.assertIn(HOST, spec["publish"]["hosts"])

    async def test_a_stale_mapping_is_freed_but_another_sites_is_never_taken(self):
        s = await self.make_site("acme")
        await self.go_live(s)
        os.makedirs(os.path.join(self.store, "hosts"), exist_ok=True)
        gone = str(ObjectId())  # a site that no longer holds the host (deleted long ago)
        with open(os.path.join(self.store, "hosts", f"{HOST}.json"), "w") as f:
            json.dump({"site": gone}, f)
        await cd.add(self.db, await self.site(s), HOST, "u1")
        self.cf.rows["x"] = {"id": "x", "hostname": HOST, "status": "active", "ssl": {"status": "active"}}
        await self.run_domain_jobs()
        self.assertEqual(self.mapping(), str(s["_id"]))
        self.assertEqual(self.cf.writes(), [])  # the existing hostname was adopted, not created again
        # The edge mapping helper never overwrites another site's mapping.
        store = docs_build.default_store()
        self.assertEqual(docs_build.ensure_hosts(store, "someone-else", [HOST]), [])
        self.assertEqual(self.mapping(), str(s["_id"]))

    async def test_give_up_after_72_hours_then_recheck_starts_over(self):
        s = await self.make_site("acme")
        await cd.add(self.db, s, HOST, "u1")
        await self.run_domain_jobs()
        await self.db[SITES].update_one({"_id": s["_id"], "domains.host": HOST}, {"$set": {
            "domains.$.pending_since": utc(hours=-73), "domains.$.next_check_at": utc(seconds=-1)}})
        await cd.requeue_due(self.db)
        await self.run_domain_jobs()
        e = await self.entry(s)
        self.assertEqual(e["status"], "failed")
        self.assertIn("72 hours", e["message"])
        self.assertIsNone(e["cf_id"])
        self.assertIsNone(self.cf.by_host(HOST))  # deleted: it would count against the free 100
        self.assertEqual(await cd.requeue_due(self.db), 0)  # failed: no more checks
        # Re-check: created again, pending, the 72 hours start now.
        self.assertTrue(await cd.check_now(self.db, await self.site(s), HOST))
        e = await self.entry(s)
        self.assertEqual((e["status"], e["checks"]), ("pending", 0))
        self.assertGreater(docs_jobs.aware(e["pending_since"]), utc(minutes=-1))
        self.assertIsNotNone(self.cf.by_host(HOST))

    async def test_recheck_nudges_cloudflare(self):
        s = await self.make_site("acme")
        await cd.add(self.db, s, HOST, "u1")
        await self.run_domain_jobs()
        self.assertTrue(await cd.check_now(self.db, await self.site(s), HOST))
        self.assertEqual(self.cf.nudges, 1)
        self.assertFalse(await cd.check_now(self.db, await self.site(s), "other.acme.com"))

    async def test_cloudflare_errors(self):
        s = await self.make_site("acme")
        await cd.add(self.db, s, HOST, "u1")
        # A check that can't reach Cloudflare: the job is done, the domain is checked again later.
        self.cf.fail = 5
        [job] = await self.run_domain_jobs()
        self.assertEqual(job["status"], "done")
        e = await self.entry(s)
        self.assertEqual((e["status"], e["checks"]), ("pending", 1))
        self.assertIn("errors", job["result"])
        self.assertNotIn(TOKEN, json.dumps(job["result"]))
        with self.assertRaises(cd.DomainError):
            self.cf.fail = 5
            await cd.check_now(self.db, await self.site(s), HOST)
        # A removal that can't reach Cloudflare: the job is retried, the entry stays until it's done.
        self.cf.fail = 0
        await self.due_now(s)
        await cd.requeue_due(self.db)
        await self.run_domain_jobs()
        self.assertIsNotNone(self.cf.by_host(HOST))
        await cd.remove(self.db, await self.site(s), HOST, "u1")
        self.cf.fail = 5
        [job] = await self.run_domain_jobs()
        self.assertEqual(job["status"], "queued")  # retry_later
        self.assertNotIn(TOKEN, job["error"])
        self.assertEqual((await self.entry(s))["status"], "removing")
        self.cf.fail = 0
        await self.run_domain_jobs()
        self.assertIsNone(await self.entry(s))
        self.assertIsNone(self.cf.by_host(HOST))

    async def test_deleting_the_guide_removes_its_domains(self):
        s = await self.make_site("acme")
        await self.go_live(s)
        await cd.add(self.db, await self.site(s), HOST, "u1")
        await self.run_domain_jobs()
        self.cf.activate(HOST)
        await cd.check_now(self.db, await self.site(s), HOST)
        self.assertEqual(self.mapping(), str(s["_id"]))
        await docs_site_store.delete_site(self.db, await self.site(s), "u1")
        await self.run_domain_jobs()
        self.assertEqual((await self.site(s))["domains"], [])
        self.assertIsNone(self.cf.by_host(HOST))
        self.assertIsNone(self.mapping())

    async def test_one_guide_per_domain_and_two_per_guide(self):
        a, b = await self.make_site("acme"), await self.make_site("globex")
        await cd.add(self.db, a, HOST, "u1")
        with self.assertRaises(LookupError):
            await cd.add(self.db, await self.site(b), HOST, "u1")
        with self.assertRaises(ValueError):
            await cd.add(self.db, await self.site(a), HOST, "u1")  # already on this guide
        await cd.add(self.db, await self.site(a), "docs.acme.com", "u1")
        with self.assertRaises(ValueError):
            await cd.add(self.db, await self.site(a), "kb.acme.com", "u1")
        # A workspace's own domain can't be a guide's too.
        await self.db["domains"].insert_one({"host": "files.acme.com", "workspace_id": "w1", "status": "verified"})
        with self.assertRaises(LookupError):
            await cd.add(self.db, await self.site(b), "files.acme.com", "u1")
        # The index holds even past the checks.
        from pymongo.errors import DuplicateKeyError

        with self.assertRaises(DuplicateKeyError):
            await self.db[SITES].update_one({"_id": b["_id"]}, {"$push": {"domains": {"host": HOST, "status": "pending"}}})


class NotConfiguredTests(DbCase):
    async def test_off_without_a_token_or_zone(self):
        cf = FakeSaaS()
        _configure(self, cf)
        for k in ("docs_cf_api_token", "docs_cf_zone_id"):
            with mock.patch.object(JS, k, ""):
                self.assertFalse(cd.configured())
                self.assertFalse(cd.available()["available"])
                s = await self.make_site(f"acme-{k[-5:].replace('_', '')}")
                with self.assertRaises(PermissionError):
                    await cd.add(self.db, s, HOST, "u1")
                self.assertIsNone(await cd.queue(self.db, s["_id"], "x", [HOST]))
                self.assertEqual(await cd.requeue_due(self.db), 0)
                self.assertEqual(await cd.reconcile(self.db, s["_id"]), {"skipped": "own domains are off"})
        with mock.patch.object(JS, "docs_cf_zone_id", "not a zone id!"):
            self.assertFalse(cd.configured())
        self.assertEqual(cf.calls, [])

    async def test_removal_without_cloudflare_still_frees_the_name(self):
        cf = FakeSaaS()
        _configure(self, cf)
        s = await self.make_site("acme")
        await cd.add(self.db, s, HOST, "u1")
        with mock.patch.object(JS, "docs_cf_api_token", ""):
            self.assertTrue(await cd.remove(self.db, await self.db[SITES].find_one({"_id": s["_id"]}), HOST, "u1"))
        self.assertEqual((await self.db[SITES].find_one({"_id": s["_id"]}))["domains"], [])


class InterpretTests(DomainCase):
    async def test_states(self):
        r = {"id": "a", "hostname": HOST, "status": "active", "ssl": {"status": "pending_validation"}}
        self.assertEqual(cd.interpret(HOST, r)["stage"], "certificate")
        r["ssl"]["status"] = "validation_timed_out"
        self.assertIn("CAA", cd.interpret(HOST, r)["message"])
        r["status"] = "blocked"
        self.assertTrue(cd.interpret(HOST, r)["blocked"])
        r = {"id": "a", "hostname": HOST, "status": "pending", "ssl": {"status": "pending_validation",
             "validation_records": [{"txt_name": f"_acme-challenge.{HOST}", "txt_value": "tok"}],
             "validation_errors": [{"message": "CAA record prevents issuance"}]}}
        i = cd.interpret(HOST, r)
        self.assertEqual((i["stage"], i["message"]), ("dns", "CAA record prevents issuance"))
        self.assertEqual([x["purpose"] for x in cd.records(HOST, r)], ["route", "certificate"])
        self.assertEqual([cd.next_wait(n).total_seconds() for n in (0, 1, 6, 50)], [60, 120, 3600, 3600])


class DomainsApiTests(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.cf = FakeSaaS()
        _configure(self, self.cf)
        p = mock.patch.object(get_settings(), "background_workers_enabled", False)
        p.start()
        self.addCleanup(p.stop)

    async def test_admins_add_check_and_remove(self):
        site = await self.create("acme")
        sid = site["id"]
        self.assertEqual(site["own_domains"], {"available": True, "target": "cname.guides.markdrop.in", "max": 2})
        for who, code in (("editor", 403), ("viewer", 403), ("stranger", 404)):
            await self.call("POST", f"/{sid}/domains", who, expect=code, json={"host": HOST})
        for bad in ("markdrop.in", "acme.com", "1.2.3.4", "x"):
            r = await self.http.post(f"/api/v1/docs-sites/{sid}/domains", json={"host": bad}, headers=self.h["admin"])
            self.assertEqual(r.status_code, 422, bad)
            self.assertIsInstance(r.json()["detail"], str)
        out = await self.call("POST", f"/{sid}/domains", "admin", expect=201, json={"host": "Help.Acme.com"})
        [d] = out["domains"]
        self.assertEqual((d["host"], d["status"], d["stage"]), (HOST, "pending", "dns"))
        self.assertEqual(d["records"][0]["value"], "cname.guides.markdrop.in")
        # Everyone else sees the status, not the records.
        seen = await self.get(f"/{sid}", "viewer")
        self.assertNotIn("records", seen["domains"][0])
        # Unique across guides.
        other = await self.create("globex")
        r = await self.http.post(f"/api/v1/docs-sites/{other['id']}/domains", json={"host": HOST}, headers=self.h["owner"])
        self.assertEqual(r.status_code, 409)
        # Re-check runs now (creates the hostname on Cloudflare).
        await self.call("POST", f"/{sid}/domains/{HOST}/check", "editor", expect=403)
        out = await self.call("POST", f"/{sid}/domains/{HOST}/check", "owner")
        self.assertEqual(out["domains"][0]["records"][1]["purpose"], "ownership")
        await self.call("POST", f"/{sid}/domains/nope.acme.com/check", "owner", expect=404)
        self.cf.fail = 5
        await self.call("POST", f"/{sid}/domains/{HOST}/check", "owner", expect=502)
        self.cf.fail = 0
        # Remove.
        await self.call("DELETE", f"/{sid}/domains/{HOST}", "editor", expect=403)
        out = await self.call("DELETE", f"/{sid}/domains/{HOST}", "admin")
        self.assertEqual(out["domains"][0]["status"], "removing")
        await self.call("DELETE", f"/{sid}/domains/nope.acme.com", "admin", expect=404)
        events = {r["kind"] async for r in self.db["docs_events"].find({})}
        self.assertIn("docs_domain_added", events)

    async def test_not_available_without_cloudflare(self):
        site = await self.create("acme")
        with mock.patch.object(JS, "docs_cf_api_token", ""):
            got = await self.get(f"/{site['id']}")
            self.assertFalse(got["own_domains"]["available"])
            await self.call("POST", f"/{site['id']}/domains", "owner", expect=503, json={"host": HOST})

