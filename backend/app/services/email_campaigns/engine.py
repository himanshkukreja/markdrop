"""Campaign sending.

queue      snapshots the audience into ``email_messages`` (one row per person,
           unique per campaign, random tracking token) and flips the campaign to
           ``sending`` (or ``scheduled``). Nothing is emailed yet.
tick       one bounded unit of work for one campaign, under a per-campaign
           lease (``lock_until``/``lock_owner``) so two processes, or the worker
           and an admin tab, never send the same campaign at once. Each round:
           re-check unsubscribes and suppressions for the next rows, claim them
           atomically, render each for its recipient, send them in ONE Resend
           batch call, store the provider ids. Pause and cancel are honoured
           between rounds.
worker     an asyncio task started with the app: promotes due scheduled
           campaigns and ticks every sending campaign.

Restart safety. Every provider call is recorded in ``email_batches`` before it
is made: ``claimed`` (rows taken, nothing sent) → ``posting`` (request about to
go out; idempotency key stored) → ``done``. Whoever next takes the lease first
finishes the dead holder's batches: ``claimed`` rows go back to the queue;
``posting`` batches are re-posted with the *same* idempotency key and the same
rendered payload (merge data is stored on the row before posting), which Resend
answers with the original result instead of sending again. So a crash or a
deploy mid-send never sends anyone a second copy. (Keys live 24 h; an older
interrupted batch is marked failed with a "may have been delivered" note.)

Errors. Auth / unverified domain / quota → the whole campaign pauses with
``last_error`` and the rows go back to the queue. Rate limits → wait
``Retry-After`` and retry the same batch. Network / 5xx → rows go back, the
worker backs off; five in a row pause the campaign. A single bad address fails
only that row. Hard bounces and complaints (webhooks) become suppressions.
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
import socket
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import UpdateOne

from app.config import get_settings

from . import audience, links, render, senders, store, transport

settings = get_settings()
log = logging.getLogger("uvicorn.error").getChild("email")

WORKER_ID = f"{socket.gethostname()}:{os.getpid()}:{secrets.token_hex(3)}"
LEASE_S = 60.0
BUDGET_S = 25.0
MAX_TRANSIENT = 5
IDEM_TTL = timedelta(hours=23)


class EngineError(Exception):
    def __init__(self, status: int, message: str, **extra: Any):
        super().__init__(message)
        self.status = status
        self.extra = extra


def batch_size() -> int:
    return max(1, min(transport.MAX_BATCH, int(settings.email_batch_size or 100)))


def round_gap() -> float:
    return max(0.0, int(settings.email_round_gap_ms or 0) / 1000)


def confirm_phrase(n: int) -> str:
    return f"send to {n}"


# ── Public shapes ──────────────────────────────────────────────────────────────

def summary(c: dict[str, Any], counts: dict[str, int] | None = None) -> dict[str, Any]:
    iso = store.iso
    return {
        "id": str(c["_id"]),
        "legacy": False,
        "name": c.get("name") or "Untitled campaign",
        "subject": c.get("subject") or "",
        "subject_fallback": c.get("subject_fallback"),
        "preheader": c.get("preheader"),
        "template": c.get("template") or "newsletter",
        "layout": (c.get("doc") or {}).get("layout", "blocks"),
        "sender_id": c.get("sender_id"),
        "sender": c.get("sender"),
        "audience": c.get("audience") or {"kind": "all"},
        "track_opens": c.get("track_opens", True),
        "track_clicks": c.get("track_clicks", True),
        "status": c.get("status", "draft"),
        "scheduled_at": iso(c.get("scheduled_at")),
        "last_error": c.get("last_error"),
        "created_by": c.get("created_by"),
        "created_at": iso(c.get("created_at")),
        "updated_at": iso(c.get("updated_at")),
        "queued_at": iso(c.get("queued_at")),
        "started_at": iso(c.get("started_at")),
        "finished_at": iso(c.get("finished_at")),
        "lock_until": iso(c.get("lock_until")),
        "counts": counts if counts is not None else (c.get("counts") or store.empty_counts()),
    }


def full(c: dict[str, Any], counts: dict[str, int] | None = None) -> dict[str, Any]:
    return {**summary(c, counts), "doc": c.get("doc")}


def legacy_summary(r: dict[str, Any]) -> dict[str, Any]:
    """A campaign from the old emailer (``campaigns`` collection), read-only."""
    total, sent, failed = int(r.get("total") or 0), int(r.get("sent") or 0), int(r.get("failed") or 0)
    status = {"partial": "sent", "queued": "sending"}.get(r.get("status", ""), r.get("status") or "sent")
    counts = {**store.empty_counts(), "total": total, "sent": sent, "failed": failed}
    return {
        "id": f"legacy-{r['_id']}",
        "legacy": True,
        "name": r.get("subject") or "(no subject)",
        "subject": r.get("subject") or "",
        "status": status,
        "legacy_status": r.get("status"),
        "audience": {"kind": r.get("audience", "all"), "days": r.get("recent_days")},
        "sender": {"from_email": r.get("sender")},
        "created_at": store.iso(r.get("created_at")),
        "updated_at": store.iso(r.get("finished_at") or r.get("created_at")),
        "finished_at": store.iso(r.get("finished_at")),
        "counts": counts,
        "track_opens": False,
        "track_clicks": False,
    }


# ── Drafts ─────────────────────────────────────────────────────────────────────

async def create(db: AsyncIOMotorDatabase, content: dict[str, Any], admin: str | None) -> dict[str, Any]:
    t = store.now()
    doc = {
        **content, "status": "draft", "scheduled_at": None, "last_error": None, "lock_until": None,
        "lock_owner": None, "created_by": admin, "created_at": t, "updated_at": t, "queued_at": None,
        "started_at": None, "finished_at": None, "sender": None, "counts": store.empty_counts(),
    }
    res = await db["email_campaigns"].insert_one(doc)
    doc["_id"] = res.inserted_id
    return doc


async def _get(db: AsyncIOMotorDatabase, cid: str) -> dict[str, Any]:
    c = await store.get_campaign(db, cid)
    if not c:
        raise EngineError(404, "Campaign not found.")
    return c


async def update_draft(db: AsyncIOMotorDatabase, cid: str, content: dict[str, Any]) -> dict[str, Any]:
    c = await _get(db, cid)
    res = await store.update_campaign(db, c["_id"], content, only_if=("draft",))
    if not res:
        raise EngineError(409, "Only drafts can be edited. Duplicate it to send a changed version.")
    return res


async def delete(db: AsyncIOMotorDatabase, cid: str) -> None:
    c = await _get(db, cid)
    res = await db["email_campaigns"].delete_one({"_id": c["_id"], "status": {"$in": ["draft", "cancelled"]}})
    if not res.deleted_count:
        raise EngineError(409, "Only drafts and cancelled campaigns can be deleted (sent ones keep their tracking history).")
    for coll in ("email_messages", "email_events", "email_batches"):
        await db[coll].delete_many({"campaign_id": c["_id"]})


CONTENT_KEYS = ("name", "subject", "subject_fallback", "preheader", "template", "doc", "sender_id",
                "audience", "track_opens", "track_clicks")


async def duplicate(db: AsyncIOMotorDatabase, cid: str, admin: str | None) -> dict[str, Any]:
    c = await _get(db, cid)
    content = {k: c.get(k) for k in CONTENT_KEYS}
    content["name"] = f"{(c.get('name') or 'Campaign')[:110]} (copy)"
    return await create(db, content, admin)


# ── Queue ──────────────────────────────────────────────────────────────────────

async def pending(db: AsyncIOMotorDatabase, c: dict[str, Any]) -> dict[str, Any]:
    exclude = await store.existing_emails(db, c["_id"])
    return await audience.resolve(db, c.get("audience") or {"kind": "all"}, exclude)


async def queue(
    db: AsyncIOMotorDatabase, cid: str, confirm: str, admin: str | None, scheduled_at: datetime | None = None,
) -> dict[str, Any]:
    c = await _get(db, cid)
    status = c.get("status")
    if status == "cancelled":
        raise EngineError(409, "This campaign was cancelled. Duplicate it to send again.")
    if status == "scheduled":
        raise EngineError(409, "This campaign is already scheduled. Unschedule it first to change the audience or time.")
    if scheduled_at is not None:
        if status != "draft":
            raise EngineError(409, "Only a draft can be scheduled.")
        if scheduled_at.tzinfo is None:
            scheduled_at = scheduled_at.replace(tzinfo=timezone.utc)
        if scheduled_at < store.now() + timedelta(seconds=30):
            raise EngineError(400, "Pick a time at least a minute from now, or send it now.")
        if scheduled_at > store.now() + timedelta(days=365):
            raise EngineError(400, "Schedule within the next year.")
    problems = render.content_problems(c)
    if problems:
        raise EngineError(400, f"Fix {len(problems)} problem{'s' if len(problems) != 1 else ''} first: "
                          + "; ".join(f"{p['where']}: {p['message']}" for p in problems[:3]))
    sender = await senders.resolve(db, c.get("sender_id"))
    if transport.mode() == "resend" and sender["check"]["level"] == "bad":
        raise EngineError(400, f"Sender can't send: {sender['check']['message']}")
    audience.invalidate()
    res = await pending(db, c)
    recipients = res["recipients"]
    if not recipients:
        raise EngineError(400, "Nobody new to send to in this audience.")
    expected = confirm_phrase(len(recipients))
    if (confirm or "").strip().lower() != expected:
        raise EngineError(400, f'Type "{expected}" to confirm.', expected=expected)
    rows = [store.new_message(c["_id"], r, links.new_token()) for r in recipients]
    added = await store.insert_messages(db, c["_id"], rows)
    t = store.now()
    patch: dict[str, Any] = {
        "status": "scheduled" if scheduled_at else "sending",
        "scheduled_at": scheduled_at,
        "sender": senders.snapshot(sender),
        "sender_id": sender["id"],
        "queued_at": c.get("queued_at") or t,
        "finished_at": None,
        "last_error": None,
        "transient_errors": 0,
        "created_by": c.get("created_by") or admin,
    }
    updated = await store.update_campaign(db, c["_id"], patch)
    counts = await store.refresh_counts(db, c["_id"])
    kick()
    return {"added": added, "campaign": summary(updated, counts)}


# ── Controls ───────────────────────────────────────────────────────────────────

async def control(db: AsyncIOMotorDatabase, cid: str, action: str, *, failed: bool = True, stuck: bool = False) -> dict[str, Any]:
    c = await _get(db, cid)
    status = c.get("status")

    def bad() -> EngineError:
        return EngineError(409, f"Can't {action.replace('_', ' ')} a {status} campaign.")

    out: dict[str, Any] = {}
    if action == "pause":
        res = await store.update_campaign(db, c["_id"], {"status": "paused"}, only_if=("sending",))
        if not res:
            raise bad()
    elif action == "resume":
        res = await store.update_campaign(
            db, c["_id"], {"status": "sending", "last_error": None, "finished_at": None, "transient_errors": 0},
            only_if=("paused", "sent"),
        )
        if not res:
            raise bad()
    elif action == "cancel":
        res = await store.update_campaign(
            db, c["_id"], {"status": "cancelled", "finished_at": store.now()},
            only_if=("draft", "scheduled", "sending", "paused"),
        )
        if not res:
            raise bad()
        r = await db["email_messages"].update_many(
            {"campaign_id": c["_id"], "status": "queued"},
            {"$set": {"status": "skipped", "error": "cancelled", "updated_at": store.now()}},
        )
        out["skipped"] = r.modified_count
    elif action == "unschedule":
        res = await store.update_campaign(
            db, c["_id"], {"status": "draft", "scheduled_at": None, "queued_at": None}, only_if=("scheduled",),
        )
        if not res:
            raise bad()
        r = await db["email_messages"].delete_many({"campaign_id": c["_id"], "status": "queued"})
        out["removed"] = r.deleted_count
    elif action == "send_now":
        res = await store.update_campaign(db, c["_id"], {"scheduled_at": store.now()}, only_if=("scheduled",))
        if not res:
            raise bad()
    elif action == "retry":
        if status not in ("sent", "paused", "sending"):
            raise bad()
        n = await store.requeue(db, c["_id"], failed=failed, stuck=stuck)
        out["requeued"] = n
        if n:
            await store.update_campaign(
                db, c["_id"], {"status": "sending", "finished_at": None, "last_error": None, "transient_errors": 0},
                only_if=("sent", "paused", "sending"),
            )
    else:
        raise EngineError(400, f"Unknown action {action!r}.")
    c = await store.get_campaign(db, c["_id"])
    counts = await store.refresh_counts(db, c["_id"])
    kick()
    return {**out, "campaign": summary(c, counts)}


# ── Sending ────────────────────────────────────────────────────────────────────

def _reply_to(sender: dict[str, Any]) -> str:
    return sender.get("reply_to") or settings.email_reply_to


def build_message(c: dict[str, Any], sender: dict[str, Any], to: str, r: dict[str, str], *,
                  campaign_id: str, message_id: str, subject_prefix: str = "") -> dict[str, Any]:
    reply = _reply_to(sender)
    msg: dict[str, Any] = {
        "from": transport.format_from(sender.get("from_name"), sender["from_email"]),
        "to": [to],
        "subject": f"{subject_prefix}{r['subject']}",
        "html": r["html"],
        "text": r["text"],
        "reply_to": reply,
        "headers": {
            "List-Unsubscribe": f"<{r['unsubscribe_url']}>, <mailto:{reply}?subject=unsubscribe>",
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            "X-Markdrop-Campaign": campaign_id,
            "X-Markdrop-Message": message_id,
        },
    }
    if campaign_id != "test":
        msg["tags"] = [{"name": "campaign", "value": campaign_id}]
    return msg


def _payload(c: dict[str, Any], sender: dict[str, Any], rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for m in rows:
        r = render.render_for(c, m.get("vars") or {}, m["token"])
        out.append(build_message(c, sender, m["email"], r, campaign_id=str(c["_id"]), message_id=str(m["_id"])))
    return out


async def _post(t: Any, payload: list[dict[str, Any]], key: str, budget_end: float) -> list[transport.Outcome]:
    """One provider call, retrying rate limits with the same key."""
    attempt = 0
    while True:
        try:
            return await t.send_batch(payload, key)
        except transport.SendError as e:
            attempt += 1
            if e.fatal or e.retry_after is None or attempt >= 5 or time.monotonic() + e.retry_after > budget_end + 30:
                raise
            log.warning("[email] rate limited; retrying batch in %.1fs", e.retry_after)
            await asyncio.sleep(e.retry_after)


async def _apply(db: AsyncIOMotorDatabase, rows: list[dict[str, Any]], outcomes: list[transport.Outcome],
                 note: str | None = None) -> tuple[int, list[dict[str, str]]]:
    t = store.now()
    ops = []
    sent = 0
    failed: list[dict[str, str]] = []
    for m, o in zip(rows, outcomes):
        if o.error:
            ops.append(UpdateOne({"_id": m["_id"], "status": "sending"}, {"$set": {
                "status": "failed", "error": o.error, "claim_id": None, "updated_at": t}}))
            failed.append({"email": m["email"], "error": o.error})
        else:
            ops.append(UpdateOne({"_id": m["_id"], "status": "sending"}, {"$set": {
                "status": "sent", "sent_at": t, "provider_id": o.provider_id, "error": note,
                "claim_id": None, "updated_at": t}}))
            sent += 1
    if ops:
        await db["email_messages"].bulk_write(ops, ordered=False)
    return sent, failed


async def recover(db: AsyncIOMotorDatabase, c: dict[str, Any], t: Any) -> None:
    """Finish or undo batches a previous lease holder left behind."""
    async for b in db["email_batches"].find({"campaign_id": c["_id"], "state": {"$in": ["claimed", "posting"]}}):
        bid = b["_id"]
        if b["state"] == "claimed":
            n = await store.release_claim(db, bid)
            await db["email_batches"].update_one({"_id": bid}, {"$set": {"state": "released", "updated_at": store.now()}})
            log.info("[email] recovered claimed batch %s: %d rows back to the queue", bid, n)
            continue
        rows = await db["email_messages"].find({"claim_id": bid, "status": "sending"}).sort("_id", 1).to_list(length=None)
        if not rows:
            await db["email_batches"].update_one({"_id": bid}, {"$set": {"state": "done", "updated_at": store.now()}})
            continue
        if store.now() - b["created_at"].replace(tzinfo=timezone.utc) > IDEM_TTL:
            await _apply(db, rows, [transport.Outcome(None, "Interrupted mid-send over a day ago; it may have been delivered. Retry only if you accept a possible duplicate.")] * len(rows))
            await db["email_batches"].update_one({"_id": bid}, {"$set": {"state": "abandoned", "updated_at": store.now()}})
            continue
        sender = c.get("sender") or senders.snapshot(await senders.resolve(db, c.get("sender_id")))
        try:
            outcomes = await _post(t, _payload(c, sender, rows), b["idem_key"], time.monotonic() + 30)
            note = None
        except transport.SendError as e:
            if e.code == "invalid_idempotent_request":
                # Resend already has this key with a different body: it took the
                # original request, so these were sent before the restart.
                outcomes = [transport.Outcome(None, None)] * len(rows)
                note = "sent before a restart (provider id unknown)"
            else:
                raise
        sent, failed = await _apply(db, rows, outcomes, note)
        await db["email_batches"].update_one({"_id": bid}, {"$set": {"state": "done", "updated_at": store.now()}})
        log.info("[email] recovered posting batch %s: %d sent, %d failed (same idempotency key)", bid, sent, len(failed))


def _result(c: dict[str, Any] | None, counts: dict[str, int] | None = None, **kw: Any) -> dict[str, Any]:
    return {
        "campaign": summary(c, counts) if c else None,
        "sent_now": kw.get("sent_now", 0),
        "failed_now": kw.get("failed_now", []),
        "skipped_now": kw.get("skipped_now", 0),
        "busy": kw.get("busy", False),
        "done": kw.get("done", False),
        "transport": transport.mode(),
        "error": kw.get("error"),
    }


async def tick(db: AsyncIOMotorDatabase, cid: str | ObjectId, budget_s: float = BUDGET_S, t: Any = None,
               owner: str = WORKER_ID) -> dict[str, Any]:
    c = await store.get_campaign(db, cid)
    if not c:
        raise EngineError(404, "Campaign not found.")
    if c.get("status") != "sending":
        return _result(c, done=True)
    if not await store.acquire_lease(db, c["_id"], owner, LEASE_S):
        return _result(c, busy=True)

    started = time.monotonic()
    budget_end = started + budget_s
    t = t or transport.make(db)
    sent_now, skipped_now = 0, 0
    failed_now: list[dict[str, str]] = []
    fatal: str | None = None
    transient: str | None = None
    try:
        await recover(db, c, t)
        if not c.get("started_at"):
            await store.update_campaign(db, c["_id"], {"started_at": store.now()})
        sender = c.get("sender") or senders.snapshot(await senders.resolve(db, c.get("sender_id")))
        n = batch_size()
        first = True
        while time.monotonic() < budget_end and not _stopping.is_set():
            if not first and round_gap():
                await asyncio.sleep(round_gap())
            first = False
            if not await store.renew_lease(db, c["_id"], owner, LEASE_S):
                break
            cur = await store.get_campaign(db, c["_id"])
            if not cur or cur.get("status") != "sending":
                break
            nxt = await store.peek_queued(db, c["_id"], n)
            if not nxt:
                break
            blocked = await audience.blocked(db, [m["email"] for m in nxt])
            for reason in ("unsubscribed", "suppressed"):
                skipped_now += await store.skip(db, [m["_id"] for m in nxt if blocked.get(m["email"]) == reason], reason)
            ids = [m["_id"] for m in nxt if m["email"] not in blocked]
            if not ids:
                continue
            claim_id = secrets.token_hex(12)
            now = store.now()
            await db["email_batches"].insert_one({
                "_id": claim_id, "campaign_id": c["_id"], "state": "claimed", "owner": owner,
                "created_at": now, "updated_at": now,
            })
            rows = await store.claim(db, ids, claim_id)
            if not rows:
                await db["email_batches"].update_one({"_id": claim_id}, {"$set": {"state": "done"}})
                continue
            vmap = await audience.merge_vars_for(db, [m["email"] for m in rows])
            await db["email_messages"].bulk_write(
                [UpdateOne({"_id": m["_id"]}, {"$set": {"vars": vmap[m["email"]]}}) for m in rows], ordered=False
            )
            for m in rows:
                m["vars"] = vmap[m["email"]]
            payload = _payload(c, sender, rows)
            key = f"md-{c['_id']}-{claim_id}"
            await db["email_batches"].update_one({"_id": claim_id}, {"$set": {
                "state": "posting", "idem_key": key, "message_ids": [m["_id"] for m in rows], "updated_at": store.now()}})
            try:
                outcomes = await _post(t, payload, key, budget_end)
            except transport.SendError as e:
                await store.release_claim(db, claim_id)
                await db["email_batches"].update_one({"_id": claim_id}, {"$set": {"state": "released", "error": str(e), "updated_at": store.now()}})
                if e.fatal:
                    fatal = str(e)
                else:
                    transient = str(e)
                break
            s, f = await _apply(db, rows, outcomes)
            await db["email_batches"].update_one({"_id": claim_id}, {"$set": {"state": "done", "updated_at": store.now()}})
            sent_now += s
            failed_now += f
            if cur.get("transient_errors"):
                await store.update_campaign(db, c["_id"], {"transient_errors": 0})
    except transport.SendError as e:  # from recovery
        if e.fatal:
            fatal = str(e)
        else:
            transient = str(e)
    except Exception as e:  # never leave the lease held on a bug
        log.exception("[email] tick failed for %s", cid)
        transient = f"{e.__class__.__name__}: {e}"
    finally:
        cid0 = c["_id"]
        c = await store.get_campaign(db, cid0)
        # Deleted while we were sending (cancel + delete): nothing to settle. No `return` in this
        # finally, so a cancellation (worker shutdown) still propagates.
        deleted = c is None
        if not deleted:
            if fatal:
                c = await store.update_campaign(db, c["_id"], {"status": "paused", "last_error": fatal}, only_if=("sending",)) or c
            elif transient and c.get("status") == "sending":
                n_err = int(c.get("transient_errors") or 0) + 1
                patch: dict[str, Any] = {"transient_errors": n_err, "last_error": transient}
                if n_err >= MAX_TRANSIENT:
                    patch.update(status="paused", last_error=f"Paused after {n_err} failed attempts in a row: {transient}")
                c = await store.update_campaign(db, c["_id"], patch, only_if=("sending",)) or c
            counts = await store.refresh_counts(db, c["_id"])
            if not fatal and not transient and c.get("status") == "sending":
                if counts["queued"] == 0 and counts["sending"] - counts["stuck"] <= 0:
                    c = await store.update_campaign(
                        db, c["_id"], {"status": "sent", "finished_at": store.now(), "last_error": None}, only_if=("sending",)
                    ) or c
            await store.release_lease(db, c["_id"], owner)
    if deleted:
        return _result(None, done=True, sent_now=sent_now, failed_now=failed_now, skipped_now=skipped_now)
    done = c.get("status") != "sending"
    return _result(c, counts, sent_now=sent_now, failed_now=failed_now, skipped_now=skipped_now,
                   done=done, error=fatal or transient)


# ── Test send ──────────────────────────────────────────────────────────────────

async def send_test(db: AsyncIOMotorDatabase, content: dict[str, Any], to: str, as_email: str | None) -> dict[str, Any]:
    sender = await senders.resolve(db, content.get("sender_id"))
    if transport.mode() == "resend" and sender["check"]["level"] == "bad":
        raise EngineError(400, f"Sender can't send: {sender['check']['message']}")
    as_ = (as_email or to).strip().lower()
    vars_ = (await audience.merge_vars_for(db, [as_]))[as_]
    r = render.render_for(content, vars_, "test")
    msg = build_message(content, sender, to, r, campaign_id="test", message_id="test", subject_prefix="[test] ")
    t = transport.make(db)
    outcomes = await t.send_batch([msg], f"md-test-{secrets.token_hex(8)}")
    o = outcomes[0]
    if o.error:
        raise EngineError(502, f"Test not sent: {o.error}")
    return {
        "mode": transport.mode(), "to": to, "as": as_, "from": msg["from"], "subject": msg["subject"],
        "provider_id": o.provider_id, "bytes": len(msg["html"].encode()) + len(msg["text"].encode()),
    }


# ── Worker ─────────────────────────────────────────────────────────────────────

_stopping = asyncio.Event()
_kick: asyncio.Event | None = None
_task: asyncio.Task[None] | None = None


def kick() -> None:
    if _kick is not None:
        _kick.set()


async def promote_scheduled(db: AsyncIOMotorDatabase) -> int:
    t = store.now()
    res = await db["email_campaigns"].update_many(
        {"status": "scheduled", "scheduled_at": {"$lte": t}},
        {"$set": {"status": "sending", "updated_at": t}},
    )
    return res.modified_count


async def run_once(db: AsyncIOMotorDatabase) -> dict[str, Any]:
    """One worker pass: promote due schedules, tick every sending campaign."""
    promoted = await promote_scheduled(db)
    ran = []
    cursor = db["email_campaigns"].find({"status": "sending"}, {"_id": 1}).sort("queued_at", 1)
    for c in await cursor.to_list(length=20):
        if _stopping.is_set():
            break
        r = await tick(db, c["_id"])
        ran.append({"id": str(c["_id"]), "sent": r["sent_now"], "busy": r["busy"], "error": r["error"]})
    return {"promoted": promoted, "ran": ran}


async def _loop(get_db) -> None:
    global _kick
    _kick = asyncio.Event()
    backoff = 2.0
    log.info("[email] campaign worker %s started (%s transport)", WORKER_ID, transport.mode())
    while not _stopping.is_set():
        wait = 5.0
        try:
            r = await run_once(get_db())
            busy = any(x["sent"] for x in r["ran"])
            errored = any(x["error"] for x in r["ran"])
            if errored:
                backoff = min(backoff * 2, 60.0)
                wait = backoff
            else:
                backoff = 2.0
                wait = 0.5 if busy else (2.0 if r["ran"] else 5.0)
        except Exception:
            log.exception("[email] worker pass failed")
            wait = 10.0
        try:
            await asyncio.wait_for(_kick.wait(), timeout=wait)
        except asyncio.TimeoutError:
            pass
        _kick.clear()


def start(get_db) -> None:
    global _task
    if not settings.email_worker_enabled or _task is not None:
        return
    _stopping.clear()
    _task = asyncio.create_task(_loop(get_db), name="email-campaign-worker")


async def stop(timeout: float = 15.0) -> None:
    """Let the current batch finish (bounded), then stop. A batch cut off
    mid-request is finished by the next start (see ``recover``)."""
    global _task
    if _task is None:
        return
    _stopping.set()
    kick()
    try:
        await asyncio.wait_for(asyncio.shield(_task), timeout=timeout)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        _task.cancel()
    except Exception:
        pass
    _task = None


def worker_running() -> bool:
    return _task is not None and not _task.done()


def now_utc() -> datetime:
    return datetime.now(timezone.utc)
