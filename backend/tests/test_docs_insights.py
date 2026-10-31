"""Insights for Markdrop Guides (services/guide_insights.py, routers/guide_insights.py).

The beacons (the edge's page views, the engine's navigations and searches, "Did this page help?"
and the docs MCP's report_problem), the privacy rules (no raw address or user agent stored, a
daily-rotating visitor hash, DNT / GPC honoured, referrers cut to a host, queries normalised),
CORS limited to the guide's own addresses, rate limits, the owner's switch, rollups and the
Insights tab's roles.
"""

from __future__ import annotations

from tests import _docs_sites_env as base  # noqa: F401  (pins settings first)

import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from bson import ObjectId

from app.limiter import limiter
from app.services import ai_usage, docs_agent, docs_sites, docs_snapshot
from app.services import guide_insights as gi
from tests._docs_sites_env import BASE, DocsSitesCase, settings

SECRET = "s" * 40
INS = "/api/v1/docs/insights"
READER = "203.0.113.7"
PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"
DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"


class PureTests(unittest.TestCase):
    def test_queries_are_normalised(self):
        self.assertEqual(gi.normalize_query("  How   do I\tINSTALL? "), "how do i install?")
        self.assertIsNone(gi.normalize_query("ab"))
        self.assertIsNone(gi.normalize_query("   a  "))
        self.assertIsNone(gi.normalize_query(None))
        self.assertEqual(gi.normalize_query("reset jane.doe@example.com"), "reset [email]")
        self.assertEqual(gi.normalize_query("order 4111 1111 1111 1111"), "order [number]")
        self.assertEqual(gi.normalize_query("ＡＰＩ key"), "api key")  # NFKC
        self.assertEqual(len(gi.normalize_query("x" * 400)), gi.QUERY_MAX)

    def test_paths_and_referrers(self):
        self.assertEqual(gi.clean_path("/start/install/?a=1#b"), "/start/install")
        self.assertEqual(gi.clean_path("/"), "/")
        self.assertEqual(gi.clean_path(""), "/")
        for bad in ("start", "//evil.com", "/a b", "/<x>", None, 5, "/" + "a" * 400):
            self.assertIsNone(gi.clean_path(bad), bad)
        own = ("acme.guides.markdrop.in", "docs.acme.com")
        self.assertEqual(gi.ref_host("https://www.google.com/search?q=secret", own), "google.com")
        self.assertEqual(gi.ref_host("https://news.ycombinator.com/item?id=1", own), "news.ycombinator.com")
        self.assertIsNone(gi.ref_host("https://docs.acme.com/other", own))  # moving around the guide
        self.assertIsNone(gi.ref_host("android-app://com.slack", own))
        self.assertIsNone(gi.ref_host("", own))
        self.assertEqual(gi.clean_country("de"), "DE")
        self.assertIsNone(gi.clean_country("XX"))
        self.assertIsNone(gi.clean_country("DEU"))
        self.assertEqual(gi.device_of(PHONE), "mobile")
        self.assertEqual(gi.device_of(DESKTOP), "desktop")

    def test_opt_out_signals(self):
        self.assertTrue(gi.opted_out("1", None))
        self.assertTrue(gi.opted_out(None, "1"))
        self.assertTrue(gi.opted_out(True))
        self.assertFalse(gi.opted_out("0", None))
        self.assertFalse(gi.opted_out(None, None))

    def test_edge_key(self):
        self.assertIsNone(gi.edge_key(""))
        self.assertIsNone(gi.edge_key("short"))
        k = gi.edge_key(SECRET)
        self.assertEqual(len(k), 64)
        self.assertNotEqual(k, gi.edge_key("t" * 40))
        self.assertNotIn(SECRET, k)

    def test_visitor_hash(self):
        a = gi.visitor_hash("salt1", "site1", READER, DESKTOP)
        self.assertEqual(a, gi.visitor_hash("salt1", "site1", READER, DESKTOP))
        self.assertNotEqual(a, gi.visitor_hash("salt2", "site1", READER, DESKTOP))  # another day
        self.assertNotEqual(a, gi.visitor_hash("salt1", "site2", READER, DESKTOP))  # another guide
        self.assertNotEqual(a, gi.visitor_hash("salt1", "site1", READER, PHONE))
        self.assertNotIn(READER, a)
        self.assertIsNone(gi.visitor_hash("salt1", "site1", None, DESKTOP))

    def test_site_json_carries_the_endpoints(self):
        row = {"_id": ObjectId(), "name": "Acme", "slug": "acme", "settings": {"insights": {"enabled": True}},
               "engine_extra": {}, "domains": []}
        snap = {"pages": [], "settings": {}}
        files, _ = docs_snapshot.content_files(row, snap, url="https://acme.guides.markdrop.in",
                                               ai_api="https://api.markdrop.in")
        sj = json.loads(files["site.json"])
        base_ = f"https://api.markdrop.in/api/v1/docs/insights/{row['_id']}"
        self.assertEqual((sj["feedback"], sj["insights"]), (f"{base_}/feedback", base_))
        self.assertEqual(sj["integrations"], {"markdropApp": False})  # Markdrop's own trackers stay off
        # A site from before the setting existed: on.
        del row["settings"]["insights"]
        sj = json.loads(docs_snapshot.content_files(row, snap, url="https://u", ai_api="https://a")[0]["site.json"])
        self.assertIn("feedback", sj)
        row["settings"]["insights"] = {"enabled": False}
        sj = json.loads(docs_snapshot.content_files(row, snap, url="https://u", ai_api="https://a")[0]["site.json"])
        self.assertNotIn("feedback", sj)
        self.assertNotIn("insights", sj)
        # The Ask AI index builds its copy with no API address: nothing to point at.
        row["settings"]["insights"] = {"enabled": True}
        sj = json.loads(docs_snapshot.content_files(row, snap, url="https://u", ai_api="")[0]["site.json"])
        self.assertNotIn("feedback", sj)


class InsightsCase(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.saved = (settings.docs_access_secret, docs_sites.STUDIO_TTL_S)
        settings.docs_access_secret = SECRET
        docs_sites.STUDIO_TTL_S = 0.0
        docs_sites.reset()
        gi.reset()
        await gi.ensure_indexes(self.db)
        self.site = await self.create("acme")
        self.sid = self.site["id"]
        await self.go_live(self.sid)
        self.host = docs_snapshot.host_for("acme", self.sid)
        self.origin = f"https://{self.host}"
        self.edge = {"Authorization": f"Bearer {gi.edge_key(SECRET)}", "X-Docs-Reader-Ip": READER}

    async def asyncTearDown(self):
        settings.docs_access_secret, docs_sites.STUDIO_TTL_S = self.saved
        docs_sites.reset()
        gi.reset()
        await super().asyncTearDown()

    async def go_live(self, sid: str) -> None:
        limiter.reset()
        b = await self.call("POST", f"/{sid}/publish", json={}, expect=202)
        await self.mark_live(b["id"])

    async def hit(self, body: dict | None = None, headers: dict | None = None, site: str | None = None):
        body = {"path": "/start", "host": self.host, "ua": DESKTOP, **(body or {})}
        return await self.http.post(f"{INS}/{site or self.sid}/hit", json=body,
                                    headers=self.edge if headers is None else headers)

    async def event(self, body: dict, origin: str | None = "own", headers: dict | None = None):
        h = {"Content-Type": "text/plain;charset=UTF-8", "User-Agent": DESKTOP, **(headers or {})}
        if origin:
            h["Origin"] = self.origin if origin == "own" else origin
        return await self.http.post(f"{INS}/{self.sid}/event", content=json.dumps(body), headers=h)

    async def raw(self, **q) -> list[dict]:
        return await self.db[gi.RAW].find({"site": self.sid, **q}).sort([("ts", 1), ("_id", 1)]).to_list(1000)


class CollectionTests(InsightsCase):
    async def test_edge_page_views(self):
        r = await self.hit(headers={})
        self.assertEqual(r.status_code, 401)
        r = await self.hit(headers={"Authorization": "Bearer " + "0" * 64})
        self.assertEqual(r.status_code, 401)
        r = await self.hit({"ref": "https://www.google.com/search?q=private+words", "country": "de", "ua": PHONE})
        self.assertEqual((r.status_code, r.json()), (202, {"status": "ok"}))
        [ev] = await self.raw()
        self.assertEqual((ev["k"], ev["p"], ev["ref"], ev["cc"], ev["dev"]), ("view", "/start", "google.com", "DE", "mobile"))
        self.assertEqual(len(ev["v"]), 24)
        # Nothing that identifies the reader is stored: no address, no user agent, no query string.
        stored = json.dumps(ev, default=str)
        for secret in (READER, "iPhone", "private", "search?q"):
            self.assertNotIn(secret, stored)
        # The same reader again today: the same visitor; a referral from the guide itself isn't one.
        await self.hit({"path": "/start/", "ref": f"{self.origin}/other"})
        evs = await self.raw()
        self.assertEqual(len(evs), 2)
        self.assertIsNone(evs[1]["ref"])
        self.assertNotEqual(evs[0]["v"], evs[1]["v"])  # another user agent: another visitor
        await self.hit({"ua": PHONE})
        self.assertEqual((await self.raw())[2]["v"], evs[0]["v"])

    async def test_dnt_counts_without_a_hash_and_bots_are_dropped(self):
        await self.hit({"dnt": True})
        [ev] = await self.raw()
        self.assertIsNone(ev["v"])
        for ua in ("Googlebot/2.1 (+http://www.google.com/bot.html)", "curl/8.4", "", "python-requests/2"):
            r = await self.hit({"ua": ua})
            self.assertEqual(r.json(), {"status": "ignored"}, ua)
        r = await self.hit({"path": "javascript:alert(1)"})
        self.assertEqual(r.json(), {"status": "ignored"})
        self.assertEqual(len(await self.raw()), 1)

    async def test_unknown_or_unpublished_guides(self):
        r = await self.hit(site=str(ObjectId()))
        self.assertEqual(r.status_code, 404)
        r = await self.hit(site="not-an-id")
        self.assertEqual(r.status_code, 404)
        await self.call("POST", f"/{self.sid}/unpublish", expect=200)
        r = await self.hit()
        self.assertEqual(r.status_code, 404)

    async def test_hit_validation(self):
        r = await self.http.post(f"{INS}/{self.sid}/hit", content=b"[1]", headers=self.edge)
        self.assertEqual(r.status_code, 422)
        r = await self.http.post(f"{INS}/{self.sid}/hit", content=b"{" + b" " * 5000 + b"}", headers=self.edge)
        self.assertEqual(r.status_code, 413)
        r = await self.hit({"path": "/" + "a" * 500})
        self.assertEqual(r.status_code, 422)

    async def test_edge_needs_the_secret(self):
        settings.docs_access_secret = ""
        r = await self.hit()
        self.assertEqual(r.status_code, 401)

    async def test_navigation_and_search_beacons(self):
        r = await self.event({"k": "view", "p": "/guide/next"})
        self.assertEqual((r.status_code, r.json()), (202, {"status": "ok"}))
        r = await self.event({"k": "search", "q": "  Rotate API   Key ", "n": 0, "p": "/"})
        self.assertEqual(r.json(), {"status": "ok"})
        r = await self.event({"k": "search", "q": "ab", "n": 3})
        self.assertEqual(r.json(), {"status": "ignored"})
        r = await self.event({"k": "search", "q": "no count"})
        self.assertEqual(r.json(), {"status": "ignored"})
        r = await self.event({"k": "click", "p": "/"})
        self.assertEqual(r.status_code, 422)
        nav, search = await self.raw()
        self.assertEqual((nav["k"], nav["p"], nav["nav"], nav["ref"]), ("view", "/guide/next", True, None))
        self.assertEqual((search["k"], search["q"], search["n"]), ("search", "rotate api key", 0))
        # Do Not Track / GPC from the browser: counted, no visitor.
        await self.event({"k": "search", "q": "webhooks", "n": 2}, headers={"Sec-GPC": "1"})
        self.assertIsNone((await self.raw(q="webhooks"))[0]["v"])

    async def test_origins(self):
        other = await self.create("other")
        await self.go_live(other["id"])
        other_origin = f"https://{docs_snapshot.host_for('other', other['id'])}"
        for origin in (None, "https://evil.example", other_origin, f"http://{self.host}", "https://markdrop.in"):
            r = await self.event({"k": "view", "p": "/"}, origin=origin)
            self.assertEqual(r.status_code, 403, origin)
            self.assertNotIn("access-control-allow-origin", r.headers)
        r = await self.event({"k": "view", "p": "/"})
        self.assertEqual(r.headers["access-control-allow-origin"], self.origin)
        self.assertNotIn("access-control-allow-credentials", r.headers)
        # The feedback widget's preflight (it sends JSON): the guide's own address only.
        pre = {"Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"}
        r = await self.http.options(f"{INS}/{self.sid}/feedback", headers={"Origin": self.origin, **pre})
        self.assertEqual((r.status_code, r.headers.get("access-control-allow-origin")), (204, self.origin))
        r = await self.http.options(f"{INS}/{self.sid}/feedback", headers={"Origin": other_origin, **pre})
        self.assertNotEqual(r.headers.get("access-control-allow-origin"), other_origin)
        # Ask AI's own endpoints still take any live guide (unchanged).
        r = await self.http.options("/api/v1/docs/ask", headers={"Origin": other_origin, **pre})
        self.assertEqual(r.headers.get("access-control-allow-origin"), other_origin)

    async def test_feedback(self):
        h = {"Origin": self.origin}
        r = await self.http.post(f"{INS}/{self.sid}/feedback", json={"path": "/start", "helpful": True}, headers=h)
        self.assertEqual((r.status_code, r.json()), (202, {"status": "ok"}))
        r = await self.http.post(f"{INS}/{self.sid}/feedback", headers=h,
                                 json={"path": "/start?x=1", "helpful": False, "comment": "  " + "w" * 1500})
        self.assertEqual(r.json(), {"status": "ok"})
        # The docs MCP's report_problem: server side, no Origin.
        r = await self.http.post(f"{INS}/{self.sid}/feedback",
                                 json={"path": "/api", "helpful": False, "comment": "[docs MCP] The example 404s"})
        self.assertEqual(r.json(), {"status": "ok"})
        r = await self.http.post(f"{INS}/{self.sid}/feedback", headers={"Origin": "https://evil.example"},
                                 json={"path": "/start", "helpful": False})
        self.assertEqual(r.status_code, 403)
        r = await self.http.post(f"{INS}/{self.sid}/feedback", json={"path": "/start", "helpful": "maybe"})
        self.assertEqual(r.status_code, 422)
        rows = await self.db[gi.FEEDBACK].find({"site": self.sid}).sort("ts", 1).to_list(10)
        self.assertEqual([(r["path"], r["helpful"], r["source"]) for r in rows],
                         [("/start", True, "page"), ("/start", False, "page"), ("/api", False, "mcp")])
        self.assertEqual(len(rows[1]["comment"]), gi.COMMENT_MAX)
        self.assertEqual(rows[2]["comment"], "The example 404s")
        self.assertFalse(any(r["resolved"] for r in rows))

    async def test_feedback_daily_bound(self):
        with mock.patch.object(gi, "FEEDBACK_PER_SITE_DAY", 2):
            for i, want in enumerate(("ok", "ok", "ignored")):
                limiter.reset()
                r = await self.http.post(f"{INS}/{self.sid}/feedback", json={"path": "/", "helpful": True})
                self.assertEqual(r.json(), {"status": want}, i)

    async def test_rate_limits(self):
        limiter.reset()
        codes = [(await self.http.post(f"{INS}/{self.sid}/feedback", json={"path": "/", "helpful": True})).status_code
                 for _ in range(11)]
        self.assertEqual(codes[:10], [202] * 10)
        self.assertEqual(codes[10], 429)
        limiter.reset()
        codes = [(await self.event({"k": "view", "p": "/"})).status_code for _ in range(61)]
        self.assertEqual((codes[59], codes[60]), (202, 429))
        # The edge's views are limited per reader, not per edge address.
        limiter.reset()
        for _ in range(120):
            await self.hit()
        self.assertEqual((await self.hit()).status_code, 429)
        r = await self.hit(headers={**self.edge, "X-Docs-Reader-Ip": "198.51.100.9"})
        self.assertEqual(r.status_code, 202)

    async def test_owner_switch(self):
        await self.call("PATCH", f"/{self.sid}", "editor", 403, json={"settings": {"insights": {"enabled": False}}})
        got = await self.call("PATCH", f"/{self.sid}", "admin", json={"settings": {"insights": {"enabled": False}}})
        self.assertIs(got["settings"]["insights"]["enabled"], False)
        self.assertEqual((await self.hit()).json(), {"status": "off"})
        self.assertEqual((await self.event({"k": "view", "p": "/"})).json(), {"status": "off"})
        r = await self.http.post(f"{INS}/{self.sid}/feedback", json={"path": "/", "helpful": True})
        self.assertEqual(r.json(), {"status": "off"})
        self.assertEqual(await self.raw(), [])
        self.assertEqual(await self.db[gi.FEEDBACK].count_documents({}), 0)
        # A new site defaults to on, and the setting validates.
        await self.call("PATCH", f"/{self.sid}", "admin", 422, json={"settings": {"insights": {"enabled": "x"}}})
        await self.call("PATCH", f"/{self.sid}", "admin", 422, json={"settings": {"insights": {"other": 1}}})
        self.assertIs((await self.create("fresh"))["settings"]["insights"]["enabled"], True)


class SaltTests(InsightsCase):
    async def test_salts_rotate_daily_and_expire(self):
        s1 = await gi.day_salt(self.db, "2026-10-30")
        s2 = await gi.day_salt(self.db, "2026-10-31")
        self.assertNotEqual(s1, s2)
        gi.reset()
        self.assertEqual(await gi.day_salt(self.db, "2026-10-30"), s1)  # shared across processes
        row = await self.db[gi.SALTS].find_one({"_id": "2026-10-30"})
        exp = row["expires_at"].replace(tzinfo=timezone.utc)
        self.assertEqual(exp, datetime(2026, 11, 1, tzinfo=timezone.utc))
        a = gi.visitor_hash(s1, self.sid, READER, DESKTOP)
        b = gi.visitor_hash(s2, self.sid, READER, DESKTOP)
        self.assertNotEqual(a, b)

    async def test_views_on_two_days_are_two_visitors(self):
        day1 = datetime(2026, 10, 30, 12, tzinfo=timezone.utc)
        with mock.patch.object(gi, "now", lambda: day1):
            await self.hit()
        with mock.patch.object(gi, "now", lambda: day1 + timedelta(days=1)):
            await self.hit()
        a, b = await self.raw()
        self.assertNotEqual(a["v"], b["v"])


class DashboardTests(InsightsCase):
    async def seed(self):
        """Yesterday and today: views (two visitors), a search with no results, feedback, Ask AI."""
        today = datetime.now(timezone.utc).replace(hour=12)
        yday = today - timedelta(days=1)
        for when, path, ua, ref in ((yday, "/start", DESKTOP, "https://google.com/"),
                                    (yday, "/start", PHONE, None), (yday, "/", DESKTOP, None),
                                    (today, "/start", DESKTOP, "https://github.com/acme")):
            with mock.patch.object(gi, "now", lambda w=when: w):
                await self.hit({"path": path, "ua": ua, "ref": ref, "country": "IN"})
        for q, n in (("webhooks", 0), ("webhooks", 0), ("install", 4)):
            await self.event({"k": "search", "q": q, "n": n})
        h = {"Origin": self.origin}
        await self.http.post(f"{INS}/{self.sid}/feedback", json={"path": "/start", "helpful": True}, headers=h)
        await self.http.post(f"{INS}/{self.sid}/feedback", json={"path": "/start", "helpful": False,
                                                                 "comment": "Step 3 is wrong"}, headers=h)
        rows = []
        for i, (q, outcome, ins) in enumerate((("How do I rotate keys?", "answered", True),
                                               ("how do i rotate keys", "answered", True),
                                               ("Is there SSO?", "no_answer", True),
                                               ("secret question", "answered", False),
                                               ("rate limited", "limit", True))):
            rows.append({"feature": docs_agent.FEATURE, "request_id": f"{i:032x}", "site": self.sid,
                         "ts": today - timedelta(minutes=i), "outcome": outcome, "question": q,
                         **({"insights": True} if ins else {})})
        await self.db[ai_usage.REQUESTS].insert_many(rows)
        return yday

    async def test_rollup_and_overview(self):
        yday = await self.seed()
        self.assertEqual(await gi.rollup_due(self.db), 1)
        self.assertEqual(await gi.rollup_due(self.db), 0)  # once
        row = await self.db[gi.DAILY].find_one({"site": self.sid, "day": gi.day_key(yday)})
        self.assertEqual((row["views"], row["visitors"]), (3, 2))
        self.assertEqual(row["pages"][0], {"k": "/start", "n": 2, "v": 2})
        self.assertEqual(row["refs"], [{"k": "google.com", "n": 1}])
        # Rolled-up days are read from the rollup (the raw events could be gone).
        await self.db[gi.RAW].delete_many({"day": gi.day_key(yday)})

        ov = await self.get(f"/{self.sid}/insights?range=7d", "viewer")
        self.assertEqual((ov["range"], ov["enabled"], ov["live"]), ("7d", True, True))
        self.assertEqual((ov["can_manage"], ov["can_resolve"]), (False, False))
        self.assertEqual(len(ov["daily"]), 7)
        self.assertEqual(ov["totals"], {"views": 4, "visitors": 3, "searches": 3, "empty_searches": 2})
        self.assertEqual(ov["pages"][0], {"path": "/start", "title": None, "views": 3, "visitors": 3})
        self.assertEqual({r["host"] for r in ov["referrers"]}, {"google.com", "github.com"})
        self.assertEqual(ov["countries"], [{"country": "IN", "views": 4}])
        self.assertEqual({d["device"] for d in ov["devices"]}, {"desktop", "mobile"})
        self.assertEqual(ov["searches"]["empty"], [{"q": "webhooks", "n": 2}])
        self.assertEqual(ov["searches"]["top"][0], {"q": "webhooks", "n": 2, "empty": 2})
        ask = ov["ask"]
        self.assertEqual((ask["asked"], ask["answered"], ask["unanswered"]), (3, 2, 1))
        self.assertEqual(ask["top"][0]["n"], 2)  # the two wordings of one question
        self.assertEqual([q["q"] for q in ask["unanswered_top"]], ["Is there SSO?"])
        self.assertNotIn("secret question", json.dumps(ov))  # asked while Insights was off
        fb = ov["feedback"]
        self.assertEqual((fb["yes"], fb["no"], fb["helpful_pct"], fb["open"]), (1, 1, 50, 1))
        self.assertEqual([i["comment"] for i in fb["items"]], ["Step 3 is wrong"])
        self.assertEqual(fb["pages"], [{"path": "/start", "yes": 1, "no": 1}])
        # Page titles come from the live build.
        ov = await self.get(f"/{self.sid}/insights?range=30d")
        self.assertEqual((ov["can_manage"], ov["can_resolve"]), (True, True))
        self.assertEqual(len(ov["daily"]), 30)

    async def test_roles_and_resolving(self):
        await self.seed()
        await self.get(f"/{self.sid}/insights", "stranger", 404)
        await self.get(f"/{self.sid}/insights?range=1y", expect=422)
        ov = await self.get(f"/{self.sid}/insights", "viewer")
        fid = ov["feedback"]["items"][0]["id"]
        url = f"/{self.sid}/insights/feedback/{fid}"
        await self.call("PATCH", url, "viewer", 403, json={"resolved": True})
        got = await self.call("PATCH", url, "editor", json={"resolved": True})
        self.assertTrue(got["resolved"])
        ov = await self.get(f"/{self.sid}/insights", "viewer")
        self.assertEqual((ov["feedback"]["open"], ov["feedback"]["items"]), (0, []))
        ov = await self.get(f"/{self.sid}/insights?feedback=resolved", "viewer")
        self.assertEqual([i["id"] for i in ov["feedback"]["items"]], [fid])
        await self.call("PATCH", f"/{self.sid}/insights/feedback/{ObjectId()}", "editor", 404, json={"resolved": True})
        # Another guide's feedback can't be touched through this one.
        other = await self.create("other")
        await self.call("PATCH", f"/{other['id']}/insights/feedback/{fid}", "editor", 404, json={"resolved": False})

    async def test_clear_and_delete(self):
        await self.seed()
        await self.call("DELETE", f"/{self.sid}/insights", "editor", 403)
        got = await self.call("DELETE", f"/{self.sid}/insights", "admin")
        self.assertEqual(got["cleared"]["feedback"], 2)
        ov = await self.get(f"/{self.sid}/insights")
        self.assertEqual((ov["totals"]["views"], ov["ask"]["asked"], ov["since"]), (0, 0, None))
        await self.seed()
        await self.call("DELETE", f"/{self.sid}", expect=200)
        for coll in (gi.RAW, gi.DAILY, gi.FEEDBACK):
            self.assertEqual(await self.db[coll].count_documents({"site": self.sid}), 0, coll)

    async def test_empty_guide(self):
        ov = await self.get(f"/{self.sid}/insights?range=90d")
        self.assertEqual((ov["totals"]["views"], ov["since"], ov["previous"]), (0, None, None))
        self.assertEqual(len(ov["daily"]), 90)
        self.assertEqual(ov["feedback"]["helpful_pct"], None)


from tests.test_docs_studio_ai import StudioBase, Turn  # noqa: E402


class AskLedgerTests(StudioBase):
    """Ask AI's ledger marks a guide's question for its Insights only while Insights is on."""

    async def test_the_insights_mark(self):
        sid = await self.make_site()
        events, _ = await self.ask(sid, [Turn(text="Use the green canister.")])
        row = await self.db["ai_requests"].find_one({"request_id": dict(events)["done"]["request_id"]})
        self.assertIs(row.get("insights"), True)
        await self.db["docs_sites"].update_one({"_id": ObjectId(sid)}, {"$set": {"settings.insights": {"enabled": False}}})
        events, _ = await self.ask(sid, [Turn(text="Use the green canister.")])
        row = await self.db["ai_requests"].find_one({"request_id": dict(events)["done"]["request_id"]})
        self.assertNotIn("insights", row)
        # Markdrop's own docs: never.
        events, _ = await self.ask(None, [Turn(text="ok")])
        row = await self.db["ai_requests"].find_one({"request_id": dict(events)["done"]["request_id"]})
        self.assertNotIn("insights", row)


class AskFlagTests(unittest.TestCase):
    def test_studio_state_reads_the_switch(self):
        row = {"_id": ObjectId(), "slug": "a", "settings": {"insights": {"enabled": False}}, "domains": []}
        st = docs_sites._studio_from(row, {"_id": ObjectId(), "snapshot_id": ObjectId()}, {})
        self.assertFalse(st.insights)
        row["settings"] = {}
        st = docs_sites._studio_from(row, {"_id": ObjectId(), "snapshot_id": ObjectId()}, {})
        self.assertTrue(st.insights)


if __name__ == "__main__":
    unittest.main()
