"""Meetings auto-import v2 (.work/meetings/AUTO-V2.md): who organized a meeting (never simply the
importer), 1:1s and two-person calls restricted to their attendees on every import path, one placement
function, "Paste a Google Drive link" (Google's public export, else the person's own Google Meet script
fetches it), the script's run reports and its fetch queue, MCP ``import_meeting`` with ``drive_url``,
and the one-off organizer repair. The model is always the fake client; Google is a mock transport.
"""

from __future__ import annotations

import unittest
from unittest import mock

import httpx

from tests.test_meetings_auto import FID_N, FID_T, NOTES, TRANSCRIPT, AutoWorld, fixture  # noqa: F401

from app.services import meeting_links, meeting_parse as mp, meeting_place, meetings

THREE = "Ada Lovelace: Release on Friday.\nBo Chen: Fine.\nRavi Kumar: Ok."
TWO = "Ada Lovelace: Can we talk about your goals?\nBo Chen: Sure."
DOC_ID = "1PublicDocAbcdefghijklmnopqrs"


class Pure(unittest.TestCase):
    def test_links(self):
        for url in (f"https://docs.google.com/document/d/{DOC_ID}/edit?usp=sharing",
                    f"docs.google.com/document/u/1/d/{DOC_ID}/view",
                    f"https://drive.google.com/file/d/{DOC_ID}/view?usp=drive_link",
                    f"https://drive.google.com/open?id={DOC_ID}", DOC_ID):
            self.assertEqual(meeting_links.file_id_of(url), DOC_ID, url)
        for url in (f"https://evil.example/document/d/{DOC_ID}/edit", f"https://docs.google.com.evil.test/document/d/{DOC_ID}",
                    "javascript:alert(1)", "https://docs.google.com/document/d/short/edit", "", "x" * 3000,
                    f"ftp://docs.google.com/document/d/{DOC_ID}"):
            self.assertIsNone(meeting_links.file_id_of(url), url)

    def test_organizer_in_text(self):
        self.assertEqual(mp.organizer_in("# Sync\nOrganizer: Gautam Rao <gautam@acme.test>\nAda: hi"),
                         {"name": "Gautam Rao", "email": "gautam@acme.test"})
        self.assertEqual(mp.organizer_in("**Hosted by** Priya Sharma\n"), {"name": "Priya Sharma", "email": None})
        self.assertIsNone(mp.organizer_in(fixture("gemini_notes.txt")))     # Gemini doesn't say who organized
        self.assertIsNone(mp.organizer_in("Ada Lovelace: the host said hi"))

    def test_small_calls(self):
        self.assertTrue(meetings.auto_restricts([{"name": "Ada"}, {"name": "Bo"}]))
        self.assertTrue(meetings.auto_restricts([{"name": "Ada"}]))
        self.assertFalse(meetings.auto_restricts([]))                       # nobody named: the team's
        self.assertFalse(meetings.auto_restricts([{"name": "Ada"}, {"name": "Bo"}, {"name": "Ravi"}]))
        self.assertFalse(meetings.auto_restricts([{"name": "Ada"}, {"name": "Bo"}], {"name": "Gautam"}))


def transport(routes: dict[str, httpx.Response]) -> httpx.AsyncClient:
    seen: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(str(req.url))
        for prefix, resp in routes.items():
            if str(req.url).startswith(prefix):
                return resp
        return httpx.Response(404)

    c = httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)
    c.seen = seen  # type: ignore[attr-defined]
    return c


EXPORT = f"https://docs.google.com/document/d/{DOC_ID}/export?format=txt"
UC = f"https://drive.google.com/uc?export=download&id={DOC_ID}"


class PublicFetch(unittest.IsolatedAsyncioTestCase):
    async def test_public_doc_through_googles_hosts(self):
        c = transport({EXPORT: httpx.Response(307, headers={"location": "https://doc-0s-docs.googleusercontent.com/export/x"}),
                       "https://doc-0s-docs.googleusercontent.com/": httpx.Response(200, text="﻿Ada: hi\nBo: yo\n", headers={
                           "content-type": "text/plain; charset=utf-8",
                           "content-disposition": "attachment; filename=\"x.txt\"; filename*=UTF-8''Weekly%20sync%20-%20Transcript.txt"})})
        title, text = await meeting_links.fetch_public(DOC_ID, client=c)
        self.assertEqual((title, text), ("Weekly sync - Transcript", "Ada: hi\nBo: yo\n"))

    async def test_not_public_or_elsewhere(self):
        for loc in ("https://accounts.google.com/ServiceLogin?continue=x", "https://evil.example/steal",
                    "http://doc-0s-docs.googleusercontent.com/plain-http"):
            c = transport({EXPORT: httpx.Response(302, headers={"location": loc}), UC: httpx.Response(302, headers={"location": loc})})
            with self.assertRaises(meeting_links.NotPublic):
                await meeting_links.fetch_public(DOC_ID, client=c)
            self.assertFalse(any("evil" in u or u.startswith("http://") for u in c.seen), c.seen)
        # A sign-in page served directly (HTML) isn't the file.
        c = transport({EXPORT: httpx.Response(200, text="<html>Sign in</html>", headers={"content-type": "text/html"})})
        with self.assertRaises(meeting_links.NotPublic):
            await meeting_links.fetch_public(DOC_ID, client=c)
        # Too many hops stop.
        c = transport({EXPORT: httpx.Response(302, headers={"location": EXPORT}), UC: httpx.Response(302, headers={"location": UC})})
        with self.assertRaises(meeting_links.NotPublic):
            await meeting_links.fetch_public(DOC_ID, client=c)

    async def test_google_unreachable_is_not_public(self):
        def boom(req):
            raise httpx.ConnectTimeout("slow")

        c = httpx.AsyncClient(transport=httpx.MockTransport(boom))
        with self.assertRaises(meeting_links.NotPublic):
            await meeting_links.fetch_public(DOC_ID, client=c)

    async def test_size_and_type_limits(self):
        big = "A: " + "x" * (meeting_links.MAX_BYTES + 10)
        c = transport({EXPORT: httpx.Response(200, text=big, headers={"content-type": "text/plain"})})
        with self.assertRaises(ValueError):
            await meeting_links.fetch_public(DOC_ID, client=c)
        c = transport({EXPORT: httpx.Response(200, content=b"%PDF", headers={"content-type": "application/pdf"})})
        with self.assertRaises(ValueError):
            await meeting_links.fetch_public(DOC_ID, client=c)


class Visibility(AutoWorld):
    async def test_two_person_calls_are_restricted_on_every_path(self):
        # Web import.
        m = await self.imported(sources=[{"name": "1:1", "text": TWO}])
        self.assertTrue(m["restricted"])
        self.assertTrue(m["auto_restricted"])
        page = await self.doc(m["slug"])
        self.assertEqual(page["access_level"], "private")
        self.assertEqual((await self.http.get(f"/api/v1/meetings/{m['id']}", headers=self.session("wa"))).status_code, 404)
        # Changeable per meeting.
        r = await self.http.patch(f"/api/v1/meetings/{m['id']}", headers=self.session("owner"), json={"restricted": False})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self.http.get(f"/api/v1/meetings/{m['id']}", headers=self.session("wa"))).status_code, 200)
        # Three people: the team's.
        m3 = await self.imported(sources=[{"name": "Team sync", "text": THREE}])
        self.assertFalse(m3["restricted"])
        # The script's inbox, a shared-in Doc.
        tok = (await self.connect())["token"]
        r = await self.deliver(tok, file_id="1OneOnOneSharedXyzwvuts", title="Ada / Bo - 2026/11/04 10:00 IST - Transcript",
                               text=TWO, owner={"name": "Bo Chen", "email": self.email["wm"], "me": False})
        self.assertEqual(r.status_code, 200, r.text)
        row = await self.db[meetings.COLL].find_one({"_id": __import__("bson").ObjectId(r.json()["meeting_id"])})
        self.assertTrue(row["restricted"])
        # MCP.
        mt = await self.mcp_token("owner")
        code, res = await self.mcp_call(mt, "import_meeting", {"workspace": self.W, "text": TWO, "file_name": "Quick chat.txt"})
        self.assertTrue(res["structuredContent"]["meetings"][0]["restricted"])


class Organizer(AutoWorld):
    async def test_drive_owner_is_the_organizer(self):
        tok = (await self.connect())["token"]
        # Priya organized it (her Drive); Ada's script imported it.
        r = await self.deliver(tok, owner={"name": "Priya S.", "email": self.email["wa"], "me": False})
        self.assertEqual(r.status_code, 200, r.text)
        mid = r.json()["meeting_id"]
        m = (await self.http.get(f"/api/v1/meetings/{mid}", headers=self.session("owner"))).json()
        self.assertEqual((m["organizer"]["user_id"], m["organizer"]["name"], m["organizer"]["from"]),
                         (self.uid["wa"], "Priya Sharma", "drive"))
        self.assertEqual(m["imported_by"]["user_id"], self.uid["owner"])
        page = await self.doc(m["slug"])
        self.assertIn(f'organizer: "{self.uid["wa"]}"', page["content"])

    async def test_a_non_member_organizer_is_a_name(self):
        tok = (await self.connect())["token"]
        r = await self.deliver(tok, owner={"name": "Gautam Rao", "email": "gautam@elsewhere.test", "me": False})
        m = (await self.http.get(f"/api/v1/meetings/{r.json()['meeting_id']}", headers=self.session("owner"))).json()
        self.assertEqual((m["organizer"]["name"], m["organizer"]["user_id"]), ("Gautam Rao", None))
        self.assertNotIn("organizer:", (await self.doc(m["slug"]))["content"])

    async def test_upload_reads_it_from_the_text_or_leaves_it_unknown(self):
        m = await self.imported(sources=[{"name": "Planning", "text": "Organizer: Bo Chen <" + self.email["wm"] + ">\n" + THREE}])
        self.assertEqual(m["organizer"]["user_id"], self.uid["wm"])
        self.assertEqual(m["organizer"]["from"], "content")
        m = await self.imported(sources=[{"name": "Planning 2", "text": THREE}])
        self.assertIsNone(m["organizer"])

    async def test_the_other_half_fills_a_missing_organizer(self):
        m = await self.imported(sources=[{"name": TRANSCRIPT, "text": fixture("google_meet_transcript.txt")}])
        self.assertIsNone(m["organizer"])
        tok = (await self.connect())["token"]
        r = await self.deliver(tok, file_id=FID_N, title=NOTES, text=fixture("gemini_notes.txt"), kind="notes",
                               owner={"name": "Bo Chen", "email": self.email["wm"], "me": False})
        self.assertEqual(r.json()["status"], "attached")
        row = await self.db[meetings.COLL].find_one({"_id": __import__("bson").ObjectId(m["id"])})
        self.assertEqual(row["organizer"]["user_id"], self.uid["wm"])

    async def test_repair_existing(self):
        tok = (await self.connect())["token"]
        r = await self.deliver(tok, owner={"name": "Priya", "email": self.email["wa"], "me": False})
        mid = __import__("bson").ObjectId(r.json()["meeting_id"])
        m2 = await self.imported(sources=[{"name": "Old upload", "text": THREE}])
        # As imported before v2: no organizer, the importer in the page's Organizer property.
        from app.services import page_db

        for oid in (mid, __import__("bson").ObjectId(m2["id"])):
            row = await self.db[meetings.COLL].find_one({"_id": oid})
            await self.db[meetings.COLL].update_one({"_id": oid}, {"$unset": {"organizer": 1, "imported_by": 1}})
            page = await meetings.page_of(self.db, row)
            await self.db["documents"].update_one({"_id": page["_id"]}, {"$set": {
                "content": page_db.write_values(page["content"], {"organizer": self.uid["owner"]})}})
        dry = await meetings.repair_organizers(self.db)
        self.assertEqual((dry["checked"], dry["from_drive"], dry["unknown"], dry["props_fixed"]), (2, 1, 1, 0))
        got = await meetings.repair_organizers(self.db, apply=True)
        self.assertEqual((got["props_fixed"], got["errors"]), (2, 0))
        row = await self.db[meetings.COLL].find_one({"_id": mid})
        self.assertEqual(row["organizer"]["user_id"], self.uid["wa"])
        page = await meetings.page_of(self.db, row)
        self.assertEqual(page_db.read_values(page["content"]).get("organizer"), self.uid["wa"])
        page2 = await self.doc(m2["slug"])
        self.assertNotIn("organizer", page_db.read_values(page2["content"]))
        self.assertEqual((await meetings.repair_organizers(self.db))["checked"], 0)


class Placement(AutoWorld):
    async def test_every_path_asks_place_meeting(self):
        calls = []
        real = meeting_place.place_meeting

        async def spy(db, ws, meeting):
            calls.append((ws, meeting.get("title"), meeting.get("via")))
            return await real(db, ws, meeting)

        with mock.patch.object(meeting_place, "place_meeting", spy):
            await self.imported(sources=[{"name": "Team sync", "text": THREE}])
            tok = (await self.connect())["token"]
            await self.deliver(tok)
            mt = await self.mcp_token("owner")
            await self.mcp_call(mt, "import_meeting", {"workspace": self.W, "text": THREE, "file_name": "Retro.txt"})
        self.assertEqual([c[2] for c in calls], ["web", "inbox", "mcp"])
        folder = await meetings.folder_of(self.db, self.W)
        for row in await self.rows():
            self.assertEqual(row["folder_id"], str(folder["_id"]))


class Links(AutoWorld):
    async def link(self, *urls, who="owner", **body):
        return await self.http.post("/api/v1/meetings/import-link", headers=self.session(who),
                                    json={"workspace": self.W, "urls": list(urls), "wait": True, **body})

    async def test_public_link_imports(self):
        async def public(fid, client=None):
            return "Weekly product sync (2026-11-04 10:00 GMT+05:30) - Transcript", fixture("google_meet_transcript.txt")

        with mock.patch.object(meeting_links, "fetch_public", public):
            r = await self.link(f"https://docs.google.com/document/d/{DOC_ID}/edit")
            self.assertEqual(r.status_code, 200, r.text)
            res = r.json()["results"][0]
            self.assertEqual((res["status"], res["file_id"]), ("imported", DOC_ID))
            self.assertEqual(res["meeting"]["title"], "Weekly product sync")
            self.assertEqual(res["meeting"]["sources"][0]["url"], f"https://docs.google.com/document/d/{DOC_ID}/edit")
            # The same link again: that meeting.
            r = await self.link(f"https://drive.google.com/open?id={DOC_ID}")
            self.assertEqual(r.json()["results"][0]["status"], "duplicate")
        # Not Google's: refused per link; a viewer can't import.
        r = await self.link("https://evil.example/document/d/1x/edit")
        self.assertEqual(r.json()["results"][0]["status"], "error")
        r = await self.link(f"https://docs.google.com/document/d/{DOC_ID}/edit", who="wv")
        self.assertEqual(r.status_code, 403)

    async def test_private_link_is_queued_for_my_script(self):
        async def private(fid, client=None):
            raise meeting_links.NotPublic(fid)

        with mock.patch.object(meeting_links, "fetch_public", private):
            # Not connected: what to do.
            r = await self.link(f"https://docs.google.com/document/d/{DOC_ID}/edit")
            res = r.json()["results"][0]
            self.assertEqual(res["status"], "needs_access")
            self.assertIn("Connect Google Meet", res["message"])
            # Connected here: queued for my script.
            tok = (await self.connect())["token"]
            r = await self.link(f"https://docs.google.com/document/d/{DOC_ID}/edit")
            self.assertEqual(r.json()["results"][0]["status"], "queued")
        h = {"Authorization": f"Bearer {tok}"}
        r = await self.http.post("/api/v1/meetings/inbox/status", headers=h, json={"phase": "start", "version": 2})
        self.assertEqual(r.json()["queue"], [{"file_id": DOC_ID}])
        # A teammate's script never gets my queue.
        other = (await self.connect(who="wm"))["token"]
        r = await self.http.post("/api/v1/meetings/inbox/status", headers={"Authorization": f"Bearer {other}"},
                                 json={"phase": "start", "version": 2})
        self.assertEqual(r.json()["queue"], [])
        # The script sends it (requested): imported, and the request is done.
        r = await self.deliver(tok, file_id=DOC_ID, requested=True, version=2)
        self.assertEqual(r.json()["status"], "imported")
        reqs = (await self.http.get(f"/api/v1/meetings/import-link?workspace={self.W}", headers=self.session("owner"))).json()["requests"]
        self.assertEqual((reqs[0]["state"], reqs[0]["meeting_id"]), ("sent", r.json()["meeting_id"]))
        r = await self.http.post("/api/v1/meetings/inbox/status", headers=h, json={"phase": "start", "version": 2})
        self.assertEqual(r.json()["queue"], [])

    async def test_queue_failures_are_reported(self):
        tok = (await self.connect())["token"]
        rec = await self.db["api_tokens"].find_one({"scope": "meetings:import"})
        await meeting_links.queue(self.db, rec, self.uid["owner"], self.W, DOC_ID)
        await meeting_links.queue(self.db, rec, self.uid["owner"], self.W, "1AnotherDocAbcdefghijklmnop")
        h = {"Authorization": f"Bearer {tok}"}
        r = await self.http.post("/api/v1/meetings/inbox/status", headers=h, json={
            "phase": "done", "version": 2, "queue_failed": [{"file_id": DOC_ID, "error": "not_found"},
                                                            {"file_id": "1AnotherDocAbcdefghijklmnop", "error": "retry"}]})
        self.assertEqual(r.status_code, 200, r.text)
        reqs = {q["file_id"]: q for q in await meeting_links.requests_of(self.db, self.uid["owner"], self.W)}
        self.assertEqual((reqs[DOC_ID]["state"], reqs[DOC_ID]["error"]), ("failed", "not_found"))
        self.assertEqual(reqs["1AnotherDocAbcdefghijklmnop"]["state"], "queued")

    async def test_requested_old_call_is_quiet(self):
        tok = (await self.connect())["token"]
        with mock.patch("app.services.meetings.import_meetings", wraps=meetings.import_meetings) as spy:
            await self.deliver(tok, requested=True)          # created 2026-11-04: more than a day ago
            self.assertFalse(spy.call_args.kwargs["notify"])

    async def test_mcp_drive_url(self):
        mt = await self.mcp_token("owner")

        async def public(fid, client=None):
            return "Retro - Transcript", THREE

        with mock.patch.object(meeting_links, "fetch_public", public):
            code, res = await self.mcp_call(mt, "import_meeting", {"workspace": self.W, "drive_url": f"https://docs.google.com/document/d/{DOC_ID}/edit"})
        self.assertFalse(res.get("isError"), res)
        self.assertEqual(res["structuredContent"]["meetings"][0]["status"], "imported")

        async def private(fid, client=None):
            raise meeting_links.NotPublic(fid)

        with mock.patch.object(meeting_links, "fetch_public", private):
            code, res = await self.mcp_call(mt, "import_meeting", {"workspace": self.W, "drive_url": "https://docs.google.com/document/d/1OtherDocAbcdefghijklmnopq/edit"})
        self.assertEqual(res["structuredContent"]["link"]["status"], "needs_access")
        code, res = await self.mcp_call(mt, "import_meeting", {"workspace": self.W, "drive_url": "https://evil.example/x"})
        self.assertTrue(res.get("isError"))


if __name__ == "__main__":
    unittest.main()
