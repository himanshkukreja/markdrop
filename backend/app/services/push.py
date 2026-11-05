"""Push notifications: the third channel next to the bell and email (and Slack DMs).

With Markdrop installed as an app (or in any browser that has Web Push), mentions — a meeting's
action item that names you is a mention too — sign-off requests, shares and access requests arrive
as real notifications on each device the person turned them on for.

Collections::

    push_subscriptions  {_id, user_id, endpoint (unique), p256dh, auth, label, standalone,
                         created_at, seen_at, last_ok_at, last_error, fails, expires_at}
    push_outbox         {_id, user_id, kind, ref, group, state, created_at, next_at, attempts, outcome}
    push_log            {_id: "<user>:<group>", sent_at}   (the gap between two pushes about a page)

One device (one browser profile) is one subscription. Its endpoint belongs to whoever subscribed it
last: signing in as someone else on that browser moves it, and signing out removes it.

What a notification may say, the rules every path follows:

* It says only what the bell says (notifications._view: the sentence, the excerpt, the sign-off's
  label, the share's note), computed at send time with the person's access *now*. A page they can
  no longer open sends nothing at all (not even "a page you can't open").
* An access request names who asked and the page, which the deciders see under Requests.
* The message is end-to-end encrypted to the device (RFC 8291); the push service sees only its size.

Delivery (:func:`flush`, a background loop every few seconds): notify() and access_requests.create()
queue one outbox row per item (only for a person with a device and that kind on). Rows for the
same person and page wait ``GATHER`` for more, then go as one notification; after one, the next
about that page waits ``GAP`` (like the email's 10 minutes, but short: a phone should ring soon).
Notifications read in the app meanwhile, or whose kind was turned off, are dropped. Each device's
notification for a page has the same tag, so a newer one replaces it instead of stacking.

A push service answering 404 / 410 (unsubscribed, expired) or 403 (another VAPID key) means the
subscription is dead: it is deleted. Devices not seen for ``STALE`` days, or past their expiry,
are pruned.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.config import get_settings
from app.services import webpush

log = logging.getLogger("markdrop.push")

SUBS = "push_subscriptions"
OUTBOX = "push_outbox"
PUSH_LOG = "push_log"
KINDS = ("mention", "signoff_requested", "shared", "access_request")
LABELS = {
    "mention": "Mentions",
    "signoff_requested": "Sign-off requests",
    "shared": "Shared with you",
    "access_request": "Access requests",
}
HINTS = {
    "mention": "Someone mentions you on a page, including a meeting's action item for you.",
    "signoff_requested": "Someone asks for your sign-off.",
    "shared": "Someone shares a page with you and ticks Notify people.",
    "access_request": "Someone asks to open or edit something you own or manage.",
}
GATHER = timedelta(seconds=10)
GAP = timedelta(minutes=2)
MAX_DEVICES = 20
MAX_ATTEMPTS = 5
STALE = timedelta(days=90)
PRUNE_EVERY = timedelta(hours=1)
FLUSH_GROUPS = 100
TTL_SECONDS = 24 * 3600
TEST_GAP = timedelta(seconds=5)
_last_prune: datetime | None = None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(v: datetime | None) -> datetime | None:
    if v is None:
        return None
    return v if v.tzinfo else v.replace(tzinfo=timezone.utc)


def _oid(v: Any) -> ObjectId | None:
    if isinstance(v, ObjectId):
        return v
    return ObjectId(v) if isinstance(v, str) and ObjectId.is_valid(v) else None


def configured() -> bool:
    return webpush.configured()


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[SUBS].create_index("endpoint", unique=True)
    await db[SUBS].create_index("user_id")
    await db[OUTBOX].create_index([("state", 1), ("next_at", 1)])
    await db[OUTBOX].create_index([("user_id", 1), ("group", 1), ("state", 1)])
    await db[OUTBOX].create_index("created_at", expireAfterSeconds=7 * 24 * 3600)
    await db[PUSH_LOG].create_index("sent_at", expireAfterSeconds=24 * 3600)


# ── Preferences ───────────────────────────────────────────────────────────────


def prefs_of(user_row: dict | None) -> dict[str, bool]:
    saved = (user_row or {}).get("push_notify") or {}
    return {k: saved.get(k) is not False for k in KINDS}


async def set_prefs(db: AsyncIOMotorDatabase, user_id: str, changes: dict[str, bool]) -> dict[str, bool]:
    sets = {f"push_notify.{k}": bool(v) for k, v in changes.items() if k in KINDS and isinstance(v, bool)}
    if sets:
        await db["users"].update_one({"_id": ObjectId(user_id)}, {"$set": sets})
        off = [k for k, v in changes.items() if k in KINDS and v is False]
        if off:
            await db[OUTBOX].update_many({"user_id": user_id, "state": "pending", "kind": {"$in": off}},
                                         {"$set": {"state": "skipped", "outcome": "off", "done_at": _now()}})
    return prefs_of(await db["users"].find_one({"_id": ObjectId(user_id)}, {"push_notify": 1}))


# ── Devices ───────────────────────────────────────────────────────────────────


def device_label(ua: str | None) -> str:
    """"Chrome on Android", "Safari on iPhone"… from a User-Agent (no version, nothing identifying)."""
    ua = ua or ""
    if re.search(r"iPhone|iPod", ua):
        os_ = "iPhone"
    elif "iPad" in ua:
        os_ = "iPad"
    elif "Android" in ua:
        os_ = "Android"
    elif "CrOS" in ua:
        os_ = "ChromeOS"
    elif "Windows" in ua:
        os_ = "Windows"
    elif "Macintosh" in ua or "Mac OS X" in ua:
        os_ = "Mac"
    elif "Linux" in ua:
        os_ = "Linux"
    else:
        os_ = None
    if "Edg/" in ua or "EdgA/" in ua or "EdgiOS/" in ua:
        br = "Edge"
    elif "SamsungBrowser/" in ua:
        br = "Samsung Internet"
    elif "OPR/" in ua or "Opera" in ua:
        br = "Opera"
    elif "Firefox/" in ua or "FxiOS/" in ua:
        br = "Firefox"
    elif "CriOS/" in ua or "Chrome/" in ua or "Chromium/" in ua:
        br = "Chrome"
    elif "Safari/" in ua:
        br = "Safari"
    else:
        br = "Browser"
    return f"{br} on {os_}" if os_ else br


def _service(endpoint: str) -> str:
    host = (re.match(r"^https?://([^/:]+)", endpoint or "") or [None, ""])[1].lower()
    if host.endswith("googleapis.com"):
        return "Google"
    if "mozilla" in host:
        return "Mozilla"
    if host.endswith("apple.com"):
        return "Apple"
    if host.endswith("windows.com"):
        return "Microsoft"
    return host or "unknown"


def _check_keys(p256dh: str, auth: str) -> None:
    try:
        pub = webpush.unb64u(p256dh)
        sec = webpush.unb64u(auth)
    except Exception:
        raise HTTPException(status_code=422, detail="That subscription's keys aren't valid.")
    if len(pub) != 65 or pub[0] != 4 or len(sec) != 16:
        raise HTTPException(status_code=422, detail="That subscription's keys aren't valid.")
    from cryptography.hazmat.primitives.asymmetric import ec

    try:
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), pub)
    except ValueError:
        raise HTTPException(status_code=422, detail="That subscription's keys aren't valid.")


def _view(row: dict, current: str | None = None) -> dict:
    return {
        "id": str(row["_id"]),
        "label": row.get("label") or "Browser",
        "app": bool(row.get("standalone")),
        "service": _service(row.get("endpoint") or ""),
        "created_at": _aware(row.get("created_at")).isoformat() if row.get("created_at") else None,
        "last_ok_at": _aware(row.get("last_ok_at")).isoformat() if row.get("last_ok_at") else None,
        "seen_at": _aware(row.get("seen_at")).isoformat() if row.get("seen_at") else None,
        "this_device": current is not None and row.get("endpoint") == current,
    }


async def subscribe(db: AsyncIOMotorDatabase, user_id: str, endpoint: str, p256dh: str, auth: str, *,
                    ua: str | None = None, standalone: bool = False, expires_at: datetime | None = None) -> dict:
    """Save (or refresh) this device's subscription for ``user_id``. The endpoint moves to them if
    another account had it on this browser. Keeps the newest ``MAX_DEVICES``."""
    if not configured():
        raise HTTPException(status_code=503, detail="Push notifications aren't set up on this server.")
    if not webpush.endpoint_allowed(endpoint):
        raise HTTPException(status_code=422, detail="That isn't a push service Markdrop can send to.")
    _check_keys(p256dh, auth)
    now = _now()
    sets = {"user_id": user_id, "p256dh": p256dh, "auth": auth, "label": device_label(ua),
            "standalone": bool(standalone), "seen_at": now, "expires_at": expires_at}
    prior = await db[SUBS].find_one({"endpoint": endpoint}, {"user_id": 1, "p256dh": 1})
    if prior is not None and (prior.get("user_id") != user_id or prior.get("p256dh") != p256dh):
        sets.update({"created_at": now, "last_ok_at": None, "fails": 0, "last_error": None})
    try:
        row = await db[SUBS].find_one_and_update(
            {"endpoint": endpoint}, {"$set": sets, "$setOnInsert": {"created_at": now, "fails": 0}},
            upsert=True, return_document=ReturnDocument.AFTER)
    except DuplicateKeyError:  # two tabs at once
        row = await db[SUBS].find_one_and_update({"endpoint": endpoint}, {"$set": sets},
                                                 return_document=ReturnDocument.AFTER)
    extra = await db[SUBS].find({"user_id": user_id}, {"_id": 1}).sort([("seen_at", -1)]).skip(MAX_DEVICES).to_list(
        length=500)
    if extra:
        await db[SUBS].delete_many({"_id": {"$in": [r["_id"] for r in extra]}})
    return _view(row, endpoint)


async def unsubscribe(db: AsyncIOMotorDatabase, user_id: str, endpoint: str) -> bool:
    res = await db[SUBS].delete_one({"endpoint": endpoint, "user_id": user_id})
    return res.deleted_count == 1


async def remove_device(db: AsyncIOMotorDatabase, user_id: str, device_id: str) -> bool:
    oid = _oid(device_id)
    if oid is None:
        return False
    res = await db[SUBS].delete_one({"_id": oid, "user_id": user_id})
    return res.deleted_count == 1


async def devices(db: AsyncIOMotorDatabase, user_id: str, current: str | None = None) -> list[dict]:
    rows = await db[SUBS].find({"user_id": user_id}).sort([("seen_at", -1)]).to_list(length=MAX_DEVICES)
    return [_view(r, current) for r in rows]


async def status(db: AsyncIOMotorDatabase, user_id: str, current: str | None = None) -> dict:
    urow = await db["users"].find_one({"_id": ObjectId(user_id)}, {"push_notify": 1})
    return {
        "enabled": configured(),
        "public_key": webpush.vapid().public if configured() else None,
        "devices": await devices(db, user_id, current),
        "prefs": prefs_of(urow),
        "kinds": [{"key": k, "label": LABELS[k], "hint": HINTS[k]} for k in KINDS],
    }


# ── Queue ─────────────────────────────────────────────────────────────────────


async def _queue(db: AsyncIOMotorDatabase, user_id: str, kind: str, ref: str, group: str) -> bool:
    if not configured() or kind not in KINDS or not user_id:
        return False
    if await db[SUBS].find_one({"user_id": user_id}, {"_id": 1}) is None:
        return False
    urow = await db["users"].find_one({"_id": _oid(user_id)}, {"push_notify": 1}) if _oid(user_id) else None
    if urow is None or not prefs_of(urow).get(kind):
        return False
    now = _now()
    await db[OUTBOX].insert_one({"user_id": user_id, "kind": kind, "ref": ref, "group": group, "state": "pending",
                                 "attempts": 0, "created_at": now, "next_at": now})
    return True


async def queue_notification(db: AsyncIOMotorDatabase, row: dict) -> None:
    """notifications.notify() made ``row`` (mention / signoff_requested / shared). Never raises."""
    try:
        await _queue(db, row["user_id"], row["kind"], str(row["_id"]), f"doc:{row['doc_id']}")
    except Exception:
        log.warning("push: couldn't queue notification %s", row.get("_id"), exc_info=True)


async def queue_access_request(db: AsyncIOMotorDatabase, raw: dict, row: dict) -> None:
    """access_requests.create() made ``row``: whoever decides it. Never raises."""
    from app.services import access_requests

    try:
        for uid in await access_requests.deciders(db, raw, row):
            await _queue(db, uid, "access_request", str(row["_id"]), f"req:{row['_id']}")
    except Exception:
        log.warning("push: couldn't queue access request %s", row.get("_id"), exc_info=True)


# ── The read link (a click on the notification marks it read) ────────────────


def _sig(user_id: str, ids: str) -> str:
    key = get_settings().auth_secret.encode()
    return hmac.new(key, f"push-read:{user_id}:{ids}".encode(), hashlib.sha256).hexdigest()[:32]


def read_token(user_id: str, ids: list[str]) -> str:
    joined = ",".join(ids)
    raw = f"{user_id}.{joined}.{_sig(user_id, joined)}"
    return base64.urlsafe_b64encode(raw.encode()).rstrip(b"=").decode()


def verify_read_token(token: str | None) -> tuple[str, list[str]] | None:
    try:
        raw = base64.urlsafe_b64decode((token or "") + "=" * (-len(token or "") % 4)).decode()
        user_id, joined, sig = raw.split(".")
    except Exception:
        return None
    if not ObjectId.is_valid(user_id) or not hmac.compare_digest(sig.encode(), _sig(user_id, joined).encode()):
        return None
    ids = [i for i in joined.split(",") if ObjectId.is_valid(i)]
    return (user_id, ids) if ids else None


async def mark_read_by_token(db: AsyncIOMotorDatabase, token: str | None) -> int:
    from app.services import notifications

    who = verify_read_token(token)
    if who is None:
        raise HTTPException(status_code=400, detail="That link isn't valid.")
    return await notifications.mark_read(db, who[0], who[1])


def read_url(user_id: str, ids: list[str]) -> str:
    return f"{get_settings().api_base_url.rstrip('/')}/api/v1/push/read?t={read_token(user_id, ids)}"


# ── Composing ─────────────────────────────────────────────────────────────────


def _cut(s: str | None, n: int) -> str:
    s = " ".join((s or "").split())
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def compose_notifications(user_id: str, doc_id: str, views: list[dict]) -> dict:
    """One notification for one person and one page, from the bell's own rows (oldest first, every
    one ``available``)."""
    first = views[-1]  # the newest leads
    n = len(views)
    if n == 1:
        title = first["text"]
        if first["kind"] == "shared":
            body = first.get("message") or "Open it in Markdrop."
        elif first["kind"] == "signoff_requested":
            body = first.get("excerpt") or (f"“{first['label']}”" if first.get("label") else "Open the page to sign off.")
        else:
            body = first.get("excerpt") or "Open the page to see where."
        url = first["href"]
    else:
        page_title = (first.get("page") or {}).get("title") or "a page"
        kinds = {v["kind"] for v in views}
        title = (f"You were mentioned {n} times in “{page_title}”" if kinds == {"mention"}
                 else f"{n} updates for you in “{page_title}”")
        names: list[str] = []
        for v in reversed(views):
            name = (v.get("actor") or {}).get("name") or "Someone"
            if name not in names:
                names.append(name)
        body = ", ".join(names[:3]) + (f" and {len(names) - 3} more" if len(names) > 3 else "")
        url = "/" + first["page"]["slug"]
    return {
        "v": 1, "title": _cut(title, 160), "body": _cut(body, 300), "url": url, "tag": f"md-doc-{doc_id}",
        "kind": first["kind"] if n == 1 else "batch", "count": n,
        "ids": [v["id"] for v in views], "read": read_url(user_id, [v["id"] for v in views]),
        "ts": int(_now().timestamp() * 1000),
    }


def compose_access_request(req: dict, title: str) -> dict:
    from app.services import access_requests

    who = req.get("requester_name") or req.get("requester_email") or "Someone"
    verb = "edit" if access_requests.requested_role(req) == "editor" else "open"
    return {
        "v": 1, "title": _cut(f"{who} asked to {verb} “{title}”", 160),
        "body": _cut(req.get("message") or "Approve or decline it in Markdrop.", 300),
        "url": f"/requests/{req['_id']}", "tag": f"md-req-{req['_id']}", "kind": "access_request", "count": 1,
        "ids": [], "read": None, "ts": int(_now().timestamp() * 1000),
    }


def compose_test(label: str) -> dict:
    return {"v": 1, "title": "Notifications are on", "body": f"This is how Markdrop notifications look on {label}.",
            "url": "/settings/account#push", "tag": "md-test", "kind": "test", "count": 1, "ids": [], "read": None,
            "ts": int(_now().timestamp() * 1000)}


# ── Sending ───────────────────────────────────────────────────────────────────


async def _send_to_devices(db: AsyncIOMotorDatabase, user_id: str, payload: dict, *, topic_key: str,
                           only: ObjectId | None = None, client=None) -> dict[str, int]:
    """Send ``payload`` to every device of ``user_id`` (or one). Returns {sent, gone, failed, retry}."""
    q: dict = {"user_id": user_id}
    if only is not None:
        q["_id"] = only
    subs = await db[SUBS].find(q).to_list(length=MAX_DEVICES)
    out = {"sent": 0, "gone": 0, "failed": 0, "retry": 0}
    data = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
    urgency = "high" if payload.get("kind") in ("signoff_requested", "access_request", "test") else "normal"
    for s in subs:
        res = await webpush.send(s["endpoint"], s["p256dh"], s["auth"], data, ttl=TTL_SECONDS, urgency=urgency,
                                 topic=webpush.topic_for(topic_key), client=client)
        now = _now()
        if res.gone:
            await db[SUBS].delete_one({"_id": s["_id"]})
            log.info("push: device %s of %s removed (%s)", s["_id"], user_id, res.error)
            out["gone"] += 1
        elif 200 <= res.status < 300:
            await db[SUBS].update_one({"_id": s["_id"]}, {"$set": {"last_ok_at": now, "fails": 0, "last_error": None}})
            out["sent"] += 1
        else:
            await db[SUBS].update_one({"_id": s["_id"]}, {"$set": {"last_error": res.error}, "$inc": {"fails": 1}})
            out["retry" if res.retry else "failed"] += 1
    return out


async def send_test(db: AsyncIOMotorDatabase, user_id: str, device_id: str | None = None) -> dict[str, int]:
    if not configured():
        raise HTTPException(status_code=503, detail="Push notifications aren't set up on this server.")
    only = _oid(device_id) if device_id else None
    if device_id and only is None:
        raise HTTPException(status_code=404, detail="That device isn't on your list.")
    sub = await db[SUBS].find_one({"user_id": user_id, **({"_id": only} if only else {})}, {"label": 1})
    if sub is None:
        raise HTTPException(status_code=404, detail="Turn notifications on for a device first.")
    now = _now()
    try:  # one test every TEST_GAP per person
        await db[PUSH_LOG].find_one_and_update(
            {"_id": f"test:{user_id}", "$or": [{"sent_at": {"$lte": now - TEST_GAP}}, {"sent_at": {"$exists": False}}]},
            {"$set": {"sent_at": now}}, upsert=True)
    except DuplicateKeyError:
        raise HTTPException(status_code=429, detail="Give that one a few seconds to arrive, then try again.")
    payload = compose_test(sub.get("label") if only else "your devices")
    return await _send_to_devices(db, user_id, payload, topic_key=f"test:{user_id}", only=only)


async def _claim_gap(db: AsyncIOMotorDatabase, user_id: str, group: str, now: datetime) -> bool:
    try:
        await db[PUSH_LOG].find_one_and_update(
            {"_id": f"{user_id}:{group}", "$or": [{"sent_at": {"$lte": now - GAP}}, {"sent_at": {"$exists": False}}]},
            {"$set": {"sent_at": now}}, upsert=True)
        return True
    except DuplicateKeyError:
        return False


async def _done(db: AsyncIOMotorDatabase, ids: list, outcome: str, state: str = "skipped") -> None:
    if ids:
        await db[OUTBOX].update_many({"_id": {"$in": ids}, "state": {"$in": ["pending", "sending"]}},
                                     {"$set": {"state": state, "outcome": outcome, "done_at": _now()}})


async def _group_payload(db: AsyncIOMotorDatabase, user_id: str, group: str, rows: list[dict],
                         urow: dict) -> tuple[dict | None, dict[str, list]]:
    """The payload for these rows as of now, and the rows dropped by reason."""
    from app.services import access_requests, md_outline, notifications

    dropped: dict[str, list] = {}
    prefs = prefs_of(urow)
    keep = []
    for r in rows:
        if not prefs.get(r["kind"]):
            dropped.setdefault("off", []).append(r["_id"])
        else:
            keep.append(r)
    if not keep:
        return None, dropped
    if group.startswith("req:"):
        req = await db[access_requests.COLL].find_one({"_id": _oid(keep[0]["ref"])})
        raw = await db["documents"].find_one({"_id": _oid((req or {}).get("doc_id"))}) if req else None
        if req is None or req.get("status") != "pending" or raw is None:
            dropped.setdefault("gone", []).extend(r["_id"] for r in keep)
            return None, dropped
        if not await notifications.can_open(db, urow, raw):
            dropped.setdefault("no_access", []).extend(r["_id"] for r in keep)
            return None, dropped
        return compose_access_request(req, md_outline.display_title(raw)), dropped
    refs = [_oid(r["ref"]) for r in keep if _oid(r["ref"])]
    nrows = await db[notifications.COLL].find({"_id": {"$in": refs}, "user_id": user_id}).sort(
        [("created_at", 1)]).to_list(length=200)
    found = {str(n["_id"]) for n in nrows}
    unread = [n for n in nrows if n.get("read_at") is None]
    read_ids = {str(n["_id"]) for n in nrows if n.get("read_at") is not None}
    for r in keep:
        if r["ref"] not in found:
            dropped.setdefault("gone", []).append(r["_id"])
        elif r["ref"] in read_ids:
            dropped.setdefault("seen", []).append(r["_id"])
    if not unread:
        return None, dropped
    views = await notifications._view(db, unread, urow)
    if not all(v["available"] for v in views):
        # Access is per page: one closed means all are (they share a page). Nothing is said.
        dropped.setdefault("no_access", []).extend(r["_id"] for r in keep if r["ref"] not in read_ids)
        return None, dropped
    return compose_notifications(user_id, group.split(":", 1)[1], views), dropped


async def flush(db: AsyncIOMotorDatabase, now: datetime | None = None, *, client=None) -> dict[str, int]:
    """One pass: every (person, page) with pending rows whose newest waited ``GATHER``. Returns
    counts by outcome."""
    now = _aware(now) or _now()
    counts: dict[str, int] = {}

    def bump(k: str, n: int = 1) -> None:
        if n:
            counts[k] = counts.get(k, 0) + n

    if not configured():
        return counts
    await _prune(db, now)
    groups = await db[OUTBOX].aggregate([
        {"$match": {"state": "pending", "next_at": {"$lte": now}}},
        {"$group": {"_id": {"u": "$user_id", "g": "$group"}, "newest": {"$max": "$created_at"}}},
        {"$sort": {"newest": 1}},
        {"$limit": FLUSH_GROUPS * 5},
    ]).to_list(length=FLUSH_GROUPS * 5)
    done = 0
    for g in groups:
        if done >= FLUSH_GROUPS:
            break
        if (_aware(g["newest"]) or now) > now - GATHER:
            continue
        uid, group = g["_id"]["u"], g["_id"]["g"]
        rows = await db[OUTBOX].find({"user_id": uid, "group": group, "state": "pending",
                                      "next_at": {"$lte": now}}).sort([("created_at", 1)]).to_list(length=200)
        if not rows:
            continue
        done += 1
        ids = [r["_id"] for r in rows]
        urow = await db["users"].find_one({"_id": _oid(uid)}) if _oid(uid) else None
        if urow is None or await db[SUBS].find_one({"user_id": uid}, {"_id": 1}) is None:
            await _done(db, ids, "no_device")
            bump("no_device", len(ids))
            continue
        payload, dropped = await _group_payload(db, uid, group, rows, urow)
        for why, gone in dropped.items():
            await _done(db, gone, why)
            bump(why, len(gone))
        if payload is None:
            continue
        live = [i for i in ids if not any(i in v for v in dropped.values())]
        if not await _claim_gap(db, uid, group, now):
            bump("waiting", len(live))
            continue
        try:
            res = await _send_to_devices(db, uid, payload, topic_key=f"{uid}:{group}", client=client)
        except Exception:
            log.warning("push: sending to %s failed", uid, exc_info=True)
            res = {"sent": 0, "gone": 0, "failed": 1, "retry": 0}
        if res["sent"]:
            await _done(db, live, "sent", "sent")
            bump("sent")
        elif res["retry"] and all(r.get("attempts", 0) + 1 < MAX_ATTEMPTS for r in rows):
            # Nothing reached a device and a push service asked us to come back: try again later.
            await db[PUSH_LOG].delete_one({"_id": f"{uid}:{group}"})
            wait = timedelta(seconds=30 * (rows[0].get("attempts", 0) + 1))
            await db[OUTBOX].update_many({"_id": {"$in": live}}, {"$set": {"next_at": now + wait}, "$inc": {"attempts": 1}})
            bump("retry", len(live))
        else:
            await _done(db, live, "failed" if (res["failed"] or res["retry"]) else "no_device", "failed")
            bump("failed", len(live))
    return counts


async def _prune(db: AsyncIOMotorDatabase, now: datetime, *, force: bool = False) -> int:
    """Drop devices not seen for ``STALE`` (the app re-registers its subscription every time it
    opens) or past the expiry the browser gave. At most once per ``PRUNE_EVERY``."""
    global _last_prune
    if not force and _last_prune is not None and now - _last_prune < PRUNE_EVERY:
        return 0
    _last_prune = now
    res = await db[SUBS].delete_many({"$or": [{"seen_at": {"$lt": now - STALE}},
                                              {"expires_at": {"$ne": None, "$lt": now}}]})
    if res.deleted_count:
        log.info("push: pruned %d stale device(s)", res.deleted_count)
    return res.deleted_count

