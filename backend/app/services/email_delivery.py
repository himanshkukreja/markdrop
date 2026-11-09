"""The one way an email leaves Markdrop: providers, daily limits, routing, the send log.

Every message (sign-in codes, mention and sign-off emails, shares, invitations,
access requests, guide emails, digests, campaigns) goes through ``send`` (one
message) or ``RoutedTransport.send_batch`` (a campaign batch), with a ``kind``
and a priority tier:

    auth            sign-in codes                       may use the whole daily room
    transactional   mentions, shares, requests, invites  stops at 95% of the combined room
    bulk            campaigns, the weekly digest         stops at 80% of the combined room

Providers. Resend and Brevo (``MARKDROP_BREVO_API_KEY``; off while unset), tried
in ``MARKDROP_EMAIL_PROVIDER_ORDER``. Each has a daily limit (UTC day; the free
plans: Resend 100; Brevo 250, Markdrop's share of its 300). A send claims its recipients atomically
(``$inc`` on ``email_quota``: one row per provider per day, plus ``all:<day>``
for the tier caps) *before* it posts, so two processes can't both take the last
slot. The first provider with room gets the message; a provider error (network,
5xx, 429, a refused key or sender, Brevo's 402) releases that claim and falls
back to the next. A payload error (400/422) is the message's fault and fails it
without a fallback.

No room. ``auth`` still tries (the claim is forced and a warning is logged:
nobody should be locked out because a newsletter went out). ``transactional``
and single ``bulk`` messages wait in ``email_retry`` for the next UTC day
(``process_retries``, run by the background loop; after ``MAX_RETRY_DAYS`` they
are dropped as ``over_limit``). A campaign stops where it is and continues the
next day (``email_campaigns/engine.py``).

Log. Every recipient of every send is a row in ``email_log`` (kept 90 days):
``{at, kind, priority, to, subject, provider, status, provider_message_id,
error, ref, attempts}``. Status: ``sent``, ``failed``, ``deferred`` (queued for
tomorrow), ``over_limit`` (dropped: no room for days), ``skipped`` (no provider
configured). Admin → Emails reads it.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.config import get_settings
from app.utils.http import shared_ssl

settings = get_settings()
log = logging.getLogger("uvicorn.error").getChild("email")

LOG = "email_log"
QUOTA = "email_quota"
RETRY = "email_retry"
ROUTES = "email_routes"
LOG_TTL_DAYS = 90
MAX_RETRY_DAYS = 3

RESEND_URL = "https://api.resend.com/emails"
RESEND_BATCH_URL = "https://api.resend.com/emails/batch"
BREVO_URL = "https://api.brevo.com/v3/smtp/email"

AUTH, TRANSACTIONAL, BULK = "auth", "transactional", "bulk"
TIERS = (AUTH, TRANSACTIONAL, BULK)
TIER_SHARE = {AUTH: 1.0, TRANSACTIONAL: 0.95, BULK: 0.80}
STATUSES = ("sent", "failed", "deferred", "over_limit", "skipped")

# kind → tier. An unknown kind is transactional.
KINDS: dict[str, str] = {
    "login": AUTH,
    "guide_signin": AUTH,
    "welcome": TRANSACTIONAL,
    "invite": TRANSACTIONAL,
    "share": TRANSACTIONAL,
    "access_request": TRANSACTIONAL,
    "edit_request": TRANSACTIONAL,
    "access_decision": TRANSACTIONAL,
    "guide_access_request": TRANSACTIONAL,
    "guide_access_decision": TRANSACTIONAL,
    "guide_domain": TRANSACTIONAL,
    "admin_change": TRANSACTIONAL,    # services/admin_roles.py: an admin added or removed
    "mention": TRANSACTIONAL,
    "signoff": TRANSACTIONAL,
    "campaign_test": TRANSACTIONAL,
    "template_test": TRANSACTIONAL,   # scripts/send_test_emails.py
    "digest": BULK,
    "campaign": BULK,
}


def tier_of(kind: str, priority: str | None = None) -> str:
    return priority if priority in TIERS else KINDS.get(kind, TRANSACTIONAL)


class DeliveryError(Exception):
    """No provider took the message. ``errors``: one line per provider tried."""

    def __init__(self, message: str, errors: list[str] | None = None):
        super().__init__(message)
        self.errors = errors or []


class ProviderError(Exception):
    """One provider refused or failed a request.

    ``fallback``: the provider is the problem (network, 5xx, 429, key, sender,
    credits), so another provider may take it. ``quota``: the provider says its
    daily or monthly quota is spent (it's marked full for the rest of the day).
    """

    def __init__(self, message: str, *, status: int | None = None, code: str | None = None,
                 fallback: bool = True, quota: bool = False, retry_after: float | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.fallback = fallback
        self.quota = quota
        self.retry_after = retry_after


@dataclass
class Outcome:
    """Per-message result of a batch (same shape as email_campaigns.transport.Outcome)."""
    provider_id: str | None
    error: str | None


@dataclass
class Result:
    status: str
    provider: str | None = None
    provider_message_id: str | None = None
    error: str | None = None
    log_ids: list[ObjectId] = field(default_factory=list)


# ── Addresses ──────────────────────────────────────────────────────────────────

_ADDR = re.compile(r"^\s*(?:\"?([^\"<]*?)\"?\s*)?<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$")


def parse_address(value: str) -> tuple[str | None, str]:
    """``"Name <a@b>"`` → ``("Name", "a@b")``; ``"a@b"`` → ``(None, "a@b")``."""
    m = _ADDR.match(value or "")
    if m:
        name = (m.group(1) or "").strip() or None
        return name, m.group(2).strip()
    return None, (value or "").strip()


def recipients(msg: dict[str, Any]) -> list[str]:
    to = msg.get("to") or []
    if isinstance(to, str):
        to = [to]
    return [parse_address(str(a))[1] for a in to if str(a).strip()]


# ── Providers ──────────────────────────────────────────────────────────────────

def _err_body(resp: httpx.Response) -> tuple[str, str]:
    try:
        body = resp.json()
    except ValueError:
        body = {}
    if not isinstance(body, dict):
        body = {}
    code = str(body.get("name") or body.get("code") or "")
    msg = str(body.get("message") or resp.text[:300] or f"HTTP {resp.status_code}")
    return code, msg[:400]


def _retry_after(resp: httpx.Response) -> float | None:
    for h in ("retry-after", "ratelimit-reset"):
        try:
            v = float(resp.headers.get(h, ""))
            if v > 0:
                return min(v, 60.0)
        except ValueError:
            pass
    return None


class Provider:
    name = ""

    def configured(self) -> bool:
        raise NotImplementedError

    def limit(self) -> int:
        raise NotImplementedError

    async def send(self, msg: dict[str, Any]) -> str | None:
        raise NotImplementedError

    async def send_batch(self, msgs: list[dict[str, Any]], idem_key: str | None) -> list[Outcome]:
        raise NotImplementedError


class Resend(Provider):
    name = "resend"
    idempotent = True

    def configured(self) -> bool:
        return bool(settings.resend_api_key)

    def limit(self) -> int:
        return max(0, int(settings.resend_daily_limit))

    def _error(self, resp: httpx.Response) -> ProviderError:
        code, msg = _err_body(resp)
        s = resp.status_code
        text = f"Resend {s}{' ' + code if code else ''}: {msg}"
        if s == 429:
            return ProviderError(text, status=s, code=code, quota="quota" in code, retry_after=_retry_after(resp))
        if s in (401, 403) or s >= 500:
            return ProviderError(text, status=s, code=code)
        # 400 / 404 / 409 / 422: the request itself (a bad address, a malformed payload).
        return ProviderError(text, status=s, code=code, fallback=False)

    async def _request(self, url: str, payload: Any, headers: dict[str, str] | None = None) -> httpx.Response:
        h = {"Authorization": f"Bearer {settings.resend_api_key}", **(headers or {})}
        try:
            async with httpx.AsyncClient(verify=shared_ssl(), timeout=30) as client:
                resp = await client.post(url, headers=h, json=payload)
        except httpx.HTTPError as e:
            raise ProviderError(f"Couldn't reach Resend: {e.__class__.__name__}") from e
        if resp.status_code >= 400:
            raise self._error(resp)
        return resp

    async def send(self, msg: dict[str, Any]) -> str | None:
        resp = await self._request(RESEND_URL, msg)
        try:
            return (resp.json() or {}).get("id")
        except ValueError:
            return None

    async def send_batch(self, msgs: list[dict[str, Any]], idem_key: str | None) -> list[Outcome]:
        headers = {"x-batch-validation": "permissive"}
        if idem_key:
            headers["Idempotency-Key"] = idem_key
        resp = await self._request(RESEND_BATCH_URL, msgs, headers)
        body = resp.json() if resp.content else {}
        data = list(body.get("data") or [])
        errors = {int(e.get("index", -1)): str(e.get("message") or "rejected") for e in body.get("errors") or []}
        out: list[Outcome] = []
        it = iter(data)
        for i in range(len(msgs)):
            if i in errors:
                out.append(Outcome(None, errors[i][:400]))
            else:
                out.append(Outcome((next(it, None) or {}).get("id"), None))
        return out


def brevo_payload(msg: dict[str, Any]) -> dict[str, Any]:
    """A Resend-shaped message as Brevo's ``POST /v3/smtp/email`` body."""
    # Every send path sets its own From (mailer._sender(purpose)); never fall back to the sign-in sender.
    name, email = parse_address(str(msg.get("from") or settings.email_from_share or settings.email_from_welcome or ""))
    if not email:
        raise ProviderError("Brevo: the message has no From address.", fallback=False)
    out: dict[str, Any] = {
        "sender": {"email": email, **({"name": name} if name else {})},
        "to": [{"email": a} for a in recipients(msg)],
        "subject": msg.get("subject") or "",
        "htmlContent": msg.get("html") or "",
    }
    if msg.get("text"):
        out["textContent"] = msg["text"]
    rt = msg.get("reply_to")
    if isinstance(rt, list):
        rt = rt[0] if rt else None
    if rt:
        rn, ra = parse_address(str(rt))
        out["replyTo"] = {"email": ra, **({"name": rn} if rn else {})}
    if msg.get("headers"):
        out["headers"] = {str(k): str(v) for k, v in msg["headers"].items()}
    tags = [f"{t.get('name')}:{t.get('value')}" if isinstance(t, dict) else str(t) for t in msg.get("tags") or []]
    if tags:
        out["tags"] = tags
    return out


class Brevo(Provider):
    name = "brevo"
    idempotent = False

    def configured(self) -> bool:
        return bool(settings.brevo_api_key)

    def limit(self) -> int:
        return max(0, int(settings.brevo_daily_limit))

    def _error(self, resp: httpx.Response) -> ProviderError:
        code, msg = _err_body(resp)
        s = resp.status_code
        text = f"Brevo {s}{' ' + code if code else ''}: {msg}"
        if s == 402:  # not enough credits
            return ProviderError(text, status=s, code=code, quota=True)
        if s == 429:
            return ProviderError(text, status=s, code=code, retry_after=_retry_after(resp))
        if s in (401, 403) or s >= 500:
            return ProviderError(text, status=s, code=code)
        return ProviderError(text, status=s, code=code, fallback=False)

    async def send(self, msg: dict[str, Any]) -> str | None:
        try:
            async with httpx.AsyncClient(verify=shared_ssl(), timeout=30) as client:
                resp = await client.post(
                    BREVO_URL, json=brevo_payload(msg),
                    headers={"api-key": settings.brevo_api_key, "accept": "application/json"},
                )
        except httpx.HTTPError as e:
            raise ProviderError(f"Couldn't reach Brevo: {e.__class__.__name__}") from e
        if resp.status_code >= 400:
            raise self._error(resp)
        try:
            return (resp.json() or {}).get("messageId")
        except ValueError:
            return None

    async def send_batch(self, msgs: list[dict[str, Any]], idem_key: str | None) -> list[Outcome]:
        """One request per message: a campaign message carries its own
        List-Unsubscribe header, which Brevo's messageVersions can't vary. A
        provider error on the first message fails the batch (so it can fall back
        whole); later, it fails the rest of the batch and keeps what went."""
        out: list[Outcome] = []
        for i, m in enumerate(msgs):
            try:
                out.append(Outcome(await self.send(m), None))
            except ProviderError as e:
                if e.fallback and i == 0:
                    raise
                if e.fallback:
                    out += [Outcome(None, f"Not sent: {e}")] * (len(msgs) - i)
                    break
                out.append(Outcome(None, str(e)))
        return out


PROVIDERS: dict[str, Provider] = {"resend": Resend(), "brevo": Brevo()}


def providers() -> list[Provider]:
    """Configured providers, in MARKDROP_EMAIL_PROVIDER_ORDER (any configured
    provider the order leaves out goes last)."""
    order = [n.strip().lower() for n in (settings.email_provider_order or "").split(",") if n.strip()]
    order += [n for n in PROVIDERS if n not in order]
    seen: list[Provider] = []
    for n in order:
        p = PROVIDERS.get(n)
        if p is not None and p not in seen and p.configured():
            seen.append(p)
    return seen


def configured() -> bool:
    return bool(providers())


# ── Daily quota ────────────────────────────────────────────────────────────────

def now() -> datetime:
    return datetime.now(timezone.utc)


def day_key(at: datetime | None = None) -> str:
    return (at or now()).astimezone(timezone.utc).strftime("%Y-%m-%d")


def next_day(at: datetime | None = None) -> datetime:
    t = (at or now()).astimezone(timezone.utc)
    return datetime(t.year, t.month, t.day, tzinfo=timezone.utc) + timedelta(days=1)


def total_limit() -> int:
    return sum(p.limit() for p in providers())


def tier_cap(tier: str) -> int:
    return int(total_limit() * TIER_SHARE.get(tier, TIER_SHARE[TRANSACTIONAL]))


async def _claim(db: AsyncIOMotorDatabase, key: str, n: int, cap: int, day: str) -> bool:
    """Atomically add ``n`` to the counter ``key`` if it stays within ``cap``."""
    if n > cap:
        return False
    flt = {"_id": key, "count": {"$lte": cap - n}}
    upd = {"$inc": {"count": n}, "$set": {"updated_at": now()}}
    for _ in range(2):
        if (await db[QUOTA].update_one(flt, upd)).modified_count:
            return True
        try:
            await db[QUOTA].insert_one({"_id": key, "day": day, "count": n, "created_at": now(), "updated_at": now()})
            return True
        except DuplicateKeyError:
            continue  # it exists: either full, or created a moment ago by someone else
    return False


async def _force(db: AsyncIOMotorDatabase, key: str, n: int, day: str) -> None:
    await db[QUOTA].update_one({"_id": key}, {"$inc": {"count": n}, "$set": {"updated_at": now()},
                                              "$setOnInsert": {"day": day, "created_at": now()}}, upsert=True)


async def _release(db: AsyncIOMotorDatabase, key: str, n: int) -> None:
    if n:
        await db[QUOTA].update_one({"_id": key}, {"$inc": {"count": -n}})


async def _mark_full(db: AsyncIOMotorDatabase, p: Provider, day: str) -> None:
    """The provider says its quota is spent: nothing else goes to it today."""
    await db[QUOTA].update_one({"_id": f"{p.name}:{day}"},
                               {"$max": {"count": p.limit()}, "$set": {"full": True, "updated_at": now()},
                                "$setOnInsert": {"day": day, "created_at": now()}}, upsert=True)


async def usage(db: AsyncIOMotorDatabase, day: str | None = None) -> dict[str, int]:
    """Today's (or ``day``'s) claimed counts: ``{provider: n, ..., "all": n}``."""
    day = day or day_key()
    rows = await db[QUOTA].find({"day": day}).to_list(length=20)
    out = {r["_id"].split(":", 1)[0]: max(0, int(r.get("count") or 0)) for r in rows}
    out.setdefault("all", 0)
    return out


async def room(db: AsyncIOMotorDatabase, tier: str, *, single: bool = False) -> int:
    """How many more recipients ``tier`` may reach today. ``single``: the most
    one provider can take in one go (a campaign batch goes to one provider)."""
    provs = providers()
    if not provs:
        return 0
    u = await usage(db)
    left_all = max(0, tier_cap(tier) - u.get("all", 0))
    per = [max(0, p.limit() - u.get(p.name, 0)) for p in provs]
    return min(left_all, max(per) if single else sum(per))


# ── Log ────────────────────────────────────────────────────────────────────────

def _subject(msg: dict[str, Any]) -> str:
    return str(msg.get("subject") or "")[:300]


async def _log(db: AsyncIOMotorDatabase, msg: dict[str, Any], *, kind: str, tier: str, ref: str | None,
               status: str, provider: str | None = None, provider_message_id: str | None = None,
               error: str | None = None, attempts: int = 1, to: list[str] | None = None) -> list[ObjectId]:
    at = now()
    rows = [{
        "_id": ObjectId(), "at": at, "kind": kind, "priority": tier, "to": addr.lower(),
        "subject": _subject(msg), "provider": provider, "status": status,
        "provider_message_id": provider_message_id, "error": (error or None) and str(error)[:1000],
        "ref": ref, "attempts": attempts, "expires_at": at + timedelta(days=LOG_TTL_DAYS),
    } for addr in (to if to is not None else recipients(msg)) or ["(none)"]]
    try:
        await db[LOG].insert_many(rows, ordered=False)
    except Exception:
        log.warning("[email] couldn't write email_log", exc_info=True)
    return [r["_id"] for r in rows]


async def _relog(db: AsyncIOMotorDatabase, ids: list[ObjectId], **fields: Any) -> None:
    if not ids:
        return
    try:
        await db[LOG].update_many({"_id": {"$in": ids}}, {"$set": {**fields, "updated_at": now()}})
    except Exception:
        log.warning("[email] couldn't update email_log", exc_info=True)


async def _record(db: AsyncIOMotorDatabase, retry: dict | None, msg: dict[str, Any], *, kind: str, tier: str,
                  ref: str | None, status: str, **fields: Any) -> list[ObjectId]:
    """A new log row per recipient, or (for a retried message) its rows updated."""
    if retry and retry.get("log_ids"):
        await _relog(db, retry["log_ids"], status=status, attempts=int(retry.get("attempts") or 0) + 1,
                     at=now(), **{k: v for k, v in fields.items() if k != "attempts"})
        return list(retry["log_ids"])
    return await _log(db, msg, kind=kind, tier=tier, ref=ref, status=status, **fields)


def _db() -> AsyncIOMotorDatabase:
    from app.database import get_database

    return get_database()


def _tagged(msg: dict[str, Any], kind: str) -> dict[str, Any]:
    tags = [t for t in (msg.get("tags") or []) if not (isinstance(t, dict) and t.get("name") == "kind")]
    return {**msg, "tags": [*tags, {"name": "kind", "value": kind}]}


# ── One message ────────────────────────────────────────────────────────────────

async def send(msg: dict[str, Any], *, kind: str, priority: str | None = None, ref: str | None = None,
               db: AsyncIOMotorDatabase | None = None, _retry: dict | None = None) -> Result:
    """Send one Resend-shaped message (``from``, ``to``, ``subject``, ``html``,
    ``text``, ``reply_to``, ``headers``). Returns the outcome; raises
    ``DeliveryError`` when every provider tried failed (logged as ``failed``).
    ``deferred`` / ``over_limit`` / ``skipped`` are returned, not raised."""
    db = db if db is not None else _db()
    tier = tier_of(kind, priority)
    provs = providers()
    if not provs:
        ids = await _record(db, _retry, msg, kind=kind, tier=tier, ref=ref, status="skipped",
                            error="No email provider is configured.")
        return Result("skipped", error="No email provider is configured.", log_ids=ids)
    to = recipients(msg)
    n = max(1, len(to))
    day = day_key()
    all_key = f"all:{day}"
    forced = False
    if not await _claim(db, all_key, n, tier_cap(tier), day):
        if tier != AUTH:
            return await _defer(db, msg, kind=kind, tier=tier, ref=ref, retry=_retry)
        log.warning("[email] daily limit reached; sending %s to %s anyway (sign-in)", kind, to)
        forced = True
        await _force(db, all_key, n, day)
    payload = _tagged(msg, kind)
    errors: list[str] = []
    tried = False
    for force_pass in ((False, True) if tier == AUTH else (False,)):
        if force_pass and tried:
            break
        if force_pass:
            log.warning("[email] every provider is at its limit; sending %s anyway (sign-in)", kind)
        for p in provs:
            key = f"{p.name}:{day}"
            if force_pass or forced:
                await _force(db, key, n, day)
            elif not await _claim(db, key, n, p.limit(), day):
                continue
            tried = True
            try:
                mid = await p.send(payload)
            except ProviderError as e:
                await _release(db, key, n)
                if e.quota:
                    await _mark_full(db, p, day)
                errors.append(str(e))
                log.warning("[email] %s via %s failed: %s", kind, p.name, e)
                if e.fallback:
                    continue
                break
            ids = await _record(db, _retry, msg, kind=kind, tier=tier, ref=ref, status="sent",
                                provider=p.name, provider_message_id=mid, error=None)
            return Result("sent", provider=p.name, provider_message_id=mid, log_ids=ids)
    await _release(db, all_key, n)
    if not tried:  # combined room, but no single provider had room for it
        return await _defer(db, msg, kind=kind, tier=tier, ref=ref, retry=_retry)
    err = "; ".join(errors) or "No provider accepted the message."
    await _record(db, _retry, msg, kind=kind, tier=tier, ref=ref, status="failed", provider=None, error=err)
    raise DeliveryError(err, errors)


async def _defer(db: AsyncIOMotorDatabase, msg: dict[str, Any], *, kind: str, tier: str, ref: str | None,
                 retry: dict | None) -> Result:
    """No room today: wait in the retry queue for tomorrow (UTC), or give up
    after ``MAX_RETRY_DAYS``."""
    attempts = int((retry or {}).get("attempts") or 0) + 1
    if attempts > MAX_RETRY_DAYS:
        err = f"Over the daily email limit for {MAX_RETRY_DAYS} days; dropped."
        ids = await _record(db, retry, msg, kind=kind, tier=tier, ref=ref, status="over_limit", error=err)
        if retry:
            await db[RETRY].delete_one({"_id": retry["_id"]})
        log.warning("[email] %s dropped: over the daily limit for %d days", kind, MAX_RETRY_DAYS)
        return Result("over_limit", error=err, log_ids=ids)
    due = next_day()
    err = f"Over today's email limit; queued for {due.strftime('%Y-%m-%d')} (UTC)."
    ids = await _record(db, retry, msg, kind=kind, tier=tier, ref=ref, status="deferred", error=err)
    if retry:
        await db[RETRY].update_one({"_id": retry["_id"]}, {"$set": {
            "due_at": due, "attempts": attempts, "state": "waiting", "updated_at": now()}})
    else:
        await db[RETRY].insert_one({
            "msg": msg, "kind": kind, "priority": tier, "priority_rank": TIERS.index(tier), "ref": ref,
            "due_at": due, "attempts": attempts,
            "state": "waiting", "log_ids": ids, "created_at": now(), "updated_at": now(),
        })
    log.info("[email] %s deferred to %s: over the daily limit", kind, due.date())
    return Result("deferred", error=err, log_ids=ids)


async def process_retries(db: AsyncIOMotorDatabase, *, limit: int = 50, at: datetime | None = None) -> dict[str, int]:
    """Send what waited for a new day. One claim per item, so two passes never
    send the same one; an item left ``sending`` by a dead process goes back
    after 10 minutes."""
    t = at or now()
    await db[RETRY].update_many({"state": "sending", "claimed_at": {"$lt": t - timedelta(minutes=10)}},
                                {"$set": {"state": "waiting"}})
    counts: dict[str, int] = {}
    for _ in range(limit):
        item = await db[RETRY].find_one_and_update(
            {"state": "waiting", "due_at": {"$lte": t}},
            {"$set": {"state": "sending", "claimed_at": now()}},
            sort=[("priority_rank", 1), ("due_at", 1)], return_document=ReturnDocument.AFTER,
        )
        if item is None:
            break
        try:
            r = await send(item["msg"], kind=item["kind"], priority=item.get("priority"), ref=item.get("ref"),
                           db=db, _retry=item)
            status = r.status
        except DeliveryError:
            status = "failed"
        except Exception:
            log.exception("[email] retry of %s failed", item.get("kind"))
            status = "failed"
        if status in ("sent", "failed", "skipped"):
            await db[RETRY].delete_one({"_id": item["_id"]})
        counts[status] = counts.get(status, 0) + 1
        if status == "deferred":
            break  # still no room: the rest wait too
    return counts


# ── Campaign batches ───────────────────────────────────────────────────────────

class NoRoom(Exception):
    """No provider has room for this batch today."""


def _batch_kind(msgs: list[dict[str, Any]]) -> tuple[str, str | None]:
    hdr = (msgs[0].get("headers") or {}) if msgs else {}
    cid = hdr.get("X-Markdrop-Campaign")
    if cid == "test":
        return "campaign_test", None
    return "campaign", (str(cid) if cid else None)


class RoutedTransport:
    """The campaign engine's transport (``email_campaigns.transport.make``): a
    batch goes to one provider (the first with room for all of it), falls back
    on a provider error, and every message is logged."""

    name = "routed"

    def __init__(self, db: AsyncIOMotorDatabase, *, kind: str | None = None, priority: str | None = None):
        self.db = db
        self.kind = kind
        self.priority = priority

    def _tier(self, kind: str) -> str:
        return tier_of(kind, self.priority)

    async def room(self, kind: str = "campaign") -> int:
        return await room(self.db, self._tier(self.kind or kind), single=True)

    async def send_batch(self, messages: list[dict[str, Any]], idem_key: str | None) -> list[Outcome]:
        if not messages:
            return []
        kind, ref = _batch_kind(messages)
        kind = self.kind or kind
        tier = self._tier(kind)
        db = self.db
        n = len(messages)
        day = day_key()
        all_key = f"all:{day}"
        if not await _claim(db, all_key, n, tier_cap(tier), day):
            raise NoRoom("Today's email limit is reached.")
        payload = [_tagged(m, kind) for m in messages]
        last: ProviderError | None = None
        tried = False
        for p in providers():
            key = f"{p.name}:{day}"
            if not await _claim(db, key, n, p.limit(), day):
                continue
            tried = True
            if idem_key:
                await db[ROUTES].update_one({"_id": idem_key}, {"$set": {"provider": p.name, "at": now()}}, upsert=True)
            try:
                outcomes = await p.send_batch(payload, idem_key if p.idempotent else None)
            except ProviderError as e:
                await _release(db, key, n)
                if e.quota:
                    await _mark_full(db, p, day)
                log.warning("[email] campaign batch via %s failed: %s", p.name, e)
                last = e
                if e.fallback:
                    continue
                break
            bad = sum(1 for o in outcomes if o.error)
            await _release(db, key, bad)
            await _release(db, all_key, bad)
            await self._log(messages, outcomes, kind=kind, tier=tier, ref=ref, provider=p.name)
            return outcomes
        await _release(db, all_key, n)
        if not tried:
            raise NoRoom("Today's email limit is reached.")
        assert last is not None
        raise last

    async def repost(self, messages: list[dict[str, Any]], idem_key: str) -> list[Outcome]:
        """Finish a batch a dead process was posting (engine.recover). Only an
        idempotent provider (Resend) can be asked again safely; a batch that was
        going to Brevo may have been delivered, so it's reported, not resent.
        The quota was claimed when it was first posted."""
        kind, ref = _batch_kind(messages)
        kind = self.kind or kind
        row = await self.db[ROUTES].find_one({"_id": idem_key}) or {}
        name = row.get("provider") or "resend"
        p = PROVIDERS.get(name)
        if p is None or not p.idempotent or not p.configured():
            return [Outcome(None, f"Interrupted mid-send via {name}; it may have been delivered. "
                                  "Retry only if you accept a possible duplicate.")] * len(messages)
        outcomes = await p.send_batch([_tagged(m, kind) for m in messages], idem_key)
        await self._log(messages, outcomes, kind=kind, tier=self._tier(kind), ref=ref, provider=p.name)
        return outcomes

    async def _log(self, messages: list[dict[str, Any]], outcomes: list[Outcome], *, kind: str, tier: str,
                   ref: str | None, provider: str) -> None:
        at = now()
        rows = []
        for m, o in zip(messages, outcomes):
            for addr in recipients(m) or ["(none)"]:
                rows.append({
                    "_id": ObjectId(), "at": at, "kind": kind, "priority": tier, "to": addr.lower(),
                    "subject": _subject(m), "provider": provider, "status": "failed" if o.error else "sent",
                    "provider_message_id": o.provider_id, "error": o.error, "ref": ref, "attempts": 1,
                    "expires_at": at + timedelta(days=LOG_TTL_DAYS),
                })
        if rows:
            try:
                await self.db[LOG].insert_many(rows, ordered=False)
            except Exception:
                log.warning("[email] couldn't write email_log", exc_info=True)


# ── Indexes ────────────────────────────────────────────────────────────────────

async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[LOG].create_index("expires_at", expireAfterSeconds=0)
    await db[LOG].create_index([("at", -1)])
    await db[LOG].create_index([("kind", 1), ("at", -1)])
    await db[LOG].create_index([("status", 1), ("at", -1)])
    await db[LOG].create_index([("provider", 1), ("at", -1)])
    await db[LOG].create_index([("to", 1), ("at", -1)])
    await db[QUOTA].create_index("day")
    await db[QUOTA].create_index("created_at", expireAfterSeconds=60 * 24 * 3600)
    await db[RETRY].create_index([("state", 1), ("due_at", 1)])
    await db[ROUTES].create_index("at", expireAfterSeconds=3 * 24 * 3600)
