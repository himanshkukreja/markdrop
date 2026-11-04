"""Who's viewing (services/viewers.py over routers/live.py).

The socket is driven through ``routers.live.serve`` with an in-memory
WebSocket, against the access-policy fixture world (tests/_access_env.py):
owner, wm (W1 member), wv (W1 viewer), gv (granted by email), stranger
(signed in, no relationship) and anonymous visitors.
"""

from __future__ import annotations

import asyncio
import json
import time
from unittest import mock

from tests._access_env import AccessWorld

from fastapi import WebSocketDisconnect

from app.routers import live as live_router
from app.services import live, tickets, viewers

CONTENT = "# Plan\n\nIntro.\n\n## Install\n\nSteps.\n\n## Use it\n\nMore.\n"


class FakeSocket:
    """Just enough of starlette's WebSocket for routers.live.serve."""

    def __init__(self, ticket: str | None = None, ip: str = "203.0.113.1"):
        self.query_params = {"t": ticket} if ticket else {}
        self.headers = {"x-real-ip": ip}
        self.client = None
        self.inbox: asyncio.Queue = asyncio.Queue()
        self.sent: list[dict] = []
        self.closed: int | None = None

    async def accept(self):
        return None

    async def receive_text(self) -> str:
        item = await self.inbox.get()
        if item is None:
            raise WebSocketDisconnect(code=1000)
        return item

    async def send_json(self, data):
        self.sent.append(data)

    async def close(self, code: int = 1000):
        self.closed = code
        self.inbox.put_nowait(None)

    # ── test helpers ──
    def say(self, **msg):
        self.inbox.put_nowait(json.dumps(msg))

    def presence(self) -> dict | None:
        snaps = [m for m in self.sent if m.get("type") == "presence"]
        return snaps[-1] if snaps else None


async def settle(n: int = 6):
    for _ in range(n):
        await asyncio.sleep(0.01)


class Viewers(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        viewers.clear()
        p = mock.patch.object(viewers, "FLUSH_S", 0.0)
        p.start()
        self.addCleanup(p.stop)
        self.tasks: list[asyncio.Task] = []
        self.addAsyncCleanup(self._close_all)

    async def _close_all(self):
        for t in self.tasks:
            t.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        viewers.clear()

    async def open(self, d: dict, who: str | None = None, *, ticket: bool = True, anon: bool = False,
                   nonce: str | None = None, ip: str = "203.0.113.1", hello: bool = True,
                   sec=None) -> FakeSocket:
        read_ticket = tickets.mint(str(d["_id"]), int(d.get("access_epoch") or 0)) if ticket else None
        ws = FakeSocket(read_ticket, ip=ip)
        self.tasks.append(asyncio.create_task(live_router.serve(ws, d["slug"])))
        await settle(2)
        if hello:
            msg = {"type": "hello", "n": nonce or f"tab{len(self.tasks):04d}xyz", "anon": anon, "state": "active"}
            if who:
                msg["pt"] = tickets.mint_presence(str(d["_id"]), self.uid[who])
            if sec is not None:
                msg["sec"] = sec
            ws.say(**msg)
            await settle()
        return ws

    def names(self, snap: dict) -> list:
        return [v.get("name") or f"Anonymous {v['animal']}" for v in snap["viewers"]]

    def assert_no_identity(self, snap: dict, who: str):
        blob = json.dumps(snap)
        self.assertNotIn(self.email[who], blob)
        self.assertNotIn(who.upper(), blob)
        self.assertNotIn(self.uid[who], blob)

    # ── The ticket ──

    async def test_get_returns_presence_ticket_only_when_signed_in(self):
        d = await self.mkdoc("L", content=CONTENT)
        anon = (await self.http.get(f"/api/v1/documents/{d['slug']}")).json()
        self.assertIsNone(anon["presence_ticket"])
        self.assertIsNone(anon["show_presence"])
        mine = (await self.http.get(f"/api/v1/documents/{d['slug']}", headers=self.session("owner"))).json()
        self.assertEqual(tickets.presence_user(mine["presence_ticket"], d), self.uid["owner"])
        self.assertTrue(mine["show_presence"])
        theirs = (await self.http.get(f"/api/v1/documents/{d['slug']}", headers=self.session("stranger"))).json()
        self.assertEqual(tickets.presence_user(theirs["presence_ticket"], d), self.uid["stranger"])
        self.assertIsNone(theirs["show_presence"])  # the owner's switch, shown to the owner
        other = await self.mkdoc("L")
        self.assertIsNone(tickets.presence_user(mine["presence_ticket"], other))  # bound to its document
        self.assertIsNone(tickets.presence_user(anon["read_ticket"], d))  # a read ticket isn't one

    # ── Identity rules ──

    async def test_named_only_with_a_relationship(self):
        d = await self.mkdoc("L", content=CONTENT)   # link, filed in W1, granted to gv and ge
        owner = await self.open(d, "owner")
        member = await self.open(d, "wm")
        granted = await self.open(d, "gv")
        stranger = await self.open(d, "stranger")
        visitor = await self.open(d)
        await settle()
        snap = owner.presence()   # someone with a relationship sees the names
        self.assertTrue(snap["on"])
        self.assertEqual(snap["total"], 5)
        named = {v["name"] for v in snap["viewers"] if "name" in v}
        self.assertEqual(named, {"OWNER", "WM", "GV"})
        anons = [v for v in snap["viewers"] if "name" not in v]
        self.assertEqual(len(anons), 2)
        for v in anons:
            self.assertIn(v["animal"], viewers.ANIMALS)
            self.assertNotIn("pic", v)
        # Anyone without one (a visitor, a stranger) sees every viewer as an animal (2026-11-04).
        for ws in (visitor, stranger):
            out = ws.presence()
            self.assertEqual(out["total"], 5)
            self.assertFalse([v for v in out["viewers"] if "name" in v or "pic" in v or "owner" in v])
            for who in ("OWNER", "WM", "GV"):
                self.assertNotIn(who, json.dumps(out))
            self.assertNotIn("owner", v)
        self.assertEqual([v.get("owner") for v in snap["viewers"] if v.get("name") == "OWNER"], [True])
        # The stranger is signed in, yet nobody (themselves included) gets their name, address or id.
        for ws in (owner, member, granted, stranger, visitor):
            self.assert_no_identity(ws.presence(), "stranger")
        # Each socket knows which entry is its own.
        self.assertEqual(stranger.presence()["me"]["id"], stranger.presence()["you"])
        self.assertIn("animal", stranger.presence()["me"])
        self.assertEqual(owner.presence()["me"]["name"], "OWNER")
        # Named first, then anonymous.
        self.assertEqual([("name" in v) for v in snap["viewers"]], [True, True, True, False, False])

    async def test_workspace_viewer_is_named_on_a_workspace_document(self):
        d = await self.mkdoc("W", content=CONTENT)
        ws = await self.open(d, "wv")
        self.assertEqual(self.names(ws.presence()), ["WV"])

    async def test_member_of_another_workspace_is_anonymous(self):
        d = await self.mkdoc("L", content=CONTENT)
        ws = await self.open(d, "wm2")
        self.assertIn("animal", ws.presence()["me"])
        self.assert_no_identity(ws.presence(), "wm2")

    async def test_forged_or_foreign_ticket_is_anonymous(self):
        d = await self.mkdoc("L", content=CONTENT)
        other = await self.mkdoc("L")
        ws = FakeSocket(None)
        self.tasks.append(asyncio.create_task(live_router.serve(ws, d["slug"])))
        await settle(2)
        ws.say(type="hello", n="tabforged01", pt=tickets.mint_presence(str(other["_id"]), self.uid["owner"]))
        await settle()
        self.assertIn("animal", ws.presence()["me"])
        ws.say(type="hello", n="tabforged01", pt="not-a-ticket")
        await settle()
        self.assertIn("animal", ws.presence()["me"])

    async def test_named_person_with_two_tabs_is_one_entry(self):
        d = await self.mkdoc("L", content=CONTENT)
        a = await self.open(d, "owner")
        b = await self.open(d, "owner")
        await settle()
        snap = b.presence()
        self.assertEqual(snap["total"], 1)
        self.assertEqual(a.presence()["you"], b.presence()["you"])

    async def test_anonymous_animal_stays_with_the_tab(self):
        d = await self.mkdoc("L", content=CONTENT)
        ws = await self.open(d, nonce="stable-tab-123")
        first = ws.presence()["me"]["animal"]
        await ws.close()
        await settle()
        again = await self.open(d, nonce="stable-tab-123")
        self.assertEqual(again.presence()["me"]["animal"], first)
        # Two tabs never share an animal on one document.
        others = [await self.open(d, nonce=f"other-tab-{i:03d}") for i in range(6)]
        animals = [v["animal"] for v in others[-1].presence()["viewers"]]
        self.assertEqual(len(animals), len(set(animals)))

    async def test_colours_differ_while_any_is_free(self):
        d = await self.mkdoc("L", content=CONTENT)
        socks = [await self.open(d, "owner")] + [await self.open(d, nonce=f"colour-tab-{i:03d}") for i in range(4)]
        await settle()
        colours = [v["color"] for v in socks[0].presence()["viewers"]]
        self.assertEqual(len(colours), 5)
        self.assertEqual(len(set(colours)), 5)
        self.assertTrue(all(0 <= c < viewers.COLORS for c in colours))
        # A second tab of a named person wears their colour.
        again = await self.open(d, "owner")
        self.assertEqual(again.presence()["me"]["color"], socks[0].presence()["me"]["color"])

    async def test_private_document_without_ticket_hears_nothing(self):
        d = await self.mkdoc("P", content=CONTENT)
        ws = await self.open(d, "owner", ticket=False)
        self.assertIsNone(ws.presence())
        self.assertIsNone(viewers.room(d["slug"]))

    # ── Show me as anonymous ──

    async def test_anonymous_me(self):
        d = await self.mkdoc("L", content=CONTENT)
        watcher = await self.open(d, "owner")   # has a relationship: sees names
        gv = await self.open(d, "gv", anon=True)
        await settle()
        self.assertIn("animal", gv.presence()["me"])
        self.assert_no_identity(watcher.presence(), "gv")
        gv.say(type="anon", v=False)
        await settle()
        self.assertEqual(gv.presence()["me"]["name"], "GV")
        self.assertIn("GV", self.names(watcher.presence()))
        gv.say(type="anon", v=True)
        await settle()
        self.assert_no_identity(watcher.presence(), "gv")

    # ── Encrypted ──

    async def test_encrypted_document_is_count_only(self):
        d = await self.mkdoc("L", content="e2e:v1:opaque", encrypted=True)
        a = await self.open(d, "owner", sec={"h": "user-content-plan"})
        b = await self.open(d)
        b.say(type="sec", sec={"h": "user-content-plan"})
        await settle()
        for ws in (a, b):
            snap = ws.presence()
            self.assertEqual(snap, {"type": "presence", "on": True, "count_only": True, "total": 2})
        self.assertTrue(all(c.sec is None for c in viewers.room(d["slug"]).conns.values()))

    # ── Sections ──

    async def test_sections_are_labelled_from_the_document(self):
        d = await self.mkdoc("L", content=CONTENT)
        a = await self.open(d, sec={"h": "user-content-install", "label": "<b>spoof</b>"})
        b = await self.open(d)
        await settle()
        self.assertEqual(a.presence()["me"]["sec"], {"h": "user-content-install", "label": "Install"})
        a.say(type="sec", sec={"h": "user-content-nope"})
        await settle()
        self.assertEqual(a.presence()["me"]["sec"]["label"], "Install")  # unknown heading ignored
        a.say(type="sec", sec={"h": "user-content-use-it"})
        await settle()
        entry = [v for v in b.presence()["viewers"] if v["id"] == a.presence()["you"]][0]
        self.assertEqual(entry["sec"], {"h": "user-content-use-it", "label": "Use it"})
        # A heading added since is found after the content changes.
        await self.db["documents"].update_one({"_id": d["_id"]}, {"$set": {"content": CONTENT + "\n## Later\n"}})
        live.publish(d["slug"], 2)
        a.say(type="sec", sec={"h": "user-content-later"})
        await settle()
        self.assertEqual(a.presence()["me"]["sec"]["label"], "Later")

    async def test_pdf_page_and_video_time(self):
        d = await self.mkdoc("L", kind="artifact")
        a = await self.open(d, sec={"p": 3})
        self.assertEqual(a.presence()["me"]["sec"], {"p": 3, "label": "Page 3"})
        a.say(type="sec", sec={"s": 151.7})
        await settle()
        self.assertEqual(a.presence()["me"]["sec"], {"s": 150, "label": "At 2:30"})
        a.say(type="sec", sec={"h": "user-content-x"})  # no headings on a file
        await settle()
        self.assertEqual(a.presence()["me"]["sec"]["label"], "At 2:30")

    async def test_away(self):
        d = await self.mkdoc("L", content=CONTENT)
        a = await self.open(d)
        b = await self.open(d)
        a.say(type="state", v="away")
        await settle()
        states = {v["id"]: v["state"] for v in b.presence()["viewers"]}
        self.assertEqual(states[a.presence()["you"]], "away")
        # Active people come first.
        self.assertEqual(b.presence()["viewers"][-1]["id"], a.presence()["you"])

    # ── The owner's switch ──

    async def test_owner_switch_off_and_on(self):
        d = await self.mkdoc("L", content=CONTENT)
        a = await self.open(d, "owner", sec={"h": "user-content-install"})
        b = await self.open(d)
        r = await self.http.put(f"/api/v1/documents/{d['slug']}/access/presence", json={"show": False},
                                headers=self.session("stranger"))
        self.assertIn(r.status_code, (403, 404))
        r = await self.http.put(f"/api/v1/documents/{d['slug']}/access/presence", json={"show": False},
                                headers=self.session("gv"))
        self.assertEqual(r.status_code, 403)
        r = await self.http.put(f"/api/v1/documents/{d['slug']}/access/presence", json={"show": False},
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 204)
        await settle()
        self.assertEqual(a.presence(), {"type": "presence", "on": False})
        self.assertEqual(b.presence(), {"type": "presence", "on": False})
        self.assertFalse((await self.doc(d["slug"]))["show_presence"])
        body = (await self.http.get(f"/api/v1/documents/{d['slug']}/access", headers=self.session("owner"))).json()
        self.assertFalse(body["show_presence"])
        self.assertFalse((await self.http.get(f"/api/v1/documents/{d['slug']}", headers=self.session("owner"))).json()["show_presence"])
        # Sections aren't taken while it's off; a newcomer hears "off" too.
        b.say(type="sec", sec={"h": "user-content-install"})
        late = await self.open(d, "gv")
        self.assertEqual(late.presence(), {"type": "presence", "on": False})
        self.assertTrue(all(c.sec is None for c in viewers.room(d["slug"]).conns.values()))
        r = await self.http.put(f"/api/v1/documents/{d['slug']}/access/presence", json={"show": True},
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 204)
        await settle()
        self.assertTrue(b.presence()["on"])
        self.assertEqual(b.presence()["total"], 3)

    # ── Narrowing ──

    async def test_access_narrowing_removes_and_renames(self):
        d = await self.mkdoc("L", content=CONTENT)
        gv = await self.open(d, "gv")
        other = await self.open(d, "owner")
        self.assertIn("GV", self.names(other.presence()))
        r = await self.http.delete(f"/api/v1/documents/{d['slug']}/access/people/{self.email['gv']}",
                                   headers=self.session("owner"))
        self.assertEqual(r.status_code, 204)
        # Everyone is listed nowhere at once; every socket is told and closed.
        self.assertIsNone(viewers.room(d["slug"]))
        await settle()
        self.assertEqual((gv.closed, other.closed), (4001, 4001))
        # Back (the link still opens it), but without the grant gv is anonymous now.
        again = await self.open(d, "gv")
        self.assertIn("animal", again.presence()["me"])
        self.assert_no_identity(again.presence(), "gv")

    async def test_recheck_drops_a_removed_member_to_anonymous(self):
        d = await self.mkdoc("L", content=CONTENT, owner="wa")
        wm = await self.open(d, "wm")
        self.assertEqual(wm.presence()["me"]["name"], "WM")
        await self.remove_member("W1", "wm")
        await viewers.recheck(self.db, now=time.monotonic() + viewers.RECHECK_S + 1)
        await settle()
        self.assertIn("animal", wm.presence()["me"])

    # ── Caps and limits ──

    async def test_listed_cap_and_total(self):
        d = await self.mkdoc("L", content=CONTENT)
        with mock.patch.object(viewers, "MAX_LISTED", 3):
            socks = [await self.open(d, ip=f"198.51.100.{i}") for i in range(5)]
            await settle()
            snap = socks[0].presence()
            self.assertEqual((len(snap["viewers"]), snap["total"]), (3, 5))
            # Off the list, a socket still knows its own entry.
            self.assertIsNotNone(socks[-1].presence()["me"])

    async def test_per_address_cap(self):
        d = await self.mkdoc("L", content=CONTENT)
        with mock.patch.object(viewers, "MAX_PER_IP", 2):
            socks = [await self.open(d, ip="198.51.100.7") for _ in range(3)]
            other = await self.open(d, ip="198.51.100.8")
            await settle()
            self.assertEqual(other.presence()["total"], 3)
            self.assertIsNone(socks[-1].presence()["me"])  # watches, isn't counted

    async def test_flood_closes_the_socket(self):
        d = await self.mkdoc("L", content=CONTENT)
        ws = await self.open(d)
        for _ in range(int(viewers.BUCKET) + viewers.DROP_LIMIT + 5):
            ws.say(type="ping")
        await settle(10)
        self.assertEqual(ws.closed, 4008)

    async def test_oversized_message_closes_the_socket(self):
        d = await self.mkdoc("L", content=CONTENT)
        ws = await self.open(d)
        ws.inbox.put_nowait(json.dumps({"type": "ping", "x": "a" * 2000}))
        await settle()
        self.assertEqual(ws.closed, 4008)

    async def test_rate_limit_drops_extra_messages(self):
        d = await self.mkdoc("L", content=CONTENT)
        a = await self.open(d)
        b = await self.open(d)
        for _ in range(int(viewers.BUCKET) + 3):
            a.say(type="ping")
        a.say(type="state", v="away")  # over the limit: ignored
        await settle()
        states = {v["id"]: v["state"] for v in b.presence()["viewers"]}
        self.assertEqual(states[a.presence()["you"]], "active")
        self.assertIsNone(a.closed)

    # ── Heartbeat ──

    async def test_heartbeat_expiry(self):
        d = await self.mkdoc("L", content=CONTENT)
        a = await self.open(d)
        b = await self.open(d)
        b.say(type="state", v="away")
        await settle()
        now = time.monotonic()
        viewers.sweep(now + viewers.TIMEOUT_S + 1)   # a: active and silent → gone; b: away, still in time
        await settle()
        self.assertEqual(b.presence()["total"], 1)
        self.assertEqual(b.presence()["viewers"][0]["id"], b.presence()["you"])
        viewers.sweep(now + viewers.AWAY_TIMEOUT_S + 1)
        await settle()
        self.assertEqual(a.presence()["total"], 0)
        self.assertIsNone(a.closed)  # the socket itself stays for live updates
        a.say(type="ping")
        await settle()
        self.assertEqual(b.presence()["total"], 1)

    async def test_leaving_updates_everyone(self):
        d = await self.mkdoc("L", content=CONTENT)
        a = await self.open(d)
        b = await self.open(d)
        self.assertEqual(a.presence()["total"], 2)
        b.inbox.put_nowait(None)  # the tab closed
        await settle()
        self.assertEqual(a.presence()["total"], 1)
        a.inbox.put_nowait(None)
        await settle()
        self.assertIsNone(viewers.room(d["slug"]))

    async def test_no_hello_no_presence(self):
        d = await self.mkdoc("L", content=CONTENT)
        quiet = await self.open(d, hello=False)
        loud = await self.open(d)
        await settle()
        self.assertIsNone(quiet.presence())
        self.assertEqual(loud.presence()["total"], 1)

    # ── Who is editing ──

    async def test_editor_is_named_only_for_people_with_a_relationship(self):
        d = await self.mkdoc("L", content=CONTENT)   # link, filed in W1, granted to gv
        owner = await self.open(d, "owner")
        member = await self.open(d, "wm")
        stranger = await self.open(d, "stranger")
        visitor = await self.open(d)
        viewers.set_editor(d["slug"], self.uid["owner"], 60)
        await settle()
        for ws in (owner, member):
            ed = [v for v in ws.presence()["viewers"] if v.get("editing")]
            self.assertEqual([v.get("name") for v in ed], ["OWNER"])
        for ws in (stranger, visitor):
            snap = ws.presence()
            ed = [v for v in snap["viewers"] if v.get("editing")]
            self.assertEqual(len(ed), 1)
            self.assertIn(ed[0]["animal"], viewers.ANIMALS)
            self.assertNotIn("name", ed[0])
            self.assertNotIn("owner", ed[0])
            self.assertNotIn("pic", ed[0])
            self.assertNotIn("OWNER", json.dumps(snap))
            # Nobody is named for them, the member who isn't editing included (2026-11-04).
            self.assertNotIn("WM", self.names(snap))
        # The editor's own entry is theirs.
        self.assertEqual(owner.presence()["me"]["name"], "OWNER")
        self.assertTrue(owner.presence()["me"]["editing"])
        # Released: nobody is editing; the owner is named again for the document's people, and
        # stays an animal for outsiders (2026-11-04: names are only for people with access).
        viewers.set_editor(d["slug"], None, 0)
        await settle()
        for ws in (owner, member, stranger, visitor):
            self.assertFalse(any(v.get("editing") for v in ws.presence()["viewers"]))
        self.assertIn("OWNER", self.names(member.presence()))
        self.assertNotIn("OWNER", self.names(visitor.presence()))

    async def test_anonymous_minded_editor_is_an_animal_with_the_flag(self):
        d = await self.mkdoc("L", content=CONTENT)
        editor = await self.open(d, "owner", anon=True)
        member = await self.open(d, "wm")
        viewers.set_editor(d["slug"], self.uid["owner"], 60)
        await settle()
        ed = [v for v in member.presence()["viewers"] if v.get("editing")]
        self.assertEqual(len(ed), 1)
        self.assertNotIn("name", ed[0])
        self.assertIn(ed[0]["animal"], viewers.ANIMALS)
        self.assertTrue(editor.presence()["me"]["editing"])

    async def test_observe_names_the_editor_only_for_related_callers(self):
        d = await self.mkdoc("L", content=CONTENT)
        await self.open(d, "owner")
        viewers.set_editor(d["slug"], self.uid["owner"], 60)
        await settle()
        args = dict(enabled=True, encrypted=False)
        inside = viewers.observe(d["slug"], str(d["_id"]), user_id=self.uid["wm"], related=True, **args)
        outside = viewers.observe(d["slug"], str(d["_id"]), user_id=self.uid["stranger"], related=False, **args)
        self.assertEqual([v.get("name") for v in inside["viewers"] if v.get("editing")], ["OWNER"])
        ed = [v for v in outside["viewers"] if v.get("editing")]
        self.assertEqual(len(ed), 1)
        self.assertNotIn("name", ed[0])
        self.assertNotIn("OWNER", json.dumps(outside))
        # The editor asking about themselves still sees their own entry.
        me = viewers.observe(d["slug"], str(d["_id"]), user_id=self.uid["owner"], related=False, **args)
        self.assertEqual([v.get("name") for v in me["viewers"] if v.get("editing")], ["OWNER"])
