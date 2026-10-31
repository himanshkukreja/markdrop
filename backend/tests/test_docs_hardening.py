"""Markdrop Guides security review fixes (October 2026):

- SVG uploads are rewritten through an XML allowlist (services/docs_svg.py), not a byte blocklist.
- A site taken down while a build runs never goes (or stays) live: the runner asks the API before
  it flips the pointer (GET /internal/docs-jobs/{id}/wanted), finish_build undoes a late flip, and
  every take-down queues the (idempotent) unpublish job.
- A build publishes to the hosts the site holds in the database now; a stale mapping of another
  site's old address is freed, a live one is never taken.
- The access policy is retried until the edge holds it (``access_synced_version``,
  ``access_enforced``).
- Deleting a workspace deletes its docs sites; a member who loses access to a members-only site
  signs its readers out (a new policy version).
- Build and job errors: the details are a studio admin's; a finished build's manifest must be the
  job's site's.

Mongo is the local test server (MARKDROP_TEST_MONGODB_URI) when reachable, else mongomock. The
docs bucket is a folder store (DbCase) or in memory (DocsSitesCase).
"""

from __future__ import annotations

from tests import _email_env as env  # noqa: F401  (pins settings first)

import json
import os
import unittest
from unittest import mock
from xml.parsers import expat

import httpx
from bson import ObjectId

from app.config import get_settings
from app.main import app
from app.services import (docs_build, docs_dispatch, docs_jobs, docs_site_access, docs_site_assets, docs_site_store,
                          docs_snapshot, docs_studio_roles, docs_svg)
from app.services import workspace as ws_service
from app.services.docs_jobs import BUILDS, JOBS, SITES
from tests._docs_sites_env import DocsSitesCase, now
from tests.test_docs_build_worker import DbCase, utc

SVG = b"xmlns='http://www.w3.org/2000/svg'"


def svg(body: str, attrs: str = "") -> bytes:
    return b"<svg " + SVG + attrs.encode() + b">" + body.encode() + b"</svg>"


# ── SVG ─────────────────────────────────────────────────────────────────────


class SvgSanitizer(unittest.TestCase):
    def rejected(self, data: bytes, msg: str = docs_svg.ACTIVE) -> None:
        with self.assertRaises(docs_svg.SvgRejected) as ctx:
            docs_svg.sanitize(data)
        self.assertEqual(str(ctx.exception), msg)

    def test_known_bypasses_of_a_blocklist_are_refused(self):
        xlink = " xmlns:xlink='http://www.w3.org/1999/xlink'"
        for data in (
            svg("<svg:script>alert(1)</svg:script>", " xmlns:svg='http://www.w3.org/2000/svg'"),
            svg("<h:script>alert(1)</h:script>", " xmlns:h='http://www.w3.org/1999/xhtml'"),
            svg("<a xlink:href='javascript&#58;alert(1)'><rect/></a>", xlink),
            svg("<a href=' java&#x09;script:alert(1)'><rect/></a>"),
            svg("<a><animate attributeName='href' values='javascript:alert(1)'/><rect/></a>"),
            svg("<a><set attributeName='xlink:href' to='javascript:alert(1)'/></a>", xlink),
            svg("<a><set attributeName=' HREF ' to='#x'/></a>"),
            svg("<foreignObject><div/></foreignObject>"),
            svg("<g onclick='x()'/>"),
            svg("", " onload='x()'"),
            svg("<image href='data:image/svg+xml,&lt;svg onload=alert(1)&gt;'/>"),
            svg("<a href='data:text/html,x'><rect/></a>"),
            # Inside an element that would be dropped anyway: still refused, not silently passed.
            svg("<x:thing xmlns:x='urn:x'><x:a href='javascript:alert(1)'/></x:thing>"),
        ):
            self.rejected(data)

    def test_entities_doctypes_and_unreadable_files(self):
        unreadable = docs_svg.UNREADABLE
        self.rejected(b"<!DOCTYPE svg [<!ENTITY a 'b'>]><svg " + SVG + b">&a;</svg>", unreadable)
        self.rejected(b"<?xml version='1.0'?><!DOCTYPE l [<!ENTITY l 'l'><!ENTITY l2 '&l;&l;'>]><svg>&l2;</svg>", unreadable)
        self.rejected(b'<!DOCTYPE svg SYSTEM "file:///etc/passwd"><svg ' + SVG + b">&x;</svg>", unreadable)
        self.rejected(svg("<rect>"), unreadable)
        self.rejected(b"<svg " + SVG + b"><g>" * 300 + b"</g>" * 300 + b"</svg>", unreadable)
        self.rejected(b"<html><body/></html>", docs_svg.NOT_SVG)
        # A bare public DOCTYPE (Illustrator's): ignored, not written back.
        out = docs_svg.sanitize(b'<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" '
                                b'"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg ' + SVG + b"><g/></svg>")
        self.assertEqual(out, b'<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>')

    def test_allowlist_rewrite(self):
        src = (b"<?xml version='1.0' encoding='UTF-8'?><!-- made by hand --><svg " + SVG +
               b" xmlns:xlink='http://www.w3.org/1999/xlink' xmlns:inkscape='http://www.inkscape.org/namespaces/inkscape'"
               b" viewBox='0 0 10 10' inkscape:version='1' data-x='1' unknown='y'>"
               b"<inkscape:namedview><inkscape:grid/></inkscape:namedview><metadata><rdf/></metadata>"
               b"<defs><linearGradient id='g'><stop offset='0' stop-color='red'/></linearGradient></defs>"
               b"<rect width='1' height='1' fill='url(#g)' style='fill:red' class='a &amp; b'/>"
               b"<rect fill='url(https://evil.test/x.svg#a)' style='background:url(https://evil.test/p)'/>"
               b"<use xlink:href='#g'/><image href='pic.png'/><image href='https://cdn.test/a.png'/>"
               b"<style><![CDATA[@import url(https://evil.test/x.css);]]></style>"
               b"<style>.a > .b { fill: url(#g) }</style>"
               b"<text x='1'>a &lt; b<tspan>&#x263A;</tspan></text>"
               b"<animateTransform attributeName='transform' type='rotate' from='0' to='360' dur='1s'/></svg>")
        out = docs_svg.sanitize(src)
        self.assertEqual(out.decode(), (
            '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" data-x="1">'
            '<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs>'
            '<rect width="1" height="1" fill="url(#g)" style="fill:red" class="a &amp; b"/>'
            "<rect/>"
            '<use xlink:href="#g"/><image/><image href="https://cdn.test/a.png"/>'
            "<style/>"
            "<style>.a &gt; .b { fill: url(#g) }</style>"
            '<text x="1">a &lt; b<tspan>☺</tspan></text>'
            '<animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="1s"/></svg>'))
        # What comes out is well-formed and passes again unchanged.
        expat.ParserCreate().Parse(out, True)
        self.assertEqual(docs_svg.sanitize(out), out)
        # An SVG without xmlns becomes a proper one; data images and fragments are links it keeps.
        self.assertEqual(docs_svg.sanitize(b"<svg width='2'><image href='data:image/png;base64,AAAA'/><a href='#x'/></svg>"),
                         b'<svg xmlns="http://www.w3.org/2000/svg" width="2"><image href="data:image/png;base64,AAAA"/><a href="#x"/></svg>')

    def test_uploads_store_the_rewritten_bytes(self):
        ext, data = docs_site_assets.prepare(svg("<metadata/><rect/>"), "logo.svg")
        self.assertEqual((ext, data), ("svg", b'<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'))
        with self.assertRaises(docs_site_assets.AssetRejected):
            docs_site_assets.prepare(svg("<svg:script/>", " xmlns:svg='http://www.w3.org/2000/svg'"), "x.svg")
        png = b"\x89PNG\r\n\x1a\n" + b"\0" * 20
        self.assertEqual(docs_site_assets.prepare(png, "a.png"), ("png", png))
        self.assertEqual(docs_site_assets.sniff(svg("<rect/>"), None), "svg")


# ── take-downs, hosts, manifests ────────────────────────────────────────────


class TakeDownRaces(DbCase):
    def fs(self) -> docs_build.FsPointerStore:
        return docs_build.FsPointerStore(self.store)

    async def claimed(self, site) -> tuple[dict, dict]:
        """Publish, then a runner claims the build and fetches its spec (now building)."""
        b, j = await self.publish(site)
        job = await docs_jobs.claim_next(self.db, "w1", target=None)
        self.assertEqual(job["_id"], j["_id"])
        build = await docs_build.start_build(self.db, job)
        await docs_build.build_spec(self.db, job, build)
        return b, job

    def runner_flipped(self, site, manifest: str) -> None:
        """What the runner wrote before it reported back: the pointer and the host mapping."""
        sid = str(site["_id"])
        self.put_manifest(sid, manifest)
        self.fs().put_text(f"sites/{sid}/current.json", json.dumps({"manifest": manifest}))
        self.fs().put_text(f"hosts/{site['slug']}.guides.markdrop.in.json", json.dumps({"site": sid}))

    async def test_never_live_site_deleted_while_its_first_build_runs(self):
        s = await self.make_site("fresh")
        await self.make_page(s, "/a")
        b, job = await self.claimed(s)
        self.assertEqual(await docs_build.still_wanted(self.db, job, "w1"), (True, "ok"))
        # Deleted mid-build: nothing was ever live, but a build is running, so the take-down is queued.
        take_down = await docs_site_store.delete_site(self.db, await self.db[SITES].find_one({"_id": s["_id"]}), "u1")
        self.assertIsNotNone(take_down)
        self.assertEqual(await docs_build.still_wanted(self.db, job, "w1"), (False, "the site was deleted"))
        # The runner had already flipped (its check came before the delete): finish_build undoes it.
        self.runner_flipped(s, "4" * 64)
        out = await docs_build.finish_build(self.db, job, "w1", {"ok": True, "manifest_hash": "4" * 64})
        self.assertTrue(out["taken_down"])
        self.assertEqual((await self.db[BUILDS].find_one({"_id": b["_id"]}))["status"], "superseded")
        # One take-down job (the second coalesced into the waiting one, with the build's hosts).
        rows = await self.db[JOBS].find({"site_id": s["_id"], "kind": "unpublish"}).to_list(length=None)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["payload"]["hosts"], ["fresh.guides.markdrop.in"])
        await docs_dispatch.run_once(self.db)
        self.assertEqual((await self.db[JOBS].find_one({"_id": rows[0]["_id"]}))["status"], "done")
        self.assertIsNone(self.fs().get_text("hosts/fresh.guides.markdrop.in.json"))
        self.assertIsNone(self.fs().get_text(f"sites/{s['_id']}/current.json"))
        # Idempotent: again is fine.
        self.assertEqual((await docs_build.unpublish(self.db, s["_id"], "fresh", store=self.fs()))["hosts_removed"], [])

    async def test_the_runner_asks_before_the_flip(self):
        s = await self.make_site()
        await self.make_page(s, "/a")
        _, j1 = await self.publish(s)
        await self.run_build(j1, {"ok": True, "manifest_hash": "1" * 64})
        await self.make_page(s, "/b")
        b2, j2 = await self.publish(s)
        http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://api.markdrop.in")
        self.addAsyncCleanup(http.aclose)
        auth = {"authorization": f"Bearer {docs_jobs.job_token(str(j2['_id']))}"}
        url = f"/api/v1/internal/docs-jobs/{j2['_id']}"
        self.assertEqual((await http.get(url + "?runner=gha-1", headers=auth)).status_code, 200)
        r = await http.get(url + "/wanted?runner=gha-1", headers=auth)
        self.assertEqual(r.json(), {"wanted": True, "reason": "ok"})
        self.assertEqual((await http.get(url + "/wanted?runner=gha-2", headers=auth)).status_code, 409)
        self.assertEqual((await http.get(url + "/wanted?runner=gha-1")).status_code, 401)
        await docs_site_store.unpublish_site(self.db, await self.db[SITES].find_one({"_id": s["_id"]}))
        r = await http.get(url + "/wanted?runner=gha-1", headers=auth)
        self.assertEqual(r.json(), {"wanted": False, "reason": "the site was unpublished"})
        # The runner stopped before the flip and says so.
        r = await http.post(url + "/result", headers=auth, json={"runner": "gha-1", "ok": False, "aborted": True,
                                                                 "error": "the site was taken down while this version was building"})
        self.assertEqual(r.status_code, 200, r.text)
        b = await self.db[BUILDS].find_one({"_id": b2["_id"]})
        self.assertEqual((b["status"], b["error"]), ("superseded", docs_build.TAKEN_DOWN))
        self.assertEqual((await self.db[JOBS].find_one({"_id": j2["_id"]}))["status"], "done")
        self.assertEqual((await self.db[SITES].find_one({"_id": s["_id"]}))["status"], "unpublished")

    async def test_a_publish_after_an_unpublish_goes_live(self):
        s = await self.make_site()
        await self.make_page(s, "/a")
        _, j1 = await self.publish(s)
        await self.run_build(j1, {"ok": True, "manifest_hash": "1" * 64})
        await docs_site_store.unpublish_site(self.db, await self.db[SITES].find_one({"_id": s["_id"]}))
        await docs_dispatch.run_once(self.db)
        await self.make_page(s, "/b")
        b2, j2 = await self.publish(s)
        out = await self.run_build(j2, {"ok": True, "manifest_hash": "2" * 64})
        self.assertFalse(out.get("taken_down"))
        site = await self.db[SITES].find_one({"_id": s["_id"]})
        self.assertEqual((site["status"], site["live_build_id"]), ("live", b2["_id"]))
        # A take-down queued earlier that runs late leaves a live site alone.
        res = await docs_build.unpublish(self.db, s["_id"], "acme", store=self.fs())
        self.assertEqual(res["skipped"], "the site is live again")

    async def test_unpublish_fails_the_builds_still_waiting(self):
        s = await self.make_site()
        await self.make_page(s, "/a")
        _, j1 = await self.publish(s)
        await self.run_build(j1, {"ok": True, "manifest_hash": "1" * 64})
        await self.make_page(s, "/b")
        b2, j2 = await self.publish(s)
        await docs_site_store.unpublish_site(self.db, await self.db[SITES].find_one({"_id": s["_id"]}))
        self.assertEqual((await self.db[JOBS].find_one({"_id": j2["_id"]}))["status"], "failed")
        self.assertEqual((await self.db[BUILDS].find_one({"_id": b2["_id"]}))["status"], "failed")

    async def test_a_cancelled_build_that_landed_puts_the_live_one_back(self):
        s = await self.make_site()
        await self.make_page(s, "/a")
        b1, j1 = await self.publish(s)
        await self.run_build(j1, {"ok": True, "manifest_hash": "1" * 64})
        self.fs().put_text(f"sites/{s['_id']}/current.json", json.dumps({"manifest": "1" * 64}))
        await self.make_page(s, "/b")
        b2, job = await self.claimed(s)
        await docs_build.fail_build_job(self.db, job, None, "the job ran longer than 25 minutes")
        await self.db[JOBS].update_one({"_id": job["_id"]}, {"$set": {"status": "running", "locked_by": "w1"}})
        self.assertEqual(await docs_build.still_wanted(self.db, job, "w1"), (False, "the build was cancelled"))
        self.runner_flipped(s, "2" * 64)
        out = await docs_build.finish_build(self.db, job, "w1", {"ok": True, "manifest_hash": "2" * 64})
        self.assertTrue(out["taken_down"])
        b = await self.db[BUILDS].find_one({"_id": b2["_id"]})
        self.assertEqual(b["status"], "failed")
        await docs_dispatch.run_once(self.db)
        ptr = json.loads(self.fs().get_text(f"sites/{s['_id']}/current.json"))
        self.assertEqual(ptr["manifest"], "1" * 64)
        site = await self.db[SITES].find_one({"_id": s["_id"]})
        self.assertEqual((site["status"], site["live_build_id"]), ("live", b1["_id"]))

    async def test_the_manifest_must_be_the_jobs_sites(self):
        s = await self.make_site()
        await self.make_page(s, "/a")
        b, job = await self.claimed(s)
        other = self.put_manifest(str(ObjectId()))
        out = await docs_build.finish_build(self.db, job, "w1", {"ok": True, "manifest_hash": other})
        self.assertFalse(out["ok"])
        row = await self.db[BUILDS].find_one({"_id": b["_id"]})
        self.assertEqual((row["status"], row["error"]), ("failed", "the runner reported a manifest of another site"))
        self.assertIsNone((await self.db[SITES].find_one({"_id": s["_id"]}))["live_build_id"])
        # A restore refuses a manifest that names no site.
        h = "c" * 64
        os.makedirs(os.path.join(self.store, "manifests"), exist_ok=True)
        with open(os.path.join(self.store, "manifests", f"{h}.json"), "w") as f:
            json.dump({"engine": "e"}, f)
        with self.assertRaises(docs_build.RestoreError):
            docs_build.point_site(self.fs(), str(s["_id"]), h)


class Hosts(DbCase):
    async def test_a_build_publishes_to_the_sites_hosts_now_and_never_takes_a_live_one(self):
        store = docs_build.FsPointerStore(self.store)
        a = await self.make_site("old-a")
        await self.make_page(a, "/a")
        ba, ja = await self.publish(a)  # its snapshot carries "old-a"
        # A moves to a new address before the build runs; B takes A's old one.
        await self.db[SITES].update_one({"_id": a["_id"]}, {"$set": {"slug": "new-a"}})
        store.put_text("hosts/old-a.guides.markdrop.in.json", json.dumps({"site": str(a["_id"])}))
        spec = await docs_build.build_spec(self.db, ja, ba)
        self.assertEqual(spec["publish"]["hosts"], ["new-a.guides.markdrop.in"])
        self.assertEqual((await self.db[BUILDS].find_one({"_id": ba["_id"]}))["publish_hosts"], ["new-a.guides.markdrop.in"])
        b = await self.make_site("old-a")
        await self.make_page(b, "/a")
        bb, jb = await self.publish(b)
        spec = await docs_build.build_spec(self.db, jb, bb)
        self.assertEqual(spec["publish"]["hosts"], ["old-a.guides.markdrop.in"])
        # A's stale mapping of that address is gone, so B's runner can claim it.
        self.assertIsNone(store.get_text("hosts/old-a.guides.markdrop.in.json"))
        # A mapping of a site that still holds the address is never touched.
        c = await self.make_site("held")
        store.put_text("hosts/held.guides.markdrop.in.json", json.dumps({"site": str(c["_id"])}))
        self.assertEqual(await docs_build.free_stale_hosts(self.db, ObjectId(), ["held.guides.markdrop.in"]), [])
        self.assertEqual(json.loads(store.get_text("hosts/held.guides.markdrop.in.json")), {"site": str(c["_id"])})
        # A deleted site holds nothing.
        await self.db[SITES].update_one({"_id": c["_id"]}, {"$set": {"deleted_at": utc()}})
        self.assertEqual(await docs_build.free_stale_hosts(self.db, ObjectId(), ["held.guides.markdrop.in"]),
                         ["held.guides.markdrop.in"])
        self.assertEqual(docs_snapshot.site_hosts({"_id": "x", "slug": "q", "domains": []}), ["q.guides.markdrop.in"])


FAKE_RUNNER = '''
import json, sys
args = sys.argv[1:]
result = args[args.index("--result") + 1]
assert args[args.index("--wanted") + 1] == "stdin"
print("@@progress " + json.dumps({"step": "publish", "done": 2, "total": 4}), flush=True)
print("@@wanted?", flush=True)
answer = sys.stdin.readline().strip()
with open(result, "w") as f:
    json.dump({"ok": False, "aborted": answer != "yes", "error": "answer=" + answer}, f)
'''


class WorkerAsksBeforeTheFlip(DbCase):
    """The local worker answers the runner's "@@wanted?" line on its stdin (a stand-in runner)."""

    async def run_once_with_fake_runner(self) -> dict:
        import sys
        import tempfile

        from scripts import docs_build_worker as w

        import shutil

        platform = tempfile.mkdtemp(prefix="fake-platform-")
        self.addCleanup(shutil.rmtree, platform, True)
        os.makedirs(os.path.join(platform, "runner"))
        with open(os.path.join(platform, "runner", "run-job.mjs"), "w") as f:
            f.write(FAKE_RUNNER)
        cfg = w.Config({"MARKDROP_DOCS_PLATFORM_DIR": platform, "MARKDROP_DOCS_NODE": sys.executable,
                        "MARKDROP_DOCS_NICE": "0"})
        worker = w.Worker(self.db, cfg)
        s = await self.make_site()
        await self.make_page(s, "/a")
        b, j = await self.publish(s)
        await self.db[JOBS].update_one({"_id": j["_id"]}, {"$set": {"target": "local"}})
        job = await worker.claim()
        self.assertEqual(job["_id"], j["_id"])
        await worker.run_job(w.Running(job, 0))
        return await self.db[BUILDS].find_one({"_id": b["_id"]})

    async def test_yes(self):
        b = await self.run_once_with_fake_runner()
        self.assertEqual((b["status"], b["error"]), ("failed", "answer=yes"))

    async def test_no(self):
        with mock.patch.object(docs_build, "still_wanted", mock.AsyncMock(return_value=(False, "the site was deleted"))):
            b = await self.run_once_with_fake_runner()
        self.assertEqual((b["status"], b["error"]), ("superseded", docs_build.TAKEN_DOWN))


# ── the access policy reaches the edge ──────────────────────────────────────


class AccessSync(DbCase):
    async def private_site(self, version: int = 1) -> dict:
        s = await self.make_site()
        await self.db[SITES].update_one({"_id": s["_id"]}, {"$set": {
            "settings.access": {"level": "password", "password_hash": "$2b$12$x"}, "access_version": version}})
        return await self.db[SITES].find_one({"_id": s["_id"]})

    async def test_synced_version_retries_and_enforced(self):
        s = await self.private_site()
        self.assertFalse(docs_site_access.enforced(s))
        self.assertTrue(docs_site_access.enforced({"settings": {"access": {"level": "public"}}}))
        # Nothing queued it (say queue_sync failed): the sweeper does.
        stats = await docs_dispatch.run_once(self.db)
        self.assertEqual(stats["access_retried"], 1)
        s = await self.db[SITES].find_one({"_id": s["_id"]})
        self.assertEqual(s["access_synced_version"], 1)
        self.assertTrue(docs_site_access.enforced(s))
        self.assertEqual(json.loads(docs_build.FsPointerStore(self.store).get_text(f"sites/{s['_id']}/access.json"))["level"],
                         "password")
        self.assertEqual((await docs_dispatch.run_once(self.db))["access_retried"], 0)

        # The bucket fails: the job is retried (not dropped) and then, once out of attempts, queued anew.
        class Broken(docs_build.FsPointerStore):
            def put_text(self, key, text):
                raise OSError("bucket down")

        await self.db[SITES].update_one({"_id": s["_id"]}, {"$inc": {"access_version": 1}})
        with mock.patch.object(docs_build, "default_store", lambda: Broken(self.store)):
            await docs_site_access.queue_sync(self.db, s["_id"], "settings")
            for _ in range(3):
                await docs_dispatch.run_once(self.db)
            jobs = await self.db[JOBS].find({"site_id": s["_id"], "kind": "access"}).sort("created_at", 1).to_list(length=None)
            self.assertEqual((jobs[-1]["status"], jobs[-1]["attempts"]), ("failed", 3))
            self.assertIn("OSError", jobs[-1]["error"])
            self.assertFalse(docs_site_access.enforced(await self.db[SITES].find_one({"_id": s["_id"]})))
            # Within the minute after a failure: left alone.
            self.assertEqual(await docs_site_access.requeue_unsynced(self.db), 0)
        with mock.patch.object(docs_site_access, "RETRY_AFTER_SECONDS", -1):
            self.assertEqual((await docs_dispatch.run_once(self.db))["access_retried"], 1)
        s = await self.db[SITES].find_one({"_id": s["_id"]})
        self.assertEqual(s["access_synced_version"], 2)
        self.assertTrue(docs_site_access.enforced(s))

    async def test_a_build_that_wrote_the_policy_counts(self):
        s = await self.private_site(version=3)
        await self.make_page(s, "/a")
        with mock.patch.object(docs_site_access, "queue_sync", mock.AsyncMock(return_value=None)), \
                mock.patch.object(get_settings(), "docs_private_sites_enabled", True):
            _, j = await self.publish(s)
            await self.run_build(j, {"ok": True, "manifest_hash": "1" * 64,
                                     "access": {"level": "password", "policy_version": 3}})
        self.assertEqual((await self.db[SITES].find_one({"_id": s["_id"]}))["access_synced_version"], 3)


class ErrorViews(unittest.TestCase):
    def test_details_are_an_admins(self):
        b = {"_id": ObjectId(), "site_id": ObjectId(), "status": "failed",
             "error": "R2 PUT objects/abc: 403 <Error><Code>AccessDenied</Code></Error>"}
        self.assertEqual(docs_site_store.build_view(b)["error"], docs_site_store.GENERIC_ERROR)
        self.assertEqual(docs_site_store.build_view(b, details=True)["error"], b["error"])
        self.assertIsNone(docs_site_store.build_view({**b, "error": None})["error"])
        j = {"_id": ObjectId(), "site_id": ObjectId(), "status": "failed", "error": "next build exited with 1: /tmp/x",
             "result": {"ok": False, "error": "x"}}
        v = docs_site_store.job_view(j)
        self.assertEqual((v["error"], v["result"]["error"]), (docs_site_store.GENERIC_ERROR, docs_site_store.GENERIC_ERROR))
        self.assertEqual(docs_site_store.job_view(j, details=True)["error"], j["error"])
        self.assertTrue(docs_site_store.sees_details("admin"))
        self.assertTrue(docs_site_store.sees_details(docs_studio_roles.Resolved("admin", "workspace")))
        self.assertFalse(docs_site_store.sees_details("editor"))
        self.assertFalse(docs_site_store.sees_details(None))


# ── workspaces and members ──────────────────────────────────────────────────


class MembersOnlySites(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.site = await self.create("handbook")
        self.sid = ObjectId(self.site["id"])
        await self.db[SITES].update_one({"_id": self.sid}, {"$set": {"settings.access.level": "members", "access_version": 1}})

    async def version(self) -> int:
        return (await self.db[SITES].find_one({"_id": self.sid}))["access_version"]

    async def access_jobs(self) -> int:
        return await self.db[JOBS].count_documents({"site_id": self.sid, "kind": "access"})

    async def test_removed_member_signs_readers_out(self):
        r = await self.http.delete(f"/api/v1/workspaces/{self.ws}/members/{self.uid['editor']}", headers=self.h["owner"])
        self.assertEqual(r.status_code, 204, r.text)
        self.assertEqual(await self.version(), 2)
        self.assertEqual(await self.access_jobs(), 1)

    async def test_studio_role_to_none_and_site_override(self):
        await docs_studio_roles.set_workspace_role(self.db, self.ws, self.uid["viewer"], "none", self.uid["owner"])
        self.assertEqual(await self.version(), 2)
        await docs_studio_roles.set_workspace_role(self.db, self.ws, self.uid["viewer"], "none", self.uid["owner"])
        self.assertEqual(await self.version(), 2)  # no change, no sign-out
        await docs_studio_roles.set_workspace_role(self.db, self.ws, self.uid["viewer"], "viewer", self.uid["owner"])
        self.assertEqual(await self.version(), 2)  # gaining access signs nobody out
        site = await self.db[SITES].find_one({"_id": self.sid})
        await docs_studio_roles.set_site_override(self.db, site, self.uid["viewer"], "none", self.uid["owner"])
        self.assertEqual(await self.version(), 3)
        await docs_studio_roles.remove_site_override(self.db, site, self.uid["viewer"], self.uid["owner"])
        self.assertEqual(await self.version(), 3)
        await docs_studio_roles.set_site_override(self.db, site, self.uid["editor"], "viewer", self.uid["owner"])
        self.assertEqual(await self.version(), 3)  # still a reader

    async def test_demoted_admin_and_public_sites(self):
        await ws_service.set_member_role(self.db, self.ws, self.uid["admin"], "member", self.uid["owner"])
        self.assertEqual(await self.version(), 2)  # no studio grant of their own: lost the site
        await self.db[SITES].update_one({"_id": self.sid}, {"$set": {"settings.access.level": "public"}})
        await docs_studio_roles.set_workspace_role(self.db, self.ws, self.uid["editor"], "none", self.uid["owner"])
        self.assertEqual(await self.version(), 2)  # a public site has no sessions to end

    async def test_settings_view_says_whether_access_is_enforced(self):
        self.assertFalse((await self.get(f"/{self.site['id']}"))["access_enforced"])
        await docs_site_access.mark_synced(self.db, self.sid, 1)
        self.assertTrue((await self.get(f"/{self.site['id']}"))["access_enforced"])

    async def test_build_errors_are_generic_below_admin(self):
        await self.db[BUILDS].insert_one({"site_id": self.sid, "number": 1, "status": "failed",
                                          "error": "R2 PUT x: 403 secret detail", "created_at": now()})
        builds = {who: (await self.get(f"/{self.site['id']}/builds", who))[0]["error"] for who in ("owner", "editor", "viewer")}
        self.assertEqual(builds, {"owner": "R2 PUT x: 403 secret detail", "editor": docs_site_store.GENERIC_ERROR,
                                  "viewer": docs_site_store.GENERIC_ERROR})
        self.assertEqual((await self.get(f"/{self.site['id']}", "viewer"))["latest_build"]["error"], docs_site_store.GENERIC_ERROR)


class WorkspaceDeletion(DocsSitesCase):
    async def test_deleting_a_workspace_takes_its_docs_sites_down(self):
        live = await self.create("live-docs")
        draft = await self.create("draft-docs")
        personal = await self.create("mine", workspace=False)
        await self.db[SITES].update_one({"_id": ObjectId(live["id"])}, {"$set": {
            "status": "live", "live_build_id": ObjectId(), "last_published_at": now()}})
        r = await self.http.request("DELETE", f"/api/v1/workspaces/{self.ws}", json={"confirm_name": "Acme"},
                                    headers=self.h["owner"])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["docs_sites_deleted"], 2)
        for s in (live, draft):
            row = await self.db[SITES].find_one({"_id": ObjectId(s["id"])})
            self.assertIsNotNone(row["deleted_at"])
            self.assertEqual((row["status"], row["deleted_slug"], row.get("slug")), ("unpublished", s["slug"], None))
        take_down = await self.db[JOBS].find_one({"site_id": ObjectId(live["id"]), "kind": "unpublish"})
        self.assertEqual(take_down["payload"]["reason"], "workspace_deleted")
        self.assertIsNone(await self.db[JOBS].find_one({"site_id": ObjectId(draft["id"]), "kind": "unpublish"}))
        self.assertIsNone((await self.db[SITES].find_one({"_id": ObjectId(personal["id"])}))["deleted_at"])
        # The addresses are free again.
        self.assertTrue((await self.get("/slug-available?slug=live-docs"))["available"])


if __name__ == "__main__":
    unittest.main()
