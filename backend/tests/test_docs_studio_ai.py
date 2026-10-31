"""Ask AI on Markdrop Guides sites (services/docs_sites.py studio_site, docs_index.aget_index).

A studio site is a ``docs_sites`` row; its docs are the live build's snapshot
(``docs_builds.snapshot_id`` → ``docs_snapshots``). The rows are written here in
the shape services/docs_site_publish.py and services/docs_build.py write them.
The Anthropic client is the fake from test_docs_ai (no network, ever), and
Markdrop's own site keeps answering exactly as before.
"""

from __future__ import annotations

from tests import _email_env as env  # noqa: F401  (pins settings first)

import asyncio
import secrets
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import httpx
from bson import ObjectId

from app import database
from app.main import app
from app.routers.admin import _make_token
from app.services import ai_usage, docs_agent, docs_index, docs_sites
from tests.test_docs_ai import API, DOCS, DocsAIBase, FakeClient, Turn, collect, parse_sse, settings, text_of
from tests.test_docs_sites import legacy_system, write_site

HOST = "acme.guides.markdrop.in"
URL = f"https://{HOST}"

PAGES = [
    {"path": "/", "title": "Acme docs", "description": "Rockets for hobbyists.",
     "markdown": "Welcome to Acme.\n\n## Where to start\n\nRead [Install](/start/install) first.\n"},
    {"path": "/start/install", "title": "Install the launcher", "description": "Set up the Acme launcher.",
     "markdown": ("Install the launcher in a minute.\n\n## Requirements\n\nA flat field and a bucket of sand.\n\n"
                  "## Fuel & oxidiser\n\nUse the green canister.\n\n### Notes\n\nKeep it cool.\n\n"
                  "## Notes\n\nCount to ten.\n\n```bash\n# not a heading\nacme install\n```\n"),
     "frontmatter_extra": {"keywords": ["setup", "pad"]}},
    {"path": "/start/launch", "title": "Launch", "description": "Count down and go.",
     "markdown": ":::warning[Stand back]\nTen metres at least.\n:::\n\nPress the big red button.\n"},
    {"path": "/internal/secret-plans", "title": "Hidden page", "description": "Not in the nav.", "hidden": True,
     "markdown": "Hidden pages are still published.\n"},
]


def now() -> datetime:
    return datetime.now(timezone.utc)


class StudioBase(DocsAIBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.saved_studio = (settings.docs_ai_answers_per_month, settings.docs_sites, docs_sites.STUDIO_TTL_S,
                             docs_sites.ORIGINS_MISS_S)
        settings.docs_ai_answers_per_month = 1000
        settings.docs_sites = ""
        docs_sites.STUDIO_TTL_S = 0.0  # every request reads the row (no waiting in tests)
        docs_sites.ORIGINS_MISS_S = 0.0
        docs_index.reset()

    async def asyncTearDown(self):
        (settings.docs_ai_answers_per_month, settings.docs_sites, docs_sites.STUDIO_TTL_S,
         docs_sites.ORIGINS_MISS_S) = self.saved_studio
        await super().asyncTearDown()

    # ── rows ──

    async def make_site(self, *, slug="acme", name="Acme Docs", ai=None, access=None, pages=None, domains=None,
                        nav=None, live=True) -> str:
        site_id = ObjectId()
        settings_ = {
            "theme": {"preset": "clean"},
            "ai": {"enabled": True, "name": "Ask Acme", "suggestions": ["How do I launch?", "Fuel?"]}
            if ai is None else ai,
            "access": access or {"level": "public"},
            "seo": {"index": True},
            "review": {"required": False},
            "nav": nav if nav is not None else [{"group": "Start", "pages": []}],
        }
        await self.db["docs_sites"].insert_one({
            "_id": site_id, "workspace_id": None, "owner_id": "u1", "name": name, "slug": slug,
            "status": "draft", "source": {"kind": "blank"}, "settings": settings_, "domains": domains or [],
            "live_build_id": None, "last_published_at": None, "created_at": now(), "updated_at": now(),
            "deleted_at": None})
        page_ids = {}
        for p in PAGES if pages is None else pages:
            pid = ObjectId()
            page_ids[p["path"]] = str(pid)
        if nav is None:
            await self.db["docs_sites"].update_one({"_id": site_id}, {"$set": {"settings.nav": [
                {"group": "Start", "pages": [page_ids[p] for p in ("/start/install", "/start/launch") if p in page_ids]}]}})
        self.page_ids = page_ids
        if live:
            await self.publish(str(site_id), pages)
        return str(site_id)

    async def publish(self, site_id: str, pages=None) -> str:
        """What a publish + a finished build do: snapshot, build, live pointer."""
        sid = ObjectId(site_id)
        site = await self.db["docs_sites"].find_one({"_id": sid})
        snap = {
            "site_id": sid,
            "site": {"name": site["name"], "slug": site["slug"], "url": f"https://{site['slug']}.guides.markdrop.in"},
            "pages": [{
                "page_id": self.page_ids.get(p["path"], str(ObjectId())), "path": p["path"], "title": p["title"],
                "description": p.get("description", ""), "icon": None, "hidden": bool(p.get("hidden")),
                "markdown": p["markdown"], "frontmatter_extra": p.get("frontmatter_extra", {}), "rev": 1,
            } for p in (PAGES if pages is None else pages)],
            "settings": site["settings"],
            "created_by": "u1",
            "created_at": now(),
        }
        snap_id = (await self.db["docs_snapshots"].insert_one(snap)).inserted_id
        number = await self.db["docs_builds"].count_documents({"site_id": sid}) + 1
        build_id = (await self.db["docs_builds"].insert_one({
            "site_id": sid, "number": number, "status": "live", "requested_by": "u1", "snapshot_id": snap_id,
            "manifest_hash": "m" * 64, "created_at": now()})).inserted_id
        await self.db["docs_builds"].update_many({"site_id": sid, "status": "live", "_id": {"$ne": build_id}},
                                                 {"$set": {"status": "superseded"}})
        await self.db["docs_sites"].update_one({"_id": sid}, {"$set": {
            "status": "live", "live_build_id": build_id, "last_published_at": now()}})
        return str(build_id)

    async def set_site(self, site_id: str, **fields) -> None:
        await self.db["docs_sites"].update_one({"_id": ObjectId(site_id)}, {"$set": fields})

    # ── calls ──

    def studio_req(self, site, question="How do I install it?", **kw):
        return docs_agent.AskRequest(question=question, history=[], page_path=kw.get("page_path"),
                                     conversation_id=None, user=kw.get("user"), ip=kw.get("ip", "203.0.113.7"),
                                     site=site)

    async def ask(self, site, turns, **kw):
        fake = FakeClient(turns)
        with mock.patch.object(docs_agent, "get_client", return_value=fake):
            events = await collect(docs_agent.ask(self.db, self.studio_req(site, **kw)))
        return events, fake

    def http(self):
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=API)


# ── Resolution ────────────────────────────────────────────────────────────────


class ResolutionTests(StudioBase):
    async def test_a_live_site_resolves_by_its_id(self):
        sid = await self.make_site()
        self.assertEqual(await docs_sites.aresolve(self.db, sid), sid)
        self.assertEqual(await docs_sites.aresolve(self.db, sid.upper()), sid)
        self.assertEqual(await docs_sites.aresolve(self.db, None), "markdrop")
        st = await docs_sites.studio_site(self.db, sid)
        self.assertEqual((st.name, st.url, st.hosts, st.ai_enabled), ("Acme Docs", URL, (HOST,), True))
        cfg = await docs_sites.aconfig(self.db, sid)
        self.assertTrue(cfg.studio)
        self.assertEqual((cfg.name, cfg.url, cfg.host, cfg.product_tools, cfg.link_hosts),
                         ("Acme Docs", URL, HOST, False, ()))
        self.assertEqual(cfg.monthly_answers, 1000)
        self.assertEqual(cfg.status_extra(), {"name": "Ask Acme", "suggestions": ["How do I launch?", "Fuel?"]})
        # A file-based site is never a studio site, and has no answer cap.
        md = docs_sites.config("markdrop")
        self.assertEqual((md.studio, md.monthly_answers, md.alias_hosts, md.status_extra()), (False, None, (), {}))

    async def test_sites_that_are_not_live_are_unknown(self):
        draft = await self.make_site(slug="draft", live=False)
        unpublished = await self.make_site(slug="gone")
        await self.set_site(unpublished, status="unpublished", live_build_id=None)
        deleted = await self.make_site(slug="deleted")
        await self.set_site(deleted, deleted_at=now())
        dangling = await self.make_site(slug="dangling")
        await self.db["docs_builds"].delete_many({"site_id": ObjectId(dangling)})
        for sid in (draft, unpublished, deleted, dangling, str(ObjectId()), "0" * 24, "nope"):
            with self.assertRaises(docs_sites.UnknownSite, msg=sid):
                await docs_sites.aresolve(self.db, sid)
            with self.assertRaises(docs_sites.UnknownSite, msg=sid):
                await docs_index.aget_index(self.db, sid)
        events, fake = await self.ask(deleted, [])
        self.assertEqual(events[0][1]["code"], "unknown_site")
        self.assertEqual(fake.messages.calls, [])

    async def test_a_file_site_of_the_same_id_wins(self):
        sid = await self.make_site()
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        write_site(tmp / "x")
        settings.docs_sites = f"{sid}={tmp / 'x'}"
        docs_index.reset()
        index = await docs_index.aget_index(self.db, sid)
        self.assertEqual(index.site_url, "https://docs.acme.test")
        self.assertFalse(index.cfg.studio)


# ── The index ─────────────────────────────────────────────────────────────────


class IndexTests(StudioBase):
    async def test_index_is_the_live_snapshot_with_the_engines_paths_and_anchors(self):
        sid = await self.make_site()
        index = await docs_index.aget_index(self.db, sid)
        self.assertEqual(index.site_id, sid)
        self.assertEqual(sorted(index.pages), ["/", "/internal/secret-plans", "/start/install", "/start/launch"])
        install = index.pages["/start/install"]
        self.assertEqual((install.title, install.description, install.keywords, install.group),
                         ("Install the launcher", "Set up the Acme launcher.", ["setup", "pad"], "Start"))
        # The engine's heading ids: github-slugger, in order, duplicates numbered, code skipped.
        self.assertEqual([h.id for h in install.headings], ["requirements", "fuel--oxidiser", "notes", "notes-1"])
        self.assertIn("/start/install#fuel--oxidiser", index.sections)
        self.assertEqual(index.url_for("/start/install", "requirements"), f"{URL}/start/install#requirements")
        self.assertEqual(index.url_for("/"), URL)
        # Search over it.
        hits = index.search("sand bucket")
        self.assertEqual(hits[0][0].key, "/start/install#requirements")
        self.assertEqual(index.search("big red button")[0][0].page, "/start/launch")
        # Directives read as plain Markdown.
        self.assertIn("**Warning: Stand back**", index.plain(index.pages["/start/launch"].body))
        # The brief: name, address, description, nav by path, hidden pages under "Other pages".
        self.assertIn("Product: Acme Docs.", index.brief)
        self.assertIn(f"Docs site: {URL}. Documentation for Acme Docs.", index.brief)
        self.assertIn("Start\n- /start/install: Install the launcher: Set up the Acme launcher.\n"
                      "- /start/launch: Launch: Count down and go.", index.brief)
        self.assertIn("Other pages\n- /internal/secret-plans: Hidden page", index.brief)
        self.assertNotIn("Key limits", index.brief)
        # Cached: the same object while the live build is the same.
        self.assertIs(await docs_index.aget_index(self.db, sid), index)
        self.assertIn(sid, docs_index.cached_sites())

    async def test_a_new_live_build_rebuilds_the_index(self):
        sid = await self.make_site()
        first = await docs_index.aget_index(self.db, sid)
        self.assertNotIn("/start/landing", first.pages)
        pages = PAGES + [{"path": "/start/landing", "title": "Landing", "description": "Coming down.",
                          "markdown": "## Parachutes\n\nOpen at 300 metres.\n"}]
        await self.publish(sid, pages)
        second = await docs_index.aget_index(self.db, sid)
        self.assertIsNot(second, first)
        self.assertIn("/start/landing", second.pages)
        self.assertEqual(second.search("parachutes")[0][0].key, "/start/landing#parachutes")
        self.assertIs(await docs_index.aget_index(self.db, sid), second)
        # Restore = the live pointer goes back to the first build: that index again (rebuilt).
        first_build = await self.db["docs_builds"].find_one({"site_id": ObjectId(sid), "number": 1})
        await self.set_site(sid, live_build_id=first_build["_id"])
        third = await docs_index.aget_index(self.db, sid)
        self.assertNotIn("/start/landing", third.pages)
        # Within the row's few-second cache the old pointer is still served.
        docs_sites.STUDIO_TTL_S = 60.0
        await self.publish(sid, pages)
        self.assertIs(await docs_index.aget_index(self.db, sid), third)

    async def test_concurrent_first_requests_build_once(self):
        sid = await self.make_site()
        real = docs_index.Index.load_files
        calls = []

        def counting(self_, *a, **kw):
            calls.append(1)
            return real(self_, *a, **kw)

        with mock.patch.object(docs_index.Index, "load_files", counting):
            got = await asyncio.gather(*(docs_index.aget_index(self.db, sid) for _ in range(5)))
        self.assertEqual(len(calls), 1)
        self.assertTrue(all(g is got[0] for g in got))

    async def test_studio_and_file_sites_share_the_lru(self):
        settings.docs_sites_cache_size = 2
        self.addCleanup(setattr, settings, "docs_sites_cache_size", 8)
        a = await self.make_site(slug="aaa")
        b = await self.make_site(slug="bbb")
        docs_index.get_index("markdrop")
        await docs_index.aget_index(self.db, a)
        await docs_index.aget_index(self.db, b)
        self.assertEqual(docs_index.cached_sites(), [a, b])


# ── The agent ─────────────────────────────────────────────────────────────────


class AgentTests(StudioBase):
    async def test_ask_on_a_studio_site(self):
        sid = await self.make_site()
        r1 = Turn(tools=[("search_docs", {"query": "sand"})])
        r2 = Turn(tools=[("read_page", {"path": "/start/install"})])
        r3 = Turn(text=("You need a flat field [S1]. See [Launch](/start/launch), [fuel](/start/install#fuel--oxidiser), "
                        "[nope](/start/nowhere), [app](https://markdrop.in/new) or [abs](https://acme.guides.markdrop.in/start/launch)."))
        events, fake = await self.ask(sid, [r1, r2, r3], page_path="/start/install")
        call = fake.messages.calls[0]
        system = call["system"][0]["text"]
        self.assertTrue(system.startswith(
            f"You are the assistant on Acme Docs's documentation site, {HOST}. You answer questions about Acme Docs "
            "using its documentation and a few read-only tools. You are not a general-purpose chatbot.\n\n"
            "# Acme Docs at a glance\n<platform_brief>\n"), system[:300])
        self.assertIn("- Scope: Acme Docs and its documentation only.", system)
        self.assertNotIn("markdrop", system.replace(HOST, "").lower())
        self.assertNotIn("get_limits", system)
        self.assertEqual([t["name"] for t in call["tools"]],
                         ["flag_unanswered", "get_changelog", "read_page", "read_section", "search_docs"])
        first_user = fake.messages.snapshots[0]["messages"][-1]["content"][0]["text"]
        self.assertNotIn("Reader:", first_user)
        self.assertIn("/start/install (Install the launcher)", first_user)
        # Tool results carry the built site's URLs.
        result = fake.messages.snapshots[1]["messages"][-1]["content"][0]["content"]
        self.assertIn(f"{URL}/start/install#requirements", result)
        text = text_of(events)
        self.assertIn(f"[Launch]({URL}/start/launch)", text)
        self.assertIn(f"[fuel]({URL}/start/install#fuel--oxidiser)", text)
        self.assertIn(f"[abs]({URL}/start/launch)", text)
        self.assertNotIn("/start/nowhere", text)
        self.assertNotIn("markdrop.in/new", text)
        cites = dict(events)["citations"]["sources"]
        self.assertEqual(cites[0]["url"], f"{URL}/start/install#requirements")
        self.assertEqual((cites[0]["page"], cites[0]["section"]), ("/start/install", "Requirements"))
        done = dict(events)["done"]
        self.assertEqual(done["outcome"], "answered")
        row = await self.db["ai_requests"].find_one({"request_id": done["request_id"]})
        self.assertEqual(row["site"], sid)
        self.assertGreater(await ai_usage.spend_today(self.db, ai_usage.site_scope("docs_ask", sid)), 0)

    async def test_own_domain_is_the_address_and_the_free_one_an_alias(self):
        sid = await self.make_site(domains=[{"host": "docs.acme.test", "status": "active"},
                                            {"host": "pending.acme.test", "status": "pending"}])
        index = await docs_index.aget_index(self.db, sid)
        self.assertEqual(index.site_url, "https://docs.acme.test")
        self.assertEqual(index.cfg.alias_hosts, (HOST,))
        check = docs_agent.make_link_check(index)
        self.assertEqual(check(f"{URL}/start/launch"), "https://docs.acme.test/start/launch")
        self.assertEqual(check("https://docs.acme.test/start/launch"), "https://docs.acme.test/start/launch")
        self.assertIsNone(check(f"{URL}/start/nowhere"))
        self.assertIsNone(check("https://pending.acme.test/start/launch"))
        system = docs_agent.build_system(index)
        self.assertIn("documentation site, docs.acme.test.", system)
        self.assertNotIn("support from", system)

    async def test_ai_off_and_non_public_sites_answer_disabled(self):
        sid = await self.make_site(ai={"enabled": False, "name": "Ask Acme", "suggestions": []})
        events, fake = await self.ask(sid, [])
        self.assertEqual((events[0][0], events[0][1]["reason"]), ("limit", "disabled"))
        self.assertTrue(events[0][1]["open_in"][0]["href"].startswith("https://claude.ai/new?q="))
        self.assertIn(f"{HOST}%2Fllms.txt", events[0][1]["open_in"][0]["href"])
        self.assertEqual(fake.messages.calls, [])
        # Turned on (no rebuild needed), then the site goes members-only.
        await self.set_site(sid, **{"settings.ai.enabled": True})
        events, _ = await self.ask(sid, [Turn(text="ok")])
        self.assertEqual(dict(events)["done"]["outcome"], "answered")
        await self.set_site(sid, **{"settings.access": {"level": "members"}})
        events, fake = await self.ask(sid, [])
        self.assertEqual(events[0][1]["reason"], "disabled")
        self.assertEqual(fake.messages.calls, [])

    async def test_monthly_answer_cap_per_site(self):
        sid = await self.make_site()
        other = await self.make_site(slug="other")
        settings.docs_ai_answers_per_month = 2
        m = ai_usage.Meter("claude-haiku-5-5")
        for outcome in ("answered", "no_answer", "limit", "error"):
            await ai_usage.record(self.db, feature="docs_ask", meter=m, request_id=secrets.token_hex(16),
                                  outcome=outcome, site=sid)
        # Two answers this month (limits and errors don't count): the cap is reached.
        events, fake = await self.ask(sid, [])
        self.assertEqual((events[0][0], events[0][1]["reason"]), ("limit", "budget"))
        self.assertEqual([x["label"] for x in events[0][1]["open_in"]][:2], ["Open in Claude", "Open in ChatGPT"])
        self.assertEqual(fake.messages.calls, [])
        row = await self.db["ai_requests"].find_one({"outcome": "limit", "limit_reason": "site_answers_monthly"})
        self.assertEqual(row["site"], sid)
        # Last month's answers don't count; other sites have their own count.
        await self.db["ai_requests"].update_many({"site": sid}, {"$set": {"ts": datetime(2020, 1, 1, tzinfo=timezone.utc)}})
        events, _ = await self.ask(sid, [Turn(text="ok")])
        self.assertEqual(dict(events)["done"]["outcome"], "answered")
        events, _ = await self.ask(other, [Turn(text="ok")])
        self.assertEqual(dict(events)["done"]["outcome"], "answered")
        # Markdrop has no answer cap.
        settings.docs_ai_answers_per_month = 0
        events, fake = await self.ask(None, [Turn(text="ok")])
        self.assertEqual(dict(events)["done"]["outcome"], "answered")
        events, _ = await self.ask(sid, [])
        self.assertEqual(events[0][1]["reason"], "budget")
        self.assertEqual(ai_usage._reserved, {})
        self.assertEqual(docs_agent._inflight_by_site, {})

    async def test_the_global_budget_binds_studio_sites(self):
        sid = await self.make_site()
        settings.docs_ai_daily_usd = 0.0
        events, fake = await self.ask(sid, [])
        self.assertEqual(events[0][1]["reason"], "budget")
        row = await self.db["ai_requests"].find_one({"outcome": "limit"})
        self.assertEqual((row["limit_reason"], row["site"]), ("budget_daily", sid))

    async def test_markdrop_is_unchanged(self):
        await self.make_site()
        events, fake = await self.ask(None, [Turn(text="ok")])
        self.assertEqual(fake.messages.calls[0]["system"][0]["text"], legacy_system(docs_index.get_index()))
        self.assertIn("get_limits", [t["name"] for t in fake.messages.calls[0]["tools"]])


# ── HTTP and CORS ─────────────────────────────────────────────────────────────


class EndpointTests(StudioBase):
    async def test_status(self):
        sid = await self.make_site()
        async with self.http() as c:
            self.assertEqual((await c.get(f"/api/v1/docs/ai/status?site={sid}")).json(),
                             {"available": True, "name": "Ask Acme", "suggestions": ["How do I launch?", "Fuel?"]})
            self.assertEqual((await c.get("/api/v1/docs/ai/status")).json(), {"available": True})
            await self.set_site(sid, **{"settings.ai": {"enabled": False}})
            self.assertEqual((await c.get("/api/v1/docs/ai/status", headers={"X-Docs-Site": sid})).json(),
                             {"available": False, "name": "Ask AI", "suggestions": [], "reason": "disabled"})
            settings.anthropic_api_key = ""
            await self.set_site(sid, **{"settings.ai": {"enabled": True}})
            self.assertEqual((await c.get(f"/api/v1/docs/ai/status?site={sid}")).json(),
                             {"available": False, "name": "Ask AI", "suggestions": [], "reason": "not_configured"})
            await self.set_site(sid, status="unpublished", live_build_id=None)
            r = await c.get(f"/api/v1/docs/ai/status?site={sid}")
            self.assertEqual((r.status_code, r.json()), (404, {"detail": "Unknown docs site"}))

    async def test_ask_and_feedback_over_http(self):
        sid = await self.make_site()
        fake = FakeClient([Turn(tools=[("search_docs", {"query": "launch"})]), Turn(text="Press it [S1].")])
        with mock.patch.object(docs_agent, "get_client", return_value=fake):
            async with self.http() as c:
                r = await c.post("/api/v1/docs/ask", json={"question": "How do I launch?", "site": sid},
                                 headers={"Origin": URL})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers.get("access-control-allow-origin"), URL)
        events = parse_sse(r.text)
        self.assertEqual(events[-1][0], "done")
        self.assertTrue(dict(events)["citations"]["sources"][0]["url"].startswith(f"{URL}/start/launch"))
        rid = events[-1][1]["request_id"]
        async with self.http() as c:
            r1 = await c.post("/api/v1/docs/ask/feedback", json={"request_id": rid, "helpful": True, "site": sid})
            r2 = await c.post("/api/v1/docs/ask/feedback", json={"request_id": rid, "helpful": True})
            r3 = await c.post("/api/v1/docs/feedback", json={"path": "/start/launch", "helpful": True},
                              headers={"X-Docs-Site": sid})
        self.assertEqual((r1.json(), r2.json(), r3.json()),
                         ({"status": "received"}, {"status": "unknown"}, {"status": "received"}))
        fb = await self.db["docs_feedback"].find_one({})
        self.assertEqual((fb["site"], fb["known_page"]), (sid, True))

    async def test_unknown_studio_sites_are_404(self):
        deleted = await self.make_site()
        await self.set_site(deleted, deleted_at=now())
        async with self.http() as c:
            for site in (deleted, str(ObjectId())):
                for method, path, body in (
                        ("POST", "/api/v1/docs/ask", {"question": "hi", "site": site}),
                        ("POST", "/api/v1/docs/ask/feedback", {"request_id": "0" * 32, "helpful": True, "site": site}),
                        ("POST", "/api/v1/docs/feedback", {"path": "/x", "helpful": True, "site": site}),
                        ("GET", f"/api/v1/docs/ai/status?site={site}", None)):
                    r = await c.request(method, path, json=body)
                    self.assertEqual((r.status_code, r.json()), (404, {"detail": "Unknown docs site"}), path)


class CORSTests(StudioBase):
    async def preflight(self, c, origin, path="/api/v1/docs/ask"):
        return await c.options(path, headers={"Origin": origin, "Access-Control-Request-Method": "POST",
                                              "Access-Control-Request-Headers": "content-type, x-docs-site"})

    async def test_live_studio_sites_may_call_the_docs_endpoints(self):
        sid = await self.make_site(domains=[{"host": "docs.acme.test", "status": "active"},
                                            {"host": "pending.acme.test", "status": "pending"}])
        await self.make_site(slug="drafty", live=False)
        await self.make_site(slug="quiet", ai={"enabled": False})  # feedback and status still work there
        async with self.http() as c:
            for origin, ok in ((URL, True), ("https://docs.acme.test", True), ("https://quiet.guides.markdrop.in", True),
                               (DOCS, True), ("https://pending.acme.test", False),
                               ("https://drafty.guides.markdrop.in", False), (f"http://{HOST}", False),
                               ("https://acme.guides.markdrop.in.evil.example", False), ("https://evil.example", False)):
                r = await self.preflight(c, origin)
                self.assertEqual(r.headers.get("access-control-allow-origin") == origin, ok, origin)
                if ok:
                    self.assertNotIn("access-control-allow-credentials", r.headers)
            r = await c.get(f"/api/v1/docs/ai/status?site={sid}", headers={"Origin": URL})
            self.assertEqual(r.headers.get("access-control-allow-origin"), URL)
            # Try it (the public API) is not opened to studio sites.
            r = await self.preflight(c, URL, "/api/v1/documents")
            self.assertNotEqual(r.headers.get("access-control-allow-origin"), URL)
            # Unpublished: the origin goes with it (after the set is re-read).
            await self.set_site(sid, status="unpublished", live_build_id=None)
            docs_sites.reset()
            r = await self.preflight(c, URL)
            self.assertIsNone(r.headers.get("access-control-allow-origin"))

    async def test_the_origin_set_is_cached(self):
        await self.make_site()
        docs_sites.ORIGINS_MISS_S = 60.0
        self.assertTrue(await docs_sites.studio_origin_allowed(URL))
        await self.make_site(slug="later")
        # A miss within the window doesn't re-read; after it, it does.
        with mock.patch.object(docs_sites, "_load_studio_origins", wraps=docs_sites._load_studio_origins) as load:
            self.assertFalse(await docs_sites.studio_origin_allowed("https://later.guides.markdrop.in"))
            self.assertTrue(await docs_sites.studio_origin_allowed(URL + "/"))
            self.assertEqual(load.call_count, 0)
            docs_sites.ORIGINS_MISS_S = 0.0
            self.assertTrue(await docs_sites.studio_origin_allowed("https://later.guides.markdrop.in"))
            self.assertEqual(load.call_count, 1)

    async def test_no_database_means_no(self):
        saved = database._client
        database._client = None
        try:
            self.assertFalse(await docs_sites.studio_origin_allowed(URL))
        finally:
            database._client = saved


class AdminTests(StudioBase):
    async def test_the_admin_breakdown_names_studio_sites(self):
        sid = await self.make_site()
        await self.ask(sid, [Turn(text="ok")])
        await self.ask(None, [Turn(text="ok")])
        async with self.http() as c:
            h = {"Authorization": f"Bearer {_make_token()[0]}"}
            ov = (await c.get("/api/v1/admin/ai/overview", headers=h)).json()
            one = (await c.get(f"/api/v1/admin/ai/overview?site={sid}", headers=h)).json()
        by = {s["site"]: s for s in ov["by_site"]}
        self.assertEqual((by[sid]["name"], by[sid]["url"], by[sid]["studio"], by[sid]["registered"]),
                         ("Acme Docs", URL, True, False))
        self.assertEqual((by[sid]["answered"], by[sid]["monthly_answers_cap"]), (1, 1000))
        self.assertEqual((by["markdrop"]["studio"], by["markdrop"]["monthly_answers_cap"]), (False, None))
        self.assertEqual(one["kpis"]["questions"], 1)
