"""Zoom meetings without a transcript, and their recordings in Markdrop (owner decision 2026-11-16).

    services/zoom.py        handle_recording picks the transcript (:func:`source_of`) and queues the work
    services/deepgram.py    speech-to-text (MARKDROP_DEEPGRAM_API_KEY)
    routers/zoom.py         PUT /api/v1/zoom/media (the switch); routers/meetings.py GET /{id}/recording

**Where a meeting's transcript comes from**, in order: Zoom's own audio transcript (``TRANSCRIPT``);
else Zoom's closed captions (``CC``, a WebVTT file: always, no switch); else, only when the workspace's
admin turned on **Transcribe and keep recordings** (``zoom_connections.keep_media``) and the server has
a Deepgram key, the recording's AUDIO (``M4A``, never the video) goes to Deepgram (nova-3, diarized).
The audio is downloaded to a temporary file, sent, and deleted right after, whatever happened.
Deepgram's speakers get names from Zoom's active-speaker timeline (``TIMELINE``) when the recording
has one (Zoom's storage often refuses it), the host when only one person spoke; speakers still unnamed
are named from what was said (:func:`named_from_words`, services/meeting_speakers.py: one small
Meetings AI call given the topic, the host and who joined; only confident names), else "Speaker 1",
"Speaker 2"…

**When.** Transcribing is background work, never in a request: a meeting that needs it is
``waiting`` in ``zoom_meetings`` (``due_at``) and :func:`tick` (services/background.py, the ``zoom``
loop) runs one at a time. From the webhook (``recording.completed``) it waits :data:`WAIT` first,
because Zoom's own transcript often arrives a few minutes after the recording (a
``recording.transcript_completed`` in the meantime imports it with Zoom's transcript instead).
Import past meetings queues it due now. Minutes are recorded in the AI usage ledger (feature
``zoom_transcribe``, internal only) under its own caps; over them a meeting waits for the next day.

**Recordings.** With the switch on, after a meeting is imported (or when an imported meeting is
imported again: "add recordings to meetings already here") its MP4 (shared screen with speaker
view, else active speaker, else any) is copied into R2, where video files live
(``art/zoom/<workspace>/<random>.mp4``, never public), streamed in parts (never whole in memory).
The meeting row keeps it as ``recording {key, size, …}``. Who can read the meeting page decides who
can play it: GET /api/v1/meetings/{id}/recording re-decides ``access.can(read)`` and hands out a
short-lived signed link to the files origin's video player (services/artifact.build_artifact_url).
Deleting the meeting (or Disconnect › delete the imported meetings) deletes the video; so does the
meeting page being deleted for good (lifecycle.destroy → :func:`forget_document`).

zoom_meetings fields used here: ``state`` (… | waiting), ``due_at``, ``tries``, ``source``
(transcript | captions | transcribe), ``rec_state`` (queued | copying | ready | failed | none | off |
too_big | gone), ``rec_at``, ``rec_tries``.
"""

from __future__ import annotations

import bisect
import json
import logging
import os
import re
import secrets
import tempfile
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from starlette.concurrency import run_in_threadpool

from app.config import get_settings
from app.services import deepgram, zoom_api

log = logging.getLogger("markdrop.zoom")

FEATURE = "zoom_transcribe"
WAIT = timedelta(minutes=20)              # Zoom's own transcript usually follows recording.completed
RETRY = timedelta(minutes=15)
STALE = timedelta(hours=2)                # a copy or a transcription a stopped process left running
MAX_TRIES = 3
MAX_AUDIO_BYTES = 1024 * 1024 * 1024
PART = 16 * 1024 * 1024                   # R2 multipart part (all but the last the same size)
CHUNK = 1024 * 1024
VIDEO_MIME = "video/mp4"
VIDEO_PREFER = ("shared_screen_with_speaker_view", "shared_screen_with_speaker_view(CDN)", "active_speaker",
                "speaker_view", "shared_screen_with_gallery_view", "gallery_view", "shared_screen")
LIMIT_REASON = "Markdrop reached its fair-use limit for transcribing today. It continues on its own tomorrow."
PAUSED_REASON = "Transcribing is paused on this Markdrop server right now."
FAILED_REASON = "Markdrop couldn't transcribe this meeting's audio. Try importing it again later."


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


# ── Availability and the switch ───────────────────────────────────────────────


def available() -> bool:
    """The server can transcribe and keep recordings: a Deepgram key, R2, and encrypted secrets."""
    from app.services import r2
    from app.utils import crypto

    return deepgram.configured() and r2.is_configured() and crypto.is_configured()


def is_on(conn: dict | None) -> bool:
    return bool(conn and conn.get("keep_media")) and available()


async def set_switch(db: AsyncIOMotorDatabase, user, workspace_id: str, enabled: bool) -> dict:
    """Transcribe and keep recordings (workspace admins). Off by default."""
    from app.services import zoom

    await zoom.require_admin(db, user, workspace_id)
    conn = await zoom.get(db, workspace_id)
    if not zoom.is_connected(conn):
        raise HTTPException(status_code=404, detail="This workspace isn't connected to Zoom.")
    if enabled and not available():
        raise HTTPException(status_code=503, detail="Transcribing Zoom meetings isn't available on this Markdrop server.")
    sets: dict[str, Any] = {"keep_media": bool(enabled), "updated_at": now_utc()}
    if enabled != bool(conn.get("keep_media")):
        sets.update(keep_media_by=user.id, keep_media_at=now_utc())
    await db[zoom.CONNS].update_one({"_id": str(workspace_id)}, {"$set": sets})
    log.info("zoom: workspace %s turned transcribe-and-keep-recordings %s", workspace_id, "on" if enabled else "off")
    return await zoom.status(db, user, workspace_id)


# ── A recording's files ───────────────────────────────────────────────────────


def _done(f: dict) -> bool:
    return (f.get("status") or "completed").lower() == "completed" and bool(f.get("download_url"))


def _of_type(obj: dict, *types: str) -> list[dict]:
    want = {t.upper() for t in types}
    return [f for f in obj.get("recording_files") or [] if str(f.get("file_type") or "").upper() in want and _done(f)]


def cc_file(obj: dict) -> dict | None:
    """Zoom's closed captions (WebVTT): a transcript when Zoom made no audio transcript."""
    for f in obj.get("recording_files") or []:
        if (str(f.get("file_type") or "").upper() == "CC" or f.get("recording_type") == "closed_caption") and _done(f):
            return f
    return None


def _size(f: dict) -> int:
    try:
        return int(f.get("file_size") or 0)
    except (TypeError, ValueError):
        return 0


def audio_file(obj: dict) -> dict | None:
    # A host who stops and starts recording leaves several parts; the first can be seconds of silence
    # (Senseloaf: a 66 KB part before the 29 MB one), so the largest part of the preferred kind.
    got = _of_type(obj, "M4A")
    pick = [f for f in got if f.get("recording_type") == "audio_only"] or got
    return max(pick, key=_size) if pick else None


def video_file(obj: dict) -> dict | None:
    got = _of_type(obj, "MP4")
    for kind in VIDEO_PREFER:
        of_kind = [f for f in got if f.get("recording_type") == kind]
        if of_kind:
            return max(of_kind, key=_size)
    return max(got, key=_size) if got else None


def timeline_file(obj: dict) -> dict | None:
    got = _of_type(obj, "TIMELINE")
    return got[0] if got else None


def can_transcribe(conn: dict | None, obj: dict) -> bool:
    return is_on(conn) and audio_file(obj) is not None


def source_of(conn: dict | None, obj: dict) -> str | None:
    """Where this meeting's transcript would come from: transcript | captions | transcribe | None."""
    from app.services import zoom

    if zoom.transcript_file(obj) is not None:
        return "transcript"
    if cc_file(obj) is not None:
        return "captions"
    if can_transcribe(conn, obj):
        return "transcribe"
    return None


# ── Waiting for (and running) a transcription ─────────────────────────────────


class Later(Exception):
    """Not now: try again at ``due`` (the fair-use limit, Deepgram busy)."""

    def __init__(self, reason: str, due: datetime):
        super().__init__(reason)
        self.reason = reason
        self.due = due


async def queue(db: AsyncIOMotorDatabase, key: str, base: dict, *, due: datetime, source: str = "transcribe") -> bool:
    """Mark a meeting ``waiting`` (unless it's being imported or is in already): a transcription, or
    captions waiting a little for Zoom's own transcript."""
    from app.services import zoom

    now = now_utc()
    try:
        res = await db[zoom.MEETINGS].update_one(
            {"_id": key, "state": {"$nin": ["processing", *zoom.DONE]}},
            {"$set": {**base, "state": "waiting", "due_at": due, "at": now, "reason": None, "source": source},
             "$setOnInsert": {"created_at": now, "tries": 0}}, upsert=True)
    except Exception as exc:  # DuplicateKeyError: it is processing or in already
        log.info("zoom: not queueing %s: %r", key, type(exc).__name__)
        return False
    return bool(res.upserted_id or res.modified_count or res.matched_count)


def _next_day() -> datetime:
    t = now_utc()
    return datetime(t.year, t.month, t.day, tzinfo=timezone.utc) + timedelta(days=1, minutes=10)


async def _budget(db: AsyncIOMotorDatabase, minutes: float) -> None:
    from app.services import ai_usage

    if not await ai_usage.feature_on(db, FEATURE):
        raise Later(PAUSED_REASON, now_utc() + timedelta(hours=6))
    reserve = max(1.0, minutes) * float(get_settings().deepgram_usd_per_minute or 0.0)
    state = await ai_usage.check_budget(db, FEATURE, reserve=reserve)
    if not state.ok:
        raise Later(LIMIT_REASON, _next_day())


async def _record(db: AsyncIOMotorDatabase, *, workspace_id: str, user_id: str | None, seconds: float,
                  outcome: str, uuid: str) -> None:
    from app.services import ai_usage

    s = get_settings()
    meter = ai_usage.Meter(model=f"deepgram-{s.deepgram_model or 'nova-3'}")
    meter.calls = 1
    meter.cost_usd = round(seconds / 60.0 * float(s.deepgram_usd_per_minute or 0.0), 6)
    try:
        await ai_usage.record(db, feature=FEATURE, meter=meter, request_id="zt_" + secrets.token_hex(8), outcome=outcome,
                              user_id=user_id, job="Zoom transcription",
                              meta={"workspace_id": workspace_id, "priced": True, "via": "background",
                                    "audio_seconds": round(seconds, 1), "audio_minutes": round(seconds / 60.0, 2),
                                    "provider": "deepgram", "zoom_uuid": uuid[:128]})
    except Exception:
        log.warning("zoom: recording transcription usage failed", exc_info=True)


async def _token(db: AsyncIOMotorDatabase, conn: dict, fresh: bool) -> str:
    from app.services import zoom

    return await zoom.access_token(db, conn, fresh=fresh)


async def _to_file(db: AsyncIOMotorDatabase, conn: dict, url: str, path: str, max_bytes: int) -> int:
    """Stream a recording file to ``path`` (a new token once on a 401)."""
    for attempt in range(2):
        tok = await _token(db, conn, attempt > 0)
        total = 0
        try:
            with open(path, "wb") as f:
                async with zoom_api.stream(url, tok) as r:
                    async for b in r.aiter_bytes(CHUNK):
                        total += len(b)
                        if total > max_bytes:
                            raise zoom_api.ZoomError(413, "The recording is too big.")
                        f.write(b)
            return total
        except zoom_api.ZoomError as exc:
            if exc.status == 401 and attempt == 0:
                continue
            raise
    raise zoom_api.ZoomError(401, "Zoom didn't accept the token.")


async def transcribe(db: AsyncIOMotorDatabase, conn: dict, obj: dict, *, host_name: str | None,
                     user_id: str | None, participants: list[str] | None = None) -> str:
    """The meeting's audio → Deepgram → WebVTT ("Name: text" cues). The audio file is deleted right after."""
    from app.services import zoom

    af = audio_file(obj)
    if af is None:
        raise zoom_api.ZoomError(404, "The recording has no audio file.")
    await _budget(db, float(obj.get("duration") or 60))
    fd, path = tempfile.mkstemp(prefix="md-zoom-", suffix=".m4a")
    os.close(fd)
    try:
        await _to_file(db, conn, af["download_url"], path, MAX_AUDIO_BYTES)
        try:
            result = await deepgram.transcribe_file(path, "audio/mp4")
        except deepgram.DeepgramError as exc:
            log.info("zoom: deepgram answered %s %s", exc.status, exc.reason)
            if exc.limited or exc.status >= 500:
                raise Later("Transcribing is busy; Markdrop tries again shortly.", now_utc() + RETRY)
            raise
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    seconds = deepgram.duration_s(result)
    utts = deepgram.utterances(result)
    await _record(db, workspace_id=conn["_id"], user_id=user_id, seconds=seconds, outcome="ok" if utts else "empty",
                  uuid=str(obj.get("uuid") or ""))
    log.info("zoom: transcribed a meeting for %s (%s)", conn["_id"], deepgram.describe(result))
    if not utts:
        raise deepgram.DeepgramError(422, "No speech was found in the recording.")
    points: list[tuple[float, list[str]]] = []
    tl = timeline_file(obj)
    if tl is not None:
        try:
            points = timeline_points(await zoom.download(db, conn, tl["download_url"]))
        except (zoom_api.ZoomError, zoom.ZoomUnavailable) as exc:
            log.info("zoom: the timeline of a meeting: %s", exc)
    names = speaker_names(utts, points, host=host_name)
    names.update(await named_from_words(db, conn, obj, utts, names, host=host_name, participants=participants,
                                        user_id=user_id))
    return deepgram.to_vtt(utts, names)


# ── Speakers' names ───────────────────────────────────────────────────────────

_TS = re.compile(r"^(\d+):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$")


def _secs(ts: Any) -> float | None:
    m = _TS.match(str(ts or "").strip())
    if not m:
        return None
    h, mi, s, ms = m.groups()
    return int(h) * 3600 + int(mi) * 60 + int(s) + (int(ms.ljust(3, "0")) / 1000 if ms else 0.0)


def timeline_points(raw: str) -> list[tuple[float, list[str]]]:
    """Zoom's active-speaker timeline: [(second, [names speaking from then on])], in order."""
    try:
        data = json.loads(raw or "{}")
    except ValueError:
        return []
    out: list[tuple[float, list[str]]] = []
    for p in (data.get("timeline") if isinstance(data, dict) else None) or []:
        if not isinstance(p, dict):
            continue
        t = _secs(p.get("ts"))
        if t is None:
            continue
        names = [" ".join(str(u.get("username") or "").split())[:80] for u in p.get("users") or [] if isinstance(u, dict)]
        out.append((t, [n for n in names if n]))
    out.sort(key=lambda x: x[0])
    return out


def speaker_names(utts: list[dict], points: list[tuple[float, list[str]]], *, host: str | None = None) -> dict[int, str]:
    """Deepgram's speaker numbers → people's names, where the evidence is good: each speaker gets the
    name Zoom's timeline shows active for most (at least half) of their speaking time, one name per
    speaker. With no timeline, a lone speaker is the host. Else none (to_vtt says "Speaker N")."""
    speakers = sorted({u["speaker"] for u in utts})
    if not points:
        return {speakers[0]: host} if host and len(speakers) == 1 else {}
    starts = [p[0] for p in points]
    votes: dict[int, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    totals: dict[int, float] = defaultdict(float)
    for u in utts:
        a, b = u["start"], max(u["end"], u["start"] + 0.05)
        i = max(0, bisect.bisect_right(starts, a) - 1)
        while i < len(points) and points[i][0] < b:
            seg_a = points[i][0] if points[i][0] > a else a
            seg_b = min(b, points[i + 1][0]) if i + 1 < len(points) else b
            overlap = seg_b - seg_a
            names = points[i][1]
            if overlap > 0 and names and points[i][0] <= b:
                for n in names:
                    votes[u["speaker"]][n] += overlap / len(names)
            i += 1
        totals[u["speaker"]] += b - a
    ranked = sorted(((v, sp, n) for sp, by in votes.items() for n, v in by.items()), reverse=True)
    out: dict[int, str] = {}
    taken: set[str] = set()
    for v, sp, n in ranked:
        if sp in out or n.casefold() in taken:
            continue
        if totals[sp] > 0 and v / totals[sp] >= 0.5:
            out[sp] = n
            taken.add(n.casefold())
    return out


async def named_from_words(db: AsyncIOMotorDatabase, conn: dict, obj: dict, utts: list[dict], names: dict[int, str], *,
                           host: str | None, participants: list[str] | None, user_id: str | None) -> dict[int, str]:
    """Speakers the timeline left unnamed, named from what was said (services/meeting_speakers.py:
    one small Meetings AI call; only confident names of people who are there). {} on any failure."""
    from app.services import meeting_speakers

    if all(u["speaker"] in names for u in utts):
        return {}
    label = {sp: f"Speaker {sp + 1}" for sp in {u["speaker"] for u in utts}}
    lines = [(names.get(u["speaker"]) or label[u["speaker"]], u["text"]) for u in utts]
    try:
        got = await meeting_speakers.name_speakers(db, workspace_id=conn["_id"], user_id=user_id, lines=lines,
                                                   title=obj.get("topic"), host=host, participants=participants)
    except Exception:
        log.warning("zoom: naming a meeting's speakers failed", exc_info=True)
        return {}
    by_label = {v: k for k, v in label.items()}
    return {by_label[lab]: n for lab, n in got.names.items() if lab in by_label and by_label[lab] not in names}


# ── Recordings ────────────────────────────────────────────────────────────────


async def queue_copy(db: AsyncIOMotorDatabase, conn: dict | None, key: str, obj: dict, meeting_id: Any) -> str | None:
    """Queue copying the meeting's video when the switch is on, it has one, and the meeting has none
    yet. "queued" or None."""
    from app.services import meetings, zoom

    if not is_on(conn) or video_file(obj) is None or meeting_id is None:
        return None
    row = await db[meetings.COLL].find_one({"_id": meetings.oid(meeting_id)}, {"recording": 1})
    if row is None or (row.get("recording") or {}).get("key"):
        return None
    res = await db[zoom.MEETINGS].update_one(
        {"_id": key, "rec_state": {"$nin": ["queued", "copying"]}},
        {"$set": {"rec_state": "queued", "rec_at": now_utc(), "rec_tries": 0}})
    if res.modified_count == 0:
        cur = await db[zoom.MEETINGS].find_one({"_id": key}, {"rec_state": 1})
        return "queued" if (cur or {}).get("rec_state") in ("queued", "copying") else None
    return "queued"


def blob_key(workspace_id: str) -> str:
    return f"art/zoom/{workspace_id}/{secrets.token_urlsafe(18)}.mp4"


async def _to_r2(db: AsyncIOMotorDatabase, conn: dict, url: str, key: str, max_bytes: int) -> int:
    """Stream a Zoom video into R2 as a multipart upload (a part at a time in memory). The bytes."""
    from app.services import r2

    for attempt in range(2):
        tok = await _token(db, conn, attempt > 0)
        upload_id = await run_in_threadpool(r2.create_multipart, key, VIDEO_MIME, False)
        parts: list[dict] = []
        buf = bytearray()
        total = 0
        try:
            async with zoom_api.stream(url, tok) as r:
                async for b in r.aiter_bytes(CHUNK):
                    total += len(b)
                    if total > max_bytes:
                        raise zoom_api.ZoomError(413, "The recording is too big.")
                    buf += b
                    while len(buf) >= PART:
                        n = len(parts) + 1
                        etag = await run_in_threadpool(r2.upload_part, key, upload_id, n, bytes(buf[:PART]))
                        parts.append({"part_number": n, "etag": etag})
                        del buf[:PART]
            if buf or not parts:
                n = len(parts) + 1
                etag = await run_in_threadpool(r2.upload_part, key, upload_id, n, bytes(buf))
                parts.append({"part_number": n, "etag": etag})
            await run_in_threadpool(r2.complete_multipart, key, upload_id, parts)
            return total
        except BaseException as exc:
            await run_in_threadpool(r2.abort_multipart, key, upload_id)
            if isinstance(exc, zoom_api.ZoomError) and exc.status == 401 and attempt == 0:
                continue
            raise
    raise zoom_api.ZoomError(401, "Zoom didn't accept the token.")


async def _rec(db: AsyncIOMotorDatabase, key: str, state: str, **extra) -> None:
    from app.services import zoom

    await db[zoom.MEETINGS].update_one({"_id": key}, {"$set": {"rec_state": state, "rec_at": now_utc(), **extra}})


async def copy_recording(db: AsyncIOMotorDatabase, key: str) -> str:
    """Copy one queued meeting's video into R2 (claimed once). The new ``rec_state``."""
    from app.services import meetings, r2, zoom

    now = now_utc()
    row = await db[zoom.MEETINGS].find_one_and_update(
        {"_id": key, "$or": [{"rec_state": "queued"},
                             {"rec_state": "copying", "rec_at": {"$lt": now - STALE}},
                             {"rec_state": "failed", "rec_tries": {"$lt": MAX_TRIES}, "rec_at": {"$lt": now - RETRY}}]},
        {"$set": {"rec_state": "copying", "rec_at": now}, "$inc": {"rec_tries": 1}}, return_document=True)
    if row is None:
        return "busy"
    ws, uuid = row["workspace_id"], row["uuid"]
    conn = await zoom.get(db, ws)
    if not zoom.is_connected(conn) or not is_on(conn):
        await _rec(db, key, "off")
        return "off"
    mrow = await db[meetings.COLL].find_one({"workspace_id": ws, "sources.file_id": f"zoom:{uuid}"}, {"recording": 1})
    if mrow is None:
        await _rec(db, key, "gone")
        return "gone"
    if (mrow.get("recording") or {}).get("key"):
        await _rec(db, key, "ready")
        return "ready"
    try:
        obj = await zoom.call(db, conn, "GET", f"meetings/{zoom_api.uuid_path(uuid)}/recordings") or {}
    except zoom.ZoomUnavailable as exc:
        await _rec(db, key, "failed", rec_reason=str(exc)[:300])
        return "failed"
    except zoom_api.ZoomError as exc:
        await _rec(db, key, "none" if exc.missing else "failed",
                   rec_reason="Zoom no longer has this recording." if exc.missing else str(exc)[:300])
        return "none" if exc.missing else "failed"
    vf = video_file(obj)
    if vf is None:
        await _rec(db, key, "none")
        return "none"
    cap = int(get_settings().artifact_max_video_bytes)
    if int(vf.get("file_size") or 0) > cap:
        await _rec(db, key, "too_big")
        return "too_big"
    bkey = blob_key(ws)
    try:
        size = await _to_r2(db, conn, vf["download_url"], bkey, cap)
    except zoom_api.ZoomError as exc:
        state = "too_big" if exc.status == 413 else "failed"
        await _rec(db, key, state, rec_reason=str(exc)[:300])
        return state
    except Exception as exc:
        log.warning("zoom: copying the recording of %s failed: %r", key, exc)
        await _rec(db, key, "failed", rec_reason="Storage didn't take it.")
        return "failed"
    rec = {"key": bkey, "mime": VIDEO_MIME, "size": size, "kind": vf.get("recording_type"), "uuid": uuid,
           "duration_s": int(obj["duration"]) * 60 if obj.get("duration") else None, "at": now_utc()}
    res = await db[meetings.COLL].update_one({"_id": mrow["_id"], "recording.key": {"$exists": False}},
                                             {"$set": {"recording": rec}})
    if res.modified_count == 0:     # deleted meanwhile, or another copy won: this one goes
        await run_in_threadpool(r2.delete, bkey)
        await _rec(db, key, "gone")
        return "gone"
    await _rec(db, key, "ready", rec_reason=None)
    log.info("zoom: kept the recording of a meeting in %s (%d bytes)", ws, size)
    return "ready"


async def drop(row: dict | None) -> bool:
    """Delete a meeting row's stored video (the row's ``recording`` is the caller's to unset)."""
    from app.services import r2

    key = ((row or {}).get("recording") or {}).get("key")
    if not key or not str(key).startswith("art/zoom/"):
        return False
    await run_in_threadpool(r2.delete, key)
    return True


async def forget_document(db: AsyncIOMotorDatabase, doc_id: Any) -> None:
    """A meeting page deleted for good: its stored video goes too."""
    from app.services import meetings

    ids = [doc_id, str(doc_id)]
    async for row in db[meetings.COLL].find({"doc_id": {"$in": ids}, "recording.key": {"$exists": True}}, {"recording": 1}):
        await drop(row)
        await db[meetings.COLL].update_one({"_id": row["_id"]}, {"$unset": {"recording": ""}})


async def remove(db: AsyncIOMotorDatabase, row: dict) -> dict:
    """Remove a meeting's stored video (the caller checked who may)."""
    from app.services import meetings, zoom

    await drop(row)
    await db[meetings.COLL].update_one({"_id": row["_id"]}, {"$unset": {"recording": ""}})
    uuid = ((row.get("recording") or {}).get("uuid")) or ""
    if uuid:
        await db[zoom.MEETINGS].update_one({"_id": f"{row['workspace_id']}:{uuid}"}, {"$set": {"rec_state": "removed"}})
    return {"removed": True}


def player(row: dict) -> dict | None:
    """A short-lived signed link to the files origin's video player for a meeting's recording."""
    from app.services import artifact, publicity, r2

    rec = row.get("recording") or {}
    if not rec.get("key") or not r2.is_configured():
        return None
    ttl = publicity.ttl_for(VIDEO_MIME)
    return {"player_url": artifact.build_artifact_url(rec["key"], VIDEO_MIME, private=True, ttl=ttl),
            "size": rec.get("size"), "duration_s": rec.get("duration_s"),
            "expires_in": ttl}


def view(row: dict) -> dict | None:
    """What a meeting's reader sees about its recording (no key, no link)."""
    rec = row.get("recording") or {}
    if not rec.get("key"):
        return None
    return {"size": rec.get("size"), "duration_s": rec.get("duration_s"), "source": "zoom"}


# ── The background loop ───────────────────────────────────────────────────────


async def run_waiting(db: AsyncIOMotorDatabase, row: dict) -> dict:
    """A meeting whose wait is over: fetch it from Zoom again (its transcript may be there now) and import."""
    from app.services import zoom

    ws, uuid, key = row["workspace_id"], row["uuid"], row["_id"]
    conn = await zoom.get(db, ws)
    if not zoom.is_connected(conn):
        await db[zoom.MEETINGS].update_one({"_id": key, "state": "waiting"}, {"$set": {"state": "no_transcript",
                                                                                    "reason": zoom.NO_TRANSCRIPT}})
        return {"status": "no_transcript"}
    try:
        obj = await zoom.call(db, conn, "GET", f"meetings/{zoom_api.uuid_path(uuid)}/recordings") or {}
    except (zoom_api.ZoomError, zoom.ZoomUnavailable) as exc:
        missing = isinstance(exc, zoom_api.ZoomError) and exc.missing
        tries = int(row.get("tries") or 0) + 1
        if missing or tries >= MAX_TRIES:
            await db[zoom.MEETINGS].update_one({"_id": key, "state": "waiting"}, {"$set": {
                "state": "failed", "at": now_utc(),
                "reason": "Zoom no longer has this recording." if missing else str(exc)[:300]}})
            return {"status": "failed"}
        await db[zoom.MEETINGS].update_one({"_id": key, "state": "waiting"},
                                           {"$set": {"due_at": now_utc() + RETRY, "tries": tries}})
        return {"status": "waiting"}
    obj.setdefault("uuid", uuid)
    out = await zoom.handle_recording(db, ws, obj, via=row.get("via") or "backfill", transcribe_now=True)
    # Nothing moved it on (the host left the team, no team any more…): it stops waiting.
    await db[zoom.MEETINGS].update_one({"_id": key, "state": "waiting", "due_at": row.get("due_at")},
                                       {"$set": {"state": "no_transcript", "at": now_utc(), "reason": zoom.NO_TRANSCRIPT}})
    return out


async def tick(db: AsyncIOMotorDatabase) -> int:
    """One pass: the next due transcription, then the next queued recording. How many ran."""
    from app.services import zoom

    n = 0
    now = now_utc()
    row = await db[zoom.MEETINGS].find_one({"state": "waiting", "due_at": {"$lte": now}}, sort=[("due_at", 1)])
    if row is not None:
        try:
            await run_waiting(db, row)
        except Exception:
            log.warning("zoom: a waiting meeting failed", exc_info=True)
            await db[zoom.MEETINGS].update_one({"_id": row["_id"], "state": "waiting"},
                                               {"$set": {"due_at": now + RETRY}, "$inc": {"tries": 1}})
        n += 1
    rec = await db[zoom.MEETINGS].find_one(
        {"$or": [{"rec_state": "queued"}, {"rec_state": "copying", "rec_at": {"$lt": now - STALE}},
                 {"rec_state": "failed", "rec_tries": {"$lt": MAX_TRIES}, "rec_at": {"$lt": now - RETRY}}]},
        sort=[("rec_at", 1)])
    if rec is not None:
        try:
            await copy_recording(db, rec["_id"])
        except Exception:
            log.warning("zoom: copying a recording failed", exc_info=True)
            await _rec(db, rec["_id"], "failed")
        n += 1
    return n


async def run_all(db: AsyncIOMotorDatabase, *, limit: int = 50) -> int:
    """Run passes until nothing is due (tests)."""
    total = 0
    for _ in range(limit):
        got = await tick(db)
        if not got:
            break
        total += got
    return total
