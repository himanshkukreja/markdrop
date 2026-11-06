"""Meetings auto-import: "Connect Google Meet" (services/meetings_inbox.py; .work/meetings/AUTO.md).

The scoped ``meetings:import`` token (works on the inbox and nowhere else, pinned to one workspace,
revocable), the inbox (idempotent on the Drive file id, size limits, rate limit by token), pairing
of Google's notes and the transcript arriving in separate runs, no duplicates with manual imports,
MCP (``meetings_connection``, ``list_meetings`` filters, ``import_meeting`` dedupe), and the
generated Apps Script itself: valid JavaScript with the endpoint and token filled in, run under
node against fake Apps Script services. The model is always the fake client.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from tests.test_meetings import MeetingsWorld, fixture  # noqa: F401  (pins settings first)

from bson import ObjectId

from app.services import meeting_parse as mp
from app.services import meetings, meetings_inbox

HERE = Path(__file__).parent
NODE = shutil.which("node")
TRANSCRIPT = "Weekly product sync (2026-11-04 10:00 GMT+05:30) - Transcript"
NOTES = "Weekly product sync - 2026/11/04 10:00 GMT+05:30 - Notes by Gemini"
FID_T = "1TranscriptAbcdefghijklmnop"
FID_N = "1NotesAbcdefghijklmnopqrstu"


class AutoWorld(MeetingsWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await meetings_inbox.ensure_indexes(self.db)

    async def settle(self):
        for _ in range(50):
            tasks = [t for t in list(meetings._bg) if not t.done()]
            if not tasks:
                return
            await asyncio.wait(tasks, timeout=10)

    async def connect(self, who="owner", ws=None, **body) -> dict:
        r = await self.http.post("/api/v1/meetings/connection", headers=self.session(who),
                                 json={"workspace": ws or self.W, **body})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def deliver(self, token: str, *, file_id=FID_T, title=TRANSCRIPT, text=None, kind="transcript", **extra):
        body = {"source": "google-meet-script", "file_id": file_id, "title": title, "created": "2026-11-04T05:20:00.000Z",
                "kind_hint": kind, "text": fixture("google_meet_transcript.txt") if text is None else text,
                "doc_url": f"https://docs.google.com/document/d/{file_id}/edit", **extra}
        r = await self.http.post("/api/v1/meetings/inbox", headers={"Authorization": f"Bearer {token}"}, json=body)
        await self.settle()
        return r

    async def rows(self) -> list[dict]:
        return await self.db[meetings.COLL].find({"workspace_id": self.W}).to_list(50)


class Connect(AutoWorld):
    async def test_connect_shows_the_script_once(self):
        out = await self.connect()
        tok = out["token"]
        self.assertTrue(tok.startswith("mdk_"))
        self.assertEqual(out["endpoint"], meetings_inbox.endpoint())
        self.assertTrue(out["endpoint"].endswith("/api/v1/meetings/inbox"))
        self.assertIn(f"var MARKDROP_TOKEN = {json.dumps(tok)};", out["script"])
        self.assertIn(f"var MARKDROP_ENDPOINT = {json.dumps(out['endpoint'])};", out["script"])
        self.assertIn('"Acme"', out["script"])
        man = json.loads(out["manifest"])
        self.assertEqual(sorted(man["oauthScopes"]), [
            "https://www.googleapis.com/auth/drive.readonly",
            "https://www.googleapis.com/auth/script.external_request",
            "https://www.googleapis.com/auth/script.scriptapp"])
        c = out["connection"]
        self.assertEqual((c["workspace_id"], c["workspace_name"], c["imported"], c["mine"]), (self.W, "Acme", 0, True))
        self.assertNotIn("token", json.dumps(c).replace("prefix", ""))
        # The status never carries the token or the script again.
        r = await self.http.get(f"/api/v1/meetings/connection?workspace={self.W}", headers=self.session("owner"))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["connection"]["id"], c["id"])
        self.assertNotIn(tok, r.text)
        self.assertNotIn("script", r.json())
        # Not a personal token.
        r = await self.http.get("/api/v1/me/tokens", headers=self.session("owner"))
        self.assertEqual(r.json()["tokens"], [])
        # A teammate sees who sends meetings to the workspace.
        r = await self.http.get(f"/api/v1/meetings/connection?workspace={self.W}", headers=self.session("wm"))
        self.assertIsNone(r.json()["connection"])
        self.assertEqual([o["connected_by"]["id"] for o in r.json()["others"]], [self.uid["owner"]])

    async def test_who_can_connect(self):
        r = await self.http.post("/api/v1/meetings/connection", headers=self.session("wv"), json={"workspace": self.W})
        self.assertEqual(r.status_code, 403)
        r = await self.http.post("/api/v1/meetings/connection", headers=self.session("stranger"), json={"workspace": self.W})
        self.assertEqual(r.status_code, 404)
        r = await self.http.post("/api/v1/meetings/connection", json={"workspace": self.W})
        self.assertEqual(r.status_code, 401)

    async def test_reconnect_replaces_and_disconnect_revokes(self):
        old = (await self.connect())["token"]
        new = (await self.connect(restricted=True))["token"]
        self.assertEqual(await self.db["api_tokens"].count_documents({"scope": "meetings:import"}), 1)
        r = await self.deliver(old)
        self.assertEqual(r.status_code, 401)
        r = await self.deliver(new)
        self.assertEqual(r.status_code, 200, r.text)
        r = await self.http.delete("/api/v1/meetings/connection", headers=self.session("owner"))
        self.assertEqual(r.json(), {"disconnected": True})
        r = await self.deliver(new, file_id=FID_N, title=NOTES, text=fixture("gemini_notes.txt"))
        self.assertEqual(r.status_code, 401)
        r = await self.http.get("/api/v1/meetings/connection", headers=self.session("owner"))
        self.assertIsNone(r.json()["connection"])


class ScriptStatus(AutoWorld):
    async def status(self, token: str, **body):
        return await self.http.post("/api/v1/meetings/inbox/status", headers={"Authorization": f"Bearer {token}"}, json=body)

    async def test_runs_are_reported_and_shown(self):
        out = await self.connect(include_shared=False)
        self.assertIn("var INCLUDE_SHARED = false;", out["script"])
        self.assertIn("var SCRIPT_VERSION = 4;", out["script"])
        c = out["connection"]
        # Nothing reported yet: it was just given v4, nothing to update.
        self.assertEqual((c["script"], c["script_version"], c["latest_script_version"], c["needs_update"]), (None, 4, 4, False))
        self.assertEqual(c["check_now"], {"ready": False, "last_at": None, "last": None})
        self.assertFalse(c["include_shared"])
        tok = out["token"]
        # A connection made before v2 (never given a version, never reports) is told to get the new script.
        await self.db["api_tokens"].update_one({"scope": "meetings:import"}, {"$unset": {"script_given": 1}})
        r = await self.http.get("/api/v1/meetings/connection", headers=self.session("owner"))
        self.assertEqual((r.json()["connection"]["script_version"], r.json()["connection"]["needs_update"]), (1, True))
        # A v2 script reports: it is told a newer one exists (and the page says so).
        r = await self.status(tok, phase="start", version=2, mode="run", include_shared=False)
        self.assertEqual(r.status_code, 200, r.text)
        key = r.json().get("check_key") or ""
        self.assertEqual(r.json(), {"ok": True, "latest_version": 4, "queue": [], "check_key": key})
        self.assertGreaterEqual(len(key), 30)
        r = await self.http.get("/api/v1/meetings/connection", headers=self.session("owner"))
        self.assertEqual((r.json()["connection"]["script_version"], r.json()["connection"]["needs_update"]), (2, True))
        r = await self.status(tok, phase="done", version=4, mode="run", include_shared=False, found=0, sent=0,
                              results={"imported": 0}, skipped={"not_yours": 14, "title": 3, "bogus": 9},
                              errors=[{"title": "X - Transcript", "error": "Could not read it"}], search="drive-v3")
        self.assertEqual(r.status_code, 200, r.text)
        r = await self.http.get(f"/api/v1/meetings/connection?workspace={self.W}", headers=self.session("owner"))
        c = r.json()["connection"]
        self.assertFalse(c["needs_update"])
        sc = c["script"]
        self.assertEqual((sc["version"], sc["found"], sc["sent"], sc["mode"]), (4, 0, 0, "run"))
        # Nothing waits, and it didn't say whether it searches shared drives.
        self.assertEqual((sc["remaining"], sc["shared_drives"], sc["drive_api_url"]), (0, None, None))
        self.assertEqual(sc["skipped"], {"already_sent": 0, "too_old": 0, "not_yours": 14, "title": 3, "writing": 0, "not_ready": 0})
        self.assertEqual(sc["errors"], [{"title": "X - Transcript", "error": "Could not read it"}])
        self.assertTrue(sc["ran_at"] and sc["started_at"])
        # A teammate sees the same line on the owner's connection.
        r = await self.http.get(f"/api/v1/meetings/connection?workspace={self.W}", headers=self.session("wm"))
        self.assertEqual(r.json()["others"][0]["script"]["skipped"]["not_yours"], 14)
        # Only the script's own token; a revoked one is told it's disconnected.
        r = await self.http.post("/api/v1/meetings/inbox/status", headers=self.session("owner"), json={"phase": "start"})
        self.assertEqual(r.status_code, 401)
        await self.http.delete("/api/v1/meetings/connection", headers=self.session("owner"))
        r = await self.status(tok, phase="start", version=2)
        self.assertEqual(r.status_code, 401)

    async def test_v3_run_reports_what_waits_and_shared_drives(self):
        tok = (await self.connect())["token"]
        r = await self.status(tok, phase="done", version=3, mode="run", found=79, sent=60, remaining=19,
                              shared_drives="off", drive_project="1034426400429", search="driveapp")
        self.assertEqual(r.status_code, 200, r.text)
        c = (await self.http.get(f"/api/v1/meetings/connection?workspace={self.W}", headers=self.session("owner"))).json()["connection"]
        sc = c["script"]
        self.assertEqual((sc["found"], sc["sent"], sc["remaining"], sc["shared_drives"]), (79, 60, 19, "off"))
        # The link that turns the Drive API on is built by Markdrop, for that project only.
        self.assertEqual(sc["drive_api_url"], "https://console.developers.google.com/apis/api/drive.googleapis.com/overview"
                                              "?project=1034426400429")
        self.assertNotIn("drive_project", sc)
        # Without a project: the page without one. A project id that isn't one is dropped.
        r = await self.status(tok, phase="done", version=3, shared_drives="off", drive_project="evil&x=<b>")
        self.assertEqual(r.status_code, 200, r.text)
        sc = (await self.http.get("/api/v1/meetings/connection", headers=self.session("owner"))).json()["connection"]["script"]
        self.assertEqual(sc["drive_api_url"], "https://console.developers.google.com/apis/api/drive.googleapis.com/overview")
        self.assertEqual(sc["remaining"], 0)
        # Searching shared drives: no link; the next run's counts replace the last's.
        r = await self.status(tok, phase="done", version=3, shared_drives="on", drive_project="1034426400429", remaining=2)
        sc = (await self.http.get("/api/v1/meetings/connection", headers=self.session("owner"))).json()["connection"]["script"]
        self.assertEqual((sc["shared_drives"], sc["drive_api_url"], sc["remaining"]), ("on", None, 2))
        # The body is checked: a negative count, an unknown state, an overlong project.
        for bad in ({"remaining": -1}, {"shared_drives": "maybe"}, {"drive_project": "x" * 41}, {"remaining": "lots"}):
            r = await self.status(tok, phase="done", version=3, **bad)
            self.assertEqual(r.status_code, 422, (bad, r.text))
        # 'start' leaves the last run's report alone.
        await self.status(tok, phase="start", version=3)
        sc = (await self.http.get("/api/v1/meetings/connection", headers=self.session("owner"))).json()["connection"]["script"]
        self.assertEqual((sc["shared_drives"], sc["remaining"]), ("on", 2))

    async def test_v2_delivery_fields(self):
        tok = (await self.connect())["token"]
        r = await self.deliver(tok, version=2, owner={"name": "Gautam Rao", "email": "Gautam@Acme.test", "me": False},
                               kind="unknown")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "imported")
        row = await self.db[meetings_inbox.COLL].find_one({"file_id": FID_T})
        self.assertEqual(row["owner"], {"name": "Gautam Rao", "email": "gautam@acme.test", "me": False})
        r = await self.deliver(tok, file_id=FID_N, title=NOTES, text=fixture("gemini_notes.txt"), kind="sideways")
        self.assertEqual(r.status_code, 422)


class Pinning(AutoWorld):
    async def test_the_token_does_nothing_else(self):
        tok = (await self.connect())["token"]
        h = {"Authorization": f"Bearer {tok}"}
        doc = await self.mkdoc("W")
        for method, path in (("GET", "/api/v1/auth/me"), ("GET", "/api/v1/me/tokens"),
                             ("GET", f"/api/v1/meetings?workspace={self.W}"),
                             ("GET", f"/api/v1/meetings/status?workspace={self.W}"),
                             ("GET", "/api/v1/meetings/connection"),
                             ("DELETE", "/api/v1/meetings/connection"),
                             ("GET", f"/api/v1/documents/{doc['slug']}"),
                             ("GET", f"/api/v1/workspaces/{self.W}")):
            r = await self.http.request(method, path, headers=h)
            self.assertEqual(r.status_code, 401, f"{method} {path}: {r.status_code} {r.text[:200]}")
        r = await self.http.post("/api/v1/meetings/import", headers=h, json={
            "workspace": self.W, "sources": [{"name": TRANSCRIPT, "text": fixture("google_meet_transcript.txt")}]})
        self.assertEqual(r.status_code, 401)
        r = await self.http.post("/mcp", headers={**h, "Accept": "application/json, text/event-stream"},
                                 json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        self.assertEqual(r.status_code, 401)
        # Still connected (nothing above revoked it), and it imports into its workspace only.
        r = await self.deliver(tok, workspace=self.ws["W2"])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(await self.db[meetings.COLL].count_documents({"workspace_id": self.ws["W2"]}), 0)
        self.assertEqual(len(await self.rows()), 1)

    async def test_the_inbox_takes_only_that_token(self):
        for h in (self.session("owner"), await self.api_token("owner"), {}):
            r = await self.http.post("/api/v1/meetings/inbox", headers=h, json={"file_id": FID_T, "text": "x"})
            self.assertEqual(r.status_code, 401)

    async def test_a_member_no_more(self):
        tok = (await self.connect("wm"))["token"]
        await self.remove_member("W1", "wm")
        r = await self.deliver(tok)
        self.assertEqual(r.status_code, 403)
        self.assertEqual(await self.rows(), [])
        rec = await self.db["api_tokens"].find_one({"scope": "meetings:import"})
        self.assertIn("no longer a member", rec["stats"]["last_error"])


class Inbox(AutoWorld):
    async def test_a_delivery_makes_a_meeting(self):
        tok = (await self.connect())["token"]
        r = await self.deliver(tok)
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertEqual(out["status"], "imported")
        self.assertTrue(out["url"].endswith("/" + (await self.rows())[0]["slug"]))
        row = (await self.rows())[0]
        self.assertEqual((row["via"], row["created_by"], row["title"], row["date"]), ("inbox", self.uid["owner"], "Weekly product sync", "2026-11-04"))
        self.assertEqual(row["sources"][0]["file_id"], FID_T)
        self.assertEqual(row["sources"][0]["origin"], "google")
        self.assertEqual(row["sources"][0]["url"], f"https://docs.google.com/document/d/{FID_T}/edit")
        self.assertEqual(row["ai"]["state"], "done")
        page = await self.doc(row["slug"])
        self.assertIn("## Decisions", page["content"])
        self.assertEqual(page["owner_id"], self.uid["owner"])
        # @mentions stay links and notify nobody, as with every meeting import (owner, 2026-11-06).
        self.assertIn(f'id="{self.uid["wv"]}"', page["content"])
        self.assertEqual(await self.db["notifications"].count_documents({}), 0)
        r = await self.http.get(f"/api/v1/meetings?workspace={self.W}&source=auto", headers=self.session("wm"))
        self.assertEqual([m["source"] for m in r.json()["meetings"]], ["auto"])
        r = await self.http.get(f"/api/v1/meetings?workspace={self.W}&source=manual", headers=self.session("wm"))
        self.assertEqual(r.json()["meetings"], [])
        c = (await self.http.get("/api/v1/meetings/connection", headers=self.session("owner"))).json()["connection"]
        self.assertEqual((c["received"], c["imported"]), (1, 1))
        self.assertIsNotNone(c["last_imported_at"])

    async def test_idempotent_on_the_file(self):
        tok = (await self.connect())["token"]
        first = (await self.deliver(tok)).json()
        again = await self.deliver(tok)
        self.assertEqual(again.status_code, 200)
        self.assertEqual(again.json(), {"status": "duplicate", "meeting_id": first["meeting_id"]})
        self.assertEqual(len(await self.rows()), 1)
        # Another member's script sending the same Doc (shared with them) changes nothing either.
        tok2 = (await self.connect("wm"))["token"]
        r = await self.deliver(tok2)
        self.assertEqual(r.json()["status"], "duplicate")
        self.assertEqual(len(await self.rows()), 1)
        c = (await self.http.get("/api/v1/meetings/connection", headers=self.session("owner"))).json()["connection"]
        self.assertEqual((c["received"], c["imported"], c["duplicates"]), (2, 1, 1))

    async def test_in_flight_and_failed(self):
        tok = (await self.connect())["token"]
        await self.db[meetings_inbox.COLL].insert_one({"workspace_id": self.W, "file_id": FID_T, "state": "processing",
                                                       "at": datetime.now(timezone.utc)})
        r = await self.deliver(tok)
        self.assertEqual(r.status_code, 409)
        # A claim left behind by a crash is taken over after a while.
        await self.db[meetings_inbox.COLL].update_one({"file_id": FID_T}, {"$set": {"at": datetime.now(timezone.utc) - timedelta(minutes=10)}})
        r = await self.deliver(tok)
        self.assertEqual(r.json()["status"], "imported")
        # A failure is retried by the next run.
        await self.db[meetings_inbox.COLL].insert_one({"workspace_id": self.W, "file_id": FID_N, "state": "failed",
                                                       "at": datetime.now(timezone.utc)})
        r = await self.deliver(tok, file_id=FID_N, title=NOTES, text=fixture("gemini_notes.txt"), kind="notes")
        self.assertEqual(r.json()["status"], "attached")

    async def test_limits(self):
        tok = (await self.connect())["token"]
        r = await self.deliver(tok, text="Ada: hi\n" * (meetings.MAX_PASTE_CHARS // 8 + 10))
        self.assertEqual(r.status_code, 413)
        big = json.dumps({"file_id": FID_T, "text": "x" * (meetings_inbox.MAX_BODY_BYTES + 10)})
        r = await self.http.post("/api/v1/meetings/inbox", headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"},
                                 content=big)
        self.assertEqual(r.status_code, 413)
        r = await self.deliver(tok, file_id="../../etc")
        self.assertEqual(r.status_code, 422)
        r = await self.http.post("/api/v1/meetings/inbox", headers={"Authorization": f"Bearer {tok}"}, content=b"{nope")
        self.assertEqual(r.status_code, 422)
        # Not a meeting: handled (the script won't send it again), nothing made.
        r = await self.deliver(tok, file_id="1ShoppingListAbcdefgh", title="Groceries - Notes", text="eggs\n\nmilk", kind="notes")
        self.assertEqual(r.status_code, 200)
        r2 = await self.deliver(tok, file_id="1ShoppingListAbcdefgh", title="Groceries - Notes", text="eggs\n\nmilk", kind="notes")
        self.assertEqual(r2.json()["status"], "duplicate")
        self.assertEqual(await self.rows(), [])

    async def test_rate_limit_is_per_token(self):
        from app.limiter import limiter

        tok = (await self.connect())["token"]
        limiter.enabled = True   # the AI world turns it off
        limiter.reset()
        self.addCleanup(setattr, limiter, "enabled", False)
        await self.deliver(tok)
        codes = [(await self.deliver(tok)).status_code for _ in range(32)]
        self.assertIn(429, codes)
        # Another connection (another person; Apps Script shares Google's addresses) isn't slowed.
        tok2 = (await self.connect("wm"))["token"]
        r = await self.deliver(tok2)
        self.assertEqual(r.status_code, 200)

    async def test_restricted_connection(self):
        tok = (await self.connect(restricted=True))["token"]
        await self.deliver(tok)
        row = (await self.rows())[0]
        self.assertTrue(row["restricted"])
        page = await self.doc(row["slug"])
        self.assertEqual(page["access_level"], "private")
        r = await self.http.get(f"/api/v1/meetings/{row['_id']}", headers=self.session("wm"))
        self.assertEqual(r.status_code, 200)   # Bo Chen was there
        r = await self.http.get(f"/api/v1/meetings/{row['_id']}", headers=self.session("wa"))
        self.assertEqual(r.status_code, 200)   # Priya too

    async def test_undated_doc_takes_the_creation_date(self):
        tok = (await self.connect())["token"]
        r = await self.deliver(tok, title="Design chat - Transcript", created="2026-10-30T09:00:00.000Z",
                               text="Ada Lovelace: hello\nBo Chen: hi there\n")
        self.assertEqual(r.json()["status"], "imported")
        self.assertEqual((await self.rows())[0]["date"], "2026-10-30")

    async def test_undated_doc_is_dated_in_the_connectors_time_zone(self):
        # 20:30 UTC on Oct 30 is already Oct 31 in Kolkata, where the call happened.
        tok = (await self.connect(tz="Asia/Kolkata"))["token"]
        await self.deliver(tok, title="Late chat - Transcript", created="2026-10-30T20:30:00.000Z",
                           text="Ada Lovelace: hello\nBo Chen: hi there\n")
        self.assertEqual((await self.rows())[0]["date"], "2026-10-31")
        self.assertEqual(meetings_inbox.meeting_date("2026-10-30T20:30:00.000Z", None), "2026-10-30")
        self.assertIsNone(meetings_inbox._tz("Mars/Olympus"))

    async def test_backfill_is_quiet_and_keeps_the_real_date(self):
        tok = (await self.connect(backfill_days=30))["token"]
        r = await self.deliver(tok, backfill=True, created="2026-11-04T05:20:00.000Z")
        self.assertEqual(r.json()["status"], "imported")
        row = (await self.rows())[0]
        self.assertTrue(row.get("history"))
        self.assertEqual(row["date"], "2026-11-04")             # the call's date, not today
        page = await self.doc(row["slug"])
        self.assertIn(":person[", page["content"])                 # the mentions stay links
        self.assertEqual(await self.db["notifications"].count_documents({}), 0)
        # Its other half arriving later (also history) stays quiet too, AI rewrite included.
        r = await self.deliver(tok, file_id=FID_N, title=NOTES, text=fixture("gemini_notes.txt"), kind="notes", backfill=True)
        self.assertEqual(r.json()["status"], "attached")
        self.assertEqual(await self.db["notifications"].count_documents({}), 0)
        # A new call afterwards isn't history (Slack may post it), and notifies nobody either.
        r = await self.deliver(tok, file_id="1AnotherCallAbcdefghijklm",
                               title=f"Release review ({meetings.now_utc().date().isoformat()} 15:00 GMT+05:30) - Transcript",
                               text="Ada Lovelace: Bo Chen will update the docs by Friday.\nBo Chen: Yes, I will update the docs.\n")
        new = await self.db[meetings.COLL].find_one({"_id": ObjectId(r.json()["meeting_id"])})
        self.assertFalse(new.get("history"))
        self.assertEqual(await self.db["notifications"].count_documents({}), 0)


class Pairing(AutoWorld):
    async def test_transcript_then_notes_in_another_run(self):
        tok = (await self.connect())["token"]
        a = (await self.deliver(tok)).json()
        b = (await self.deliver(tok, file_id=FID_N, title=NOTES, text=fixture("gemini_notes.txt"), kind="notes")).json()
        self.assertEqual((a["status"], b["status"]), ("imported", "attached"))
        self.assertEqual(a["meeting_id"], b["meeting_id"])
        rows = await self.rows()
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual({s["file_id"] for s in row["sources"]}, {FID_T, FID_N})
        self.assertTrue(row["notes"] and row["segments"])
        self.assertEqual(row["ai"]["state"], "done")
        c = (await self.doc(row["slug"]))["content"]
        self.assertIn("Summary · From Google Meet notes", c)
        self.assertIn("## Details", c)
        self.assertIn("## Decisions", c)
        self.assertIn(f'::page{{src="{row["transcript_slug"]}"}}', c)
        self.assertEqual(c.count("## Action items"), 1)
        c2 = (await self.http.get("/api/v1/meetings/connection", headers=self.session("owner"))).json()["connection"]
        self.assertEqual((c2["imported"], c2["attached"]), (1, 1))

    async def test_notes_then_transcript(self):
        tok = (await self.connect())["token"]
        a = (await self.deliver(tok, file_id=FID_N, title=NOTES, text=fixture("gemini_notes.txt"), kind="notes")).json()
        row = (await self.rows())[0]
        self.assertIsNone(row.get("transcript_slug"))
        b = (await self.deliver(tok)).json()
        self.assertEqual((a["status"], b["status"], a["meeting_id"]), ("imported", "attached", b["meeting_id"]))
        row = (await self.rows())[0]
        self.assertEqual(len(row["segments"]), 14)
        tr = await self.doc(row["transcript_slug"])
        self.assertEqual(str(tr["parent_id"]), str(row["doc_id"]))
        self.assertEqual(tr["meeting_role"], "transcript")
        self.assertIn("{#b-t0014}", tr["content"])
        c = (await self.doc(row["slug"]))["content"]
        self.assertIn(f"](/{row['transcript_slug']}#b-t", c)   # the AI pass cites the transcript now

    async def test_edited_page_keeps_the_edit(self):
        tok = (await self.connect())["token"]
        await self.deliver(tok)
        row = (await self.rows())[0]
        page = await self.doc(row["slug"])
        await self.db["documents"].update_one({"_id": page["_id"]}, {"$set": {"content": page["content"] + "\nMY OWN NOTE\n"},
                                                                     "$inc": {"rev": 1}})
        r = await self.deliver(tok, file_id=FID_N, title=NOTES, text=fixture("gemini_notes.txt"), kind="notes")
        self.assertEqual(r.json()["status"], "attached")
        c = (await self.doc(row["slug"]))["content"]
        self.assertIn("MY OWN NOTE", c)
        self.assertIn("## Decisions", c)

    async def test_edited_page_without_ai_gets_the_new_half_at_the_end(self):
        tok = (await self.connect())["token"]
        await self.deliver(tok)
        row = (await self.rows())[0]
        page = await self.doc(row["slug"])
        await self.db["documents"].update_one({"_id": page["_id"]}, {"$set": {"content": page["content"] + "\nMY OWN NOTE\n"},
                                                                     "$inc": {"rev": 1}})
        from app.config import get_settings

        get_settings().meetings_ai_enabled = False
        self.addCleanup(setattr, get_settings(), "meetings_ai_enabled", True)
        await self.deliver(tok, file_id=FID_N, title=NOTES, text=fixture("gemini_notes.txt"), kind="notes")
        c = (await self.doc(row["slug"]))["content"]
        self.assertIn("MY OWN NOTE", c)
        self.assertLess(c.index("MY OWN NOTE"), c.index("Summary · From Google Meet notes"))

    async def test_other_days_and_times_are_other_meetings(self):
        tok = (await self.connect())["token"]
        await self.deliver(tok)
        nxt = fixture("google_meet_transcript.txt").replace("2026-11-04", "2026-11-05")
        r = await self.deliver(tok, file_id="1NextDayAbcdefghijklmno", title="Weekly product sync (2026-11-05 10:00 GMT+05:30) - Transcript", text=nxt)
        self.assertEqual(r.json()["status"], "imported")
        late = fixture("google_meet_transcript.txt").replace("10:00", "17:00")
        r = await self.deliver(tok, file_id="1LateCallAbcdefghijklmn", title="Weekly product sync (2026-11-04 17:00 GMT+05:30) - Transcript", text=late)
        self.assertEqual(r.json()["status"], "imported")
        self.assertEqual(len(await self.rows()), 3)


class WithManual(AutoWorld):
    async def test_manual_paste_then_script(self):
        m = await self.imported(sources=[{"name": TRANSCRIPT, "text": fixture("google_meet_transcript.txt")}])
        tok = (await self.connect())["token"]
        r = (await self.deliver(tok)).json()
        self.assertEqual((r["status"], r["meeting_id"]), ("duplicate", m["id"]))
        r = (await self.deliver(tok, file_id=FID_N, title=NOTES, text=fixture("gemini_notes.txt"), kind="notes")).json()
        self.assertEqual((r["status"], r["meeting_id"]), ("attached", m["id"]))
        self.assertEqual(len(await self.rows()), 1)

    async def test_picker_import_by_file_id(self):
        from app.models.user import User  # noqa: F401
        from app.services import user as user_service

        user = await user_service.get_user_by_id(self.db, self.uid["wm"])
        rows = await meetings.import_meetings(self.db, user, self.W, [meetings.Incoming(
            name="renamed by hand", text=fixture("google_meet_transcript.txt"), origin="google", file_id=FID_T,
            url=f"https://docs.google.com/document/d/{FID_T}/edit")], wait=True)
        tok = (await self.connect())["token"]
        r = (await self.deliver(tok, title="Something else entirely - Transcript")).json()
        self.assertEqual((r["status"], r["meeting_id"]), ("duplicate", str(rows[0]["_id"])))
        # And the other way round: the website's import of a Doc the script already sent opens that meeting.
        tok_n = await self.deliver(tok, file_id=FID_N, title="Retro - 2026/11/03 - Notes by Gemini",
                                   text=fixture("gemini_notes.txt").replace("Weekly product sync", "Retro"), kind="notes")
        self.assertEqual(tok_n.json()["status"], "imported")
        again = await meetings.import_meetings(self.db, user, self.W, [meetings.Incoming(
            name="x", text=fixture("gemini_notes.txt"), origin="google", file_id=FID_N)], dedupe="file")
        self.assertEqual(again[0]["_status"], "duplicate")
        self.assertEqual(len(await self.rows()), 2)

    async def test_manual_import_still_works_while_connected(self):
        await self.connect()
        m = await self.imported(sources=[{"name": "standup.vtt", "text": fixture("teams.vtt")}])
        self.assertEqual(m["source"], "manual")
        self.assertEqual(m["status"], "imported")


class MCP(AutoWorld):
    async def test_connection_tool_and_filters(self):
        tok = await self.mcp_token("wm")
        code, res = await self.mcp_call(tok, "meetings_connection", {"workspace": self.W})
        self.assertFalse(res.get("isError"), res)
        self.assertFalse(res["structuredContent"]["connected"])
        raw = (await self.connect())["token"]
        await self.deliver(raw)
        code, res = await self.mcp_call(tok, "meetings_connection", {"workspace": self.W})
        sc = res["structuredContent"]
        self.assertTrue(sc["connected"])
        self.assertEqual(sc["connections"][0]["connected_by"]["id"], self.uid["owner"])
        self.assertEqual(sc["connections"][0]["imported"], 1)
        blob = json.dumps(res)
        self.assertNotIn(raw, blob)
        self.assertNotIn(raw[:12], blob)
        self.assertNotIn("UrlFetchApp", blob)
        code, res = await self.mcp_call(await self.mcp_token("stranger"), "meetings_connection", {"workspace": self.W})
        self.assertTrue(res.get("isError"))
        # list_meetings: source and since.
        await self.imported(sources=[{"name": "standup.vtt", "text": fixture("teams.vtt")}], date="2026-10-01")
        code, res = await self.mcp_call(tok, "list_meetings", {"workspace": self.W, "source": "auto"})
        self.assertEqual([m["source"] for m in res["structuredContent"]["meetings"]], ["auto"])
        code, res = await self.mcp_call(tok, "list_meetings", {"workspace": self.W, "source": "manual"})
        self.assertEqual([m["date"] for m in res["structuredContent"]["meetings"]], ["2026-10-01"])
        code, res = await self.mcp_call(tok, "list_meetings", {"workspace": self.W, "since": "2026-11-01"})
        self.assertEqual([m["date"] for m in res["structuredContent"]["meetings"]], ["2026-11-04"])

    async def test_import_meeting_dedupes_like_the_inbox(self):
        tok = await self.mcp_token("owner")
        args = {"workspace": self.W, "text": fixture("google_meet_transcript.txt"), "file_name": TRANSCRIPT}
        code, res = await self.mcp_call(tok, "import_meeting", args)
        first = res["structuredContent"]["meetings"][0]
        self.assertEqual((first["status"], first["source"]), ("imported", "mcp"))
        code, res = await self.mcp_call(tok, "import_meeting", args)
        self.assertEqual(res["structuredContent"]["meetings"][0]["status"], "duplicate")
        code, res = await self.mcp_call(tok, "import_meeting", {"workspace": self.W, "notes_text": fixture("gemini_notes.txt")})
        self.assertFalse(res.get("isError"), res)
        got = res["structuredContent"]["meetings"][0]
        self.assertEqual((got["status"], got["id"]), ("attached", first["id"]))
        self.assertTrue(got["has_notes"])
        self.assertEqual(len(await self.rows()), 1)


@unittest.skipUnless(NODE, "node isn't installed")
class Script(unittest.TestCase):
    def render(self, token="mdk_" + "A" * 43, name="Acme \"R&D\" */ team\nx") -> str:
        return meetings_inbox.script(token, name, url="https://api.example.test/api/v1/meetings/inbox")

    def node(self, *args: str, input_: str | None = None) -> subprocess.CompletedProcess:
        return subprocess.run([NODE, *args], capture_output=True, text=True, timeout=60, input=input_)

    def run_script(self, scenario: dict, code: str | None = None) -> dict:
        with tempfile.TemporaryDirectory() as d:
            gs, scen = Path(d) / "Code.js", Path(d) / "scenario.json"
            gs.write_text(code or self.render())
            scen.write_text(json.dumps(scenario))
            p = self.node(str(HERE / "meeting_script_harness.js"), str(gs), str(scen))
            self.assertEqual(p.returncode, 0, p.stderr)
            return json.loads(p.stdout)

    def test_valid_javascript_with_the_values(self):
        for name in ("Acme", "Acme \"R&D\" */ team\nx", "O'Brien's team"):
            code = self.render(name=name)
            with tempfile.TemporaryDirectory() as d:
                f = Path(d) / "Code.js"
                f.write_text(code)
                p = self.node("--check", str(f))
                self.assertEqual(p.returncode, 0, p.stderr)
        out = self.run_script({"files": [], "runs": []})
        self.assertEqual(out["constants"], {"endpoint": "https://api.example.test/api/v1/meetings/inbox",
                                            "token": "mdk_" + "A" * 43, "lookback": 48, "version": 4, "maxPerRun": 0,
                                            "shared": True})
        self.assertEqual(meetings_inbox.script_version(), 4)
        self.assertNotIn("{{", self.render())
        # The manifest is JSON and asks for nothing that writes to Drive.
        man = json.loads(meetings_inbox.manifest())
        self.assertFalse([s for s in man["oauthScopes"] if s.endswith("/drive") or "documents" in s])

    def test_runs_against_fake_apps_script(self):
        now = datetime.now(timezone.utc)

        def iso(h: float) -> str:
            return (now - timedelta(hours=h)).isoformat().replace("+00:00", "Z")

        notes_doc = {"title": NOTES, "tabs": [
            {"tabProperties": {"title": "Notes"}, "documentTab": {"body": {"content": [
                {"paragraph": {"paragraphStyle": {"namedStyleType": "HEADING_1"}, "elements": [{"textRun": {"content": "Summary\n"}}]}},
                {"paragraph": {"elements": [{"textRun": {"content": "We agreed to ship.\n"}}]}},
                {"paragraph": {"paragraphStyle": {"namedStyleType": "HEADING_1"}, "elements": [{"textRun": {"content": "Suggested next steps\n"}}]}},
                {"paragraph": {"bullet": {}, "elements": [{"person": {"personProperties": {"name": "Bo Chen", "email": "bo@acme.test"}}},
                                                          {"textRun": {"content": " will update the docs.\n"}}]}},
                {"table": {"tableRows": [{"tableCells": [{"content": [{"paragraph": {"elements": [{"textRun": {"content": "a\n"}}]}}]},
                                                         {"content": [{"paragraph": {"elements": [{"textRun": {"content": "b\n"}}]}}]}]}]}},
            ]}}},
            {"tabProperties": {"title": "Transcript"}, "documentTab": {"body": {"content": [
                {"paragraph": {"elements": [{"textRun": {"content": "Ada: Shall we ship?\n"}}]}},
                {"paragraph": {"elements": [{"textRun": {"content": "Bo: Yes.\n"}}]}},
            ]}}},
        ]}
        files = [
            {"id": FID_N, "name": NOTES, "created": iso(2), "modified": iso(1), "doc": notes_doc},
            {"id": FID_T, "name": TRANSCRIPT, "created": iso(3), "modified": iso(2.5),
             "doc": {"title": TRANSCRIPT, "body": {"content": [{"paragraph": {"elements": [{"textRun": {"content": "Ada: hi\n"}}]}}]}}},
            {"id": "1Unrelated", "name": "Quarterly plan", "created": iso(1), "modified": iso(1), "doc": {}},
            {"id": "1OldTranscript", "name": "Old (2026-01-01) - Transcript", "created": iso(24 * 30), "modified": iso(1), "doc": {}},
            # Someone else's Doc that only says "Transcript" (not Meet's: no date, not Gemini): left alone.
            {"id": "1SharedPlain", "name": "Theirs - Transcript", "created": iso(1), "modified": iso(1), "owned": False, "doc": {}},
            # A call the manager organized: it lives in HIS Drive, shared with me. Sent (v1 missed it).
            {"id": "1SharedMeet", "name": "Standup - 2026/11/04 10:00 IST - Transcript", "created": iso(3),
             "modified": iso(2), "owned": False, "doc": {"body": {"content": [{"paragraph": {"elements": [{"textRun": {"content": "Gautam: hi\n"}}]}}]}}},
        ]
        out = self.run_script({"files": files, "runs": ["setup", "syncMeetings"], "responses": [200, 200, 200]})
        # setup scheduled itself once, every 15 minutes, and ran.
        self.assertEqual(out["triggers"], [{"fn": "syncMeetings", "every": 5}])
        # Drive v3, every drive (shared drives too), shared-with-me included (no owner filter).
        search = next(v for v in out["v3"] if "vnd.google-apps.document" in v["q"])
        self.assertEqual((search["corpora"], search["all"]), ("allDrives", "true"))
        self.assertNotIn("'me' in owners", search["q"])
        self.assertIn("name contains 'Transcrip'", search["q"])
        self.assertEqual(out["searches"], [])          # DriveApp only when Drive v3 fails
        # The three meeting Docs, once each (the second run sent nothing).
        self.assertEqual(sorted(p["body"]["file_id"] for p in out["posts"]), sorted([FID_N, FID_T, "1SharedMeet"]))
        self.assertEqual(out["sent"], sorted([FID_N, FID_T, "1SharedMeet"]))
        shared = next(p for p in out["posts"] if p["body"]["file_id"] == "1SharedMeet")["body"]
        self.assertEqual(shared["owner"], {"name": "Gautam", "email": "gautam@acme.test", "me": False})
        self.assertEqual((shared["version"], shared["requested"]), (4, False))
        # Each run told Markdrop how it went: start, then done with the counts.
        self.assertEqual([(st["phase"], st["mode"]) for st in out["statuses"]],
                         [("start", "setup"), ("done", "setup"), ("start", "run"), ("done", "run")])
        first = out["statuses"][1]
        self.assertEqual((first["found"], first["sent"], first["version"], first["include_shared"]), (3, 3, 4, True))
        self.assertEqual((first["remaining"], first["shared_drives"], first["drive_project"]), (0, "on", None))
        self.assertEqual(first["results"]["imported"], 3)
        self.assertEqual(first["skipped"]["title"], 2)       # "Quarterly plan", "Theirs - Transcript"
        self.assertEqual(first["skipped"]["too_old"], 1)
        self.assertEqual(out["statuses"][3]["skipped"]["already_sent"], 3)
        self.assertEqual(out["statuses"][0]["auth"], "Bearer mdk_" + "A" * 43)
        post = next(p for p in out["posts"] if p["body"]["file_id"] == FID_N)
        self.assertEqual(post["auth"], "Bearer mdk_" + "A" * 43)
        self.assertEqual(post["url"], "https://api.example.test/api/v1/meetings/inbox")
        self.assertEqual(post["method"], "post")
        b = post["body"]
        self.assertEqual((b["source"], b["title"], b["kind_hint"]), ("google-meet-script", NOTES, "notes"))
        self.assertEqual(b["doc_url"], f"https://docs.google.com/document/d/{FID_N}/edit")
        # The text is what the server's own Docs reader makes of it (tabs included).
        self.assertEqual(b["text"], mp.gdoc_text(notes_doc))
        self.assertEqual(mp.parse_source(b["title"], b["text"]).kind, "both")
        self.assertEqual(next(p for p in out["posts"] if p["body"]["file_id"] == FID_T)["body"]["kind_hint"], "transcript")

    def test_failures_retry_and_disconnect_stops(self):
        now = (datetime.now(timezone.utc) - timedelta(minutes=20)).isoformat().replace("+00:00", "Z")
        files = [{"id": FID_T, "name": TRANSCRIPT, "created": now, "modified": now, "text": "Ada: hi\nBo: yo\n"},
                 {"id": FID_N, "name": NOTES, "created": now, "modified": now, "text": "Summary\nok"}]
        # A 500 stops the run and nothing is marked sent; the next run sends both.
        out = self.run_script({"files": files, "docsFails": True, "runs": ["syncMeetings", "syncMeetings"],
                               "responses": [500, 200, 200]})
        self.assertEqual(len(out["posts"]), 3)
        self.assertEqual(out["sent"], sorted([FID_N, FID_T]))
        self.assertEqual(len(out["exports"]), 3)   # the Docs service off: Drive's text export
        self.assertEqual(out["posts"][-1]["body"]["text"] in ("Ada: hi\nBo: yo\n", "Summary\nok"), True)
        # A 422 is final (marked sent); a 401 (disconnected) removes the schedule.
        out = self.run_script({"files": files, "docsFails": True, "runs": ["setup"], "responses": [422, 401]})
        self.assertEqual(len(out["sent"]), 1)
        self.assertEqual(out["triggers"], [])
        # A 409 (being imported) is retried next run without stopping this one.
        out = self.run_script({"files": files, "docsFails": True, "runs": ["syncMeetings"], "responses": [409, 200]})
        self.assertEqual((len(out["posts"]), len(out["sent"])), (2, 1))

    def test_backfill_oldest_first_and_flagged(self):
        now = datetime.now(timezone.utc)

        def iso(h: float) -> str:
            return (now - timedelta(hours=h)).isoformat().replace("+00:00", "Z")

        files = [{"id": "1Recent", "name": "Now (2026-11-05) - Transcript", "created": iso(1), "modified": iso(1), "text": "A: hi\n"},
                 {"id": "1TenDays", "name": "Ten (2026-10-26) - Transcript", "created": iso(240), "modified": iso(240), "text": "A: hi\n"},
                 {"id": "1TwentyDays", "name": "Twenty - Notes by Gemini", "created": iso(480), "modified": iso(470), "text": "Summary\nok"},
                 {"id": "1TooOld", "name": "Old (2026-08-01) - Transcript", "created": iso(24 * 60), "modified": iso(24 * 60), "text": "A: hi\n"}]
        out = self.run_script({"files": files, "docsFails": True, "runs": ["backfill(30)", "syncMeetings"]})
        # The recent sweep first (not flagged), then the past, oldest first and flagged; once each.
        self.assertEqual([(p["body"]["file_id"], p["body"]["backfill"]) for p in out["posts"]],
                         [("1Recent", False), ("1TwentyDays", True), ("1TenDays", True)])
        self.assertNotIn("backfill_since", out["props"])
        # setup with BACKFILL_DAYS filled in does the same by itself.
        code = meetings_inbox.script("mdk_" + "A" * 43, "Acme", url="https://api.example.test/api/v1/meetings/inbox",
                                     backfill_days=30)
        self.assertIn("var BACKFILL_DAYS = 30;", code)
        out = self.run_script({"files": files, "docsFails": True, "runs": ["setup"]}, code=code)
        self.assertEqual([p["body"]["file_id"] for p in out["posts"]], ["1Recent", "1TwentyDays", "1TenDays"])
        self.assertIn("var BACKFILL_DAYS = 0;", self.render())
        out = self.run_script({"files": files, "docsFails": True, "runs": ["setup"]})
        self.assertEqual([p["body"]["file_id"] for p in out["posts"]], ["1Recent"])

    def test_backfill_spreads_over_runs(self):
        now = datetime.now(timezone.utc)
        files = [{"id": f"1Day{i:02d}", "name": f"Call {i} (2026-10-{i:02d}) - Transcript",
                  "created": (now - timedelta(days=i)).isoformat().replace("+00:00", "Z"),
                  "modified": (now - timedelta(days=i)).isoformat().replace("+00:00", "Z"), "text": "A: hi\n"}
                 for i in range(1, 26)]
        # Each send takes 15 s: 18 fit in the 4.5-minute budget.
        out = self.run_script({"files": files, "docsFails": True, "runs": ["backfill(30)"], "sendMs": 15_000})
        self.assertEqual(len(out["posts"]), 18)
        # The last 48 hours first (yesterday's call), then the past, oldest first.
        self.assertEqual([p["body"]["file_id"] for p in out["posts"][:3]], ["1Day01", "1Day25", "1Day24"])
        self.assertIn("backfill_since", out["props"])
        self.assertEqual((out["statuses"][-1]["found"], out["statuses"][-1]["remaining"]), (25, 7))
        out = self.run_script({"files": files, "docsFails": True, "runs": ["backfill(30)", "syncMeetings"], "sendMs": 15_000})
        self.assertEqual(len(out["posts"]), 25)
        self.assertNotIn("backfill_since", out["props"])
        self.assertEqual(out["statuses"][-1]["remaining"], 0)

    def test_time_budget_and_what_waits(self):
        now = datetime.now(timezone.utc)
        files = [{"id": f"1Doc{i:010d}", "name": f"Call {i} (2026-11-04) - Transcript",
                  "created": (now - timedelta(hours=2, minutes=79 - i)).isoformat().replace("+00:00", "Z"),
                  "modified": (now - timedelta(hours=1)).isoformat().replace("+00:00", "Z"), "text": "A: hi\n"}
                 for i in range(79)]
        # 79 Docs, each send takes 4.5 s: 60 fit in the 4.5-minute budget (a run has 6); 19 wait.
        out = self.run_script({"files": files, "docsFails": True, "sendMs": 4_500, "runs": ["syncMeetings"]})
        self.assertEqual([p["body"]["file_id"] for p in out["posts"]], [f"1Doc{i:010d}" for i in range(60)])
        done = out["statuses"][-1]
        self.assertEqual((done["phase"], done["found"], done["sent"], done["remaining"]), ("done", 79, 60, 19))
        self.assertIn("Found 79 meeting Docs. Sent 60 of 79 · 19 more in the next run (every 5 min) — or run syncMeetings now. "
                      "Skipped: none.", out["logs"])
        # At about 3.5 s a send, 78 fit.
        out = self.run_script({"files": files, "docsFails": True, "sendMs": 3_500, "runs": ["syncMeetings"]})
        self.assertEqual((len(out["posts"]), out["statuses"][-1]["remaining"]), (78, 1))
        # The next run (15 minutes later) sends the rest, and nothing waits.
        out = self.run_script({"files": files, "docsFails": True, "sendMs": 4_500, "runGapMs": 15 * 60_000,
                               "runs": ["syncMeetings", "syncMeetings"]})
        self.assertEqual(len(out["posts"]), 79)
        self.assertEqual(len(out["sent"]), 79)
        self.assertEqual([(s["found"], s["sent"], s["remaining"]) for s in out["statuses"] if s["phase"] == "done"],
                         [(79, 60, 19), (19, 19, 0)])
        # Fast sends: 200 at most a run, whatever the time.
        many = [dict(f, id=f"1Many{i:010d}") for i, f in enumerate(files * 3)][:230]
        out = self.run_script({"files": many, "docsFails": True, "sendMs": 50, "runs": ["syncMeetings"]})
        self.assertEqual((len(out["posts"]), out["statuses"][-1]["remaining"]), (200, 30))
        # MAX_PER_RUN, when set, caps a run too.
        code = self.render().replace("var MAX_PER_RUN = 0;", "var MAX_PER_RUN = 5;")
        self.assertNotEqual(code, self.render())
        out = self.run_script({"files": files, "docsFails": True, "runs": ["syncMeetings"]}, code=code)
        self.assertEqual((len(out["posts"]), out["statuses"][-1]["remaining"]), (5, 74))
        # Docs asked for by link count against the budget too, and wait with the rest.
        out = self.run_script({"files": files, "docsFails": True, "queue": ["1Doc0000000078", "1Doc0000000077"],
                               "runs": ["syncMeetings"]}, code=code.replace("var MAX_PER_RUN = 5;", "var MAX_PER_RUN = 1;"))
        self.assertEqual([p["body"]["file_id"] for p in out["posts"]], ["1Doc0000000078"])
        self.assertEqual(out["statuses"][-1]["remaining"], 78)     # the other asked-for one is among the 78 found

    def test_shared_off_skips_other_peoples_docs(self):
        at = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat().replace("+00:00", "Z")
        files = [{"id": "1SharedMeetXyz", "name": NOTES, "created": at, "modified": at, "owned": False, "text": "Summary\nok"},
                 {"id": FID_T, "name": TRANSCRIPT, "created": at, "modified": at, "text": "A: hi\n"}]
        code = meetings_inbox.script("mdk_" + "A" * 43, "Acme", url="https://api.example.test/api/v1/meetings/inbox",
                                     include_shared=False)
        self.assertIn("var INCLUDE_SHARED = false;", code)
        out = self.run_script({"files": files, "docsFails": True, "runs": ["syncMeetings"]}, code=code)
        self.assertEqual([p["body"]["file_id"] for p in out["posts"]], [FID_T])
        self.assertEqual(out["statuses"][-1]["skipped"]["not_yours"], 1)
        self.assertFalse(out["statuses"][-1]["include_shared"])

    def test_titles_in_other_languages_and_the_meet_folder(self):
        at = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat().replace("+00:00", "Z")
        names = {
            "1GermanNotesXyz": ("Wochenrunde - 2026/11/04 10:00 MEZ - Notizen von Gemini", "notes"),
            "1SpanishTransXy": ("Reunión (2026-11-04 10:00 GMT+1) - Transcripción", "transcript"),
            "1PortugueseXyzw": ("Reunião - 2026/11/04 10:00 BRT - Transcrição", "transcript"),
            "1GeminiJapanese": ("定例 - 2026/11/04 10:00 JST - Gemini によるメモ", "notes"),
            "1MeetingStarted": ("Meeting started 2026/11/04 10:00 IST - Notes by Gemini", "notes"),
            "1UntitledInMeet": ("Call with Bo", "unknown"),
        }
        files = [{"id": k, "name": v[0], "created": at, "modified": at, "text": "Summary\nok",
                  "owned": k != "1GermanNotesXyz", "parents": ["fMeet"] if k == "1UntitledInMeet" else []}
                 for k, v in names.items()]
        # Not meetings: my "Notes", a Gemini research Doc, a plain shared "Notes".
        files += [{"id": "1JustNotesXyzw", "name": "Notes", "created": at, "modified": at, "text": "x"},
                  {"id": "1GeminiApiXyzw", "name": "Gemini API pricing", "created": at, "modified": at, "text": "x"},
                  {"id": "1TheirNotesXyz", "name": "Q3 plan - Notes", "created": at, "modified": at, "owned": False, "text": "x"}]
        out = self.run_script({"files": files, "docsFails": True, "folders": [{"id": "fMeet", "name": "Meet Recordings"},
                                                                              {"id": "fOther", "name": "Meet ups"}],
                               "runs": ["syncMeetings"]})
        got = {p["body"]["file_id"]: p["body"]["kind_hint"] for p in out["posts"]}
        self.assertEqual(got, {k: v[1] for k, v in names.items()})
        self.assertIn("'fMeet' in parents", next(v for v in out["v3"] if "vnd.google-apps.document" in v["q"])["q"])
        self.assertEqual(out["statuses"][-1]["skipped"]["title"], 3)

    def test_check_sends_nothing_and_says_why(self):
        at = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat().replace("+00:00", "Z")
        just = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        files = [{"id": FID_T, "name": TRANSCRIPT, "created": at, "modified": at, "text": "A: hi\n"},
                 {"id": FID_N, "name": NOTES, "created": just, "modified": just, "text": "Summary\nok"},
                 {"id": "1Unrelated", "name": "Quarterly plan - Notes", "created": at, "modified": at, "text": "x"}]
        out = self.run_script({"files": files, "docsFails": True, "runs": ["check"]})
        self.assertEqual(out["posts"], [])
        self.assertEqual(out["sent"], [])
        self.assertTrue(any(l.startswith("WOULD SEND  transcript") for l in out["logs"]), out["logs"])
        self.assertTrue(any("skip (writing)" in l for l in out["logs"]))
        self.assertEqual([(s["phase"], s["mode"]) for s in out["statuses"]], [("done", "check")])
        self.assertEqual(out["statuses"][0]["skipped"]["writing"], 1)

    def test_queued_links_come_first(self):
        old = (datetime.now(timezone.utc) - timedelta(days=200)).isoformat().replace("+00:00", "Z")
        files = [{"id": "1AskedForByLinkXyzwv", "name": "Board call", "created": old, "modified": old, "owned": False,
                  "listed": False, "text": "Ada: hi\nBo: yes\n"},
                 {"id": "1AVttInDriveXyzwvut", "name": "call.vtt", "mime": "text/vtt", "created": old, "modified": old,
                  "listed": False, "text": "WEBVTT\n\n00:00.000 --> 00:01.000\n<v Ada>hi\n"},
                 {"id": "1APdfInDriveXyzwvut", "name": "deck.pdf", "mime": "application/pdf", "created": old,
                  "modified": old, "listed": False}]
        out = self.run_script({"files": files, "docsFails": True, "runs": ["syncMeetings"],
                               "queue": ["1AskedForByLinkXyzwv", "1AVttInDriveXyzwvut", "1APdfInDriveXyzwvut", "1MissingFileXyzwvut"]})
        self.assertEqual([(p["body"]["file_id"], p["body"]["requested"]) for p in out["posts"]],
                         [("1AskedForByLinkXyzwv", True), ("1AVttInDriveXyzwvut", True)])
        self.assertEqual(out["posts"][1]["body"]["text"].split("\n")[0], "WEBVTT")
        done = out["statuses"][-1]
        self.assertEqual(done["queue_done"], ["1AskedForByLinkXyzwv", "1AVttInDriveXyzwvut"])
        self.assertEqual(sorted((f["file_id"], f["error"]) for f in done["queue_failed"]),
                         [("1APdfInDriveXyzwvut", "not_a_doc"), ("1MissingFileXyzwvut", "not_found")])

    def test_queued_links_with_the_drive_api_off(self):
        # The owner's project has the Drive API off: a Doc asked for by link is still read (DriveApp).
        old = (datetime.now(timezone.utc) - timedelta(days=200)).isoformat().replace("+00:00", "Z")
        files = [{"id": "1AskedForByLinkXyzwv", "name": "Board call", "created": old, "modified": old, "owned": False,
                  "listed": False, "text": "Ada: hi\nBo: yes\n"},
                 {"id": "1AVttInDriveXyzwvut", "name": "call.vtt", "mime": "text/vtt", "created": old, "modified": old,
                  "listed": False, "text": "WEBVTT\n\n00:00.000 --> 00:01.000\n<v Ada>hi\n"}]
        out = self.run_script({"files": files, "docsFails": True, "driveOff": True, "runs": ["syncMeetings"],
                               "queue": ["1AskedForByLinkXyzwv", "1AVttInDriveXyzwvut", "1MissingFileXyzwvut"]})
        self.assertEqual([(p["body"]["file_id"], p["body"]["requested"]) for p in out["posts"]],
                         [("1AskedForByLinkXyzwv", True), ("1AVttInDriveXyzwvut", True)])
        self.assertEqual(out["posts"][1]["body"]["text"].split("\n")[0], "WEBVTT")
        done = out["statuses"][-1]
        self.assertEqual(done["queue_done"], ["1AskedForByLinkXyzwv", "1AVttInDriveXyzwvut"])
        self.assertEqual([(f["file_id"], f["error"]) for f in done["queue_failed"]], [("1MissingFileXyzwvut", "not_found")])
        self.assertEqual(done["shared_drives"], "off")
        self.assertFalse(any(l.startswith("WARN") for l in out["logs"]), out["logs"])

    def test_drive_api_off_falls_back_to_driveapp(self):
        at = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat().replace("+00:00", "Z")
        files = [{"id": FID_T, "name": TRANSCRIPT, "created": at, "modified": at, "text": "A: hi\n", "owned": False}]
        # Some other Drive error: said as a warning, DriveApp instead.
        out = self.run_script({"files": files, "docsFails": True, "driveFails": True, "runs": ["syncMeetings"]})
        self.assertEqual([p["body"]["file_id"] for p in out["posts"]], [FID_T])
        self.assertNotIn("'me' in owners", out["searches"][0])
        self.assertEqual(out["statuses"][-1]["search"], "driveapp")
        self.assertEqual(out["statuses"][-1]["shared_drives"], None)
        self.assertTrue(any(l.startswith("WARN Drive search:") for l in out["logs"]), out["logs"])
        self.assertFalse(any(l.startswith("INFO") for l in out["logs"]))

    def test_drive_api_disabled_is_one_friendly_line_a_day(self):
        noon = datetime.now(timezone.utc).replace(hour=12, minute=0, second=0, microsecond=0)
        at = (noon - timedelta(hours=1)).isoformat().replace("+00:00", "Z")
        files = [{"id": FID_T, "name": TRANSCRIPT, "created": at, "modified": at, "text": "A: hi\n", "owned": False},
                 {"id": FID_N, "name": NOTES, "created": at, "modified": at, "text": "Summary\nok"}]
        scen = {"files": files, "docsFails": True, "driveOff": True, "now": noon.isoformat(), "runGapMs": 15 * 60_000,
                "runs": ["syncMeetings", "syncMeetings"]}
        out = self.run_script(scen)
        # The shared-with-me meeting and mine still come in (DriveApp).
        self.assertEqual(sorted(p["body"]["file_id"] for p in out["posts"]), sorted([FID_N, FID_T]))
        self.assertNotIn("'me' in owners", out["searches"][0])
        # The folder lookup and the search both met it: one line, information (not a warning), and not
        # again in the second run the same day.
        self.assertFalse([l for l in out["logs"] if l.startswith("WARN")], out["logs"])
        info = [l for l in out["logs"] if l.startswith("INFO")]
        self.assertEqual(info, ["INFO Shared-drive search is off (optional: enable the Drive API for this script's project: "
                                "https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=1034426400429). "
                                "Using your Drive and files shared with you — meetings shared with you are still imported."])
        self.assertEqual(out["propValues"]["drive_off_said"], noon.date().isoformat())
        # Every run still tells Markdrop (the Meetings page shows the optional hint).
        for done in [s for s in out["statuses"] if s["phase"] == "done"]:
            self.assertEqual((done["shared_drives"], done["drive_project"], done["search"]), ("off", "1034426400429", "driveapp"))
        # The next day: said once more.
        out = self.run_script(dict(scen, runGapMs=24 * 3600_000))
        self.assertEqual(len([l for l in out["logs"] if l.startswith("INFO Shared-drive search is off")]), 2)
        # check (run by hand to see what the script sees) always says it.
        out = self.run_script(dict(scen, runs=["syncMeetings", "check"]))
        self.assertEqual(len([l for l in out["logs"] if l.startswith("INFO Shared-drive search is off")]), 2)

    def test_disconnected_status_stops_before_sending(self):
        at = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat().replace("+00:00", "Z")
        files = [{"id": FID_T, "name": TRANSCRIPT, "created": at, "modified": at, "text": "A: hi\n"}]
        out = self.run_script({"files": files, "docsFails": True, "runs": ["setup"], "statusResponses": [{"code": 401}]})
        self.assertEqual((out["posts"], out["triggers"]), ([], []))
        # An old server without the status route (404) doesn't stop the run.
        out = self.run_script({"files": files, "docsFails": True, "runs": ["syncMeetings"],
                               "statusResponses": [{"code": 404, "body": {"detail": "Not Found"}}, {"code": 404, "body": {}}]})
        self.assertEqual([p["body"]["file_id"] for p in out["posts"]], [FID_T])

    def test_waits_for_a_doc_still_being_written(self):
        just = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        files = [{"id": FID_N, "name": NOTES, "created": just, "modified": just, "text": "Summary\nok"}]
        out = self.run_script({"files": files, "docsFails": True, "runs": ["syncMeetings"], "responses": [200]})
        self.assertEqual((out["posts"], out["sent"]), ([], []))   # Gemini may still be writing it: next run

    # ── v4: Gemini's notes Doc is made when the call starts and filled in when it ends ──────────

    NOW = "2026-11-06T10:00:00.000Z"

    def at(self, minutes: float) -> str:
        """NOW + minutes, ISO (negative: earlier)."""
        t = datetime(2026, 11, 6, 10, tzinfo=timezone.utc) + timedelta(minutes=minutes)
        return t.isoformat().replace("+00:00", "Z")

    def test_gemini_notes_doc_waits_then_arrives_then_updates(self):
        not_ready = {"code": 200, "body": {"status": "not_ready"}}
        files = [{"id": FID_N, "name": NOTES, "created": self.at(-40), "modified": self.at(-39), "text": "Notes\nInvited Ada"}]
        fill = f"__files[0].modified = new Date(Date.now() - 6 * 60000).toISOString(); __files[0].text = 'filled'"
        edit = f"__files[0].modified = new Date(Date.now() - 6 * 60000).toISOString(); __files[0].text = 'edited'"
        out = self.run_script({"now": self.NOW, "files": files, "docsFails": True, "runGapMs": 5 * 60000,
                               "responses": [not_ready, 200, {"code": 200, "body": {"status": "updated"}}],
                               "runs": ["syncMeetings",            # empty Doc (the call is on): not ready, remembered
                                        "syncMeetings",            # unchanged: not sent again
                                        fill, "syncMeetings",      # Gemini filled it in: sent, imported
                                        "syncMeetings",            # unchanged: nothing
                                        edit, "syncMeetings",      # someone edited the notes: sent again (updated)
                                        "syncMeetings"]})
        self.assertEqual([p["body"]["text"] for p in out["posts"]], ["Notes\nInvited Ada", "filled", "edited"])
        self.assertEqual(out["sent"], [FID_N])
        self.assertNotIn("wait:" + FID_N, out["props"])
        self.assertIn('"Weekly product sync - 2026/11/04 10:00 GMT+05:30 - Notes by Gemini" has no notes or transcript in it '
                      'yet: sent again when Google fills it in.', out["logs"])
        done = [s for s in out["statuses"] if s["phase"] == "done"]
        self.assertEqual((done[0]["results"]["not_ready"], done[0]["sent"]), (1, 0))
        self.assertEqual(done[1]["skipped"]["not_ready"], 1)
        self.assertEqual((done[4]["results"]["updated"], done[4]["sent"]), (1, 1))
        self.assertEqual(done[5]["skipped"]["already_sent"], 1)
        # A Doc Google keeps changing is sent again at most 5 times.
        runs = []
        for i in range(9):
            runs += [f"__files[0].modified = new Date(Date.now() - 6 * 60000).toISOString(); __files[0].text = 'v{i}'", "syncMeetings"]
        out = self.run_script({"now": self.NOW, "files": files, "docsFails": True, "runGapMs": 5 * 60000, "runs": runs})
        self.assertEqual([p["body"]["text"] for p in out["posts"]], ["v0", "v1", "v2", "v3", "v4", "v5"])

    def test_upgrade_from_v3_sends_its_docs_once_more(self):
        """v3 sent today's Gemini Doc while the call was on and Markdrop ignored it (nothing in it yet); v3
        kept "sent:<id>" = the time and never sent it again. The first v4 run sends it once more (and every
        other Doc v3 sent in the lookback: Markdrop answers duplicate for the unchanged ones), then not again."""
        files = [{"id": FID_N, "name": NOTES, "created": self.at(-90), "modified": self.at(-25), "text": "filled"},
                 {"id": FID_T, "name": TRANSCRIPT, "created": self.at(-30), "modified": self.at(-29), "text": "A: hi\n"}]
        v3_sent = str(int(datetime(2026, 11, 6, 9, 0, tzinfo=timezone.utc).timestamp() * 1000))
        seed = (f"PropertiesService.getScriptProperties().setProperty('sent:{FID_N}', '{v3_sent}');"
                f"PropertiesService.getScriptProperties().setProperty('sent:{FID_T}', '{v3_sent}')")
        out = self.run_script({"now": self.NOW, "files": files, "docsFails": True, "runGapMs": 5 * 60000,
                               "responses": [200, {"code": 200, "body": {"status": "duplicate"}}],
                               "runs": [seed, "setup", "syncMeetings", "syncMeetings"]})
        self.assertEqual(sorted(p["body"]["file_id"] for p in out["posts"]), sorted([FID_N, FID_T]))
        self.assertEqual(out["triggers"], [{"fn": "syncMeetings", "every": 5}])
        self.assertEqual(out["sent"], sorted([FID_N, FID_T]))

    # ── Check now (v4): the web app Markdrop calls ───────────────────────────────

    KEY = "k" * 32

    def post(self, key: str | None) -> str:
        body = json.dumps({} if key is None else {"key": key})
        return f"doPost({{postData: {{contents: {json.dumps(body)}}}}})"

    def test_check_now_runs_a_quick_sync_for_markdrops_key_only(self):
        now = datetime.now(timezone.utc)
        three = (now - timedelta(minutes=3)).isoformat().replace("+00:00", "Z")
        files = [{"id": FID_T, "name": TRANSCRIPT, "created": three, "modified": three, "text": "Ada: hi\nBo: hello\n"}]
        hello = {"code": 200, "body": {"ok": True, "latest_version": 4, "queue": [], "check_key": self.KEY}}
        # Before the script ever heard from Markdrop it has no key: nothing runs.
        out = self.run_script({"files": files, "docsFails": True, "runs": [self.post(self.KEY)]})
        self.assertEqual(out["returns"][0]["body"]["error"], "no_key")
        self.assertEqual((out["statuses"], out["posts"]), ([], []))
        # setup: Markdrop hands it the key; the Doc Google finished 3 min ago waits (a scheduled run waits 10).
        # Check now with a wrong key: nothing; with the key: a quick run sends it and says so.
        out = self.run_script({"files": files, "docsFails": True, "statusResponses": [hello],
                               "runs": ["setup", self.post("wrong"), self.post(None), self.post(self.KEY), self.post(self.KEY)]})
        r = [x["body"] for x in out["returns"]]
        self.assertEqual([x["error"] for x in r[:2]], ["bad_key", "bad_key"])
        self.assertEqual(out["returns"][2]["mime"], "application/json")
        self.assertEqual((r[2]["ok"], r[2]["found"], r[2]["sent"], r[2]["results"]["imported"], r[2]["version"]), (True, 1, 1, 1, 4))
        # At most once a minute.
        self.assertEqual((r[3]["ok"], r[3]["error"]), (False, "too_soon"))
        self.assertGreater(r[3]["retry_in"], 50)
        self.assertEqual([p["body"]["file_id"] for p in out["posts"]], [FID_T])
        self.assertEqual([s["mode"] for s in out["statuses"]], ["setup", "setup", "now", "now"])
        self.assertEqual(out["propValues"]["check_key"], self.KEY)
        # The web app calls with the copy of the token setup keeps (a deployment of an older copy of the file).
        self.assertEqual(out["propValues"]["markdrop_token"], "mdk_" + "A" * 43)
        out = self.run_script({"files": files, "docsFails": True, "statusResponses": [hello],
                               "runs": ["setup", "PropertiesService.getScriptProperties().setProperty('markdrop_token', 'mdk_newer')",
                                        self.post(self.KEY)]})
        self.assertEqual({p["auth"] for p in out["posts"]}, {"Bearer mdk_newer"})
        self.assertEqual(out["statuses"][-1]["auth"], "Bearer mdk_newer")
        # Opening the web app in a browser runs nothing.
        out = self.run_script({"files": files, "runs": ["doGet()"]})
        self.assertIn("Turn on Check now", out["returns"][0]["body"])
        self.assertEqual((out["statuses"], out["posts"]), ([], []))

    def test_check_now_busy_and_disconnected(self):
        hello = {"code": 200, "body": {"ok": True, "latest_version": 4, "queue": [], "check_key": self.KEY}}
        out = self.run_script({"files": [], "statusResponses": [hello], "runs": ["setup"]})
        self.assertEqual(out["triggers"], [{"fn": "syncMeetings", "every": 5}])
        # A scheduled run holds the lock: busy (nothing sent).
        out = self.run_script({"files": [], "locked": True, "runs": [
            f"PropertiesService.getScriptProperties().setProperty('check_key', '{self.KEY}')", self.post(self.KEY)]})
        self.assertEqual(out["returns"][0]["body"]["error"], "busy")
        # The token was replaced (401): the web app says so and leaves the schedule alone (the deployment may
        # run an older copy of the file); a scheduled run still unschedules itself.
        out = self.run_script({"files": [], "statusResponses": [hello, {"code": 200}, {"code": 401}], "runs": ["setup", self.post(self.KEY)]})
        self.assertEqual(out["returns"][0]["body"], {"ok": False, "error": "disconnected", "version": 4})
        self.assertEqual(out["triggers"], [{"fn": "syncMeetings", "every": 5}])


if __name__ == "__main__":
    unittest.main()
