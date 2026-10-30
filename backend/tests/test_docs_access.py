"""Password and members-only docs sites: the API's half (services/docs_site_access.py,
routers/docs_access.py) — the policy the edge reads, the sign-in grants, the rate limit, and the
build pipeline carrying the policy. The edge's half is docs-platform/test/access.test.mjs."""

from __future__ import annotations

import json
import unittest
import time
from unittest import mock
from urllib.parse import parse_qs, unquote, urlsplit

from bson import ObjectId

from tests._docs_sites_env import DocsSitesCase, settings
from tests.test_docs_build_worker import DbCase

from app.limiter import limiter
from app.services import docs_build, docs_dispatch, docs_site_access as access
from app.services.docs_jobs import JOBS, SITES

SECRET = "api-test-secret-0123456789abcdef-0123456789"
SH = "S" * 43
HOST = "acme.docs.markdrop.in"
PW_URL = "/api/v1/docs-access/password"
GRANT_URL = "/api/v1/docs-access/grant"


def fragment(url: str) -> dict:
    return {k: unquote(v[0]) for k, v in parse_qs(urlsplit(url).fragment).items()}


class AccessApiTests(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        for p in (mock.patch.object(settings, "docs_access_secret", SECRET),
                  mock.patch.object(settings, "background_workers_enabled", False)):
            p.start()
            self.addCleanup(p.stop)
        self.site = await self.create("acme", source={"kind": "template", "template": "product"})
        self.sid = self.site["id"]

    async def make_live(self, level: str = "password", password: str = "open-sesame") -> None:
        body = {"level": level, **({"password": password} if level == "password" else {})}
        await self.call("PATCH", f"/{self.sid}", json={"settings": {"access": body}})
        b = await self.call("POST", f"/{self.sid}/publish", json={}, expect=202)
        await self.mark_live(b["id"])

    async def row(self) -> dict:
        return await self.db[SITES].find_one({"_id": ObjectId(self.sid)})

    async def access_jobs(self) -> list[dict]:
        return await self.db[JOBS].find({"site_id": ObjectId(self.sid), "kind": "access"}).to_list(length=50)

    async def pw(self, password: str = "open-sesame", *, site: str | None = None, host: str = HOST, sh: str = SH,
                 next: str = "/guide/start", ip: str = "198.51.100.7"):
        return await self.http.post(f"{PW_URL}?site={site or self.sid}", data={
            "host": host, "next": next, "sh": sh, "password": password}, headers={"X-Real-IP": ip})

    # ── settings → policy version + access job ──

    async def test_access_changes_bump_the_policy_version_and_queue_the_sync(self):
        self.assertEqual((await self.row()).get("access_version"), None)
        await self.call("PATCH", f"/{self.sid}", json={"settings": {"seo": {"index": False}}})
        self.assertEqual(await self.access_jobs(), [])
        await self.call("PATCH", f"/{self.sid}", json={"settings": {"access": {"level": "password", "password": "pass-one"}}})
        self.assertEqual((await self.row())["access_version"], 1)
        # The same password again is a new hash: everyone signed in is signed out.
        await self.call("PATCH", f"/{self.sid}", json={"settings": {"access": {"password": "pass-one"}}})
        self.assertEqual((await self.row())["access_version"], 2)
        await self.call("PATCH", f"/{self.sid}", json={"settings": {"access": {"level": "members"}}})
        await self.call("PATCH", f"/{self.sid}", json={"settings": {"theme": {"preset": "editorial"}}})
        self.assertEqual((await self.row())["access_version"], 3)
        # One waiting job covers every change.
        jobs = await self.access_jobs()
        self.assertEqual([j["status"] for j in jobs], ["queued"])
        # The API never shows the hash, and access isn't a "publish to apply" change.
        site = await self.get(f"/{self.sid}")
        self.assertNotIn("password_hash", json.dumps(site))
        ch = await self.get(f"/{self.sid}/changes")
        self.assertNotIn("access", ch["settings_changed"])

    async def test_publishing_a_private_site_needs_the_flag_and_queues_the_policy(self):
        await self.make_live("members")
        self.assertTrue(await self.access_jobs())
        settings.docs_private_sites_enabled = False
        await self.call("POST", f"/{self.sid}/publish", json={}, expect=409)

    # ── POST /password ──

    async def test_the_right_password_gets_a_grant_for_this_site_host_policy_and_browser(self):
        await self.make_live()
        r = await self.pw()
        self.assertEqual(r.status_code, 303, r.text)
        self.assertEqual(r.headers["cache-control"], "no-store")
        loc = r.headers["location"]
        self.assertTrue(loc.startswith(f"https://{HOST}/_access/callback#g="), loc)
        f = fragment(loc)
        self.assertEqual(f["next"], "/guide/start")
        g = access.read(access.GRANT_PURPOSE, f["g"])
        self.assertEqual((g["s"], g["h"], g["k"], g["v"], g["sh"]), (self.sid, HOST, "password", 1, SH))
        self.assertTrue(time.time() < g["exp"] <= time.time() + 121)
        # Not a session, and nothing secret in it.
        self.assertIsNone(access.read(access.SESSION_PURPOSE, f["g"]))
        self.assertNotIn("$2", json.dumps(g))
        self.assertEqual(await self.db["docs_events"].count_documents({"kind": "docs_access_granted"}), 1)

    async def test_refusals_go_back_to_the_sign_in_page_with_a_reason(self):
        await self.make_live()

        def reason(r):
            self.assertEqual(r.status_code, 303, r.text)
            u = urlsplit(r.headers["location"])
            self.assertEqual((u.netloc, u.path), (HOST, "/_access/login"))
            self.assertNotIn("#", r.headers["location"])
            return parse_qs(u.query)["e"][0]

        self.assertEqual(reason(await self.pw("nope-nope")), "wrong")
        self.assertEqual(reason(await self.pw("")), "wrong")
        self.assertEqual(reason(await self.pw("x" * 300)), "wrong")
        self.assertEqual(reason(await self.pw(sh="short")), "cookies")
        # Only ever back to this site's own address, and only to a path on it.
        r = await self.pw(next="//evil.test/x")
        self.assertEqual(fragment(r.headers["location"])["next"], "/")
        bad = await self.pw(host="evil.test")
        self.assertEqual(bad.status_code, 400)
        self.assertNotIn("location", bad.headers)
        self.assertEqual((await self.pw(site=str(ObjectId()))).status_code, 404)
        self.assertEqual((await self.pw(site="not-an-id")).status_code, 404)
        # A members-only site, or one taken down, doesn't take passwords.
        await self.call("PATCH", f"/{self.sid}", json={"settings": {"access": {"level": "members"}}})
        self.assertEqual(reason(await self.pw()), "changed")
        await self.call("PATCH", f"/{self.sid}", json={"settings": {"access": {"level": "password", "password": "open-sesame"}}})
        await self.db[SITES].update_one({"_id": ObjectId(self.sid)}, {"$set": {"status": "unpublished"}})
        self.assertEqual(reason(await self.pw()), "changed")
        await self.db[SITES].update_one({"_id": ObjectId(self.sid)}, {"$set": {"status": "live"}})
        with mock.patch.object(settings, "docs_access_secret", "too-short"):
            self.assertEqual(reason(await self.pw()), "unavailable")

    async def test_password_attempts_are_rate_limited_per_ip_and_site(self):
        await self.make_live()
        limiter.reset()
        for _ in range(10):
            r = await self.pw("wrong-one")
            self.assertIn("e=wrong", r.headers["location"])
        # The 11th, even right, is refused; another reader isn't affected.
        self.assertIn("e=rate", (await self.pw()).headers["location"])
        self.assertIn("#g=", (await self.pw(ip="203.0.113.9")).headers["location"])
        # Per reader across sites too.
        limiter.reset()
        with mock.patch("app.routers.docs_access.PER_SITE", access_limit("1000/hour")), \
                mock.patch("app.routers.docs_access.PER_IP", access_limit("5/hour")):
            for _ in range(5):
                await self.pw("wrong-one", ip="192.0.2.1")
            self.assertIn("e=rate", (await self.pw(ip="192.0.2.1")).headers["location"])

    async def test_admins_can_sign_everyone_out(self):
        url = f"/api/v1/docs-access/{self.sid}/sign-out-everyone"
        self.assertEqual((await self.http.post(url, headers=self.h["admin"])).status_code, 409)  # public
        await self.make_live("members")
        before = (await self.row())["access_version"]
        for who, want in (("editor", 403), ("viewer", 403), ("stranger", 404)):
            self.assertEqual((await self.http.post(url, headers=self.h[who])).status_code, want, who)
        r = await self.http.post(url, headers=self.h["admin"])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["policy_version"], before + 1)
        self.assertEqual((await self.row())["access_version"], before + 1)
        self.assertTrue(any(j["status"] == "queued" for j in await self.access_jobs()))

    # ── POST /grant (members-only, via markdrop.in) ──

    async def member_grant(self, who: str = "viewer", **over):
        body = {"site_id": self.sid, "host": HOST, "next": "/guide/start", "sh": SH, **over}
        return await self.http.post(GRANT_URL, json=body, headers=self.h.get(who, {}))

    async def test_members_get_a_grant_by_their_docs_studio_role(self):
        await self.make_live("members")
        for who in ("viewer", "editor", "admin", "owner"):
            r = await self.member_grant(who)
            self.assertEqual(r.status_code, 200, (who, r.text))
            g = access.read(access.GRANT_PURPOSE, fragment(r.json()["url"])["g"])
            self.assertEqual((g["s"], g["h"], g["k"], g["v"], g["sh"]), (self.sid, HOST, "members", 1, SH))
            self.assertNotIn("u", g)  # the edge never learns who
        r = await self.member_grant("stranger")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["detail"]["site_name"], "Acme Docs")
        self.assertEqual((await self.http.post(GRANT_URL, json={"site_id": self.sid, "host": HOST, "sh": SH})).status_code, 401)
        # The role comes from the Docs Studio helper, whatever it decides.
        with mock.patch("app.services.docs_site_store.site_role", mock.AsyncMock(return_value=None)):
            self.assertEqual((await self.member_grant("owner")).status_code, 403)

    async def test_grant_refusals(self):
        await self.make_live("members")
        self.assertEqual((await self.member_grant(host="evil.test")).status_code, 400)
        self.assertEqual((await self.member_grant(sh="x")).status_code, 400)
        self.assertEqual((await self.member_grant(site_id=str(ObjectId()))).status_code, 404)
        r = await self.member_grant(next="https://evil.test")
        self.assertEqual(fragment(r.json()["url"])["next"], "/")
        with mock.patch.object(settings, "docs_access_secret", ""):
            self.assertEqual((await self.member_grant()).status_code, 503)
        await self.call("PATCH", f"/{self.sid}", json={"settings": {"access": {"level": "password", "password": "abcdefg"}}})
        self.assertEqual((await self.member_grant()).status_code, 409)
        await self.call("PATCH", f"/{self.sid}", json={"settings": {"access": {"level": "members"}}})
        self.assertEqual((await self.member_grant()).json()["url"].count("#g="), 1)
        await self.db[SITES].update_one({"_id": ObjectId(self.sid)}, {"$set": {"status": "unpublished"}})
        self.assertEqual((await self.member_grant()).status_code, 409)


def access_limit(s: str):
    from limits import parse

    return parse(s)


class AccessTokenTests(unittest.TestCase):
    def test_a_session_minted_by_the_edge_reads_here(self):
        # Minted by docs-platform/edge/access.mjs signToken(SESSION_PURPOSE, …) with this secret.
        token = "eyJzIjoidmVjIiwidiI6MywiayI6Im1lbWJlcnMiLCJleHAiOjQxMDI0NDQ4MDB9.pRiG5dQfKsMxSV3Qc9v5YcQa3FhtXyOxebAvBHUcOH0"
        key = "test-vector-secret-0123456789abcdef-xyz"
        self.assertEqual(access.read(access.SESSION_PURPOSE, token, key), {"s": "vec", "v": 3, "k": "members", "exp": 4102444800})
        self.assertIsNone(access.read(access.GRANT_PURPOSE, token, key))
        self.assertIsNone(access.read(access.SESSION_PURPOSE, token, key + "x"))
        self.assertIsNone(access.read(access.SESSION_PURPOSE, token[:-2] + "AA", key))
        self.assertIsNone(access.read(access.SESSION_PURPOSE, access.sign(access.SESSION_PURPOSE, {"exp": 1}, key), key))

    def test_helpers(self):
        for bad in ("//evil", "/\\evil", "https://evil", "evil", "/a\nb", "/" + "a" * 2001):
            self.assertEqual(access.safe_next(bad), "/", bad)
        self.assertEqual(access.safe_next("/a/b?c=1"), "/a/b?c=1")
        self.assertEqual(access.clean_host("ACME.docs.markdrop.in."), "acme.docs.markdrop.in")
        self.assertIsNone(access.clean_host("evil.test/x"))
        self.assertIsNone(access.clean_host("a..b"))
        self.assertEqual(access.origin_of("acme.docs.localhost:3563"), "http://acme.docs.localhost:3563")
        self.assertEqual(access.origin_of(HOST), f"https://{HOST}")
        self.assertEqual(access.level_of({"settings": {"access": {"level": "weird"}}}), "members")
        self.assertTrue(access.access_changed({"level": "password", "password_hash": "a"}, {"level": "password", "password_hash": "b"}))
        self.assertFalse(access.access_changed(None, {"level": "public", "password_hash": None}))


class AccessPipelineTests(DbCase):
    """The policy object: the access job, the build spec, the runner's report."""

    async def asyncSetUp(self):
        await super().asyncSetUp()
        p = mock.patch.object(settings, "docs_private_sites_enabled", True)
        p.start()
        self.addCleanup(p.stop)

    def policy(self, sid) -> dict | None:
        raw = docs_build.FsPointerStore(self.store).get_text(f"sites/{sid}/access.json")
        return json.loads(raw) if raw else None

    async def test_the_access_job_writes_the_policy_and_never_lowers_it(self):
        s = await self.make_site(status="live", access_version=2,
                                 settings={**s_settings(), "access": {"level": "password", "password_hash": "$2b$12$abc"}})
        sid = str(s["_id"])
        await access.queue_sync(self.db, s["_id"], "test")
        await docs_dispatch.run_once(self.db)
        job = await self.db[JOBS].find_one({"site_id": s["_id"], "kind": "access"})
        self.assertEqual((job["status"], job["target"]), ("done", "local"))
        p = self.policy(sid)
        self.assertEqual((p["site"], p["level"], p["policy_version"]), (sid, "password", 2))
        self.assertNotIn("$2b$", json.dumps(p))
        self.assertEqual(set(p), {"site", "level", "policy_version", "updatedAt"})
        # A newer policy (another writer) wins over an older one.
        store = docs_build.FsPointerStore(self.store)
        store.put_text(f"sites/{sid}/access.json", json.dumps({"site": sid, "level": "members", "policy_version": 5}))
        res = await access.sync_policy(self.db, s["_id"], store=store)
        self.assertFalse(res["written"])
        self.assertEqual(self.policy(sid)["level"], "members")

    async def test_the_build_spec_carries_the_policy_and_builds_a_private_site_closed(self):
        s = await self.make_site(access_version=1, settings={**s_settings(), "access": {"level": "members", "password_hash": None},
                                                             "ai": {"enabled": True, "name": None, "suggestions": []}})
        await self.make_page(s, "/")
        build, job = await self.publish(s)
        spec = await docs_build.build_spec(self.db, job, build)
        self.assertEqual(spec["publish"]["access"], {"level": "members", "policy_version": 1})
        site_json = json.loads(spec["bundle"]["files"]["site.json"])
        self.assertEqual(site_json["ai"], {"enabled": False})
        self.assertEqual(site_json["seo"], {"index": False})
        self.assertNotIn("access", json.dumps(site_json))
        # The publish queued the access job too (a runner from before the policy existed).
        self.assertEqual(await self.db[JOBS].count_documents({"site_id": s["_id"], "kind": "access"}), 1)

    async def test_a_public_site_is_unchanged(self):
        s = await self.make_site(settings={**s_settings(), "ai": {"enabled": True, "name": None, "suggestions": []}})
        await self.make_page(s, "/")
        build, job = await self.publish(s)
        spec = await docs_build.build_spec(self.db, job, build)
        self.assertEqual(spec["publish"]["access"], {"level": "public", "policy_version": 0})
        self.assertTrue(json.loads(spec["bundle"]["files"]["site.json"])["ai"]["enabled"])
        self.assertEqual(await self.db[JOBS].count_documents({"site_id": s["_id"], "kind": "access"}), 0)

    async def test_finish_reconciles_a_policy_that_changed_during_the_build(self):
        s = await self.make_site(access_version=1, settings={**s_settings(), "access": {"level": "members", "password_hash": None}})
        await self.make_page(s, "/")
        build, job = await self.publish(s)
        await self.db[JOBS].delete_many({"kind": "access"})
        # The runner wrote the spec's policy, and it's still current: nothing to do.
        await self.run_build(job, {"ok": True, "manifest_hash": "a" * 64, "access": {"level": "members", "policy_version": 1}})
        self.assertEqual(await self.db[JOBS].count_documents({"kind": "access"}), 0)
        # A runner that wrote an older policy (or none): the access job writes the current one.
        await self.db[SITES].update_one({"_id": s["_id"]}, {"$set": {"access_version": 2}})
        build, job = await self.publish(s)
        await self.db[JOBS].delete_many({"kind": "access"})
        await self.run_build(job, {"ok": True, "manifest_hash": "b" * 64})
        self.assertEqual(await self.db[JOBS].count_documents({"kind": "access"}), 1)


def s_settings() -> dict:
    from app.services import docs_site_settings

    return docs_site_settings.default_settings()

