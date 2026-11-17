"""A meeting's recording on the workspace's own domain (2026-11-17).

GET /api/v1/meetings/{id}/recording is on the tenant allowlist (routers/auth.py): read-only, decided
by meetings.for_read with the pinned actor, so a W1 domain token can't play a W2 meeting even for
someone who is a member of both. The meeting page's read carries ``meeting.has_recording`` so the
page shows its Recording button without another call: false when signed out or when the reader
can't read the meeting.
"""

from __future__ import annotations

from tests._access_env import HOSTS, AccessWorld, now  # noqa: F401  (pins settings first)

from bson import ObjectId

from app.limiter import limiter


class TenantRecording(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        limiter.enabled = False
        self.addCleanup(setattr, limiter, "enabled", True)
        # wm is a member of W1 and W2: their W1 domain token must still never reach W2.
        await self.add_member("W2", "wm", "member")
        self.m1, self.p1 = await self.meeting("W1", owner="owner")
        self.m2, self.p2 = await self.meeting("W2", owner="wm2")

    async def meeting(self, ws_key: str, *, owner: str, state: str = "W") -> tuple[str, dict]:
        mid = ObjectId()
        page = await self.mkdoc(state, owner=owner, ws=ws_key, editor="blocks", meeting_id=str(mid),
                                meeting_role="page")
        await self.db["meetings"].insert_one({
            "_id": mid, "workspace_id": self.ws[ws_key], "doc_id": str(page["_id"]), "title": "Standup",
            "created_at": now(), "updated_at": now(),
            "recording": {"key": f"art/zoom/{self.ws[ws_key]}/{mid}.mp4", "size": 1234, "duration_s": 60}})
        return str(mid), page

    async def play(self, mid: str, headers: dict):
        return await self.http.get(f"/api/v1/meetings/{mid}/recording", headers=headers)

    async def test_tenant_reader_with_access_gets_the_player(self):
        for who in ("wm", "wv", "owner", "gv"):
            r = await self.play(self.m1, self.tenant(who, "W1"))
            self.assertEqual(r.status_code, 200, (who, r.text))
            self.assertIn("player_url", r.json())

    async def test_other_workspace_recording_is_a_404_through_this_domain(self):
        # wm can play W2's meeting with their markdrop.in session...
        self.assertEqual((await self.play(self.m2, self.session("wm"))).status_code, 200)
        # ...but never through W1's domain: the same 404 as a meeting that doesn't exist.
        r = await self.play(self.m2, self.tenant("wm", "W1"))
        missing = await self.play(str(ObjectId()), self.tenant("wm", "W1"))
        self.assertEqual((r.status_code, r.content), (missing.status_code, missing.content))
        self.assertEqual(r.status_code, 404)

    async def test_reader_without_access_gets_404(self):
        self.assertEqual((await self.play(self.m1, self.tenant("stranger", "W1"))).status_code, 404)
        self.assertEqual((await self.play(self.m1, self.session("stranger"))).status_code, 404)
        # A private meeting page: a workspace member it wasn't shared with can't play it.
        m3, _ = await self.meeting("W1", owner="owner", state="P")
        self.assertEqual((await self.play(m3, self.tenant("wm", "W1"))).status_code, 404)

    async def test_wrong_origin_and_signed_out_are_refused(self):
        r = await self.play(self.m1, self.tenant("wm", "W1", origin="https://evil.test"))
        self.assertEqual(r.status_code, 401)
        r = await self.play(self.m1, self.tenant("wm", "W1", origin=f"https://{HOSTS['W2']}"))
        self.assertEqual(r.status_code, 401)
        self.assertEqual((await self.play(self.m1, {})).status_code, 401)

    async def test_page_read_says_whether_there_is_a_recording(self):
        async def flag(slug: str, headers: dict):
            r = await self.http.get(f"/api/v1/documents/{slug}", headers=headers)
            self.assertEqual(r.status_code, 200, r.text)
            return (r.json().get("meeting") or {}).get("has_recording")

        self.assertIs(await flag(self.p1["slug"], self.tenant("wm", "W1")), True)
        self.assertIs(await flag(self.p1["slug"], self.session("wm")), True)
        # A link-readable meeting page read signed out: no button (playing needs sign-in).
        m4, p4 = await self.meeting("W1", owner="owner", state="L")
        self.assertIs(await flag(p4["slug"], {}), False)
        self.assertIs(await flag(p4["slug"], self.tenant("wm", "W1")), True)
        # No recording kept: no button.
        await self.db["meetings"].update_one({"_id": ObjectId(self.m1)}, {"$unset": {"recording": ""}})
        self.assertIs(await flag(self.p1["slug"], self.tenant("wm", "W1")), False)
        self.assertEqual((await self.play(self.m1, self.tenant("wm", "W1"))).status_code, 404)
