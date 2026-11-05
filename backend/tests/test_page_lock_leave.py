"""An editor that closes or leaves lets go of the page's edit lock at once (fix/lock-release-on-leave,
2026-11-05), not two minutes later:

- every lock answer carries ``release_token`` (services/tickets.mint_lock_release): the close beacon
  (POST …/lock/release, no Authorization header) sends it; it lets go of that person's own lock on
  that one page and nothing else, on markdrop.in and on a workspace's own domain alike, and it is
  no session;
- the holder's last live socket on the page closing (a killed tab, a browser that ran no
  ``pagehide``) lets go of it ``page_lock_gone_s`` later (services/viewers._editor_left), unless
  one of their tabs is back; nobody else's lock is touched.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
from unittest import mock

import jwt

from tests._access_env import HOSTS, AccessWorld

from app.config import get_settings
from app.services import pages, tickets, viewers


class PageLockLeave(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        from app.limiter import limiter

        limiter.enabled = False
        self.addCleanup(setattr, limiter, "enabled", True)
        viewers.clear()
        self.addCleanup(viewers.clear)

    async def page(self) -> dict:
        return await self.mkdoc("W", editor="blocks", content="# Plan\n\nSome text.\n")

    async def lock(self, slug: str, headers: dict, status: int = 200, **params) -> dict:
        q = {k: ("true" if v is True else "false" if v is False else v) for k, v in params.items()}
        r = await self.http.post(f"/api/v1/documents/{slug}/lock", params=q, headers=headers)
        self.assertEqual(r.status_code, status, r.text)
        return r.json()

    async def holder(self, slug: str) -> str | None:
        view = pages.lock_view((await self.doc(slug)).get("edit_lock"))
        return view["user_id"] if view else None

    async def beacon(self, slug: str, body: str, origin: str | None = None) -> None:
        hdrs = {"Content-Type": "text/plain", **({"Origin": origin} if origin else {})}
        r = await self.http.post(f"/api/v1/documents/{slug}/lock/release", content=body, headers=hdrs)
        self.assertEqual(r.status_code, 204)

    # ── the release token ──

    async def test_lock_answers_carry_a_release_token(self):
        p = await self.page()
        took = await self.lock(p["slug"], self.session("ge"), intent="edit")
        beat = await self.lock(p["slug"], self.session("ge"), intent="heartbeat", edited=True)
        for out in (took, beat):
            claims = jwt.decode(out["release_token"], get_settings().auth_secret, algorithms=["HS256"])
            self.assertEqual(tickets.lock_release_user(claims, await self.doc(p["slug"])), self.uid["ge"])
        # A refusal (someone else holds it) carries none; a take-over carries the new holder's.
        refused = await self.lock(p["slug"], self.session("wm"), status=423, intent="edit")
        self.assertNotIn("release_token", refused)
        over = await self.lock(p["slug"], self.session("owner"), intent="edit", take_over=True)
        claims = jwt.decode(over["release_token"], get_settings().auth_secret, algorithms=["HS256"])
        self.assertEqual(claims["u"], self.uid["owner"])

    async def test_release_token_beacon_lets_go_of_the_holders_own_lock(self):
        p = await self.page()
        token = (await self.lock(p["slug"], self.session("ge"), intent="edit"))["release_token"]
        # No Origin needed (a beacon from markdrop.in or a workspace's domain alike).
        await self.beacon(p["slug"], token)
        self.assertIsNone(await self.holder(p["slug"]))
        self.assertIsNone(viewers.editor_of(p["slug"]))
        # An AI app's write right after goes through.
        status, res = await self.mcp_call(await self.mcp_token("owner"), "update_page",
                                          {"document": p["slug"], "markdown": "# After\n", "base_rev": 1})
        self.assertEqual(status, 200)
        self.assertFalse(res["isError"], res)

    async def test_release_token_never_releases_anyone_elses_lock(self):
        p = await self.page()
        ge_token = (await self.lock(p["slug"], self.session("ge"), intent="edit"))["release_token"]
        # The owner took over: GE's token (a stale tab closing) leaves the owner's lock alone.
        await self.lock(p["slug"], self.session("owner"), intent="edit", take_over=True)
        await self.beacon(p["slug"], ge_token)
        self.assertEqual(await self.holder(p["slug"]), self.uid["owner"])
        # A token for another page does nothing here.
        q = await self.page()
        q_token = (await self.lock(q["slug"], self.session("owner"), intent="edit"))["release_token"]
        await self.beacon(p["slug"], q_token)
        self.assertEqual(await self.holder(p["slug"]), self.uid["owner"])
        self.assertEqual(await self.holder(q["slug"]), self.uid["owner"])
        # Expired, tampered, or another kind of ticket (presence, read): ignored.
        expired = tickets.mint_lock_release(str(p["_id"]), self.uid["owner"], ttl=timedelta(seconds=-1))
        presence = tickets.mint_presence(str(p["_id"]), self.uid["owner"])
        for body in (expired, q_token[:-3] + "abc", presence, tickets.mint(str(p["_id"]), 0)):
            await self.beacon(p["slug"], body)
            self.assertEqual(await self.holder(p["slug"]), self.uid["owner"])
        # A missing page: 204 all the same.
        await self.beacon("no-such-page", q_token)

    async def test_release_token_is_no_session(self):
        p = await self.page()
        token = (await self.lock(p["slug"], self.session("ge"), intent="edit"))["release_token"]
        auth = {"Authorization": f"Bearer {token}"}
        self.assertEqual((await self.http.get("/api/v1/auth/me", headers=auth)).status_code, 401)
        self.assertEqual((await self.http.delete(f"/api/v1/documents/{p['slug']}/lock", headers=auth)).status_code, 401)
        self.assertEqual((await self.http.get(f"/api/v1/documents/{p['slug']}/lock", headers=auth)).status_code, 401)
        self.assertEqual(await self.holder(p["slug"]), self.uid["ge"])

    async def test_release_token_on_a_workspace_domain(self):
        p = await self.page()
        h = self.tenant("wm", "W1")
        token = (await self.lock(p["slug"], h, intent="edit"))["release_token"]
        self.assertEqual(await self.holder(p["slug"]), self.uid["wm"])
        await self.beacon(p["slug"], token, origin=f"https://{HOSTS['W1']}")
        self.assertIsNone(await self.holder(p["slug"]))

    async def test_session_token_beacon_still_works(self):
        """Editors loaded before release tokens send the session itself."""
        p = await self.page()
        await self.lock(p["slug"], self.session("ge"), intent="edit")
        await self.beacon(p["slug"], self.session("ge")["Authorization"][7:])
        self.assertIsNone(await self.holder(p["slug"]))

    # ── the holder's tabs closed without a word ──

    def conn(self, slug: str, raw: dict, who: str) -> viewers.Conn:
        r = viewers._room_for(slug, raw)
        c = viewers.connect(asyncio.Queue(), "1.2.3.4")
        c.joined = c.present = True
        c.user_id = self.uid[who]
        r.conns[c.id] = c
        return c

    async def settle(self, s: float = 0.25) -> None:
        await asyncio.sleep(s)
        for t in list(viewers._gone_tasks):
            await t

    async def test_holders_last_socket_closing_releases(self):
        p = await self.page()
        raw = await self.doc(p["slug"])
        with mock.patch.object(get_settings(), "page_lock_gone_s", 0.1):
            c = self.conn(p["slug"], raw, "ge")
            reader = self.conn(p["slug"], raw, "wv")
            await self.lock(p["slug"], self.session("ge"), intent="edit")
            # A reader leaving changes nothing.
            viewers.leave(p["slug"], reader)
            await self.settle()
            self.assertEqual(await self.holder(p["slug"]), self.uid["ge"])
            viewers.leave(p["slug"], c)
            await self.settle()
        self.assertIsNone(await self.holder(p["slug"]))
        self.assertIsNone(viewers.editor_of(p["slug"]))

    async def test_another_tab_or_a_reconnect_keeps_it(self):
        p = await self.page()
        raw = await self.doc(p["slug"])
        with mock.patch.object(get_settings(), "page_lock_gone_s", 0.1):
            a = self.conn(p["slug"], raw, "ge")
            b = self.conn(p["slug"], raw, "ge")
            await self.lock(p["slug"], self.session("ge"), intent="edit")
            # Another of their tabs is still on the page.
            viewers.leave(p["slug"], a)
            await self.settle()
            self.assertEqual(await self.holder(p["slug"]), self.uid["ge"])
            # Their last tab reconnects (a new read ticket, a network blip) within the time.
            viewers.leave(p["slug"], b)
            self.conn(p["slug"], raw, "ge")
            await self.settle()
            self.assertEqual(await self.holder(p["slug"]), self.uid["ge"])

    async def test_gone_never_touches_someone_elses_lock(self):
        p = await self.page()
        raw = await self.doc(p["slug"])
        with mock.patch.object(get_settings(), "page_lock_gone_s", 0.1):
            c = self.conn(p["slug"], raw, "ge")
            await self.lock(p["slug"], self.session("ge"), intent="edit")
            viewers.leave(p["slug"], c)
            # Before the check runs the owner takes over: GE's tabs being gone leaves it be.
            await self.lock(p["slug"], self.session("owner"), intent="edit", take_over=True)
            await self.settle()
        self.assertEqual(await self.holder(p["slug"]), self.uid["owner"])
        self.assertFalse(await pages.release_gone(self.db, p["slug"], self.uid["ge"]))

    async def test_gone_off_when_zero(self):
        p = await self.page()
        raw = await self.doc(p["slug"])
        with mock.patch.object(get_settings(), "page_lock_gone_s", 0):
            c = self.conn(p["slug"], raw, "ge")
            await self.lock(p["slug"], self.session("ge"), intent="edit")
            viewers.leave(p["slug"], c)
            await self.settle()
        self.assertEqual(await self.holder(p["slug"]), self.uid["ge"])
