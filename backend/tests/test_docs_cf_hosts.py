"""Free docs addresses on Cloudflare (services/docs_cf_hosts.py): each site's <slug>.guides.markdrop.in
attached to the edge Worker as a Workers Custom Domain. Cloudflare is an httpx.MockTransport here;
nothing reaches the network."""

from __future__ import annotations

from tests import _email_env as env  # noqa: F401  (pins settings first)

import json
import unittest
from unittest import mock

import httpx

from app.services import docs_build, docs_cf_hosts, docs_dispatch, docs_jobs, docs_site_store
from app.services.docs_jobs import BUILDS, JOBS, SITES
from tests.test_docs_build_worker import JS, DbCase

TOKEN = "cf-test-token-never-logged"
ACCOUNT = "0123456789abcdef0123456789abcdef"
WORKER = "markdrop-docs-edge"
FOREIGN = ["www.markdrop.in", "markdrop.in", "a.b.guides.markdrop.in", "evil.com", "x.guides.markdrop.in.evil.com",
           "guides.markdrop.in", "api.markdrop.in", "edge.guides.markdrop.in", "www.guides.markdrop.in",
           "acme.guides.markdrop.in\n", "-acme.guides.markdrop.in", "ACME.guides.markdrop.in.", "", None, 42]


class FakeCloudflare:
    """The Workers domains API, in memory."""

    def __init__(self):
        self.domains: dict[str, dict] = {}
        self.calls: list[tuple[str, str]] = []
        self.fail = 0  # this many next calls answer 500
        self.n = 0

    def handler(self, req: httpx.Request) -> httpx.Response:
        assert req.url.host == "api.cloudflare.com"
        assert req.headers["authorization"] == f"Bearer {TOKEN}"
        self.calls.append((req.method, req.url.path))
        if self.fail:
            self.fail -= 1
            return httpx.Response(500, json={"success": False, "errors": [{"code": 10013, "message": "boom"}]})
        base = f"/client/v4/accounts/{ACCOUNT}/workers/domains"
        if req.method == "GET" and req.url.path == base:
            host = req.url.params.get("hostname")
            res = [d for d in self.domains.values() if not host or d["hostname"] == host]
            return httpx.Response(200, json={"success": True, "errors": [], "messages": [], "result": res,
                                             "result_info": {"count": len(res)}})
        if req.method == "PUT" and req.url.path == base:
            body = json.loads(req.content)
            assert set(body) == {"hostname", "service", "zone_name"}, body
            self.n += 1
            d = {"id": f"dom{self.n}", "hostname": body["hostname"], "service": body["service"],
                 "zone_name": body["zone_name"], "zone_id": "z1", "enabled": True}
            self.domains[d["id"]] = d
            return httpx.Response(200, json={"success": True, "errors": [], "messages": [], "result": d})
        if req.method == "DELETE" and req.url.path.startswith(base + "/"):
            did = req.url.path.rsplit("/", 1)[1]
            if self.domains.pop(did, None) is None:
                return httpx.Response(404, json={"success": False, "errors": [{"code": 100, "message": "nope"}]})
            return httpx.Response(200, json={"success": True, "errors": [], "messages": []})
        return httpx.Response(400, json={"success": False, "errors": [{"code": 1, "message": "bad"}]})

    def hosts(self) -> set[str]:
        return {d["hostname"] for d in self.domains.values() if d["service"] == WORKER}

    def writes(self) -> list[tuple[str, str]]:
        return [c for c in self.calls if c[0] != "GET"]


class CfCase(DbCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.cf = FakeCloudflare()
        for k, v in {"docs_cf_api_token": TOKEN, "docs_cf_account_id": ACCOUNT, "docs_cf_zone_name": "markdrop.in",
                     "docs_cf_worker": WORKER}.items():
            p = mock.patch.object(JS, k, v)
            p.start()
            self.addCleanup(p.stop)
        p = mock.patch.object(docs_cf_hosts, "_TRANSPORT", httpx.MockTransport(self.cf.handler))
        p.start()
        self.addCleanup(p.stop)

    async def cf_jobs(self, status="queued") -> list[dict]:
        return await self.db[JOBS].find({"kind": "cf_host", "status": status}).to_list(50)

    async def run_cf(self) -> list[dict]:
        """Run every queued cf_host job the way the API does (inline, through the dispatcher)."""
        out = []
        for job in await self.cf_jobs():
            self.assertTrue(await docs_dispatch.run_server_job_here(self.db, job))
            out.append(await self.db[JOBS].find_one({"_id": job["_id"]}))
        return out

    async def site(self, s) -> dict:
        return await self.db[SITES].find_one({"_id": s["_id"]})

    async def go_live(self, s) -> None:
        """Publish and run the build to live (the cf_host job the publish queued stays queued)."""
        _, job = await self.publish(s)
        claimed = await docs_jobs.claim_next(self.db, "w1", kinds=("build",), target=None)
        self.assertEqual(claimed["_id"], job["_id"])
        await docs_build.start_build(self.db, claimed)
        h = self.put_manifest(str(s["_id"]))
        out = await docs_build.finish_build(self.db, claimed, "w1", {"ok": True, "manifest_hash": h})
        self.assertTrue(out["ok"], out)


class HostnameSafetyTests(CfCase):
    async def test_foreign_hostnames_are_refused_before_any_call(self):
        for h in FOREIGN:
            self.assertIsNotNone(docs_cf_hosts.host_problem(h), h)
            with self.assertRaises(docs_cf_hosts.CfHostRefused, msg=repr(h)):
                await docs_cf_hosts.ensure_host(h)
            with self.assertRaises(docs_cf_hosts.CfHostRefused, msg=repr(h)):
                await docs_cf_hosts.drop_host(h)
        self.assertEqual(self.cf.calls, [])
        self.assertIsNone(docs_cf_hosts.host_problem("acme.guides.markdrop.in"))
        self.assertIsNone(docs_cf_hosts.host_problem("a1-b2.guides.markdrop.in"))

    async def test_a_docs_domain_outside_the_zone_or_the_zone_itself_refuses_everything(self):
        from app.config import get_settings

        with mock.patch.object(get_settings(), "docs_sites_domain", "markdrop.in"):
            self.assertIsNotNone(docs_cf_hosts.host_problem("www.markdrop.in"))
            self.assertIsNotNone(docs_cf_hosts.host_problem("acme.markdrop.in"))
        with mock.patch.object(JS, "docs_cf_zone_name", "example.com"):
            self.assertIsNotNone(docs_cf_hosts.host_problem("acme.guides.markdrop.in"))

    async def test_refused_hosts_in_a_job_are_never_sent(self):
        s = await self.make_site("acme")
        await docs_cf_hosts.queue(self.db, s["_id"], "test", ["www.markdrop.in", "markdrop.in", "a.b.guides.markdrop.in"])
        [job] = await self.run_cf()
        self.assertEqual(job["status"], "done")
        self.assertEqual(sorted(job["result"]["refused"]), ["a.b.guides.markdrop.in", "markdrop.in", "www.markdrop.in"])
        self.assertEqual(self.cf.writes(), [])

    async def test_another_workers_domain_is_left_alone(self):
        self.cf.domains["x"] = {"id": "x", "hostname": "acme.guides.markdrop.in", "service": "someone-else"}
        with self.assertRaises(docs_cf_hosts.CfHostRefused):
            await docs_cf_hosts.ensure_host("acme.guides.markdrop.in")
        self.assertEqual((await docs_cf_hosts.drop_host("acme.guides.markdrop.in"))["detached"], 0)
        self.assertIn("x", self.cf.domains)
        self.assertEqual(self.cf.writes(), [])

    async def test_the_token_is_never_logged(self):
        self.cf.fail = 1
        with self.assertLogs("app.services", level="DEBUG") as logs:
            with self.assertRaises(docs_cf_hosts.CfHostError) as e:
                await docs_cf_hosts.ensure_host("acme.guides.markdrop.in")
            docs_cf_hosts.checked("acme.guides.markdrop.in")
            try:
                docs_cf_hosts.checked("www.markdrop.in")
            except docs_cf_hosts.CfHostRefused:
                pass
        self.assertNotIn(TOKEN, "\n".join(logs.output) + str(e.exception))


class ApiTests(CfCase):
    async def test_ensure_is_idempotent_and_drop_removes(self):
        h = "acme.guides.markdrop.in"
        first = await docs_cf_hosts.ensure_host(h)
        self.assertTrue(first["attached"])
        again = await docs_cf_hosts.ensure_host(h)
        self.assertFalse(again["attached"])
        self.assertEqual([c[0] for c in self.cf.calls], ["GET", "PUT", "GET"])
        self.assertEqual(self.cf.hosts(), {h})
        self.assertEqual((await docs_cf_hosts.drop_host(h))["detached"], 1)
        self.assertEqual((await docs_cf_hosts.drop_host(h))["detached"], 0)
        self.assertEqual(self.cf.hosts(), set())

    async def test_no_op_without_a_token_or_account(self):
        for i, k in enumerate(("docs_cf_api_token", "docs_cf_account_id")):
            with mock.patch.object(JS, k, ""):
                self.assertFalse(docs_cf_hosts.enabled())
                self.assertEqual((await docs_cf_hosts.ensure_host("acme.guides.markdrop.in"))["skipped"], "not configured")
                self.assertEqual((await docs_cf_hosts.drop_host("acme.guides.markdrop.in"))["skipped"], "not configured")
                s = await self.make_site(f"nokey{i}")
                await self.make_page(s, "/a")
                await self.publish(s)
                self.assertEqual(await self.cf_jobs(), [])
                self.assertTrue(docs_cf_hosts.address_ready(await self.site(s)))
        self.assertEqual(self.cf.calls, [])

    async def test_nothing_with_a_preview_host_template(self):
        with mock.patch.object(JS, "docs_site_host_template", "preview.example.workers.dev"):
            s = await self.make_site("acme")
            await self.make_page(s, "/a")
            await self.publish(s)
            await docs_site_store.delete_site(self.db, await self.site(s), "u1")
            self.assertEqual(await self.cf_jobs(), [])
            self.assertEqual(await docs_cf_hosts.requeue_pending(self.db), 0)
        self.assertEqual(self.cf.calls, [])


class LifecycleTests(CfCase):
    async def test_attach_on_first_publish_then_skip(self):
        s = await self.make_site("acme")
        await self.make_page(s, "/a")
        await self.publish(s)
        self.assertFalse(docs_cf_hosts.address_ready(await self.site(s)))
        [job] = await self.run_cf()
        self.assertEqual(job["status"], "done", job.get("error"))
        self.assertEqual(job["result"]["attached"], ["acme.guides.markdrop.in"])
        self.assertEqual(self.cf.hosts(), {"acme.guides.markdrop.in"})
        site = await self.site(s)
        self.assertEqual(site["cf_host_attached"], "acme.guides.markdrop.in")
        self.assertEqual(site["cf_hosts"], ["acme.guides.markdrop.in"])
        self.assertTrue(docs_cf_hosts.address_ready(site))
        # The next publish doesn't call Cloudflare again.
        await self.publish(s)
        self.assertEqual(await self.cf_jobs(), [])
        self.assertEqual(len(self.cf.writes()), 1)

    async def test_site_view_says_whether_the_address_is_ready(self):
        s = await self.make_site("acme")
        view = await docs_site_store.site_view(self.db, await self.site(s), "admin")
        self.assertFalse(view["address_ready"])
        await self.db[SITES].update_one({"_id": s["_id"]}, {"$set": {"cf_host_attached": "acme.guides.markdrop.in"}})
        view = await docs_site_store.site_view(self.db, await self.site(s), "admin")
        self.assertTrue(view["address_ready"])

    async def test_drop_on_unpublish_and_delete(self):
        a = await self.make_site("acme")
        await self.make_page(a, "/a")
        await self.go_live(a)
        await self.run_cf()
        b = await self.make_site("bolt")
        await self.make_page(b, "/a")
        await self.go_live(b)
        await self.run_cf()
        self.assertEqual(self.cf.hosts(), {"acme.guides.markdrop.in", "bolt.guides.markdrop.in"})

        await docs_site_store.unpublish_site(self.db, await self.site(a))
        [job] = await self.run_cf()
        self.assertEqual(job["result"]["detached"], ["acme.guides.markdrop.in"])
        site = await self.site(a)
        self.assertEqual(site.get("cf_hosts"), [])
        self.assertNotIn("cf_host_attached", site)

        await docs_site_store.delete_site(self.db, await self.site(b), "u1")
        [job] = await self.run_cf()
        self.assertEqual(job["result"]["detached"], ["bolt.guides.markdrop.in"])
        self.assertEqual(self.cf.hosts(), set())

        # Published again after the take-down: attached again.
        await self.publish(a)
        await self.run_cf()
        self.assertEqual(self.cf.hosts(), {"acme.guides.markdrop.in"})

    async def test_deleting_a_never_published_site_detaches_a_stray_domain(self):
        s = await self.make_site("acme")
        self.cf.domains["old"] = {"id": "old", "hostname": "acme.guides.markdrop.in", "service": WORKER}
        await docs_site_store.delete_site(self.db, await self.site(s), "u1")
        await self.run_cf()
        self.assertEqual(self.cf.hosts(), set())

    async def test_slug_rename(self):
        # Never published: the old address goes at once.
        d = await self.make_site("draft-one")
        await docs_cf_hosts.ensure_host("draft-one.guides.markdrop.in")
        await docs_site_store.update_site(self.db, await self.site(d), name=None, slug="draft-two", settings_patch=None)
        await self.run_cf()
        self.assertEqual(self.cf.hosts(), set())

        # Live: the old address keeps serving its live build, and the new one is attached ahead;
        # the old one goes when a build at the new slug goes live.
        s = await self.make_site("old-name")
        await self.make_page(s, "/a")
        await self.go_live(s)
        await self.run_cf()
        await docs_site_store.update_site(self.db, await self.site(s), name=None, slug="new-name", settings_patch=None)
        await self.run_cf()
        self.assertEqual(self.cf.hosts(), {"old-name.guides.markdrop.in", "new-name.guides.markdrop.in"})
        self.assertEqual((await self.site(s))["cf_host_attached"], "new-name.guides.markdrop.in")
        await self.go_live(s)
        [job] = await self.run_cf()
        self.assertEqual(job["payload"]["hosts"], ["old-name.guides.markdrop.in"])
        self.assertEqual(self.cf.hosts(), {"new-name.guides.markdrop.in"})
        self.assertEqual((await self.site(s))["cf_hosts"], ["new-name.guides.markdrop.in"])

    async def test_failures_are_retried_by_the_sweeper(self):
        s = await self.make_site("acme")
        await self.make_page(s, "/a")
        await self.publish(s)
        self.cf.fail = 1
        [job] = await self.run_cf()
        self.assertEqual(job["status"], "queued")  # back in the queue, the attempt counted
        self.assertEqual(job["attempts"], 1)
        self.assertIn("500", job["error"])
        self.assertNotIn(TOKEN, job["error"])
        self.assertEqual(self.cf.hosts(), set())
        await docs_dispatch.run_once(self.db)
        job = await self.db[JOBS].find_one({"_id": job["_id"]})
        self.assertEqual(job["status"], "done", job.get("error"))
        self.assertEqual(self.cf.hosts(), {"acme.guides.markdrop.in"})

        # Out of attempts (Cloudflare down for a while): failed; once it is back the sweeper queues
        # the site again (after a pause), and the take-down goes through.
        await docs_site_store.delete_site(self.db, await self.site(s), "u1")
        self.cf.fail = 100
        for _ in range(JS.docs_job_max_attempts):
            await docs_dispatch.run_once(self.db)
        [failed] = await self.cf_jobs("failed")
        self.assertIn("500", failed["error"])
        self.assertEqual(self.cf.hosts(), {"acme.guides.markdrop.in"})
        self.cf.fail = 0
        self.assertEqual(await docs_cf_hosts.requeue_pending(self.db), 0)  # too soon after the failure
        await self.db[JOBS].update_many({"kind": "cf_host"}, {"$set": {"updated_at": failed["updated_at"]
                                                                         - docs_cf_hosts.RETRY_AFTER * 2}})
        self.assertEqual(await docs_cf_hosts.requeue_pending(self.db), 1)
        await self.run_cf()
        self.assertEqual(self.cf.hosts(), set())
        self.assertEqual(await docs_cf_hosts.requeue_pending(self.db), 0)  # nothing left to do

    async def test_sweeper_attaches_a_live_site_published_before_the_token(self):
        s = await self.make_site("acme")
        await self.make_page(s, "/a")
        with mock.patch.object(JS, "docs_cf_api_token", ""):
            await self.go_live(s)
        self.assertEqual(await self.cf_jobs(), [])
        await docs_dispatch.run_once(self.db)  # requeues and runs it inline
        self.assertEqual(self.cf.hosts(), {"acme.guides.markdrop.in"})
        self.assertEqual((await self.db[BUILDS].find_one({"site_id": s["_id"]}))["status"], "live")


if __name__ == "__main__":
    unittest.main()
