"""The readable AI request log: every AI call, who made it and what was said (Admin → AI → Requests).

Two things live here, both fed by ``ai_usage.record`` (every AI feature already calls it):

**Who.** Every ledger row (``ai_requests``) and log row gets an ``actor``:

* ``user``   — a person, signed in, in the app (Slack included);
* ``api``    — a person through an AI app or an API token (MCP, ``mdk_`` tokens): ``app`` names it;
* ``system`` — a background job (team memory, Ask suggestions, a meeting summary after an
  auto-import, the weekly summary…): ``job`` names it, ``workspace_id`` says for whom;
* ``public`` — an anonymous visitor (docs Ask AI, a shared page);
* ``test``   — test or internal traffic, whatever it would otherwise be (``actor_kind`` keeps that).

A call is test traffic (``test: true``, ``test_reason``) when the request carried
``X-Markdrop-Test: 1`` (our e2e / eval / docs-media harnesses send it), the account's email is on a
test domain (``@example.com``, ``*.test``, ``*.invalid``…), the account is on the internal list
(Admin → AI → Requests → settings; default ``MARKDROP_ADMIN_EMAILS``), the request came from
localhost or one of our own servers (``ai_log_internal_ips``), or its User-Agent is a test
client's (Playwright, headless Chrome; python-httpx / requests / curl too unless it came through an
AI app or an API token). Dashboards leave test traffic out by default and say how much they left out.

**What.** One ``ai_log`` row per call (``_id`` = the ledger's ``request_id``; 30-day TTL; admins only):
a human label ("Ask · Senseloaf", "Team memory · read meeting 'Daily Syncup' → 12 facts"), the
actor, the workspace, model, tokens, cost, latency, outcome, and the readable content: the person's
input (question, instruction, quoted selection), the model's final answer as the person saw it
(markdown, with its citations), and a summary of the context that was sent — kinds, titles and ids,
never the injected document text. Chat features keep the full question and answer (up to
:data:`CHAT_CAP` characters); everything else is cut at :data:`INPUT_CAP` / :data:`OUTPUT_CAP`.
Secrets are always masked; other people's email addresses and phone numbers are masked in free
text (the actor's own address stays). The admin can turn content capture off
(``ai_settings`` ``_id: "log"``, ``content: false``): metadata is still logged.

Calls group into conversations (``conversation_id``): an Ask / assistant / meetings thread
(``t:<thread id>``, linked when the turn is saved: :func:`link`), a docs Ask AI conversation
(``d:<id>``), a run of follow-ups on one page or the analytics home (the same ``thread_key`` within
:data:`FOLLOW_UP_WINDOW`), else the call on its own.

Nothing here may fail an AI request: every entry point swallows its own errors.
"""

from __future__ import annotations

import ipaddress
import logging
import re
import time
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase
from starlette.types import ASGIApp, Receive, Scope, Send

log = logging.getLogger("markdrop.ai_log")

COLL = "ai_log"
RETENTION_DAYS = 30
SETTINGS_ID = "log"            # in ai_usage.SETTINGS
CHAT_CAP = 50_000              # a chat feature's question and answer
INPUT_CAP = 2_000              # anything else the person typed or selected
OUTPUT_CAP = 4_000             # anything else the model wrote
DESC_CAP = 300
PREVIEW_CAP = 200              # the list's title: the start of the question
CONTEXT_ITEMS = 30
FOLLOW_UP_WINDOW = timedelta(hours=3)
CACHE_TTL = 60.0

ACTORS = ("user", "api", "system", "public", "test")
#: Admin filter values → a query on the ledger / the log.
AUDIENCES = ("live", "real", "system", "public", "test", "all")

TEST_HEADER = b"x-markdrop-test"
TEST_COOKIE = "md_test"
TEST_DOMAINS = ("example.com", "example.org", "example.net", "acme.test")
TEST_TLDS = (".test", ".invalid", ".example", ".localhost")
_TEST_UA = re.compile(r"playwright|headlesschrome|puppeteer|\bpytest\b", re.I)
_SCRIPT_UA = re.compile(r"python-httpx|python-requests|python-urllib|\bcurl/|aiohttp", re.I)

#: Features whose every call is a background job, and the job's name.
SYSTEM_FEATURES = {"workspace_memory": "Team memory", "ask_suggestions": "Ask suggestions"}


def job_name(feature: str, meta: dict) -> str:
    if feature == "workspace_memory" and meta.get("kind") == "weekly":
        return "Weekly summary"
    if feature == "analytics_ai" and meta.get("via") == "digest":
        return "Analytics digest"
    if feature == "pages_ai" and meta.get("via") == "backfill":
        return "Cover backfill"
    return SYSTEM_FEATURES.get(feature) or str(meta.get("kind") or feature).replace("_", " ").capitalize()


# ── The request in progress ───────────────────────────────────────────────────


@dataclass(frozen=True)
class RequestInfo:
    test: bool = False          # X-Markdrop-Test: 1 (or the md_test=1 cookie)
    ip: str | None = None
    ua: str = ""
    api_token: bool = False     # Authorization: Bearer mdk_…


REQUEST: ContextVar[RequestInfo | None] = ContextVar("ai_log_request", default=None)


def _client_ip(scope: Scope, headers: dict[bytes, bytes]) -> str | None:
    """As utils/net.get_client_ip: nginx's X-Real-IP, else the last X-Forwarded-For hop, else the peer."""
    real = headers.get(b"x-real-ip")
    if real:
        return real.decode("latin-1").strip()
    fwd = headers.get(b"x-forwarded-for")
    if fwd:
        return fwd.decode("latin-1").split(",")[-1].strip()
    client = scope.get("client")
    return client[0] if client else None


def request_info(scope: Scope) -> RequestInfo:
    headers = {k.lower(): v for k, v in scope.get("headers") or []}
    test = headers.get(TEST_HEADER, b"").strip() in (b"1", b"true", b"yes")
    if not test:
        cookie = headers.get(b"cookie", b"").decode("latin-1")
        test = bool(re.search(rf"(?:^|;\s*){TEST_COOKIE}=1(?:;|$)", cookie))
    auth = headers.get(b"authorization", b"").decode("latin-1")
    return RequestInfo(test=test, ip=_client_ip(scope, headers),
                       ua=headers.get(b"user-agent", b"").decode("latin-1")[:300],
                       api_token=auth[7:].strip().startswith("mdk_") if auth[:7].lower() == "bearer " else False)


class RequestContextMiddleware:
    """Pure ASGI: remembers who is asking (test header, address, User-Agent, API token) for the
    duration of the request, so an AI call made anywhere below can be classified."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        token = REQUEST.set(request_info(scope))
        try:
            await self.app(scope, receive, send)
        finally:
            REQUEST.reset(token)


# ── Settings ──────────────────────────────────────────────────────────────────

_cache: dict[tuple[str, str], tuple[float, Any]] = {}


def invalidate() -> None:
    _cache.clear()


async def _cached(db: AsyncIOMotorDatabase, key: str, load) -> Any:
    ck = (getattr(db, "name", ""), key)
    hit = _cache.get(ck)
    t = time.monotonic()
    if hit is not None and hit[0] > t:
        return hit[1]
    value = await load()
    _cache[ck] = (t + CACHE_TTL, value)
    return value


def default_internal() -> list[str]:
    from app.config import get_settings

    return sorted(get_settings().admin_email_set)


def config_ips() -> list[str]:
    from app.config import get_settings

    return [x.strip() for x in (get_settings().ai_log_internal_ips or "").split(",") if x.strip()]


async def settings(db: AsyncIOMotorDatabase) -> dict:
    """{content: bool, internal_emails: [str], internal_ips: [str]} — the admin's choices over the
    defaults (content on; the admin emails; no extra addresses)."""
    from app.services import ai_usage

    async def load() -> dict:
        try:
            row = await db[ai_usage.SETTINGS].find_one({"_id": SETTINGS_ID}) or {}
        except Exception:
            row = {}
        emails = row.get("internal_emails")
        return {"content": row.get("content", True) is not False,
                "internal_emails": [e.lower() for e in emails] if isinstance(emails, list) else default_internal(),
                "internal_emails_default": not isinstance(emails, list),
                "internal_ips": list(row.get("internal_ips") or []),
                "updated_at": row.get("updated_at"), "updated_by": row.get("updated_by")}
    return await _cached(db, "settings", load)


# ── Classification ────────────────────────────────────────────────────────────


def test_email(email: str | None) -> bool:
    e = (email or "").strip().lower()
    if "@" not in e:
        return False
    domain = e.rsplit("@", 1)[1]
    return domain in TEST_DOMAINS or domain.endswith(TEST_TLDS) or any(domain.endswith("." + d) for d in TEST_DOMAINS)


def local_ip(ip: str | None, extra: list[str] | tuple[str, ...] = ()) -> bool:
    if not ip:
        return False
    if ip in extra or ip in ("testclient", "localhost"):
        return True
    try:
        return ipaddress.ip_address(ip).is_loopback
    except ValueError:
        return False


def test_ua(ua: str | None, *, via_app: bool) -> bool:
    if not ua:
        return False
    if _TEST_UA.search(ua):
        return True
    # Scripts' default clients: an AI app's own servers may use them too, so not through MCP / a token.
    return not via_app and bool(_SCRIPT_UA.search(ua))


async def user_info(db: AsyncIOMotorDatabase, user_id: str | None) -> dict:
    """{email, name} of an account (cached briefly); {} when unknown."""
    if not user_id or not ObjectId.is_valid(str(user_id)):
        return {}

    async def load() -> dict:
        try:
            row = await db["users"].find_one({"_id": ObjectId(str(user_id))}, {"email": 1, "name": 1})
        except Exception:
            row = None
        return {"email": (row or {}).get("email") or "", "name": (row or {}).get("name") or ""} if row else {}
    return await _cached(db, f"user:{user_id}", load)


async def workspace_name(db: AsyncIOMotorDatabase, workspace_id: str | None) -> str | None:
    if not workspace_id or not ObjectId.is_valid(str(workspace_id)):
        return None

    async def load() -> str | None:
        try:
            row = await db["workspaces"].find_one({"_id": ObjectId(str(workspace_id))}, {"name": 1})
        except Exception:
            row = None
        return (row or {}).get("name")
    return await _cached(db, f"ws:{workspace_id}", load)


async def _app_name(db: AsyncIOMotorDatabase, client_id: str | None, info: RequestInfo | None) -> str:
    if client_id:
        from app.services import page_history

        return await page_history._client_name(db, client_id)
    return "API token" if info and info.api_token else "AI app"


async def classify(db: AsyncIOMotorDatabase, *, feature: str, user_id: str | None, visitor: str | None,
                   meta: dict | None = None, job: str | None = None) -> dict:
    """{actor, actor_kind, test, test_reason?, job?, app?} for one call made now."""
    from app.services import page_history

    meta = meta or {}
    info = REQUEST.get()
    mcp_client = page_history.MCP_CLIENT.get()
    via = str(meta.get("via") or "")
    out: dict[str, Any] = {}
    if job or visitor == "system" or via in ("background", "digest") or feature in SYSTEM_FEATURES or meta.get("system"):
        kind = "system"
        out["job"] = job or job_name(feature, meta)
    elif not user_id:
        kind = "public"
    elif mcp_client or via in ("mcp", "api") or (info is not None and info.api_token):
        kind = "api"
        out["app"] = await _app_name(db, mcp_client, info)
    else:
        kind = "user"
    reason = None
    conf = await settings(db)
    if info is not None and info.test:
        reason = "header"
    if reason is None and user_id:
        email = (await user_info(db, user_id)).get("email") or ""
        if test_email(email):
            reason = "test_domain"
        elif email and email.lower() in conf["internal_emails"]:
            reason = "internal"
    if reason is None and info is not None:
        if local_ip(info.ip, [*config_ips(), *conf["internal_ips"]]):
            reason = "local"
        elif test_ua(info.ua, via_app=kind == "api"):
            reason = "client"
    out.update(actor="test" if reason else kind, actor_kind=kind, test=bool(reason))
    if reason:
        out["test_reason"] = reason
    return out


def audience_query(audience: str | None) -> dict:
    """The ledger / log clause for an admin filter. ``live`` (the dashboards' default): everything
    but test traffic. ``real``: people (in the app or through an AI app). Rows written before actors
    existed have none until the startup backfill: they count as live, never as test."""
    a = audience if audience in AUDIENCES else "live"
    if a == "all":
        return {}
    if a == "live":
        return {"test": {"$ne": True}}
    if a == "real":
        return {"actor": {"$in": ["user", "api"]}}
    return {"actor": a}


# ── Content ───────────────────────────────────────────────────────────────────

_SECRETS = [
    re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{8,}"),
    re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"\bmdk_[A-Za-z0-9_\-]{8,}"),
    re.compile(r"\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{16,}"),
    re.compile(r"\bxox[abposr]-[A-Za-z0-9\-]{8,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_\-]{30,}"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"),   # a JWT
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
]
_BEARER = re.compile(r"(?i)\b(bearer|token|api[_-]?key|secret|password|passwd|pwd)(\s*[:=]\s*|\s+)([^\s,;'\"]{6,})")
_EMAIL = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")
_PHONE = re.compile(r"(?<![\w/.-])(?:\+\d{1,3}[\s.\-]?)?(?:\(\d{2,4}\)[\s.\-]?)?\d{3,5}[\s.\-]\d{3,4}[\s.\-]?\d{0,4}(?![\w/.-])")


def _phone_like(m: re.Match) -> str:
    s = m.group(0)
    digits = re.sub(r"\D", "", s)
    # Dates, times, versions and amounts look like this too: only 10-15 digits, or a leading +.
    if (10 <= len(digits) <= 15) or (s.startswith("+") and len(digits) >= 8):
        return "[phone]"
    return s


def redact(text: str | None, *, keep_email: str | None = None) -> str:
    """Secrets always masked; email addresses (but ``keep_email``) and phone numbers too."""
    if not text:
        return ""
    s = str(text).replace("\x00", "")
    for rx in _SECRETS:
        s = rx.sub("[secret]", s)
    s = _BEARER.sub(lambda m: f"{m.group(1)}{m.group(2)}[secret]", s)
    keep = (keep_email or "").lower()
    s = _EMAIL.sub(lambda m: m.group(0) if keep and m.group(0).lower() == keep else "[email]", s)
    s = _PHONE.sub(_phone_like, s)
    return s


def cut(text: str | None, cap: int) -> tuple[str, bool]:
    s = text or ""
    if len(s) <= cap:
        return s, False
    return s[:cap].rstrip() + "…", True


def context_summary(items: list[dict] | None, *, extra: str | None = None) -> dict | None:
    """{summary: "6 sources: 3 meetings, 2 pages, 1 file", items: [{kind, title, id, url}]} from
    the items a request sent (titles and ids only)."""
    items = [i for i in (items or []) if isinstance(i, dict)]
    if not items and not extra:
        return None
    counts: dict[str, int] = {}
    for i in items:
        k = str(i.get("kind") or "item")
        counts[k] = counts.get(k, 0) + 1
    words = {"page": ("page", "pages"), "document": ("document", "documents"), "file": ("file", "files"),
             "meeting": ("meeting", "meetings"), "guide": ("guide page", "guide pages"),
             "moment": ("transcript moment", "transcript moments"), "item": ("item", "items"),
             "doc": ("doc", "docs"), "fact": ("fact", "facts"), "section": ("section", "sections")}
    parts = [f"{n} {words.get(k, (k, k + 's'))[0 if n == 1 else 1]}" for k, n in sorted(counts.items(), key=lambda x: -x[1])]
    n = len(items)
    summary = (f"{n} source{'s' if n != 1 else ''}: " + ", ".join(parts)) if items else ""
    if extra:
        summary = f"{summary} · {extra}" if summary else extra
    keep = []
    for i in items[:CONTEXT_ITEMS]:
        keep.append({k: (str(v)[:200] if isinstance(v, str) else v) for k, v in i.items()
                     if k in ("kind", "title", "id", "url", "slug", "subtitle", "label") and v not in (None, "")})
    return {"summary": summary, "items": keep, "more": max(0, n - len(keep))}


def _citations(cites: list | None) -> list[dict]:
    out = []
    for c in (cites or [])[:60]:
        if not isinstance(c, dict):
            continue
        row = {k: c.get(k) for k in ("label", "n", "title", "url", "web_url", "kind", "slug", "subtitle", "moment",
                                      "quote", "page", "id") if c.get(k) not in (None, "")}
        if "title" not in row and c.get("text"):
            row["title"] = str(c["text"])[:200]
        if "url" not in row and c.get("href"):
            row["url"] = c["href"]
        if "quote" in row:
            row["quote"] = str(row["quote"])[:300]
        if "label" not in row and "n" in row:
            row["label"] = str(row["n"])
        out.append(row)
    return out


# ── Labels ────────────────────────────────────────────────────────────────────

KIND_LABELS: dict[str, dict[str, str]] = {
    "search_ai": {"ask": "Ask", "catch_up": "Catch up", "my_actions": "My action items", "page": "Ask this page",
                  "search": "AI search"},
    "meetings_ai": {"generate": "Meeting summary", "ask": "Meeting chat", "ask_all": "Ask meetings",
                    "check": "Meeting memory"},
    "workspace_memory": {"meeting": "Team memory", "page": "Team memory", "weekly": "Weekly summary"},
    "analytics_ai": {"story": "Analytics story", "ask": "Ask analytics", "gaps": "Content gaps",
                     "content": "Doc coach", "media": "Video coach", "pages": "PDF coach",
                     "versions": "Version compare"},
    "pages_ai": {"improve": "Improve", "shorten": "Shorten", "fix": "Fix spelling", "tone": "Change tone",
                 "translate": "Translate", "checklist": "Make a checklist", "table": "Make a table",
                 "explain": "Explain", "transform": "Rewrite", "write": "Write", "notes": "Notes to page",
                 "action_items": "Action items", "summary": "Summary", "ask": "Ask this page",
                 "meta": "Title & description", "alt": "Alt text", "translate_page": "Translate page",
                 "cover": "Cover image"},
    "docs_ask": {"ask": "Docs Ask"},
    "docs_editor": {"fix": "Guides fix draft", "improve": "Guides · Improve", "shorten": "Guides · Shorten",
                    "fix_grammar": "Guides · Fix grammar", "translate": "Guides · Translate", "ask": "Guides · Ask"},
    "ask_suggestions": {"workspace": "Ask suggestions"},
    "jira_ai": {"draft": "Jira draft"},
    "comments_ai": {"apply": "Comment → suggested edit", "summary": "Discussion summary", "ask": "@AI in a thread",
                    "tone": "Comment tone check"},
}

#: Features whose question and answer are kept whole (a conversation transcript).
CHAT = {("search_ai", "ask"), ("search_ai", "page"), ("search_ai", "catch_up"), ("search_ai", "my_actions"),
        ("search_ai", "search"), ("meetings_ai", "ask"), ("meetings_ai", "ask_all"), ("pages_ai", "ask"),
        ("docs_ask", "ask"), ("analytics_ai", "ask"), ("docs_editor", "ask"),
        ("comments_ai", "ask")}


def kind_of(feature: str, meta: dict) -> str:
    """The one kind word a row is labelled and grouped by."""
    if feature == "search_ai":
        return str(meta.get("ask") or "search")
    if feature in ("pages_ai", "docs_editor"):
        if meta.get("transform"):
            return str(meta["transform"])
        return str(meta.get("action") or meta.get("kind") or feature)
    if feature == "docs_ask":
        return "ask"
    return str(meta.get("kind") or meta.get("action") or feature)


def label_of(feature: str, kind: str, subject: str | None, *, public: bool = False) -> str:
    from app.services import ai_usage

    base = KIND_LABELS.get(feature, {}).get(kind)
    if base is None:
        fl = ai_usage.FEATURES.get(feature) or feature.replace("_", " ").capitalize()
        base = fl if kind in (feature, "", None) else f"{fl} · {kind.replace('_', ' ')}"
    if feature == "docs_ask" and public:
        base = "Docs Ask (public)"
    return f"{base} · {subject}" if subject else base


# ── Writing ───────────────────────────────────────────────────────────────────


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLL].create_index("ts", expireAfterSeconds=RETENTION_DAYS * 24 * 3600)
    await db[COLL].create_index([("conversation_id", 1), ("ts", 1)])
    await db[COLL].create_index([("actor", 1), ("ts", -1)])
    await db[COLL].create_index([("feature", 1), ("ts", -1)])
    await db[COLL].create_index([("user_id", 1), ("ts", -1)])
    await db[COLL].create_index([("workspace_id", 1), ("ts", -1)])
    await db[COLL].create_index([("thread_key", 1), ("user_id", 1), ("ts", -1)])


async def _follow_up_conversation(db: AsyncIOMotorDatabase, user_id: str | None, thread_key: str,
                                  ts: datetime) -> str | None:
    q: dict = {"thread_key": thread_key, "user_id": user_id, "ts": {"$gte": ts - FOLLOW_UP_WINDOW, "$lte": ts}}
    row = await db[COLL].find_one(q, {"conversation_id": 1}, sort=[("ts", -1)])
    return (row or {}).get("conversation_id")


async def write(db: AsyncIOMotorDatabase, row: dict, who: dict, log_in: dict | None) -> None:
    """One log row for one ledger row (``row`` as ai_usage.record wrote it, ``who`` from classify)."""
    log_in = dict(log_in or {})
    meta = row
    feature = row["feature"]
    ts = row["ts"]
    kind = log_in.pop("kind", None) or kind_of(feature, meta)
    conf = await settings(db)
    uinfo = await user_info(db, row.get("user_id")) if row.get("user_id") else {}
    ws_id = log_in.pop("workspace_id", None) or meta.get("workspace_id")
    ws_name = await workspace_name(db, ws_id) if ws_id else None
    subject = log_in.pop("subject", None)
    if subject is None and ws_name and feature not in ("docs_ask", "docs_editor"):
        subject = ws_name
    description = log_in.pop("description", None)
    public = who.get("actor_kind") == "public"
    doc: dict[str, Any] = {
        "ts": ts, "request_id": row["request_id"], "feature": feature, "kind": kind,
        "label": (log_in.pop("label", None) or label_of(feature, kind, subject, public=public))[:200],
        **{k: v for k, v in who.items()},
        "user_id": row.get("user_id"), "user_email": uinfo.get("email") or None, "user_name": uinfo.get("name") or None,
        "ip_hash": row.get("ip_hash"), "visitor": row.get("visitor"), "via": meta.get("via"), "site": meta.get("site"),
        "workspace_id": ws_id, "workspace_name": ws_name,
        "model": row.get("model"), "calls": row.get("calls"), "usage": row.get("usage"),
        "cost_usd": row.get("cost_usd"), "latency_ms": row.get("latency_ms"), "ttft_ms": row.get("ttft_ms"),
        "outcome": row.get("outcome"), "stop_reason": meta.get("stop_reason"), "error_code": meta.get("error_code"),
        "limit_reason": meta.get("limit_reason"),
        "scope_label": log_in.pop("scope_label", None),
        "results": log_in.pop("results", None),
        "actions": log_in.pop("actions", None),
        "slug": log_in.pop("slug", None) or meta.get("slug"),
        "page_title": log_in.pop("page_title", None),
    }
    if log_in.pop("backfilled", False):
        doc["backfilled"] = True   # rebuilt later from a saved conversation (scripts/backfill_ai_log.py)
    thread_key = log_in.pop("thread_key", None)
    follow_up = log_in.pop("follow_up", False)
    conv = log_in.pop("conversation_id", None)
    if conv is None and meta.get("conversation_id") and feature == "docs_ask":
        conv = f"d:{meta['conversation_id']}"
    if conv is None and thread_key:
        doc["thread_key"] = thread_key
        if follow_up:
            conv = await _follow_up_conversation(db, row.get("user_id"), thread_key, ts)
    chat = (feature, kind) in CHAT or bool(log_in.pop("chat", False))
    if description:
        doc["description"] = redact(description, keep_email=uinfo.get("email"))[:DESC_CAP]
    doc["content"] = conf["content"]
    if conf["content"]:
        keep = uinfo.get("email")
        inp = log_in.pop("input", None)
        if inp is None and feature == "docs_ask":
            inp = meta.get("question")
        out = log_in.pop("output", None)
        if out is None and feature == "docs_ask":
            out = meta.get("answer")
        if inp:
            doc["input"], cut_in = cut(redact(inp, keep_email=keep), CHAT_CAP if chat else INPUT_CAP)
            doc["input_truncated"] = cut_in
        sel = log_in.pop("selection", None)
        if sel:
            doc["selection"], _ = cut(redact(sel, keep_email=keep), INPUT_CAP)
        if out:
            doc["output"], cut_out = cut(redact(out, keep_email=keep), CHAT_CAP if chat else OUTPUT_CAP)
            doc["output_truncated"] = cut_out
        doc["output_format"] = log_in.pop("output_format", "markdown")
        cites = log_in.pop("citations", None)
        if cites is None and feature == "docs_ask":
            cites = meta.get("citations")
        if cites:
            doc["citations"] = _citations(cites)
        ctx = log_in.pop("context", None)
        if isinstance(ctx, list):
            ctx = context_summary(ctx)
        if ctx:
            doc["context"] = ctx
    else:
        for k in ("input", "output", "selection", "citations", "context", "output_format"):
            log_in.pop(k, None)
    first = doc.get("input") or doc.get("description") or ""
    doc["preview"] = " ".join(first.split())[:PREVIEW_CAP] or None
    doc = {k: v for k, v in doc.items() if v is not None}
    doc["expires_at"] = ts + timedelta(days=RETENTION_DAYS)
    update: dict[str, Any] = {"$set": doc}
    if conv:
        update["$set"]["conversation_id"] = conv
    else:
        update["$setOnInsert"] = {"conversation_id": f"r:{row['request_id']}"}
    await db[COLL].update_one({"_id": row["request_id"]}, update, upsert=True)


async def link(db: AsyncIOMotorDatabase, request_id: str | None, *, thread_id: str | None = None,
               conversation_id: str | None = None, scope_label: str | None = None,
               citations: list | None = None, answer: str | None = None) -> None:
    """A call joined a saved conversation (an Ask / assistant / meetings thread): group it there.
    Safe before or after the call's own row is written (an upsert; :func:`write` keeps it)."""
    if not request_id:
        return
    try:
        sets: dict[str, Any] = {}
        conv = conversation_id or (f"t:{thread_id}" if thread_id else None)
        if conv:
            sets["conversation_id"] = conv
        if scope_label:
            sets["scope_label"] = str(scope_label)[:200]
        if citations is not None and (await settings(db))["content"]:
            sets["citations"] = _citations(citations)
        if answer is not None and (await settings(db))["content"]:
            sets["output"], cut_out = cut(redact(answer), CHAT_CAP)
            sets["output_truncated"] = cut_out
        if not sets:
            return
        now = datetime.now(timezone.utc)
        await db[COLL].update_one({"_id": request_id}, {"$set": sets, "$setOnInsert": {
            "ts": now, "expires_at": now + timedelta(days=RETENTION_DAYS), "request_id": request_id}}, upsert=True)
    except Exception as exc:
        log.warning("ai log: linking %s failed: %s", request_id, type(exc).__name__)


# ── Backfill ──────────────────────────────────────────────────────────────────


async def backfill(db: AsyncIOMotorDatabase, *, limit_users: int = 5000) -> int:
    """Ledger rows written before actors existed get one: background features and visitor
    "system" → system; no account → public; an account → user (test when its email is on a test
    domain or the internal list). Idempotent: only rows without ``actor``. Returns rows changed."""
    from app.services import ai_usage

    R = db[ai_usage.REQUESTS]
    missing = {"actor": {"$exists": False}}
    n = 0
    for f, job in SYSTEM_FEATURES.items():
        res = await R.update_many({**missing, "feature": f}, {"$set": {
            "actor": "system", "actor_kind": "system", "test": False, "job": job}})
        n += res.modified_count
    # The weekly summary is team memory's too, under its own name.
    res = await R.update_many({"feature": "workspace_memory", "kind": "weekly", "job": "Team memory"},
                              {"$set": {"job": "Weekly summary"}})
    n += res.modified_count
    res = await R.update_many({**missing, "$or": [{"visitor": "system"}, {"via": "background"}, {"system": True}]},
                              {"$set": {"actor": "system", "actor_kind": "system", "test": False}})
    n += res.modified_count
    res = await R.update_many({**missing, "user_id": None},
                              {"$set": {"actor": "public", "actor_kind": "public", "test": False}})
    n += res.modified_count
    conf = await settings(db)
    ids = await R.distinct("user_id", {**missing, "user_id": {"$ne": None}})
    for uid in ids[:limit_users]:
        email = (await user_info(db, uid)).get("email") or ""
        reason = "test_domain" if test_email(email) else ("internal" if email and email.lower() in conf["internal_emails"] else None)
        base = {"actor_kind": "user", "test": bool(reason), "actor": "test" if reason else "user"}
        if reason:
            base["test_reason"] = reason
        api = await R.update_many({**missing, "user_id": uid, "via": "mcp"},
                                  {"$set": {**base, "actor_kind": "api", "actor": "test" if reason else "api"}})
        res = await R.update_many({**missing, "user_id": uid}, {"$set": base})
        n += api.modified_count + res.modified_count
    return n
