"""Jira issues made from (or linked to) things in Markdrop, and keeping both sides in step.

**Sources.** An item in a page — a meeting's action item, decision or open question, any list item
or paragraph with a block id (``{#b-…}``), text selected in a page — or a Team line (a blocker or
target, ``memory_facts``). :func:`source` reads it for the person asking, only when they can read
it now: the item's own line, its section, the page's (or meeting's) title and date, and the
transcript moment it cites (only when the transcript is readable too). Nothing else is sent to the
model or to Jira.

**Create** (:func:`draft` → review → :func:`create`): Haiku drafts the fields (services/jira_ai.py),
the person edits them in the review dialog, and the issue is created **as them** (their own
Atlassian connection: they are the reporter, Jira's permissions apply). The description is
Atlassian Document Format: their text, the item quoted, and "From <meeting> · <date> at 12:34"
linking back to the exact moment (or the page's block). An item without a block id gets one (a
quiet save) so the link has somewhere to live. The link (``jira_links``) is what pages show as a
live chip next to the item: key · status · assignee for viewers whose own connection can open the
issue, the key alone for everyone else.

**Two-way status sync** (to-dos with a linked issue):

* Ticked in Markdrop (the editor, view mode's quick tick, Home, Slack's Done button, MCP — every
  path saves through ``document.update_document``, which calls :func:`on_page_saved`): the issue is
  moved to a Done-category status **as the person who ticked it**; unticked: back to a To-do (else
  In-progress) status. No Atlassian connection, or no permission: nothing moves, and the chip says so
  (``sync.state`` "error" + why, with Retry).
* Moved in Jira (the webhook, services/jira.verify_webhook): into Done → the to-do is ticked on the
  page through the normal save path, quietly, as the Markdrop member who made the change in Jira
  (else the person who linked it) when they can edit the page; out of Done → unticked. Version
  history says "<name> via Jira".
* No echo: ``done`` (the page's last known state) and ``jira_done`` (Jira's) are stored on the link
  and updated *before* the write on the other side, so the webhook that reports our own transition,
  and the save hook that sees our own tick, find nothing to do. Webhook deliveries are de-duplicated.

Collection ``jira_links``: workspace_id, cloud_id, key, issue_id, doc_id, slug, block, fact_id, kind,
meeting_id, created_by, created_at, done, jira_done, sync {state, message, at}.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import secrets
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.services import access, jira, jira_ai, jira_api

log = logging.getLogger("markdrop.jira")

LINKS = "jira_links"
VIEWS = "jira_views"
VIEW_TTL = timedelta(minutes=5)
SELECTION_MAX = 4000
KINDS = ("action_item", "decision", "open_question", "item", "selection", "blocker", "target")
KIND_LABEL = {"action_item": "Action item", "decision": "Decision", "open_question": "Open question", "item": "Item",
              "selection": "Selected text", "blocker": "Blocker", "target": "Target"}
SECTIONS = {"action items": "action_item", "decisions": "decision", "open questions": "open_question"}

_BLOCK = re.compile(r"\{#(b-[0-9A-Za-z_-]+)[^}]*\}[ \t]*$")
_TASK = re.compile(r"^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\][ \t]")
_LIST = re.compile(r"^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?")
_CITE = re.compile(r"\s*\[(#?\d{1,4}|\d{1,2}:\d{2}(?::\d{2})?)\]\((/[^)\s]*#b-t\d+)\)")
_PERSON = re.compile(r':person\[([^\]\n]*)\]\{id="([0-9a-f]{24})"[^}]*\}')
_MDREF = re.compile(r":markdrop\[([^\]\n]*)\]\{[^}]*\}")
_LINK = re.compile(r"\[([^\]\n]*)\]\((?:[^)\s]+)\)")
_DUE = re.compile(r"\s+·\s+due\s+(.+)$", re.I)


def now_utc():
    return jira.now_utc()


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[LINKS].create_index([("doc_id", 1), ("block", 1)], unique=True,
                                 partialFilterExpression={"block": {"$type": "string"}})
    await db[LINKS].create_index([("cloud_id", 1), ("key", 1)])
    await db[LINKS].create_index("fact_id", sparse=True)
    await db[LINKS].create_index("workspace_id")
    await db[VIEWS].create_index("at", expireAfterSeconds=3600)
    from app.services import jira_pages

    await jira_pages.ensure_indexes(db)


# ── Reading an item ───────────────────────────────────────────────────────────


@dataclass
class Item:
    start: int                  # offsets of the line in the whole content
    end: int
    line: str
    block: str | None
    mark: str | None            # " " / "x" for a to-do, None otherwise
    text: str                   # plain text, mentions as names
    people: list[str] = field(default_factory=list)   # mentioned member ids, in order
    moment: dict | None = None  # {clock, path}
    section: str | None = None
    due: str | None = None


def _plain(line: str) -> tuple[str, list[str], dict | None, str | None]:
    people = [m.group(2) for m in _PERSON.finditer(line)]
    moment = None
    m = _CITE.search(line)
    if m:
        moment = {"clock": m.group(1), "path": m.group(2)}
    t = _BLOCK.sub("", line)
    t = _CITE.sub("", t)
    t = _LIST.sub("", t, count=1)
    t = _PERSON.sub(lambda x: x.group(1), t)
    t = _MDREF.sub(lambda x: x.group(1), t)
    t = _LINK.sub(lambda x: x.group(1), t)
    t = re.sub(r"\\([\\`*_\[\]<>|~$#:{}()!.+-])", r"\1", t)
    t = re.sub(r"(\*\*|__|~~|`)", "", t)
    t = re.sub(r"^#{1,6}\s+", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    due = None
    d = _DUE.search(t)
    if d:
        due = d.group(1).strip()
    return t, people, moment, due


def _body_start(content: str) -> int:
    from app.services import page_props

    _lines, body = page_props.split(content)
    return len(content) - len(body)


def item_at(content: str, *, block: str | None = None, offset: int | None = None) -> Item | None:
    """The line holding ``block`` (its ``{#…}``), or the line at ``offset`` in the page's body (what
    the renderer reports, after the front matter)."""
    content = content or ""
    if block:
        m = re.search(r"(?m)^.*\{#" + re.escape(block) + r"(?:[ \t][^}]*)?\}[ \t]*$", content)
        if not m:
            return None
        start, end = m.start(), m.end()
    elif offset is not None:
        at = _body_start(content) + max(0, int(offset))
        if at > len(content):
            return None
        start = content.rfind("\n", 0, at) + 1
        nl = content.find("\n", at)
        end = len(content) if nl < 0 else nl
    else:
        return None
    line = content[start:end]
    if not line.strip() or line.lstrip().startswith(("```", "---", ":::")):
        return None
    bm = _BLOCK.search(line)
    tm = _TASK.match(line)
    text, people, moment, due = _plain(line)
    if not text:
        return None
    # The section: the nearest "## " heading above.
    section = None
    for prev in reversed(content[:start].split("\n")):
        h = re.match(r"^#{1,3}\s+(.*?)\s*(\{#[^}]*\})?\s*$", prev)
        if h:
            section = h.group(1).strip()
            break
    return Item(start, end, line, bm.group(1) if bm else None, (tm.group(1).lower() if tm else None), text,
                people, moment, section, due)


def todo_mark(content: str, block: str) -> bool | None:
    """True / False for the to-do ``block`` (ticked or not), None when it isn't a to-do (any more)."""
    it = item_at(content, block=block)
    if it is None or it.mark is None:
        return None
    return it.mark == "x"


def _kind_for(it: Item, raw: dict) -> str:
    sec = (it.section or "").strip().lower()
    if raw.get("meeting_id") and sec in SECTIONS:
        return SECTIONS[sec]
    if it.mark is not None:
        return "action_item"
    return "item"


# ── Sources ───────────────────────────────────────────────────────────────────


async def _page(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, slug: str) -> dict:
    raw = await db["documents"].find_one({"slug": slug, "deleted_at": None})
    if raw is None or not (await access.can(actor, raw, "read", ctx)).allowed:
        raise HTTPException(status_code=404, detail="That page isn't there any more.")
    if raw.get("encrypted") or raw.get("kind") == "artifact":
        raise HTTPException(status_code=422, detail="Jira issues can be made from pages and meetings only.")
    return raw


async def _site_or_409(db: AsyncIOMotorDatabase, workspace_id: str | None) -> dict:
    jira.need_configured()
    site = await jira.site_for(db, workspace_id)
    if site is None:
        raise HTTPException(status_code=409, detail="This workspace isn't connected to Jira. A workspace admin "
                                                    "connects it in Workspace settings › Integrations › Jira.")
    return site


def _limited(raw: dict) -> bool:
    """Not everyone in the workspace can open it (restricted to people, or a password)."""
    return (raw.get("access_level") == "private") or bool(raw.get("read_password_hash"))


async def source(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, *, slug: str | None = None,
                 block: str | None = None, offset: int | None = None, selection: str | None = None,
                 fact_id: str | None = None) -> dict:
    """What an issue would be made from, read for ``actor`` now (404 when they can't read it)."""
    from app.services import meetings, urls

    if fact_id:
        return await _fact_source(db, actor, ctx, fact_id)
    if not slug:
        raise HTTPException(status_code=422, detail="Say which page the item is on.")
    raw = await _page(db, actor, ctx, slug)
    content = raw.get("content") or ""
    out: dict[str, Any] = {"slug": raw["slug"], "doc_id": str(raw["_id"]), "workspace_id": raw.get("workspace_id"),
                           "title": raw.get("title") or "Untitled", "meeting": None, "moment": None,
                           "restricted": _limited(raw), "people": [], "due": None, "fact_id": None}
    if raw.get("meeting_id"):
        row = await meetings.get_row(db, raw["meeting_id"])
        if row is not None:
            out["meeting"] = {"id": str(row["_id"]), "title": row.get("series") or row.get("title") or raw.get("title"),
                              "date": row.get("date"), "date_label": meetings.fmt_date(row.get("date"))}
    if selection is not None:
        text = re.sub(r"\s+", " ", selection).strip()[:SELECTION_MAX]
        if not text:
            raise HTTPException(status_code=422, detail="Select some text first.")
        it = item_at(content, block=block) if block else (item_at(content, offset=offset) if offset is not None else None)
        out.update(kind="selection", text=text, block=it.block if it else None, section=it.section if it else None,
                   offset=offset if it and not it.block else None, mark=None)
    else:
        it = item_at(content, block=block, offset=offset)
        if it is None:
            raise HTTPException(status_code=404, detail="That item was changed or removed on the page.")
        out.update(kind=_kind_for(it, raw), text=it.text, block=it.block, section=it.section,
                   offset=offset if not it.block else None, mark=it.mark, people=it.people, due=it.due)
        if it.moment and raw.get("meeting_id"):
            # The moment link only when the transcript is readable by this person too.
            tslug = it.moment["path"].lstrip("/").split("#", 1)[0]
            t = await db["documents"].find_one({"slug": tslug, "deleted_at": None}, {"content": 0})
            if t is not None and (await access.can(actor, t, "read", ctx)).allowed:
                out["moment"] = {"clock": it.moment["clock"], "url": urls.markdrop_url(tslug) + "#" + it.moment["path"].split("#", 1)[1]}
    out["url"] = urls.markdrop_url(raw["slug"]) + (f"#{out['block']}" if out.get("block") else "")
    return out


async def _fact_source(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, fact_id: str) -> dict:
    from app.services import urls, workspace_memory as wm

    oid = wm._oid(fact_id)
    f = await db[wm.FACTS].find_one({"_id": oid}) if oid else None
    if f is None or f.get("kind") not in ("blocker", "target", "action_item", "working_on"):
        raise HTTPException(status_code=404, detail="That line isn't on Team any more.")
    from app.services import workspace as ws_service

    if not await ws_service.role_for(db, f["workspace_id"], actor.user_id):
        raise HTTPException(status_code=404, detail="That line isn't on Team any more.")
    first = None
    for s in f.get("sources") or []:
        d = await db["documents"].find_one({"_id": wm._oid(s.get("doc_id"))}, {"content": 0})
        if d is not None and not d.get("deleted_at") and (await access.can(actor, d, "read", ctx)).allowed:
            first = d
            break
    if first is None:
        raise HTTPException(status_code=404, detail="That line isn't on Team any more.")
    text = (f.get("correction") or {}).get("text") or f.get("text") or ""
    people = [f["subject"]] if f.get("subject_type", "person") == "person" and wm._oid(f.get("subject")) else []
    due = f.get("due")
    return {"slug": first["slug"], "doc_id": None, "workspace_id": f["workspace_id"], "title": first.get("title"),
            "meeting": None, "moment": None, "restricted": _limited(first), "people": people,
            "due": due.isoformat()[:10] if hasattr(due, "isoformat") else (str(due)[:10] if due else None),
            "fact_id": str(f["_id"]), "kind": "blocker" if f["kind"] == "blocker" else ("target" if f["kind"] == "target" else "item"),
            "text": text, "block": None, "section": "Team", "offset": None, "mark": None,
            "url": urls.markdrop_url(first["slug"])}


# ── Drafts ────────────────────────────────────────────────────────────────────


async def _meta(db: AsyncIOMotorDatabase, user_id: str, site: dict, project: str | None) -> dict:
    """What the review dialog offers: projects, issue types, priorities (from Jira, as the person)."""
    proj = project or site.get("default_project")
    try:
        projects = await jira.projects(db, user_id, site["cloud_id"])
    except HTTPException:
        projects = [{"key": k, "name": k} for k in site.get("projects") or []]
    follow = set(site.get("projects") or [])
    projects.sort(key=lambda p: (p["key"] not in follow, p["name"].lower()))
    if proj and not any(p["key"] == proj for p in projects):
        proj = projects[0]["key"] if projects else proj
    types = []
    if proj:
        try:
            types = await jira.issue_types(db, user_id, site["cloud_id"], proj)
        except HTTPException:
            types = []
    prios = await jira.priorities(db, user_id, site["cloud_id"])
    return {"projects": projects[:100], "project": proj, "issue_types": types or [{"id": "", "name": site.get("default_issue_type") or "Task"}],
            "priorities": prios}


async def _people(db: AsyncIOMotorDatabase, workspace_id: str, site: dict, user_id: str) -> list[dict]:
    from app.services import workspace as ws_service

    members = await ws_service.mention_people(db, workspace_id, viewer_id=None, emails=False)
    accounts = await jira.member_accounts(db, workspace_id, site["cloud_id"], lookup_as=user_id)
    return [{"user_id": m["id"], "name": m.get("name") or "Someone", "account_id": accounts.get(m["id"])} for m in members]


def _assignee(src: dict, d: dict, people: list[dict]) -> dict | None:
    by_id = {p["user_id"]: p for p in people}
    for uid in src.get("people") or []:
        p = by_id.get(uid)
        if p is not None and p.get("account_id"):
            return p
    if d.get("assignee_name"):
        p = next((x for x in people if x["name"].lower() == d["assignee_name"].lower()), None)
        if p is not None and p.get("account_id"):
            return p
    return None


def _due_from(src: dict) -> str | None:
    return jira_ai._iso_day(src.get("due"))


async def _need_me(db: AsyncIOMotorDatabase, user_id: str | None, site: dict) -> None:
    try:
        await jira.access_token(db, user_id, site["cloud_id"])
    except jira.NotConnected as exc:
        raise jira.not_connected(exc)


def _notice(src: dict) -> str | None:
    if src.get("restricted"):
        return ("This page is restricted: the link in the issue only opens for people who can open it in Markdrop. "
                "The text you put in the issue is visible to everyone who can see the issue in Jira.")
    return None


async def draft(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, *, slug: str | None = None,
                block: str | None = None, offset: int | None = None, selection: str | None = None,
                fact_id: str | None = None, project: str | None = None) -> dict:
    src = await source(db, actor, ctx, slug=slug, block=block, offset=offset, selection=selection, fact_id=fact_id)
    site = await _site_or_409(db, src["workspace_id"])
    await _need_me(db, actor.user_id, site)
    meta = await _meta(db, actor.user_id, site, project)
    people = await _people(db, src["workspace_id"], site, actor.user_id)
    d = await jira_ai.draft(db, actor.user_id, src["workspace_id"], src, {
        "issue_types": [t["name"] for t in meta["issue_types"]], "priorities": [p["name"] for p in meta["priorities"]],
        "members": [p["name"] for p in people]})
    return _draft_out(src, d, meta, people, site)


def _draft_out(src: dict, d: dict, meta: dict, people: list[dict], site: dict) -> dict:
    who = _assignee(src, d, people)
    existing = None
    return {
        "source": {k: src.get(k) for k in ("slug", "block", "offset", "fact_id", "kind", "text", "title", "url",
                                           "restricted", "mark")}
                  | {"meeting": src.get("meeting"), "moment": src.get("moment"), "kind_label": KIND_LABEL.get(src["kind"], "Item")},
        "draft": {"project": meta["project"], "issue_type": d["issue_type"], "summary": d["summary"],
                  "description": d["description"], "priority": d.get("priority"),
                  "assignee": ({"user_id": who["user_id"], "name": who["name"], "account_id": who["account_id"]} if who else None),
                  "due": d.get("due") or _due_from(src), "labels": d.get("labels") or []},
        "ai": bool(d.get("ai")), "note": d.get("note"), "notice": _notice(src), "existing": existing,
        "meta": {"projects": meta["projects"], "issue_types": meta["issue_types"], "priorities": meta["priorities"],
                 "people": [p for p in people if p.get("account_id")], "site": {"name": site.get("name"), "url": site.get("url")},
                 "backlink": backlink_text(src)},
    }


def backlink_text(src: dict) -> str:
    m = src.get("meeting")
    if m:
        s = f"From {m.get('title') or 'a meeting'}"
        if m.get("date_label"):
            s += f" · {m['date_label']}"
        if src.get("moment"):
            s += f" at {src['moment']['clock']}"
        return s
    return f"From {src.get('title') or 'a page'} in Markdrop"


async def draft_all(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, slug: str,
                    project: str | None = None) -> dict:
    """Drafts for every open action item (an unticked to-do with no issue yet) on a page, one AI call."""
    raw = await _page(db, actor, ctx, slug)
    site = await _site_or_409(db, raw.get("workspace_id"))
    await _need_me(db, actor.user_id, site)
    content = raw.get("content") or ""
    linked = {x["block"] async for x in db[LINKS].find({"doc_id": str(raw["_id"])}, {"block": 1}) if x.get("block")}
    blocks = []
    for m in re.finditer(r"(?m)^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+\[ \][ \t].*\{#(b-[0-9A-Za-z_-]+)[^}]*\}[ \t]*$", content):
        if m.group(1) not in linked:
            blocks.append(m.group(1))
    srcs = []
    for b in blocks[:jira_ai.BULK_MAX]:
        try:
            srcs.append(await source(db, actor, ctx, slug=slug, block=b))
        except HTTPException:
            continue
    meta = await _meta(db, actor.user_id, site, project)
    people = await _people(db, raw.get("workspace_id"), site, actor.user_id)
    drafts = await jira_ai.draft_many(db, actor.user_id, raw.get("workspace_id"), srcs, {
        "issue_types": [t["name"] for t in meta["issue_types"]], "priorities": [p["name"] for p in meta["priorities"]],
        "members": [p["name"] for p in people]})
    items = [_draft_out(s, d, meta, people, site) for s, d in zip(srcs, drafts)]
    return {"items": items, "skipped": len(linked), "more": max(0, len(blocks) - jira_ai.BULK_MAX),
            "meta": items[0]["meta"] if items else {"projects": meta["projects"], "issue_types": meta["issue_types"],
                                                   "priorities": meta["priorities"], "people": [p for p in people if p.get("account_id")],
                                                   "site": {"name": site.get("name"), "url": site.get("url")}}}


# ── Create ────────────────────────────────────────────────────────────────────


def adf(description: str, quote: str | None, back_text: str, back_url: str | None) -> dict:
    """Atlassian Document Format: the person's text (paragraphs), the item quoted, the link back."""
    content: list[dict] = []
    for para in re.split(r"\n\s*\n", (description or "").strip()):
        lines = [ln for ln in para.split("\n") if ln.strip()]
        if not lines:
            continue
        inner: list[dict] = []
        for i, ln in enumerate(lines):
            if i:
                inner.append({"type": "hardBreak"})
            inner.append({"type": "text", "text": ln[:2000]})
        content.append({"type": "paragraph", "content": inner})
    if quote:
        content.append({"type": "blockquote", "content": [{"type": "paragraph", "content": [
            {"type": "text", "text": quote[:2000]}]}]})
    back = {"type": "text", "text": back_text[:300]}
    if back_url:
        back["marks"] = [{"type": "link", "attrs": {"href": back_url}}]
    content.append({"type": "paragraph", "content": [back]})
    return {"type": "doc", "version": 1, "content": content}


async def _ensure_block(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, slug: str,
                        offset: int | None) -> str | None:
    """Give the item at ``offset`` a block id (a quiet save as the person), when they may edit the page."""
    from app.services import meetings, pages

    if offset is None:
        return None
    for _attempt in range(3):
        raw = await db["documents"].find_one({"slug": slug, "deleted_at": None})
        if raw is None or not (await access.can(actor, raw, "edit_content", ctx)).allowed:
            return None
        content = raw.get("content") or ""
        it = item_at(content, offset=offset)
        if it is None:
            return None
        if it.block:
            return it.block
        bid = "b-" + secrets.token_hex(4)
        new = content[:it.end].rstrip() + f" {{#{bid}}}" + content[it.end:]
        try:
            await pages.check_page_lock(raw, actor, ctx, new)
            await meetings._save(db, raw, new, actor, ctx, base_rev=int(raw.get("rev") or 1))
            return bid
        except HTTPException as exc:
            if exc.status_code == 409:
                continue
            return None
    return None


async def create(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, *, slug: str | None = None,
                 block: str | None = None, offset: int | None = None, selection: str | None = None,
                 fact_id: str | None = None, fields: dict, back_url: str | None = None) -> dict:
    """Create the issue as the person, from the reviewed fields, and link it to the item.
    ``back_url``: where the issue's "From …" line links (default: the item; a comment thread's own link)."""
    src = await source(db, actor, ctx, slug=slug, block=block, offset=offset, selection=selection, fact_id=fact_id)
    site = await _site_or_409(db, src["workspace_id"])
    await _need_me(db, actor.user_id, site)
    if src.get("block") and src.get("doc_id"):
        dup = await db[LINKS].find_one({"doc_id": src["doc_id"], "block": src["block"]})
        if dup is not None and src["kind"] != "selection":
            raise HTTPException(status_code=409, detail=f"That item already has a Jira issue ({dup['key']}).")
    summary = re.sub(r"\s+", " ", str(fields.get("summary") or "")).strip()[:jira_ai.SUMMARY_MAX]
    if not summary:
        raise HTTPException(status_code=422, detail="Give the issue a summary.")
    from app.services import teams as teams_service

    # Teams: an item of a team with Jira projects files into the team's first one by default.
    team_default = await teams_service.jira_default(db, src.get("slug")) if not fields.get("project") else None
    project = str(fields.get("project") or team_default or site.get("default_project") or "").strip().upper()
    if not re.match(r"^[A-Z][A-Z0-9_]{0,19}$", project):
        raise HTTPException(status_code=422, detail="Pick a Jira project.")
    issue_type = str(fields.get("issue_type") or site.get("default_issue_type") or "Task").strip()[:60]
    quote = src["text"] if src["kind"] != "selection" else src["text"][:1500]
    back_url = back_url or (src.get("moment") or {}).get("url") or src.get("url")
    jf: dict[str, Any] = {
        "project": {"key": project}, "summary": summary, "issuetype": {"name": issue_type},
        "description": adf(str(fields.get("description") or "")[:jira_ai.DESC_MAX], quote, backlink_text(src), back_url),
    }
    if fields.get("priority"):
        jf["priority"] = {"name": str(fields["priority"])[:40]}
    acc = fields.get("assignee_account_id")
    if not acc and fields.get("assignee_user_id"):
        accounts = await jira.member_accounts(db, src["workspace_id"], site["cloud_id"], lookup_as=actor.user_id)
        acc = accounts.get(str(fields["assignee_user_id"]))
    if acc:
        jf["assignee"] = {"accountId": str(acc)[:128]}
    due = jira_ai._iso_day(fields.get("due"))
    if due:
        jf["duedate"] = due
    labels = [jira_ai.LABEL_RE.sub("-", str(x).strip().lower()).strip("-")[:40] for x in fields.get("labels") or []]
    labels = [x for x in dict.fromkeys(labels) if x][:10]
    if labels:
        jf["labels"] = labels
    try:
        made = await jira.call_as(db, actor.user_id, site["cloud_id"], "POST", "issue", body={"fields": jf})
    except jira.NotConnected as exc:
        raise jira.not_connected(exc)
    except jira_api.JiraError as exc:
        if exc.status == 400 and ("priority" in exc.reason or "duedate" in exc.reason) and (jf.pop("priority", None) or jf.pop("duedate", None)):
            # The project's screen doesn't take that field: create without it (the person still gets the issue).
            try:
                made = await jira.call_as(db, actor.user_id, site["cloud_id"], "POST", "issue", body={"fields": jf})
            except jira_api.JiraError as exc2:
                raise jira._http(exc2)
        else:
            raise jira._http(exc)
    key = str((made or {}).get("key") or "")
    if not key:
        raise HTTPException(status_code=502, detail="Jira didn't say which issue it made.")
    issue = await _fetch(db, actor.user_id, site, key)
    bid = src.get("block")
    if not bid and src.get("offset") is not None and src["kind"] != "selection":
        bid = await _ensure_block(db, actor, ctx, src["slug"], src["offset"])
    link = None
    if src.get("fact_id") or (bid and src.get("doc_id") and src["kind"] != "selection"):
        link = await _save_link(db, src, site, key, str((made or {}).get("id") or ""), actor.user_id, bid)
        await jira.cover_project(db, src["workspace_id"], project)
    log.info("jira: %s created %s from %s", actor.user_id, key, src["kind"])
    return {"key": key, "url": jira.browse_url(site.get("url"), key), "issue": jira.public_issue(issue) if issue else None,
            "link": link_view(link, issue, True) if link else None}


async def _fetch(db: AsyncIOMotorDatabase, user_id: str, site: dict, key: str) -> dict | None:
    try:
        raw = await jira.call_as(db, user_id, site["cloud_id"], "GET", f"issue/{key}",
                                 params={"fields": ",".join(jira.ISSUE_FIELDS)})
    except (jira_api.JiraError, jira.NotConnected):
        return None
    it = jira.shape_issue(site["cloud_id"], site.get("url"), raw or {})
    await jira.store_issues(db, [it])
    await _seen(db, user_id, site["cloud_id"], [key], {key})
    return it


async def _save_link(db: AsyncIOMotorDatabase, src: dict, site: dict, key: str, issue_id: str, user_id: str,
                     block: str | None) -> dict:
    mark = None
    if block and src.get("doc_id"):
        raw = await db["documents"].find_one({"_id": ObjectId(src["doc_id"])}, {"content": 1})
        mark = todo_mark((raw or {}).get("content") or "", block)
    issue = await db[jira.ISSUES].find_one({"_id": f"{site['cloud_id']}:{key}"}) or {}
    jira_done = (issue.get("status") or {}).get("category") == "done" if issue else None
    row = {"workspace_id": src["workspace_id"], "cloud_id": site["cloud_id"], "key": key, "issue_id": issue_id,
           "doc_id": src.get("doc_id"), "slug": src.get("slug"), "block": block, "fact_id": src.get("fact_id"),
           "kind": src["kind"], "meeting_id": (src.get("meeting") or {}).get("id"), "created_by": user_id,
           "created_at": now_utc(), "done": mark, "jira_done": jira_done, "sync": {"state": "ok", "message": None, "at": now_utc()}}
    try:
        res = await db[LINKS].insert_one(row)
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail="That item already has a Jira issue.")
    row["_id"] = res.inserted_id
    if mark is not None and jira_done is not None and mark != jira_done:
        # Linked to an issue whose state differs from the to-do: the page follows Jira.
        jira.spawn(_follow_jira(db, row, jira_done, None))
    return row


async def link_existing(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, *, slug: str | None,
                        block: str | None, offset: int | None, key: str, fact_id: str | None = None) -> dict:
    """Link an issue that already exists to an item (the person's connection must be able to open it)."""
    key = (key or "").strip().upper()
    m = re.search(r"([A-Z][A-Z0-9_]{0,19}-[1-9][0-9]{0,8})\s*$", key.rstrip("/"))
    if not m:
        raise HTTPException(status_code=422, detail="Give an issue key like PAY-123 (or its Jira link).")
    key = m.group(1)
    src = await source(db, actor, ctx, slug=slug, block=block, offset=offset, fact_id=fact_id)
    site = await _site_or_409(db, src["workspace_id"])
    await _need_me(db, actor.user_id, site)
    if src.get("doc_id"):
        raw = await db["documents"].find_one({"_id": ObjectId(src["doc_id"])})
        if raw is None or not (await access.can(actor, raw, "edit_content", ctx)).allowed:
            raise HTTPException(status_code=403, detail="You can link issues to items on pages you can edit.")
    issue = await _fetch(db, actor.user_id, site, key)
    if issue is None:
        raise HTTPException(status_code=404, detail=f"Jira didn't find {key}, or you can't open it.")
    bid = src.get("block") or await _ensure_block(db, actor, ctx, src["slug"], src.get("offset"))
    if not bid and not src.get("fact_id"):
        raise HTTPException(status_code=409, detail="Markdrop couldn't mark that item on the page. Try again.")
    if bid and src.get("doc_id"):
        await db[LINKS].delete_many({"doc_id": src["doc_id"], "block": bid})
    link = await _save_link(db, src, site, key, issue.get("id") or "", actor.user_id, bid)
    await jira.cover_project(db, src["workspace_id"], key.split("-")[0])
    return {"key": key, "url": issue.get("url"), "issue": jira.public_issue(issue), "link": link_view(link, issue, True)}


async def unlink(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, link_id: str) -> dict:
    link = await _link_for_edit(db, actor, ctx, link_id)
    await db[LINKS].delete_one({"_id": link["_id"]})
    return {"unlinked": True, "key": link["key"]}


async def _link_for_edit(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, link_id: str) -> dict:
    link = await db[LINKS].find_one({"_id": ObjectId(link_id)}) if ObjectId.is_valid(link_id or "") else None
    if link is None:
        raise HTTPException(status_code=404, detail="That link isn't there any more.")
    if link.get("doc_id"):
        raw = await db["documents"].find_one({"_id": ObjectId(link["doc_id"])})
        if raw is None or not (await access.can(actor, raw, "edit_content", ctx)).allowed:
            raise HTTPException(status_code=404 if raw is None else 403, detail="You can change links on pages you can edit.")
    elif link.get("created_by") != actor.user_id:
        from app.services import workspace as ws_service

        if (await ws_service.role_for(db, link["workspace_id"], actor.user_id)) not in ("admin", "owner"):
            raise HTTPException(status_code=403, detail="Only who linked it, or a workspace admin, can change it.")
    return link


# ── What viewers see ──────────────────────────────────────────────────────────


async def _seen(db: AsyncIOMotorDatabase, user_id: str, cloud_id: str, asked: list[str], visible: set[str]) -> None:
    now = now_utc()
    for k in asked:
        await db[VIEWS].update_one({"_id": f"{user_id}:{cloud_id}:{k}"}, {"$set": {"ok": k in visible, "at": now}}, upsert=True)


async def viewer_issues(db: AsyncIOMotorDatabase, user_id: str | None, site: dict, keys: list[str], *,
                        ttl: timedelta = VIEW_TTL) -> dict[str, dict]:
    """{key: cached issue} for the keys this viewer's own connection can open (asked of Jira at most
    every ``ttl`` per key, all stale keys in one search; details from the cache that webhooks keep
    fresh). {} when not connected."""
    keys = [k for k in dict.fromkeys(keys) if jira.KEY_RE.match(k or "")]
    if not keys or not await jira.can_use(db, user_id, site["cloud_id"]):
        return {}
    cloud = site["cloud_id"]
    fresh = now_utc() - ttl
    known = {r["_id"].rsplit(":", 1)[1]: r async for r in db[VIEWS].find(
        {"_id": {"$in": [f"{user_id}:{cloud}:{k}" for k in keys]}})}
    stale = [k for k in keys if k not in known or (jira._aware(known[k].get("at")) or fresh) <= fresh]
    ok = {k for k in keys if k in known and known[k].get("ok") and k not in stale}
    if stale and await jira.busy(db, cloud):
        # Jira asked us to wait: what this viewer could open last time, from the cache.
        ok |= {k for k in stale if k in known and known[k].get("ok")}
        stale = []
    if stale:
        try:
            got = await jira.visible_keys(db, user_id, site, stale)
            await _seen(db, user_id, cloud, stale, set(got))
            ok |= set(got)
        except (jira_api.JiraError, jira.NotConnected) as exc:
            if getattr(exc, "status", 0) == 429:
                await jira.backoff(db, cloud, getattr(exc, "retry_after", None))
            ok |= {k for k in stale if k in known and known[k].get("ok")}
    if not ok:
        return {}
    return {r["key"]: r async for r in db[jira.ISSUES].find({"_id": {"$in": [f"{cloud}:{k}" for k in ok]}})}


def link_view(link: dict, issue: dict | None, can_see: bool) -> dict:
    sync = link.get("sync") or {}
    return {"id": str(link["_id"]), "key": link["key"], "block": link.get("block"), "fact_id": link.get("fact_id"),
            "kind": link.get("kind"), "url": (issue or {}).get("url"),
            "issue": jira.public_issue(issue) if (issue and can_see) else None,
            "sync": {"state": sync.get("state") or "ok", "message": sync.get("message")}}


async def page_links(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, slug: str) -> dict:
    """The page's Jira chips for this viewer, and what they can do (create, connect)."""
    raw = await db["documents"].find_one({"slug": slug, "deleted_at": None})
    if raw is None or not (await access.can(actor, raw, "read", ctx)).allowed:
        raise HTTPException(status_code=404, detail="Page not found")
    out: dict[str, Any] = {"configured": jira.configured(), "site": None, "connected": False, "can_create": False,
                           "can_edit": False, "links": {}}
    site = await jira.site_for(db, raw.get("workspace_id")) if jira.configured() else None
    if site is None or raw.get("encrypted"):
        return out
    from app.services import workspace as ws_service

    member = bool(await ws_service.role_for(db, raw["workspace_id"], actor.user_id))
    connected = await jira.can_use(db, actor.user_id, site["cloud_id"])
    out.update(site={"name": site.get("name"), "url": site.get("url")}, connected=connected,
               can_create=member, can_edit=(await access.can(actor, raw, "edit_content", ctx)).allowed)
    links = await db[LINKS].find({"doc_id": str(raw["_id"])}).to_list(length=500)
    if not links:
        return out
    seen = await viewer_issues(db, actor.user_id, site, [ln["key"] for ln in links])
    cached = {}
    if not seen:
        cached = {r["key"]: r async for r in db[jira.ISSUES].find({"_id": {"$in": [f"{site['cloud_id']}:{ln['key']}" for ln in links]}},
                                                                  {"key": 1, "url": 1})}
    for ln in links:
        it = seen.get(ln["key"])
        v = link_view(ln, it, it is not None)
        if it is None:
            v["url"] = (cached.get(ln["key"]) or {}).get("url") or jira.browse_url(site.get("url"), ln["key"])
        if ln.get("block"):
            out["links"][ln["block"]] = v
    return out


_BROWSE = re.compile(r"^https://([a-z0-9][a-z0-9-]{0,62}\.(?:atlassian\.net|jira\.com|[a-z0-9.-]+))/browse/([A-Z][A-Z0-9_]{0,19}-[1-9][0-9]{0,8})(?:[/?#].*)?$")


async def lookup_urls(db: AsyncIOMotorDatabase, actor: access.Actor, urls_: list[str]) -> dict:
    """Live chips for Jira links pasted in pages: {url: issue} for the ones this viewer's own
    connection can open (one of the sites it reaches); others are left out (they stay plain links)."""
    row = await jira.account(db, actor.user_id) if jira.configured() else None
    if row is None or row.get("broken"):
        return {"connected": row is not None and not row.get("broken"), "issues": {}}
    by_host = {}
    for s in row.get("sites") or []:
        host = re.sub(r"^https?://", "", (s.get("url") or "")).rstrip("/").lower()
        if host:
            by_host[host] = s
    want: dict[str, list[tuple[str, str]]] = {}
    for u in list(dict.fromkeys(urls_))[:50]:
        m = _BROWSE.match(u or "")
        if not m:
            continue
        s = by_host.get(m.group(1).lower())
        if s is not None:
            want.setdefault(s["id"], []).append((u, m.group(2)))
    out: dict[str, dict] = {}
    for cloud, pairs in want.items():
        known = next(x for x in row.get("sites") or [] if x.get("id") == cloud)
        got = await viewer_issues(db, actor.user_id, {"cloud_id": cloud, "url": known.get("url")}, [k for _u, k in pairs])
        for u, k in pairs:
            if k in got:
                out[u] = jira.public_issue(got[k])
    return {"connected": True, "issues": out}


# ── Markdrop → Jira ───────────────────────────────────────────────────────────


async def on_page_saved(db: AsyncIOMotorDatabase, before: dict, after: dict, actor) -> None:
    """``document.update_document`` after every save: a linked to-do ticked or unticked moves its issue
    (in the background, as the person who saved). Never fails the save."""
    try:
        if not jira.configured() or after.get("encrypted"):
            return
        # Jira chips, cards and lists in the page (services/jira_pages.py): their snapshots follow the save.
        from app.services import jira_pages

        await jira_pages.on_page_saved(db, before, after, actor)
        links = await db[LINKS].find({"doc_id": str(after["_id"]), "block": {"$type": "string"}}).to_list(length=500)
        if not links:
            return
        content = after.get("content") or ""
        for ln in links:
            mark = todo_mark(content, ln["block"])
            if mark is None or mark == ln.get("done"):
                continue
            res = await db[LINKS].update_one({"_id": ln["_id"], "done": ln.get("done")}, {"$set": {"done": mark}})
            if not res.modified_count:
                continue
            if ln.get("jira_done") == mark:
                continue
            jira.spawn(transition(db, ln["_id"], getattr(actor, "user_id", None), mark))
    except Exception:
        log.warning("jira: the save hook failed", exc_info=True)


def _pick(transitions: list[dict], done: bool) -> dict | None:
    def cat(t):
        return (((t.get("to") or {}).get("statusCategory") or {}).get("key"))
    if done:
        return next((t for t in transitions if cat(t) == "done"), None)
    return next((t for t in transitions if cat(t) == "new"), None) or next((t for t in transitions if cat(t) == "indeterminate"), None)


async def _sync_state(db: AsyncIOMotorDatabase, link_id, state: str, message: str | None, **extra) -> None:
    await db[LINKS].update_one({"_id": link_id}, {"$set": {"sync": {"state": state, "message": message, "at": now_utc()}, **extra}})


async def transition(db: AsyncIOMotorDatabase, link_id, user_id: str | None, done: bool) -> str:
    """Move the linked issue to a Done (``done``) or open status as ``user_id``. Returns ok | why not."""
    link = await db[LINKS].find_one({"_id": link_id})
    if link is None:
        return "gone"
    site = await jira.site_for(db, link["workspace_id"])
    if site is None or site.get("cloud_id") != link.get("cloud_id"):
        await _sync_state(db, link_id, "error", "This workspace isn't connected to that Jira site any more.")
        return "no_site"
    if not user_id or not await jira.can_use(db, user_id, site["cloud_id"]):
        await _sync_state(db, link_id, "error", f"Not {'closed' if done else 'reopened'} in Jira: whoever ticks it "
                                                "needs their Atlassian account connected (Settings › Account › Jira).")
        return "not_connected"
    prev = link.get("jira_done")
    # Before Jira answers: the webhook reporting this very change must find nothing to do.
    await db[LINKS].update_one({"_id": link_id}, {"$set": {"jira_done": done}})
    try:
        tr = await jira.call_as(db, user_id, site["cloud_id"], "GET", f"issue/{link['key']}/transitions")
        pick = _pick((tr or {}).get("transitions") or [], done)
        if pick is None:
            issue = await _fetch(db, user_id, site, link["key"])
            if issue is not None and ((issue.get("status") or {}).get("category") == "done") == done:
                await _sync_state(db, link_id, "ok", None)
                return "ok"
            await db[LINKS].update_one({"_id": link_id}, {"$set": {"jira_done": prev}})
            await _sync_state(db, link_id, "error", f"Not {'closed' if done else 'reopened'} in Jira: you can't move "
                                                    f"{link['key']} {'to Done' if done else 'out of Done'} there "
                                                    "(no such step for you in its workflow).")
            return "no_transition"
        await jira.call_as(db, user_id, site["cloud_id"], "POST", f"issue/{link['key']}/transitions",
                           body={"transition": {"id": str(pick.get("id"))}})
    except (jira_api.JiraError, jira.NotConnected) as exc:
        await db[LINKS].update_one({"_id": link_id}, {"$set": {"jira_done": prev}})
        why = ("Jira says you don't have permission to move it." if getattr(exc, "forbidden", False)
               else "Your Atlassian connection stopped working; reconnect it." if isinstance(exc, jira.NotConnected)
               else "Jira didn't answer.")
        await _sync_state(db, link_id, "error", f"Not {'closed' if done else 'reopened'} in Jira: {why}")
        return "error"
    await _sync_state(db, link_id, "ok", None)
    await _fetch(db, user_id, site, link["key"])
    log.info("jira: %s moved %s %s", user_id, link["key"], "to done" if done else "out of done")
    return "ok"


async def retry(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, link_id: str) -> dict:
    """Retry from the chip: push the page's state to Jira again, as the person asking."""
    link = await _link_for_edit(db, actor, ctx, link_id)
    if link.get("done") is None:
        return {"state": "ok"}
    out = await transition(db, link["_id"], actor.user_id, bool(link["done"]))
    fresh = await db[LINKS].find_one({"_id": link["_id"]}) or link
    return {"state": (fresh.get("sync") or {}).get("state"), "message": (fresh.get("sync") or {}).get("message"), "result": out}


# ── Jira → Markdrop ───────────────────────────────────────────────────────────


def delivery_key(workspace_id: str, payload: dict) -> str:
    issue = payload.get("issue") or {}
    raw = json.dumps([workspace_id, payload.get("webhookEvent"), payload.get("timestamp"), issue.get("key"),
                      (payload.get("changelog") or {}).get("id"), ((issue.get("fields") or {}).get("updated"))],
                     sort_keys=True, default=str)
    return "wh:" + hashlib.sha1(raw.encode()).hexdigest()


async def handle_webhook(db: AsyncIOMotorDatabase, workspace_id: str, payload: dict) -> dict:
    """One webhook delivery for a workspace (already verified): refresh the cached issue, then make
    linked to-dos follow a move into or out of Done."""
    site = await jira.site_for(db, workspace_id)
    if site is None:
        return {"ok": True, "ignored": "no_site"}
    if not await jira.remember(db, delivery_key(workspace_id, payload), timedelta(days=2)):
        return {"ok": True, "duplicate": True}
    issue = payload.get("issue") or {}
    key = str(issue.get("key") or "")
    if not jira.KEY_RE.match(key):
        return {"ok": True, "ignored": "no_issue"}
    event = str(payload.get("webhookEvent") or "")
    cloud = site["cloud_id"]
    if event == "jira:issue_deleted":
        await db[jira.ISSUES].delete_one({"_id": f"{cloud}:{key}"})
        from app.services import jira_pages

        await jira_pages.on_issue_changed(db, site.get("url"), key, None)
        await db[LINKS].update_many({"cloud_id": cloud, "key": key}, {"$set": {"sync": {
            "state": "error", "message": f"{key} was deleted in Jira.", "at": now_utc()}}})
        return {"ok": True, "deleted": key}
    shaped = jira.shape_issue(cloud, site.get("url"), issue)
    await jira.store_issues(db, [shaped])
    # Pages showing it (services/jira_pages.py): the snapshot's title, and a live nudge to re-read.
    from app.services import jira_pages

    await jira_pages.on_issue_changed(db, site.get("url"), key, shaped)
    done = shaped["status"]["category"] == "done"
    actor_acc = (payload.get("user") or {}).get("accountId")
    moved = 0
    async for ln in db[LINKS].find({"cloud_id": cloud, "key": key, "workspace_id": workspace_id}):
        if ln.get("jira_done") == done:
            continue
        await db[LINKS].update_one({"_id": ln["_id"]}, {"$set": {"jira_done": done}})
        if ln.get("block") and ln.get("done") is not None and ln.get("done") != done:
            moved += await _follow_jira(db, ln, done, actor_acc)
        elif ln.get("fact_id"):
            await _follow_fact(db, ln, done)
    return {"ok": True, "key": key, "moved": moved}


async def _follow_fact(db: AsyncIOMotorDatabase, ln: dict, done: bool) -> None:
    from app.services import workspace_memory as wm

    oid = wm._oid(ln.get("fact_id"))
    if oid is not None:
        await db[wm.FACTS].update_one({"_id": oid}, {"$set": {"done_at": now_utc() if done else None, "updated_at": now_utc()}})


async def _follow_jira(db: AsyncIOMotorDatabase, ln: dict, done: bool, actor_account: str | None) -> int:
    """Tick (or untick) the linked to-do on its page as a member who can edit it: whoever moved the
    issue in Jira when they're a member here, else the person who linked it. Quiet, normal save path."""
    from app.services import document as doc_service, pages
    from app.schemas.document import DocumentUpdate
    from app.services import notifications
    from app.services.user import get_user_by_id

    raw = await db["documents"].find_one({"_id": ObjectId(ln["doc_id"])}) if ln.get("doc_id") else None
    if raw is None or raw.get("deleted_at"):
        if (ln.get("sync") or {}).get("state") == "pending":
            # Otherwise retry_pending re-reads it every minute for ever.
            await _sync_state(db, ln["_id"], "error", "The page was deleted.", pending=None)
        return 0
    who = []
    uid = await jira.user_for_account(db, ln["workspace_id"], ln["cloud_id"], actor_account)
    if uid:
        who.append(uid)
    if ln.get("created_by") and ln["created_by"] not in who:
        who.append(ln["created_by"])
    for user_id in who:
        user = await get_user_by_id(db, user_id)
        if user is None:
            continue
        actor, ctx = access.Actor.of(user, cred="session"), access.Ctx(db, surface="jira")
        if not (await access.can(actor, raw, "edit_content", ctx)).allowed:
            continue
        for _attempt in range(3):
            content = raw.get("content") or ""
            it = item_at(content, block=ln["block"])
            if it is None or it.mark is None:
                await _sync_state(db, ln["_id"], "error", "The to-do was changed or removed on the page.")
                return 0
            if (it.mark == "x") == done:
                await db[LINKS].update_one({"_id": ln["_id"]}, {"$set": {"done": done}})
                return 0
            m = _TASK.match(it.line)
            pos = it.start + m.start(1)
            new = content[:pos] + ("x" if done else " ") + content[pos + 1:]
            # Before the save: the save hook must see nothing to send back to Jira.
            await db[LINKS].update_one({"_id": ln["_id"]}, {"$set": {"done": done}})
            try:
                await pages.check_page_lock(raw, actor, ctx, new)
                data = DocumentUpdate(title=raw.get("title"), content=new, base_rev=int(raw.get("rev") or 1))
                with notifications.quiet():
                    await doc_service.update_document(db, raw["slug"], data, actor, ctx, history={"kind": "jira"})
            except HTTPException as exc:
                await db[LINKS].update_one({"_id": ln["_id"]}, {"$set": {"done": not done}})
                if exc.status_code == 409:
                    raw = await db["documents"].find_one({"_id": raw["_id"]}) or raw
                    continue
                if exc.status_code == 423:
                    await _sync_state(db, ln["_id"], "pending", "Someone is editing the page; Markdrop ticks it when they're done.",
                                      pending={"done": done, "account": actor_account})
                    return 0
                break
            await _sync_state(db, ln["_id"], "ok", None, pending=None)
            return 1
    await _sync_state(db, ln["_id"], "error", f"{'Done' if done else 'Reopened'} in Jira, but nobody here who can edit "
                                              "the page could update it.")
    return 0


async def retry_pending(db: AsyncIOMotorDatabase, limit: int = 20) -> int:
    """Background: to-dos Jira moved while someone was editing the page."""
    n = 0
    async for ln in db[LINKS].find({"sync.state": "pending"}).limit(limit):
        p = ln.get("pending") or {}
        if "done" in p:
            ln["jira_done"] = p["done"]
            n += await _follow_jira(db, ln, bool(p["done"]), p.get("account"))
    return n


# ── Finding an item by its words (MCP) ────────────────────────────────────────


def find_item(content: str, ref: str) -> tuple[str | None, int | None, list[str]]:
    """(block id, body offset, candidates) for ``ref``: a block id ("b-…"), or words of the item. One
    match: its block id (or, without one, its offset in the body); several: their texts (to ask)."""
    ref = (ref or "").strip()
    if re.match(r"^b-[0-9A-Za-z_-]{1,40}$", ref):
        return (ref, None, []) if item_at(content, block=ref) else (None, None, [])
    needle = re.sub(r"\s+", " ", ref).strip().lower()
    if len(needle) < 3:
        return None, None, []
    start = _body_start(content)
    body = content[start:]
    hits: list[tuple[str | None, int, str]] = []
    pos = 0
    fence = False
    for line in body.split("\n"):
        if line.lstrip().startswith(("```", "~~~")):
            fence = not fence
        elif not fence and line.strip() and not line.lstrip().startswith(("#", ":::", "---", "|")):
            text, _p, _m, _d = _plain(line)
            if needle in text.lower():
                bm = _BLOCK.search(line)
                hits.append((bm.group(1) if bm else None, pos, text))
        pos += len(line) + 1
    if len(hits) == 1:
        b, off, _t = hits[0]
        return (b, None if b else off, [])
    return None, None, [t for _b, _o, t in hits[:8]]
