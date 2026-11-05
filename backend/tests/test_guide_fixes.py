"""The Fix list for Markdrop Guides (services/guide_signals.py, services/guide_fixes.py,
services/guide_fix_drafts.py, routers/guide_fixes.py, the signal beacon in routers/guide_insights.py).

Pure parts with synthetic data: beacon cleaning (bounds, nothing a reader typed), rollup merging,
section drop detection against a page's own curve, clustering of unanswered questions and empty
searches, video retention falls, broken links, stale and heavy pages, scoring and levels. Then the
beacon (origin, DNT / GPC, the owner's switch), rollups, detection runs and their lifecycle (new,
updated, fixed, reopened only on fresh evidence, quiet items closing, dismissals sticking), the API's
roles, the publish that marks an applied fix fixed, and AI drafts with a fake Anthropic client
(budget consumed, refused when the guide's budget is used up, link fixes free).
"""

from __future__ import annotations

from tests import _docs_sites_env as base  # noqa: F401  (pins settings first)

import json
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import mock

from bson import ObjectId

from app.limiter import limiter
from app.services import ai_usage, docs_agent, docs_editor_ai, docs_sites, docs_snapshot
from app.services import guide_fix_drafts as fd
from app.services import guide_fixes as gf
from app.services import guide_insights as gi
from app.services import guide_signals as gs
from tests._docs_sites_env import DocsSitesCase, now, settings

SIG = "/api/v1/docs/insights"
DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"
NOW = datetime(2026, 11, 2, 12, 0, tzinfo=timezone.utc)


def hist_rec(n: int, hist: dict[int, int], ids: dict[int, str] | None = None) -> dict:
    return {"n": n, "m": sum(hist.values()), "t": 0, "hist": {str(k): v for k, v in hist.items()},
            "ids": {str(k): v for k, v in (ids or {}).items()}}


def bits(slices) -> str:
    v = 0
    for i in slices:
        v |= 1 << i
    return f"{v:010x}"


# ── Pure ──────────────────────────────────────────────────────────────────────


class BeaconCleaning(unittest.TestCase):
    def test_read_beacon(self):
        got = gs.clean_read({"k": "read", "p": "/start/?q=secret#x", "n": 5, "d": 2, "h": "install-the-cli", "t": 99999,
                             "w": 4, "c": [[1, 0], [2, "x"], [9, 3]], "v": [{"i": "tour", "l": 120, "b": bits([0, 1, 2])}],
                             "email": "jane@example.com", "q": "what I typed"})
        self.assertEqual(got["p"], "/start")
        self.assertEqual((got["n"], got["d"], got["h"], got["w"]), (5, 2, "install-the-cli", 4))
        self.assertEqual(got["t"], gs.MAX_SECONDS)
        self.assertEqual(got["c"], [[1, 0], [9, 3]])
        self.assertEqual(got["v"], [{"i": "tour", "l": 120, "b": [0, 1, 2]}])
        stored = json.dumps(got)
        for secret in ("jane", "typed", "secret"):
            self.assertNotIn(secret, stored)  # unknown fields and query strings never stored

    def test_read_bounds(self):
        self.assertIsNone(gs.clean_read({"p": "/a", "n": 3, "d": 4}))      # deeper than the end
        self.assertIsNone(gs.clean_read({"p": "/a", "n": 3, "d": -2}))
        self.assertIsNone(gs.clean_read({"p": "nope", "n": 3, "d": 1}))
        self.assertIsNone(gs.clean_read({"p": "/a", "n": True, "d": 1}))
        self.assertIsNone(gs.clean_read({"p": "/a", "n": 999, "d": 1}))
        got = gs.clean_read({"p": "/a", "n": 3, "d": 3, "h": "x", "w": 500})
        self.assertNotIn("h", got)              # the end of the page is no section
        self.assertEqual(got["w"], 1)           # weights out of bounds count once
        got = gs.clean_read({"p": "/a", "n": 3, "d": 1, "h": "<script>", "v": [{"i": "a b", "l": 9, "b": "zz"}]})
        self.assertNotIn("h", got)
        self.assertNotIn("v", got)
        self.assertIsNone(gs.watched("0000000000"))
        self.assertEqual(gs.watched("8000000001"), [0, 39])

    def test_broken_beacon(self):
        self.assertEqual(gs.clean_broken({"p": "/old/page/", "f": "/start?x=1"}), {"p": "/old/page", "f": "/start"})
        self.assertEqual(gs.clean_broken({"p": "/old", "f": "/old"}), {"p": "/old", "f": None})
        self.assertIsNone(gs.clean_broken({"p": "/"}))
        self.assertEqual(gs.clean_broken({"p": "/x", "f": "https://evil.example/a"}), {"p": "/x", "f": None})

    def test_merge(self):
        day1 = {"reading": [{"p": "/a", "n": 4, "m": 3, "t": 30, "hist": {"0": 2, "4": 1}, "ids": {"0": "one"}}],
                "videos": [{"i": "tour", "p": "/a", "l": 60, "plays": 2, "curve": [2] + [1] * 39}],
                "broken": [{"p": "/gone", "f": "/a", "n": 2, "last": NOW}], "copies": [{"p": "/a", "s": 0, "b": 0, "n": 1}]}
        day2 = {"reading": [{"p": "/a", "n": 5, "m": 2, "t": 10, "hist": {"0": 1, "2": 1}, "ids": {"2": "three"}}],
                "videos": [{"i": "tour", "p": "/b", "l": 61, "plays": 3, "curve": [3] * 40}],
                "broken": [{"p": "/gone", "f": "/a", "n": 1, "last": NOW - timedelta(days=1)}],
                "copies": [{"p": "/a", "s": 0, "b": 0, "n": 4}]}
        m = gs.merge([day1, day2])
        a = m["reading"]["/a"]
        self.assertEqual((a["n"], a["m"], a["hist"], a["ids"]), (5, 5, {"0": 3, "4": 1, "2": 1}, {"0": "one", "2": "three"}))
        v = m["videos"]["tour"]
        self.assertEqual((v["plays"], v["l"], v["curve"][0], v["curve"][1], v["pages"]), (5, 61, 5, 4, {"/a": 2, "/b": 3}))
        self.assertEqual(m["broken"], [{"p": "/gone", "f": "/a", "n": 3, "last": NOW}])
        self.assertEqual(m["copies"], [{"p": "/a", "s": 0, "b": 0, "n": 5}])


class Detection(unittest.TestCase):
    def pages(self, **extra):
        heads = [{"id": "install", "text": "Install", "depth": 2, "line": 1},
                 {"id": "configure-the-agent", "text": "Configure the agent", "depth": 2, "line": 5},
                 {"id": "send-data", "text": "Send data", "depth": 2, "line": 9},
                 {"id": "next-steps", "text": "Next steps", "depth": 2, "line": 12}]
        return {"/start": {"title": "Quickstart", "page_id": "p1", "readers": 200, "headings": heads, **extra}}

    def test_drop_at_an_abnormal_section(self):
        # 100 measured readers of a 4-section page: most leave at "Configure the agent" (index 1).
        rec = hist_rec(4, {-1: 6, 0: 7, 1: 45, 2: 6, 3: 8, 4: 28}, {1: "configure-the-agent"})
        [c] = gf.detect_drops({"now": NOW, "reading": {"/start": rec}, "pages": self.pages()})
        self.assertEqual((c["type"], c["key"], c["section"]), ("drop", "drop:/start#configure-the-agent", "configure-the-agent"))
        self.assertEqual(c["title"], "Readers leave at “Configure the agent”")
        self.assertEqual((c["evidence"]["left_pct"], c["evidence"]["typical_pct"], c["readers"]), (45, 6, 45))
        curve = c["evidence"]["curve"]
        self.assertEqual([p["reached_pct"] for p in curve], [100, 94, 87, 42, 36, 28])
        self.assertEqual(curve[2]["title"], "Configure the agent")

    def test_no_drop_on_a_smooth_curve_or_too_little_data(self):
        smooth = hist_rec(4, {-1: 10, 0: 12, 1: 11, 2: 13, 3: 14, 4: 40}, {1: "configure-the-agent"})
        self.assertEqual(gf.detect_drops({"now": NOW, "reading": {"/start": smooth}, "pages": self.pages()}), [])
        few = hist_rec(4, {1: 15, 4: 5}, {1: "configure-the-agent"})
        self.assertEqual(gf.detect_drops({"now": NOW, "reading": {"/start": few}, "pages": self.pages()}), [])
        # The last section and the end of the page are finishing, never "leaving".
        late = hist_rec(4, {-1: 5, 0: 5, 1: 5, 2: 5, 3: 60, 4: 20}, {3: "next-steps"})
        self.assertEqual(gf.detect_drops({"now": NOW, "reading": {"/start": late}, "pages": self.pages()}), [])
        short = hist_rec(2, {0: 80, 2: 20}, {0: "install"})
        self.assertEqual(gf.detect_drops({"now": NOW, "reading": {"/start": short}, "pages": self.pages()}), [])

    def test_drop_in_the_introduction(self):
        rec = hist_rec(4, {-1: 50, 0: 5, 1: 6, 2: 5, 3: 4, 4: 30})
        [c] = gf.detect_drops({"now": NOW, "reading": {"/start": rec}, "pages": self.pages()})
        self.assertEqual((c["key"], c["section"]), ("drop:/start#_intro", None))
        self.assertIn("before the first section", c["title"])
        self.assertLess(c["severity"], gf.SEVERITY["drop"])

    def test_clustering_questions(self):
        qs = ["Do you support SSO with Okta?", "do you support sso with okta", "SSO with Okta?", "Okta SSO setup",
              "How do I connect Snowflake?", "How do I connect Snowflake", "How do I connect Postgres?",
              "Can I export a dashboard to CSV?"]
        corpus = ["Connect Postgres", "Connect MySQL", "Connect BigQuery", "Build a dashboard", "API keys"]
        cl = gf.cluster([{"text": q, "n": 1, "last": NOW} for q in qs], corpus=corpus)
        by = {c["key"]: c for c in cl}
        sso = by["do you support sso with okta"]
        self.assertEqual(sso["n"], 4)
        self.assertEqual(set(sso["aliases"]), {"do you support sso with okta", "sso with okta", "okta sso setup"})
        self.assertEqual(sso["samples"][0], {"text": "Do you support SSO with Okta?", "n": 2})
        # Snowflake and Postgres share only a common word ("connect"): two problems.
        self.assertEqual(by["how do i connect snowflake"]["n"], 2)
        self.assertEqual(by["how do i connect postgres"]["n"], 1)
        self.assertEqual(cl[0]["key"], "do you support sso with okta")
        # The product's own name says nothing about what a question is about.
        cl = gf.cluster([{"text": t, "n": 1} for t in ("terraform provider", "acme terraform", "Acme Terraform provider?")],
                        stop=frozenset({"acme"}))
        self.assertEqual([c["n"] for c in cl], [3])

    def test_asks_and_searches(self):
        data = {"now": NOW, "pages": self.pages(), "asked": [],
                "questions": [{"q": "Do you support SSO with Okta?", "ts": NOW - timedelta(days=2), "page": "/start"},
                              {"q": "SSO with Okta?", "ts": NOW - timedelta(days=1), "page": "/start"},
                              {"q": "Is there a dark mode?", "ts": NOW, "page": None}],
                "empty_searches": [{"q": "sso", "n": 9, "last": NOW}, {"q": "sso setup", "n": 2, "last": NOW},
                                   {"q": "vat", "n": 2, "last": NOW}]}
        [ask] = gf.detect_asks(data)
        self.assertEqual((ask["type"], ask["readers"], ask["path"]), ("ask", 2, "/start"))
        self.assertEqual(ask["last_seen"], NOW - timedelta(days=1))
        [search] = gf.detect_searches(data)
        self.assertEqual((search["key"], search["readers"]), ("search:sso", 11))   # vat: 2, under the bar
        self.assertEqual(set(search["aliases"]), {"search:sso", "search:sso setup"})

    def test_not_helpful(self):
        data = {"now": NOW, "pages": self.pages(), "votes": {"/start": (4, 6), "/fine": (9, 1), "/few": (0, 2)},
                "comments": {"/start": [{"id": "c1", "comment": "Step 2 fails behind a proxy", "ts": NOW}]}}
        [c] = gf.detect_not_helpful(data)
        self.assertEqual((c["key"], c["evidence"]["helpful_pct"], c["evidence"]["no"]), ("helpful:/start", 40, 6))
        self.assertEqual(c["evidence"]["comments"][0]["text"], "Step 2 fails behind a proxy")
        self.assertEqual(c["readers"], 120)  # 200 readers x 6/10 said no

    def test_video_fall(self):
        plays = 50
        curve = [50] * 10 + [48, 46, 20, 19] + [18] * 26          # most leave around slice 11 to 12
        [c] = gf.detect_videos({"now": NOW, "pages": self.pages(), "video_titles": {"tour": "Product tour"},
                                "videos": {"tour": {"plays": plays, "l": 160, "curve": curve, "pages": {"/start": 50}}}})
        self.assertEqual(c["key"], "video:tour")
        self.assertEqual(c["title"], "“Product tour” loses most viewers at 0:44")
        self.assertEqual((c["evidence"]["fall_pct"], c["readers"], c["path"]), (56, 28, "/start"))
        # A gentle decline, and a fall in the ending, are not problems.
        gentle = [50 - i for i in range(40)]
        ending = [50] * 36 + [10] * 4
        for cv in (gentle, ending):
            self.assertIsNone(gf.video_fall(cv, plays))
        self.assertEqual(gf.detect_videos({"now": NOW, "videos": {"x": {"plays": 3, "l": 10, "curve": curve}}}), [])

    def test_broken_links(self):
        pages = {"/start": {"title": "Quickstart", "readers": 100}, "/guides/connect-postgres": {"title": "Postgres", "readers": 50},
                 "/guides/alert-rules": {"title": "Alert rules", "readers": 20}}
        data = {"now": NOW, "pages": pages, "redirects": ["/old-home"],
                "broken_hits": [{"p": "/guides/postgres", "f": "/start", "n": 3, "last": NOW},
                                {"p": "/random", "f": None, "n": 1, "last": NOW},
                                {"p": "/old-home", "f": None, "n": 9, "last": NOW},
                                {"p": "/changelog", "f": None, "n": 4, "last": NOW}],
                "links": [{"page": "/guides/connect-postgres", "target": "/guides/alert-rule"},
                          {"page": "/start", "target": "/guides/alert-rules"}, {"page": "/start", "target": "/llms.txt"}]}
        got = {c["key"]: c for c in gf.detect_broken(data)}
        self.assertEqual(set(got), {"broken:/guides/postgres", "broken:/guides/alert-rule"})
        hit = got["broken:/guides/postgres"]
        self.assertEqual((hit["readers"], hit["path"], hit["evidence"]["suggested"]), (3, "/start", "/guides/connect-postgres"))
        link = got["broken:/guides/alert-rule"]
        self.assertEqual((link["path"], link["evidence"]["suggested"], link["readers"]), ("/guides/connect-postgres", "/guides/alert-rules", 5))
        self.assertLess(link["severity"], hit["severity"])

    def test_stale_and_heavy(self):
        pages = {"/old": {"title": "API keys", "readers": 80, "updated_at": NOW - timedelta(days=250), "words": 900},
                 "/fresh": {"title": "New", "readers": 90, "updated_at": NOW - timedelta(days=10)},
                 "/old-quiet": {"title": "Rare", "readers": 3, "updated_at": NOW - timedelta(days=400)},
                 "/long": {"title": "CLI reference", "readers": 40, "words": 12400, "media": 4, "updated_at": NOW}}
        [stale] = gf.detect_stale({"now": NOW, "pages": pages})
        self.assertEqual((stale["key"], stale["evidence"]["age_days"]), ("stale:/old", 250))
        self.assertIn("8 months", stale["title"])
        [heavy] = gf.detect_heavy({"now": NOW, "pages": pages})
        self.assertEqual(heavy["key"], "heavy:/long")
        self.assertIn("12,400 words", heavy["summary"])

    def test_scoring(self):
        self.assertEqual(gf.recency(NOW, NOW), 1.0)
        self.assertAlmostEqual(gf.recency(NOW - timedelta(days=14), NOW), 0.5)
        self.assertEqual(gf.recency(NOW - timedelta(days=400), NOW), 0.1)
        self.assertEqual(gf.score(40, 0.5, NOW - timedelta(days=14), NOW), (10.0, 0.5))
        self.assertEqual(gf.level(30, 100), "high")
        self.assertEqual(gf.level(30, 1000), "medium")   # 5% of 1,000 readers is 50
        self.assertEqual(gf.level(2, 10), "low")
        data = {"now": NOW, "total_readers": 400, "pages": self.pages(),
                "votes": {"/start": (2, 8)}, "comments": {},
                "empty_searches": [{"q": "sso", "n": 30, "last": NOW - timedelta(days=28)}]}
        ranked = gf.detect_all(data)
        self.assertEqual([c["type"] for c in ranked], ["not_helpful", "search"])
        self.assertEqual(ranked[0]["page_id"], "p1")
        self.assertGreater(ranked[0]["impact"], ranked[1]["impact"])

    def test_markdown_helpers(self):
        md = ("---\ntitle: Q\n---\nIntro text.\n\n## Install\nRun it. See [setup](/guides/setup#x) and "
              "[home](/).\n\n```sh\n# not a heading\necho [x](/in-code)\n```\n\n### Linux\nApt.\n\n## Next\nDone.\n"
              "::card{href=\"/guides/alerts\"}\n")
        self.assertEqual([h["id"] for h in gf.headings_of(md)], ["install", "linux", "next"])
        sec = gf.section_of(md, "install")
        self.assertTrue(sec["markdown"].startswith("## Install"))
        self.assertIn("### Linux", sec["markdown"])
        self.assertNotIn("## Next", sec["markdown"])
        self.assertEqual(gf.section_of(md, None)["markdown"], "Intro text.")
        self.assertIsNone(gf.section_of(md, "missing"))
        self.assertEqual(gf.internal_links(md), ["/guides/setup", "/", "/guides/alerts"])
        self.assertEqual(gf.clock(42), "0:42")
        self.assertEqual(gf.clock(3725), "1:02:05")

    def test_parse_output(self):
        got = fd.parse_output("<summary>Shorter steps.</summary>\n<markdown>\n## Install\n\nRun it.\n</markdown>")
        self.assertEqual((got["summary"], got["markdown"], got["title"]), ("Shorter steps.", "## Install\n\nRun it.", None))
        got = fd.parse_output("Just some markdown")
        self.assertEqual(got["markdown"], "Just some markdown")
        got = fd.parse_output("<summary>x</summary><title># Single sign-on</title><markdown>Body</markdown>")
        self.assertEqual(got["title"], "Single sign-on")


# ── With the database ─────────────────────────────────────────────────────────


QUICKSTART = """Get Acme running in ten minutes.

## Install the CLI

Run `npm i -g acme`.

## Configure the agent

Edit `acme.yml` and set your key. See [API keys](/reference/api-keys) and [alerts](/guides/alert-rule).

## Send data

Run `acme send`.

## Next steps

Read the guides.
"""


def usage_ns():
    return SimpleNamespace(input_tokens=900, output_tokens=120, cache_read_input_tokens=0,
                           cache_creation_input_tokens=0, cache_creation=None)


class FakeClient:
    def __init__(self):
        self.calls: list[dict] = []
        self.reply = "<summary>Split the step.</summary>\n<markdown>\n## Configure the agent\n\n1. Open `acme.yml`.\n</markdown>"
        self.stop = "end_turn"
        outer = self

        class Messages:
            async def create(self, **params):
                outer.calls.append(params)
                return SimpleNamespace(content=[SimpleNamespace(type="text", text=outer.reply)], stop_reason=outer.stop,
                                       stop_details=None, usage=usage_ns(), model="claude-haiku-5-5")

        self.messages = Messages()


class FixCase(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.saved = (settings.docs_access_secret, docs_sites.STUDIO_TTL_S)
        settings.docs_access_secret = "s" * 40
        docs_sites.STUDIO_TTL_S = 0.0
        docs_sites.reset()
        gi.reset()
        await gi.ensure_indexes(self.db)
        await gs.ensure_indexes(self.db)
        await gf.ensure_indexes(self.db)
        self.site = await self.create("acme")
        self.sid = self.site["id"]
        page = await self.call("POST", f"/{self.sid}/pages", expect=201,
                               json={"path": "/start", "title": "Quickstart", "markdown": QUICKSTART})
        self.page_id = page["id"]
        await self.call("POST", f"/{self.sid}/pages", expect=201,
                        json={"path": "/reference/api-keys", "title": "API keys", "markdown": "Keys.\n"})
        await self.call("POST", f"/{self.sid}/pages", expect=201,
                        json={"path": "/guides/alert-rules", "title": "Alert rules", "markdown": "Rules.\n"})
        await self.go_live()
        self.host = docs_snapshot.host_for("acme", self.sid)
        self.origin = f"https://{self.host}"

    async def asyncTearDown(self):
        settings.docs_access_secret, docs_sites.STUDIO_TTL_S = self.saved
        docs_sites.reset()
        gi.reset()
        await super().asyncTearDown()

    async def go_live(self) -> None:
        limiter.reset()
        b = await self.call("POST", f"/{self.sid}/publish", json={}, expect=202)
        await self.mark_live(b["id"])
        docs_sites.reset()

    async def row(self) -> dict:
        return await self.db["docs_sites"].find_one({"_id": ObjectId(self.sid)})

    async def signal(self, body: dict, origin: str | None = "own", headers: dict | None = None):
        h = {"Content-Type": "text/plain;charset=UTF-8", "User-Agent": DESKTOP, **(headers or {})}
        if origin:
            h["Origin"] = self.origin if origin == "own" else origin
        return await self.http.post(f"{SIG}/{self.sid}/signal", content=json.dumps(body), headers=h)

    async def seed_reads(self, n_leave: int = 45, *, when: datetime | None = None):
        """100 measured reads of /start, most leaving at "Configure the agent"."""
        ts = when or now()
        rows = []
        for d, k in ((-1, 6), (0, 7), (1, n_leave), (2, 6), (3, 8), (4, 28)):
            for _ in range(k):
                rows.append({"site": self.sid, "k": "read", "ts": ts, "day": gi.day_key(ts), "p": "/start", "n": 4,
                             "d": d, "w": 1, **({"h": ["install-the-cli", "configure-the-agent", "send-data", "next-steps"][d]}
                                                if 0 <= d < 4 else {})})
        await self.db[gi.RAW].insert_many(rows)


class SignalBeacon(FixCase):
    async def test_beacon(self):
        r = await self.signal({"k": "read", "p": "/start", "n": 4, "d": 1, "h": "configure-the-agent", "t": 40,
                               "c": [[1, 0]], "v": [{"i": "tour", "l": 90, "b": bits(range(12))}]})
        self.assertEqual((r.status_code, r.json()), (202, {"status": "ok"}))
        r = await self.signal({"k": "broken", "p": "/guides/postgres", "f": "/start"})
        self.assertEqual(r.json(), {"status": "ok"})
        rows = await self.db[gi.RAW].find({"site": self.sid}).to_list(10)
        self.assertEqual(sorted(r["k"] for r in rows), ["broken", "read"])
        for row in rows:
            self.assertNotIn("v", {k for k in row if k == "v" and isinstance(row[k], str)})  # no visitor hash
            for k in ("ip", "ua", "ref", "cc"):
                self.assertNotIn(k, row)
        # Do Not Track / GPC: dropped (the engine doesn't send them either); so are bots.
        for h in ({"DNT": "1"}, {"Sec-GPC": "1"}, {"User-Agent": "Googlebot/2.1"}):
            r = await self.signal({"k": "read", "p": "/start", "n": 4, "d": 2}, headers=h)
            self.assertEqual(r.json(), {"status": "ignored"}, h)
        r = await self.signal({"k": "read", "p": "/start", "n": 4, "d": 9})
        self.assertEqual(r.json(), {"status": "ignored"})
        r = await self.signal({"k": "click", "p": "/start"})
        self.assertEqual(r.status_code, 422)
        for origin in (None, "https://evil.example"):
            r = await self.signal({"k": "read", "p": "/start", "n": 4, "d": 2}, origin=origin)
            self.assertEqual(r.status_code, 403, origin)
        self.assertEqual(await self.db[gi.RAW].count_documents({"site": self.sid}), 2)
        # The owner's switch: off drops everything.
        await self.call("PATCH", f"/{self.sid}", json={"settings": {"insights": {"enabled": False}}})
        docs_sites.reset()
        r = await self.signal({"k": "read", "p": "/start", "n": 4, "d": 2})
        self.assertEqual(r.json(), {"status": "off"})

    async def test_site_json_sample(self):
        row = await self.row()
        files, _ = docs_snapshot.content_files(row, {"pages": [], "settings": row["settings"]}, url="https://u", ai_api="https://a")
        self.assertEqual(json.loads(files["site.json"])["signals"], {"sample": 1.0})

    async def test_rollup(self):
        yday = now() - timedelta(days=1)
        await self.seed_reads(when=yday)
        await self.db[gi.RAW].insert_many([
            {"site": self.sid, "k": "read", "ts": yday, "day": gi.day_key(yday), "p": "/start", "n": 4, "d": 4, "w": 2,
             "v": [{"i": "tour", "l": 100, "b": [0, 1, 2]}], "c": [[0, 1]]},
            {"site": self.sid, "k": "broken", "ts": yday, "day": gi.day_key(yday), "p": "/gone", "f": "/start"}])
        self.assertEqual(await gs.rollup_due(self.db), 1)
        self.assertEqual(await gs.rollup_due(self.db), 0)
        await self.db[gi.RAW].delete_many({"day": gi.day_key(yday)})  # read from the rollup from now on
        w = await gs.window(self.db, self.sid, gf.window_days(now()))
        page = w["reading"]["/start"]
        self.assertEqual((page["m"], page["hist"]["1"], page["hist"]["4"], page["ids"]["1"]), (102, 45, 30, "configure-the-agent"))
        self.assertEqual((w["videos"]["tour"]["plays"], w["videos"]["tour"]["curve"][:4]), (2, [2, 2, 2, 0]))
        self.assertEqual(w["copies"], [{"p": "/start", "s": 0, "b": 1, "n": 2}])
        self.assertEqual([(b["p"], b["f"], b["n"]) for b in w["broken"]], [("/gone", "/start", 1)])


class Lifecycle(FixCase):
    async def items(self, **q) -> list[dict]:
        return await self.db[gf.FIXES].find({"site": self.sid, **q}).to_list(100)

    async def test_detect_list_and_roles(self):
        await self.seed_reads()
        listing = await self.get(f"/{self.sid}/fixes", "viewer")
        types = {i["type"]: i for i in listing["items"]}
        self.assertIn("drop", types)
        self.assertIn("broken", types)          # /guides/alert-rule is linked from /start and doesn't exist
        drop = types["drop"]
        self.assertEqual((drop["status"], drop["section"], drop["page_id"]), ("open", "configure-the-agent", self.page_id))
        self.assertEqual(drop["title"], "Readers leave at “Configure the agent”")
        self.assertNotIn("curve", drop["evidence"])  # the list carries a few numbers, the drawer the curves
        self.assertFalse(listing["can_edit"])
        self.assertEqual(listing["counts"]["open"], len(listing["items"]))
        self.assertIsNotNone(listing["checked_at"])
        full = await self.get(f"/{self.sid}/fixes/{drop['id']}", "viewer")
        self.assertEqual(len(full["evidence"]["curve"]), 6)
        self.assertEqual(full["history"][0]["status"], "open")
        cnt = await self.get(f"/{self.sid}/fixes/count", "viewer")
        self.assertEqual(cnt["open"], len(listing["items"]))
        # Roles: strangers see nothing, viewers can't change anything.
        await self.get(f"/{self.sid}/fixes", "stranger", 404)
        await self.get(f"/{self.sid}/fixes/count", "stranger", 404)
        await self.call("PATCH", f"/{self.sid}/fixes/{drop['id']}", "viewer", 403, json={"status": "fixed"})
        await self.call("POST", f"/{self.sid}/fixes/{drop['id']}/draft", "viewer", 403)
        await self.call("POST", f"/{self.sid}/fixes/check", "viewer", 403)
        await self.call("PATCH", f"/{self.sid}/fixes/{drop['id']}", "editor", 422, json={"status": "dismissed"})
        got = await self.call("PATCH", f"/{self.sid}/fixes/{drop['id']}", "editor",
                              json={"status": "dismissed", "reason": "wont_fix", "note": "On purpose"})
        self.assertEqual((got["status"], got["reason"], got["note"]), ("dismissed", "wont_fix", "On purpose"))
        listing = await self.get(f"/{self.sid}/fixes?status=dismissed")
        self.assertEqual([i["id"] for i in listing["items"]], [drop["id"]])
        listing = await self.get(f"/{self.sid}/fixes?type=broken")
        self.assertEqual({i["type"] for i in listing["items"]}, {"broken"})
        # Another guide can't reach this guide's items.
        other = await self.create("other")
        await self.get(f"/{other['id']}/fixes/{drop['id']}", expect=404)
        # The Guides home's cards carry the count.
        home = await self.get("/insights-summary")
        self.assertEqual(home["sites"][self.sid]["fixes"]["open"], cnt["open"] - 1)

    async def test_daily_recheck_and_reopen(self):
        old = now() - timedelta(days=5)
        await self.seed_reads(when=old)
        await gf.check(self.db, await self.row())
        [drop] = await self.items(type="drop")
        await self.call("PATCH", f"/{self.sid}/fixes/{drop['_id']}", "editor", json={"status": "fixed"})
        # Same evidence (from before the fix) at the next check: stays fixed.
        await gf.check(self.db, await self.row())
        [drop] = await self.items(type="drop")
        self.assertEqual(drop["status"], "fixed")
        # Readers keep leaving there after the fix (the day after it): it reopens.
        later = now() + timedelta(days=2)
        await self.seed_reads(when=later)
        with mock.patch.object(gi, "now", lambda: later), mock.patch.object(gf, "now", lambda: later):
            stats = await gf.check(self.db, await self.row(), at=later)
        self.assertEqual(stats["reopened"], 1)
        [drop] = await self.items(type="drop")
        self.assertEqual((drop["status"], drop["reopened"]), ("open", 1))
        self.assertEqual(drop["history"][-1]["note"], "Came back after it was fixed")

    async def test_quiet_items_close_and_dismissed_stay(self):
        await gf.reconcile(self.db, self.sid, [
            {**gf._cand("search", "search:sso", path=None, title="t", summary="s", readers=5, evidence={}, last=now()),
             "impact": 3.5, "recency": 1, "level": "medium"},
            {**gf._cand("search", "search:vat", path=None, title="t", summary="s", readers=5, evidence={}, last=now()),
             "impact": 3.5, "recency": 1, "level": "medium"}], at=now())
        sso, vat = sorted(await self.items(), key=lambda i: i["key"])
        await gf.set_status(self.db, self.sid, str(vat["_id"]), "dismissed", self.uid["editor"], reason="not_a_problem")
        t = now() + timedelta(days=1)
        await gf.reconcile(self.db, self.sid, [], at=t)
        self.assertIsNotNone((await self.items(key="search:sso"))[0]["quiet_since"])
        st = await gf.reconcile(self.db, self.sid, [], at=t + timedelta(days=gf.QUIET_DAYS))
        self.assertEqual(st["closed"], 1)
        sso = (await self.items(key="search:sso"))[0]
        self.assertEqual((sso["status"], sso["fixed_by"]), ("fixed", "detector"))
        self.assertEqual((await self.items(key="search:vat"))[0]["status"], "dismissed")
        # A cluster whose wording changed is the same item (aliases).
        await gf.reconcile(self.db, self.sid, [
            {**gf._cand("search", "search:value added tax", aliases=["search:value added tax", "search:vat"], path=None, title="t",
                        summary="s", readers=5, evidence={}, last=now()), "impact": 3.5, "recency": 1, "level": "medium"}],
            at=t + timedelta(days=9))
        self.assertEqual(len(await self.items(type="search")), 2)
        self.assertEqual((await self.items(key="search:vat"))[0]["status"], "dismissed")

    async def test_applied_fix_is_fixed_by_the_next_publish(self):
        await self.seed_reads()
        await gf.check(self.db, await self.row())
        [drop] = await self.items(type="drop")
        got = await self.call("POST", f"/{self.sid}/fixes/{drop['_id']}/applied", "editor", json={"page_id": self.page_id})
        self.assertEqual((got["status"], got["applied"]["page_id"]), ("in_progress", self.page_id))
        await self.call("POST", f"/{self.sid}/fixes/{drop['_id']}/applied", "editor", 404, json={"page_id": str(ObjectId())})
        # A publish that doesn't change the page: still in progress.
        await self.go_live()
        self.assertEqual(await gf.reconcile_applied(self.db, await self.row()), 0)
        # The page is edited (the suggestion accepted) and published: fixed.
        pg = await self.get(f"/{self.sid}/pages/{self.page_id}")
        await self.call("PUT", f"/{self.sid}/pages/{self.page_id}", json={
            "base_rev": pg["rev"], "markdown": QUICKSTART.replace("Edit `acme.yml`", "1. Open `acme.yml`")})
        await self.go_live()
        self.assertEqual(await gf.reconcile_applied(self.db, await self.row()), 1)
        [drop] = await self.items(type="drop")
        self.assertEqual((drop["status"], drop["fixed_by"]), ("fixed", "publish"))

    async def test_clear_with_insights(self):
        await self.seed_reads()
        await gf.check(self.db, await self.row())
        got = await self.call("DELETE", f"/{self.sid}/insights", "admin")
        self.assertGreater(got["cleared"]["fixes"], 0)
        self.assertEqual(await self.db[gf.FIXES].count_documents({"site": self.sid}), 0)


_SAVED = ("anthropic_api_key", "docs_ai_enabled", "docs_ai_model", "docs_editor_ai_enabled", "docs_editor_ai_per_user_day",
          "docs_ai_answers_per_month", "docs_editor_ai_daily_usd", "docs_editor_ai_monthly_usd", "docs_editor_ai_max_concurrent")


class Drafts(FixCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.saved_ai = {k: getattr(settings, k) for k in _SAVED}
        settings.anthropic_api_key = "sk-test-not-a-real-key"
        settings.docs_ai_enabled = True
        settings.docs_ai_model = "claude-haiku-5-5"
        settings.docs_editor_ai_enabled = True
        settings.docs_editor_ai_per_user_day = 50
        settings.docs_ai_answers_per_month = 1000
        settings.docs_editor_ai_daily_usd = 2.0
        settings.docs_editor_ai_monthly_usd = 20.0
        settings.docs_editor_ai_max_concurrent = 6
        await ai_usage.ensure_indexes(self.db)
        ai_usage._reserved.clear()
        docs_editor_ai._inflight = 0
        docs_editor_ai._inflight_by_user.clear()
        docs_editor_ai._inflight_by_site.clear()
        self.fake = FakeClient()
        p = mock.patch.object(docs_agent, "get_client", lambda: self.fake)
        p.start()
        self.addCleanup(p.stop)
        await self.seed_reads()
        await gf.check(self.db, await self.row())

    async def asyncTearDown(self):
        for k, v in self.saved_ai.items():
            setattr(settings, k, v)
        await super().asyncTearDown()

    async def item(self, type_: str) -> dict:
        return await self.db[gf.FIXES].find_one({"site": self.sid, "type": type_})

    async def test_section_draft_spends_the_guide_budget(self):
        drop = await self.item("drop")
        got = await self.call("POST", f"/{self.sid}/fixes/{drop['_id']}/draft", "editor")
        d = got["draft"]
        self.assertEqual((d["kind"], d["section"], d["page_id"]), ("section", "configure-the-agent", self.page_id))
        self.assertTrue(d["before"].startswith("## Configure the agent"))
        self.assertNotIn("## Send data", d["before"])
        self.assertEqual(d["after"], "## Configure the agent\n\n1. Open `acme.yml`.")
        self.assertEqual(d["summary"], "Split the step.")
        params = self.fake.calls[-1]
        self.assertEqual(params["model"], "claude-haiku-5-5")
        turn = params["messages"][0]["content"][0]["text"]
        self.assertIn("<section>", turn)
        self.assertIn("stop in this section", turn)
        # Counted where Ask AI and AI help are: the guide's monthly allowance, the person's day.
        [row] = await self.db[ai_usage.REQUESTS].find({"feature": "docs_editor"}).to_list(5)
        self.assertEqual((row["kind"] if "kind" in row else row.get("meta", {}).get("kind"), row["outcome"]), ("fix", "ok"))
        self.assertNotIn("acme.yml", json.dumps(row, default=str))  # counts only, never the text
        from app.services import docs_site_store

        self.assertEqual((await docs_site_store.ai_answers(self.db, [self.sid]))[self.sid], 1)
        # Kept on the item: the drawer shows it again without spending.
        again = await self.get(f"/{self.sid}/fixes/{drop['_id']}")
        self.assertEqual(again["draft"]["after"], d["after"])

    async def test_out_of_budget(self):
        drop = await self.item("drop")
        settings.docs_ai_answers_per_month = 1
        await self.db[ai_usage.REQUESTS].insert_one({"feature": "docs_ask", "site": self.sid, "ts": now(), "outcome": "answered",
                                                     "request_id": "x" * 32})
        got = await self.call("POST", f"/{self.sid}/fixes/{drop['_id']}/draft", "editor", 429)
        self.assertEqual(got["code"], "guide_budget")
        self.assertIn("AI budget", got["detail"])
        self.assertEqual(self.fake.calls, [])
        settings.docs_ai_answers_per_month = 1000
        settings.docs_editor_ai_per_user_day = 0
        got = await self.call("POST", f"/{self.sid}/fixes/{drop['_id']}/draft", "editor", 429)
        self.assertEqual(got["code"], "user_daily")

    async def test_draft_cut_by_thinking_is_asked_again_then_reported(self):
        # Haiku 5.5 thinks before it answers and the thinking counts against max_tokens.
        from tests._thinking_fake import ThinkingModel

        from app.services import ai_output

        drop = await self.item("drop")
        reply = self.fake.reply
        cap = max(ai_output.MIN_ANSWER_CAP, settings.docs_editor_ai_max_tokens)
        self.fake = ThinkingModel(reply, think=lambda kw: cap if kw["max_tokens"] == cap else 1500)
        got = await self.call("POST", f"/{self.sid}/fixes/{drop['_id']}/draft", "editor")
        self.assertEqual(got["draft"]["after"], "## Configure the agent\n\n1. Open `acme.yml`.")
        self.assertEqual(self.fake.caps(), [cap, ai_output.retry_cap(cap, sync=True)])
        [row] = await self.db[ai_usage.REQUESTS].find({"feature": "docs_editor"}).to_list(5)
        self.assertEqual((row["outcome"], row["calls"], row["usage"]["output"]), ("ok", 2, self.fake.output_tokens()))
        # Cut both times: an error that says so, never an empty draft.
        self.fake = ThinkingModel(reply, think=10 ** 6)
        got = await self.call("POST", f"/{self.sid}/fixes/{drop['_id']}/draft", "editor", 422)
        self.assertEqual(got["code"], "too_long_output")
        self.assertEqual(len(self.fake.calls), 2)

    async def test_refusal_and_switch(self):
        drop = await self.item("drop")
        self.fake.stop = "refusal"
        got = await self.call("POST", f"/{self.sid}/fixes/{drop['_id']}/draft", "editor", 422)
        self.assertEqual(got["code"], "refused")
        settings.docs_editor_ai_enabled = False
        got = await self.call("POST", f"/{self.sid}/fixes/{drop['_id']}/draft", "editor", 503)
        self.assertEqual(got["code"], "disabled")

    async def test_link_fix_needs_no_ai(self):
        broken = await self.item("broken")
        self.assertEqual(broken["key"], "broken:/guides/alert-rule")
        got = await self.call("POST", f"/{self.sid}/fixes/{broken['_id']}/draft", "editor")
        d = got["draft"]
        self.assertEqual((d["kind"], d["section"]), ("link", "configure-the-agent"))
        self.assertIn("](/guides/alert-rule)", d["before"])
        self.assertIn("](/guides/alert-rules)", d["after"])
        self.assertEqual(self.fake.calls, [])

    async def test_question_draft_appends_or_makes_a_page(self):
        await self.db[ai_usage.REQUESTS].insert_many([
            {"feature": docs_agent.FEATURE, "site": self.sid, "ts": now(), "insights": True, "outcome": "no_answer",
             "question": q, "page_path": "/start", "request_id": f"{i:032x}"}
            for i, q in enumerate(["Can I rotate an API key?", "How do I rotate API keys"])])
        await self.db[gf.STATE].delete_many({})
        await gf.check(self.db, await self.row())
        ask = await self.item("ask")
        self.fake.reply = "<summary>Adds an answer.</summary><markdown>## Can I rotate an API key?\n\nYes. [Add the steps]</markdown>"
        got = await self.call("POST", f"/{self.sid}/fixes/{ask['_id']}/draft", "editor")
        d = got["draft"]
        self.assertEqual((d["kind"], d["path"]), ("append", "/start"))
        self.assertTrue(d["before"].startswith("## Next steps"))
        self.assertTrue(d["after"].endswith("Yes. [Add the steps]"))
        # Readers' words travel as data inside <reader_input>.
        turn = self.fake.calls[-1]["messages"][0]["content"][0]["text"]
        self.assertIn("<reader_input>", turn)
        self.assertIn("rotate an API key", turn)


# ── Agents, embeds, confidence ────────────────────────────────────────────────


class AgentsAndEmbedsPure(unittest.TestCase):
    def test_agent_families(self):
        self.assertEqual(gs.agent_family("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0)"), "ChatGPT")
        self.assertEqual(gs.agent_family("Claude-User/1.0 (+Claude-User@anthropic.com)"), "Claude")
        self.assertEqual(gs.agent_family("Mozilla/5.0 (compatible; PerplexityBot/1.0)"), "Perplexity")
        self.assertIsNone(gs.agent_family(DESKTOP))
        self.assertIsNone(gs.agent_family("Googlebot/2.1"))   # a search crawler is not an AI agent
        self.assertEqual(gs.tool_family("curl/8.4"), "Other tool")
        self.assertEqual(gs.tool_family(""), "Other tool")
        self.assertEqual(gs.tool_family(DESKTOP), "Browser or other")
        self.assertEqual(gs.agent_path("/md/guides/start", "markdown"), "/guides/start")
        self.assertEqual(gs.agent_path("/guides/start.md", "markdown"), "/guides/start")
        self.assertEqual(gs.agent_path("/md/index.md", "markdown"), "/")
        self.assertEqual(gs.agent_path("/anything", "llms"), "/llms.txt")
        self.assertEqual(gs.agent_path("/mcp", "mcp"), "/mcp")
        self.assertIsNone(gs.agent_path("bad path", "page"))

    def test_embed_entries(self):
        self.assertEqual(gs.clean_embed({"i": "emb1", "k": "video", "l": 100, "b": bits([0, 1]), "name": "Tour\x00"}),
                         {"i": "emb1", "k": "video", "name": "Tour", "l": 100, "b": [0, 1]})
        self.assertEqual(gs.clean_embed({"i": "emb1", "k": "video", "l": 100, "q": 2})["b"], list(range(20)))
        self.assertEqual(gs.clean_embed({"i": "emb1", "k": "video", "l": 100, "s": 42})["b"], list(range(17)))
        self.assertEqual(gs.clean_embed({"i": "deck", "k": "pdf", "n": 12, "r": 3}), {"i": "deck", "k": "pdf", "n": 12, "r": 3})
        for bad in ({"i": "deck", "k": "pdf", "n": 12, "r": 13}, {"i": "a b", "k": "pdf", "n": 2, "r": 1},
                    {"i": "x", "k": "sheet"}, {"i": "x", "k": "video", "l": 0, "q": 1}, {"i": "x", "k": "video", "l": 9}):
            self.assertIsNone(gs.clean_embed(bad), bad)
        got = gs.clean_read({"p": "/a", "n": 2, "d": 0, "e": [{"i": "deck", "k": "pdf", "n": 5, "r": 2}, {"i": "?", "k": "pdf"}]})
        self.assertEqual(got["e"], [{"i": "deck", "k": "pdf", "n": 5, "r": 2}])
        self.assertEqual(gs.clean_embed_beacon({"k": "embed", "p": "/a/", "e": [{"i": "deck", "k": "pdf", "n": 5, "r": 5}, 7]}),
                         {"p": "/a", "w": 1, "e": [{"i": "deck", "k": "pdf", "n": 5, "r": 5}]})
        self.assertIsNone(gs.clean_embed_beacon({"k": "embed", "p": "/a", "e": [{"i": "deck", "k": "pdf"}]}))

    def test_pdf_drop(self):
        hist = {"1": 4, "2": 3, "3": 14, "4": 2, "5": 2, "6": 5}
        data = {"now": NOW, "pages": {"/board": {"title": "Board pack", "readers": 40}},
                "pdfs": {"deck": {"n": 6, "name": "Q3 Board Deck", "hist": hist, "pages": {"/board": 30}}}}
        [c] = gf.detect_pdfs(data)
        self.assertEqual((c["key"], c["path"], c["readers"]), ("pdf:deck", "/board", 14))
        self.assertEqual(c["title"], "Readers stop at page 3 of “Q3 Board Deck”")
        self.assertEqual(c["confidence"], "medium")      # 30 readers, twice the minimum
        self.assertEqual(c["evidence"]["curve"][0], {"page": 1, "reached_pct": 100, "left_pct": 13})
        data["pdfs"]["deck"]["hist"] = {"1": 3, "3": 6}  # 9 readers: too few
        self.assertEqual(gf.detect_pdfs(data), [])
        self.assertEqual(gf.pending(data)[0], {"type": "pdf", "path": None, "title": "Q3 Board Deck", "have": 9, "need": gf.PDF_MIN})

    def test_agent_items(self):
        pages = {"/ref/cli": {"title": "CLI reference", "readers": 5, "words": 2400, "media": 0, "headings": []},
                 "/tour": {"title": "Product tour", "readers": 5, "words": 60, "media": 6, "headings": [{"id": "a", "depth": 2}]},
                 "/secret": {"title": "Internal", "readers": 0, "words": 300, "media": 0, "hidden": True, "headings": []},
                 "/fine": {"title": "Fine", "readers": 9, "words": 900, "media": 1, "headings": [{"id": "x", "depth": 2}]}}
        agents = [{"p": p, "via": via, "a": a, "n": n} for p, via, a, n in (
            ("/ref/cli", "markdown", "Claude", 30), ("/ref/cli", "page", "ChatGPT", 12), ("/tour", "page", "Perplexity", 11),
            ("/secret", "markdown", "Other tool", 14), ("/fine", "markdown", "Claude", 50), ("/llms.txt", "llms", "Claude", 80),
            ("/mcp", "mcp", "Claude", 40))]
        data = {"now": NOW, "pages": pages, "agents": agents, "total_readers": 300,
                "agent_searches": [{"q": "terraform provider", "n": 3, "last": NOW}, {"q": "terraform", "n": 1, "last": NOW},
                                   {"q": "pricing", "n": 1, "last": NOW}]}
        got = {c["key"]: c for c in gf.detect_agent_unfriendly(data)}
        self.assertEqual(set(got), {"agent_unfriendly:/ref/cli", "agent_unfriendly:/tour", "agent_unfriendly:/secret"})
        self.assertEqual(got["agent_unfriendly:/ref/cli"]["evidence"]["reason"], "no_headings")
        self.assertEqual(got["agent_unfriendly:/ref/cli"]["readers"], 42)
        self.assertEqual(got["agent_unfriendly:/tour"]["evidence"]["reason"], "media")
        self.assertEqual(got["agent_unfriendly:/secret"]["evidence"]["reason"], "hidden")
        [ask] = gf.detect_agent_searches(data)
        self.assertEqual((ask["key"], ask["readers"]), ("agent_unanswered:terraform provider", 4))
        s = gf.agents_summary(data)
        self.assertEqual(s["total"], 237)
        self.assertEqual(s["families"][0], {"name": "Claude", "n": 200})
        self.assertEqual(s["via"], {"markdown": 94, "page": 23, "llms": 80, "mcp": 40})
        self.assertEqual(s["pages"][0]["path"], "/fine")
        self.assertEqual(s["readers"], 300)              # people, counted apart

    def test_confidence_and_pending(self):
        self.assertEqual(gf.confidence(25, 25), "low")
        self.assertEqual(gf.confidence(50, 25), "medium")
        self.assertEqual(gf.confidence(100, 25), "high")
        self.assertEqual(gf.confidence(None, None), "high")
        data = {"now": NOW, "pages": {"/a": {"title": "A"}}, "votes": {"/a": (0, 2)},
                "reading": {"/a": hist_rec(4, {1: 10, 4: 2})}, "videos": {"tour": {"plays": 3, "l": 9, "curve": []}}}
        got = gf.pending(data)
        self.assertEqual({(p["type"], p["have"], p["need"]) for p in got},
                         {("drop", 12, gf.MIN_READS), ("video", 3, gf.VIDEO_MIN_PLAYS), ("not_helpful", 2, gf.HELPFUL_MIN_VOTES)})


class AgentsAndEmbedsApi(FixCase):
    async def test_agent_reads_are_counted_apart(self):
        edge = {"Authorization": f"Bearer {gi.edge_key('s' * 40)}", "X-Docs-Reader-Ip": "203.0.113.7"}
        r = await self.http.post(f"{SIG}/{self.sid}/hit", headers=edge, json={
            "path": "/start", "ua": "Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)"})
        self.assertEqual(r.json(), {"status": "ok"})
        r = await self.http.post(f"{SIG}/{self.sid}/agent", headers=edge, json={"path": "/md/start", "via": "markdown", "ua": "Claude-User/1.0"})
        self.assertEqual(r.json(), {"status": "ok"})
        r = await self.http.post(f"{SIG}/{self.sid}/agent", json={"path": "/llms.txt", "via": "llms"})
        self.assertEqual(r.status_code, 401)
        r = await self.http.post(f"{SIG}/{self.sid}/agent", headers=edge, json={"path": "/x", "via": "sitemap"})
        self.assertEqual(r.status_code, 422)
        rows = await self.db[gi.RAW].find({"site": self.sid}).to_list(10)
        self.assertEqual(sorted((r["k"], r["p"], r["via"], r["a"]) for r in rows),
                         [("agent", "/start", "markdown", "Claude"), ("agent", "/start", "page", "ChatGPT")])
        self.assertFalse(any(r["k"] == "view" for r in rows))   # never a reader
        for row in rows:
            self.assertNotIn("203.0.113.7", json.dumps(row, default=str))
        # The docs MCP server's searches that found nothing (server side, no Origin).
        h = {"Content-Type": "text/plain;charset=UTF-8"}
        r = await self.http.post(f"{SIG}/{self.sid}/event", headers=h, content=json.dumps(
            {"k": "search", "q": "Terraform provider for jane@acme.com", "n": 0, "src": "mcp"}))
        self.assertEqual(r.json(), {"status": "ok"})
        r = await self.http.post(f"{SIG}/{self.sid}/event", headers=h, content=json.dumps({"k": "search", "q": "found", "n": 3, "src": "mcp"}))
        self.assertEqual(r.json(), {"status": "ignored"})
        r = await self.http.post(f"{SIG}/{self.sid}/event", headers=h, content=json.dumps({"k": "search", "q": "no origin", "n": 0}))
        self.assertEqual(r.status_code, 403)   # a reader's search still needs the guide's own Origin
        [s] = await self.db[gi.RAW].find({"site": self.sid, "k": "agent_search"}).to_list(5)
        self.assertEqual(s["q"], "terraform provider for [email]")

    async def test_embed_beacons_roll_up_into_videos_and_pdfs(self):
        r = await self.signal({"k": "read", "p": "/start", "n": 4, "d": 1, "t": 20,
                               "e": [{"i": "deck", "k": "pdf", "n": 6, "r": 3, "name": "Q3 Board Deck"},
                                     {"i": "demo", "k": "video", "l": 40, "q": 1, "name": "Product demo"}]})
        self.assertEqual(r.json(), {"status": "ok"})
        r = await self.signal({"k": "embed", "p": "/start", "e": [{"i": "deck", "k": "pdf", "n": 6, "r": 6}]})
        self.assertEqual(r.json(), {"status": "ok"})
        w = await gs.window(self.db, self.sid, gf.window_days(now()))
        self.assertEqual(w["pdfs"]["deck"]["hist"], {"3": 1, "6": 1})
        self.assertEqual(w["pdfs"]["deck"]["name"], "Q3 Board Deck")
        v = w["videos"]["embed:demo"]
        self.assertEqual((v["plays"], v["name"], v["curve"][:11]), (1, "Product demo", [1] * 10 + [0]))
        listing = await self.get(f"/{self.sid}/fixes")
        self.assertIn("pending", listing)
        self.assertEqual({p["type"] for p in listing["pending"]} >= {"pdf", "video"}, True)
        self.assertIsNotNone(listing["agents"])


if __name__ == "__main__":
    unittest.main()
