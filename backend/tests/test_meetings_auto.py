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
        # @mentions notify, as with a manual import.
        to = {n["user_id"] for n in await self.db["notifications"].find({}).to_list(50)}
        self.assertIn(self.uid["wv"], to)
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
        tok = (await self.connect())["token"]
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
                                            "token": "mdk_" + "A" * 43, "lookback": 48})
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
            {"id": "1Shared", "name": "Theirs - Transcript", "created": iso(1), "modified": iso(1), "owned": False, "doc": {}},
        ]
        out = self.run_script({"files": files, "runs": ["setup", "syncMeetings"], "responses": [200, 200]})
        # setup scheduled itself once, every 15 minutes, and ran.
        self.assertEqual(out["triggers"], [{"fn": "syncMeetings", "every": 15}])
        self.assertIn("'me' in owners", out["searches"][0])
        self.assertIn("mimeType = 'application/vnd.google-apps.document'", out["searches"][0])
        # Only the two meeting Docs, once each (the second run sent nothing).
        self.assertEqual(sorted(p["body"]["file_id"] for p in out["posts"]), sorted([FID_N, FID_T]))
        self.assertEqual(out["sent"], sorted([FID_N, FID_T]))
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
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
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


if __name__ == "__main__":
    unittest.main()
