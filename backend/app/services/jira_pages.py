"""Jira inside pages: inline chips, issue cards, live lists, actions, and comment threads → issues
(owner 2026-11-09, ships with Comments).

**In the page's Markdown** (directives, like the page's other blocks; exports and MCP show them as
plain links, so the content stays portable):

    :jira[PAY-12]{site=acme.atlassian.net}                    an inline chip
    ::jira{key=PAY-12 site=acme.atlassian.net}                an issue card
    ::jira-list{jql="…" | project=PAY | filter=10042  site=… cols="status,assignee,due" limit=25 title="…"}

``site`` is the Jira host; without one, the page's workspace's Jira site.

**Privacy.** Live details (status, assignee, priority, sprint…) only for a signed-in viewer whose *own*
Atlassian connection can open the issue — one ``search/jql`` per site for every issue on the page, under
their token (``jira_links.viewer_issues``: visibility cached per person and issue for :data:`VIEW_TTL`,
details from ``jira_issues``, which webhooks keep fresh). Everyone else gets the stored snapshot
(``jira_snaps``): the key and title only, never status, assignee or description. An anonymous reader
costs no account lookup and no Jira call. A snapshot's title is written only under the token of someone
who can *edit* the page (they save it, or open it with the editor's rights), or by Jira's webhook for a
title it already had — a reader's own access never leaks into what other readers see.

**Lists** run their JQL (from the page's author) under the *viewer's* token, so nobody sees an issue
their own Jira wouldn't show them. A reader can run only the lists saved on the page (an editor may
preview a list before saving it). Pages of :data:`LIST_PAGE` with Jira's ``nextPageToken``; cached per
person and query for :data:`LIST_TTL`.

**Actions** (signed in, own connection; Jira's permissions decide, its refusal is shown as it is): any
transition of the issue's workflow (``expand=transitions.fields``: the screen's required fields are
offered and sent), assignee (``user/assignable/search``), a comment, title / priority / due date.
After each, the issue is read back (the cache) and every page showing it gets a live nudge
(``{"type": "jira", "keys": [...]}`` — keys only, already in those pages); each viewer re-reads under
their own token.

**Comment threads → issues** (``jira_thread_links``): "Create Jira issue" on a thread drafts it from
the thread (``jira_links.draft`` with the thread as the selected text, the AI draft + review flow) and
links the thread to it; the panel shows the issue, and resolving one offers to resolve the other.

Collections
    jira_snaps         _id "<doc_id>|<host>|<KEY>": doc_id, host, key, title, url, at, tried_at
    jira_thread_links  _id "<doc_id>|<thread_id>": doc_id, thread_id, host, cloud_id, key, title, url, created_by, created_at
    jira_list_cache    _id sha1: keys, next, expires_at (TTL)
"""

from __future__ import annotations

import hashlib
import html
import logging
import re
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any
from urllib.parse import quote

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import access, jira, jira_api

log = logging.getLogger("markdrop.jira")

SNAPS = "jira_snaps"
THREADS = "jira_thread_links"
LISTS = "jira_list_cache"

VIEW_TTL = timedelta(seconds=60)
LIST_TTL = timedelta(seconds=60)
SNAP_RETRY = timedelta(minutes=10)
MAX_REFS = 200
MAX_JQL = 1500
LIST_PAGE = 25
LIST_MAX = 100
COLS = ("status", "assignee", "priority", "type", "due", "sprint", "updated")
DEFAULT_COLS = ("status", "assignee", "priority", "due")
SEARCH_MAX = 10
COMMENT_MAX = 5000

KEY_RE = jira.KEY_RE
PROJECT_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,19}$")


def now_utc():
    return jira.now_utc()


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[SNAPS].create_index([("host", 1), ("key", 1)])
    await db[SNAPS].create_index("doc_id")
    await db[THREADS].create_index("doc_id")
    await db[THREADS].create_index([("host", 1), ("key", 1)])
    await db[LISTS].create_index("expires_at", expireAfterSeconds=0)


# ── The syntax ────────────────────────────────────────────────────────────────

_FENCE = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})")
_LEAF = re.compile(r"^[ \t]*::(jira-list|jira)(?:\[([^\]\n]*)\])?\{([^\n]*)\}[ \t]*$")
_CHIP = re.compile(r"(?<![A-Za-z0-9_:\\]):jira\[([^\]\n]*)\](?:\{([^}\n]*)\})?")
_ATTR = re.compile(r"""([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'}]+))|#([\w-]+)|(?<![\w-])([A-Za-z_][\w-]*)(?![\w-]*\s*=)""")


def host_of(value: str | None) -> str | None:
    """``acme.atlassian.net`` from a host, an address or a browse link; None when it isn't one."""
    v = (value or "").strip().lower()
    v = re.sub(r"^https?://", "", v).split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
    return v if re.match(r"^[a-z0-9][a-z0-9.-]{1,200}$", v) and "." in v else None


def parse_attrs(text: str | None) -> dict[str, str]:
    """A directive's ``{…}`` (without the braces): ``k=v``, ``k="v"`` (HTML entities decoded, as the
    editor writes them), ``#id``, a bare flag."""
    out: dict[str, str] = {}
    for m in _ATTR.finditer(text or ""):
        if m.group(1):
            v = next((g for g in (m.group(2), m.group(3), m.group(4)) if g is not None), "")
            out[m.group(1)] = html.unescape(v)
        elif m.group(5):
            out["id"] = m.group(5)
        elif m.group(6):
            out.setdefault(m.group(6), "")
    return out


def _q(v: str) -> str:
    return '"' + str(v).replace("&", "&amp;").replace('"', "&quot;").replace("\n", " ") + '"'


def chip_md(key: str, host: str | None) -> str:
    return f":jira[{key}]" + (f"{{site={host}}}" if host else "")


def card_md(key: str, host: str | None) -> str:
    return f"::jira{{key={key}" + (f" site={host}" if host else "") + "}"


def list_md(spec: dict, host: str | None) -> str:
    parts = []
    if spec.get("jql"):
        parts.append(f"jql={_q(spec['jql'])}")
    elif spec.get("project"):
        parts.append(f"project={spec['project']}")
    elif spec.get("filter"):
        parts.append(f"filter={spec['filter']}")
    if host:
        parts.append(f"site={host}")
    if spec.get("cols") and tuple(spec["cols"]) != DEFAULT_COLS:
        parts.append(f"cols={_q(','.join(spec['cols']))}")
    if spec.get("limit") and int(spec["limit"]) != LIST_PAGE:
        parts.append(f"limit={int(spec['limit'])}")
    if spec.get("title"):
        parts.append(f"title={_q(spec['title'])}")
    return "::jira-list{" + " ".join(parts) + "}"


def norm_key(v: str | None) -> str | None:
    k = (v or "").strip().upper()
    m = re.search(r"([A-Z][A-Z0-9_]{0,19}-[1-9][0-9]{0,8})$", k.rstrip("/"))
    return m.group(1) if m and KEY_RE.match(m.group(1)) else None


def list_spec(attrs: dict) -> dict | None:
    """A list block's query and layout from its attributes (or an API body), checked; None when it has none."""
    jql = re.sub(r"\s+", " ", str(attrs.get("jql") or "")).strip()[:MAX_JQL + 1]
    project = str(attrs.get("project") or "").strip().upper()
    flt = str(attrs.get("filter") or "").strip()
    spec: dict[str, Any] = {"jql": None, "project": None, "filter": None}
    if jql:
        if len(jql) > MAX_JQL:
            return None
        spec["jql"] = jql
    elif project and PROJECT_RE.match(project):
        spec["project"] = project
    elif flt and re.match(r"^[0-9]{1,12}$", flt):
        spec["filter"] = flt
    else:
        return None
    cols = attrs.get("cols")
    if isinstance(cols, str):
        cols = cols.split(",")
    picked = [c.strip() for c in (cols or []) if isinstance(c, str) and c.strip() in COLS]
    spec["cols"] = list(dict.fromkeys(picked)) or list(DEFAULT_COLS)
    try:
        limit = int(attrs.get("limit") or LIST_PAGE)
    except (TypeError, ValueError):
        limit = LIST_PAGE
    spec["limit"] = max(1, min(LIST_MAX, limit))
    title = re.sub(r"\s+", " ", str(attrs.get("title") or "")).strip()[:120]
    spec["title"] = title or None
    return spec


def spec_jql(spec: dict) -> str:
    if spec.get("jql"):
        return spec["jql"]
    if spec.get("project"):
        return f'project = "{spec["project"]}" ORDER BY updated DESC'
    return f"filter = {spec['filter']}"


def same_query(a: dict, b: dict) -> bool:
    return (a.get("jql"), a.get("project"), a.get("filter")) == (b.get("jql"), b.get("project"), b.get("filter"))


@dataclass
class Ref:
    kind: str                   # "chip" | "card" | "list"
    host: str | None
    key: str | None = None
    spec: dict | None = None
    attrs: dict = field(default_factory=dict)


def refs(content: str | None) -> list[Ref]:
    """The Jira chips, cards and lists in a page's Markdown, in order (code left alone)."""
    out: list[Ref] = []
    if not content or "jira" not in content:
        return out
    fence: str | None = None
    for line in content.split("\n"):
        fm = _FENCE.match(line)
        if fence is not None:
            if fm and fm.group(1)[0] == fence[0] and len(fm.group(1)) >= len(fence):
                fence = None
            continue
        if fm:
            fence = fm.group(1)
            continue
        if "jira" not in line:
            continue
        lm = _LEAF.match(line)
        if lm:
            a = parse_attrs(lm.group(3))
            if lm.group(1) == "jira":
                key = norm_key(a.get("key") or lm.group(2))
                if key:
                    out.append(Ref("card", host_of(a.get("site")), key=key, attrs=a))
            else:
                spec = list_spec(a)
                if spec:
                    out.append(Ref("list", host_of(a.get("site")), spec=spec, attrs=a))
            continue
        for m in _CHIP.finditer(line):
            a = parse_attrs(m.group(2))
            key = norm_key(a.get("key") or m.group(1))
            if key:
                out.append(Ref("chip", host_of(a.get("site")), key=key, attrs=a))
        if len(out) >= MAX_REFS:
            break
    return out[:MAX_REFS]


def link_text(key: str, title: str | None) -> str:
    return f"{key} · {title}" if title else key


def browse(host: str, key: str) -> str:
    return f"https://{host}/browse/{key}"


def search_url(host: str, jql: str) -> str:
    return f"https://{host}/issues/?jql={quote(jql)}"


# ── Sites ─────────────────────────────────────────────────────────────────────


async def default_host(db: AsyncIOMotorDatabase, raw: dict) -> str | None:
    """The page's workspace's Jira site, for chips written without ``site``."""
    if not raw.get("workspace_id"):
        return None
    site = await jira.site_for(db, raw.get("workspace_id"))
    return host_of((site or {}).get("url"))


def account_sites(row: dict | None) -> dict[str, dict]:
    """{host: {cloud_id, url, name}} for the sites a person's own connection reaches."""
    out = {}
    for s in (row or {}).get("sites") or []:
        h = host_of(s.get("url"))
        if h and s.get("id"):
            out[h] = {"cloud_id": s["id"], "url": (s.get("url") or "").rstrip("/"), "name": s.get("name")}
    return out


class NeedJira(HTTPException):
    """Signed in, but no (working) connection reaching that site: the UI offers "Connect Jira"."""

    def __init__(self, why: str):
        msg = {
            "not_configured": "Jira isn't set up on this Markdrop server yet.",
            "not_connected": "Connect your Atlassian account to see and change Jira issues here.",
            "broken": "Your Atlassian connection stopped working. Reconnect it to see and change Jira issues.",
            "no_site": "Your Atlassian account doesn't reach that Jira site.",
        }.get(why, "Connect your Atlassian account first.")
        super().__init__(status_code=409, detail=msg)
        self.why = why


async def site_as(db: AsyncIOMotorDatabase, user_id: str | None, host: str | None) -> dict:
    """The site at ``host`` as this person's connection reaches it; :class:`NeedJira` when it doesn't."""
    if not user_id:
        raise HTTPException(status_code=401, detail="Sign in to change Jira issues here.")
    if not jira.configured():
        raise NeedJira("not_configured")
    row = await jira.account(db, user_id)
    if row is None:
        raise NeedJira("not_connected")
    if row.get("broken"):
        raise NeedJira("broken")
    site = account_sites(row).get(host_of(host) or "")
    if site is None:
        raise NeedJira("no_site")
    return site


def _http(exc: jira_api.JiraError, *, doing: str = "") -> HTTPException:
    """Jira's refusal, shown plainly (its own words for a 400: a workflow's required field…)."""
    if exc.status == 400 and exc.reason:
        return HTTPException(status_code=422, detail=f"Jira didn't accept {doing or 'that'}: {exc.reason}"[:400])
    if exc.forbidden:
        return HTTPException(status_code=403, detail=f"Jira says you don't have permission to {doing or 'do that'}.")
    return jira._http(exc)


async def _call(db: AsyncIOMotorDatabase, user_id: str, site: dict, method: str, path: str, *, doing: str = "",
                body: Any = None, params: dict | None = None) -> Any:
    """A Jira call as the person; Jira's rate limit is respected (no call while it asked us to wait)."""
    if await jira.busy(db, site["cloud_id"]):
        raise HTTPException(status_code=429, detail="Jira is busy right now. Try again in a minute.")
    try:
        return await jira.call_as(db, user_id, site["cloud_id"], method, path, body=body, params=params)
    except jira.NotConnected as exc:
        raise NeedJira(exc.why)
    except jira_api.JiraError as exc:
        if exc.status == 429:
            await jira.backoff(db, site["cloud_id"], exc.retry_after)
        raise _http(exc, doing=doing)


# ── Readers ───────────────────────────────────────────────────────────────────


async def _readable(actor: access.Actor, raw: dict | None, ctx: access.Ctx) -> dict:
    if raw is None or raw.get("deleted_at") or not (await access.can(actor, raw, "read", ctx)).allowed:
        raise HTTPException(status_code=404, detail="Page not found")
    return raw


async def _can_edit(actor: access.Actor, raw: dict, ctx: access.Ctx) -> bool:
    if not actor.user_id:
        return False
    return (await access.can(actor, raw, "edit_content", ctx)).allowed


def _snap_id(doc_id: str, host: str, key: str) -> str:
    return f"{doc_id}|{host}|{key}"


async def page_items(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, raw: dict | None) -> dict:
    """The page's Jira chips and cards for this viewer: ``items`` keyed "<host>/<KEY>" with the
    snapshot (key, title, link) for everyone and ``issue`` (live details) only when the viewer's own
    connection can open it. Anonymous: snapshots only, no account lookup, no Jira call."""
    raw = await _readable(actor, raw, ctx)
    out: dict[str, Any] = {"configured": jira.configured(), "signed_in": bool(actor.user_id), "connected": False,
                           "broken": False, "can_edit": False, "default_site": None, "sites": [], "items": {},
                           "lists": 0}
    if raw.get("encrypted") or raw.get("kind") == "artifact":
        return out
    rs = refs(raw.get("content"))
    out["lists"] = sum(1 for r in rs if r.kind == "list")
    keyed = [r for r in rs if r.key]
    if not rs:
        return out
    default = await default_host(db, raw) if any(r.host is None for r in rs) else None
    out["default_site"] = default
    doc_id = str(raw["_id"])
    snaps = {(s["host"], s["key"]): s async for s in db[SNAPS].find({"doc_id": doc_id})}
    items: dict[str, dict] = {}
    for r in keyed:
        host = r.host or default
        if not host:
            continue
        snap = snaps.get((host, r.key)) or {}
        items[f"{host}/{r.key}"] = {"key": r.key, "site": host, "title": snap.get("title"),
                                    "url": browse(host, r.key), "issue": None}
    out["items"] = items
    if not actor.user_id or not jira.configured():
        return out
    row = await jira.account(db, actor.user_id)
    out["connected"] = bool(row and not row.get("broken"))
    out["broken"] = bool(row and row.get("broken"))
    out["can_edit"] = await _can_edit(actor, raw, ctx)
    if not out["connected"]:
        return out
    sites = account_sites(row)
    out["sites"] = sorted(sites)
    by_host: dict[str, list[str]] = {}
    for it in items.values():
        by_host.setdefault(it["site"], []).append(it["key"])
    from app.services import jira_links

    for host, keys in by_host.items():
        site = sites.get(host)
        if site is None:
            continue
        got = await jira_links.viewer_issues(db, actor.user_id, site, keys, ttl=VIEW_TTL)
        for key, it in got.items():
            items[f"{host}/{key}"]["issue"] = jira.public_issue(it)
            snap = snaps.get((host, key))
            if out["can_edit"] and it.get("summary") and (snap is None or not snap.get("title")):
                # An editor can open it: the snapshot readers see gets its title (as on a save).
                await _put_snap(db, doc_id, host, key, it["summary"])
                items[f"{host}/{key}"]["title"] = it["summary"]
    return out


async def _put_snap(db: AsyncIOMotorDatabase, doc_id: str, host: str, key: str, title: str | None) -> None:
    sets: dict[str, Any] = {"doc_id": doc_id, "host": host, "key": key, "at": now_utc(), "tried_at": now_utc()}
    if title is not None:
        sets["title"] = str(title)[:300]
    await db[SNAPS].update_one({"_id": _snap_id(doc_id, host, key)}, {"$set": sets}, upsert=True)


async def snapshots(db: AsyncIOMotorDatabase, raw: dict) -> tuple[dict[str, dict], str | None]:
    """({"<host>/<KEY>": {key, site, title, url}}, the default host) for exports and MCP: snapshots only."""
    rs = refs(raw.get("content"))
    if not rs:
        return {}, None
    default = await default_host(db, raw) if any(r.host is None for r in rs) else None
    snaps = {(s["host"], s["key"]): s async for s in db[SNAPS].find({"doc_id": str(raw["_id"])})}
    out = {}
    for r in rs:
        host = r.host or default
        if r.key and host:
            out[f"{host}/{r.key}"] = {"key": r.key, "site": host, "title": (snaps.get((host, r.key)) or {}).get("title"),
                                      "url": browse(host, r.key)}
    return out, default


def plain(ref: Ref, snaps: dict[str, dict], default: str | None) -> dict:
    """One chip, card or list as a plain link (exports, MCP): {as, key|jql, title, url, text, markdown}."""
    host = ref.host or default
    if ref.kind == "list":
        jql = spec_jql(ref.spec or {})
        title = (ref.spec or {}).get("title") or "Jira issues"
        url = search_url(host, jql) if host else None
        return {"as": "list", "jql": jql, "site": host, "title": title, "url": url, "text": f"{title}: {jql}",
                "markdown": f"[{_md(title)}: {_md(jql)}]({url})" if url else f"{_md(title)}: {_md(jql)}"}
    snap = snaps.get(f"{host}/{ref.key}") or {}
    text = link_text(ref.key or "", snap.get("title"))
    url = browse(host, ref.key or "") if host else None
    return {"as": ref.kind, "key": ref.key, "site": host, "title": snap.get("title"), "url": url, "text": text,
            "markdown": f"[{_md(text)}]({url})" if url else _md(text)}


def _md(s: str) -> str:
    return re.sub(r"([\\`*_\[\]<>|])", r"\\\1", s or "")


def plain_markdown(content: str, snaps: dict[str, dict], default: str | None) -> str:
    """The Markdown with every chip, card and list as a plain link (portable: any Markdown app reads it)."""
    if not content or "jira" not in content:
        return content or ""

    def one(kind: str, key: str | None, host: str | None, spec: dict | None = None) -> str:
        return plain(Ref(kind, host, key=key, spec=spec), snaps, default)["markdown"]

    lines = []
    fence: str | None = None
    for line in content.split("\n"):
        fm = _FENCE.match(line)
        if fence is not None:
            if fm and fm.group(1)[0] == fence[0] and len(fm.group(1)) >= len(fence):
                fence = None
            lines.append(line)
            continue
        if fm:
            fence = fm.group(1)
            lines.append(line)
            continue
        lm = _LEAF.match(line) if "jira" in line else None
        if lm:
            a = parse_attrs(lm.group(3))
            if lm.group(1) == "jira":
                key = norm_key(a.get("key") or lm.group(2))
                lines.append(one("card", key, host_of(a.get("site"))) if key else line)
            else:
                spec = list_spec(a)
                lines.append(one("list", None, host_of(a.get("site")), spec) if spec else line)
            continue

        def chip(m: re.Match) -> str:
            a = parse_attrs(m.group(2))
            key = norm_key(a.get("key") or m.group(1))
            return one("chip", key, host_of(a.get("site"))) if key else m.group(0)

        lines.append(_CHIP.sub(chip, line) if "jira" in line else line)
    return "\n".join(lines)


# ── Saves: the snapshots follow the page ──────────────────────────────────────


async def on_page_saved(db: AsyncIOMotorDatabase, before: dict | None, after: dict, actor) -> None:
    """After a save (``jira_links.on_page_saved``): snapshots for the issues now on the page (rows for
    ones that left are removed), titles fetched under the saver's own token in the background (they
    could edit the page). Never fails the save."""
    try:
        content = after.get("content") or ""
        doc_id = str(after["_id"])
        if "jira" not in content and "jira" not in ((before or {}).get("content") or ""):
            return
        rs = refs(content)
        default = await default_host(db, after) if any(r.host is None for r in rs) else None
        now_on = {(r.host or default, r.key) for r in rs if r.key and (r.host or default)}
        have = {(s["host"], s["key"]): s async for s in db[SNAPS].find({"doc_id": doc_id})}
        gone = [s["_id"] for k, s in have.items() if k not in now_on]
        if gone:
            await db[SNAPS].delete_many({"_id": {"$in": gone}})
        for host, key in now_on - set(have):
            await db[SNAPS].update_one({"_id": _snap_id(doc_id, host, key)}, {"$setOnInsert": {
                "doc_id": doc_id, "host": host, "key": key, "title": None, "at": now_utc()}}, upsert=True)
        retry = now_utc() - SNAP_RETRY
        need = [(h, k) for (h, k) in now_on
                if not (have.get((h, k)) or {}).get("title")
                and ((jira._aware((have.get((h, k)) or {}).get("tried_at")) or retry) <= retry)]
        uid = getattr(actor, "user_id", None)
        if need and uid:
            jira.spawn(capture(db, doc_id, uid, need))
    except Exception:
        log.warning("jira: the pages' save hook failed", exc_info=True)


async def capture(db: AsyncIOMotorDatabase, doc_id: str, user_id: str, pairs: list[tuple[str, str]]) -> int:
    """Titles for these snapshots, as ``user_id`` (an editor of the page) sees them: one search per site."""
    row = await jira.account(db, user_id)
    if row is None or row.get("broken"):
        return 0
    sites = account_sites(row)
    by_host: dict[str, list[str]] = {}
    for h, k in pairs:
        by_host.setdefault(h, []).append(k)
    n = 0
    for host, keys in by_host.items():
        site = sites.get(host)
        got: dict[str, dict] = {}
        if site is not None and not await jira.busy(db, site["cloud_id"]):
            try:
                got = await jira.visible_keys(db, user_id, site, keys)
            except (jira_api.JiraError, jira.NotConnected) as exc:
                if getattr(exc, "status", 0) == 429:
                    await jira.backoff(db, site["cloud_id"], getattr(exc, "retry_after", None))
                got = {}
        for k in keys:
            it = got.get(k)
            await _put_snap(db, doc_id, host, k, it.get("summary") if it else None)
            n += bool(it)
    return n


async def on_issue_changed(db: AsyncIOMotorDatabase, site_url: str | None, key: str, shaped: dict | None, *,
                           also: list[str] | None = None) -> int:
    """An issue changed (webhook, or an action from a page): snapshot titles follow (only ones an editor
    already approved: a row with a title), and every page showing it gets a live nudge to re-read."""
    from app.services import live

    host = host_of(site_url)
    if not host or not key:
        return 0
    doc_ids = set()
    async for s in db[SNAPS].find({"host": host, "key": key}, {"doc_id": 1, "title": 1}):
        doc_ids.add(s["doc_id"])
        if shaped and shaped.get("summary") and s.get("title") and s["title"] != shaped["summary"]:
            await db[SNAPS].update_one({"_id": s["_id"]}, {"$set": {"title": str(shaped["summary"])[:300], "at": now_utc()}})
    async for t in db[THREADS].find({"host": host, "key": key}, {"doc_id": 1, "title": 1}):
        doc_ids.add(t["doc_id"])
        if shaped and shaped.get("summary") and t.get("title") != shaped["summary"]:
            await db[THREADS].update_one({"_id": t["_id"]}, {"$set": {"title": str(shaped["summary"])[:300]}})
    slugs = set(also or [])
    oids = [ObjectId(d) for d in doc_ids if ObjectId.is_valid(d)]
    if oids:
        async for d in db["documents"].find({"_id": {"$in": oids}, "deleted_at": None}, {"slug": 1}):
            slugs.add(d["slug"])
    for slug in slugs:
        live.notify(slug, {"type": "jira", "keys": [key]})
    return len(slugs)


# ── Lists ─────────────────────────────────────────────────────────────────────


async def run_list(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, raw: dict | None, body: dict, *,
                   page_token: str | None = None) -> dict:
    """One page of a list block's issues, under the viewer's own token."""
    raw = await _readable(actor, raw, ctx)
    if not actor.user_id:
        raise HTTPException(status_code=401, detail="Sign in and connect Jira to see this list.")
    spec = list_spec(body)
    if spec is None:
        raise HTTPException(status_code=422, detail="Give the list a JQL query, a project key or a filter id "
                                                    f"(JQL up to {MAX_JQL} characters).")
    default = await default_host(db, raw)
    host = host_of(body.get("site")) or default
    if not host:
        raise HTTPException(status_code=422, detail="Say which Jira site the list is from.")
    if not await _can_edit(actor, raw, ctx):
        # Readers run only the lists the page's editors saved: the endpoint isn't a JQL proxy for any page.
        saved = [r for r in refs(raw.get("content")) if r.kind == "list"]
        if not any(same_query(r.spec or {}, spec) and (r.host or default) == host for r in saved):
            raise HTTPException(status_code=403, detail="That list isn't on this page.")
    site = await site_as(db, actor.user_id, host)
    jql = spec_jql(spec)
    limit = spec["limit"]
    ck = hashlib.sha1("|".join([actor.user_id, site["cloud_id"], jql, page_token or "", str(limit)]).encode()).hexdigest()
    hit = await db[LISTS].find_one({"_id": ck})
    issues: list[dict] | None = None
    nxt = None
    if hit is not None and (jira._aware(hit.get("expires_at")) or now_utc()) > now_utc():
        found = {r["key"]: r async for r in db[jira.ISSUES].find(
            {"_id": {"$in": [f"{site['cloud_id']}:{k}" for k in hit.get("keys") or []]}})}
        if all(k in found for k in hit.get("keys") or []):
            issues = [found[k] for k in hit.get("keys") or []]
            nxt = hit.get("next")
    if issues is None:
        req: dict[str, Any] = {"jql": jql, "fields": list(jira.ISSUE_FIELDS), "maxResults": limit}
        if page_token:
            req["nextPageToken"] = page_token[:2000]
        res = await _call(db, actor.user_id, site, "POST", "search/jql", body=req, doing="this list's query")
        issues = [jira.shape_issue(site["cloud_id"], site["url"], x) for x in (res or {}).get("issues") or []][:limit]
        await jira.store_issues(db, issues)
        nxt = None if (res or {}).get("isLast") else (res or {}).get("nextPageToken")
        await db[LISTS].update_one({"_id": ck}, {"$set": {"keys": [i["key"] for i in issues], "next": nxt,
                                                          "expires_at": now_utc() + LIST_TTL}}, upsert=True)
    return {"site": host, "jql": jql, "url": search_url(host, jql), "cols": spec["cols"], "title": spec["title"],
            "issues": [jira.public_issue(i) for i in issues], "next": nxt}


# ── Actions (as the viewer; Jira decides) ─────────────────────────────────────


async def _key(key: str) -> str:
    k = norm_key(key)
    if not k:
        raise HTTPException(status_code=422, detail="Give an issue key like PAY-123.")
    return k


async def _after(db: AsyncIOMotorDatabase, user_id: str, site: dict, key: str, slug: str | None) -> dict | None:
    """Read the issue back (the shared cache), update pages showing it, nudge them live."""
    from app.services import jira_links

    it = await jira_links._fetch(db, user_id, site, key)
    await on_issue_changed(db, site.get("url"), key, it, also=[slug] if slug else None)
    return jira.public_issue(it) if it else None


async def issue(db: AsyncIOMotorDatabase, user_id: str | None, host: str | None, key: str) -> dict:
    """One issue's live details for this person (fresh from Jira), and the site's priorities."""
    key = await _key(key)
    site = await site_as(db, user_id, host)
    raw = await _call(db, user_id, site, "GET", f"issue/{key}", params={"fields": ",".join(jira.ISSUE_FIELDS)},
                      doing=f"open {key}")
    it = jira.shape_issue(site["cloud_id"], site["url"], raw or {})
    await jira.store_issues(db, [it])
    return {"issue": jira.public_issue(it), "site": host_of(site["url"])}


def _field_meta(fid: str, meta: dict) -> dict:
    allowed = []
    for v in meta.get("allowedValues") or []:
        if isinstance(v, dict):
            name = v.get("name") or v.get("value")
            if name:
                allowed.append({"id": str(v.get("id") or name), "name": str(name)[:120]})
    schema = meta.get("schema") or {}
    return {"key": fid, "name": str(meta.get("name") or fid)[:120], "required": bool(meta.get("required")),
            "type": schema.get("type") or "string", "options": allowed[:100]}


async def transitions(db: AsyncIOMotorDatabase, user_id: str | None, host: str | None, key: str) -> dict:
    """Every step this person may take on the issue now (Jira's workflow), each with its screen's fields."""
    key = await _key(key)
    site = await site_as(db, user_id, host)
    res = await _call(db, user_id, site, "GET", f"issue/{key}/transitions", params={"expand": "transitions.fields"},
                      doing=f"see {key}'s workflow")
    out = []
    for t in (res or {}).get("transitions") or []:
        to = t.get("to") or {}
        fields = [_field_meta(fid, meta) for fid, meta in (t.get("fields") or {}).items() if isinstance(meta, dict)]
        out.append({"id": str(t.get("id")), "name": str(t.get("name") or to.get("name") or "")[:80],
                    "to": {"name": str(to.get("name") or "")[:80], "category": jira._cat(to)},
                    "fields": [f for f in fields if f["required"]] + [f for f in fields if not f["required"]][:6]})
    return {"key": key, "transitions": out}


def _value(meta: dict | None, v: Any) -> Any:
    """A form value as Jira's field wants it: an option by id (or name), a person, a date, text."""
    if v is None or v == "":
        return None
    if meta and meta.get("options"):
        opt = next((o for o in meta["options"] if o["id"] == str(v) or o["name"].lower() == str(v).lower()), None)
        return {"id": opt["id"]} if opt else {"name": str(v)[:120]}
    t = (meta or {}).get("type")
    if t == "user":
        return {"accountId": str(v)[:128]}
    if t == "array":
        return [{"name": str(x)[:120]} for x in (v if isinstance(v, list) else [v])][:20]
    if t == "number":
        try:
            return float(v)
        except (TypeError, ValueError):
            return None
    return str(v)[:2000]


async def transition(db: AsyncIOMotorDatabase, user_id: str | None, host: str | None, key: str, step: str, *,
                     fields: dict | None = None, slug: str | None = None) -> dict:
    """Take a workflow step: ``step`` is its id, its name, or the status it goes to ("Done")."""
    key = await _key(key)
    site = await site_as(db, user_id, host)
    avail = (await transitions(db, user_id, host, key))["transitions"]
    want = str(step or "").strip().lower()
    pick = (next((t for t in avail if t["id"] == str(step)), None)
            or next((t for t in avail if t["name"].lower() == want), None)
            or next((t for t in avail if t["to"]["name"].lower() == want), None))
    if pick is None:
        names = ", ".join(f"{t['name']} → {t['to']['name']}" for t in avail) or "none"
        raise HTTPException(status_code=422, detail=f"{key} has no step {step!r} for you now. Available: {names}."[:400])
    body: dict[str, Any] = {"transition": {"id": pick["id"]}}
    metas = {f["key"]: f for f in pick["fields"]}
    vals = {}
    for fid, v in (fields or {}).items():
        if fid in metas or re.match(r"^[a-z][A-Za-z0-9_]{0,60}$", fid):
            val = _value(metas.get(fid), v)
            if val is not None:
                vals[fid] = val
    missing = [f["name"] for f in pick["fields"] if f["required"] and f["key"] not in vals]
    if missing:
        raise HTTPException(status_code=422, detail=f"Jira needs {', '.join(missing)} for “{pick['name']}”.")
    if vals:
        body["fields"] = vals
    await _call(db, user_id, site, "POST", f"issue/{key}/transitions", body=body, doing=f"move {key} to {pick['to']['name'] or pick['name']}")
    log.info("jira: %s moved %s via %s", user_id, key, pick["name"])
    return {"key": key, "issue": await _after(db, user_id, site, key, slug), "transition": pick["name"]}


async def assignable(db: AsyncIOMotorDatabase, user_id: str | None, host: str | None, key: str, q: str) -> dict:
    key = await _key(key)
    site = await site_as(db, user_id, host)
    res = await _call(db, user_id, site, "GET", "user/assignable/search",
                      params={"issueKey": key, "query": (q or "").strip()[:100], "maxResults": 20}, doing="find people")
    people = []
    for u in res or []:
        if isinstance(u, dict) and u.get("accountId") and u.get("accountType", "atlassian") == "atlassian":
            people.append({"account_id": u["accountId"], "name": str(u.get("displayName") or "")[:120],
                           "avatar": (u.get("avatarUrls") or {}).get("48x48")})
    return {"people": people}


async def assign(db: AsyncIOMotorDatabase, user_id: str | None, host: str | None, key: str, account_id: str | None, *,
                 slug: str | None = None) -> dict:
    key = await _key(key)
    site = await site_as(db, user_id, host)
    await _call(db, user_id, site, "PUT", f"issue/{key}/assignee",
                body={"accountId": str(account_id)[:128] if account_id else None}, doing=f"assign {key}")
    return {"key": key, "issue": await _after(db, user_id, site, key, slug)}


def adf_text(text: str) -> dict:
    content = []
    for para in re.split(r"\n\s*\n", (text or "").strip()):
        lines = [ln for ln in para.split("\n") if ln.strip()]
        inner: list[dict] = []
        for i, ln in enumerate(lines):
            if i:
                inner.append({"type": "hardBreak"})
            inner.append({"type": "text", "text": ln[:COMMENT_MAX]})
        if inner:
            content.append({"type": "paragraph", "content": inner})
    return {"type": "doc", "version": 1, "content": content}


async def comment(db: AsyncIOMotorDatabase, user_id: str | None, host: str | None, key: str, text: str, *,
                  slug: str | None = None) -> dict:
    key = await _key(key)
    text = (text or "").strip()
    if not text:
        raise HTTPException(status_code=422, detail="Write the comment first.")
    if len(text) > COMMENT_MAX:
        raise HTTPException(status_code=422, detail=f"Keep it under {COMMENT_MAX} characters.")
    site = await site_as(db, user_id, host)
    res = await _call(db, user_id, site, "POST", f"issue/{key}/comment", body={"body": adf_text(text)},
                      doing=f"comment on {key}")
    return {"key": key, "comment_id": str((res or {}).get("id") or ""), "issue": await _after(db, user_id, site, key, slug)}


async def edit(db: AsyncIOMotorDatabase, user_id: str | None, host: str | None, key: str, changes: dict, *,
               slug: str | None = None) -> dict:
    """Title, priority, due date (``due: null`` clears it)."""
    from app.services import jira_ai

    key = await _key(key)
    f: dict[str, Any] = {}
    if "summary" in changes and changes["summary"] is not None:
        s = re.sub(r"\s+", " ", str(changes["summary"])).strip()[:jira_ai.SUMMARY_MAX]
        if not s:
            raise HTTPException(status_code=422, detail="The title can't be empty.")
        f["summary"] = s
    if changes.get("priority"):
        f["priority"] = {"name": str(changes["priority"])[:40]}
    if "due" in changes:
        if changes["due"] in (None, ""):
            f["duedate"] = None
        else:
            d = jira_ai._iso_day(changes["due"])
            if not d:
                raise HTTPException(status_code=422, detail="Give the due date as YYYY-MM-DD.")
            f["duedate"] = d
    if not f:
        raise HTTPException(status_code=422, detail="Nothing to change.")
    site = await site_as(db, user_id, host)
    await _call(db, user_id, site, "PUT", f"issue/{key}", body={"fields": f}, doing=f"edit {key}")
    return {"key": key, "issue": await _after(db, user_id, site, key, slug)}


async def priorities(db: AsyncIOMotorDatabase, user_id: str | None, host: str | None) -> dict:
    site = await site_as(db, user_id, host)
    return {"priorities": await jira.priorities(db, user_id, site["cloud_id"])}


async def search(db: AsyncIOMotorDatabase, user_id: str | None, host: str | None, q: str) -> dict:
    """The editor's issue picker: a key, words of a title, or (nothing typed) your recent issues."""
    site = await site_as(db, user_id, host)
    q = re.sub(r"\s+", " ", (q or "")).strip()[:120]
    key = norm_key(q) if q else None
    if key and re.match(r"^\s*(https?://\S+/browse/)?[A-Za-z][A-Za-z0-9_]{0,19}-\d+\s*$", q):
        jql = f"key = {key}"
    elif q:
        words = re.sub(r'["\\]', " ", q).strip()
        jql = f'text ~ "{words}*" ORDER BY updated DESC' if words else "ORDER BY updated DESC"
    else:
        jql = "assignee = currentUser() OR reporter = currentUser() ORDER BY updated DESC"
    try:
        res = await jira.call_as(db, user_id, site["cloud_id"], "POST", "search/jql",
                                 body={"jql": jql, "fields": list(jira.ISSUE_FIELDS), "maxResults": SEARCH_MAX})
    except jira.NotConnected as exc:
        raise NeedJira(exc.why)
    except jira_api.JiraError as exc:
        if exc.status in (400, 404):
            return {"issues": [], "site": host_of(site["url"])}
        if exc.status == 429:
            await jira.backoff(db, site["cloud_id"], exc.retry_after)
        raise _http(exc, doing="search")
    shaped = [jira.shape_issue(site["cloud_id"], site["url"], x) for x in (res or {}).get("issues") or []]
    await jira.store_issues(db, shaped)
    return {"issues": [jira.public_issue(i) for i in shaped], "site": host_of(site["url"])}


async def remember(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, raw: dict | None, host: str | None,
                   key: str) -> dict:
    """The editor just put an issue on the page: its snapshot (title as this editor sees it), so readers
    get "KEY · title" from the first save on."""
    raw = await _readable(actor, raw, ctx)
    if not await _can_edit(actor, raw, ctx):
        raise HTTPException(status_code=403, detail="You can add Jira issues to pages you can edit.")
    key = await _key(key)
    site = await site_as(db, actor.user_id, host)
    from app.services import jira_links

    got = await jira_links.viewer_issues(db, actor.user_id, site, [key], ttl=VIEW_TTL)
    it = got.get(key)
    if it is None:
        raise HTTPException(status_code=404, detail=f"Jira didn't find {key}, or you can't open it.")
    h = host_of(site["url"])
    await _put_snap(db, str(raw["_id"]), h, key, it.get("summary"))
    return {"key": key, "site": h, "title": it.get("summary"), "url": browse(h, key), "issue": jira.public_issue(it)}


# ── Comment threads → issues ──────────────────────────────────────────────────


async def _thread(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, raw: dict | None, thread_id: str,
                  *, write: bool) -> tuple[dict, dict]:
    from app.services.comments import perms

    raw = await _readable(actor, raw, ctx)
    ok = await (perms.can_comment if write else perms.can_view_comments)(db, actor, raw, ctx)
    if not ok:
        raise HTTPException(status_code=404 if not write else 403, detail="You can't see that discussion.")
    oid = ObjectId(thread_id) if ObjectId.is_valid(thread_id or "") else None
    t = await db["comment_threads"].find_one({"_id": oid, "doc_id": str(raw["_id"]), "deleted_at": None}) if oid else None
    if t is None:
        raise HTTPException(status_code=404, detail="That discussion isn't there any more.")
    return raw, t


async def thread_text(db: AsyncIOMotorDatabase, t: dict) -> str:
    """The discussion as the issue's source text: what it's about, then each message (names, no emails)."""
    anchor = t.get("anchor") or {}
    about = ((anchor.get("quote") or {}).get("exact") or anchor.get("block_text") or (t.get("original") or {}).get("exact") or "")
    parts = [f"Discussion about “{about.strip()[:400]}”:" if about.strip() else "Discussion on the page:"]
    async for m in db["comment_messages"].find({"thread_id": t["_id"], "deleted_at": None}).sort("created_at", 1).limit(30):
        body = re.sub(r"\s+", " ", m.get("body") or "").strip()
        if body:
            parts.append(f"{m.get('author_name') or 'Someone'}: {body[:600]}")
    return "\n".join(parts)[:3900]


async def thread_draft(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, raw: dict | None, thread_id: str,
                       project: str | None = None) -> dict:
    from app.services import jira_links

    raw, t = await _thread(db, actor, ctx, raw, thread_id, write=True)
    if await db[THREADS].find_one({"_id": f"{raw['_id']}|{t['_id']}"}):
        raise HTTPException(status_code=409, detail="That discussion already has a Jira issue.")
    return await jira_links.draft(db, actor, ctx, slug=raw["slug"], selection=await thread_text(db, t), project=project)


async def thread_create(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, raw: dict | None, thread_id: str,
                        fields: dict) -> dict:
    from app.services import jira_links, urls

    raw, t = await _thread(db, actor, ctx, raw, thread_id, write=True)
    tid = f"{raw['_id']}|{t['_id']}"
    if await db[THREADS].find_one({"_id": tid}):
        raise HTTPException(status_code=409, detail="That discussion already has a Jira issue.")
    made = await jira_links.create(db, actor, ctx, slug=raw["slug"], selection=await thread_text(db, t), fields=fields,
                                   back_url=urls.markdrop_url(raw["slug"]) + f"#c-{t['_id']}")
    site = await jira.site_for(db, raw.get("workspace_id"))
    return await _save_thread_link(db, raw, t, site or {}, made["key"], (made.get("issue") or {}).get("summary"),
                                   actor.user_id, made.get("issue"))


async def thread_link(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, raw: dict | None, thread_id: str,
                      key: str, host: str | None = None) -> dict:
    """Link a discussion to an issue that already exists (one the person's own Jira can open)."""
    from app.services import jira_links

    raw, t = await _thread(db, actor, ctx, raw, thread_id, write=True)
    key = await _key(key)
    host = host_of(host) or host_of(key if "/" in key else None) or await default_host(db, raw)
    site = await site_as(db, actor.user_id, host)
    got = await jira_links.viewer_issues(db, actor.user_id, site, [key], ttl=VIEW_TTL)
    if key not in got:
        raise HTTPException(status_code=404, detail=f"Jira didn't find {key}, or you can't open it.")
    return await _save_thread_link(db, raw, t, {"cloud_id": site["cloud_id"], "url": site["url"]}, key,
                                   got[key].get("summary"), actor.user_id, jira.public_issue(got[key]))


async def _save_thread_link(db, raw: dict, t: dict, site: dict, key: str, title: str | None, user_id: str | None,
                            issue: dict | None) -> dict:
    from app.services import live

    host = host_of(site.get("url"))
    row = {"doc_id": str(raw["_id"]), "thread_id": str(t["_id"]), "host": host, "cloud_id": site.get("cloud_id"),
           "key": key, "title": (title or None), "created_by": user_id, "created_at": now_utc()}
    await db[THREADS].update_one({"_id": f"{raw['_id']}|{t['_id']}"}, {"$set": row}, upsert=True)
    live.notify(raw["slug"], {"type": "jira", "keys": [key]})
    return {"thread_id": str(t["_id"]), "key": key, "site": host, "title": row["title"],
            "url": browse(host, key) if host else None, "issue": issue}


async def thread_unlink(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, raw: dict | None, thread_id: str) -> dict:
    raw, t = await _thread(db, actor, ctx, raw, thread_id, write=True)
    res = await db[THREADS].delete_one({"_id": f"{raw['_id']}|{t['_id']}"})
    return {"unlinked": bool(res.deleted_count)}


async def thread_links(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, raw: dict | None) -> dict:
    """{thread id: the linked issue} for the page's discussions this viewer can see: key and title for
    everyone who sees the discussion, live details only through their own Jira."""
    from app.services import jira_links
    from app.services.comments import perms

    raw = await _readable(actor, raw, ctx)
    if not await perms.can_view_comments(db, actor, raw, ctx):
        return {"threads": {}}
    rows = await db[THREADS].find({"doc_id": str(raw["_id"])}).to_list(length=500)
    out = {r["thread_id"]: {"thread_id": r["thread_id"], "key": r["key"], "site": r.get("host"), "title": r.get("title"),
                            "url": browse(r["host"], r["key"]) if r.get("host") else None, "issue": None}
           for r in rows}
    if actor.user_id and rows and jira.configured():
        row = await jira.account(db, actor.user_id)
        sites = account_sites(row) if row and not row.get("broken") else {}
        by_host: dict[str, list[str]] = {}
        for r in rows:
            if r.get("host") in sites:
                by_host.setdefault(r["host"], []).append(r["key"])
        for host, keys in by_host.items():
            got = await jira_links.viewer_issues(db, actor.user_id, sites[host], keys, ttl=VIEW_TTL)
            for r in rows:
                if r.get("host") == host and r["key"] in got:
                    out[r["thread_id"]]["issue"] = jira.public_issue(got[r["key"]])
    return {"threads": out}
