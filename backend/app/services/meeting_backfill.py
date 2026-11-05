"""Import past meetings: many transcripts / Gemini notes at once, reviewed, then imported in the
background, oldest first (.work/meetings/BACKFILL.md).

    GET    /api/v1/meetings/backfill?workspace=           the caller's imports here (the open one first)
    POST   /api/v1/meetings/backfill                      {workspace, quiet?, restricted?} → a draft
    POST   /api/v1/meetings/backfill/{id}/sources         add files / pasted texts / Google Docs → the review
    PATCH  /api/v1/meetings/backfill/{id}                 {quiet?, restricted?, rows: [{id, title?, date?, series?, include?}]}
    POST   /api/v1/meetings/backfill/{id}/start | pause | resume
    POST   /api/v1/meetings/backfill/{id}/rows/{row}/retry
    DELETE /api/v1/meetings/backfill/{id}                 discard a draft, stop the rest, or dismiss a finished one

**The review.** Every source is parsed (services/meeting_parse.py) and dated
(meeting_backfill_detect.date_of: the name, else the Google Doc's creation day, else the text); the
notes and the transcript of one call pair into one row; recurring names get a series
(services/meeting_series.py, the workspace's existing series first); each row is checked against
the workspace's meetings (a Google Doc already imported, or the same call with that half: a
duplicate, skipped; the call without that half: attached to it) and against the other rows. Rows
without a date are flagged: the import doesn't start until each included row has one.

**The queue.** Started, the rows import one at a time, oldest first, through the normal import
(``meetings.import_meetings(dedupe="all", wait=True)``, so each AI summary is written before the
next one starts and the ``meetings_ai`` caps are checked row by row). It survives the page closing
and the server restarting: the job holds a lease (renewed per row) and whoever finds it running
with a lapsed lease — the hub polling it, the next Start/Resume, or the background loop — carries
on; a row caught half way is finished, not imported twice (``import_meetings`` dedupes, and a
meeting this job made is recognised as its own).

**Quiet.** A bulk import notifies nobody by default (``quiet``, the review's "Don't notify anyone"
switch); with it off, meetings older than a day still import silently. Mentions stay links.

**The cap.** Before each row: Meetings AI over today's budget (or the person's own daily cap) →
the job waits until the next UTC midnight; over the month's → the 1st; too fast → a minute. AI
off for the workspace or the server → imported without the AI sections, as a single import is.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import secrets
import socket
from datetime import date, datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import meeting_backfill_detect as det
from app.services import meeting_parse as mp
from app.services import meeting_series, meetings

log = logging.getLogger("markdrop.meeting_backfill")

JOBS = "meeting_backfill_jobs"
SOURCES = "meeting_backfill_sources"
MAX_JOB_SOURCES = 300
MAX_ROWS = 200
MAX_ADD = 25
MAX_JOB_CHARS = 40_000_000
LEASE = timedelta(minutes=5)
PAST = timedelta(hours=24)
KEEP_DONE = timedelta(days=30)
OPEN = ("draft", "running", "paused", "waiting")
ACTIVE = ("running", "waiting")
WAIT_REASONS = ("daily", "monthly", "user_daily", "burst")
HOLDER = f"{socket.gethostname()}:{os.getpid()}:{secrets.token_hex(3)}"
ROW_DONE = ("imported", "attached", "duplicate", "skipped")

_tasks: dict[str, asyncio.Task] = {}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[JOBS].create_index([("workspace_id", 1), ("user_id", 1), ("created_at", -1)])
    await db[JOBS].create_index("state")
    await db[SOURCES].create_index([("job_id", 1), ("n", 1)])


def is_past(d: str | None, t: str | None, *, now: datetime | None = None) -> bool:
    """Did the meeting end more than a day ago? (Its date and start time, read as UTC; a date
    without a time counts from the end of that day.)"""
    if not d:
        return False
    try:
        day = date.fromisoformat(d)
    except ValueError:
        return False
    m = re.match(r"^(\d{1,2}):(\d{2})$", t or "")
    at = datetime(day.year, day.month, day.day, int(m.group(1)), int(m.group(2)), tzinfo=timezone.utc) if m \
        else datetime(day.year, day.month, day.day, 23, 59, tzinfo=timezone.utc)
    return (now or now_utc()) - at > PAST


# ── Jobs ──────────────────────────────────────────────────────────────────────


def _oid(v: Any) -> ObjectId | None:
    return meetings.oid(v)


async def get_job(db: AsyncIOMotorDatabase, job_id: str, user_id: str) -> dict:
    """The caller's own job (404 for anyone else's)."""
    j = await db[JOBS].find_one({"_id": _oid(job_id)}) if _oid(job_id) else None
    if j is None or j.get("user_id") != user_id:
        raise HTTPException(status_code=404, detail="That import isn't here anymore.")
    return j


async def create_job(db: AsyncIOMotorDatabase, user, workspace_id: str, *, quiet: bool = True,
                     restricted: bool = False, origin: str = "web") -> tuple[dict, bool]:
    """(job, made_now). The person's open draft in this workspace is reused (the review survives a
    reload); one running import per person and workspace at a time is enough, so a second one
    is refused until the first finishes."""
    from app.services import workspace as ws_service

    await meetings.require_member(db, workspace_id, user.id)
    await ws_service.assert_open(db, workspace_id)
    q = {"workspace_id": workspace_id, "user_id": user.id}
    if origin == "web":
        draft = await db[JOBS].find_one({**q, "state": "draft", "origin": "web"}, sort=[("created_at", -1)])
        if draft is not None:
            return draft, False
    now = now_utc()
    job = {"workspace_id": workspace_id, "user_id": user.id, "state": "draft", "origin": origin,
           "quiet": bool(quiet), "restricted": bool(restricted), "rows": [], "problems": [], "edits": {},
           "created_at": now, "updated_at": now, "started_at": None, "done_at": None, "wait": None,
           "lease": None, "chars": 0, "n_sources": 0}
    res = await db[JOBS].insert_one(job)
    job["_id"] = res.inserted_id
    return job, True


async def jobs_for(db: AsyncIOMotorDatabase, user_id: str, workspace_id: str) -> list[dict]:
    """The person's imports in this workspace that are open or finished but not dismissed, newest first."""
    out = []
    async for j in db[JOBS].find({"workspace_id": workspace_id, "user_id": user_id,
                                  "state": {"$in": [*OPEN, "done"]}}).sort("created_at", -1).limit(5):
        out.append(j)
    return out


# ── Sources → the review ──────────────────────────────────────────────────────


def _sha(text: str) -> str:
    return hashlib.sha256(re.sub(r"\s+", " ", text).strip().encode("utf-8", "replace")).hexdigest()[:32]


async def add_sources(db: AsyncIOMotorDatabase, job: dict, incoming: list[dict], *, today: date | None = None) -> dict:
    """Add sources (``{name, text, origin, file_id?, url?, created?}``) to a draft and rebuild its
    review. A source that is already in this import (the same text) is skipped; one with no
    transcript or notes in it is listed under ``problems``."""
    if job["state"] != "draft":
        raise HTTPException(status_code=409, detail="This import has started: start another one for more files.")
    if len(incoming) > MAX_ADD:
        raise HTTPException(status_code=422, detail=f"Add at most {MAX_ADD} files at a time.")
    have = await db[SOURCES].count_documents({"job_id": job["_id"]})
    shas = {s["sha"] async for s in db[SOURCES].find({"job_id": job["_id"]}, {"sha": 1})}
    chars = int(job.get("chars") or 0)
    problems = list(job.get("problems") or [])
    today = today or now_utc().date()
    n = int(job.get("n_sources") or 0)
    for item in incoming:
        name = str(item.get("name") or "Pasted text")[:200]
        text = str(item.get("text") or "")
        if have >= MAX_JOB_SOURCES:
            problems.append({"name": name, "error": f"An import takes at most {MAX_JOB_SOURCES} files."})
            continue
        if not text.strip():
            problems.append({"name": name, "error": "It's empty."})
            continue
        sha = _sha(text)
        if sha in shas:
            problems.append({"name": name, "error": "The same text is already in this import.", "kind": "repeat"})
            continue
        if chars + len(text) > MAX_JOB_CHARS:
            problems.append({"name": name, "error": "This import is full: import these files in another one."})
            continue
        src = mp.parse_source(name, text)
        if not src.segments and not src.notes:
            problems.append({"name": name, "error": "No transcript or meeting notes found in it."})
            continue
        d, t, d_from = det.date_of(name, item.get("created"), src.date, src.time, today=today)
        # A Google-style name (a date, "- Transcript", "Notes by Gemini") names the meeting best; else the
        # text's own first line does, then whatever the file is called.
        strong = d_from == "title" or bool(det.GOOGLE_NAME.search(name))
        title = (det.title_from_name(name) or src.title) if strong else (src.title or det.title_from_name(name))
        n += 1
        doc = {"job_id": job["_id"], "n": n, "name": name, "text": text, "sha": sha,
               "origin": item.get("origin") or "upload", "file_id": item.get("file_id"), "url": item.get("url"),
               "created": (str(item.get("created") or "")[:40] or None),
               "parsed": {"kind": src.kind, "format": src.format, "title": title, "date": d, "time": t if d else None,
                          "date_from": d_from, "segments": len(src.segments), "has_notes": bool(src.notes),
                          "chars": sum(len(s.get("text") or "") for s in src.segments),
                          "attendees": [a["name"] for a in src.attendees][:30], "truncated": src.truncated}}
        if src.time and d and not doc["parsed"]["time"]:
            doc["parsed"]["time"] = src.time
        await db[SOURCES].insert_one(doc)
        shas.add(sha)
        have += 1
        chars += len(text)
    await db[JOBS].update_one({"_id": job["_id"]}, {"$set": {"problems": problems[-100:], "chars": chars, "n_sources": n,
                                                             "updated_at": now_utc()}})
    job = await db[JOBS].find_one({"_id": job["_id"]})
    return await rebuild(db, job)


async def remove_source(db: AsyncIOMotorDatabase, job: dict, row_id: str) -> dict:
    """Take a row (its files) out of a draft."""
    if job["state"] != "draft":
        raise HTTPException(status_code=409, detail="This import has started.")
    row = next((r for r in job.get("rows") or [] if r["id"] == row_id), None)
    if row is None:
        raise HTTPException(status_code=404, detail="That row isn't in this import.")
    await db[SOURCES].delete_many({"job_id": job["_id"], "_id": {"$in": [ObjectId(x) for x in row["source_ids"]]}})
    return await rebuild(db, await db[JOBS].find_one({"_id": job["_id"]}))


def _row_id(source_ids: list[str]) -> str:
    return "r" + hashlib.sha1(",".join(sorted(source_ids)).encode()).hexdigest()[:10]


_DATE_RANK = {"user": 0, "title": 1, "created": 2, "content": 3, None: 9}


async def rebuild(db: AsyncIOMotorDatabase, job: dict) -> dict:
    """The review's rows from the job's sources (and the person's edits, kept by row)."""
    srcs = await db[SOURCES].find({"job_id": job["_id"]}, {"text": 0}).sort("n", 1).to_list(length=MAX_JOB_SOURCES)
    items = [det.Item(id=str(s["_id"]), kind=s["parsed"]["kind"], title=s["parsed"]["title"], date=s["parsed"]["date"],
                      time=s["parsed"]["time"], extra=s) for s in srcs]
    edits: dict[str, dict] = dict(job.get("edits") or {})
    rows: list[dict] = []
    for g in det.pair(items)[:MAX_ROWS]:
        ids = [x.id for x in g]
        rid = _row_id(ids)
        ps = [x.extra["parsed"] for x in g]
        notes = next((p for p in ps if p["has_notes"]), None)
        title = (notes or ps[0])["title"] or next((p["title"] for p in ps if p["title"]), None)
        dated = sorted((p for p in ps if p["date"]), key=lambda p: _DATE_RANK.get(p["date_from"], 9))
        d = dated[0]["date"] if dated else None
        t = next((p["time"] for p in dated if p["time"]), None)
        kinds = sorted({k for p in ps for k in (("notes", "transcript") if p["kind"] == "both" else (p["kind"],))})
        row = {"id": rid, "source_ids": ids, "names": [x.extra["name"] for x in g], "kinds": kinds,
               "title": title, "date": d, "time": t, "date_from": dated[0]["date_from"] if dated else None,
               "detected": {"title": title, "date": d}, "segments": sum(p["segments"] for p in ps),
               "attendees": sorted({a for p in ps for a in p["attendees"]})[:30],
               "est_usd": det.estimate_usd(sum(p["chars"] for p in ps), bool(notes)),
               "file_ids": [x.extra.get("file_id") for x in g if x.extra.get("file_id")],
               "series": None, "series_from": "auto", "include": True, "state": "pending", "error": None,
               "meeting_id": None, "dup": {"status": "new"}, "attempts": 0}
        e = edits.get(rid) or {}
        if e.get("title"):
            row["title"] = e["title"]
        if e.get("date"):
            row["date"], row["date_from"] = e["date"], "user"
            if e["date"] != d:
                row["time"] = None
        rows.append(row)
    await _series_for(db, job["workspace_id"], rows, edits)
    await _dupes_for(db, job["workspace_id"], rows)
    for r in rows:
        e = edits.get(r["id"]) or {}
        if r["dup"]["status"] == "duplicate":
            r["include"] = False
        elif "include" in e:
            r["include"] = bool(e["include"])
        r["needs_date"] = r["include"] and not r["date"]
    rows.sort(key=lambda r: (r["date"] is not None, r["date"] or "", r["time"] or "", r["title"] or ""))
    await db[JOBS].update_one({"_id": job["_id"]}, {"$set": {"rows": rows, "updated_at": now_utc()}})
    return await db[JOBS].find_one({"_id": job["_id"]})


async def _series_for(db: AsyncIOMotorDatabase, workspace_id: str, rows: list[dict], edits: dict) -> None:
    known = await meeting_series.known(db, workspace_id)
    by_key: dict[str, list[dict]] = {}
    for r in rows:
        r["series_key"] = det.series_key(r["title"])
        if r["series_key"]:
            by_key.setdefault(r["series_key"], []).append(r)
    for key, rs in by_key.items():
        label = det.pick_label(det.series_label(r["title"]) for r in rs)
        name = meeting_series.decide(key, label, known.get(key), batch=len(rs) - 1)
        for r in rs:
            r["series"] = name
    for r in rows:
        e = edits.get(r["id"]) or {}
        if "series" in e:
            r["series"], r["series_from"] = meeting_series.clean_name(e["series"]), "user"


async def _dupes_for(db: AsyncIOMotorDatabase, workspace_id: str, rows: list[dict]) -> None:
    """Each row against the workspace's meetings, then against the rows before it."""
    for r in rows:
        if r["file_ids"]:
            hit = await db[meetings.COLL].find_one({"workspace_id": workspace_id, "sources.file_id": {"$in": r["file_ids"]}},
                                                   {"title": 1, "date": 1})
            if hit is not None:
                r["dup"] = {"status": "duplicate", "meeting_id": str(hit["_id"]), "title": hit.get("title"),
                            "date": hit.get("date"), "why": "file"}
                continue
        action, hit = await meetings.find_existing(db, workspace_id, title=r["title"], date_=r["date"], time_=r["time"],
                                                   kinds=set(r["kinds"]))
        if action != "new" and hit is not None:
            r["dup"] = {"status": action, "meeting_id": str(hit["_id"]), "title": hit.get("title"), "date": hit.get("date"),
                        "why": "call"}
    seen: list[dict] = []
    for r in rows:
        if r["dup"]["status"] != "new" or not r["date"]:
            seen.append(r)
            continue
        twin = next((x for x in seen if x["date"] == r["date"] and x["dup"]["status"] == "new"
                     and meetings.same_call({"title": x["title"], "date": x["date"], "time": x["time"]},
                                            r["title"], r["date"], r["time"])
                     and set(r["kinds"]) <= set(x["kinds"])), None)
        if twin is not None:
            r["dup"] = {"status": "duplicate", "row": twin["id"], "title": twin["title"], "date": twin["date"],
                        "why": "batch"}
        seen.append(r)


def check_date(value: str) -> str:
    try:
        d = date.fromisoformat(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="A date is written YYYY-MM-DD.")
    if d > now_utc().date() + timedelta(days=1):
        raise HTTPException(status_code=422, detail="That date is in the future: past meetings only.")
    if d.year < 2000:
        raise HTTPException(status_code=422, detail="That date is too far back.")
    return d.isoformat()


async def edit(db: AsyncIOMotorDatabase, job: dict, *, quiet: bool | None = None, restricted: bool | None = None,
               rows: list[dict] | None = None) -> dict:
    """The review's changes: the switches, and per row its title, date, series and whether it's included."""
    sets: dict[str, Any] = {"updated_at": now_utc()}
    if quiet is not None:
        sets["quiet"] = bool(quiet)
    if restricted is not None:
        if job["state"] != "draft":
            raise HTTPException(status_code=409, detail="This import has started.")
        sets["restricted"] = bool(restricted)
    if rows:
        if job["state"] != "draft":
            raise HTTPException(status_code=409, detail="This import has started: its rows can't change now.")
        known_ids = {r["id"] for r in job.get("rows") or []}
        edits = dict(job.get("edits") or {})
        for ch in rows:
            rid = str(ch.get("id") or "")
            if rid not in known_ids:
                raise HTTPException(status_code=404, detail="That row isn't in this import.")
            e = dict(edits.get(rid) or {})
            if "title" in ch and ch["title"] is not None:
                t = " ".join(str(ch["title"]).split())[:150]
                if not t:
                    raise HTTPException(status_code=422, detail="A meeting needs a name.")
                e["title"] = t
            if "date" in ch and ch["date"] is not None:
                e["date"] = check_date(str(ch["date"]))
            if "series" in ch:
                e["series"] = meeting_series.clean_name(ch["series"])
            if "include" in ch and ch["include"] is not None:
                e["include"] = bool(ch["include"])
            edits[rid] = e
        sets["edits"] = edits
    await db[JOBS].update_one({"_id": job["_id"]}, {"$set": sets})
    job = await db[JOBS].find_one({"_id": job["_id"]})
    return await rebuild(db, job) if rows else job


# ── Running ───────────────────────────────────────────────────────────────────


async def start(db: AsyncIOMotorDatabase, job: dict) -> dict:
    if job["state"] != "draft":
        raise HTTPException(status_code=409, detail="This import has already started.")
    rows = job.get("rows") or []
    todo = [r for r in rows if r["include"]]
    if not todo:
        raise HTTPException(status_code=422, detail="Nothing to import: every row is skipped or already here.")
    undated = [r for r in todo if not r["date"]]
    if undated:
        raise HTTPException(status_code=422, detail=f"{len(undated)} meeting{'s' if len(undated) != 1 else ''} "
                                                    "need a date first (or leave them out).")
    for i, r in enumerate(sorted(todo, key=lambda r: (r["date"], r["time"] or "", r["title"] or "")), 1):
        r["order"] = i
    for r in rows:
        if not r["include"]:
            r["state"] = "duplicate" if r["dup"]["status"] == "duplicate" else "skipped"
    now = now_utc()
    await db[JOBS].update_one({"_id": job["_id"], "state": "draft"},
                              {"$set": {"rows": rows, "state": "running", "started_at": now, "updated_at": now}})
    # The files of rows that won't import aren't needed anymore.
    drop = [ObjectId(s) for r in rows if not r["include"] for s in r["source_ids"]]
    if drop:
        await db[SOURCES].delete_many({"job_id": job["_id"], "_id": {"$in": drop}})
    job = await db[JOBS].find_one({"_id": job["_id"]})
    kick(db, job)
    return job


async def pause(db: AsyncIOMotorDatabase, job: dict) -> dict:
    if job["state"] not in ACTIVE:
        raise HTTPException(status_code=409, detail="This import isn't running.")
    await db[JOBS].update_one({"_id": job["_id"]}, {"$set": {"state": "paused", "updated_at": now_utc()}})
    return await db[JOBS].find_one({"_id": job["_id"]})


async def resume(db: AsyncIOMotorDatabase, job: dict) -> dict:
    if job["state"] not in ("paused", "waiting"):
        raise HTTPException(status_code=409, detail="This import isn't paused.")
    await db[JOBS].update_one({"_id": job["_id"]}, {"$set": {"state": "running", "wait": None, "updated_at": now_utc()}})
    job = await db[JOBS].find_one({"_id": job["_id"]})
    kick(db, job)
    return job


async def retry(db: AsyncIOMotorDatabase, job: dict, row_id: str) -> dict:
    row = next((r for r in job.get("rows") or [] if r["id"] == row_id), None)
    if row is None:
        raise HTTPException(status_code=404, detail="That row isn't in this import.")
    if row["state"] != "failed":
        raise HTTPException(status_code=409, detail="Only a meeting that failed can be tried again.")
    if job["state"] == "cancelled":
        raise HTTPException(status_code=409, detail="This import was stopped.")
    sets = {"rows.$[r].state": "pending", "rows.$[r].error": None, "updated_at": now_utc()}
    if job["state"] == "done":
        sets.update(state="running", done_at=None)
    await db[JOBS].update_one({"_id": job["_id"]}, {"$set": sets}, array_filters=[{"r.id": row_id}])
    job = await db[JOBS].find_one({"_id": job["_id"]})
    kick(db, job)
    return job


async def discard(db: AsyncIOMotorDatabase, job: dict) -> dict:
    """A draft or a finished import: gone. A running one: stopped (what was imported stays)."""
    if job["state"] in ("draft", "done", "cancelled"):
        await db[SOURCES].delete_many({"job_id": job["_id"]})
        await db[JOBS].delete_one({"_id": job["_id"]})
        return {"deleted": True, "id": str(job["_id"])}
    rows = job.get("rows") or []
    for r in rows:
        if r["state"] in ("pending", "importing", "failed"):
            r["state"] = "skipped"
    await db[JOBS].update_one({"_id": job["_id"]}, {"$set": {"state": "cancelled", "rows": rows, "lease": None,
                                                             "done_at": now_utc(), "updated_at": now_utc()}})
    await db[SOURCES].delete_many({"job_id": job["_id"]})
    return {"deleted": False, "stopped": True, "id": str(job["_id"])}


def kick(db: AsyncIOMotorDatabase, job: dict | None) -> None:
    """Run the job in this process (unless it already runs here)."""
    if job is None or job.get("state") != "running":
        return
    jid = str(job["_id"])
    t = _tasks.get(jid)
    if t is not None and not t.done():
        return
    task = asyncio.create_task(run(db, jid))
    _tasks[jid] = task
    task.add_done_callback(lambda _t, k=jid: _tasks.pop(k, None) if _tasks.get(k) is _t else None)


async def wake(db: AsyncIOMotorDatabase, job: dict) -> dict:
    """A waiting job whose wait is over runs again; a running one nobody holds is picked up."""
    now = now_utc()
    if job.get("state") == "waiting":
        until = _aware((job.get("wait") or {}).get("until"))
        if until is not None and until <= now:
            await db[JOBS].update_one({"_id": job["_id"], "state": "waiting"},
                                      {"$set": {"state": "running", "wait": None, "updated_at": now}})
            job = await db[JOBS].find_one({"_id": job["_id"]}) or job
    if job.get("state") == "running":
        lease = job.get("lease") or {}
        until = _aware(lease.get("until"))
        if until is None or until <= now or lease.get("holder") == HOLDER:
            kick(db, job)
    return job


async def _claim(db: AsyncIOMotorDatabase, job_id: ObjectId) -> dict | None:
    now = now_utc()
    return await db[JOBS].find_one_and_update(
        {"_id": job_id, "state": "running",
         "$or": [{"lease": None}, {"lease.until": {"$lt": now}}, {"lease.holder": HOLDER}]},
        {"$set": {"lease": {"holder": HOLDER, "until": now + LEASE}}}, return_document=True)


async def _release(db: AsyncIOMotorDatabase, job_id: ObjectId) -> None:
    await db[JOBS].update_one({"_id": job_id, "lease.holder": HOLDER}, {"$set": {"lease": None}})


def _wait_until(reason: str, now: datetime) -> datetime:
    if reason == "burst":
        return now + timedelta(seconds=65)
    if reason == "monthly":
        first = (now.replace(day=1) + timedelta(days=32)).replace(day=1)
        return first.replace(hour=0, minute=0, second=30, microsecond=0)
    return (now + timedelta(days=1)).replace(hour=0, minute=0, second=30, microsecond=0)


async def run(db: AsyncIOMotorDatabase, job_id: str) -> str:
    """Import the job's rows, one at a time, while it is running and this process holds it.
    Returns the job's state when it stops."""
    oid = _oid(job_id)
    job = await _claim(db, oid) if oid else None
    if job is None:
        return "busy"
    try:
        while True:
            job = await db[JOBS].find_one({"_id": oid})
            if job is None or job["state"] != "running":
                return job["state"] if job else "gone"
            rows = job.get("rows") or []
            # A row this process (or a stopped one) was importing: carry on with it.
            nxt = min((r for r in rows if r["state"] in ("pending", "importing")),
                      key=lambda r: r.get("order") or 0, default=None)
            if nxt is None:
                await _finish(db, job)
                return "done"
            user = await _owner(db, job)
            if user is None:
                await db[JOBS].update_one({"_id": oid}, {"$set": {
                    "state": "paused", "updated_at": now_utc(),
                    "wait": {"reason": "member", "until": None,
                             "message": "You're no longer a member who can import meetings into this workspace."}}})
                return "paused"
            from app.services import meetings_ai

            reason = await meetings_ai.generate_reason(db, user.id, job["workspace_id"])
            if reason in WAIT_REASONS:
                now = now_utc()
                await db[JOBS].update_one({"_id": oid, "state": "running"}, {"$set": {
                    "state": "waiting", "updated_at": now,
                    "wait": {"reason": reason, "until": _wait_until(reason, now), "message": meetings_ai.message(reason)}}})
                return "waiting"
            await _row(db, job, nxt, user)
    finally:
        await _release(db, oid)


async def _owner(db: AsyncIOMotorDatabase, job: dict):
    from app.models.workspace import role_allows
    from app.services import user as user_service
    from app.services import workspace as ws_service

    user = await user_service.get_user_by_id(db, job["user_id"])
    if user is None:
        return None
    role = await ws_service.role_for(db, job["workspace_id"], user.id)
    return user if role is not None and role_allows(role, "member") else None


async def _set_row(db: AsyncIOMotorDatabase, job_id: ObjectId, row_id: str, **values) -> None:
    sets = {f"rows.$[r].{k}": v for k, v in values.items()}
    sets["updated_at"] = now_utc()
    await db[JOBS].update_one({"_id": job_id}, {"$set": sets}, array_filters=[{"r.id": row_id}])


async def _row(db: AsyncIOMotorDatabase, job: dict, row: dict, user) -> None:
    from app.services import meetings_ai

    oid = job["_id"]
    started = now_utc()
    again = row["state"] == "importing"
    await _set_row(db, oid, row["id"], state="importing", attempts=int(row.get("attempts") or 0) + 1,
                   started_at=_aware(row.get("started_at")) if again and row.get("started_at") else started)
    await db[JOBS].update_one({"_id": oid}, {"$set": {"lease.until": now_utc() + LEASE}})
    srcs = await db[SOURCES].find({"job_id": oid, "_id": {"$in": [ObjectId(s) for s in row["source_ids"]]}}).sort("n", 1).to_list(length=10)
    if not srcs:
        await _set_row(db, oid, row["id"], state="failed", error="Its file isn't here anymore: add it again in a new import.")
        return
    incoming = [meetings.Incoming(name=s["name"], text=s["text"], origin=s.get("origin") or "upload",
                                  file_id=s.get("file_id"), url=s.get("url")) for s in srcs]
    quiet = bool(job.get("quiet")) or is_past(row["date"], row.get("time"))
    try:
        rows = await meetings.import_meetings(
            db, user, job["workspace_id"], incoming, title=row["title"], date_=row["date"],
            restricted=bool(job.get("restricted")), wait=True, via="backfill", dedupe="all",
            series=row.get("series"), series_from=row.get("series_from") or "auto", quiet=quiet)
    except HTTPException as exc:
        detail = exc.detail if isinstance(exc.detail, str) else "The import was refused."
        await _set_row(db, oid, row["id"], state="failed", error=detail[:300])
        return
    except Exception:
        log.warning("meetings backfill: row %s of %s failed", row["id"], oid, exc_info=True)
        await _set_row(db, oid, row["id"], state="failed", error="Something went wrong. Try again.")
        return
    status = rows[0].get("_status") or "imported"
    m = await meetings.get_row(db, str(rows[0]["_id"])) or rows[0]
    since = _aware(row.get("started_at")) if again and row.get("started_at") else started
    if status == "duplicate" and m.get("created_by") == user.id and m.get("via") == "backfill" \
            and _aware(m.get("created_at")) and _aware(m.get("created_at")) >= since - timedelta(seconds=5):
        # Made by this job before a restart cut it short: it's this row's meeting; finish its summary.
        status = "imported"
        if meetings.ai_view(m)["state"] in ("failed",) or (m.get("ai") or {}).get("state") == "pending":
            await meetings_ai.generate(db, str(m["_id"]), user)
            m = await meetings.get_row(db, str(m["_id"])) or m
    await _set_row(db, oid, row["id"], state=status, meeting_id=str(m["_id"]), error=None,
                   cost_usd=round(float((m.get("ai") or {}).get("cost_usd") or 0), 6) if status != "duplicate" else 0,
                   ai=(m.get("ai") or {}).get("state"), done_at=now_utc())
    await db[SOURCES].delete_many({"job_id": oid, "_id": {"$in": [s["_id"] for s in srcs]}})


async def _finish(db: AsyncIOMotorDatabase, job: dict) -> None:
    now = now_utc()
    await db[JOBS].update_one({"_id": job["_id"], "state": "running"},
                              {"$set": {"state": "done", "done_at": now, "updated_at": now, "wait": None}})


async def background(db: AsyncIOMotorDatabase) -> None:
    """The loop's pass (services/background.py): jobs to wake or pick up; finished ones forgotten."""
    now = now_utc()
    async for j in db[JOBS].find({"state": {"$in": list(ACTIVE)}}).limit(50):
        await wake(db, j)
    old = [j["_id"] async for j in db[JOBS].find({"state": {"$in": ["done", "cancelled"]},
                                                  "done_at": {"$lt": now - KEEP_DONE}}, {"_id": 1}).limit(200)]
    if old:
        await db[SOURCES].delete_many({"job_id": {"$in": old}})
        await db[JOBS].delete_many({"_id": {"$in": old}})


# ── What the page and MCP see ────────────────────────────────────────────────


async def estimate(db: AsyncIOMotorDatabase, job: dict) -> dict:
    """The AI cost of the rows still to import, and whether today's Meetings AI budget covers it."""
    from app.services import ai_usage, meetings_ai

    todo = [r for r in job.get("rows") or [] if r.get("include") and r.get("state") in ("pending", "importing")]
    usd = round(sum(float(r.get("est_usd") or 0) for r in todo), 4)
    daily, _monthly = await ai_usage.caps(db, meetings_ai.FEATURE)
    left = None
    if daily != ai_usage.INF:
        left = max(0.0, daily - await ai_usage.spend_today(db, meetings_ai.FEATURE))
    mine = await ai_usage.user_daily_cap(db, job["user_id"])
    if mine is not None:
        mine_left = max(0.0, mine - await ai_usage.user_spend_today(db, job["user_id"]))
        left = mine_left if left is None else min(left, mine_left)
    reason = await meetings_ai.generate_reason(db, job["user_id"], job["workspace_id"])
    ai = reason is None or reason in WAIT_REASONS
    return {"usd": usd, "meetings": len(todo), "left_today_usd": None if left is None else round(left, 4),
            "may_wait": bool(ai and left is not None and usd > left), "ai": ai,
            "ai_message": None if ai else meetings_ai.message(reason)}


def _iso(dt: datetime | None) -> str | None:
    return meetings.iso(_aware(dt)) if dt else None


async def view(db: AsyncIOMotorDatabase, job: dict, *, with_estimate: bool = True) -> dict:
    rows = job.get("rows") or []
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["state"]] = counts.get(r["state"], 0) + 1
    todo = [r for r in rows if r.get("include")]
    done = sum(1 for r in todo if r["state"] in ROW_DONE or r["state"] == "failed")
    slugs: dict[str, str] = {}
    ids = [_oid(r["meeting_id"]) for r in rows if r.get("meeting_id") and _oid(r["meeting_id"])]
    if ids:
        async for m in db[meetings.COLL].find({"_id": {"$in": ids}}, {"slug": 1}):
            slugs[str(m["_id"])] = m.get("slug")
    wait = job.get("wait")
    out = {
        "id": str(job["_id"]), "workspace_id": job["workspace_id"], "state": job["state"], "origin": job.get("origin"),
        "quiet": bool(job.get("quiet")), "restricted": bool(job.get("restricted")),
        "created_at": _iso(job.get("created_at")), "started_at": _iso(job.get("started_at")),
        "done_at": _iso(job.get("done_at")),
        "wait": {"reason": wait.get("reason"), "until": _iso(wait.get("until")), "message": wait.get("message")} if wait else None,
        "counts": {"rows": len(rows), "included": len(todo), "done": done, "imported": counts.get("imported", 0),
                   "attached": counts.get("attached", 0), "duplicate": counts.get("duplicate", 0),
                   "skipped": counts.get("skipped", 0), "failed": counts.get("failed", 0),
                   "pending": counts.get("pending", 0) + counts.get("importing", 0),
                   "needs_date": sum(1 for r in rows if r.get("needs_date"))},
        "problems": job.get("problems") or [],
        "rows": [{
            "id": r["id"], "names": r["names"], "kinds": r["kinds"], "title": r["title"], "date": r["date"],
            "time": r.get("time"), "date_from": r.get("date_from"), "series": r.get("series"),
            "series_from": r.get("series_from"), "include": r["include"], "needs_date": bool(r.get("needs_date")),
            "dup": r["dup"], "state": r["state"], "error": r.get("error"), "meeting_id": r.get("meeting_id"),
            "slug": slugs.get(r.get("meeting_id") or ""), "segments": r.get("segments"), "attendees": r.get("attendees") or [],
            "est_usd": r.get("est_usd"), "cost_usd": r.get("cost_usd"), "order": r.get("order"),
            "past": is_past(r["date"], r.get("time")), "ai": r.get("ai"),
        } for r in rows],
    }
    if with_estimate:
        out["estimate"] = await estimate(db, job)
    return out
