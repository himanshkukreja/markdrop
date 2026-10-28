"""Creator analytics — the read side (build spec §3).

Everything is computed at query time from ``events`` (views, previews) and
``engage_sessions`` (services/engage.py); there is no rollup collection at this
scale. Work is bounded: a query reads at most :data:`SESSION_CAP` sessions (the
most recent in the range) and says ``sampled: true`` when it had to stop.

Conventions:

* ``range`` is 7d | 30d | 90d | all; each window is compared with the window of
  the same length just before it (no comparison for ``all``).
* ``internal=False`` (the default) hides workspace members' views and sessions.
* People = distinct ``ip_hash`` among views (the static hash; owner decision).
* Audience rows with fewer than :data:`K_ANON` people fold into "Other".
* ``watched_s`` = length of the union of a session's watched ranges.
"""

from __future__ import annotations

import csv
import io
import math
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from statistics import median
from urllib.parse import urlsplit

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import engage, insights, presence, traffic
from app.services.analytics import FINISHED_AT, clean_referrer
from app.services.engage import aware, decode_key, merge_segs

RANGES = {"7d": 7, "30d": 30, "90d": 90, "all": None}
SESSION_CAP = 20_000
K_ANON = 5
RETENTION_POINTS = 600
REWATCH_BUCKETS = 60
SLOW_START_MS = 5000
MEDIA_KINDS = ("video", "audio")


# ── Windows ───────────────────────────────────────────────────────────────────


@dataclass
class Window:
    key: str
    start: datetime | None
    end: datetime
    prev_start: datetime | None = None
    prev_end: datetime | None = None

    @property
    def has_prev(self) -> bool:
        return self.prev_start is not None


def window(range_key: str, now: datetime | None = None) -> Window:
    """The window for a range: whole UTC days, today included (so the daily
    series adds up to the totals). The previous window is the same span just
    before it, cut at the same time of day, so the two are equally long."""
    now = now or datetime.now(timezone.utc)
    days = RANGES.get(range_key, 30)
    if days is None:
        return Window(range_key, None, now)
    start = datetime.combine(now.date() - timedelta(days=days - 1), datetime.min.time(), tzinfo=timezone.utc)
    delta = timedelta(days=days)
    return Window(range_key, start, now, start - delta, now - delta)


def _ts(field: str, start: datetime | None, end: datetime | None) -> dict:
    clause: dict = {}
    if start is not None:
        clause["$gte"] = start
    if end is not None:
        clause["$lt"] = end
    return {field: clause} if clause else {}


def _internal(internal: bool) -> dict:
    return {} if internal else {"internal": {"$ne": True}}


def views_match(scope: dict, start, end, internal: bool) -> dict:
    return {**scope, "type": "view", **_ts("ts", start, end), **_internal(internal)}


def sessions_match(scope: dict, start, end, internal: bool) -> dict:
    return {**scope, **_ts("started_at", start, end), **_internal(internal)}


async def load_sessions(db: AsyncIOMotorDatabase, match: dict, projection: dict | None = None,
                        cap: int = SESSION_CAP) -> tuple[list[dict], bool]:
    """The newest ``cap`` sessions matching, and whether there were more."""
    rows = await db[engage.COLL].find(match, projection).sort("started_at", -1).limit(cap + 1) \
        .to_list(length=cap + 1)
    return rows[:cap], len(rows) > cap


# ── Small helpers ─────────────────────────────────────────────────────────────


def pct(n: float, d: float) -> float:
    return round(100.0 * n / d, 1) if d else 0.0


def med(values) -> float:
    vals = [v for v in values if v is not None]
    return round(float(median(vals)), 1) if vals else 0.0


def iso(dt: datetime | None) -> str | None:
    dt = aware(dt)
    return dt.isoformat() if dt else None


def kpi(key: str, label: str, value, unit: str, prev=None, note: str | None = None,
        has_prev: bool = False) -> dict:
    out = {"key": key, "label": label, "value": value, "unit": unit}
    if has_prev and prev is not None:
        out["prev"] = prev
    if note:
        out["note"] = note
    return out


def doc_title(raw: dict) -> str | None:
    if raw.get("encrypted"):
        return None
    return (raw.get("title") or "").strip() or raw.get("original_filename") or None


def renderer_of(raw: dict) -> str | None:
    if raw.get("kind") != "artifact":
        return None
    from app.services import artifact

    return artifact.renderer_for(raw.get("mime") or "")


def _media(s: dict) -> dict:
    return s.get("media") or {}


def is_playing(s: dict) -> bool:
    m = _media(s)
    return (m.get("plays") or 0) >= 1 or bool(m.get("segs"))


def watched_frac(s: dict, dur: float | None) -> float | None:
    m = _media(s)
    d = m.get("dur") or dur
    if not d:
        return None
    return min(1.0, (m.get("watched_s") or 0) / d)


def engaged(s: dict, kind: str, dur: float | None = None) -> bool:
    """Did this session finish? doc: read to the end; pdf: reached the last
    page; video/audio: played to the end (or watched ≥ 90%); other: ≥ 30 s."""
    if kind == "doc":
        return (s.get("depth") or 0) >= FINISHED_AT
    if kind == "pdf":
        n = s.get("npages")
        return bool(n) and (s.get("pmax") or 0) >= n
    if kind in MEDIA_KINDS:
        m = _media(s)
        if (m.get("ended") or 0) >= 1:
            return True
        f = watched_frac(s, dur)
        return f is not None and f >= 0.9
    return (s.get("active_s") or 0) >= 30


def engaged_pct(sessions: list[dict], kind: str, dur: float | None = None) -> float | None:
    if kind in MEDIA_KINDS:
        sessions = [s for s in sessions if is_playing(s)]
    if not sessions:
        return None
    return pct(sum(1 for s in sessions if engaged(s, kind, dur)), len(sessions))


def primary_metric(sessions: list[dict], kind: str, dur: float | None = None) -> dict:
    """The one number a version or a link is judged by."""
    if kind in MEDIA_KINDS:
        fr = [f for f in (watched_frac(s, dur) for s in sessions if is_playing(s)) if f is not None]
        return {"label": "Avg listened" if kind == "audio" else "Avg watched",
                "value": round(100 * sum(fr) / len(fr), 1) if fr else 0.0, "unit": "percent"}
    if kind == "pdf":
        known = [s for s in sessions if s.get("npages")]
        return {"label": "Reached the end", "unit": "percent",
                "value": pct(sum(1 for s in known if engaged(s, "pdf")), len(known))}
    if kind == "doc":
        return {"label": "Read to the end", "unit": "percent",
                "value": pct(sum(1 for s in sessions if engaged(s, "doc")), len(sessions))}
    return {"label": "Median time", "unit": "seconds", "value": med(s.get("active_s") for s in sessions)}


def engage_label(sessions: list[dict], kind: str) -> str | None:
    """A one-line engagement summary for a link row ("62% watched")."""
    if not sessions:
        return None
    m = primary_metric(sessions, kind)
    if kind in MEDIA_KINDS:
        return f"{m['value']:.0f}% {'listened' if kind == 'audio' else 'watched'}"
    if kind == "pdf":
        return f"{m['value']:.0f}% reached the end"
    if kind == "doc":
        return f"{m['value']:.0f}% read to the end"
    return f"{fmt_duration(m['value'])} median time"


def fmt_duration(seconds: float) -> str:
    s = int(round(seconds or 0))
    if s < 60:
        return f"{s}s"
    m, s = divmod(s, 60)
    if m < 60:
        return f"{m}m {s}s" if s else f"{m}m"
    h, m = divmod(m, 60)
    return f"{h}h {m}m"


def fold_k(rows: list[dict], key: str, *, people: str = "people", other: dict | None = None,
           k: int = K_ANON) -> tuple[list[dict], list[dict]]:
    """Rows with at least ``k`` people, biggest first; the rest summed into an
    "Other" row at the end. Returns (rows, folded) — ``folded`` is what went
    into Other (callers compute its engagement from them)."""
    keep = sorted([r for r in rows if (r.get(people) or 0) >= k], key=lambda r: -r[people])
    small = [r for r in rows if (r.get(people) or 0) < k]
    if small:
        row = {key: "Other", **(other or {}), people: sum(r.get(people) or 0 for r in small)}
        keep.append(row)
    return keep, small


# ── Views ─────────────────────────────────────────────────────────────────────


async def views_count(db, match: dict) -> int:
    return await db["events"].count_documents(match)


async def people_count(db, match: dict) -> int:
    rows = await db["events"].aggregate([
        {"$match": {**match, "ip_hash": {"$ne": None}}},
        {"$group": {"_id": "$ip_hash"}},
        {"$count": "n"},
    ]).to_list(length=1)
    return rows[0]["n"] if rows else 0


async def daily_views(db, match: dict) -> dict[str, dict]:
    """{date: {views, people}}."""
    out: dict[str, dict] = {}
    async for row in db["events"].aggregate([
        {"$match": match},
        {"$group": {"_id": {"d": {"$dateToString": {"format": "%Y-%m-%d", "date": "$ts"}},
                            "ip": "$ip_hash"}, "n": {"$sum": 1}}},
        {"$group": {"_id": "$_id.d", "views": {"$sum": "$n"},
                    "people": {"$sum": {"$cond": [{"$ne": ["$_id.ip", None]}, 1, 0]}}}},
    ]):
        out[row["_id"]] = {"views": row["views"], "people": row["people"]}
    return out


def date_span(w: Window, have: list[str], created: datetime | None = None) -> list[str]:
    end = w.end.date()
    if w.start is not None:
        start = w.start.date()
    elif have:
        start = date.fromisoformat(min(have))
    else:
        start = (aware(created) or w.end).date()
    start = max(start, end - timedelta(days=3 * 366))
    days = (end - start).days
    return [(start + timedelta(days=i)).isoformat() for i in range(days + 1)]


def _channel_of(row_channel: str | None, referrer: str | None) -> str:
    if row_channel:
        return row_channel
    ref = clean_referrer(referrer) if referrer else None
    return traffic.channel_for(urlsplit(ref).hostname if ref else None, None, None)


async def sources(db, match: dict) -> list[dict]:
    """Views by channel; rows from before channels were stored fall back to
    their referrer's host."""
    counts: dict[str, int] = defaultdict(int)
    async for row in db["events"].aggregate([
        {"$match": match},
        {"$group": {"_id": {"c": "$channel", "r": "$referrer"}, "n": {"$sum": 1}}},
        {"$limit": 5000},
    ]):
        counts[_channel_of(row["_id"].get("c"), row["_id"].get("r"))] += row["n"]
    return [{"channel": c, "views": n} for c, n in sorted(counts.items(), key=lambda kv: -kv[1])]


async def returning_split(db, scope: dict, w: Window, internal: bool) -> tuple[int, int]:
    """(new, returning) among the people with views in the window. Returning =
    views on at least two distinct days, ever, up to the window's end."""
    rows = await db["events"].aggregate([
        {"$match": {**scope, "type": "view", "ip_hash": {"$ne": None}, "ts": {"$lt": w.end},
                    **_internal(internal)}},
        {"$group": {"_id": "$ip_hash",
                    "days": {"$addToSet": {"$dateToString": {"format": "%Y-%m-%d", "date": "$ts"}}},
                    "last": {"$max": "$ts"}}},
        *([{"$match": {"last": {"$gte": w.start}}}] if w.start is not None else []),
        {"$group": {"_id": None,
                    "new": {"$sum": {"$cond": [{"$lt": [{"$size": "$days"}, 2]}, 1, 0]}},
                    "returning": {"$sum": {"$cond": [{"$gte": [{"$size": "$days"}, 2]}, 1, 0]}}}},
    ]).to_list(length=1)
    if not rows:
        return 0, 0
    return rows[0]["new"], rows[0]["returning"]


async def signals(db, scope: dict, w: Window) -> list[dict]:
    out = []
    async for row in db["events"].aggregate([
        {"$match": {**scope, "type": "preview", **_ts("ts", w.start, w.end)}},
        {"$group": {"_id": "$platform", "n": {"$sum": 1}, "last": {"$max": "$ts"}}},
        {"$sort": {"n": -1}},
    ]):
        out.append({"platform": row["_id"] or "Other", "n": row["n"], "last": iso(row["last"])})
    return out


# ── Media math ────────────────────────────────────────────────────────────────


def bucket_size(dur: float) -> float:
    return max(1.0, dur / RETENTION_POINTS)


def _bucket_range(s: float, e: float, b: float, n: int) -> tuple[int, int]:
    """Buckets whose midpoint lies in [s, e): indices [i0, i1)."""
    i0 = max(0, math.ceil(s / b - 0.5))
    i1 = min(n, math.ceil(e / b - 0.5))
    return i0, i1


def retention(sessions: list[dict], dur: float) -> tuple[list[dict], int]:
    """Per-bucket share of playing sessions whose watched ranges cover the
    bucket (its midpoint). ≤ 600 points, bucket = max(1, dur/600) seconds.
    Returns (points, playing sessions)."""
    if not dur or dur <= 0:
        return [], 0
    b = bucket_size(dur)
    n = min(RETENTION_POINTS, max(1, math.ceil(dur / b - 1e-9)))
    diff = [0] * (n + 1)
    denom = 0
    for s in sessions:
        if not is_playing(s):
            continue
        denom += 1
        for st, en in merge_segs(_media(s).get("segs") or []):
            i0, i1 = _bucket_range(st, en, b, n)
            if i1 > i0:
                diff[i0] += 1
                diff[i1] -= 1
    points, run = [], 0
    for i in range(n):
        run += diff[i]
        points.append({"t": round(i * b, 2), "pct": pct(run, denom)})
    return points, denom


def retention_at(points: list[dict], t: float) -> float | None:
    if not points:
        return None
    b = (points[1]["t"] - points[0]["t"]) if len(points) > 1 else 1.0
    i = int(t // b) if b else 0
    if i >= len(points):
        return None
    return points[i]["pct"]


def rewatch(sessions: list[dict], dur: float) -> tuple[list[float], list[dict]]:
    """60 buckets: views of each bucket per watching session, normalised to
    0..1 by the busiest bucket (0 where nobody watched). Also returns per-bucket
    {t, ratio, watchers} — views per session that watched that bucket."""
    if not dur or dur <= 0:
        return [0.0] * REWATCH_BUCKETS, []
    b = dur / REWATCH_BUCKETS
    views = [0] * REWATCH_BUCKETS
    watchers = [0] * REWATCH_BUCKETS
    denom = 0
    for s in sessions:
        if not is_playing(s):
            continue
        denom += 1
        cov = [0] * REWATCH_BUCKETS
        for st, en in _media(s).get("segs") or []:
            i0, i1 = _bucket_range(st, en, b, REWATCH_BUCKETS)
            for i in range(i0, i1):
                cov[i] += 1
        for i, c in enumerate(cov):
            if c:
                views[i] += c
                watchers[i] += 1
    if not denom:
        return [0.0] * REWATCH_BUCKETS, []
    avg = [v / denom for v in views]
    top = max(avg) or 0
    strip = [round(a / top, 3) if top else 0.0 for a in avg]
    detail = [{"t": round(i * b, 2), "ratio": (views[i] / watchers[i]) if watchers[i] else 0.0,
               "watchers": watchers[i]} for i in range(REWATCH_BUCKETS)]
    return strip, detail


def moments(points: list[dict], playing: int, dur: float, rw_detail: list[dict], kind: str) -> list[dict]:
    noun = "listening" if kind == "audio" else "watching"
    out: list[dict] = []
    if not playing:
        return out
    if dur > 30:
        h = retention_at(points, 30)
        if h is not None:
            out.append({"t": 30, "kind": "hold", "pct": h,
                        "title": f"{h:.0f}% still {noun} at 0:30",
                        "body": "Of everyone who pressed play."})
    drop = insights.biggest_drop(points, dur=dur)
    if drop and drop["delta"] > 0:
        t = insights.fmt_t(drop["t"])
        out.append({"t": drop["t"], "kind": "drop", "delta": drop["delta"], "pct": drop["pct"],
                    "title": f"Most {'listeners' if kind == 'audio' else 'viewers'} leave at {t}",
                    "body": f"{drop['delta']:.0f}% stop within 10 seconds of {t}."})
    floor = max(3, math.ceil(0.1 * playing))
    best = max((r for r in rw_detail if r["watchers"] >= floor), key=lambda r: r["ratio"], default=None)
    if best and best["ratio"] >= 1.2:
        t = insights.fmt_t(best["t"])
        out.append({"t": best["t"], "kind": "rewatch",
                    "title": f"Replayed most at {t}",
                    "body": f"People who reach it play it {best['ratio']:.1f}× on average."})
    return out[:3]


def p95(values: list[float]) -> float:
    vals = sorted(values)
    if not vals:
        return 0
    return vals[min(len(vals) - 1, max(0, math.ceil(0.95 * len(vals)) - 1))]


def qoe(sessions: list[dict], *, size_bytes: int | None, dur: float | None) -> dict:
    startups = [_media(s)["startup_ms"] for s in sessions if _media(s).get("startup_ms") is not None]
    playing = [s for s in sessions if is_playing(s)]
    failed = [s for s in sessions if _media(s).get("err")]
    by_reason: dict[str, int] = defaultdict(int)
    for s in failed:
        by_reason[_media(s)["err"]] += 1
    phones = [s for s in sessions if s.get("device") == "Mobile" and _media(s).get("startup_ms") is not None]
    slow = [s for s in phones if _media(s)["startup_ms"] > SLOW_START_MS]
    by_country: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for s in phones:
        if s.get("country"):
            c = by_country[s["country"]]
            c[0] += 1
            c[1] += 1 if _media(s)["startup_ms"] > SLOW_START_MS else 0
    phone_slow_by = sorted(
        [{"country": k, "pct": pct(v[1], v[0])} for k, v in by_country.items() if v[0] >= K_ANON],
        key=lambda r: -r["pct"])
    bitrate = round(size_bytes * 8 / dur / 1000) if size_bytes and dur else None
    phone_slow_pct = pct(len(slow), len(phones))
    suggestion = None
    if len(phones) >= K_ANON and phone_slow_pct >= 20:
        suggestion = ("Phones often wait more than 5 seconds to start. A smaller file "
                      "(around 2–3 Mbps, 720p) would start faster on mobile networks.")
        if bitrate is not None and bitrate <= 3000:
            suggestion = ("Phones often wait more than 5 seconds to start, even at this bitrate — "
                          "check where your viewers are and their connections.")
    return {
        "startup_p50_ms": round(median(startups)) if startups else None,
        "startup_p95_ms": round(p95(startups)) if startups else None,
        "stalled_pct": pct(sum(1 for s in playing if (_media(s).get("rebuf_n") or 0) >= 1), len(playing)),
        "failed_pct": pct(len(failed), len(sessions)),
        "failed_n": len(failed),
        "failed_by": [{"reason": r, "n": n} for r, n in sorted(by_reason.items(), key=lambda kv: -kv[1])],
        "phone_slow_pct": phone_slow_pct,
        "phone_slow_by": phone_slow_by,
        "bitrate_kbps": bitrate,
        "suggestion": suggestion,
    }


# ── Documents ─────────────────────────────────────────────────────────────────


async def version_rows(db, raw: dict) -> list[dict]:
    if raw.get("kind") != "artifact":
        return []
    from app.services import file_versions

    return await file_versions.rows_for(db, raw)


def session_ver_filter(raw: dict, ver: int | None) -> dict:
    if ver is None:
        return {}
    current = int(raw.get("file_version") or 1)
    if ver == current:
        return {"ver": {"$in": [ver, None]}}
    return {"ver": ver}


def doc_dur(raw: dict, sessions: list[dict], row: dict | None = None) -> float | None:
    media = (row or {}).get("media") or raw.get("media") or {}
    d = media.get("duration_s")
    if d:
        return float(d)
    ds = [_media(s).get("dur") for s in sessions if _media(s).get("dur")]
    return float(max(ds)) if ds else None


async def doc_head(db, raw: dict, sessions: list[dict] | None = None) -> dict:
    from app.services import urls
    from app.services import workspace as ws_service

    kind = engage.kind_for(raw)
    ws = None
    if raw.get("workspace_id"):
        w = await ws_service.get_workspace(db, raw["workspace_id"])
        if w is not None:
            ws = {"id": w.id, "name": w.name}
    npages = None
    if kind == "pdf" and sessions:
        npages = max((s.get("npages") or 0 for s in sessions), default=0) or None
    head = {
        "slug": raw["slug"],
        "title": doc_title(raw),
        "kind": kind,
        "renderer": renderer_of(raw),
        "mime": raw.get("mime"),
        "file_version": int(raw.get("file_version") or 1),
        "workspace": ws,
        "address": await urls.canonical_url(db, raw),
        "created_at": iso(raw.get("created_at")),
    }
    dur = (raw.get("media") or {}).get("duration_s")
    if kind in MEDIA_KINDS and dur:
        head["duration_s"] = dur
    if npages:
        head["npages"] = npages
    return head


_SESSION_FIELDS = {
    "_id": 0, "doc_id": 1, "kind": 1, "ver": 1, "started_at": 1, "updated_at": 1, "ip_hash": 1,
    "country": 1, "device": 1, "channel": 1, "utm_source": 1, "utm_medium": 1, "utm_campaign": 1,
    "internal": 1, "active_s": 1, "depth": 1, "npages": 1, "pmax": 1, "media": 1,
}


def _sections(sessions: list[dict]) -> list[dict]:
    """Heading ids in first-seen order (oldest session first), with the share
    of sessions that reached each and the median seconds spent in it."""
    order: list[str] = []
    seen: set[str] = set()
    reached: dict[str, int] = defaultdict(int)
    secs: dict[str, list[float]] = defaultdict(list)
    for s in reversed(sessions):
        for h in s.get("reached") or []:
            if h not in seen:
                seen.add(h)
                order.append(h)
            reached[h] += 1
        for k, v in (s.get("sec") or {}).items():
            k = decode_key(k)
            if v and v > 0:
                secs[k].append(v)
                if k not in seen:
                    seen.add(k)
                    order.append(k)
    n = len(sessions)
    return [{"id": h, "reached_pct": pct(reached.get(h, 0), n), "median_s": med(secs.get(h, []))}
            for h in order[:engage.MAP_KEYS]]


def _pages(sessions: list[dict]) -> dict:
    known = [s for s in sessions if s.get("npages") or s.get("pmax")]
    npages = max((s.get("npages") or s.get("pmax") or 0 for s in known), default=0)
    npages = min(npages, engage.MAX_PAGES)
    n = len(known)
    reach, time, back = [], [], []
    for p in range(1, npages + 1):
        got = [s for s in known if (s.get("pmax") or 0) >= p]
        reach.append({"page": p, "pct": pct(len(got), n)})
        key = str(p)
        time.append({"page": p, "median_s": med(
            (s.get("pages") or {}).get(key) for s in known if (s.get("pages") or {}).get(key))})
        back.append({"page": p, "pct": pct(sum(1 for s in got if ((s.get("rv") or {}).get(key) or 0) >= 1),
                                           len(got))})
    drop = None
    for a, b in zip(reach, reach[1:]):
        d = round(a["pct"] - b["pct"], 1)
        if d > 0 and (drop is None or d > drop["pct"]):
            drop = {"after_page": a["page"], "pct": d}
    return {"sessions": n, "npages": npages, "reach": reach, "time": time, "back": back,
            "biggest_drop": drop}


def _phone(sessions: list[dict]) -> dict:
    phones = [s for s in sessions if s.get("device") == "Mobile" and _media(s).get("startup_ms") is not None]
    slow = sum(1 for s in phones if _media(s)["startup_ms"] > SLOW_START_MS)
    return {"n": len(phones), "slow_pct": pct(slow, len(phones))}


def _by_ver(sessions: list[dict], raw: dict) -> dict[int, list[dict]]:
    current = int(raw.get("file_version") or 1)
    out: dict[int, list[dict]] = defaultdict(list)
    for s in sessions:
        out[int(s.get("ver") or current)].append(s)
    return out


async def _other_videos_hold30(db, raw: dict, w: Window, internal: bool) -> float | None:
    """Median retention at 0:30 across the owner's other videos with enough
    playing sessions."""
    owner = raw.get("owner_id")
    if not owner:
        return None
    others = await db["documents"].find(
        {"owner_id": owner, "kind": "artifact", "mime": {"$regex": "^video/"}, "_id": {"$ne": raw["_id"]}},
        {"_id": 1, "media": 1}).limit(20).to_list(length=20)
    holds = []
    for o in others:
        rows, _ = await load_sessions(
            db, sessions_match({"doc_id": str(o["_id"])}, w.start, w.end, internal),
            {"media.segs": 1, "media.plays": 1, "media.dur": 1}, cap=2000)
        dur = doc_dur(o, rows)
        if not dur or dur <= 30:
            continue
        pts, playing = retention(rows, dur)
        if playing >= insights.MIN_SESSIONS:
            h = retention_at(pts, 30)
            if h is not None:
                holds.append(h)
    return round(float(median(holds)), 1) if holds else None


async def _channel_engagement(db, scope: dict, w: Window, internal: bool, sessions: list[dict],
                              kind: str, dur: float | None) -> list[dict]:
    rows = await sources(db, views_match(scope, w.start, w.end, internal))
    by: dict[str, list[dict]] = defaultdict(list)
    for s in sessions:
        by[s.get("channel") or "Direct"].append(s)
    return [{**r, "engaged_pct": engaged_pct(by.get(r["channel"], []), kind, dur)} for r in rows]


async def doc_insights(db, raw: dict, w: Window, internal: bool, *, sessions: list[dict] | None = None,
                       views: int | None = None, prev_views: int | None = None) -> list[dict]:
    """§5 rules for one document over the window."""
    doc_id = str(raw["_id"])
    scope = {"doc_id": doc_id}
    kind = engage.kind_for(raw)
    if sessions is None:
        sessions, _ = await load_sessions(db, sessions_match(scope, w.start, w.end, internal))
    if views is None:
        views = await views_count(db, views_match(scope, w.start, w.end, internal))
    if prev_views is None and w.has_prev:
        prev_views = await views_count(db, views_match(scope, w.prev_start, w.prev_end, internal))
    current = int(raw.get("file_version") or 1)
    cur_sessions = [s for s in sessions if int(s.get("ver") or current) == current] \
        if kind != "doc" else sessions
    dur = doc_dur(raw, cur_sessions)
    stats: dict = {"kind": kind, "slug": raw["slug"], "views": views,
                   "prev_views": prev_views if w.has_prev else None, "sessions": len(sessions)}
    if kind in MEDIA_KINDS and dur:
        pts, playing = retention(cur_sessions, dur)
        stats.update(retention=pts, playing=playing, dur=dur, hold30=retention_at(pts, 30) if dur > 30 else None)
        if playing >= insights.MIN_SESSIONS and dur > 30:
            stats["other_hold30"] = await _other_videos_hold30(db, raw, w, internal)
        stats["phone"] = _phone(cur_sessions)
    if kind == "doc" and not raw.get("encrypted"):
        full, _ = await load_sessions(db, sessions_match(scope, w.start, w.end, internal),
                                      {"reached": 1, "sec": 1})
        stats["sections"] = _sections(full)
    if kind == "pdf":
        full, _ = await load_sessions(db, sessions_match(scope, w.start, w.end, internal),
                                      {"npages": 1, "pmax": 1})
        stats["pages"] = _pages(full)
    if kind != "doc" and current > 1:
        by = _by_ver(sessions, raw)
        vs = []
        for v in sorted(by, reverse=True)[:2]:
            m = primary_metric(by[v], kind, dur)
            vs.append({"version": v, "sessions": len(by[v]), "metric": m["value"]})
            stats["metric_label"] = m["label"]
        stats["versions"] = vs
    stats["channels"] = await _channel_engagement(db, scope, w, internal, sessions, kind, dur)
    stats["engaged_pct"] = engaged_pct(sessions, kind, dur)
    stats["signals"] = await signals(db, scope, w)
    return insights.for_document(stats)


async def overview(db, raw: dict, w: Window, internal: bool) -> dict:
    doc_id = str(raw["_id"])
    scope = {"doc_id": doc_id}
    kind = engage.kind_for(raw)
    vm = views_match(scope, w.start, w.end, internal)
    sessions, sampled = await load_sessions(db, sessions_match(scope, w.start, w.end, internal), _SESSION_FIELDS)
    prev_sessions: list[dict] = []
    if w.has_prev:
        prev_sessions, s2 = await load_sessions(
            db, sessions_match(scope, w.prev_start, w.prev_end, internal), _SESSION_FIELDS)
        sampled = sampled or s2
    views = await views_count(db, vm)
    people = await people_count(db, vm)
    prev_views = prev_people = None
    if w.has_prev:
        pm = views_match(scope, w.prev_start, w.prev_end, internal)
        prev_views = await views_count(db, pm)
        prev_people = await people_count(db, pm)
    first = await db[engage.COLL].find_one({"doc_id": doc_id}, {"started_at": 1}, sort=[("started_at", 1)])
    dur = doc_dur(raw, sessions)
    hp = w.has_prev
    kpis = [kpi("views", "Views", views, "count", prev_views, has_prev=hp),
            kpi("people", "People", people, "count", prev_people, has_prev=hp)]

    def both(fn):
        return fn(sessions), (fn(prev_sessions) if hp else None)

    if kind == "doc":
        ra = both(lambda ss: pct(sum(1 for s in ss if engaged(s, "doc")), len(ss)))
        rt = both(lambda ss: med(s.get("active_s") for s in ss))
        cc = await _copies_clicks(db, sessions_match(scope, w.start, w.end, internal))
        pcc = await _copies_clicks(db, sessions_match(scope, w.prev_start, w.prev_end, internal)) if hp else None
        kpis += [kpi("read_all", "Read to the end", ra[0], "percent", ra[1], has_prev=hp),
                 kpi("read_time", "Median read time", rt[0], "seconds", rt[1], has_prev=hp),
                 kpi("copies_clicks", "Copies & link clicks", cc, "count", pcc, has_prev=hp)]
    elif kind == "pdf":
        def reached_end(ss):
            known = [s for s in ss if s.get("npages")]
            return pct(sum(1 for s in known if engaged(s, "pdf")), len(known))
        re_ = both(reached_end)
        rt = both(lambda ss: med(s.get("active_s") for s in ss))
        pg = both(lambda ss: med(s.get("pmax") for s in ss if s.get("pmax")))
        npages = max((s.get("npages") or 0 for s in sessions), default=0)
        kpis += [kpi("reached_end", "Reached the last page", re_[0], "percent", re_[1], has_prev=hp),
                 kpi("read_time", "Median read time", rt[0], "seconds", rt[1], has_prev=hp),
                 kpi("pages_npages", "Pages read", pg[0], "count", pg[1],
                     note=f"of {npages}" if npages else None, has_prev=hp)]
    elif kind in MEDIA_KINDS:
        audio = kind == "audio"
        wt = both(lambda ss: round(sum(_media(s).get("watched_s") or 0 for s in ss), 1))
        aw = both(lambda ss: primary_metric(ss, kind, dur)["value"])
        pl = both(lambda ss: pct(sum(1 for s in ss if is_playing(s)), len(ss)))
        kpis += [kpi("watch_time", "Listen time" if audio else "Watch time", wt[0], "seconds", wt[1], has_prev=hp),
                 kpi("avg_watched", "Avg listened" if audio else "Avg watched", aw[0], "percent", aw[1],
                     has_prev=hp),
                 kpi("played", "Played", pl[0], "percent", pl[1], has_prev=hp)]
    else:
        tm = both(lambda ss: med(s.get("active_s") for s in ss))
        _new, ret = await returning_split(db, scope, w, internal)
        prev_ret = None
        if hp:
            _n2, prev_ret = await returning_split(db, scope, Window("prev", w.prev_start, w.prev_end), internal)
        kpis += [kpi("time", "Median time", tm[0], "seconds", tm[1], has_prev=hp),
                 kpi("returning", "Returning", ret, "count", prev_ret, has_prev=hp)]
    if sampled:
        for k in kpis[2:]:
            k.setdefault("note", f"Based on the latest {SESSION_CAP:,} sessions")

    days = await daily_views(db, vm)
    daily = [{"date": d, "views": days.get(d, {}).get("views", 0), "people": days.get(d, {}).get("people", 0)}
             for d in date_span(w, list(days), raw.get("created_at"))]
    marks = []
    for r in await version_rows(db, raw):
        at = aware(r.get("created_at"))
        if r["version"] > 1 and at and (w.start is None or at >= w.start) and at <= w.end:
            marks.append({"date": at.date().isoformat(), "version": r["version"]})
    marks.sort(key=lambda m: m["version"])
    return {
        "doc": await doc_head(db, raw, sessions),
        "range": w.key,
        "has_engagement": first is not None,
        "tracking_since": iso(first["started_at"]) if first else None,
        "live": presence.count(doc_id, include_internal=internal),
        "kpis": kpis,
        "daily": daily,
        "versions_marks": marks,
        "sources": await sources(db, vm),
        "insights": await doc_insights(db, raw, w, internal, sessions=sessions, views=views,
                                       prev_views=prev_views),
        "sampled": sampled,
    }


async def _copies_clicks(db, match: dict) -> int:
    total = 0
    rows, _ = await load_sessions(db, match, {"copies": 1, "links": 1})
    for s in rows:
        total += sum((s.get("copies") or {}).values()) + sum((s.get("links") or {}).values())
    return int(total)


async def media_report(db, raw: dict, w: Window, internal: bool, ver: int | None) -> dict:
    doc_id = str(raw["_id"])
    kind = engage.kind_for(raw)
    current = int(raw.get("file_version") or 1)
    ver = ver or current
    rows = await version_rows(db, raw)
    row = next((r for r in rows if r["version"] == ver), None)
    match = {**sessions_match({"doc_id": doc_id}, w.start, w.end, internal), **session_ver_filter(raw, ver)}
    sessions, sampled = await load_sessions(db, match, _SESSION_FIELDS)
    dur = doc_dur(raw if ver == current else {}, sessions, row)
    pts, playing = retention(sessions, dur or 0)
    strip, detail = rewatch(sessions, dur or 0)
    speed: dict[str, float] = defaultdict(float)
    for s in sessions:
        for k, v in (_media(s).get("speed") or {}).items():
            speed[decode_key(k)] += v or 0
    total_speed = sum(speed.values())
    plays = [s for s in sessions if is_playing(s)]
    q = qoe(sessions, size_bytes=(row or {}).get("size_bytes") or (raw.get("size_bytes") if ver == current else None),
            dur=dur)
    counts = defaultdict(int)
    async for r in db[engage.COLL].aggregate([
        {"$match": {"doc_id": doc_id, **_internal(internal)}},
        {"$group": {"_id": "$ver", "n": {"$sum": 1}}},
    ]):
        counts[int(r["_id"] or current)] += r["n"]
    return {
        "ver": ver,
        "dur": dur,
        "sessions": len(sessions),
        "viewers": len({s.get("ip_hash") for s in sessions if s.get("ip_hash")}),
        "retention": pts,
        "rewatch": strip,
        "moments": moments(pts, playing, dur or 0, detail, kind),
        "speeds": [{"rate": r, "pct": pct(v, total_speed)}
                   for r, v in sorted(speed.items(), key=lambda kv: float(kv[0]))],
        "fullscreen_pct": pct(sum(1 for s in plays if (_media(s).get("fs_s") or 0) > 0), len(plays)),
        "muted_pct": pct(sum(1 for s in plays if (_media(s).get("muted_s") or 0) > 0), len(plays)),
        "pip_pct": pct(sum(1 for s in plays if (_media(s).get("pip_s") or 0) > 0), len(plays)),
        "qoe": q,
        "versions": [{"version": r["version"], "created_at": iso(r.get("created_at")),
                      "sessions": counts.get(r["version"], 0)} for r in rows],
        "sampled": sampled,
    }


async def content_report(db, raw: dict, w: Window, internal: bool) -> dict:
    match = sessions_match({"doc_id": str(raw["_id"])}, w.start, w.end, internal)
    sessions, sampled = await load_sessions(
        db, match, {"depth": 1, "active_s": 1, "reached": 1, "sec": 1, "copies": 1, "links": 1, "prints": 1})
    copies: dict[tuple[str, str], int] = defaultdict(int)
    links: dict[tuple[str, str], int] = defaultdict(int)
    for s in sessions:
        for k, v in (s.get("copies") or {}).items():
            h, _, sec = decode_key(k).partition("|")
            copies[(h, sec)] += int(v or 0)
        for k, v in (s.get("links") or {}).items():
            k = decode_key(k)
            href, sec = (k.rsplit("|", 1) + [""])[:2] if "|" in k else (k, "")
            links[(href, sec)] += int(v or 0)
    n = len(sessions)
    return {
        "sessions": n,
        "read_all_pct": pct(sum(1 for s in sessions if engaged(s, "doc")), n),
        "median_active_s": med(s.get("active_s") for s in sessions),
        "sections": _sections(sessions),
        "copies": [{"hash": h, "section": sec or None, "n": c}
                   for (h, sec), c in sorted(copies.items(), key=lambda kv: -kv[1])[:10]],
        "links": [{"href": href, "section": sec or None, "n": c}
                  for (href, sec), c in sorted(links.items(), key=lambda kv: -kv[1])[:10]],
        "prints": sum(int(s.get("prints") or 0) for s in sessions),
        "sampled": sampled,
    }


async def pages_report(db, raw: dict, w: Window, internal: bool) -> dict:
    match = sessions_match({"doc_id": str(raw["_id"])}, w.start, w.end, internal)
    sessions, sampled = await load_sessions(db, match, {"npages": 1, "pmax": 1, "pages": 1, "rv": 1})
    out = _pages(sessions)
    if out["biggest_drop"] is None:
        out.pop("biggest_drop")
    out["sampled"] = sampled
    return out


async def audience_report(db, raw: dict, w: Window, internal: bool) -> dict:
    from app.services import workspace as ws_service

    doc_id = str(raw["_id"])
    scope = {"doc_id": doc_id}
    kind = engage.kind_for(raw)
    vm = views_match(scope, w.start, w.end, internal)
    sessions, sampled = await load_sessions(db, sessions_match(scope, w.start, w.end, internal), _SESSION_FIELDS)
    dur = doc_dur(raw, sessions)
    new, returning = await returning_split(db, scope, w, internal)
    note = None
    if new + returning:
        note = f"{pct(returning, new + returning):.0f}% of people came back on another day."

    def eng_by(field: str) -> dict[str, list[dict]]:
        by: dict[str, list[dict]] = defaultdict(list)
        for s in sessions:
            by[s.get(field) or ""].append(s)
        return by

    # Devices: share of views; engagement from sessions.
    dev_rows = await db["events"].aggregate([
        {"$match": {**vm, "device": {"$ne": None}}},
        {"$group": {"_id": "$device", "n": {"$sum": 1}}},
        {"$sort": {"n": -1}},
    ]).to_list(length=20)
    dev_total = sum(r["n"] for r in dev_rows)
    sess_dev = eng_by("device")
    devices = [{"device": r["_id"], "pct": pct(r["n"], dev_total),
                "engaged_pct": engaged_pct(sess_dev.get(r["_id"], []), kind, dur)} for r in dev_rows]
    if not devices and sessions:
        total = len(sessions)
        devices = [{"device": d, "pct": pct(len(ss), total), "engaged_pct": engaged_pct(ss, kind, dur)}
                   for d, ss in sorted(sess_dev.items(), key=lambda kv: -len(kv[1])) if d]

    # Countries: people per country, k-anonymous.
    c_rows = await db["events"].aggregate([
        {"$match": {**vm, "country": {"$ne": None}, "ip_hash": {"$ne": None}}},
        {"$group": {"_id": {"c": "$country", "ip": "$ip_hash"}}},
        {"$group": {"_id": "$_id.c", "people": {"$sum": 1}}},
    ]).to_list(length=500)
    sess_c = eng_by("country")
    countries, small = fold_k([{"country": r["_id"], "people": r["people"]} for r in c_rows], "country")
    folded = {r["country"] for r in small}
    for i, r in enumerate(countries):
        if small and i == len(countries) - 1:  # the folded "Other" row
            ss = [s for c in folded for s in sess_c.get(c, [])]
        else:
            ss = sess_c.get(r["country"], [])
        r["engaged_pct"] = engaged_pct(ss, kind, dur)

    sess_ch = eng_by("channel")
    channels = [{**r, "engaged_pct": engaged_pct(sess_ch.get(r["channel"], []), kind, dur)}
                for r in await sources(db, vm)]

    # Campaigns: people per utm triple, k-anonymous.
    camp = await db["events"].aggregate([
        {"$match": {**vm, "utm_source": {"$ne": None}, "ip_hash": {"$ne": None}}},
        {"$group": {"_id": {"s": "$utm_source", "m": "$utm_medium", "c": "$utm_campaign", "ip": "$ip_hash"}}},
        {"$group": {"_id": {"s": "$_id.s", "m": "$_id.m", "c": "$_id.c"}, "people": {"$sum": 1}}},
    ]).to_list(length=1000)
    sess_camp: dict[tuple, list[dict]] = defaultdict(list)
    for s in sessions:
        if s.get("utm_source"):
            sess_camp[(s.get("utm_source"), s.get("utm_medium"), s.get("utm_campaign"))].append(s)
    camp_rows = [{"source": r["_id"].get("s"), "medium": r["_id"].get("m"), "campaign": r["_id"].get("c"),
                  "people": r["people"]} for r in camp]
    campaigns, small_c = fold_k(camp_rows, "source", other={"medium": None, "campaign": None})
    for i, r in enumerate(campaigns):
        if small_c and i == len(campaigns) - 1:  # the folded "Other" row
            ss = [s for x in small_c for s in sess_camp.get((x["source"], x["medium"], x["campaign"]), [])]
        else:
            ss = sess_camp.get((r["source"], r["medium"], r["campaign"]), [])
        r["engaged_pct"] = engaged_pct(ss, kind, dur)

    hidden = 0
    if not internal:
        hidden = await db["events"].count_documents(
            {**scope, "type": "view", **_ts("ts", w.start, w.end), "internal": True})
    ws = None
    if raw.get("workspace_id"):
        wsd = await ws_service.get_workspace(db, raw["workspace_id"])
        if wsd is not None:
            ws = {"id": wsd.id, "name": wsd.name}
    out = {
        "new": new,
        "returning": returning,
        "devices": devices,
        "countries": countries,
        "channels": channels,
        "signals": await signals(db, scope, w),
        "campaigns": campaigns,
        "internal_hidden": hidden,
        "sampled": sampled,
    }
    if note:
        out["returning_ratio_note"] = note
    if ws:
        out["workspace"] = ws
    return out


async def versions_report(db, raw: dict, internal: bool) -> dict:
    doc_id = str(raw["_id"])
    kind = engage.kind_for(raw)
    rows = await version_rows(db, raw)
    current = int(raw.get("file_version") or 1)
    if not rows:
        return {"versions": []}
    # Old rows without a version tag are attributed by when they happened.
    starts = sorted(((aware(r.get("created_at")) or datetime.min.replace(tzinfo=timezone.utc), r["version"])
                     for r in rows), key=lambda x: x[1])

    def ver_at(ts: datetime | None) -> int:
        ts = aware(ts)
        v = starts[0][1]
        for at, ver in starts:
            if ts is not None and ts >= at:
                v = ver
        return v

    views: dict[int, int] = defaultdict(int)
    async for r in db["events"].aggregate([
        {"$match": {"doc_id": doc_id, "type": "view", **_internal(internal)}},
        {"$group": {"_id": {"v": "$ver", "d": {"$dateToString": {"format": "%Y-%m-%d %H", "date": "$ts"}}},
                    "n": {"$sum": 1}, "ts": {"$min": "$ts"}}},
    ]):
        v = r["_id"].get("v")
        views[int(v) if v else ver_at(r["ts"])] += r["n"]
    sessions, _ = await load_sessions(db, {"doc_id": doc_id, **_internal(internal)}, _SESSION_FIELDS)
    by: dict[int, list[dict]] = defaultdict(list)
    for s in sessions:
        by[int(s.get("ver") or ver_at(s.get("started_at")) or current)].append(s)
    out = []
    for r in rows:
        v = r["version"]
        ss = by.get(v, [])
        dur = doc_dur(raw if v == current else {}, ss, r)
        m = primary_metric(ss, kind, dur)
        item = {"version": v, "created_at": iso(r.get("created_at")), "views": views.get(v, 0),
                "sessions": len(ss), "primary_metric": {"label": m["label"], "value": m["value"]}}
        if kind == "video" and dur:
            pts, playing = retention(ss, dur)
            if playing:
                item["first_minute"] = [{"t": t, "pct": retention_at(pts, t) or 0.0}
                                        for t in range(0, 61, 2) if t <= dur]
        out.append(item)
    return {"versions": out}


async def daily_csv(db, raw: dict, w: Window, internal: bool) -> str:
    doc_id = str(raw["_id"])
    scope = {"doc_id": doc_id}
    days = await daily_views(db, views_match(scope, w.start, w.end, internal))
    sess: dict[str, dict] = {}
    async for r in db[engage.COLL].aggregate([
        {"$match": sessions_match(scope, w.start, w.end, internal)},
        {"$group": {"_id": {"$dateToString": {"format": "%Y-%m-%d", "date": "$started_at"}},
                    "n": {"$sum": 1}, "a": {"$sum": "$active_s"}, "w": {"$sum": "$media.watched_s"}}},
    ]):
        sess[r["_id"]] = r
    buf = io.StringIO()
    out = csv.writer(buf)
    out.writerow(["date", "views", "people", "sessions", "active_s", "watched_s"])
    for d in date_span(w, list(days) + list(sess), raw.get("created_at")):
        v, s = days.get(d, {}), sess.get(d, {})
        out.writerow([d, v.get("views", 0), v.get("people", 0), s.get("n", 0),
                      round(s.get("a") or 0, 1), round(s.get("w") or 0, 1)])
    return buf.getvalue()


# ── Home (every document the caller owns) ────────────────────────────────────


async def _owned(db, user_id: str) -> dict[str, dict]:
    rows = await db["documents"].find(
        {"owner_id": user_id},
        {"slug": 1, "title": 1, "kind": 1, "mime": 1, "encrypted": 1, "original_filename": 1,
         "file_version": 1, "media": 1, "owner_id": 1, "created_at": 1, "workspace_id": 1,
         "folder_path": 1}).to_list(length=50_000)
    return {str(r["_id"]): r for r in rows}


async def _views_by_doc(db, match: dict) -> dict[str, dict]:
    out: dict[str, dict] = {}
    async for r in db["events"].aggregate([
        {"$match": match},
        {"$group": {"_id": "$doc_id", "n": {"$sum": 1}, "last": {"$max": "$ts"}}},
    ]):
        out[r["_id"]] = {"views": r["n"], "last": r["last"]}
    return out


def _home_sessions_kpis(sessions: list[dict]) -> tuple[float, float]:
    watch = round(sum(_media(s).get("watched_s") or 0 for s in sessions), 1)
    reads = [s for s in sessions if s.get("kind") in ("doc", "pdf")
             and (s.get("kind") == "doc" or s.get("npages"))]
    read_end = pct(sum(1 for s in reads if engaged(s, s["kind"])), len(reads))
    return watch, read_end


async def home(db, user_id: str, w: Window, internal: bool, *,
               per_doc_out: dict[str, list[dict]] | None = None) -> dict:
    """The home board. ``per_doc_out``, when given, receives each top link's
    own insights by slug (the weekly digest's notes reuse them)."""
    owned = await _owned(db, user_id)
    scope = {"owner_id": user_id}
    vm = views_match(scope, w.start, w.end, internal)
    by_doc = {k: v for k, v in (await _views_by_doc(db, vm)).items() if k in owned}
    views = sum(v["views"] for v in by_doc.values())
    people = await people_count(db, vm)
    proj = {"_id": 0, "doc_id": 1, "kind": 1, "depth": 1, "npages": 1, "pmax": 1, "active_s": 1,
            "media.watched_s": 1, "media.dur": 1, "media.plays": 1, "media.ended": 1, "media.segs": 1}
    sessions, sampled = await load_sessions(db, sessions_match(scope, w.start, w.end, internal), proj)
    watch, read_end = _home_sessions_kpis(sessions)
    hp = w.has_prev
    prev = {}
    if hp:
        pm = views_match(scope, w.prev_start, w.prev_end, internal)
        prev_sessions, _ = await load_sessions(db, sessions_match(scope, w.prev_start, w.prev_end, internal), proj)
        pw, pr = _home_sessions_kpis(prev_sessions)
        prev = {"views": await views_count(db, pm), "people": await people_count(db, pm),
                "watch_time": pw, "read_end": pr}
    n_links = len(by_doc)
    kpis = [
        kpi("views", "Views", views, "count", prev.get("views"), has_prev=hp,
            note=f"across {n_links} link{'s' if n_links != 1 else ''}"),
        kpi("people", "People", people, "count", prev.get("people"), has_prev=hp,
            note="distinct visitors"),
        kpi("watch_time", "Watch time", watch, "seconds", prev.get("watch_time"), has_prev=hp,
            note="videos and audio"),
        kpi("read_end", "Read to the end", read_end, "percent", prev.get("read_end"), has_prev=hp,
            note="documents and PDFs"),
    ]
    live = presence.snapshot(list(owned), include_internal=internal)
    sess_by_doc: dict[str, list[dict]] = defaultdict(list)
    for s in sessions:
        sess_by_doc[s["doc_id"]].append(s)

    top = sorted(by_doc.items(), key=lambda kv: -kv[1]["views"])[:50]
    spark_start = (w.end - timedelta(days=13)).date()
    spark: dict[str, list[int]] = {d: [0] * 14 for d, _ in top}
    if top:
        async for r in db["events"].aggregate([
            {"$match": {"doc_id": {"$in": [d for d, _ in top]}, "type": "view",
                        "ts": {"$gte": datetime.combine(spark_start, datetime.min.time(), tzinfo=timezone.utc)},
                        **_internal(internal)}},
            {"$group": {"_id": {"doc": "$doc_id", "d": {"$dateToString": {"format": "%Y-%m-%d", "date": "$ts"}}},
                        "n": {"$sum": 1}}},
        ]):
            i = (date.fromisoformat(r["_id"]["d"]) - spark_start).days
            if 0 <= i < 14:
                spark[r["_id"]["doc"]][i] = r["n"]
    links = []
    for doc_id, v in top:
        raw = owned[doc_id]
        kind = engage.kind_for(raw)
        renderer = renderer_of(raw)
        links.append({
            "slug": raw["slug"],
            "title": doc_title(raw),
            "kind": kind,
            "renderer": renderer,
            "icon": renderer or "doc",
            "views": v["views"],
            "spark": spark[doc_id],
            "engage_label": engage_label(sess_by_doc.get(doc_id, []), kind),
            "last_view": iso(v["last"]),
            "live": doc_id in live,
        })
    per_doc = []
    for doc_id, _v in top[:5]:
        per_doc.append(await doc_insights(db, owned[doc_id], w, internal))
        if per_doc_out is not None:
            per_doc_out[owned[doc_id]["slug"]] = per_doc[-1]
    return {
        "range": w.key,
        "kpis": kpis,
        "live": {"people": sum(len(v) for v in live.values()), "links": len(live)},
        "links": links,
        "insights": insights.top_across(per_doc),
        "sampled": sampled,
    }


def _feed_text(kind: str, title: str, s: dict) -> str:
    m = _media(s)
    where = f" in {s['country']}" if s.get("country") else ""
    if kind in MEDIA_KINDS and m.get("watched_s"):
        verb = "listened to" if kind == "audio" else "watched"
        return f"Someone{where} {verb} {insights.fmt_t(m['watched_s'])} of {title}"
    if kind == "pdf" and s.get("pmax"):
        of = f" of {s['npages']}" if s.get("npages") else ""
        return f"Someone{where} reached page {s['pmax']}{of} of {title}"
    if kind == "doc":
        return f"Someone{where} read {int(s.get('depth') or 0)}% of {title}"
    return f"Someone{where} spent {fmt_duration(s.get('active_s') or 0)} on {title}"


async def live(db, user_id: str) -> dict:
    owned = await _owned(db, user_id)
    snap = presence.snapshot(list(owned))
    docs = []
    for doc_id, entries in sorted(snap.items(), key=lambda kv: -len(kv[1])):
        raw = owned[doc_id]
        kind = engage.kind_for(raw)
        item = {"slug": raw["slug"], "title": doc_title(raw), "kind": kind, "n": len(entries),
                "entries": [{"pos": e["pos"], "country": e["country"], "device": e["device"]}
                            for e in entries]}
        if kind in MEDIA_KINDS:
            # The playback timeline's length (null until the file was probed).
            item["dur"] = (raw.get("media") or {}).get("duration_s")
        docs.append(item)
    since = datetime.now(timezone.utc) - timedelta(minutes=30)
    feed = []

    def name(raw: dict) -> str:
        t = doc_title(raw)
        return f"“{t}”" if t else raw["slug"]

    async for e in db["events"].find(
            {"owner_id": user_id, "type": {"$in": ["view", "preview"]}, "ts": {"$gte": since},
             "internal": {"$ne": True}},
            {"doc_id": 1, "type": 1, "ts": 1, "country": 1, "platform": 1}).sort("ts", -1).limit(60):
        raw = owned.get(e["doc_id"])
        if raw is None:
            continue
        if e["type"] == "preview":
            text = f"Link to {name(raw)} unfurled in {e.get('platform') or 'a chat'}"
        else:
            where = f" in {e['country']}" if e.get("country") else ""
            text = f"Someone{where} opened {name(raw)}"
        feed.append({"at": iso(e["ts"]), "text": text, "slug": raw["slug"]})
    async for s in db[engage.COLL].find(
            {"owner_id": user_id, "updated_at": {"$gte": since}, "internal": {"$ne": True}},
            {"doc_id": 1, "kind": 1, "updated_at": 1, "country": 1, "depth": 1, "pmax": 1, "npages": 1,
             "active_s": 1, "media.watched_s": 1}).sort("updated_at", -1).limit(60):
        raw = owned.get(s["doc_id"])
        if raw is None:
            continue
        feed.append({"at": iso(s["updated_at"]), "text": _feed_text(s.get("kind") or "doc", name(raw), s),
                     "slug": raw["slug"]})
    feed.sort(key=lambda f: f["at"] or "", reverse=True)
    return {
        "people": sum(d["n"] for d in docs),
        "links": len(docs),
        "docs": docs,
        "feed": feed[:30],
    }


async def home_csv(db, user_id: str, w: Window, internal: bool) -> str:
    owned = await _owned(db, user_id)
    scope = {"owner_id": user_id}
    vm = views_match(scope, w.start, w.end, internal)
    by_doc = await _views_by_doc(db, vm)
    people: dict[str, int] = {}
    async for r in db["events"].aggregate([
        {"$match": {**vm, "ip_hash": {"$ne": None}}},
        {"$group": {"_id": {"doc": "$doc_id", "ip": "$ip_hash"}}},
        {"$group": {"_id": "$_id.doc", "n": {"$sum": 1}}},
    ]):
        people[r["_id"]] = r["n"]
    sessions, _ = await load_sessions(
        db, sessions_match(scope, w.start, w.end, internal),
        {"_id": 0, "doc_id": 1, "kind": 1, "depth": 1, "npages": 1, "pmax": 1, "active_s": 1,
         "media.watched_s": 1, "media.dur": 1, "media.plays": 1, "media.ended": 1, "media.segs": 1})
    by_sess: dict[str, list[dict]] = defaultdict(list)
    for s in sessions:
        by_sess[s["doc_id"]].append(s)
    buf = io.StringIO()
    out = csv.writer(buf)
    out.writerow(["slug", "title", "kind", "views", "people", "engaged_metric", "engaged_value"])
    order = sorted(owned.items(), key=lambda kv: (-(by_doc.get(kv[0], {}).get("views") or 0), kv[1]["slug"]))
    for doc_id, raw in order[:5000]:
        kind = engage.kind_for(raw)
        ss = by_sess.get(doc_id, [])
        m = primary_metric(ss, kind) if ss else {"label": "", "value": ""}
        out.writerow([raw["slug"], doc_title(raw) or "", kind, by_doc.get(doc_id, {}).get("views", 0),
                      people.get(doc_id, 0), m["label"], m["value"]])
    return buf.getvalue()


# ── Frames ────────────────────────────────────────────────────────────────────


FRAME_MAX_BYTES = 2 * 1024 * 1024
FRAME_WIDTH = 640


async def frame(db, raw: dict, t: float, ver: int | None) -> bytes | None:
    """A JPEG of the video at ``t`` (whole seconds), cached privately in R2
    beside the version's blob. None when it isn't a video, the version or its
    bytes are gone, R2 isn't configured or ffmpeg isn't available."""
    from fastapi.concurrency import run_in_threadpool

    from app.services import media, r2

    if engage.kind_for(raw) != "video" or not r2.is_configured():
        return None
    current = int(raw.get("file_version") or 1)
    ver = ver or current
    rows = await version_rows(db, raw)
    row = next((r for r in rows if r["version"] == ver), None)
    if row is None or not row.get("blob_key"):
        return None
    dur = ((row.get("media") or {}).get("duration_s")) or None
    sec = max(0, int(round(t)))
    if dur:
        sec = min(sec, max(0, int(dur) - 1)) if dur >= 1 else 0
    key = f"{media.frames_prefix(row['blob_key'])}{sec}.jpg"
    cached = await run_in_threadpool(r2.get_bytes, key, FRAME_MAX_BYTES)
    if cached:
        return cached
    if media.binary("ffmpeg") is None:
        return None
    url = await run_in_threadpool(r2.presign_get, row["blob_key"], 600)
    jpg = await media.frame(url, row.get("mime") or raw.get("mime") or "", sec, max_width=FRAME_WIDTH)
    if not jpg:
        return None
    await run_in_threadpool(r2.put_bytes, key, jpg, "image/jpeg", False)
    return jpg
