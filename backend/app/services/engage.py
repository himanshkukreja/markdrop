"""Engagement sessions — what a reader did on a document after opening it.

Fed by ``POST /api/v1/documents/{slug}/engage`` (creator analytics v1, build
spec §1b/§2). One row per page load per document (``sid``), in
``engage_sessions``; each beacon carries *deltas* since the previous one plus an
increasing ``seq``, so a retried beacon (same seq) is a no-op.

What is kept is anonymous and aggregate-shaped: seconds, depth, positions,
heading ids, page numbers, watched ranges of a video, counts of copies (by a
hash of the code, never the text) and outbound links (host + path). The
visitor key is the same static ``analytics._hash_ip`` the view events use
(owner decision). Encrypted documents keep only time and depth: their heading
ids, copies and links would leak content.

Plausibility clamps keep a forged or buggy client from inflating anything much:
``active_s`` per send ≤ min(120, seconds since the session's last update + 20),
every per-session seconds total ≤ 4 h, depth 0..100, pages 1..2000, video
ranges inside [0, duration], ≤ 400 stored ranges and ≤ 200 keys per map.

A session is stored only once it has 2 active seconds, any watched media
seconds or a media error (a failed play is exactly what the QoE panel needs).
Until then its state waits in process memory (bounded, 30 min) so the first
beacon's referrer and campaign aren't lost.

Map keys are user-supplied (heading ids, link paths, playback rates) and may
contain '.' or '$', which MongoDB field names can't; they're stored with those
characters replaced by full-width look-alikes (:func:`encode_key`).
"""

from __future__ import annotations

import copy
import json
import math
import re
import time
from collections import OrderedDict
from datetime import datetime, timezone
from urllib.parse import urlsplit

from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.services import analytics, geo, presence, traffic

COLL = "engage_sessions"
KINDS = ("doc", "pdf", "video", "audio", "other")
MAX_BODY = 8192
TTL_DAYS = 395
SESSION_CAP_S = 4 * 3600
SEND_CAP_S = 120
SEND_SLACK_S = 20
MAP_KEYS = 200
MAX_SEGS = 400
SEGS_PER_SEND = 50
MAX_PAGES = 2000
MAX_DUR_S = 24 * 3600
MEDIA_ERRORS = ("network", "decode", "src", "expired", "other")

_SID = re.compile(r"^[A-Za-z0-9_-]{12,64}$")
_DOT, _DOLLAR = "．", "＄"  # ． ＄

# Sessions not yet worth a row, waiting for their second active second.
PENDING_TTL_S = 30 * 60
PENDING_MAX = 20_000
_pending: "OrderedDict[tuple[str, str], tuple[dict, float]]" = OrderedDict()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def aware(dt: datetime | None) -> datetime | None:
    """Mongo hands back naive UTC datetimes; make them comparable."""
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


# ── Keys ──────────────────────────────────────────────────────────────────────


def encode_key(key: str) -> str:
    return key.replace("\x00", "").replace(".", _DOT).replace("$", _DOLLAR)


def decode_key(key: str) -> str:
    return key.replace(_DOT, ".").replace(_DOLLAR, "$")


def kind_for(raw: dict) -> str:
    """The tracked kind of a document: doc (markdown), pdf, video, audio, other."""
    if raw.get("kind") != "artifact":
        return "doc"
    from app.services import artifact

    r = artifact.renderer_for(raw.get("mime") or "")
    return r if r in ("pdf", "video", "audio") else "other"


# ── Ranges ────────────────────────────────────────────────────────────────────


def merge_segs(segs) -> list[list[float]]:
    """Sorted, merged copy of ``[[s, e], ...]`` (touching ranges join)."""
    out: list[list[float]] = []
    for s, e in sorted((float(a), float(b)) for a, b in segs if b > a):
        if out and s <= out[-1][1]:
            if e > out[-1][1]:
                out[-1][1] = e
        else:
            out.append([s, e])
    return out


def union_len(segs) -> float:
    return sum(e - s for s, e in merge_segs(segs))


# ── Indexes ───────────────────────────────────────────────────────────────────


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLL].create_index([("sid", 1), ("doc_id", 1)], unique=True)
    await db[COLL].create_index([("doc_id", 1), ("started_at", -1)])
    await db[COLL].create_index([("owner_id", 1), ("started_at", -1)])
    await db[COLL].create_index([("owner_id", 1), ("updated_at", -1)])
    await db[COLL].create_index("started_at", expireAfterSeconds=TTL_DAYS * 24 * 3600,
                                name="engage_ttl")
    # Views / previews per document by type (creator analytics read API).
    await db["events"].create_index([("doc_id", 1), ("type", 1), ("ts", -1)])


# ── Parsing ───────────────────────────────────────────────────────────────────


def _num(v, lo: float, hi: float) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    if f != f or f in (math.inf, -math.inf):
        return None
    return max(lo, min(hi, f))


def _int(v, lo: int, hi: int) -> int | None:
    f = _num(v, lo, hi)
    return int(f) if f is not None else None


def _str(v, n: int) -> str | None:
    if not isinstance(v, str):
        return None
    v = v.strip()[:n]
    return v or None


def parse(raw_body: bytes) -> dict | None:
    """The beacon's envelope, validated; None for anything unusable."""
    if not raw_body or len(raw_body) > MAX_BODY:
        return None
    try:
        body = json.loads(raw_body)
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(body, dict):
        return None
    sid = body.get("sid")
    if not (isinstance(sid, str) and _SID.match(sid)):
        return None
    seq = _int(body.get("seq"), 0, 10**9)
    if seq is None or seq < 1:
        return None
    d = body.get("d") if isinstance(body.get("d"), dict) else {}
    first = body.get("first") if isinstance(body.get("first"), dict) else None
    pos = None
    p = body.get("pos")
    if isinstance(p, dict):
        if (s := _num(p.get("s"), 0, MAX_DUR_S)) is not None:
            pos = {"s": round(s, 1)}
        elif (h := _str(p.get("h"), 120)) is not None:
            pos = {"h": h}
        elif (pg := _int(p.get("p"), 1, MAX_PAGES)) is not None:
            pos = {"p": pg}
    return {
        "sid": sid,
        "seq": seq,
        "t": body.get("t") if isinstance(body.get("t"), str) and len(body["t"]) <= 2048 else None,
        "u": body.get("u") if isinstance(body.get("u"), str) and len(body["u"]) <= 4096 else None,
        "ver": _int(body.get("ver"), 1, 100_000),
        "final": body.get("final") is True,
        "first": first,
        "pos": pos,
        "d": d,
    }


# ── Applying a beacon ─────────────────────────────────────────────────────────


def _first_fields(first: dict | None) -> dict:
    first = first or {}
    ref = analytics.clean_referrer(_str(first.get("ref"), 2048))
    utm = first.get("utm") if isinstance(first.get("utm"), dict) else {}
    source = _str(utm.get("source"), 100)
    medium = _str(utm.get("medium"), 100)
    campaign = _str(utm.get("campaign"), 100)
    source = source.lower() if source else None
    medium = medium.lower() if medium else None
    ref_host = urlsplit(ref).hostname if ref else None
    return {
        "ref": ref,
        "utm_source": source,
        "utm_medium": medium,
        "utm_campaign": campaign,
        "channel": traffic.channel_for(ref_host, source, medium),
    }


def new_session(raw_doc: dict, msg: dict, *, now: datetime, ip: str | None, ua: str,
                internal: bool) -> dict:
    loc = geo.lookup(ip)
    kind = kind_for(raw_doc)
    ver = None
    if kind != "doc":
        current = int(raw_doc.get("file_version") or 1)
        ver = msg["ver"] if msg.get("ver") and msg["ver"] <= current else current
    return {
        "sid": msg["sid"],
        "doc_id": str(raw_doc["_id"]),
        "owner_id": raw_doc.get("owner_id"),
        "kind": kind,
        "ver": ver,
        "started_at": now,
        "updated_at": None,
        "seq": 0,
        "ended": False,
        "ip_hash": analytics._hash_ip(ip),
        "country": loc["country"],
        "region": loc["region"],
        "city": loc["city"],
        **traffic.parse_ua(ua),
        **_first_fields(msg.get("first")),
        "internal": bool(internal),
        "active_s": 0,
        "depth": 0,
        "reached": [],
        "sec": {},
        "copies": {},
        "links": {},
        "prints": 0,
        "pages": {},
        "npages": None,
        "pmax": 0,
        "rv": {},
        "media": None,
    }


def _merge_map(target: dict, incoming, *, key_max: int, val_lo: float, val_hi: float,
               total_cap: float, key_ok=None, as_int: bool = False) -> None:
    """``target[k] += v`` for each valid pair, ≤ MAP_KEYS keys, each total ≤ cap."""
    if not isinstance(incoming, dict):
        return
    for k, v in list(incoming.items())[:MAP_KEYS]:
        if not isinstance(k, str) or not k or len(k) > key_max:
            continue
        if key_ok is not None:
            k = key_ok(k)
            if k is None:
                continue
        val = _num(v, val_lo, val_hi)
        if val is None or val <= 0:
            continue
        ek = encode_key(k)
        if ek not in target and len(target) >= MAP_KEYS:
            continue
        total = min(total_cap, (target.get(ek) or 0) + val)
        target[ek] = int(total) if as_int else round(total, 1)


def _page_key(k: str) -> str | None:
    try:
        n = int(k)
    except ValueError:
        return None
    return str(n) if 1 <= n <= MAX_PAGES else None


def _rate_key(k: str) -> str | None:
    try:
        r = float(k)
    except ValueError:
        return None
    return f"{r:g}" if 0.0625 <= r <= 16 else None


def _apply_media(state: dict, m: dict, cap: float) -> None:
    media = state.get("media")
    if media is None:
        media = state["media"] = {
            "dur": None, "segs": [], "plays": 0, "ended": 0, "seeks": 0, "speed": {},
            "fs_s": 0, "pip_s": 0, "muted_s": 0, "startup_ms": None, "rebuf_n": 0,
            "rebuf_ms": 0, "err": None, "dropped": 0, "frames": 0, "watched_s": 0,
        }
    dur = _num(m.get("dur"), 0, MAX_DUR_S)
    if dur and dur > 0:
        media["dur"] = round(dur, 3)
    bound = media["dur"] or MAX_DUR_S
    segs = m.get("segs")
    if isinstance(segs, list):
        for seg in segs[:SEGS_PER_SEND]:
            if len(media["segs"]) >= MAX_SEGS:
                break
            if not (isinstance(seg, (list, tuple)) and len(seg) == 2):
                continue
            s, e = _num(seg[0], 0, bound), _num(seg[1], 0, bound)
            if s is None or e is None or e - s <= 0:
                continue
            media["segs"].append([round(s, 2), round(e, 2)])
    for f, hi in (("plays", 100), ("ended", 100), ("seeks", 500), ("rebuf_n", 100)):
        n = _int(m.get(f), 0, hi)
        if n:
            media[f] = int(media.get(f) or 0) + n
    for f in ("fs_s", "pip_s", "muted_s"):
        n = _num(m.get(f), 0, cap)
        if n:
            media[f] = round(min(SESSION_CAP_S, (media.get(f) or 0) + n), 1)
    n = _int(m.get("rebuf_ms"), 0, int(cap * 1000))
    if n:
        media["rebuf_ms"] = int(media.get("rebuf_ms") or 0) + n
    for f, hi in (("dropped", 1_000_000), ("frames", 1_000_000)):
        n = _int(m.get(f), 0, hi)
        if n:
            media[f] = int(media.get(f) or 0) + n
    if media.get("startup_ms") is None:
        n = _int(m.get("startup_ms"), 0, 300_000)
        if n is not None and m.get("startup_ms") is not None:
            media["startup_ms"] = n
    if media.get("err") is None and m.get("err") in MEDIA_ERRORS:
        media["err"] = m["err"]
    _merge_map(media["speed"], m.get("speed"), key_max=8, val_lo=0, val_hi=cap,
               total_cap=SESSION_CAP_S, key_ok=_rate_key)
    if media["dur"]:
        # A duration learnt after some ranges were sent still bounds them.
        media["segs"] = [[s, min(e, media["dur"])] for s, e in media["segs"] if s < media["dur"]]
    media["watched_s"] = round(min(SESSION_CAP_S, union_len(media["segs"])), 1)


def apply(state: dict, msg: dict, *, now: datetime, encrypted: bool = False) -> dict:
    """Fold one beacon's deltas into ``state`` (in place), with the clamps."""
    last = aware(state.get("updated_at"))
    if last is None:
        cap = float(SEND_CAP_S)
    else:
        cap = max(0.0, min(SEND_CAP_S, (now - last).total_seconds() + SEND_SLACK_S))
    d = msg.get("d") or {}
    a = _num(d.get("active_s"), 0, cap) or 0
    state["active_s"] = round(min(SESSION_CAP_S, (state.get("active_s") or 0) + a), 1)
    depth = _int(d.get("depth"), 0, 100)
    if depth is not None:
        state["depth"] = max(int(state.get("depth") or 0), depth)
    if not encrypted:
        reached = d.get("reached")
        if isinstance(reached, list):
            have = state.setdefault("reached", [])
            for h in reached[:MAP_KEYS]:
                h = _str(h, 120)
                if h and h not in have and len(have) < MAP_KEYS:
                    have.append(h)
        _merge_map(state.setdefault("sec", {}), d.get("sec"), key_max=120, val_lo=0, val_hi=cap,
                   total_cap=SESSION_CAP_S)
        _merge_map(state.setdefault("copies", {}), d.get("copies"), key_max=140, val_lo=0,
                   val_hi=50, total_cap=10_000, as_int=True)
        _merge_map(state.setdefault("links", {}), d.get("links"), key_max=330, val_lo=0,
                   val_hi=50, total_cap=10_000, as_int=True)
    prints = _int(d.get("print"), 0, 10)
    if prints:
        state["prints"] = int(state.get("prints") or 0) + prints
    if state.get("kind") == "pdf":
        _merge_map(state.setdefault("pages", {}), d.get("pages"), key_max=6, val_lo=0, val_hi=cap,
                   total_cap=SESSION_CAP_S, key_ok=_page_key)
        _merge_map(state.setdefault("rv", {}), d.get("rv"), key_max=6, val_lo=0, val_hi=50,
                   total_cap=10_000, key_ok=_page_key, as_int=True)
        npages = _int(d.get("npages"), 1, MAX_PAGES)
        if npages:
            state["npages"] = npages
        pmax = _int(d.get("pmax"), 1, MAX_PAGES)
        if pmax:
            if state.get("npages"):
                pmax = min(pmax, state["npages"])
            state["pmax"] = max(int(state.get("pmax") or 0), pmax)
    if state.get("kind") in ("video", "audio") and isinstance(d.get("media"), dict):
        _apply_media(state, d["media"], cap)
    state["seq"] = msg["seq"]
    state["updated_at"] = now
    if msg.get("final"):
        state["ended"] = True
    return state


def qualifies(state: dict) -> bool:
    media = state.get("media") or {}
    return (state.get("active_s") or 0) >= 2 or (media.get("watched_s") or 0) > 0 or bool(media.get("err"))


# ── Pending sessions ──────────────────────────────────────────────────────────


def _pending_get(key: tuple[str, str]) -> dict | None:
    hit = _pending.get(key)
    if hit is None:
        return None
    state, at = hit
    if time.monotonic() - at > PENDING_TTL_S:
        _pending.pop(key, None)
        return None
    return state


def _pending_put(key: tuple[str, str], state: dict) -> None:
    _pending[key] = (state, time.monotonic())
    _pending.move_to_end(key)
    while len(_pending) > PENDING_MAX:
        _pending.popitem(last=False)


def clear_pending() -> None:
    _pending.clear()


# ── Ingest ────────────────────────────────────────────────────────────────────


async def ingest(db: AsyncIOMotorDatabase, raw_doc: dict, msg: dict, *, ip: str | None,
                 ua: str, viewer_id: str | None, internal: bool) -> str:
    """Record one admitted beacon. Returns what happened (for tests): owner,
    dup, pending or stored."""
    doc_id = str(raw_doc["_id"])
    key = (doc_id, msg["sid"])
    if viewer_id and raw_doc.get("owner_id") and viewer_id == raw_doc["owner_id"]:
        # The owner's own reading never counts; drop anything already held.
        presence.remove(doc_id, msg["sid"])
        _pending.pop(key, None)
        await db[COLL].delete_one({"sid": msg["sid"], "doc_id": doc_id})
        return "owner"
    encrypted = bool(raw_doc.get("encrypted"))
    now = _now()

    for _attempt in range(4):
        existing = await db[COLL].find_one({"sid": msg["sid"], "doc_id": doc_id})
        if existing is not None:
            if msg["seq"] <= int(existing.get("seq") or 0):
                return "dup"
            state = copy.deepcopy(existing)
            if internal:
                state["internal"] = True
            apply(state, msg, now=now, encrypted=encrypted)
            res = await db[COLL].replace_one({"_id": existing["_id"], "seq": existing.get("seq")}, state)
            if res.matched_count:
                _touch_presence(doc_id, msg, state, encrypted)
                return "stored"
            continue  # another beacon for this sid won the race; re-read
        held = _pending_get(key)
        if held is not None:
            if msg["seq"] <= int(held.get("seq") or 0):
                return "dup"
            state = copy.deepcopy(held)
            if internal:
                state["internal"] = True
        else:
            state = new_session(raw_doc, msg, now=now, ip=ip, ua=ua, internal=internal)
        apply(state, msg, now=now, encrypted=encrypted)
        _touch_presence(doc_id, msg, state, encrypted)
        if not qualifies(state):
            _pending_put(key, state)
            return "pending"
        try:
            await db[COLL].insert_one(state)
        except DuplicateKeyError:
            continue
        _pending.pop(key, None)
        return "stored"
    return "dup"


def _touch_presence(doc_id: str, msg: dict, state: dict, encrypted: bool) -> None:
    if msg.get("final"):
        presence.remove(doc_id, msg["sid"])
        return
    pos = msg.get("pos")
    if pos and encrypted and "h" in pos:
        pos = None
    presence.touch(doc_id, msg["sid"], pos=pos, country=state.get("country"),
                   device=state.get("device"), kind=state.get("kind") or "doc",
                   internal=bool(state.get("internal")))
