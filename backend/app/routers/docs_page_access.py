"""Private pages and sections: the readers' sign-in and the studio's controls.

Readers (/api/v1/docs-access, posted to by the docs edge's lock page, docs-platform/edge/readers.mjs;
each answers with a 303 back to the guide):

- ``POST /page-password?site=``   a page rule's password → a reader grant for that rule
- ``POST /email-link?site=``      "Email me a sign-in link": sent only when the address may open
                                  something (a people rule lists it or its domain, or it's a team
                                  member's); the answer is the same either way
- ``GET|POST /email-link/{token}`` the link: a confirmation page (mail scanners only GET), then
                                  the single-use POST → a reader grant (not tied to a browser)
- ``POST /request?site=``         "Request access": stored, the guide's admins get an email
- ``POST /reader-grant``          (signed in) markdrop.in's /auth/docs-access?mode=reader

Studio (/api/v1/docs-sites/{site_id}/private): rules (admins), group access (editors), the
access-requests inbox, the audit log, "Sign out every reader", and preview-as (who can open what).
Free on every guide. App-internal: kept out of the public OpenAPI schema.
"""

import html
import logging
from datetime import datetime, timezone
from typing import Any, Literal

import bcrypt
from fastapi import APIRouter, Depends, Form, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse
from limits import parse
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.config import get_settings
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.routers.docs_access import PER_IP, PER_SITE, SITE_FAILURES, _hit, _redirect, _room, _site, get_db
from app.services import docs_page_access as pa
from app.services import docs_site_access as access
from app.services import docs_site_store as store
from app.services.docs_site_store import PAGES, SITES
from app.utils.net import get_client_ip

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/docs-access", tags=["docs-access"])
studio = APIRouter(prefix="/api/v1/docs-sites", tags=["docs-sites"])

LINK_PER_IP = parse("10/15 minutes")
LINK_PER_EMAIL = parse("5/hour")
LINK_PER_SITE = parse("300/hour")
REQ_PER_IP = parse("5/hour")
REQ_PER_SITE = parse("100/day")
_NO_STORE = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"}


def _html(status: int, title: str, body: str) -> HTMLResponse:
    page = (f"<!doctype html><html lang=en><meta charset=utf-8><meta name=robots content=noindex>"
            f"<meta name=viewport content='width=device-width,initial-scale=1'><title>{html.escape(title)}</title>"
            "<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:flex;"
            "align-items:center;justify-content:center;padding:24px 16px;background:#f8fafc;color:#0f172a}"
            "@media (prefers-color-scheme:dark){body{background:#0b1120;color:#e2e8f0}main{background:#0f172a!important;border-color:#1e293b!important}}"
            "main{max-width:400px;width:100%;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px 26px}"
            "h1{font-size:20px;margin:0 0 8px}p{color:#64748b;font-size:14px;margin:0 0 18px}"
            "button,a.btn{display:block;width:100%;padding:11px 14px;border:0;border-radius:9px;background:#2563eb;color:#fff;"
            "font:inherit;font-weight:600;cursor:pointer;text-align:center;text-decoration:none}</style>"
            f"<main><h1>{html.escape(title)}</h1>{body}</main></html>")
    return HTMLResponse(page, status_code=status, headers=_NO_STORE)


async def _reader_site(db: AsyncIOMotorDatabase, site: str, host: str) -> tuple[dict | None, str | None, HTMLResponse | None]:
    row = await _site(db, site)
    h = access.clean_host(host)
    if row is None or h is None:
        return None, None, _html(404, "Guide not found", "<p>This form doesn't lead to a guide. Open the guide again.</p>")
    if h not in access.site_hosts(row):
        return None, None, _html(400, "Wrong address", "<p>This form doesn't belong to that guide. Open the guide again.</p>")
    return row, h, None


# ── readers ──────────────────────────────────────────────────────────────────


@router.post("/page-password", include_in_schema=False)
async def page_password(request: Request, site: str = Query(..., max_length=64), host: str = Form("", max_length=300),
                        next: str = Form("/", max_length=2000), sh: str = Form("", max_length=100),
                        rule: str = Form("", max_length=40), password: str = Form("", max_length=1000),
                        db: AsyncIOMotorDatabase = Depends(get_db)):
    row, h, err = await _reader_site(db, site, host)
    if err:
        return err
    nxt = access.safe_next(next)
    ip = get_client_ip(request)
    sid = str(row["_id"])
    if not _room(SITE_FAILURES, "page-failures", sid):
        return _redirect(pa.lock_url(h, rule, nxt, "rate"))
    if not _hit(PER_SITE, ip, sid, "page") or not _hit(PER_IP, ip):
        return _redirect(pa.lock_url(h, rule, nxt, "rate"))
    if not access.secret():
        return _redirect(pa.lock_url(h, rule, nxt, "unavailable"))
    r = pa.rule(row, rule)
    if row.get("status") != "live" or r is None or r["kind"] != "password":
        return _redirect(pa.lock_url(h, rule, nxt, "changed"))
    if not access.valid_state_hash(sh):
        return _redirect(pa.lock_url(h, rule, nxt, "cookies"))
    ok = False
    pw_hash = r.get("password_hash") or ""
    if password and len(password) <= 200 and pw_hash:
        try:
            ok = await run_in_threadpool(bcrypt.checkpw, password.encode(), pw_hash.encode())
        except ValueError:
            ok = False
    if not ok:
        _hit(SITE_FAILURES, "page-failures", sid)
        return _redirect(pa.lock_url(h, rule, nxt, "wrong"))
    await store.log_event(db, "docs_page_access_granted", row, None, via="password")
    grant = pa.mint_reader_grant(row, h, sh=sh, pw=[[r["id"], int(r.get("pv") or 0)]], via="password")
    return _redirect(pa.reader_callback(h, grant, nxt))


@router.post("/email-link", include_in_schema=False)
async def email_link(request: Request, site: str = Query(..., max_length=64), host: str = Form("", max_length=300),
                     next: str = Form("/", max_length=2000), rule: str = Form("", max_length=40),
                     email: str = Form("", max_length=320), sh: str = Form("", max_length=100),
                     db: AsyncIOMotorDatabase = Depends(get_db)):
    row, h, err = await _reader_site(db, site, host)
    if err:
        return err
    nxt = access.safe_next(next)
    addr = pa.clean_email(email)
    if addr is None:
        return _redirect(pa.lock_url(h, rule, nxt, "email"))
    ip = get_client_ip(request)
    sid = str(row["_id"])
    if not _hit(LINK_PER_IP, ip, "link") or not _hit(LINK_PER_EMAIL, addr, "link") or not _hit(LINK_PER_SITE, sid, "link"):
        return _redirect(pa.lock_url(h, rule, nxt, "rate"))
    if not access.secret() or row.get("status") != "live":
        return _redirect(pa.lock_url(h, rule, nxt, "unavailable"))
    # The same answer whether or not the address may sign in: nobody learns who is on a list.
    if await pa.may_sign_in(db, row, addr):
        token = await pa.create_link(db, row, email=addr, host=h, next_path=nxt, rule_id=rule or None)
        url = f"{get_settings().api_base_url.rstrip('/')}/api/v1/docs-access/email-link/{token}"
        try:
            await pa.send_link_email(to=addr, guide=row.get("name") or "the guide", url=url)
        except Exception:
            log.warning("docs site %s: couldn't send a reader sign-in link", sid, exc_info=True)
        await store.log_event(db, "docs_page_link_sent", row, None)
    return _redirect(pa.lock_url(h, rule, nxt, "sent"))


@router.get("/email-link/{token}", include_in_schema=False)
async def email_link_open(token: str, db: AsyncIOMotorDatabase = Depends(get_db)):
    """The link in the email: a page with one button (a mail scanner's GET uses nothing up)."""
    row = await pa.peek_link(db, token)
    if row is None:
        return _html(410, "This link has expired", "<p>Sign-in links work once, for 15 minutes. Open the page again and ask for a new one.</p>")
    site = await db[SITES].find_one({"_id": row["site_id"], "deleted_at": None}, {"name": 1})
    name = html.escape((site or {}).get("name") or "the guide")
    return _html(200, f"Sign in to {(site or {}).get('name') or 'the guide'}",
                 f"<p>You're signing in as <strong>{html.escape(row['email'])}</strong>.</p>"
                 f"<form method=post><button type=submit>Continue to {name}</button></form>")


@router.post("/email-link/{token}", include_in_schema=False)
async def email_link_use(token: str, db: AsyncIOMotorDatabase = Depends(get_db)):
    row = await pa.use_link(db, token)
    if row is None:
        return _html(410, "This link has expired", "<p>Sign-in links work once, for 15 minutes. Open the page again and ask for a new one.</p>")
    site = await db[SITES].find_one({"_id": row["site_id"], "deleted_at": None})
    if site is None or not access.secret() or row["host"] not in access.site_hosts(site):
        return _html(404, "Guide not found", "<p>This guide isn't available any more.</p>")
    member = await pa.is_member_email(db, site, row["email"])
    grant = pa.mint_reader_grant(site, row["host"], email=row["email"], member=member, via="email")
    await store.log_event(db, "docs_page_access_granted", site, None, via="email")
    return _redirect(pa.reader_callback(row["host"], grant, row.get("next") or "/"))


@router.post("/request", include_in_schema=False)
async def request_access(request: Request, site: str = Query(..., max_length=64), host: str = Form("", max_length=300),
                         next: str = Form("/", max_length=2000), rule: str = Form("", max_length=40),
                         email: str = Form("", max_length=320), note: str = Form("", max_length=2000),
                         sh: str = Form("", max_length=100), db: AsyncIOMotorDatabase = Depends(get_db)):
    row, h, err = await _reader_site(db, site, host)
    if err:
        return err
    nxt = access.safe_next(next)
    addr = pa.clean_email(email)
    if addr is None:
        return _redirect(pa.lock_url(h, rule, nxt, "email"))
    ip = get_client_ip(request)
    sid = str(row["_id"])
    if not _hit(REQ_PER_IP, ip, "request") or not _hit(REQ_PER_SITE, sid, "request"):
        return _redirect(pa.lock_url(h, rule, nxt, "rate"))
    r = pa.rule(row, rule) or pa.rule(row, pa.MEMBERS)
    t = datetime.now(timezone.utc)
    clean_note = " ".join(str(note or "").split())[:500]
    existing = await db[pa.REQUESTS].find_one_and_update(
        {"site_id": row["_id"], "email": addr, "rule": r["id"], "status": "pending"},
        {"$set": {"note": clean_note, "path": nxt, "updated_at": t}})
    if existing is None:
        await db[pa.REQUESTS].insert_one({"site_id": row["_id"], "email": addr, "rule": r["id"], "note": clean_note,
                                         "path": nxt, "status": "pending", "created_at": t, "updated_at": t})
        await _notify_admins(db, row, addr, r, clean_note)
    await store.log_event(db, "docs_page_access_requested", row, None)
    return _redirect(pa.lock_url(h, rule, nxt, "requested"))


async def _notify_admins(db: AsyncIOMotorDatabase, site: dict, email: str, r: dict, note: str) -> None:
    from app.services import docs_studio_roles

    try:
        people = await docs_studio_roles.site_members(db, site)
        to = [p["email"] for p in people if p.get("email") and p.get("effective_role") in ("admin", "owner")]
        if not to:
            return
        url = get_settings().studio_link(f"/{site['_id']}/settings/private#requests")
        await pa.send_request_email(to=to, guide=site.get("name") or "your guide", email=email, rule_name=r.get("name") or r["id"],
                                    note=note, url=url)
    except Exception:
        log.warning("docs site %s: couldn't email admins about an access request", site.get("_id"), exc_info=True)


class ReaderGrantBody(BaseModel):
    site_id: str = Field(..., max_length=64)
    host: str = Field(..., max_length=300)
    next: str = Field("/", max_length=2000)
    sh: str = Field(..., max_length=100)


@router.post("/reader-grant", include_in_schema=False)
@limiter.limit("30/minute")
async def reader_grant(request: Request, body: ReaderGrantBody, db: AsyncIOMotorDatabase = Depends(get_db),
                       user: User = Depends(require_user)):
    """markdrop.in's /auth/docs-access?mode=reader: the signed-in reader's email and whether they are on
    the guide's team (team members open every private page)."""
    row = await _site(db, body.site_id)
    h = access.clean_host(body.host)
    if row is None or h is None:
        raise HTTPException(status_code=404, detail="Guide not found")
    if h not in access.site_hosts(row):
        raise HTTPException(status_code=400, detail="That address isn't this guide's.")
    if row.get("status") != "live":
        raise HTTPException(status_code=409, detail="This guide isn't live. Open it again.")
    if not access.valid_state_hash(body.sh):
        raise HTTPException(status_code=400, detail="Open the guide again and choose Sign in.")
    if not access.secret():
        raise HTTPException(status_code=503, detail="Signing in to guides isn't available right now.")
    member = store.role_at_least(await store.site_role(db, row, user.id), "viewer")
    email = pa.clean_email(user.email)
    grant = pa.mint_reader_grant(row, h, sh=body.sh, email=email, member=member, via="account")
    await store.log_event(db, "docs_page_access_granted", row, user.id, via="account")
    return {"url": pa.reader_callback(h, grant, body.next), "site_name": row.get("name") or "the guide", "member": member}


# ── studio ───────────────────────────────────────────────────────────────────


async def _drafts(db: AsyncIOMotorDatabase, site: dict) -> tuple[list[dict], dict[str, str]]:
    rows = await db[PAGES].find({"site_id": site["_id"], "deleted_at": None},
                                {"path": 1, "title": 1, "draft.markdown": 1, "draft.frontmatter_extra": 1, "hidden": 1}).to_list(length=5000)
    pages = [{"page_id": str(r["_id"]), "path": r.get("path"), "title": r.get("title") or "Untitled",
              "markdown": (r.get("draft") or {}).get("markdown") or "",
              "frontmatter_extra": (r.get("draft") or {}).get("frontmatter_extra") or {}} for r in rows]
    nav_groups: dict[str, str] = {}
    for g in (site.get("settings") or {}).get("nav") or []:
        for pid in g.get("pages") or []:
            nav_groups.setdefault(str(pid), str(g.get("group") or ""))
    return pages, nav_groups


def _usage(rows: list[dict]) -> dict[str, int]:
    used: dict[str, int] = {}
    for r in rows:
        for rid in {r["rule"], *[s["rule"] for s in r["sections"]]} - {None}:
            used[rid] = used.get(rid, 0) + 1
    return used


async def _view(db: AsyncIOMotorDatabase, site: dict, role: str) -> dict:
    admin = store.is_admin(role)
    pages, nav_groups = await _drafts(db, site)
    rows = pa.preview(site, pages, nav_groups, {"as": "public"})
    used = _usage(rows)
    out: dict[str, Any] = {
        "rules": [pa.rule_view(r, admin=admin, used=used.get(r["id"], 0)) for r in pa.rules(site)],
        "groups": pa.groups(site),
        "enforced": pa.enforced(site),
        "version": pa.version_of(site),
        "protected_pages": sum(1 for r in rows if r["rule"]),
        "private_sections": sum(len(r["sections"]) for r in rows),
        "warnings": pa.link_warnings(rows, pages),
        "unknown_rules": sorted({r["rule"] for r in rows if r["unknown_rule"]} | {s["rule"] for r in rows for s in r["sections"] if s["unknown_rule"]}),
        "is_admin": admin,
    }
    pending = await db[pa.REQUESTS].count_documents({"site_id": site["_id"], "status": "pending"})
    out["requests_pending"] = pending
    if admin:
        reqs = await db[pa.REQUESTS].find({"site_id": site["_id"]}).sort("created_at", -1).to_list(length=100)
        out["requests"] = [{"id": str(q["_id"]), "email": q["email"], "rule": q.get("rule"), "note": q.get("note") or "",
                            "path": q.get("path") or "/", "status": q.get("status"), "created_at": store.aware(q.get("created_at")),
                            "decided_at": store.aware(q.get("decided_at"))} for q in reqs]
    return out


@studio.get("/{site_id}/private", include_in_schema=False)
async def private_view(site_id: str, db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, role = await store.load_site(db, site_id, user, need="editor")
    return await _view(db, site, role)


class RuleBody(BaseModel):
    kind: Literal["people", "password"] | None = None
    name: str | None = Field(None, max_length=60)
    nav: Literal["show", "hide"] | None = None
    emails: list[str] | None = Field(None, max_length=pa.MAX_EMAILS)
    domains: list[str] | None = Field(None, max_length=pa.MAX_DOMAINS)
    password: str | None = Field(None, max_length=200)


async def _hash_pw(password: str) -> str:
    if len(password) < 6:
        raise HTTPException(status_code=422, detail="Use a password of at least 6 characters.")
    return (await run_in_threadpool(bcrypt.hashpw, password.encode(), bcrypt.gensalt(rounds=10))).decode()


@studio.post("/{site_id}/private/rules", include_in_schema=False)
@limiter.limit("30/minute")
async def create_rule(request: Request, site_id: str, body: RuleBody, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    site, role = await store.load_site(db, site_id, user, need="admin")
    if body.kind not in ("people", "password"):
        raise HTTPException(status_code=422, detail="Choose who the rule is for: specific people or a password.")
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="Give the rule a name readers will see, like Northwind or Partners.")
    if len(pa.rules(site)) > pa.MAX_RULES:
        raise HTTPException(status_code=409, detail=f"A guide can have at most {pa.MAX_RULES} rules.")
    r: dict[str, Any] = {"id": pa.new_rule_id(site, name), "kind": body.kind, "name": name,
                         "nav": body.nav or ("show" if body.kind == "people" else "hide"), "created_at": pa.now(), "created_by": user.id}
    if body.kind == "people":
        try:
            r["emails"], r["domains"] = pa.check_lists(body.emails, body.domains)
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e)) from None
    else:
        if not body.password:
            raise HTTPException(status_code=422, detail="Set the password readers will type.")
        r["password_hash"] = await _hash_pw(body.password)
        r["pv"] = 1
    stored = [x for x in (pa.state(site).get("rules") or [])]
    row = await pa.bump(db, site["_id"], {"page_access.rules": stored + [r]})
    await pa.audit(db, site, user.id, "rule_created", rule_id=r["id"], kind=r["kind"], name=name,
                   emails=len(r.get("emails") or []), domains=len(r.get("domains") or []))
    return {"rule": pa.rule_view(r, admin=True), "private": await _view(db, row or site, role)}


@studio.patch("/{site_id}/private/rules/{rule_id}", include_in_schema=False)
@limiter.limit("60/minute")
async def update_rule(request: Request, site_id: str, rule_id: str, body: RuleBody, db: AsyncIOMotorDatabase = Depends(get_db),
                      user: User = Depends(require_user)):
    site, role = await store.load_site(db, site_id, user, need="admin")
    stored = list(pa.state(site).get("rules") or [])
    cur = pa.rule(site, rule_id)
    if cur is None:
        raise HTTPException(status_code=404, detail="That rule isn't on this guide any more.")
    new = dict(next((x for x in stored if x.get("id") == rule_id), None) or cur)
    changes: dict[str, Any] = {}
    if body.name is not None:
        if not body.name.strip():
            raise HTTPException(status_code=422, detail="A rule needs a name.")
        new["name"] = body.name.strip()
        changes["name"] = new["name"]
    if body.nav is not None:
        new["nav"] = body.nav
        changes["nav"] = body.nav
    if cur["kind"] == "people" and (body.emails is not None or body.domains is not None):
        try:
            es, ds = pa.check_lists(body.emails if body.emails is not None else cur.get("emails"),
                                    body.domains if body.domains is not None else cur.get("domains"))
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e)) from None
        before_e, before_d = set(cur.get("emails") or []), set(cur.get("domains") or [])
        new["emails"], new["domains"] = es, ds
        changes.update({"added": sorted((set(es) - before_e) | (set(ds) - before_d)),
                        "removed": sorted((before_e - set(es)) | (before_d - set(ds)))})
    if cur["kind"] == "password" and body.password:
        new["password_hash"] = await _hash_pw(body.password)
        new["pv"] = int(cur.get("pv") or 0) + 1
        changes["password"] = "changed"
    if not changes:
        return {"rule": pa.rule_view(cur, admin=True), "private": await _view(db, site, role)}
    new["updated_at"] = pa.now()
    rest = [x for x in stored if x.get("id") != rule_id]
    row = await pa.bump(db, site["_id"], {"page_access.rules": rest + [new] if rule_id != pa.MEMBERS else [new] + rest})
    await pa.audit(db, site, user.id, "rule_updated", rule_id=rule_id, **changes)
    return {"rule": pa.rule_view(new, admin=True), "private": await _view(db, row or site, role)}


@studio.delete("/{site_id}/private/rules/{rule_id}", include_in_schema=False)
async def delete_rule(site_id: str, rule_id: str, db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, role = await store.load_site(db, site_id, user, need="admin")
    if rule_id == pa.MEMBERS:
        raise HTTPException(status_code=409, detail="The team rule is built in.")
    if pa.rule(site, rule_id) is None:
        raise HTTPException(status_code=404, detail="That rule isn't on this guide any more.")
    pages, nav_groups = await _drafts(db, site)
    rows = pa.preview(site, pages, nav_groups, {"as": "public"})
    using = [r["path"] for r in rows if r["rule"] == rule_id or any(s["rule"] == rule_id for s in r["sections"])]
    groups_using = [g for g, v in pa.groups(site).items() if v == rule_id]
    if using or groups_using:
        raise HTTPException(status_code=409, detail={"message": "Pages still use this rule. Change them first, then publish.",
                                                     "pages": using[:20], "groups": groups_using})
    rest = [x for x in pa.state(site).get("rules") or [] if x.get("id") != rule_id]
    row = await pa.bump(db, site["_id"], {"page_access.rules": rest})
    await pa.audit(db, site, user.id, "rule_deleted", rule_id=rule_id)
    return {"private": await _view(db, row or site, role)}


class GroupsBody(BaseModel):
    groups: dict[str, str | None] = Field(..., max_length=200)


@studio.put("/{site_id}/private/groups", include_in_schema=False)
async def put_groups(site_id: str, body: GroupsBody, db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """Each nav group's rule (every page in it, unless the page sets its own). Applies at the next publish."""
    site, role = await store.load_site(db, site_id, user, need="editor")
    known = {r["id"] for r in pa.rules(site)}
    cur = pa.groups(site)
    for g, v in body.groups.items():
        if v in (None, "", "inherit"):
            cur.pop(g, None)
        elif v == "public" or v in known:
            cur[g[:80]] = v
        else:
            raise HTTPException(status_code=422, detail=f"No rule {v} on this guide.")
    await db[SITES].update_one({"_id": site["_id"]}, {"$set": {"page_access.groups": cur, "updated_at": pa.now()}})
    await pa.audit(db, site, user.id, "groups_updated", groups=cur)
    site["page_access"] = {**pa.state(site), "groups": cur}
    return {"private": await _view(db, site, role)}


class DecideBody(BaseModel):
    rule: str | None = Field(None, max_length=40)


@studio.post("/{site_id}/private/requests/{request_id}/{decision}", include_in_schema=False)
async def decide(site_id: str, request_id: str, decision: Literal["approve", "decline"], body: DecideBody | None = None,
                 db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, role = await store.load_site(db, site_id, user, need="admin")
    q = await db[pa.REQUESTS].find_one({"_id": store.oid(request_id, "Request"), "site_id": site["_id"]})
    if q is None:
        raise HTTPException(status_code=404, detail="Request not found")
    if q.get("status") != "pending":
        raise HTTPException(status_code=409, detail="Someone already answered this request.")
    note = None
    row = site
    if decision == "approve":
        target = pa.rule(site, (body.rule if body else None) or q.get("rule") or "")
        if target is None:
            raise HTTPException(status_code=422, detail="Choose the rule to add them to.")
        if target["kind"] == "people":
            stored = list(pa.state(site).get("rules") or [])
            for x in stored:
                if x.get("id") == target["id"] and q["email"] not in (x.get("emails") or []):
                    x["emails"] = list(x.get("emails") or []) + [q["email"]]
            row = await pa.bump(db, site["_id"], {"page_access.rules": stored}) or site
        elif target["kind"] == "members":
            note = "Team pages open to the guide's team: invite them under People to give access."
        else:
            note = "Password pages open with the password: send it to them yourself."
        await pa.audit(db, site, user.id, "request_approved", rule_id=target["id"], email=q["email"])
    else:
        await pa.audit(db, site, user.id, "request_declined", rule_id=q.get("rule"), email=q["email"])
    await db[pa.REQUESTS].update_one({"_id": q["_id"]}, {"$set": {"status": "approved" if decision == "approve" else "declined",
                                                                   "decided_at": pa.now(), "decided_by": user.id}})
    try:
        host = (access.site_hosts(site) or [""])[0]
        url = f"{access.origin_of(host)}{access.safe_next(q.get('path') or '/')}" if host else get_settings().frontend_url
        await pa.send_decision_email(to=q["email"], guide=site.get("name") or "the guide", approved=decision == "approve", url=url)
    except Exception:
        log.warning("docs site %s: couldn't email an access decision", site["_id"], exc_info=True)
    return {"note": note, "private": await _view(db, row, role)}


@studio.post("/{site_id}/private/sign-out-readers", include_in_schema=False)
@limiter.limit("10/minute")
async def sign_out_readers(request: Request, site_id: str, db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, role = await store.load_site(db, site_id, user, need="admin")
    row = await pa.bump(db, site["_id"], rv=True, reason="sign-out-readers")
    await pa.audit(db, site, user.id, "readers_signed_out")
    return {"private": await _view(db, row or site, role)}


@studio.get("/{site_id}/private/preview", include_in_schema=False)
async def preview(site_id: str, as_: Literal["public", "member", "email", "password"] = Query("public", alias="as"),
                  email: str | None = Query(None, max_length=320), rules: str | None = Query(None, max_length=400),
                  db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """Who can open what, as a public reader, a team member, an email address or someone with passwords."""
    site, _role = await store.load_site(db, site_id, user, need="editor")
    if as_ == "email" and pa.clean_email(email) is None:
        raise HTTPException(status_code=422, detail="Enter an email address to preview as.")
    pages, nav_groups = await _drafts(db, site)
    who = {"as": as_, "email": email, "rules": [r for r in (rules or "").split(",") if r]}
    rows = pa.preview(site, pages, nav_groups, who)
    return {"as": as_, "email": pa.clean_email(email) if email else None, "pages": rows,
            "open": sum(1 for r in rows if r["open"]), "locked": sum(1 for r in rows if not r["open"])}


@studio.get("/{site_id}/private/audit", include_in_schema=False)
async def audit_log(site_id: str, db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    site, _role = await store.load_site(db, site_id, user, need="admin")
    rows = await db[pa.AUDIT].find({"site_id": site["_id"]}).sort("at", -1).to_list(length=200)
    names = await store.user_names(db, [r.get("actor") for r in rows])
    return {"entries": [{"at": store.aware(r["at"]), "actor": r.get("actor"), "actor_name": names.get(r.get("actor") or "") or None,
                         "action": r["action"], "rule": r.get("rule"), "detail": r.get("detail") or {}} for r in rows]}
