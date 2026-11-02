"""Private pages and sections inside a guide: who may open them, and how the edge learns it.

A guide stays public; some of its pages, groups or sections are for some readers only (free on
every guide). The pieces:

Rules. ``site.page_access.rules``: ``{id, kind, name, nav, emails, domains, password_hash, pv}``.
Kinds: ``members`` (the guide's team: a Guides role of viewer or more), ``people`` (listed emails
and email domains), ``password`` (one shared password; ``pv`` moves on when it changes, closing the
rule to everyone who gave the old one). ``encrypted`` is reserved in the engine's model and not
offered. The built-in ``members`` rule exists on every guide. A page names a rule in its
frontmatter (``access: <id>``, ``public`` undoes a group's rule; the editor's page panel writes it
into ``frontmatter_extra``), a nav group in ``page_access.groups`` ({group name: id}), a section
with ``:::private{access="<id>"}``. *What* is protected is content: it reaches readers when the
guide is published (the engine leaves protected pages and sections out of every public output,
docs-platform/builder/access.mjs checks the build). *Who* may open it is live: every change here
moves ``page_access.version`` on and queues the ``access`` job, which writes the readers policy
into ``sites/<site>/access.json`` (services/docs_site_access.write_policy), read by the edge within
seconds (docs-platform/edge/readers.mjs). No email list or password hash ever reaches the content
folder, the build or a reader.

Readers sign in at the edge's lock page. Everything they get back is a *reader grant* (the same
signed-token format and secret as the guide-wide sign-in, docs_site_access.sign) in the fragment of
``/_access/callback``: after "Sign in with Markdrop" (``POST /docs-access/reader-grant``: their
email and whether they are on the team), after a page password (``pw: [[rule, pv]]``), or from an
emailed link (``x: "email"``: a single-use link stored hashed here, opened with a POST so mail
scanners can't use it up, valid 15 minutes; the grant then lives two minutes and isn't tied to a
browser, so it works from a phone's mail app). ``rv`` (``page_access.rv``) is in every grant and
reader cookie: "Sign out every reader" moves it on. ``mv`` (``page_access.mv``, the members version)
is in every grant and in a team member's reader cookie: it moves on when someone loses their Guides
role on the guide (:func:`revoke_members`, called by docs_studio_roles.revoke_lost), and the edge
then stops treating any older cookie as a team member's (their email and page passwords still
count; the others sign in again with one click, the removed member can't).

Access requests (``docs_access_requests``) come from the lock page; the guide's admins get an
email; approving one adds the email to a people rule. Every change of who may read lands in
``docs_access_audit``.

Ask AI: the edge's ``/_access/me`` hands the page a ten-minute token naming the rules the reader
may open (``mdda-ai-v1``); ``/docs/ask`` reveals exactly those (docs_index builds a separate index
per rule set). Without a valid token Ask AI knows only the public guide.
"""

from __future__ import annotations

import hashlib
import html
import logging
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.services import docs_site_access as access

log = logging.getLogger(__name__)

LINKS = "docs_reader_links"
REQUESTS = "docs_access_requests"
AUDIT = "docs_access_audit"
READER_GRANT = "mdda-reader-grant-v1"
AI_TOKEN = "mdda-ai-v1"
RULE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
KINDS = ("members", "people", "password")
MEMBERS = "members"
MAX_RULES = 50
MAX_EMAILS = 1000
MAX_DOMAINS = 100
LINK_TTL = 15 * 60
EMAIL_RE = re.compile(r"^[^\s@]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$")
DOMAIN_RE = re.compile(r"^[a-z0-9-]+(?:\.[a-z0-9-]+)+$")
# Domains that are everyone's: "anyone at gmail.com" is not a customer.
PUBLIC_DOMAINS = frozenset({"gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com",
                            "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "mail.com",
                            "yandex.com", "zoho.com"})


def now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# ── the model ────────────────────────────────────────────────────────────────


def state(site: dict) -> dict:
    return site.get("page_access") or {}


def version_of(site: dict) -> int:
    try:
        return max(0, int(state(site).get("version") or 0))
    except (TypeError, ValueError):
        return 0


def rv_of(site: dict) -> int:
    try:
        return max(0, int(state(site).get("rv") or 0))
    except (TypeError, ValueError):
        return 0


def mv_of(site: dict) -> int:
    """The members version: team-member reader sessions of an older one are not a member's."""
    try:
        return max(0, int(state(site).get("mv") or 0))
    except (TypeError, ValueError):
        return 0


def members_rule() -> dict:
    return {"id": MEMBERS, "kind": "members", "name": "Team members", "nav": "show", "emails": [], "domains": [], "pv": 0}


def rules(site: dict) -> list[dict]:
    """Every rule, the built-in team rule first (a stored one with that id keeps its name and nav)."""
    out: list[dict] = []
    stored = [r for r in state(site).get("rules") or [] if isinstance(r, dict) and RULE_ID.match(str(r.get("id") or ""))]
    team = next((r for r in stored if r["id"] == MEMBERS), None)
    out.append({**members_rule(), **({"name": team.get("name"), "nav": team.get("nav", "show")} if team else {})})
    out.extend(r for r in stored if r["id"] != MEMBERS and r.get("kind") in KINDS)
    return out


def rule(site: dict, rid: str) -> dict | None:
    return next((r for r in rules(site) if r["id"] == rid), None)


def groups(site: dict) -> dict[str, str]:
    g = state(site).get("groups") or {}
    return {str(k): str(v) for k, v in g.items() if isinstance(v, str) and (v == "public" or RULE_ID.match(v))}


def readers_policy(site: dict) -> dict:
    """What the edge enforces (docs-platform/edge/readers.mjs parseReaders): no hashes, no names it
    doesn't show."""
    return {
        "version": version_of(site),
        "rv": rv_of(site),
        "mv": mv_of(site),
        "rules": {r["id"]: {
            "kind": r["kind"], "name": str(r.get("name") or "")[:60],
            **({"emails": sorted(set(r.get("emails") or [])), "domains": sorted(set(r.get("domains") or []))} if r["kind"] == "people" else {}),
            **({"pv": int(r.get("pv") or 0)} if r["kind"] == "password" else {}),
        } for r in rules(site)},
    }


def needs_readers(site: dict) -> bool:
    """Whether the edge must hold a readers policy for this guide (it ever had a rule change)."""
    return version_of(site) > 0


def content_access(site: dict) -> dict | None:
    """site.json ``access`` (the engine's view: kinds, names, nav; never who)."""
    if not needs_readers(site):
        return None
    return {"rules": {r["id"]: {"kind": r["kind"], "name": r.get("name") or "", "nav": r.get("nav") or "show"} for r in rules(site)}}


def snapshot_uses_access(snap: dict, site: dict) -> bool:
    """Whether a publish protects anything (a page's access, a group's, a private section)."""
    if any(v and v != "public" for v in groups(site).values()):
        return True
    for p in snap.get("pages") or []:
        extra = p.get("frontmatter_extra") or {}
        if extra.get("access") not in (None, "", "public", "inherit") or has_private(p.get("markdown") or ""):
            return True
    return False


def enforced(site: dict) -> bool:
    """The edge holds the current readers policy (False while the access job is on its way)."""
    if not needs_readers(site):
        return True
    try:
        return int(site.get("page_access_synced_version") or 0) >= version_of(site)
    except (TypeError, ValueError):
        return False


# ── emails and domains ───────────────────────────────────────────────────────


def clean_email(v: Any) -> str | None:
    e = str(v or "").strip().lower()
    return e if len(e) <= 254 and EMAIL_RE.match(e) else None


def clean_domain(v: Any) -> str | None:
    d = str(v or "").strip().lower().lstrip("@")
    return d if len(d) <= 253 and DOMAIN_RE.match(d) else None


def domain_of(email: str) -> str:
    return email.rsplit("@", 1)[-1]


def people_match(r: dict, email: str | None) -> bool:
    if not email or r.get("kind") != "people":
        return False
    return email in (r.get("emails") or []) or domain_of(email) in (r.get("domains") or [])


def rules_for_email(site: dict, email: str | None) -> list[str]:
    return [r["id"] for r in rules(site) if people_match(r, email)]


# ── page access in the drafts (what a publish will protect) ──────────────────


def page_rule(page_access: Any, group_access: Any) -> str | None:
    """The engine's effectiveRule (frontend/src/docs/access.mjs): the page's own, else its group's."""
    def val(v: Any) -> str | None:
        if v is None or v == "":
            return None
        s = str(v).strip().lower()
        if s in ("", "inherit"):
            return None
        if s == "public":
            return "public"
        return s if RULE_ID.match(s) else "invalid"
    p = val(page_access)
    if p == "public":
        return None
    if p:
        return p
    g = val(group_access)
    return g if g and g != "public" else None


_FENCE = re.compile(r"^(`{3,}|~{3,})")
_QUOTE = re.compile(r"^\s{0,3}(?:>\s?)+")
_BULLET = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")
_OPEN = re.compile(r"^(\s*)(:{3,})([A-Za-z][\w-]*)(?:\[([^\]]*)\])?(?:\{((?:[^}\"']|\"[^\"]*\"|'[^']*')*)\})?\s*$")
_CLOSE = re.compile(r"^\s*(:{3,})\s*$")
_ATTR = re.compile(r"([A-Za-z_][\w-]*)(?:=(?:\"([^\"]*)\"|'([^']*)'|([^\s\"']+)))?")


def section_rule(attrs: str | None) -> str:
    a: dict[str, str] = {}
    for m in _ATTR.finditer(attrs or ""):
        a[m.group(1)] = m.group(2) or m.group(3) or m.group(4) or ""
    v = (a.get("access") or a.get("for") or "").strip().lower()
    if not v or v in ("public", "inherit"):
        return MEMBERS
    return v if RULE_ID.match(v) else "invalid"


def split_private(body: str, reveal: set[str] | frozenset | None = None, *,
                  placeholder: bool = True, unwrap: bool = False) -> tuple[str, list[str]]:
    """A port of access.mjs splitPrivate (the same cuts, so Ask AI reads what the page shows): hidden
    sections become one "Private section" line; revealed ones keep their text. → (body, rules).

    For a guide's export (services/docs_site_export.py): ``placeholder=False`` leaves nothing where a
    hidden section was; ``unwrap=True`` drops a revealed section's closing fence too, so its text
    stands as ordinary Markdown."""
    out: list[str] = []
    found: list[str] = []
    stack: list[int] = []
    # The containers a revealed section opened (their depth in ``stack``), whose fence unwrap drops.
    opened: set[int] = set()
    skip_at = -1
    fence: tuple[str, int] | None = None
    math = False
    for raw in str(body or "").split("\n"):
        raw = raw.rstrip("\r")
        line = _QUOTE.sub("", raw)
        skipping = skip_at >= 0
        if fence:
            m = re.match(r"^(`{3,}|~{3,})\s*$", line.strip())
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= fence[1]:
                fence = None
            if not skipping:
                out.append(raw)
            continue
        if math:
            if re.match(r"^\s{0,3}\$\$\s*$", line):
                math = False
            if not skipping:
                out.append(raw)
            continue
        core = _BULLET.sub(lambda m: " " * len(m.group(0)), line)
        f = re.match(r"^\s{0,3}(`{3,}|~{3,})(.*)$", core.lstrip())
        if f and not (f.group(1)[0] == "`" and "`" in f.group(2)):
            fence = (f.group(1)[0], len(f.group(1)))
            if not skipping:
                out.append(raw)
            continue
        if re.match(r"^\s{0,3}\$\$(?!.*\$\$)", core):
            math = True
            if not skipping:
                out.append(raw)
            continue
        o = _OPEN.match(core)
        if o:
            colons = len(o.group(2))
            if o.group(3) == "private":
                r = section_rule(o.group(5))
                if r not in found:
                    found.append(r)
                stack.append(colons)
                if skipping:
                    continue
                if reveal and r in reveal:
                    if unwrap:
                        opened.add(len(stack))
                    continue  # the container line itself: its content follows
                label = re.sub(r"\s+", " ", o.group(4) or "").strip()
                if placeholder:
                    out.append(f"_Private section{': ' + label if label else ''}._")
                skip_at = len(stack)
                continue
            stack.append(colons)
            if not skipping:
                out.append(raw)
            continue
        c = _CLOSE.match(core)
        if c and stack and stack[-1] <= len(c.group(1)):
            depth = len(stack)
            stack.pop()
            if skipping and len(stack) < skip_at:
                skip_at = -1
                continue
            if depth in opened:
                opened.discard(depth)
                continue
            if not skipping:
                out.append(raw)
            continue
        if not skipping:
            out.append(raw)
    return "\n".join(out), found


def has_private(body: str) -> bool:
    return bool(re.search(r":{3,}private\b", body or ""))


# ── tokens ───────────────────────────────────────────────────────────────────


def mint_reader_grant(site: dict, host: str, *, sh: str | None = None, email: str | None = None,
                      member: bool = False, pw: list | None = None, via: str) -> str:
    """A reader grant for the edge (readers.mjs readerGrant). Browser-bound (``sh``) unless it comes
    from an emailed link (``via="email"``: two minutes, single-use at the link)."""
    payload: dict = {"s": str(site["_id"]), "h": host, "rv": rv_of(site), "mv": mv_of(site), "n": secrets.token_urlsafe(9)}
    if via == "email":
        payload.update({"x": "email", "exp": int(time.time()) + 120})
    else:
        if not access.valid_state_hash(sh):
            raise ValueError("a browser-bound grant needs the state hash")
        ttl = max(30, min(int(get_settings().docs_access_grant_ttl_seconds or 120), 600))
        payload.update({"sh": sh, "exp": int(time.time()) + ttl})
    if email:
        payload["e"] = email
    if member:
        payload["m"] = True
    if pw:
        payload["pw"] = pw
    return access.sign(READER_GRANT, payload)


def reader_callback(host: str, grant: str, next_path: str) -> str:
    return f"{access.callback_url(host, grant, next_path)}&kind=reader"


def lock_url(host: str, rule_id: str | None, next_path: str, message: str | None = None) -> str:
    q = f"next={quote(access.safe_next(next_path), safe='')}"
    if rule_id:
        q += f"&rule={quote(rule_id, safe='')}"
    if message:
        q += f"&m={quote(message, safe='')}"
    return f"{access.origin_of(host)}/_access/page?{q}"


def ai_rules(token: Any, site_id: str) -> frozenset[str]:
    """The rules an Ask AI request may read (a valid edge token for this guide), else none."""
    if not token or not isinstance(token, str) or len(token) > 4096:
        return frozenset()
    data = access.read(AI_TOKEN, token)
    if not data or str(data.get("s")) != str(site_id) or not isinstance(data.get("r"), list):
        return frozenset()
    if int(data["exp"]) > time.time() + 900:
        return frozenset()
    return frozenset(r for r in data["r"] if isinstance(r, str) and RULE_ID.match(r))


# ── emailed sign-in links ────────────────────────────────────────────────────


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def create_link(db: AsyncIOMotorDatabase, site: dict, *, email: str, host: str, next_path: str,
                      rule_id: str | None) -> str:
    token = secrets.token_urlsafe(32)
    await db[LINKS].insert_one({
        "_id": _hash(token), "site_id": site["_id"], "email": email, "host": host, "next": access.safe_next(next_path),
        "rule": rule_id, "created_at": now(), "expires_at": now() + timedelta(seconds=LINK_TTL), "used_at": None,
    })
    return token


async def peek_link(db: AsyncIOMotorDatabase, token: str) -> dict | None:
    if not isinstance(token, str) or not 20 <= len(token) <= 100:
        return None
    row = await db[LINKS].find_one({"_id": _hash(token)})
    if not row or row.get("used_at") or (_aware(row.get("expires_at")) or now()) <= now():
        return None
    return row


async def use_link(db: AsyncIOMotorDatabase, token: str) -> dict | None:
    """Use a link once (atomically): the row, or None when unknown, used or expired."""
    if not isinstance(token, str) or not 20 <= len(token) <= 100:
        return None
    return await db[LINKS].find_one_and_update(
        {"_id": _hash(token), "used_at": None, "expires_at": {"$gt": now()}}, {"$set": {"used_at": now()}})


async def is_member_email(db: AsyncIOMotorDatabase, site: dict, email: str) -> bool:
    from app.services import docs_site_store as store
    from app.services.user import get_user_by_email

    user = await get_user_by_email(db, email)
    if user is None:
        return False
    return store.role_at_least(await store.site_role(db, site, user.id), "viewer")


async def may_sign_in(db: AsyncIOMotorDatabase, site: dict, email: str) -> bool:
    """Whether an emailed link is worth sending: a people rule lists the email (or its domain), or
    it is a team member's (they open everything)."""
    return bool(rules_for_email(site, email)) or await is_member_email(db, site, email)


# ── audit ────────────────────────────────────────────────────────────────────


async def audit(db: AsyncIOMotorDatabase, site: dict, actor: str | None, action: str, *, rule_id: str | None = None,
                **detail: Any) -> None:
    try:
        await db[AUDIT].insert_one({"site_id": site["_id"], "at": now(), "actor": actor, "action": action,
                                    "rule": rule_id, **({"detail": detail} if detail else {})})
    except Exception:  # pragma: no cover - an audit hiccup must not fail the change
        log.warning("docs access audit write failed", exc_info=True)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[LINKS].create_index("expires_at", expireAfterSeconds=86400)
    await db[REQUESTS].create_index([("site_id", 1), ("status", 1), ("created_at", -1)])
    await db[AUDIT].create_index([("site_id", 1), ("at", -1)])


# ── emails ───────────────────────────────────────────────────────────────────


async def send_link_email(*, to: str, guide: str, url: str) -> None:
    from app.services import mailer as m

    g = html.escape(guide)
    content = (m._eyebrow("Sign in") + m._heading(f"Open {g}")
               + m._p(f"Use this button to sign in to <strong>{g}</strong> as {html.escape(to)}. It works once, for 15 minutes.")
               + m._button(url, "Sign in and open the page")
               + m._p("If you didn't ask for this, ignore this email: nothing happens unless the button is used.", size=13))
    await m._post({"from": m._sender("login"), "to": [to], "subject": f"Sign in to {m._one_line(guide, 80)}",
                   "reply_to": get_settings().email_reply_to,
                   "html": m._shell(title=f"Sign in to {g}", content=content, footer="Sent by Markdrop Guides because someone entered this address on the guide's sign-in page.")})


async def send_request_email(*, to: list[str], guide: str, email: str, rule_name: str, note: str, url: str) -> None:
    from app.services import mailer as m

    g = html.escape(guide)
    content = (m._eyebrow("Access request") + m._heading(f"{html.escape(email)} asked for access")
               + m._p(f"They want to open <strong>{html.escape(rule_name)}</strong> pages in {g}.")
               + (m._p(f"&ldquo;{html.escape(note)}&rdquo;", size=14) if note else "")
               + m._button(url, "Review the request"))
    await m._post({"from": m._sender("share"), "to": to[:20], "subject": f"Access request for {m._one_line(guide, 80)}",
                   "reply_to": get_settings().email_reply_to,
                   "html": m._shell(title="Access request", content=content, footer="You get these because you're an admin of this guide in Markdrop Guides.")})


async def send_decision_email(*, to: str, guide: str, approved: bool, url: str) -> None:
    from app.services import mailer as m

    g = html.escape(guide)
    if approved:
        content = (m._eyebrow("Access request") + m._heading(f"You can open {g}")
                   + m._p("Your request was approved. Open the page and sign in with this email address.")
                   + m._button(url, "Open the guide"))
    else:
        content = m._eyebrow("Access request") + m._heading("Your request wasn't approved") + m._p(f"The team behind {g} didn't approve access for this address.")
    await m._post({"from": m._sender("share"), "to": [to], "subject": f"Your access request for {m._one_line(guide, 80)}",
                   "reply_to": get_settings().email_reply_to,
                   "html": m._shell(title="Access request", content=content, footer="Sent by Markdrop Guides.")})


# ── changes (the studio) ─────────────────────────────────────────────────────


async def bump(db: AsyncIOMotorDatabase, site_id: Any, sets: dict | None = None, *, rv: bool = False,
               reason: str = "page-access") -> dict | None:
    """Apply a change and move the readers policy on, then queue the access job (the edge has it
    within seconds; the sweeper retries until it does)."""
    from app.services.docs_jobs import SITES, oid

    inc = {"page_access.version": 1, **({"page_access.rv": 1} if rv else {})}
    row = await db[SITES].find_one_and_update({"_id": oid(site_id), "deleted_at": None},
                                              {"$inc": inc, "$set": {**(sets or {}), "updated_at": now()}},
                                              return_document=True)
    if row is not None:
        await access.queue_sync(db, row["_id"], reason)
    return row


async def revoke_members(db: AsyncIOMotorDatabase, site_id: Any, reason: str, *, target_user_id: str | None = None) -> dict | None:
    """Someone lost their Guides role on this guide: end every team member's reader session at the
    edge (``mv`` moves on with the policy version, and the access job writes it within seconds), so
    their up-to-7-day reader cookie stops opening team pages. Only the member claim goes: readers
    signed in by email or password keep what those rules give them, which is live anyway. None when
    the guide has no readers policy (nothing private was ever set up: no reader sessions to end)."""
    from app.services.docs_jobs import SITES, oid

    row = await db[SITES].find_one_and_update(
        {"_id": oid(site_id), "deleted_at": None, "page_access.version": {"$gt": 0}},
        {"$inc": {"page_access.version": 1, "page_access.mv": 1}, "$set": {"updated_at": now()}},
        return_document=True)
    if row is None:
        return None
    await access.queue_sync(db, row["_id"], reason)
    await audit(db, row, None, "members_signed_out", reason=reason,
                **({"target_user_id": target_user_id} if target_user_id else {}))
    return row


def rule_view(r: dict, *, admin: bool, used: int = 0) -> dict:
    out = {"id": r["id"], "kind": r["kind"], "name": r.get("name") or "", "nav": r.get("nav") or "show",
           "builtin": r["id"] == MEMBERS, "pages": used}
    if r["kind"] == "people":
        out["emails_count"] = len(r.get("emails") or [])
        out["domains_count"] = len(r.get("domains") or [])
        if admin:
            out["emails"] = list(r.get("emails") or [])
            out["domains"] = list(r.get("domains") or [])
    if r["kind"] == "password":
        out["has_password"] = bool(r.get("password_hash"))
        out["pv"] = int(r.get("pv") or 0)
    return out


def new_rule_id(site: dict, name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")[:24] or "rule"
    if not base[0].isalnum():
        base = "r" + base
    taken = {r["id"] for r in rules(site)} | {"public", "inherit", "invalid"}
    rid, n = base, 2
    while rid in taken:
        rid = f"{base[:20]}-{n}"
        n += 1
    return rid


def check_lists(emails: Any, domains: Any) -> tuple[list[str], list[str]]:
    es: list[str] = []
    for e in emails or []:
        c = clean_email(e)
        if c is None:
            raise ValueError(f"“{str(e)[:80]}” isn't an email address.")
        if c not in es:
            es.append(c)
    ds: list[str] = []
    for d in domains or []:
        c = clean_domain(d)
        if c is None:
            raise ValueError(f"“{str(d)[:80]}” isn't an email domain (like northwind.com).")
        if c in PUBLIC_DOMAINS:
            raise ValueError(f"{c} is a public email provider: anyone can have an address there. List the people instead.")
        if c not in ds:
            ds.append(c)
    if len(es) > MAX_EMAILS or len(ds) > MAX_DOMAINS:
        raise ValueError(f"A rule can list at most {MAX_EMAILS} emails and {MAX_DOMAINS} domains.")
    return es, ds


def preview(site: dict, pages: list[dict], nav_groups: dict[str, str], who: dict) -> list[dict]:
    """Who-can-open for every draft page, as ``who`` would see it after a publish.

    ``who``: {"as": "public"} | {"as": "member"} | {"as": "email", "email": ...} | {"as": "password", "rules": [...]}.
    ``pages``: drafts with path, title, markdown, frontmatter_extra, page_id; ``nav_groups``: page id → group name.
    """
    g_access = groups(site)
    known = {r["id"]: r for r in rules(site)}

    def can(rid: str) -> bool:
        r = known.get(rid)
        if r is None:
            return False
        mode = who.get("as")
        if mode == "member":
            return True
        if mode == "email":
            return people_match(r, clean_email(who.get("email")))
        if mode == "password":
            return r["kind"] == "password" and rid in (who.get("rules") or [])
        return False

    out = []
    for p in pages:
        extra = p.get("frontmatter_extra") or {}
        group = nav_groups.get(str(p.get("page_id") or p.get("id") or ""))
        rid = page_rule(extra.get("access"), g_access.get(group) if group else None)
        _body, sections = split_private(p.get("markdown") or "", None) if has_private(p.get("markdown") or "") else ("", [])
        out.append({
            "path": p.get("path"), "title": p.get("title"), "rule": rid, "group": group,
            "open": rid is None or can(rid),
            "unknown_rule": bool(rid and rid not in known),
            "sections": [{"rule": s, "open": can(s), "unknown_rule": s not in known} for s in sections],
        })
    return out


_LINK = re.compile(r"\]\((/[^)\s#?]*)")


def link_warnings(rows: list[dict], pages: list[dict]) -> list[dict]:
    """Public pages that link to a protected one (readers will meet a lock), from preview rows."""
    rule_of = {r["path"]: r["rule"] for r in rows}
    out = []
    for p in pages:
        src = p.get("path")
        if rule_of.get(src):
            continue
        for m in _LINK.finditer(p.get("markdown") or ""):
            target = m.group(1).rstrip("/") or "/"
            if rule_of.get(target):
                out.append({"from": src, "to": target, "rule": rule_of[target]})
    return out
