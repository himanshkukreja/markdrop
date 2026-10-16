"""Admin API for email campaigns (admin → Email). All routes need the admin JWT.

    GET    /api/v1/admin/email/info                     setup, senders, campaigns (incl. legacy)
    GET    /api/v1/admin/email/templates                templates + merge tags + block catalogue
    POST   /api/v1/admin/email/render                   render a draft as a recipient (preview)
    POST   /api/v1/admin/email/test                     send a "[test]" copy
    POST   /api/v1/admin/email/audience                 live audience count + preset counts
    GET    /api/v1/admin/email/recipients?q=            "preview as" search
    GET|POST /api/v1/admin/email/senders, PATCH|DELETE /senders/{id}
    GET|POST /api/v1/admin/email/suppressions, DELETE /suppressions/{email}
    POST   /api/v1/admin/email/campaigns                create a draft
    GET|PATCH|DELETE /api/v1/admin/email/campaigns/{id}
    POST   /api/v1/admin/email/campaigns/{id}/duplicate
    POST   /api/v1/admin/email/campaigns/{id}/queue     {confirm: "send to N", scheduled_at?}
    POST   /api/v1/admin/email/campaigns/{id}/action    {action: pause|resume|cancel|unschedule|send_now|retry}
    POST   /api/v1/admin/email/campaigns/{id}/tick      one bounded round in-request
    GET    /api/v1/admin/email/campaigns/{id}/progress
    GET    /api/v1/admin/email/campaigns/{id}/report
    GET    /api/v1/admin/email/campaigns/{id}/recipients?filter=&q=&offset=&limit=&format=csv

The old ``/api/v1/admin/campaigns*`` endpoints in ``admin.py`` stay until the
frontend that uses them is gone (backend deploys first).
"""

from __future__ import annotations

import csv
import io
import re
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from bson import ObjectId
from fastapi import APIRouter, Depends, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, Response
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.database import get_database
from app.routers.admin import require_admin
from app.services.email_campaigns import (
    audience, engine, links, render, senders, store, tags, templates, transport,
)

settings = get_settings()
router = APIRouter(prefix="/api/v1/admin/email", tags=["admin-email"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def err(status: int, message: str, **extra: Any) -> JSONResponse:
    return JSONResponse({"detail": message, **extra}, status_code=status, headers={"Cache-Control": "no-store"})


def ok(body: Any) -> JSONResponse:
    return JSONResponse(jsonable_encoder(body, custom_encoder={ObjectId: str}), headers={"Cache-Control": "no-store"})


async def body_of(request: Request) -> dict[str, Any]:
    try:
        b = await request.json()
    except Exception:
        return {}
    return b if isinstance(b, dict) else {}


def engine_error(e: engine.EngineError) -> JSONResponse:
    return err(e.status, str(e), **e.extra)


def _content(b: dict[str, Any]) -> dict[str, Any] | JSONResponse:
    try:
        return render.parse_content(b)
    except render.ContentError as e:
        return err(400, str(e))


# ── Setup ──────────────────────────────────────────────────────────────────────

def _setup(admin: dict[str, Any], info: dict[str, Any]) -> dict[str, Any]:
    return {
        "transport": transport.mode(),
        "tracking_base": links.api_base(),
        "site": links.site_base(),
        "batch": {"size": engine.batch_size(), "gap_ms": int(engine.round_gap() * 1000)},
        "worker": {"enabled": settings.email_worker_enabled, "running": engine.worker_running()},
        "webhooks": bool(settings.resend_webhook_secret),
        "webhook_url": f"{links.api_base()}/api/v1/email/webhooks/resend",
        "test_to": settings.email_reply_to,
        "admin": admin.get("sub"),
        "domains": {k: info.get(k) for k in ("state", "message", "checked_at")} | {"names": info.get("domains") or {}},
        "click_hosts": list(settings.email_click_hosts),
    }


async def _all_campaigns(db: AsyncIOMotorDatabase) -> list[dict[str, Any]]:
    rows = await db["email_campaigns"].find({}, {"doc": 0}).sort("updated_at", -1).to_list(length=200)
    counts = await store.counts_many(db, [r["_id"] for r in rows]) if rows else {}
    out = [engine.summary(r, counts.get(r["_id"], store.empty_counts())) for r in rows]
    legacy = await db["campaigns"].find({}, {"html": 0}).sort("created_at", -1).to_list(length=100)
    return out + [engine.legacy_summary(r) for r in legacy]


@router.get("/info")
async def info(db: AsyncIOMotorDatabase = Depends(get_db), admin: dict = Depends(require_admin)):
    sl, dinfo = await senders.list_senders(db)
    return ok({"setup": _setup(admin, dinfo), "senders": sl, "campaigns": await _all_campaigns(db)})


@router.get("/templates")
async def list_templates(_: dict = Depends(require_admin)):
    return ok({
        "templates": templates.all_templates(),
        "tags": [{"tag": t.tag, "label": t.label, "hint": t.hint, "sample": t.sample, "url": t.url} for t in tags.MERGE_TAGS],
        "blocks": {"labels": render.BLOCK_LABELS, "fields": render.BLOCK_FIELDS},
        "default_footer": render.DEFAULT_FOOTER,
    })


# ── Preview, test, audience ────────────────────────────────────────────────────

async def _as(db: AsyncIOMotorDatabase, as_email: str | None) -> tuple[dict[str, str], dict[str, Any]]:
    e = (as_email or "").strip().lower()
    if not e:
        return dict(tags.SAMPLE_VARS), {"email": tags.SAMPLE_VARS["email"], "name": tags.SAMPLE_VARS["name"], "source": "sample"}
    b = await audience.base(db)
    p = b["people"].get(e)
    return audience.vars_for_person(e, p), {"email": e, "name": p["name"] if p else None, "source": "account" if p else "custom"}


@router.post("/render")
async def render_preview(request: Request, db: AsyncIOMotorDatabase = Depends(get_db), _: dict = Depends(require_admin)):
    b = await body_of(request)
    content = _content(b)
    if isinstance(content, JSONResponse):
        return content
    vars_, who = await _as(db, b.get("as_email"))
    r = render.render_for(content, vars_, "preview")
    vars_out = {**vars_, "unsubscribe_url": r["unsubscribe_url"]}
    return ok({**r, "vars": vars_out, "as": who, "problems": render.content_problems(content)})


@router.post("/test")
async def send_test(request: Request, db: AsyncIOMotorDatabase = Depends(get_db), _: dict = Depends(require_admin)):
    b = await body_of(request)
    content = _content(b)
    if isinstance(content, JSONResponse):
        return content
    problems = render.content_problems(content)
    if problems:
        return err(400, f"Fix {len(problems)} problem{'s' if len(problems) != 1 else ''} first.", problems=problems)
    to = (b.get("to") or "").strip().lower() or settings.email_reply_to
    if not senders.is_email(to):
        return err(400, "That test address isn't valid.")
    as_email = (b.get("as_email") or "").strip().lower() or None
    try:
        return ok({"ok": True, **await engine.send_test(db, content, to, as_email)})
    except engine.EngineError as e:
        return engine_error(e)
    except transport.SendError as e:
        return err(502, f"Test not sent: {e}")


@router.post("/audience")
async def audience_count(request: Request, db: AsyncIOMotorDatabase = Depends(get_db), _: dict = Depends(require_admin)):
    b = await body_of(request)
    spec = render.parse_audience(b.get("audience"))
    exclude: set[str] | None = None
    cid = store.oid(b.get("campaign_id"))
    if cid:
        exclude = await store.existing_emails(db, cid)
    res = await audience.resolve(db, spec, exclude)
    return ok({"count": res["count"], "presets": await audience.preset_counts(db, spec), "existing": len(exclude or ())})


@router.get("/recipients")
async def search_recipients(q: str = Query("", max_length=120), db: AsyncIOMotorDatabase = Depends(get_db),
                            _: dict = Depends(require_admin)):
    return ok({"recipients": await audience.search(db, q)})


# ── Senders and suppressions ───────────────────────────────────────────────────

@router.get("/senders")
async def list_senders(check: bool = False, db: AsyncIOMotorDatabase = Depends(get_db), _: dict = Depends(require_admin)):
    sl, dinfo = await senders.list_senders(db, force_check=check)
    return ok({"senders": sl, "domains": {k: dinfo.get(k) for k in ("state", "message", "checked_at")} | {"names": dinfo.get("domains") or {}}})


async def _save_sender(db: AsyncIOMotorDatabase, sid: str | None, request: Request) -> JSONResponse:
    if sid == senders.ENV_ID:
        return err(400, "The env sender is set with MARKDROP_EMAIL_CAMPAIGN_FROM and MARKDROP_EMAIL_FROM_NAME.")
    try:
        data = senders.parse(await body_of(request))
        saved = await senders.save(db, sid, data)
    except senders.SenderError as e:
        return err(400 if sid is None or "valid" in str(e) else 404, str(e))
    sl, _ = await senders.list_senders(db)
    return ok({"sender": next((s for s in sl if s["id"] == saved["id"]), saved), "senders": sl})


@router.post("/senders")
async def add_sender(request: Request, db: AsyncIOMotorDatabase = Depends(get_db), _: dict = Depends(require_admin)):
    return await _save_sender(db, None, request)


@router.patch("/senders/{sid}")
async def edit_sender(sid: str, request: Request, db: AsyncIOMotorDatabase = Depends(get_db), _: dict = Depends(require_admin)):
    return await _save_sender(db, sid, request)


@router.delete("/senders/{sid}")
async def remove_sender(sid: str, db: AsyncIOMotorDatabase = Depends(get_db), _: dict = Depends(require_admin)):
    if sid == senders.ENV_ID:
        return err(400, "The env sender can't be deleted.")
    if not await senders.delete(db, sid):
        return err(404, "Unknown sender.")
    return ok({"ok": True})


@router.get("/suppressions")
async def list_suppressions(q: str = Query("", max_length=120), db: AsyncIOMotorDatabase = Depends(get_db),
                            _: dict = Depends(require_admin)):
    query: dict[str, Any] = {}
    if q.strip():
        query["_id"] = {"$regex": re.escape(q.strip().lower())}
    rows = await db["email_suppressions"].find(query).sort("updated_at", -1).to_list(length=200)
    by_reason: dict[str, int] = {}
    async for r in db["email_suppressions"].aggregate([{"$group": {"_id": "$reason", "n": {"$sum": 1}}}]):
        by_reason[r["_id"] or "manual"] = r["n"]
    unsub_users = await db["users"].count_documents({"unsubscribed_at": {"$ne": None}})
    return ok({
        "rows": [{"email": r["_id"], "reason": r.get("reason"), "detail": r.get("detail"),
                  "created_at": store.iso(r.get("created_at")), "updated_at": store.iso(r.get("updated_at"))} for r in rows],
        "by_reason": by_reason,
        "unsubscribed_accounts": unsub_users,
    })


@router.post("/suppressions")
async def add_suppression(request: Request, db: AsyncIOMotorDatabase = Depends(get_db), _: dict = Depends(require_admin)):
    b = await body_of(request)
    emails, invalid = audience.parse_custom(str(b.get("emails") or ""))
    for e in emails:
        await store.suppress(db, e, "manual", str(b.get("detail") or "added by admin")[:200])
    audience.invalidate()
    return ok({"added": len(set(emails)), "invalid": invalid})


@router.delete("/suppressions/{email}")
async def remove_suppression(email: str, db: AsyncIOMotorDatabase = Depends(get_db), _: dict = Depends(require_admin)):
    """Lift a bounce or manual suppression. Unsubscribes are the person's own
    choice and can't be lifted from here."""
    e = email.strip().lower()
    row = await db["email_suppressions"].find_one({"_id": e})
    if not row:
        return err(404, "That address isn't suppressed.")
    if row.get("reason") in ("unsubscribed", "complained"):
        return err(409, "This person unsubscribed or reported spam; only they can opt back in.")
    await db["email_suppressions"].delete_one({"_id": e})
    audience.invalidate()
    return ok({"ok": True})


# ── Campaigns ──────────────────────────────────────────────────────────────────

_LEGACY = re.compile(r"^legacy-([0-9a-f]{24})$")


async def _events(db: AsyncIOMotorDatabase, cid: ObjectId, limit: int = 40) -> list[dict[str, Any]]:
    rows = await db["email_events"].find({"campaign_id": cid}).sort("ts", -1).limit(limit).to_list(length=limit)
    return [{"at": store.iso(r.get("ts")), "type": r.get("type"), "email": r.get("email"), "url": r.get("url")} for r in rows]


@router.post("/campaigns")
async def create_campaign(request: Request, db: AsyncIOMotorDatabase = Depends(get_db), admin: dict = Depends(require_admin)):
    content = _content(await body_of(request))
    if isinstance(content, JSONResponse):
        return content
    c = await engine.create(db, content, admin.get("sub"))
    return ok({"campaign": engine.full(c)})


@router.get("/campaigns/{cid}")
async def get_campaign(cid: str, db: AsyncIOMotorDatabase = Depends(get_db), _: dict = Depends(require_admin)):
    m = _LEGACY.match(cid)
    if m:
        r = await db["campaigns"].find_one({"_id": ObjectId(m.group(1))})
        if not r:
            return err(404, "Campaign not found.")
        return ok({"campaign": {**engine.legacy_summary(r), "legacy_html": r.get("html") or ""}, "events": []})
    c = await store.get_campaign(db, cid)
    if not c:
        return err(404, "Campaign not found.")
    counts = await store.refresh_counts(db, c["_id"])
    return ok({"campaign": engine.full(c, counts), "events": await _events(db, c["_id"])})


@router.patch("/campaigns/{cid}")
async def update_campaign(cid: str, request: Request, db: AsyncIOMotorDatabase = Depends(get_db), _: dict = Depends(require_admin)):
    content = _content(await body_of(request))
    if isinstance(content, JSONResponse):
        return content
    try:
        c = await engine.update_draft(db, cid, content)
    except engine.EngineError as e:
        return engine_error(e)
    return ok({"campaign": engine.full(c)})


@router.delete("/campaigns/{cid}")
async def delete_campaign(cid: str, db: AsyncIOMotorDatabase = Depends(get_db), _: dict = Depends(require_admin)):
    try:
        await engine.delete(db, cid)
    except engine.EngineError as e:
        return engine_error(e)
    return ok({"ok": True})


@router.post("/campaigns/{cid}/duplicate")
async def duplicate_campaign(cid: str, db: AsyncIOMotorDatabase = Depends(get_db), admin: dict = Depends(require_admin)):
    m = _LEGACY.match(cid)
    if m:
        r = await db["campaigns"].find_one({"_id": ObjectId(m.group(1))})
        if not r:
            return err(404, "Campaign not found.")
        html = re.sub(r"\{\{\s*name\s*\}\}", "{{first_name|there}}", r.get("html") or "")
        content = render.parse_content({
            "name": f"{(r.get('subject') or 'Campaign')[:110]} (copy)", "subject": r.get("subject") or "",
            "template": "legacy", "doc": {"layout": "raw", "html": html, "text": render.html_to_text(html), "source": "old emailer"},
            "audience": {"kind": "all"},
        })
        c = await engine.create(db, content, admin.get("sub"))
        return ok({"campaign": engine.full(c)})
    try:
        c = await engine.duplicate(db, cid, admin.get("sub"))
    except engine.EngineError as e:
        return engine_error(e)
    return ok({"campaign": engine.full(c)})


def _when(v: Any) -> datetime | None:
    if not v:
        return None
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


@router.post("/campaigns/{cid}/queue")
async def queue_campaign(cid: str, request: Request, db: AsyncIOMotorDatabase = Depends(get_db), admin: dict = Depends(require_admin)):
    b = await body_of(request)
    when = _when(b.get("scheduled_at"))
    if b.get("scheduled_at") and when is None:
        return err(400, "That date isn't valid.")
    try:
        return ok(await engine.queue(db, cid, str(b.get("confirm") or ""), admin.get("sub"), when))
    except engine.EngineError as e:
        return engine_error(e)


@router.post("/campaigns/{cid}/action")
async def campaign_action(cid: str, request: Request, db: AsyncIOMotorDatabase = Depends(get_db), _: dict = Depends(require_admin)):
    b = await body_of(request)
    try:
        return ok(await engine.control(db, cid, str(b.get("action") or ""),
                                       failed=b.get("failed") is not False, stuck=b.get("stuck") is True))
    except engine.EngineError as e:
        return engine_error(e)


@router.post("/campaigns/{cid}/tick")
async def campaign_tick(cid: str, db: AsyncIOMotorDatabase = Depends(get_db), _: dict = Depends(require_admin)):
    if not store.oid(cid):
        return err(404, "Campaign not found.")
    try:
        return ok(await engine.tick(db, cid, budget_s=10.0, owner=f"{engine.WORKER_ID}:admin"))
    except engine.EngineError as e:
        return engine_error(e)


@router.get("/campaigns/{cid}/progress")
async def campaign_progress(cid: str, db: AsyncIOMotorDatabase = Depends(get_db), _: dict = Depends(require_admin)):
    c = await store.get_campaign(db, cid)
    if not c:
        return err(404, "Campaign not found.")
    counts = await store.refresh_counts(db, c["_id"])
    lu = c.get("lock_until")
    held = bool(lu and (lu if lu.tzinfo else lu.replace(tzinfo=timezone.utc)) > store.now())
    return ok({"campaign": engine.summary(c, counts), "lease_held": held, "worker": engine.worker_running(),
               "transport": transport.mode()})


def _strip_tracking(u: str) -> str:
    try:
        p = urlsplit(u)
    except ValueError:
        return u
    q = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if not k.lower().startswith("utm_")]
    return urlunsplit((p.scheme, p.netloc, p.path, urlencode(q), p.fragment))


@router.get("/campaigns/{cid}/report")
async def campaign_report(cid: str, db: AsyncIOMotorDatabase = Depends(get_db), _: dict = Depends(require_admin)):
    c = await store.get_campaign(db, cid)
    if not c:
        return err(404, "Campaign not found.")
    counts = await store.refresh_counts(db, c["_id"])

    # Unique opens and clicks over time (first open / first click per person),
    # bucketed by 10 minutes for a fresh campaign, by hour up to three days,
    # then by day. Bucketed here rather than with $dateTrunc (MongoDB 5+ only).
    start = c.get("started_at") or c.get("queued_at") or c.get("created_at") or store.now()
    start = start if start.tzinfo else start.replace(tzinfo=timezone.utc)
    end = store.now()
    span = end - start
    if span <= timedelta(hours=6):
        unit, step = "minute", timedelta(minutes=10)
    elif span <= timedelta(hours=72):
        unit, step = "hour", timedelta(hours=1)
    else:
        unit, step = "day", timedelta(days=1)

    def floor(d: datetime) -> datetime:
        d = d if d.tzinfo else d.replace(tzinfo=timezone.utc)
        if unit == "minute":
            return d.replace(minute=d.minute - d.minute % 10, second=0, microsecond=0)
        if unit == "hour":
            return d.replace(minute=0, second=0, microsecond=0)
        return d.replace(hour=0, minute=0, second=0, microsecond=0)

    series: dict[datetime, dict[str, int]] = {}
    for field, key in (("first_open_at", "opens"), ("first_click_at", "clicks")):
        async for r in db["email_messages"].find({"campaign_id": c["_id"], field: {"$ne": None}}, {field: 1}):
            b = series.setdefault(floor(r[field]), {"opens": 0, "clicks": 0})
            b[key] += 1
    t = floor(start)
    points = []
    while t <= end and len(points) < 500:
        v = series.get(t, {"opens": 0, "clicks": 0})
        points.append({"t": t.isoformat().replace("+00:00", "Z"), "opens": v["opens"], "clicks": v["clicks"]})
        t += step

    # Per-link clicks (UTM parameters folded together).
    by_url: dict[str, dict[str, Any]] = {}
    async for r in db["email_events"].aggregate([
        {"$match": {"campaign_id": c["_id"], "type": "click", "url": {"$ne": None}}},
        {"$group": {"_id": "$url", "clicks": {"$sum": 1}, "people": {"$addToSet": "$message_id"}}},
    ]):
        u = _strip_tracking(r["_id"])
        row = by_url.setdefault(u, {"url": u, "clicks": 0, "people": set()})
        row["clicks"] += r["clicks"]
        row["people"].update(r["people"])
    link_rows = sorted(
        ({"url": v["url"], "clicks": v["clicks"], "people": len(v["people"])} for v in by_url.values()),
        key=lambda x: (-x["people"], -x["clicks"]),
    )[:50]
    return ok({
        "counts": counts, "timeline": {"unit": unit, "points": points}, "links": link_rows,
        "events": await _events(db, c["_id"]), "webhooks": bool(settings.resend_webhook_secret),
        "transport": transport.mode(),
    })


_CSV_HEAD = ["email", "name", "status", "sent_at", "delivered_at", "opens", "first_open_at", "last_open_at",
             "clicks", "first_click_at", "last_click_at", "unsubscribed_at", "bounced_at", "error"]


def _cell(v: Any) -> str:
    s = "" if v is None else str(v)
    return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") else s


@router.get("/campaigns/{cid}/recipients")
async def campaign_recipients(
    cid: str,
    filter: str = Query("all"),
    q: str = Query("", max_length=120),
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    format: str = Query("json"),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _: dict = Depends(require_admin),
):
    c = await store.get_campaign(db, cid)
    if not c:
        return err(404, "Campaign not found.")
    flt = filter if filter in store.FILTERS else "all"
    query = store.message_query(c["_id"], flt, q)
    if format == "csv":
        buf = io.StringIO()
        w = csv.writer(buf, quoting=csv.QUOTE_ALL)
        w.writerow(_CSV_HEAD)
        async for m in db["email_messages"].find(query, {"vars": 0}).sort("_id", 1).limit(200_000):
            r = store.message_row(m)
            w.writerow([_cell(x) for x in (
                r["email"], r["name"], r["display_status"], r["sent_at"], r["delivered_at"], r["open_count"],
                r["first_open_at"], r["last_open_at"], r["click_count"], r["first_click_at"], r["last_click_at"],
                r["unsubscribed_at"], r["bounced_at"], r["error"],
            )])
        slug = render.utm_slug(c.get("name") or "campaign")
        return Response(buf.getvalue(), media_type="text/csv; charset=utf-8", headers={
            "Content-Disposition": f'attachment; filename="{slug}-{flt}.csv"', "Cache-Control": "no-store"})
    total = await db["email_messages"].count_documents(query)
    rows = await db["email_messages"].find(query, {"vars": 0}).sort("_id", 1).skip(offset).limit(limit).to_list(length=limit)
    return ok({"rows": [store.message_row(m) for m in rows], "total": total, "offset": offset, "limit": limit})
