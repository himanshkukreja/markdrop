"""Auto covers (services/page_covers.py): the pick (AI and the keyword fallback), the limits and
ledger rows, the workspace setting, removal being remembered, templates and duplicates, the
waiting state of an untitled page, the backfill (dry run, skips, batches, a short budget) and the
MCP tools.

The Anthropic client is the fake of tests/test_pages_ai.py (``docs_agent.get_client`` patched):
nothing reaches the network and backend/.env is never read (tests/_email_env pins the settings).
"""

from __future__ import annotations

import json
from datetime import timedelta

from tests.test_pages_ai import PagesAIWorld, prompt_of, usage  # noqa: F401  (pins settings first)

from bson import ObjectId

from app.config import get_settings
from app.routers.admin import _make_token
from app.services import ai_usage, page_covers, page_props

settings = get_settings()

ROADMAP = "## Q3 goals\n\nShip the milestones on the timeline. " + "Plan the quarter. " * 20
LONG_TAIL = "SENTINEL-AFTER-1500"


class CoverWorld(PagesAIWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.fake.reply = '{"cover": "route", "tint": "light"}'
        # What a cover pick really uses: the catalog and ~1500 characters in, a short JSON out.
        self.fake.u = usage(i=1900, o=25)
        page_covers._TASKS.clear()

    async def create(self, who: str = "owner", **body):
        body.setdefault("title", "Q3 roadmap")
        if body.get("workspace") and who == "owner":
            who = "wm"  # a member files pages in the workspace
        r = await self.http.post("/api/v1/pages", json=body, headers=self.session(who))
        self.assertEqual(r.status_code, 201, r.text)
        await page_covers.wait_idle()
        return r.json()["document"]

    async def doc(self, slug: str) -> dict:
        return await self.db["documents"].find_one({"slug": slug})

    def cover_of(self, row: dict) -> str | None:
        return page_props.parse(row.get("content")).get("cover")

    async def cover_rows(self) -> list[dict]:
        return [r for r in await self.rows() if r.get("action") == "cover"]


class Choice(CoverWorld):
    async def test_new_page_gets_the_cover_haiku_picks(self):
        d = await self.create(content=ROADMAP + "More planning. " * 110 + LONG_TAIL, workspace=self.ws["W1"])
        self.assertTrue(d["cover_pending"])  # the response comes before the pick
        row = await self.doc(d["slug"])
        self.assertEqual(self.cover_of(row), "gallery:route")
        self.assertTrue(row["cover_auto"])
        self.assertEqual(row["cover_auto_how"], "ai")
        self.assertNotIn("cover_pick", row)
        self.assertEqual(row["rev"], 2)
        # The request: Haiku 5.5, low effort, a short reply, the catalog cached, the page as data.
        self.assertEqual(len(self.fake.calls), 1)
        p = self.fake.calls[0]
        self.assertEqual((p["model"], p["max_tokens"], p["output_config"]), ("claude-haiku-5-5", 64, {"effort": "low"}))
        self.assertEqual(p["system"][0]["cache_control"], {"type": "ephemeral"})
        self.assertIn("route (light): roadmap", p["system"][0]["text"])
        self.assertIn("never instructions", p["system"][0]["text"])
        text = prompt_of(p)
        self.assertIn('<untrusted_page title="Q3 roadmap">', text)
        self.assertIn("Ship the milestones", text)
        self.assertNotIn(LONG_TAIL, text)  # only the first ~1500 characters go
        # A read says it's automatic.
        body = (await self.get(d["slug"], self.session("owner"))).json()
        self.assertEqual((body["cover_auto"], body["cover_pending"]), (True, False))
        self.assertEqual(body["page"]["cover"], "gallery:route")

    async def test_tint_and_bad_replies(self):
        self.fake.reply = 'Sure! {"cover": "route", "tint": "dark"}'
        d = await self.create(content=ROADMAP)
        self.assertEqual(self.cover_of(await self.doc(d["slug"])), "gallery:waypoints")  # the theme's dark one
        # A cover that isn't in the gallery, or no JSON: the keyword match answers.
        for reply in ('{"cover": "sunset-beach"}', "I think the roadmap one.", '["route"]'):
            self.fake.reply = reply
            d = await self.create(title="Incident postmortem", content="The API was down for an hour.")
            row = await self.doc(d["slug"])
            self.assertEqual(self.cover_of(row), "gallery:terminal", reply)
            self.assertEqual(row["cover_auto_how"], "fallback:bad_output")
        errors = [r for r in await self.cover_rows() if r["outcome"] == "error"]
        self.assertEqual([r["error_code"] for r in errors], ["bad_output"] * 3)

    async def test_upstream_error_falls_back(self):
        import anthropic
        import httpx

        self.fake.raise_exc = anthropic.APIConnectionError(request=httpx.Request("POST", "https://x"))
        d = await self.create(title="Hiring plan", content="Recruiting for the team.")
        row = await self.doc(d["slug"])
        self.assertEqual(self.cover_of(row), "gallery:gather")
        self.assertEqual(row["cover_auto_how"], "fallback:upstream")

    def test_fallback_is_keywords_then_a_hash(self):
        fb = page_covers.fallback
        self.assertEqual(fb("Q3 roadmap", ""), "route")
        self.assertEqual(fb("Brand style guide", "Figma mockups and colors"), "swatches")
        self.assertEqual(fb("Daily standup", "Agenda: blockers"), "circles")
        self.assertEqual(fb("Security audit", "SOC 2 access review"), "lattice")
        self.assertEqual(fb("On-call runbook", "When the pager fires"), "pulse")
        self.assertEqual(fb("Welcome to the team", "Your first day: getting started"), "doorway")
        # No match: a light cover, the same one every time for the same title.
        a, b = fb("Zebra quokka", "lorem ipsum"), fb("Zebra quokka", "dolor")
        self.assertEqual(a, b)
        self.assertEqual(page_covers.BY_ID[a]["tint"], "light")
        self.assertIn(a, page_props.GALLERY)
        # Tints swap within a theme, and only within one.
        self.assertEqual(page_covers.with_tint("facets", "dark"), "prism")
        self.assertEqual(page_covers.with_tint("prism", "light"), "facets")
        self.assertEqual(page_covers.with_tint("tide", "dark"), "moonlit")
        self.assertEqual(page_covers.with_tint("doorway", "dark"), "doorway")  # no dark onboarding cover
        self.assertEqual(page_covers.parse_reply('{"cover": "gallery:sunset"}'), "dawn")  # an old alias

    def test_catalog(self):
        self.assertEqual(len(page_covers.CATALOG), 44)
        self.assertEqual(page_covers.IDS, page_props.GALLERY)
        for c in page_covers.CATALOG:
            self.assertIn(c["tint"], ("light", "dark"))
            self.assertGreaterEqual(len(c["tags"]), 4, c["id"])
        # The frontend's manifest (frontend/scripts/page-covers/generate.mjs writes both) says the same.
        from pathlib import Path

        manifest = Path(__file__).resolve().parents[2] / "frontend/public/page-covers/manifest.json"
        if manifest.exists():
            m = json.loads(manifest.read_text())["covers"]
            self.assertEqual([(c["id"], c["tint"], c["tags"]) for c in m],
                             [(c["id"], c["tint"], c["tags"]) for c in page_covers.CATALOG])
            for c in m:
                f = manifest.parent / f"{c['id']}.webp"
                self.assertLessEqual(f.stat().st_size, 60 * 1024, c["id"])


class Fallback(CoverWorld):
    async def assert_fallback(self, why: str, **create):
        d = await self.create(title="Q3 roadmap", content=ROADMAP, **create)
        row = await self.doc(d["slug"])
        self.assertEqual(self.cover_of(row), "gallery:route")
        self.assertEqual(row["cover_auto_how"], f"fallback:{why}")
        return row

    async def test_ai_off_everywhere_it_can_be(self):
        settings.pages_ai_enabled = False
        await self.assert_fallback("off")
        settings.pages_ai_enabled = True
        settings.anthropic_api_key = ""
        await self.assert_fallback("not_configured")
        settings.anthropic_api_key = "sk-test-not-a-real-key"
        await self.db[ai_usage.SETTINGS].update_one({"_id": ai_usage.BUDGETS_ID},
                                                    {"$set": {"enabled": {"pages_ai": False}}}, upsert=True)
        ai_usage.invalidate_settings()
        await self.assert_fallback("off")
        await self.db[ai_usage.SETTINGS].delete_one({"_id": ai_usage.BUDGETS_ID})
        ai_usage.invalidate_settings()
        await self.set_ws_ai("W1", False)
        await self.assert_fallback("workspace_off", workspace=self.ws["W1"])
        self.assertEqual(self.fake.calls, [])
        self.assertEqual(await self.cover_rows(), [])  # nothing reached the ledger either

    async def test_over_budget_or_blocked(self):
        settings.pages_ai_daily_usd = 0.0
        await self.assert_fallback("budget")
        settings.pages_ai_daily_usd = 5.0
        settings.ai_daily_usd = 0.001   # all features together
        await self.assert_fallback("budget")
        settings.ai_daily_usd = None
        await self.db[ai_usage.SETTINGS].insert_one({"_id": f"user:{self.uid['owner']}", "blocked": True})
        ai_usage.invalidate_settings()
        await self.assert_fallback("blocked")
        self.assertEqual(self.fake.calls, [])

    async def test_anonymous_creator(self):
        cid, how = await page_covers.choose(self.db, title="Q3 roadmap", markdown=ROADMAP, user_id=None,
                                            workspace_id=None)
        self.assertEqual((cid, how), ("route", "fallback:anonymous"))
        self.assertEqual(self.fake.calls, [])


class Ledger(CoverWorld):
    async def test_caps_and_ledger_rows(self):
        await self.create(content=ROADMAP)
        rows = await self.cover_rows()
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual((r["feature"], r["outcome"], r["via"], r["user_id"], r["cover"]),
                         ("pages_ai", "ok", "web", self.uid["owner"], "route"))
        self.assertEqual((r["usage"]["input"], r["usage"]["output"]), (1900, 25))
        # 1,900 in and 25 out at Haiku 5.5 prices: $0.0002025 a page.
        self.assertAlmostEqual(r["cost_usd"], 0.0002025, places=9)
        self.assertNotIn("Ship the milestones", json.dumps(r, default=str))  # sizes only, never text
        self.assertAlmostEqual(await ai_usage.spend_today(self.db, "pages_ai"), 0.0002025, places=9)
        self.assertAlmostEqual(await ai_usage.spend_today(self.db, ai_usage.ALL), 0.0002025, places=9)
        # Nothing stays held.
        self.assertEqual(ai_usage._reserved, {})
        # Its own row never counts against the person in the moment (a peek), but the ledger does:
        # with the burst limit reached, the next page falls back.
        settings.ai_burst_per_minute = 1
        d = await self.create(content=ROADMAP)
        self.assertEqual((await self.doc(d["slug"]))["cover_auto_how"], "fallback:burst")


class Setting(CoverWorld):
    async def test_workspace_auto_covers_off(self):
        r = await self.http.get(f"/api/v1/workspaces/{self.ws['W1']}", headers=self.session("wa"))
        self.assertTrue(r.json()["settings"]["auto_covers"])
        r = await self.http.put(f"/api/v1/workspaces/{self.ws['W1']}", json={"settings": {"auto_covers": False}},
                                headers=self.session("wm"))
        self.assertEqual(r.status_code, 403)
        r = await self.http.put(f"/api/v1/workspaces/{self.ws['W1']}", json={"settings": {"auto_covers": False}},
                                headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["settings"]["auto_covers"])
        self.assertTrue(r.json()["settings"]["ai_enabled"])   # nothing else changed
        d = await self.create(content=ROADMAP, workspace=self.ws["W1"])
        row = await self.doc(d["slug"])
        self.assertFalse(d["cover_pending"])
        self.assertIsNone(self.cover_of(row))
        self.assertNotIn("cover_pick", row)
        self.assertEqual(self.fake.calls, [])
        # Personal pages and other workspaces are unaffected.
        d = await self.create(content=ROADMAP)
        self.assertEqual(self.cover_of(await self.doc(d["slug"])), "gallery:route")
        # AI off but auto covers on: a cover still comes, by keywords.
        await self.http.put(f"/api/v1/workspaces/{self.ws['W1']}", json={"settings": {"auto_covers": True}},
                            headers=self.session("wa"))
        await self.set_ws_ai("W1", False)
        d = await self.create(content=ROADMAP, workspace=self.ws["W1"])
        self.assertEqual((await self.doc(d["slug"]))["cover_auto_how"], "fallback:workspace_off")

    async def test_opt_out_and_pages_that_have_a_cover(self):
        d = await self.create(content=ROADMAP, auto_cover=False)
        row = await self.doc(d["slug"])
        self.assertIsNone(self.cover_of(row))
        self.assertTrue(row["cover_auto_off"])
        d = await self.create(content="---\ncover: gallery:sage\n---\n" + ROADMAP)
        self.assertEqual(self.cover_of(await self.doc(d["slug"])), "gallery:sage")
        self.assertEqual(self.fake.calls, [])


class Removal(CoverWorld):
    async def test_a_removed_cover_is_never_added_again(self):
        d = await self.create(content=ROADMAP)
        row = await self.doc(d["slug"])
        self.assertTrue(row["cover_auto"])
        # The owner removes it in the editor (a save without the cover line).
        no_cover = page_props.apply(row["content"], {"cover": None})
        r = await self.http.put(f"/api/v1/documents/{d['slug']}", headers=self.session("owner"),
                                json={"title": row["title"], "content": no_cover, "base_rev": row["rev"]})
        self.assertEqual(r.status_code, 200, r.text)
        row = await self.doc(d["slug"])
        self.assertIsNotNone(row.get("cover_removed_at"))
        self.assertNotIn("cover_auto", row)
        # Nothing brings it back: a pick, the background loop, the backfill.
        self.assertIsNone(await page_covers.pick_now(self.db, row, None))
        self.assertIsNone(await page_covers.apply(self.db, row["_id"], "route", how="ai"))
        scan = await page_covers.backfill_scan(self.db)
        self.assertEqual(scan["skipped"]["removed"], 1)
        while ((await page_covers.backfill_tick(self.db, pause=0)) or {}).get("status") == "running":
            pass
        self.assertIsNone(self.cover_of(await self.doc(d["slug"])))

    async def test_changing_it_makes_it_yours(self):
        d = await self.create(content=ROADMAP)
        row = await self.doc(d["slug"])
        mine = page_props.apply(row["content"], {"cover": "gallery:sage"})
        r = await self.http.put(f"/api/v1/documents/{d['slug']}", headers=self.session("owner"),
                                json={"title": row["title"], "content": mine, "base_rev": row["rev"]})
        self.assertEqual(r.status_code, 200, r.text)
        row = await self.doc(d["slug"])
        self.assertNotIn("cover_auto", row)
        self.assertIsNone(row.get("cover_removed_at"))

    async def test_a_stale_editor_cant_remove_it_by_accident(self):
        # The editor opened the page before the cover landed: its save is refused (409), not taken
        # as a removal; its next save carries the cover (usePageEditSession merges it).
        r = await self.http.post("/api/v1/pages", json={"title": "Q3 roadmap", "content": ROADMAP},
                                 headers=self.session("owner"))
        slug = r.json()["document"]["slug"]
        rev0 = r.json()["document"]["rev"]
        await page_covers.wait_idle()
        r = await self.http.put(f"/api/v1/documents/{slug}", headers=self.session("owner"),
                                json={"title": "Q3 roadmap", "content": ROADMAP + "\nmore", "base_rev": rev0})
        self.assertEqual(r.status_code, 409)
        row = await self.doc(slug)
        self.assertIsNone(row.get("cover_removed_at"))
        self.assertEqual(self.cover_of(row), "gallery:route")

    async def test_it_lands_while_the_editor_holds_the_lock(self):
        r = await self.http.post("/api/v1/pages", json={"title": "Q3 roadmap", "content": ROADMAP},
                                 headers=self.session("owner"))
        slug = r.json()["document"]["slug"]
        # A pick in flight while someone has the page open (the lock).
        page_covers._TASKS.clear()
        await page_covers.wait_idle()
        r = await self.http.post(f"/api/v1/documents/{slug}/lock", headers=self.session("owner"))
        self.assertIn(r.status_code, (200, 201), r.text)
        row = await self.doc(slug)
        after = await page_covers.apply(self.db, row["_id"], "horizon", how="ai", replace=True)
        self.assertIsNotNone(after)
        self.assertEqual(self.cover_of(after), "gallery:horizon")


class Waiting(CoverWorld):
    async def test_an_untitled_page_waits_until_it_says_what_its_about(self):
        d = await self.create(title="Untitled")
        row = await self.doc(d["slug"])
        self.assertEqual(row["cover_pick"], "waiting")
        self.assertFalse(d["cover_pending"])
        self.assertEqual(self.fake.calls, [])
        # A title alone (maybe half typed) isn't enough while the body is empty…
        r = await self.http.put(f"/api/v1/documents/{d['slug']}", headers=self.session("owner"),
                                json={"title": "Q3 ro", "content": "\n", "base_rev": row["rev"]})
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["cover_pending"])
        # …a title and a start on the body is.
        r = await self.http.put(f"/api/v1/documents/{d['slug']}", headers=self.session("owner"),
                                json={"title": "Q3 roadmap", "content": "Milestones\n", "base_rev": r.json()["rev"]})
        self.assertTrue(r.json()["cover_pending"])
        await page_covers.wait_idle()
        row = await self.doc(d["slug"])
        self.assertEqual(self.cover_of(row), "gallery:route")
        self.assertNotIn("cover_pick", row)
        st = (await self.http.get(f"/api/v1/pages/{d['slug']}/cover", headers=self.session("owner"))).json()
        self.assertEqual((st["cover"], st["cover_auto"], st["cover_pending"], st["rev"]),
                         ("gallery:route", True, False, row["rev"]))

    async def test_a_titled_page_left_alone_gets_one_from_the_background_loop(self):
        d = await self.create(title="Untitled")
        await self.db["documents"].update_one({"slug": d["slug"]}, {"$set": {
            "title": "Hiring plan", "updated_at": page_covers.now_utc() - timedelta(minutes=5)}})
        self.assertEqual(await page_covers.finish_stale(self.db), 1)
        self.assertEqual(self.cover_of(await self.doc(d["slug"])), "gallery:route")  # the fake's pick
        # A pick a stopped process left pending is finished too.
        d = await self.create(content=ROADMAP, auto_cover=False)
        await self.db["documents"].update_one({"slug": d["slug"]}, {
            "$set": {"cover_pick": "pending", "cover_pick_at": page_covers.now_utc() - timedelta(minutes=2),
                     "cover_pick_by": self.uid["owner"]}, "$unset": {"cover_auto_off": ""}})
        self.assertEqual(await page_covers.finish_stale(self.db), 1)
        self.assertEqual(self.cover_of(await self.doc(d["slug"])), "gallery:route")


class TemplatesAndCopies(CoverWorld):
    async def test_templates(self):
        # A built-in template without a cover: the page gets one.
        d = await self.create(title="Sprint sync", template="meeting-notes")
        self.assertIsNotNone(self.cover_of(await self.doc(d["slug"])))
        # A page saved as a template: the template itself never gets one; pages made from it keep
        # its cover (nothing is picked).
        self.fake.calls.clear()
        src = await self.create(content="---\ncover: gallery:sage\n---\n# Weekly\n")
        r = await self.http.post(f"/api/v1/documents/{src['slug']}/save-as-template", json={"name": "Weekly"},
                                 headers=self.session("owner"))
        self.assertEqual(r.status_code, 201, r.text)
        tid = r.json()["id"]
        tpl = await self.db["documents"].find_one({"_id": ObjectId(tid)})
        self.assertEqual(page_covers.skip_reason(tpl), "template")
        d = await self.create(title="From template", template=tid)
        self.assertEqual(self.cover_of(await self.doc(d["slug"])), "gallery:sage")
        self.assertEqual(self.fake.calls, [])
        # An empty template: the new page gets a cover (the template still has none).
        empty = await self.create(content="# Notes\n", auto_cover=False)
        r = await self.http.post(f"/api/v1/documents/{empty['slug']}/save-as-template", json={"name": "Empty"},
                                 headers=self.session("owner"))
        tid = r.json()["id"]
        d = await self.create(title="Q3 roadmap", template=tid)
        self.assertEqual(self.cover_of(await self.doc(d["slug"])), "gallery:route")
        self.assertIsNone(self.cover_of(await self.db["documents"].find_one({"_id": ObjectId(tid)})))

    async def test_duplicates_keep_the_source(self):
        d = await self.create(content=ROADMAP)
        tok = await self.mcp_token("owner")
        self.fake.calls.clear()
        code, res = await self.mcp_call(tok, "duplicate_page", {"document": d["slug"]})
        self.assertFalse(res.get("isError"), res)
        copy = await self.doc(res["structuredContent"]["slug"])
        self.assertEqual(self.cover_of(copy), "gallery:route")
        self.assertTrue(copy["cover_auto"])
        # A source whose cover was removed: the copy has none and never gets one.
        src = await self.doc(d["slug"])
        await self.http.put(f"/api/v1/documents/{d['slug']}", headers=self.session("owner"),
                            json={"title": src["title"], "content": ROADMAP, "base_rev": src["rev"]})
        code, res = await self.mcp_call(tok, "duplicate_page", {"document": d["slug"]})
        copy = await self.doc(res["structuredContent"]["slug"])
        self.assertIsNone(self.cover_of(copy))
        self.assertIsNotNone(copy.get("cover_removed_at"))
        self.assertEqual(self.fake.calls, [])
        # The app's own duplicate (POST /pages with the content and auto_cover false) adds nothing.
        d2 = await self.create(content=ROADMAP, auto_cover=False)
        self.assertIsNone(self.cover_of(await self.doc(d2["slug"])))


class Backfill(CoverWorld):
    async def make_pages(self):
        old = page_covers.now_utc() - timedelta(days=30)   # made before the job started
        p = {}
        p["plain"] = await self.mkdoc("W", editor="blocks", title="Security audit", content="# Audit\n\nSOC 2",
                                      created_at=old)
        p["plain2"] = await self.mkdoc("UL", editor="blocks", title="Welcome", content="Getting started", created_at=old)
        p["plain3"] = await self.mkdoc("W", editor="blocks", title="Q3 roadmap", content="Milestones", created_at=old)
        p["empty"] = await self.mkdoc("W", editor="blocks", title="Untitled", content="\n", created_at=old)
        p["has"] = await self.mkdoc("W", editor="blocks", content="---\ncover: gallery:sage\n---\n# Has", created_at=old)
        p["enc"] = await self.mkdoc("W", editor="blocks", encrypted=True, content="ciphertext", created_at=old)
        p["tpl"] = await self.mkdoc("W", editor="blocks", template=True, content="# T", created_at=old)
        p["removed"] = await self.mkdoc("W", editor="blocks", content="# R", cover_removed_at=page_covers.now_utc(),
                                        created_at=old)
        p["off"] = await self.mkdoc("W", editor="blocks", content="# O", cover_auto_off=True, created_at=old)
        p["classic"] = await self.mkdoc("W", content="# classic doc", created_at=old)       # not a page
        p["file"] = await self.mkdoc("W", kind="artifact", editor="blocks", created_at=old)
        p["ws_off"] = await self.mkdoc("W", owner="wm2", ws="W2", editor="blocks", content="# W2 page", created_at=old)
        await self.db["workspaces"].update_one({"_id": ObjectId(self.ws["W2"])}, {"$set": {"settings.auto_covers": False}})
        # The world's own page (launch-page) is one more page without a cover.
        await self.db["documents"].update_one({"slug": "launch-page"}, {"$set": {"created_at": old}})
        return p

    async def test_starts_by_itself_and_works_in_batches(self):
        self.fake.script = lambda params: json.dumps(
            {"cover": page_covers.fallback(prompt_of(params).split('title="')[1].split('"')[0], ""), "tint": "light"})
        p = await self.make_pages()
        self.assertEqual((await page_covers.backfill_state(self.db))["status"], "not_started")
        # The counts it starts from (writes nothing, calls nothing).
        scan = await page_covers.backfill_scan(self.db)
        self.assertEqual(scan["eligible"], 5)   # 3 plain + the untitled empty one + launch-page
        self.assertEqual(scan["skipped"], {"encrypted": 1, "template": 1, "removed": 1, "creator_off": 1,
                                           "has_cover": 1, "workspace_off": 1, "other": 0})
        self.assertEqual((scan["ai_enabled"], scan["ai_estimate"], scan["fallback_estimate"]), (True, 5, 0))
        self.assertEqual(self.fake.calls, [])
        self.assertIsNone(self.cover_of(await self.doc(p["plain"]["slug"])))
        # The first tick of the background loop starts it: no approval.
        st = await page_covers.backfill_tick(self.db, batch=3, pause=0)
        self.assertEqual((st["status"], st["planned"], st["done"], st["batches"]), ("running", 5, 3, 1))
        st = await page_covers.backfill_tick(self.db, batch=3, pause=0)
        self.assertEqual((st["done"], st["ai"], st["skipped"]), (4, 4, 1))   # the untitled, empty page: nothing to go by
        st = await page_covers.backfill_tick(self.db, batch=3, pause=0)
        self.assertEqual(st["status"], "done")
        self.assertIsNotNone(st["finished_at"])
        self.assertIsNone(await page_covers.backfill_tick(self.db))
        self.assertEqual(self.cover_of(await self.doc(p["plain"]["slug"])), "gallery:lattice")
        self.assertEqual(self.cover_of(await self.doc(p["plain2"]["slug"])), f"gallery:{page_covers.fallback('Welcome', '')}")
        for k in ("empty", "has", "enc", "tpl", "removed", "off", "classic", "file", "ws_off"):
            row = await self.doc(p[k]["slug"])
            self.assertNotEqual(row.get("cover_auto"), True, k)
        self.assertEqual(self.cover_of(await self.doc(p["has"]["slug"])), "gallery:sage")
        # Its ledger rows: no person, via backfill. updated_at untouched (a cover isn't an edit).
        rows = await self.cover_rows()
        self.assertEqual(len(rows), 4)
        self.assertEqual({(r["via"], r["user_id"]) for r in rows}, {("backfill", None)})
        moved = (await self.doc(p["plain"]["slug"]))["updated_at"].replace(tzinfo=None) - p["plain"]["updated_at"].replace(tzinfo=None)
        self.assertLess(abs(moved.total_seconds()), 1)

    async def test_runs_once(self):
        await self.make_pages()
        while ((await page_covers.backfill_tick(self.db, batch=50, pause=0)) or {}).get("status") == "running":
            pass
        n = len(self.fake.calls)
        # Pages made later are new pages (they had their own chance); and a finished job never restarts,
        # not even on another process or after a restart.
        late = await self.mkdoc("W", editor="blocks", title="Hiring plan", content="Recruiting")
        old = await self.mkdoc("W", editor="blocks", title="Brand guide", content="Colours",
                               created_at=page_covers.now_utc() - timedelta(days=60))
        self.assertFalse(await page_covers.backfill_ensure(self.db))
        for _ in range(3):
            self.assertIsNone(await page_covers.backfill_tick(self.db, pause=0))
        self.assertEqual(len(self.fake.calls), n)
        self.assertIsNone(self.cover_of(await self.doc(late["slug"])))
        self.assertIsNone(self.cover_of(await self.doc(old["slug"])))
        self.assertEqual(await self.db[page_covers.BACKFILL].count_documents({}), 1)

    async def test_two_starters_make_one_job(self):
        import asyncio

        await self.make_pages()
        started = await asyncio.gather(*(page_covers.backfill_ensure(self.db) for _ in range(4)))
        self.assertEqual(sorted(started), [False, False, False, True])
        self.assertEqual(await self.db[page_covers.BACKFILL].count_documents({}), 1)

    async def test_resumes_after_a_restart_and_pauses(self):
        p = await self.make_pages()
        st = await page_covers.backfill_tick(self.db, batch=2, pause=0)
        self.assertEqual(st["done"], 2)
        # A restart: nothing in memory survives; the cursor in Mongo does. No page is done twice.
        page_covers._TASKS.clear()
        ai_usage._reserved.clear()
        calls = len(self.fake.calls)
        st = await page_covers.backfill_tick(self.db, batch=2, pause=0)
        self.assertEqual(st["done"], 4)
        self.assertEqual(len(self.fake.calls), calls + 2)
        covered = [r for r in await self.cover_rows()]
        self.assertEqual(len({r["slug"] for r in covered}), len(covered))
        # Paused: ticks do nothing; resumed: it finishes.
        st = await page_covers.backfill_pause(self.db, "admin")
        self.assertEqual(st["status"], "paused")
        self.assertIsNone(await page_covers.backfill_tick(self.db, pause=0))
        st = await page_covers.backfill_resume(self.db, "admin")
        self.assertEqual(st["status"], "running")
        while ((await page_covers.backfill_tick(self.db, batch=2, pause=0)) or {}).get("status") == "running":
            pass
        self.assertEqual((await page_covers.backfill_state(self.db))["status"], "done")
        self.assertIsNotNone(self.cover_of(await self.doc(p["plain3"]["slug"])))

    async def test_a_short_budget_falls_back_to_keywords(self):
        await self.make_pages()
        settings.pages_ai_daily_usd = 0.0021   # room for one pick held at $0.002
        st = await page_covers.backfill_tick(self.db, batch=10, pause=0)
        self.assertEqual((st["done"], st["ai"], st["fallback"], st["budget_short"]), (4, 1, 3, True))
        self.assertEqual(len(self.fake.calls), 1)
        self.assertEqual(st["scan"]["ai_estimate"] + st["scan"]["fallback_estimate"], 5)

    async def test_admin_status_pause_resume(self):
        await self.make_pages()
        h = {"Authorization": f"Bearer {_make_token()[0]}"}
        base = "/api/v1/admin/ai/covers/backfill"
        self.assertEqual((await self.http.get(base)).status_code, 401)
        self.assertEqual((await self.http.post(f"{base}/pause")).status_code, 401)
        r = await self.http.get(base, headers=h)
        self.assertEqual((r.status_code, r.json()["state"]["status"]), (200, "not_started"))
        await page_covers.backfill_tick(self.db, batch=1, pause=0)
        r = await self.http.get(base, headers=h)
        body = r.json()
        self.assertEqual((body["state"]["status"], body["state"]["done"], body["scan"]["eligible"]), ("running", 1, 5))
        self.assertNotIn("cursor", body["state"])
        r = await self.http.post(f"{base}/pause", headers=h)
        self.assertEqual(r.json()["state"]["status"], "paused")
        self.assertIsNone(await page_covers.backfill_tick(self.db))
        r = await self.http.post(f"{base}/resume", headers=h)
        self.assertEqual(r.json()["state"]["status"], "running")
        audit = (await self.http.get("/api/v1/admin/ai/budgets/audit", headers=h)).json()["items"]
        self.assertEqual([a["target_label"] for a in audit[:2]], ["Cover backfill", "Cover backfill"])


class MCP(CoverWorld):
    async def test_create_page_says_its_cover(self):
        tok = await self.mcp_token("owner")
        code, res = await self.mcp_call(tok, "create_page", {"title": "Q3 roadmap", "content": ROADMAP})
        self.assertFalse(res.get("isError"), res)
        out = res["structuredContent"]
        self.assertEqual((out["cover"], out["cover_auto"]), ("gallery:route", True))
        self.assertIn("automatically", res["content"][0]["text"])
        rows = await self.cover_rows()
        self.assertEqual((rows[-1]["via"], rows[-1]["user_id"]), ("mcp", self.uid["owner"]))
        # auto_cover false: none, ever.
        code, res = await self.mcp_call(tok, "create_page", {"title": "Q3 roadmap", "content": ROADMAP,
                                                             "auto_cover": False})
        out = res["structuredContent"]
        self.assertEqual((out["cover"], out["cover_auto"]), (None, False))
        self.assertTrue((await self.doc(out["slug"]))["cover_auto_off"])
        # A cover given: kept, nothing picked.
        n = len(self.fake.calls)
        code, res = await self.mcp_call(tok, "create_page", {"title": "Q3 roadmap", "content": ROADMAP,
                                                             "properties": {"cover": "gallery:sage"}})
        self.assertEqual((res["structuredContent"]["cover"], res["structuredContent"]["cover_auto"]),
                         ("gallery:sage", False))
        self.assertEqual(len(self.fake.calls), n)
        # get_page says it.
        code, res = await self.mcp_call(tok, "get_page", {"document": out["slug"]})
        self.assertFalse(res["structuredContent"]["properties"]["cover_auto"])

    async def test_set_page_properties_auto_and_null(self):
        tok = await self.mcp_token("owner")
        code, res = await self.mcp_call(tok, "create_page", {"title": "Q3 roadmap", "content": ROADMAP})
        slug = res["structuredContent"]["slug"]
        # null removes it, and that's remembered.
        code, res = await self.mcp_call(tok, "set_page_properties", {"document": slug, "cover": None})
        self.assertFalse(res.get("isError"), res)
        self.assertIsNotNone((await self.doc(slug)).get("cover_removed_at"))
        # "auto" asks for one again (the person asking overrides the removal).
        self.fake.reply = '{"cover": "horizon", "tint": "light"}'
        code, res = await self.mcp_call(tok, "set_page_properties", {"document": slug, "cover": "auto"})
        self.assertFalse(res.get("isError"), res)
        out = res["structuredContent"]
        self.assertEqual((out["cover"], out["cover_auto"]), ("gallery:horizon", True))
        row = await self.doc(slug)
        self.assertIsNone(row.get("cover_removed_at"))
        self.assertTrue(row["cover_auto"])
        # With other properties in the same call.
        self.fake.reply = '{"cover": "sheets"}'
        code, res = await self.mcp_call(tok, "set_page_properties", {"document": slug, "cover": "auto",
                                                                     "full_width": True})
        self.assertFalse(res.get("isError"), res)
        props = page_props.parse((await self.doc(slug))["content"])
        self.assertEqual((props["cover"], props["full_width"]), ("gallery:sheets", True))
        # A reader can't; a workspace with auto covers off says so.
        code, res = await self.mcp_call(await self.mcp_token("gv"), "set_page_properties",
                                        {"document": slug, "cover": "auto"})
        self.assertTrue(res.get("isError"))
        code, res = await self.mcp_call(await self.mcp_token("wm"), "create_page",
                                        {"title": "Q3 roadmap", "content": ROADMAP, "workspace": self.ws["W1"]})
        self.assertFalse(res.get("isError"), res)
        wslug = res["structuredContent"]["slug"]
        await self.db["workspaces"].update_one({"_id": ObjectId(self.ws["W1"])}, {"$set": {"settings.auto_covers": False}})
        code, res = await self.mcp_call(await self.mcp_token("wm"), "set_page_properties",
                                        {"document": wslug, "cover": "auto"})
        self.assertTrue(res.get("isError"))
        self.assertIn("Auto covers are off", res["content"][0]["text"])

    async def test_suggest_endpoint(self):
        self.fake.reply = '{"cover": "circles"}'
        r = await self.http.post("/api/v1/pages/launch-page/cover/suggest", headers=self.session("owner"))
        self.assertEqual((r.status_code, r.json()), (200, {"cover": "gallery:circles", "how": "ai"}))
        self.assertIsNone(page_props.parse((await self.doc("launch-page"))["content"])["cover"])  # not written
        r = await self.http.post("/api/v1/pages/launch-page/cover/suggest", headers=self.session("gv"))
        self.assertEqual(r.status_code, 403)
        r = await self.http.get("/api/v1/pages/launch-page/cover", headers=self.session("stranger"))
        self.assertEqual(r.status_code, 404)
