"""Import past meetings + how meetings are organised (services/meeting_backfill*.py,
meeting_series.py, meeting_scope.py; .work/meetings/BACKFILL.md).

Date detection (Google's titles, the Doc's creation day, the text), pairing of notes and
transcripts, series detection, dedupe against meetings already in the workspace (manual, auto,
MCP), silent notifications for bulk / past meetings, the queue (oldest first, resume after a
restart, the meetings_ai cap → waiting → resumes, pause / resume / retry), series on the row and
the page (folder views), list filters, Ask across meetings scoped by series / dates (given or read
from the question) with dates in the prompt and a preference for recent meetings, and the MCP
tool. The model is always the fake client.
"""

from __future__ import annotations

import asyncio
import re
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest import mock

from tests.test_meetings import MeetingsWorld, fixture  # noqa: F401  (pins settings first)
from tests.test_pages_ai import parse_sse, prompt_of

from fastapi import HTTPException

from app.services import ai_usage, background, meeting_backfill as bf, meeting_scope, meetings, meetings_ai
from app.services import meeting_backfill_detect as det
from app.services import meeting_series

TODAY = datetime.now(timezone.utc).date()


def ago(days: int) -> date:
    return TODAY - timedelta(days=days)


def standup(extra: str = "") -> str:
    return ("Ada Lovelace: Morning all, quick standup.\n"
            f"Bo Chen: I will finish the billing migration today{extra}.\n"
            "Priya Sharma: I agree, we decide to ship the API on Friday.\n")


def standup_notes() -> str:
    return ("# Daily Standup\nSummary\nThe team synced on billing and the API.\n\nDetails\n- Billing migration on track.\n"
            "Suggested next steps\n- Bo Chen will finish the billing migration.\n")


def g_title(name: str, d: date, kind: str = "Transcript", hhmm: str = "10:00") -> str:
    return f"{name} – {d:%Y/%m/%d} {hhmm} IST – {kind}"


# ── Pure ──────────────────────────────────────────────────────────────────────


class Detect(unittest.TestCase):
    T = date(2026, 11, 5)

    def test_dates_from_google_titles(self):
        cases = {
            "Daily Standup – 2026/10/28 10:00 IST – Transcript": ("2026-10-28", "10:00", "Daily Standup"),
            "Daily Standup – 2026_10_28 10_00 IST – Transcript.docx": ("2026-10-28", "10:00", "Daily Standup"),
            "Weekly product sync (2026-11-04 10:00 GMT+05:30) - Transcript": ("2026-11-04", "10:00", "Weekly product sync"),
            "Sprint 23 review - 2026/10/28 15:30 GMT+05:30 - Notes by Gemini": ("2026-10-28", "15:30", "Sprint 23 review"),
            "Retro Oct 28, 2026.docx": ("2026-10-28", None, "Retro"),
            "standup_2026-10-27.vtt": ("2026-10-27", None, "standup"),
            "Meeting started 2026/10/28 10:00 IST - Notes by Gemini": ("2026-10-28", "10:00", None),
        }
        for name, (d, t, title) in cases.items():
            got = det.date_of(name, None, None, None, today=self.T)
            self.assertEqual(got, (d, t, "title"), name)
            self.assertEqual(det.title_from_name(name), title, name)
        self.assertIsNone(det.title_from_name("Pasted text"))
        self.assertIsNone(det.title_from_name("transcript.txt"))

    def test_date_fallbacks(self):
        # The Doc's creation day, then the text; never a future or ancient date.
        self.assertEqual(det.date_of("Standup", "2026-10-01", "2026-10-02", "09:00", today=self.T), ("2026-10-01", None, "created"))
        self.assertEqual(det.date_of("Standup", None, "2026-10-02", "09:00", today=self.T), ("2026-10-02", "09:00", "content"))
        self.assertEqual(det.date_of("Standup", None, "2030-10-02", None, today=self.T), (None, None, None))
        self.assertEqual(det.date_of("Standup 1990-01-01", None, None, None, today=self.T), (None, None, None))
        self.assertEqual(det.date_of("Plan 2031-01-01", "2026-09-09", None, None, today=self.T), ("2026-09-09", None, "created"))

    def test_pairing(self):
        I = det.Item
        items = [I("a", "transcript", "Daily Standup", "2026-10-28", "10:00"),
                 I("b", "notes", "Daily Standup", "2026-10-29", "10:00"),
                 I("c", "notes", "Daily Standup", "2026-10-28", "10:05"),
                 I("d", "transcript", "Daily Standup", "2026-10-29", "10:01"),
                 I("e", "both", "Retro", "2026-10-29", None),
                 I("f", "transcript", "Weekly sync", "2026-10-29", None),
                 I("g", "notes", "Weekly sync with Acme", "2026-10-29", None),
                 I("h", "transcript", "Daily Standup", "2026-10-28", "16:00"),   # a second call that day
                 I("i", "notes", "Daily Standup", "2026-10-28", "16:10"),
                 I("j", "transcript", "Planning", None, None),
                 I("k", "notes", "Planning", "2026-10-28", None),               # dated: not with the undated one
                 I("l", "transcript", "Daily Standup", "2026-10-28", "10:00")]   # never two transcripts
        groups = [[x.id for x in g] for g in det.pair(items)]
        self.assertEqual(groups, [["a", "c"], ["b", "d"], ["e"], ["f", "g"], ["h", "i"], ["j"], ["k"], ["l"]])

    def test_series(self):
        self.assertEqual(det.series_label("Sprint 23 review"), "Sprint review")
        self.assertEqual(det.series_key("Sprint 23 review"), det.series_key("Sprint 24 Review"))
        self.assertEqual(det.series_key("Daily Standup"), det.series_key("Daily standups"))
        self.assertEqual(det.series_key("Weekly sync #12"), "weekly sync")
        self.assertEqual(det.series_key("1:1 Ada / Bo"), "1:1 ada bo")
        self.assertEqual(det.series_key("Copy of Daily Standup"), "daily standup")
        self.assertNotEqual(det.series_key("Design review"), det.series_key("Sprint review"))
        self.assertEqual(det.pick_label(["Daily Standup", "Daily standup", "Daily Standup"]), "Daily Standup")
        C = __import__("collections").Counter
        e = {"series": C(), "rows": 1, "loose": [], "dates": {"2026-10-27"}}
        self.assertIsNone(meeting_series.decide("acme kickoff", "Acme kickoff", None, dates={"2026-10-28"}))
        # A name seen on two different days is a series; two calls on one day aren't.
        self.assertEqual(meeting_series.decide("daily standup", "Daily Standup", e, dates={"2026-10-28"}), "Daily Standup")
        self.assertIsNone(meeting_series.decide("daily standup", "Daily Standup", e, dates={"2026-10-27"}))
        self.assertEqual(meeting_series.decide("daily standup", "Daily Standup", None, dates={"2026-10-27", "2026-10-28"}), "Daily Standup")
        e2 = {"series": C({"Standup": 3}), "rows": 3, "loose": [], "dates": set()}
        self.assertEqual(meeting_series.decide("daily standup", "Daily Standup", e2), "Standup")
        self.assertTrue(meeting_series.auto_restricted([{"name": "Ada"}, {"name": "Bo"}]))
        self.assertFalse(meeting_series.auto_restricted([{"name": "Ada"}, {"name": "Bo"}, {"name": "Cy"}]))
        self.assertFalse(meeting_series.auto_restricted([]))

    def test_estimate_and_past(self):
        self.assertAlmostEqual(det.estimate_usd(54_000, False), 0.00234, places=5)   # ~1 h call
        self.assertEqual(det.estimate_usd(0, True), det.NOTES_ONLY_USD)
        self.assertEqual(det.estimate_usd(0, False), 0.0)
        now = datetime(2026, 11, 5, 12, 0, tzinfo=timezone.utc)
        self.assertTrue(bf.is_past("2026-11-03", None, now=now))
        self.assertTrue(bf.is_past("2026-11-04", "10:00", now=now))
        self.assertFalse(bf.is_past("2026-11-04", "13:00", now=now))
        self.assertFalse(bf.is_past("2026-11-04", None, now=now))   # the end of that day: not a day ago yet
        self.assertFalse(bf.is_past("2026-11-05", None, now=now))
        self.assertFalse(bf.is_past(None, None, now=now))


class Scope(unittest.TestCase):
    T = date(2026, 11, 5)   # a Thursday

    def test_dates_from_question(self):
        f = meeting_scope.dates_from
        self.assertEqual(f("what happened last month?", self.T), ("2026-10-01", "2026-10-31"))
        self.assertEqual(f("decisions this week", self.T), ("2026-11-02", "2026-11-05"))
        self.assertEqual(f("decisions last week", self.T), ("2026-10-26", "2026-11-01"))
        self.assertEqual(f("anything yesterday?", self.T), ("2026-11-04", "2026-11-04"))
        self.assertEqual(f("in the last 10 days", self.T), ("2026-10-26", "2026-11-05"))
        self.assertEqual(f("what did we say in October", self.T), ("2026-10-01", "2026-10-31"))
        self.assertEqual(f("since sept", self.T), ("2026-09-01", "2026-11-05"))
        self.assertEqual(f("in December", self.T), ("2025-12-01", "2025-12-31"))    # the last one that happened
        self.assertEqual(f("what did we decide about pricing?", self.T), (None, None))

    def test_series_from_question(self):
        names = ["Daily Standup", "Sprint review", "Design review"]
        sf = meeting_scope.series_from
        self.assertEqual(sf("what came up in Daily Standups last month?", names), "Daily Standup")
        self.assertEqual(sf("blockers raised in standups", names), "Daily Standup")
        self.assertEqual(sf("what did the sprint reviews decide", names), "Sprint review")
        self.assertIsNone(sf("what did the reviews decide", names))     # "review": two series, and generic
        self.assertIsNone(sf("pricing?", names))
        s = meeting_scope.from_question("in Daily Standups last month", names, self.T)
        self.assertEqual((s.series, s.since, s.until, s.detected), ("Daily Standup", "2026-10-01", "2026-10-31", True))
        self.assertEqual(s.label(), "Daily Standup · October 2026")

    def test_recent_and_checks(self):
        self.assertTrue(meeting_scope.wants_recent("What's the latest on pricing?"))
        self.assertTrue(meeting_scope.wants_recent("Is the release still on Friday?"))
        self.assertFalse(meeting_scope.wants_recent("What happened last month?"))
        with self.assertRaises(ValueError):
            meeting_scope.checked(None, "2026-10-31", "2026-10-01")
        with self.assertRaises(ValueError):
            meeting_scope.checked(None, "Oct 1", None)
        self.assertEqual(meeting_scope.day_label("2026-10-28"), "Wed 28 Oct 2026")
        self.assertEqual(meeting_scope.range_label("2026-10-26", "2026-11-01"), "Oct 26 – Nov 1, 2026")


# ── The world ─────────────────────────────────────────────────────────────────


class BackfillWorld(MeetingsWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await bf.ensure_indexes(self.db)

    async def asyncTearDown(self):
        for t in list(bf._tasks.values()):
            await asyncio.wait({t}, timeout=20)
        await super().asyncTearDown()

    async def settle(self):
        for _ in range(100):
            tasks = [t for t in [*bf._tasks.values(), *meetings._bg] if not t.done()]
            if not tasks:
                return
            await asyncio.wait(tasks, timeout=20)

    async def new_job(self, who="owner", **body) -> dict:
        r = await self.http.post("/api/v1/meetings/backfill", headers=self.session(who), json={"workspace": self.W, **body})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def add(self, job: dict, sources: list[dict], who="owner", **body) -> dict:
        r = await self.http.post(f"/api/v1/meetings/backfill/{job['id']}/sources", headers=self.session(who),
                                 json={"sources": sources, **body})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def call(self, method: str, path: str, who="owner", **kw):
        return await self.http.request(method, f"/api/v1/meetings/backfill{path}", headers=self.session(who), **kw)

    async def run_to_end(self, job_id: str) -> dict:
        await self.settle()
        await bf.run(self.db, job_id)
        await self.settle()
        r = await self.call("GET", f"/{job_id}")
        return r.json()

    def standups(self, days=(3, 2, 1)) -> list[dict]:
        return [{"name": g_title("Daily Standup", ago(d)), "text": standup(f" ({d})")} for d in days]


class Review(BackfillWorld):
    async def test_review_dates_pairs_series_and_duplicates(self):
        # Already here: the weekly sync's transcript (by hand), so the call's notes + transcript attach to it,
        # and a standup imported by hand is a duplicate.
        have = await self.imported()
        st3 = self.standups((3,))[0]
        had = await self.imported(sources=[{**st3, "origin": "upload"}])
        job = await self.new_job()
        self.assertEqual(job["state"], "draft")
        self.assertTrue(job["quiet"])
        srcs = [
            *self.standups((3, 2)),
            {"name": g_title("Daily Standup", ago(2), "Notes by Gemini", "10:02"), "text": standup_notes()},
            {"name": "Weekly product sync - 2026/11/04 10:00 GMT+05:30 - Notes by Gemini", "text": fixture("gemini_notes.txt")},
            {"name": "Weekly product sync (2026-11-04 10:00 GMT+05:30) - Transcript", "text": fixture("google_meet_transcript.txt")},
            {"name": "notes.txt", "text": "Ada: hello there\nBo: hi Ada, all good\n"},
            {"name": "empty.txt", "text": "   "},
        ]
        v = await self.add(job, srcs)
        rows = v["rows"]
        self.assertEqual(len(rows), 4)                     # 2 standups (one paired), the sync (paired), undated
        by = {(r["title"], r["date"]): r for r in rows}
        paired = by[("Daily Standup", ago(2).isoformat())]
        self.assertEqual(paired["kinds"], ["notes", "transcript"])
        self.assertEqual(len(paired["names"]), 2)
        self.assertEqual(paired["date_from"], "title")
        self.assertEqual(paired["time"], "10:00")
        self.assertEqual(paired["series"], "Daily Standup")
        sync = next(r for r in rows if r["title"] == "Weekly product sync")
        self.assertEqual((sync["kinds"], sync["dup"]["status"], sync["dup"]["meeting_id"]),
                         (["notes", "transcript"], "attach", have["id"]))
        self.assertTrue(sync["include"])
        dupe = by[("Daily Standup", ago(3).isoformat())]
        self.assertEqual((dupe["dup"]["status"], dupe["dup"]["meeting_id"], dupe["include"]), ("duplicate", had["id"], False))
        undated = next(r for r in rows if r["date"] is None)
        self.assertTrue(undated["needs_date"])
        self.assertEqual(v["counts"]["needs_date"], 1)
        self.assertEqual([p["name"] for p in v["problems"]], ["empty.txt"])
        # Undated rows come first so they're seen; then by date.
        self.assertIsNone(rows[0]["date"])
        self.assertEqual([r["date"] for r in rows[1:]], sorted(r["date"] for r in rows[1:]))
        self.assertGreater(v["estimate"]["usd"], 0)
        # The same text again is skipped; the draft is the one the person had open.
        again = await self.new_job()
        self.assertEqual(again["id"], job["id"])
        v = await self.add(job, [self.standups((3,))[0]])
        self.assertEqual(len(v["rows"]), 4)
        self.assertEqual(v["problems"][-1]["error"], "The same text is already in this import.")
        # Start needs every included row dated; fixing the date (and title, series) in the review works.
        r = await self.call("POST", f"/{job['id']}/start")
        self.assertEqual(r.status_code, 422)
        self.assertIn("need a date", r.json()["detail"])
        r = await self.call("PATCH", f"/{job['id']}", json={"rows": [{"id": undated["id"], "date": ago(9).isoformat(),
                                                                       "title": "Hello sync", "series": "Hellos"}]})
        self.assertEqual(r.status_code, 200, r.text)
        fixed = next(x for x in r.json()["rows"] if x["id"] == undated["id"])
        self.assertEqual((fixed["date"], fixed["date_from"], fixed["title"], fixed["series"], fixed["needs_date"]),
                         (ago(9).isoformat(), "user", "Hello sync", "Hellos", False))
        r = await self.call("PATCH", f"/{job['id']}", json={"rows": [{"id": undated["id"], "date": (TODAY + timedelta(days=5)).isoformat()}]})
        self.assertEqual(r.status_code, 422)
        # Someone else's import is 404.
        r = await self.call("GET", f"/{job['id']}", who="wm")
        self.assertEqual(r.status_code, 404)
        r = await self.call("POST", f"/{job['id']}/sources", who="wm", json={"sources": [{"name": "x", "text": "Ada: hi"}]})
        self.assertEqual(r.status_code, 404)

    async def test_duplicates_of_auto_and_picked_docs(self):
        # A call the Google Meet script brought in (via inbox), and a Google Doc picked earlier (its Drive id).
        user = await bf._owner(self.db, {"user_id": self.uid["owner"], "workspace_id": self.W})
        name = g_title("Ops sync", ago(4))
        await meetings.import_meetings(self.db, user, self.W, [meetings.Incoming(name=name, text=standup(), origin="google",
                                                                                  file_id="1AutoDocAbcdefghijklmnop")],
                                       via="inbox", dedupe="all", wait=True, notify=False)
        job, _ = await bf.create_job(self.db, user, self.W)
        job = await bf.add_sources(self.db, job, [
            {"name": name, "text": standup() + "Ada Lovelace: (a re-export, edited)\n", "origin": "upload"},   # same call by name/date/time
            {"name": "Picked again", "text": standup(" and more"), "origin": "google", "file_id": "1AutoDocAbcdefghijklmnop",
             "created": ago(30).isoformat()},
        ])
        dups = sorted((r["dup"]["status"], r["dup"].get("why")) for r in job["rows"])
        self.assertEqual(dups, [("duplicate", "call"), ("duplicate", "file")])
        self.assertTrue(all(not r["include"] for r in job["rows"]))
        with self.assertRaises(HTTPException) as cm:
            await bf.start(self.db, job)
        self.assertEqual(cm.exception.status_code, 422)

    async def test_viewer_cant_import(self):
        r = await self.http.post("/api/v1/meetings/backfill", headers=self.session("wv"), json={"workspace": self.W})
        self.assertEqual(r.status_code, 403)
        r = await self.http.post("/api/v1/meetings/backfill", headers=self.session("stranger"), json={"workspace": self.W})
        self.assertEqual(r.status_code, 404)


class Queue(BackfillWorld):
    async def test_imports_oldest_first_quietly_with_series_and_folder_views(self):
        job = await self.new_job()
        await self.add(job, self.standups((1, 30, 12)) + [{"name": g_title("Acme kickoff", ago(20)), "text": standup()}])
        order = []
        real = meetings.import_meetings

        async def spy(db, user, ws, incoming, **kw):
            order.append(kw["date_"])
            self.assertEqual(kw["via"], "backfill")
            self.assertFalse(kw["notify"])
            return await real(db, user, ws, incoming, **kw)

        with mock.patch.object(meetings, "import_meetings", spy):
            r = await self.call("POST", f"/{job['id']}/start")
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["state"], "running")
            v = await self.run_to_end(job["id"])
        self.assertEqual(order, sorted(order))                       # oldest first
        self.assertEqual(v["state"], "done")
        self.assertEqual(v["counts"]["imported"], 4)
        rows = await self.db[meetings.COLL].find({"workspace_id": self.W}).sort("date", 1).to_list(10)
        self.assertEqual([r["date"] for r in rows], sorted(ago(d).isoformat() for d in (30, 20, 12, 1)))
        self.assertEqual({r["title"]: r["series"] for r in rows}, {"Daily Standup": "Daily Standup", "Acme kickoff": None})
        self.assertTrue(all(r["history"] for r in rows))
        self.assertTrue(all((r["ai"] or {}).get("state") == "done" for r in rows))
        # Action items mention members, but nobody was notified (bulk = quiet by default).
        page = await self.doc(rows[-1]["slug"])
        self.assertIn(":person[Ravi Kumar]", page["content"])
        self.assertIn('series: "Daily Standup"', page["content"])
        self.assertEqual(await self.db["notifications"].count_documents({}), 0)
        # The folders: Meetings/Daily Standup (a Series option there) and Meetings/Other meetings, with the views.
        folder = await self.db["folders"].find_one({"workspace_id": self.W, "meetings": True})
        subs = {f["name"]: f async for f in self.db["folders"].find({"parent_id": str(folder["_id"])})}
        self.assertEqual(set(subs), {"Daily Standup", "Other meetings"})
        self.assertEqual({r["title"]: r["folder_id"] for r in rows},
                         {"Daily Standup": str(subs["Daily Standup"]["_id"]), "Acme kickoff": str(subs["Other meetings"]["_id"])})
        docs = await self.db["documents"].find({"meeting_role": "page", "workspace_id": self.W}).to_list(10)
        self.assertTrue(all(d["folder_id"] == next(r["folder_id"] for r in rows if r["doc_id"] == d["_id"]) for d in docs))
        props = {p["key"]: p for p in subs["Daily Standup"]["properties"]}
        self.assertEqual([o["name"] for o in props["series"]["options"]], ["Daily Standup"])
        self.assertEqual(subs["Daily Standup"]["meetings_series"], "daily standup")
        self.assertEqual([v_["id"] for v_ in subs["Daily Standup"]["views"]], [meeting_series.VIEW_ALL])
        self.assertEqual(subs["Other meetings"]["views"][0]["group"], "date")
        self.assertEqual(folder.get("views") or [], [])                     # Meetings itself opens on its folders
        views = {v_["id"]: v_ for v_ in subs["Other meetings"]["views"]}
        self.assertEqual(views[meeting_series.VIEW_ALL]["group"], "date")
        self.assertEqual(views[meeting_series.VIEW_ALL]["sort"], [{"key": "date", "dir": "desc"}])
        self.assertEqual((views[meeting_series.VIEW_BOARD]["type"], views[meeting_series.VIEW_BOARD]["group"]), ("board", "series"))
        self.assertEqual(views[meeting_series.VIEW_TABLE]["group"], "series")
        # The hub's list: by series, by date range; the series endpoint.
        r = await self.http.get("/api/v1/meetings", headers=self.session("wm"),
                                params={"workspace": self.W, "series": "daily standup"})
        self.assertEqual(len(r.json()["meetings"]), 3)
        self.assertEqual(r.json()["meetings"][0]["series"], "Daily Standup")
        r = await self.http.get("/api/v1/meetings", headers=self.session("wm"),
                                params={"workspace": self.W, "since": ago(25).isoformat(), "until": ago(5).isoformat()})
        self.assertEqual({m["date"] for m in r.json()["meetings"]}, {ago(20).isoformat(), ago(12).isoformat()})
        r = await self.http.get("/api/v1/meetings", headers=self.session("wm"), params={"workspace": self.W, "series": "none"})
        self.assertEqual([m["title"] for m in r.json()["meetings"]], ["Acme kickoff"])
        r = await self.http.get("/api/v1/meetings/series", headers=self.session("wm"), params={"workspace": self.W})
        self.assertEqual(r.json()["series"], [{"name": "Daily Standup", "count": 3, "last": ago(1).isoformat()}])
        # A finished import can be dismissed.
        r = await self.call("DELETE", f"/{job['id']}")
        self.assertEqual(r.json()["deleted"], True)
        self.assertEqual(await self.db[bf.SOURCES].count_documents({}), 0)

    async def test_notify_switch_off_still_quiet_for_past_meetings(self):
        job = await self.new_job(quiet=False)
        now_ = datetime.now(timezone.utc)
        recent = now_ - timedelta(hours=2)
        await self.add(job, [
            {"name": f"Release sync – {recent:%Y/%m/%d %H:%M} UTC – Transcript", "text": fixture("google_meet_transcript.txt")},
            {"name": g_title("Old sync", ago(40)), "text": fixture("google_meet_transcript.txt").replace("Okay", "Right")},
        ])
        await self.call("POST", f"/{job['id']}/start")
        v = await self.run_to_end(job["id"])
        self.assertEqual(v["counts"]["imported"], 2)
        notes = await self.db["notifications"].find({}).to_list(50)
        pages = {n["doc_id"] for n in notes}
        rows = {r["title"]: r async for r in self.db[meetings.COLL].find({"workspace_id": self.W})}
        self.assertTrue(notes)                                         # the recent one notified…
        self.assertEqual(pages, {str(rows["Release sync"]["doc_id"])})  # …the 40-day-old one didn't
        self.assertFalse(rows["Release sync"].get("history"))
        self.assertTrue(rows["Old sync"]["history"])

    async def test_resume_after_a_restart(self):
        job = await self.new_job()
        await self.add(job, self.standups((5, 4)))
        with mock.patch.object(bf, "kick", lambda db, job: None):       # the process "dies" before running it
            await self.call("POST", f"/{job['id']}/start")
        row = await self.db[bf.JOBS].find_one({"_id": bf._oid(job["id"])})
        first = min(row["rows"], key=lambda r: r["order"])
        # It had imported the first meeting, and died before recording it; its lease is someone else's, lapsed.
        user = await bf._owner(self.db, row)
        srcs = await self.db[bf.SOURCES].find({"_id": {"$in": [bf.ObjectId(s) for s in first["source_ids"]]}}).to_list(5)
        await meetings.import_meetings(self.db, user, self.W, [meetings.Incoming(name=s["name"], text=s["text"], origin="upload") for s in srcs],
                                       title=first["title"], date_=first["date"], wait=True, via="backfill", dedupe="all", notify=False)
        await self.db[bf.JOBS].update_one({"_id": row["_id"]}, {"$set": {
            "lease": {"holder": "other:1", "until": datetime.now(timezone.utc) - timedelta(seconds=1)},
            "rows.$[r].state": "importing", "rows.$[r].attempts": 1,
            "rows.$[r].started_at": datetime.now(timezone.utc) - timedelta(minutes=1)}}, array_filters=[{"r.id": first["id"]}])
        # Someone else holds a live lease: nothing happens here.
        await self.db[bf.JOBS].update_one({"_id": row["_id"]}, {"$set": {"lease.until": datetime.now(timezone.utc) + timedelta(minutes=3)}})
        self.assertEqual(await bf.run(self.db, job["id"]), "busy")
        await self.db[bf.JOBS].update_one({"_id": row["_id"]}, {"$set": {"lease.until": datetime.now(timezone.utc) - timedelta(seconds=1)}})
        # The hub polling it picks it up (the e2e stack runs without background workers).
        r = await self.call("GET", f"/{job['id']}")
        self.assertEqual(r.status_code, 200)
        v = await self.run_to_end(job["id"])
        self.assertEqual(v["state"], "done")
        self.assertEqual([x["state"] for x in sorted(v["rows"], key=lambda x: x["order"])], ["imported", "imported"])
        self.assertEqual(await self.db[meetings.COLL].count_documents({"workspace_id": self.W}), 2)   # not imported twice

    async def test_background_pass_picks_up_a_lapsed_job(self):
        job = await self.new_job()
        await self.add(job, self.standups((6,)))
        with mock.patch.object(bf, "kick", lambda db, job: None):
            await self.call("POST", f"/{job['id']}/start")
        await background._meetings_backfill(self.db)
        await self.settle()
        j = await self.db[bf.JOBS].find_one({"_id": bf._oid(job["id"])})
        self.assertEqual(j["state"], "done")

    async def test_cap_waits_until_it_resets(self):
        job = await self.new_job()
        await self.add(job, self.standups((8, 7)))
        with mock.patch.object(meetings_ai, "generate_reason", mock.AsyncMock(return_value="daily")):
            await self.call("POST", f"/{job['id']}/start")
            await self.settle()
            v = (await self.call("GET", f"/{job['id']}")).json()
        self.assertEqual(v["state"], "waiting")
        self.assertEqual(v["wait"]["reason"], "daily")
        until = datetime.fromisoformat(v["wait"]["until"].replace("Z", "+00:00"))
        self.assertEqual(until.date(), datetime.now(timezone.utc).date() + timedelta(days=1))
        self.assertEqual(v["counts"]["imported"], 0)
        self.assertIn("Try again tomorrow", v["wait"]["message"])
        # Midnight passes: the next look wakes it and it carries on.
        await self.db[bf.JOBS].update_one({"_id": bf._oid(job["id"])}, {"$set": {"wait.until": datetime.now(timezone.utc) - timedelta(seconds=1)}})
        await self.call("GET", f"/{job['id']}")
        v = await self.run_to_end(job["id"])
        self.assertEqual((v["state"], v["counts"]["imported"]), ("done", 2))

    async def test_ai_off_imports_without_summaries(self):
        settings_off = mock.patch.object(meetings_ai, "configured", lambda: False)
        job = await self.new_job()
        await self.add(job, self.standups((8,)))
        with settings_off:
            v = (await self.call("GET", f"/{job['id']}")).json()
            self.assertFalse(v["estimate"]["ai"])
            await self.call("POST", f"/{job['id']}/start")
            v = await self.run_to_end(job["id"])
        self.assertEqual(v["counts"]["imported"], 1)
        row = await self.db[meetings.COLL].find_one({"workspace_id": self.W})
        self.assertEqual(row["ai"]["state"], "skipped")

    async def test_pause_resume_retry_and_stop(self):
        job = await self.new_job()
        await self.add(job, self.standups((10, 9, 8)))
        real = meetings.import_meetings
        calls = {"n": 0}

        async def flaky(*a, **kw):
            calls["n"] += 1
            if calls["n"] == 1:
                raise HTTPException(status_code=422, detail="Boom: the parser choked.")
            return await real(*a, **kw)

        with mock.patch.object(bf, "kick", lambda db, job: None):
            await self.call("POST", f"/{job['id']}/start")
            r = await self.call("POST", f"/{job['id']}/pause")
            self.assertEqual(r.json()["state"], "paused")
            self.assertEqual(await bf.run(self.db, job["id"]), "busy")     # paused: nothing runs
            r = await self.call("POST", f"/{job['id']}/resume")
            self.assertEqual(r.json()["state"], "running")
        with mock.patch.object(meetings, "import_meetings", flaky):
            v = await self.run_to_end(job["id"])
        self.assertEqual(v["state"], "done")
        failed = [x for x in v["rows"] if x["state"] == "failed"]
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0]["error"], "Boom: the parser choked.")
        self.assertEqual(failed[0]["date"], ago(10).isoformat())           # the oldest went first
        self.assertEqual(v["counts"]["imported"], 2)
        r = await self.call("POST", f"/{job['id']}/rows/{failed[0]['id']}/retry")
        self.assertEqual(r.json()["state"], "running")
        v = await self.run_to_end(job["id"])
        self.assertEqual((v["state"], v["counts"]["imported"], v["counts"]["failed"]), ("done", 3, 0))
        # Stopping a running import keeps what was imported.
        job2 = await self.new_job()
        await self.add(job2, self.standups((15,)))
        with mock.patch.object(bf, "kick", lambda db, job: None):
            await self.call("POST", f"/{job2['id']}/start")
        r = await self.call("DELETE", f"/{job2['id']}")
        self.assertEqual(r.json(), {"deleted": False, "stopped": True, "id": job2["id"]})
        self.assertEqual(await bf.run(self.db, job2["id"]), "busy")
        self.assertEqual(await self.db[meetings.COLL].count_documents({"workspace_id": self.W}), 3)


class Organise(BackfillWorld):
    async def test_series_detected_on_single_imports_and_editable(self):
        a = await self.imported(sources=[{"name": g_title("Design crit", ago(9)), "text": standup()}])
        self.assertIsNone(a["series"])                                 # a one-off, so far
        b = await self.imported(sources=[{"name": g_title("Design crit", ago(2)), "text": standup(" again")}])
        self.assertEqual(b["series"], "Design crit")
        row_a = await self.db[meetings.COLL].find_one({"_id": bf._oid(a["id"])})
        self.assertEqual((row_a["series"], row_a["series_from"]), ("Design crit", "auto"))     # adopted
        page_a = await self.doc(a["slug"])
        self.assertIn('series: "Design crit"', page_a["content"])
        self.assertEqual(int(page_a["rev"]), int(row_a["base_rev"]))    # still "untouched since import"
        # A person renames it: the row and the page; later namesakes join the renamed series.
        r = await self.http.patch(f"/api/v1/meetings/{b['id']}", headers=self.session("owner"), json={"series": "Design reviews"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["series"], "Design reviews")
        self.assertIn('series: "Design reviews"', (await self.doc(b["slug"]))["content"])
        c = await self.imported(sources=[{"name": g_title("Design crit", ago(1)), "text": standup(" thrice")}])
        self.assertIn(c["series"], ("Design crit", "Design reviews"))
        # Taking a meeting out of its series sticks (detection won't put it back).
        r = await self.http.patch(f"/api/v1/meetings/{a['id']}", headers=self.session("owner"), json={"series": None})
        self.assertIsNone(r.json()["series"])
        row_a = await self.db[meetings.COLL].find_one({"_id": bf._oid(a["id"])})
        self.assertEqual(row_a["series_from"], "user")
        n = await meeting_series.adopt(self.db, await bf._owner(self.db, {"user_id": self.uid["owner"], "workspace_id": self.W}),
                                       self.W, det.series_key("Design crit"), "Design crit")
        self.assertEqual(n, 0)
        # A viewer can't change it.
        r = await self.http.patch(f"/api/v1/meetings/{b['id']}", headers=self.session("wv"), json={"series": "X"})
        self.assertEqual(r.status_code, 403)

    async def folder_name(self, row_or_id) -> str:
        r = row_or_id if isinstance(row_or_id, dict) else await self.db[meetings.COLL].find_one({"_id": bf._oid(row_or_id)})
        f = await self.db["folders"].find_one({"_id": bf._oid(r["folder_id"])})
        page = await self.db["documents"].find_one({"_id": r["doc_id"]})
        self.assertEqual(page["folder_id"], r["folder_id"])          # the page is where the row says
        return f["name"]

    async def test_placement_series_folders_and_moves(self):
        a = await self.imported(sources=[{"name": g_title("Daily Sync Up", ago(9)), "text": standup()}])
        self.assertEqual(await self.folder_name(a["id"]), "Other meetings")       # a one-off, so far
        b = await self.imported(sources=[{"name": g_title("Daily Sync Up", ago(8)), "text": standup(" two")}])
        self.assertEqual(await self.folder_name(b["id"]), "Daily Sync Up")
        self.assertEqual(await self.folder_name(a["id"]), "Daily Sync Up")        # the earlier one moved in
        sub = await self.db["folders"].find_one({"meetings_series": "daily sync up"})
        # A person renames the folder: it is still that series' folder.
        from app.services import folder as folder_service

        await folder_service.update_folder(self.db, self.W, str(sub["_id"]), name="Sync ups")
        c = await self.imported(sources=[{"name": g_title("Daily Sync Up", ago(7)), "text": standup(" three")}])
        self.assertEqual(await self.folder_name(c["id"]), "Sync ups")
        # A person moves a meeting to another series: it moves to that series' folder (made now).
        r = await self.http.patch(f"/api/v1/meetings/{c['id']}", headers=self.session("owner"), json={"series": "Leads sync"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(await self.folder_name(c["id"]), "Leads sync")
        r = await self.http.patch(f"/api/v1/meetings/{c['id']}", headers=self.session("owner"), json={"series": None})
        self.assertEqual(await self.folder_name(c["id"]), "Other meetings")
        # Two calls of one name on one day aren't a series.
        d1 = await self.imported(sources=[{"name": g_title("Hiring loop", ago(3), hhmm="10:00"), "text": standup(" x")}])
        d2 = await self.imported(sources=[{"name": g_title("Hiring loop", ago(3), hhmm="16:00"), "text": standup(" y")}])
        self.assertEqual({await self.folder_name(d1["id"]), await self.folder_name(d2["id"])}, {"Other meetings"})

    async def test_place_meeting_contract(self):
        from app.services import meeting_place

        # Before the row exists (how every import path asks): the folder only, nothing written.
        fid = await meeting_place.place_meeting(self.db, self.W, {"workspace_id": self.W, "created_by": self.uid["owner"],
                                                                  "title": "Board review", "series": None})
        f = await self.db["folders"].find_one({"_id": bf._oid(fid)})
        self.assertEqual(f["name"], "Other meetings")
        fid2 = await meeting_place.place_meeting(self.db, self.W, {"workspace_id": self.W, "created_by": self.uid["owner"],
                                                                   "title": "Board review", "series": "Board review"})
        f2 = await self.db["folders"].find_one({"_id": bf._oid(fid2)})
        self.assertEqual((f2["name"], f2["meetings_series"]), ("Board review", "board review"))
        self.assertEqual(await meeting_place.place_meeting(self.db, self.W, {"created_by": self.uid["owner"], "series": "board REVIEW"}), fid2)
        # Every import goes through it.
        real, calls = meeting_place.place_meeting, []

        async def spy(db, ws, m):
            calls.append(m.get("_id"))
            return await real(db, ws, m)

        with mock.patch.object(meeting_place, "place_meeting", spy):
            a = await self.imported(sources=[{"name": g_title("Spy call", ago(4)), "text": standup(" spy")}])
        self.assertEqual(calls, [None])
        self.assertEqual(await self.folder_name(a["id"]), "Other meetings")

    async def test_visibility_by_attendees(self):
        two = await self.imported(sources=[{"name": g_title("Ada / Bo", ago(2)), "text": "Ada Lovelace: Hi.\nBo Chen: Hello.\n"}])
        self.assertTrue(two["restricted"])                                         # a two-person call
        three = await self.imported(sources=[{"name": g_title("Trio", ago(2)), "text": standup()}])
        self.assertFalse(three["restricted"])
        forced = await self.imported(sources=[{"name": g_title("Pair", ago(2)), "text": "Ada Lovelace: Hi.\nBo Chen: Yo.\n"}],
                                     restricted=False)
        self.assertFalse(forced["restricted"])
        # The review says so, and a row can be switched.
        job = await self.new_job()
        v = await self.add(job, [{"name": g_title("One to one", ago(5)), "text": "Ada Lovelace: Hi.\nBo Chen: Hello there.\n"},
                                 {"name": g_title("Team call", ago(5)), "text": standup(" z")}])
        by = {r["title"]: r for r in v["rows"]}
        self.assertEqual((by["One to one"]["restricted"], by["One to one"]["restricted_from"]), (True, "auto"))
        self.assertEqual((by["Team call"]["restricted"], by["Team call"]["folder"]), (False, "Other meetings"))
        r = await self.call("PATCH", f"/{job['id']}", json={"rows": [{"id": by["One to one"]["id"], "restricted": False}]})
        self.assertEqual(next(x for x in r.json()["rows"] if x["title"] == "One to one")["restricted"], False)
        await self.call("POST", f"/{job['id']}/start")
        await self.run_to_end(job["id"])
        rows = {m["title"]: m async for m in self.db[meetings.COLL].find({"workspace_id": self.W})}
        self.assertFalse(rows["One to one"]["restricted"])

    async def test_organize_existing_meetings(self):
        # Meetings from before folders: all in the Meetings folder itself, no series.
        ms = [await self.imported(sources=[{"name": g_title("Weekly ops", ago(d)), "text": standup(f" {d}")}]) for d in (20, 13)]
        root = await self.db["folders"].find_one({"workspace_id": self.W, "meetings": True})
        for m in ms:
            await self.db[meetings.COLL].update_one({"_id": bf._oid(m["id"])}, {"$set": {"series": None, "series_from": None,
                                                                                        "folder_id": str(root["_id"])}})
            await self.db["documents"].update_one({"slug": m["slug"]}, {"$set": {"folder_id": str(root["_id"])}})
        r = await self.http.post("/api/v1/meetings/organize", headers=self.session("wm"), json={"workspace": self.W})
        self.assertEqual(r.status_code, 403)                                          # members can't (admins can)
        r = await self.http.post("/api/v1/meetings/organize", headers=self.session("wa"), json={"workspace": self.W})
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertEqual((out["meetings"], out["moved"], out["series_set"]), (2, 2, 2))
        for m in ms:
            self.assertEqual(await self.folder_name(m["id"]), "Weekly ops")
        r = await self.http.post("/api/v1/meetings/organize", headers=self.session("wa"), json={"workspace": self.W})
        self.assertEqual(r.json()["moved"], 0)                                        # idempotent

    async def test_existing_folder_gets_series_property_once(self):
        await self.imported()
        folder = await self.db["folders"].find_one({"workspace_id": self.W, "meetings": True})
        self.assertTrue(folder["meetings_views"])
        self.assertIn("series", [p["key"] for p in folder["properties"]])
        # A person removes the Series property: it is not put back on the next import.
        props = [p for p in folder["properties"] if p["key"] != "series"]
        await self.db["folders"].update_one({"_id": folder["_id"]}, {"$set": {"properties": props}})
        await self.imported(sources=[{"name": "standup.vtt", "text": fixture("teams.vtt")}], title="Daily standup")
        folder = await self.db["folders"].find_one({"_id": folder["_id"]})
        self.assertNotIn("series", [p["key"] for p in folder["properties"]])
        # A v1 folder (no Series) gets it on its next import.
        await self.db["folders"].update_one({"_id": folder["_id"]}, {"$set": {"meetings_views": False}})
        await self.imported(sources=[{"name": "zoom.srt", "text": fixture("zoom.srt")}], title="Zoom call")
        folder = await self.db["folders"].find_one({"_id": folder["_id"]})
        self.assertIn("series", [p["key"] for p in folder["properties"]])


class AskScoped(BackfillWorld):
    async def seed(self):
        job = await self.new_job()
        last_month_end = TODAY.replace(day=1) - timedelta(days=1)
        lm = [last_month_end - timedelta(days=d) for d in (2, 5)]
        await self.add(job, [
            {"name": g_title("Daily Standup", lm[0]), "text": standup(" before the pricing launch")},
            {"name": g_title("Daily Standup", lm[1]), "text": standup(" and the pricing page")},
            {"name": g_title("Pricing review", ago(1)), "text": "Ada Lovelace: The pricing page ships next week.\nBo Chen: I agree on pricing.\n"},
            {"name": g_title("Pricing review", ago(60)), "text": "Ada Lovelace: Pricing is on hold for now.\nBo Chen: The pricing waits for finance.\n"},
        ])
        await self.call("POST", f"/{job['id']}/start")
        v = await self.run_to_end(job["id"])
        self.assertEqual(v["counts"]["imported"], 4)
        from app.services import search_index

        await search_index.drain()
        self.fake.calls.clear()
        return lm

    async def ask(self, question: str, **scope) -> tuple[dict, str]:
        r = await self.http.post("/api/v1/meetings/ask", headers=self.session("wm"),
                                 json={"workspace": self.W, "question": question, **scope})
        evs = parse_sse(r.text)
        self.assertEqual(evs[-1][0], "done", r.text)
        return evs[-1][1], prompt_of(self.fake.calls[-1]) if self.fake.calls else ""

    async def test_scoped_by_series_and_dates(self):
        lm = await self.seed()
        done, p = await self.ask("What did we say about pricing?", series="daily standup")
        titles = set(re.findall(r'<untrusted_meeting n="\d+" title="([^"]+)"', p))
        self.assertEqual(titles, {"Daily Standup"})
        self.assertEqual(done["scope"]["series"], "daily standup")
        self.assertFalse(done["scope"]["detected"])
        self.assertTrue(all(c["meeting_id"] for c in done["citations"]))
        # The date and the series go to the model, and today's date; the model is told to say when and where.
        self.assertIn(f'day="{meeting_scope.day_label(lm[0].isoformat())}"', p)
        self.assertIn('series="Daily Standup"', p)
        self.assertIn(f"Today is {meeting_scope.day_label(TODAY.isoformat())}", p)
        self.assertIn('e.g. "On 28 Oct, in Daily Standup', self.fake.calls[-1]["system"][0]["text"])
        # A date range alone.
        done, p = await self.ask("pricing?", since=ago(2).isoformat(), until=TODAY.isoformat())
        self.assertEqual(set(re.findall(r'<untrusted_meeting n="\d+" title="([^"]+)"', p)), {"Pricing review"})
        self.assertEqual(len(re.findall(r"<untrusted_meeting n=\"\d+\"", p)), 1)
        # Nothing in the range: said plainly, no model call.
        n = len(self.fake.calls)
        done, _ = await self.ask("pricing?", since="2001-01-01", until="2001-01-31")
        self.assertEqual(done["answer"], "There are no meetings you can open in January 2001.")
        self.assertEqual(len(self.fake.calls), n)
        r = await self.http.post("/api/v1/meetings/ask", headers=self.session("wm"),
                                 json={"workspace": self.W, "question": "x?", "since": "yesterday"})
        self.assertEqual(parse_sse(r.text)[-1][1]["code"], "bad_scope")

    async def test_scope_read_from_the_question(self):
        await self.seed()
        done, p = await self.ask("What came up in the Daily Standups last month?")
        self.assertTrue(done["scope"]["detected"])
        self.assertEqual(done["scope"]["series"], "Daily Standup")
        self.assertEqual(set(re.findall(r'<untrusted_meeting n="\d+" title="([^"]+)"', p)), {"Daily Standup"})
        self.assertIn("The meetings were picked from: Daily Standup", p)
        # A series nobody here has is ignored, not a dead end.
        done, p = await self.ask("What did the board meeting say about pricing?")
        self.assertIsNone(done["scope"])
        self.assertGreaterEqual(len(re.findall(r"<untrusted_meeting n=\"\d+\"", p)), 3)

    async def test_latest_prefers_recent_meetings(self):
        await self.seed()
        _done, p = await self.ask("What's the latest on pricing?")
        first = re.search(r'<untrusted_meeting n="1" title="([^"]+)" date="([^"]+)"', p)
        self.assertEqual((first.group(1), first.group(2)), ("Pricing review", ago(1).isoformat()))
        self.assertIn("for \"latest\", \"current\" or \"still\" questions", self.fake.calls[-1]["system"][0]["text"])


class MCPBulk(BackfillWorld):
    async def test_import_meetings_bulk(self):
        tok = await self.mcp_token("owner")
        items = [{"file_name": g_title("Daily Standup", ago(d)), "text": standup(f" {d}")} for d in (4, 3)]
        items.append({"text": "Ada: hello\nBo: hi there\n", "title": "Hallway chat"})               # no date
        items.append({"text": "Ada: kickoff time\nBo: let's go\n", "title": "Kickoff", "date": ago(6).isoformat()})
        code, res = await self.mcp_call(tok, "import_meetings_bulk", {"workspace": self.W, "items": items, "dry_run": True})
        self.assertFalse(res.get("isError"), res)
        sc = res["structuredContent"]
        self.assertIsNone(sc["job"])
        st = {i["title"]: i["status"] for i in sc["items"]}
        self.assertEqual(st, {"Daily Standup": "queued", "Hallway chat": "needs_date", "Kickoff": "queued"})
        self.assertEqual(await self.db[bf.JOBS].count_documents({}), 0)          # a dry run leaves nothing
        self.assertEqual(await self.db[meetings.COLL].count_documents({}), 0)
        code, res = await self.mcp_call(tok, "import_meetings_bulk", {"workspace": self.W, "items": items})
        self.assertFalse(res.get("isError"), res)
        sc = res["structuredContent"]
        self.assertTrue(sc["job"])
        self.assertEqual(sorted(i["status"] for i in sc["items"]), ["needs_date", "queued", "queued", "queued"])
        await self.settle()
        await bf.run(self.db, sc["job"])
        await self.settle()
        code, res = await self.mcp_call(tok, "import_meetings_bulk", {"job": sc["job"]})
        sc = res["structuredContent"]
        self.assertEqual(sc["state"], "done")
        st = sorted((i["title"], i["status"]) for i in sc["items"])
        self.assertEqual(st, [("Daily Standup", "imported"), ("Daily Standup", "imported"), ("Hallway chat", "needs_date"),
                              ("Kickoff", "imported")])
        self.assertTrue(all(i["url"] for i in sc["items"] if i["status"] == "imported"))
        # Again: already here.
        code, res = await self.mcp_call(tok, "import_meetings_bulk", {"workspace": self.W, "items": items[:2], "dry_run": True})
        self.assertEqual({i["status"] for i in res["structuredContent"]["items"]}, {"duplicate"})
        # list_meetings / ask_meetings take the series and dates.
        code, res = await self.mcp_call(tok, "list_meetings", {"workspace": self.W, "series": "Daily Standup"})
        self.assertEqual(len(res["structuredContent"]["meetings"]), 2)
        self.assertEqual(res["structuredContent"]["meetings"][0]["series"], "Daily Standup")
        code, res = await self.mcp_call(tok, "list_meetings", {"workspace": self.W, "until": ago(5).isoformat()})
        self.assertEqual([m["title"] for m in res["structuredContent"]["meetings"]], ["Kickoff"])
        code, res = await self.mcp_call(tok, "ask_meetings", {"workspace": self.W, "question": "billing?", "series": "Daily Standup"})
        self.assertFalse(res.get("isError"), res)
        self.assertEqual(res["structuredContent"]["scope"]["series"], "Daily Standup")
        self.assertTrue(res["content"][0]["text"].startswith("(Meetings in Daily Standup)"))
        # Someone else can't read the job.
        other = await self.mcp_token("wm")
        code, res = await self.mcp_call(other, "import_meetings_bulk", {"job": sc["job"] if sc.get("job") else "x"})
        self.assertTrue(res.get("isError"))


if __name__ == "__main__":
    unittest.main()
