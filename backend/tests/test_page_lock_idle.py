"""A page's edit lock is held only while someone is actually editing (services/pages.py "One
editor at a time"): taken with the first change, never by opening; released after 2 minutes
without a change, 60 s with the tab hidden, or 2 minutes without a heartbeat; a heartbeat never
takes back a lost lock; the page's owner and workspace admins can take over (the app's
``take_over=true``, MCP ``take_over: true``), and the other editor's unsaved text is kept in the
page's version history; refusals say who, how idle, unsaved changes, when it releases and whether
the caller may take over (REST body and MCP structuredContent).

Senseloaf, 2026-11-05: an idle open editor tab ("away", editing) refused every MCP write until
its owner closed the tab.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta

from tests._access_env import AccessWorld, now

from app.services import live, pages, viewers


class PageLockIdle(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        from app.limiter import limiter

        limiter.enabled = False
        self.addCleanup(setattr, limiter, "enabled", True)
        viewers.clear()

    async def page(self) -> dict:
        return await self.mkdoc("W", editor="blocks", content="# Plan\n\nSome text.\n")

    async def lock(self, slug: str, who: str, status: int = 200, **params) -> dict:
        q = {k: ("true" if v is True else "false" if v is False else v) for k, v in params.items()}
        r = await self.http.post(f"/api/v1/documents/{slug}/lock", params=q, headers=self.session(who))
        self.assertEqual(r.status_code, status, r.text)
        return r.json()

    async def status(self, slug: str, who: str) -> dict:
        r = await self.http.get(f"/api/v1/documents/{slug}/lock", headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def age(self, slug: str, **fields_seconds) -> None:
        """Move lock clocks into the past: age(slug, edited_at=130) → edited 130 s ago."""
        sets = {f"edit_lock.{k}": now() - timedelta(seconds=v) for k, v in fields_seconds.items()}
        await self.db["documents"].update_one({"slug": slug}, {"$set": sets})

    async def mcp(self, who: str, name: str, args: dict) -> dict:
        status, res = await self.mcp_call(await self.mcp_token(who, write=True), name, args)
        self.assertEqual(status, 200)
        return res

    # ── taken on a change, never on opening ──

    async def test_opening_takes_nothing(self):
        p = await self.page()
        r = await self.http.get(f"/api/v1/documents/{p['slug']}", headers=self.session("ge"))
        self.assertEqual(r.status_code, 200, r.text)
        st = await self.status(p["slug"], "ge")
        self.assertIsNone(st["holder"])
        self.assertIn("idle_s", st["timers"])
        self.assertIsNone((await self.doc(p["slug"])).get("edit_lock"))
        # Asking who holds it takes nothing either; MCP writes go straight through.
        res = await self.mcp("owner", "update_page", {"document": p["slug"], "markdown": "# New\n", "base_rev": 1})
        self.assertFalse(res["isError"], res)

    async def test_edit_takes_heartbeat_renews(self):
        p = await self.page()
        out = await self.lock(p["slug"], "ge", intent="edit")
        self.assertTrue(out["mine"])
        self.assertEqual(out["rev"], 1)
        self.assertEqual(out["timers"]["idle_s"], 120.0)
        lock = (await self.doc(p["slug"]))["edit_lock"]
        self.assertIsNotNone(lock["edited_at"])
        self.assertFalse(lock["dirty"])
        out = await self.lock(p["slug"], "ge", intent="heartbeat", edited=True, dirty=True, hidden=False)
        self.assertTrue(out["mine"])
        self.assertTrue((await self.doc(p["slug"]))["edit_lock"]["dirty"])
        self.assertEqual(viewers.editor_of(p["slug"]), self.uid["ge"])

    # ── released when idle, hidden, or gone ──

    async def test_idle_release_and_heartbeat_never_retakes(self):
        p = await self.page()
        await self.lock(p["slug"], "ge", intent="edit")
        # Heartbeats keep coming (an open tab), but nothing changed for over 2 minutes.
        await self.lock(p["slug"], "ge", intent="heartbeat")
        await self.age(p["slug"], edited_at=121)
        self.assertIsNone(pages.lock_view((await self.doc(p["slug"]))["edit_lock"]))
        out = await self.lock(p["slug"], "ge", intent="heartbeat")
        self.assertEqual((out["mine"], out["released"], out["reason"]), (False, True, "idle"))
        self.assertIsNone(pages.lock_view((await self.doc(p["slug"]))["edit_lock"]))
        self.assertIsNone(viewers.editor_of(p["slug"]))
        # Everyone can write again (MCP included).
        res = await self.mcp("owner", "update_page", {"document": p["slug"], "markdown": "# Mine\n", "base_rev": 1})
        self.assertFalse(res["isError"], res)
        # An editor from before idle release (no intent) can't revive it either.
        out = await self.lock(p["slug"], "ge")
        self.assertFalse(out["mine"])
        self.assertIsNone(pages.lock_view((await self.doc(p["slug"]))["edit_lock"]))
        # Their next change takes it again, at the page's newest revision.
        out = await self.lock(p["slug"], "ge", intent="edit")
        self.assertTrue(out["mine"])
        self.assertEqual(out["rev"], 2)

    async def test_hidden_release(self):
        p = await self.page()
        await self.lock(p["slug"], "ge", intent="edit")
        await self.lock(p["slug"], "ge", intent="heartbeat", hidden=True)
        lock = (await self.doc(p["slug"]))["edit_lock"]
        self.assertIsNotNone(lock["hidden_since"])
        self.assertTrue(pages.lock_view(lock)["hidden"])
        # Presence lists them as editing no longer than the hidden time.
        self.assertLessEqual(viewers._editors[p["slug"]][1] - viewers._now(), 60.5)
        # Back within the minute: still theirs.
        await self.lock(p["slug"], "ge", intent="heartbeat", hidden=False)
        self.assertIsNone((await self.doc(p["slug"]))["edit_lock"]["hidden_since"])
        # Hidden over a minute: released.
        await self.lock(p["slug"], "ge", intent="heartbeat", hidden=True)
        await self.age(p["slug"], hidden_since=61)
        out = await self.lock(p["slug"], "ge", intent="heartbeat", hidden=False)
        self.assertEqual((out["mine"], out["reason"]), (False, "hidden"))
        # Someone else may take it now.
        self.assertTrue((await self.lock(p["slug"], "wm", intent="edit"))["mine"])

    async def test_presence_away_starts_the_hidden_clock(self):
        """An editor that doesn't say its tab is hidden (an old one): who's viewing does."""
        p = await self.page()
        await self.lock(p["slug"], "ge")  # no intent: an editor from before idle release
        await pages.presence_away(self.db, p["slug"], self.uid["ge"], True)
        self.assertIsNotNone((await self.doc(p["slug"]))["edit_lock"]["hidden_since"])
        await pages.presence_away(self.db, p["slug"], self.uid["ge"], False)
        self.assertIsNone((await self.doc(p["slug"]))["edit_lock"]["hidden_since"])
        await pages.presence_away(self.db, p["slug"], self.uid["ge"], True)
        await self.age(p["slug"], hidden_since=61)
        self.assertIsNone(pages.lock_view((await self.doc(p["slug"]))["edit_lock"]))
        # Coming back after it lapsed doesn't revive it, and its legacy heartbeat can't either.
        await pages.presence_away(self.db, p["slug"], self.uid["ge"], False)
        self.assertIsNone(pages.lock_view((await self.doc(p["slug"]))["edit_lock"]))
        out = await self.lock(p["slug"], "ge")
        self.assertFalse(out["mine"])

    async def test_no_heartbeat_release(self):
        p = await self.page()
        await self.lock(p["slug"], "ge", intent="edit")
        await self.age(p["slug"], expires_at=1)
        self.assertIsNone(pages.lock_view((await self.doc(p["slug"]))["edit_lock"]))

    async def test_holder_save_restarts_the_idle_clock(self):
        p = await self.page()
        await self.lock(p["slug"], "ge", intent="edit", dirty=True)
        await self.age(p["slug"], edited_at=100)
        r = await self.http.put(f"/api/v1/documents/{p['slug']}", headers=self.session("ge"),
                                json={"title": "T", "content": "# Plan\n\nMore.\n", "base_rev": 1})
        self.assertEqual(r.status_code, 200, r.text)
        lock = (await self.doc(p["slug"]))["edit_lock"]
        self.assertFalse(lock["dirty"])
        self.assertLess((now() - lock["edited_at"].replace(tzinfo=now().tzinfo)).total_seconds(), 5)

    # ── refusals say enough ──

    async def test_refusal_fields_rest(self):
        p = await self.page()
        await self.lock(p["slug"], "ge", intent="edit", dirty=True)
        await self.age(p["slug"], edited_at=70)
        body = await self.lock(p["slug"], "wm", status=423, intent="edit")
        self.assertEqual(body["code"], "locked")
        self.assertEqual(body["holder"]["name"], "GE")
        self.assertTrue(body["dirty"])
        self.assertGreaterEqual(body["idle_s"], 69)
        self.assertLessEqual(body["releases_in_s"], 51)
        self.assertFalse(body["can_take_over"])
        self.assertIn("idle for 1 min", body["detail"])
        self.assertIn("unsaved changes", body["detail"])
        self.assertIn("releases in about", body["detail"])
        body = await self.lock(p["slug"], "owner", status=423, intent="edit")
        self.assertTrue(body["can_take_over"])
        self.assertIn("Edit anyway", body["detail"])
        # A save by someone else says the same.
        r = await self.http.put(f"/api/v1/documents/{p['slug']}", headers=self.session("wm"),
                                json={"title": "T", "content": "x", "base_rev": 1})
        self.assertEqual(r.status_code, 423)
        self.assertTrue(r.json()["dirty"])

    async def test_refusal_fields_mcp(self):
        p = await self.page()
        await self.lock(p["slug"], "ge", intent="edit", dirty=True)
        await self.age(p["slug"], edited_at=30)
        for tool, args in (("update_page", {"markdown": "# x\n", "base_rev": 1}),
                           ("replace_section", {"heading": "Plan", "markdown": "y"}),
                           ("set_page_properties", {"full_width": True}),
                           ("set_slug", {"slug": "new-slug-1"})):
            res = await self.mcp("owner", tool, {"document": p["slug"], **args})
            self.assertTrue(res["isError"], (tool, res))
            sc = res.get("structuredContent")
            self.assertIsNotNone(sc, tool)
            self.assertEqual(sc["error"], "locked", tool)
            self.assertEqual(sc["holder"]["name"], "GE")
            self.assertTrue(sc["dirty"])
            self.assertGreaterEqual(sc["idle_s"], 29)
            self.assertIn("releases_in_s", sc)
            self.assertTrue(sc["can_take_over"], tool)
            text = res["content"][0]["text"]
            self.assertIn("GE is editing this page (idle for", text)
            self.assertIn("take_over: true", text)
        res = await self.mcp("wm", "update_page", {"document": p["slug"], "markdown": "# x\n", "base_rev": 1})
        self.assertFalse(res["structuredContent"]["can_take_over"])
        # get_page says who and how idle.
        res = await self.mcp("owner", "get_page", {"document": p["slug"]})
        self.assertEqual(res["structuredContent"]["edit_lock"]["holder"], "GE")
        self.assertIn("idle for", res["content"][0]["text"])

    # ── take over ──

    async def test_take_over_permissions_app(self):
        p = await self.page()
        await self.lock(p["slug"], "ge", intent="edit")
        for who in ("wm", "wv"):
            r = await self.http.post(f"/api/v1/documents/{p['slug']}/lock", params={"take_over": "true"},
                                     headers=self.session(who))
            self.assertIn(r.status_code, (403,), (who, r.text))
        body = await self.lock(p["slug"], "wm", status=403, take_over=True)
        self.assertEqual(body["code"], "take_over_forbidden")
        q = live.subscribe(p["slug"])
        self.addCleanup(live.unsubscribe, p["slug"], q)
        out = await self.lock(p["slug"], "owner", intent="edit", take_over=True)
        self.assertTrue(out["mine"])
        self.assertEqual(out["took_over"]["from"], "GE")
        self.assertEqual(q.get_nowait(), {"type": "lock", "taken_over": True})
        self.assertEqual(viewers.editor_of(p["slug"]), self.uid["owner"])
        # GE's editor learns it on its next heartbeat (never re-taking it).
        body = await self.lock(p["slug"], "ge", status=423, intent="heartbeat", dirty=True)
        self.assertEqual(body["taken_over"]["by"], "OWNER")
        self.assertEqual(body["holder"]["name"], "OWNER")
        st = await self.status(p["slug"], "ge")
        self.assertEqual(st["taken_over"]["by"], "OWNER")
        # A workspace admin can take it from the owner.
        out = await self.lock(p["slug"], "wa", intent="edit", take_over=True)
        self.assertEqual(out["took_over"]["from"], "OWNER")
        # Taking over a free page is just taking it.
        await self.db["documents"].update_one({"slug": p["slug"]}, {"$set": {"edit_lock": None}})
        self.assertTrue((await self.lock(p["slug"], "wo", intent="edit", take_over=True))["mine"])

    async def test_take_over_mcp(self):
        p = await self.page()
        await self.lock(p["slug"], "ge", intent="edit", dirty=True)
        res = await self.mcp("wm", "update_page", {"document": p["slug"], "markdown": "# x\n", "base_rev": 1,
                                                   "take_over": True})
        self.assertTrue(res["isError"])
        self.assertEqual(res["structuredContent"]["error"], "take_over_forbidden")
        self.assertIsNotNone(pages.lock_view((await self.doc(p["slug"]))["edit_lock"]))
        q = live.subscribe(p["slug"])
        self.addCleanup(live.unsubscribe, p["slug"], q)
        res = await self.mcp("owner", "update_page", {"document": p["slug"], "markdown": "# By AI\n", "base_rev": 1,
                                                      "take_over": True})
        self.assertFalse(res["isError"], res)
        raw = await self.doc(p["slug"])
        self.assertEqual(raw["content"], "# By AI\n")
        self.assertIsNone(raw["edit_lock"])
        self.assertEqual(raw["edit_lock_taken"]["from_user_id"], self.uid["ge"])
        self.assertTrue(raw["edit_lock_taken"]["dirty"])
        events = []
        while not q.empty():
            events.append(q.get_nowait())
        self.assertIn({"type": "lock", "taken_over": True}, events)
        out = await self.lock(p["slug"], "ge", intent="heartbeat", dirty=True)
        self.assertEqual((out["mine"], out["reason"], out["taken_over"]["by"]), (False, "taken_over", "OWNER"))
        # take_over isn't sticky: the next call without it is refused again once someone holds it.
        await self.lock(p["slug"], "ge", intent="edit")
        res = await self.mcp("owner", "replace_section", {"document": p["slug"], "heading": "By AI", "markdown": "z"})
        self.assertTrue(res["isError"])
        # A workspace admin's AI app may take over too (set_page_properties, set_slug, restore).
        res = await self.mcp("wa", "set_page_properties", {"document": p["slug"], "full_width": True,
                                                           "take_over": True})
        self.assertFalse(res["isError"], res)

    async def test_unsaved_text_is_kept_on_take_over(self):
        p = await self.page()
        await self.lock(p["slug"], "ge", intent="edit", dirty=True)
        await self.lock(p["slug"], "owner", intent="edit", take_over=True)
        r = await self.http.post(f"/api/v1/documents/{p['slug']}/lock/keep", headers=self.session("ge"),
                                 json={"title": "Draft", "content": "# Plan\n\nGE's unsaved words.\n",
                                       "base_rev": 1, "reason": "taken_over"})
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertTrue(out["kept"])
        raw = await self.doc(p["slug"])
        self.assertEqual(raw["content"], "# Plan\n\nSome text.\n")  # the page itself is unchanged
        r = await self.http.get(f"/api/v1/documents/{p['slug']}/versions/{out['version']}",
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        v = r.json()
        self.assertIn("GE's unsaved words", v["markdown"])
        self.assertEqual(v["event"]["type"], "kept")
        self.assertIn("kept when OWNER took over editing", v["event"]["text"])
        # Sent twice (a retry): one version.
        r = await self.http.post(f"/api/v1/documents/{p['slug']}/lock/keep", headers=self.session("ge"),
                                 json={"title": "Draft", "content": "# Plan\n\nGE's unsaved words.\n",
                                       "reason": "taken_over"})
        self.assertFalse(r.json()["kept"])
        # Someone who can't edit the page can't put anything in its history.
        r = await self.http.post(f"/api/v1/documents/{p['slug']}/lock/keep", headers=self.session("gv"),
                                 json={"content": "x", "reason": "taken_over"})
        self.assertIn(r.status_code, (403, 404))
        # Their next change takes the page back once it's free, and the take-over is forgotten.
        await self.db["documents"].update_one({"slug": p["slug"]}, {"$set": {"edit_lock": None}})
        await self.lock(p["slug"], "ge", intent="edit")
        self.assertIsNone((await self.doc(p["slug"]))["edit_lock_taken"])

    async def test_presence_editing_follows_the_lock(self):
        p = await self.page()
        await self.lock(p["slug"], "ge", intent="edit")
        self.assertEqual(viewers.editor_of(p["slug"]), self.uid["ge"])
        await self.db["documents"].update_one({"slug": p["slug"]}, {"$set": {"edit_lock": None}})
        await self.http.delete(f"/api/v1/documents/{p['slug']}/lock", headers=self.session("ge"))
        # Release by the editor (or its lapse) clears it; the sweeper notices a lapse by itself.
        viewers.set_editor(p["slug"], self.uid["ge"], 0.05)
        await asyncio.sleep(0.1)
        self.assertIsNone(viewers.editor_of(p["slug"]))
