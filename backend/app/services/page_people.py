"""People in a page by name: ``:person[Ada Lovelace]`` without an ``{id=…}``.

A mention the editor makes always carries the account id
(``:person[Ada]{id="…"}``). One written by hand or by an AI app may carry only
the name. On every write of a page (an editor save through
``document.update_document``, and the MCP page tools) such a mention is looked
up among the members of the page's workspace: a case-insensitive exact match
of the whole name (the member's name on Markdrop, or their address's local
part when they have none). When exactly one member matches, the id is added
(the label stays as written), so the page from then on holds an ordinary
mention: deterministic, and redacted for readers outside the page's circle
like every other (``pages.redact_people``).

A name that matches nobody, or more than one member, is left as written and
shows as plain text; MCP writes say which names were left.

Names resolve only for a writer who is a member of the page's workspace (any
role): members can list each other anyway. Anyone else (a person the page is
shared with by email, an edit-secret holder, a personal page) gets nothing
resolved, so a write can't be used to learn who is a member.
"""

from __future__ import annotations

import re

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

# ``:person[Name]`` not followed by ``{``: the bare form. Not ``::person`` and
# not escaped.
_BARE = re.compile(r"(?<![A-Za-z0-9_:\\]):person\[((?:\\.|[^\]\\\n])*)\](?!\{)")
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
_CODE_SPAN = re.compile(r"(`+)(?:(?!\1)[^\n])*?\1")
MAX_NAMES = 200
MAX_MEMBERS = 500


def _norm(name: str) -> str:
    return " ".join(re.sub(r"\\(.)", r"\1", name or "").split()).casefold()


def _map_outside_code(markdown: str, fn) -> str:
    """``fn`` applied to every stretch of ``markdown`` outside code fences and
    inline code spans."""
    out: list[str] = []
    fence = None
    for line in markdown.split("\n"):
        f = _FENCE.match(line)
        if f:
            mark = f.group(1)
            if fence is None:
                fence = mark[0]
            elif mark[0] == fence:
                fence = None
            out.append(line)
            continue
        if fence is not None or ":person[" not in line:
            out.append(line)
            continue
        parts: list[str] = []
        pos = 0
        for m in _CODE_SPAN.finditer(line):
            parts.append(fn(line[pos:m.start()]))
            parts.append(m.group(0))
            pos = m.end()
        parts.append(fn(line[pos:]))
        out.append("".join(parts))
    return "\n".join(out)


def bare_names(markdown: str | None) -> list[str]:
    """The labels of the bare ``:person[…]`` mentions, in order, once each."""
    if not markdown or ":person[" not in markdown:
        return []
    found: list[str] = []

    def collect(text: str) -> str:
        for m in _BARE.finditer(text):
            label = m.group(1).strip()
            if label and label not in found:
                found.append(label)
        return text

    _map_outside_code(markdown, collect)
    return found


async def member_names(db: AsyncIOMotorDatabase, workspace_id: str) -> dict[str, set[str]]:
    """normalised name → the ids of the members it names."""
    from app.services import viewers

    rows = await db["memberships"].find({"workspace_id": workspace_id},
                                        {"user_id": 1, "name": 1}).to_list(length=MAX_MEMBERS)
    oids = [ObjectId(r["user_id"]) for r in rows if ObjectId.is_valid(str(r.get("user_id") or ""))]
    users = {str(u["_id"]): u for u in await db["users"].find(
        {"_id": {"$in": oids}}, {"name": 1, "email": 1}).to_list(length=len(oids) or 1)}
    index: dict[str, set[str]] = {}
    for r in rows:
        uid = str(r.get("user_id") or "")
        u = users.get(uid)
        if not uid or u is None:
            continue  # an account that no longer exists
        shown = viewers.display_name(type("U", (), {"name": u.get("name"), "email": u.get("email")}))
        for name in {shown, u.get("name") or "", r.get("name") or ""}:
            key = _norm(name)
            if key:
                index.setdefault(key, set()).add(uid)
    return index


async def resolve(db: AsyncIOMotorDatabase, markdown: str | None, page: dict | None,
                  user_id: str | None) -> tuple[str | None, list[str]]:
    """(the Markdown with every uniquely named member given their id, the
    names left as written). Nothing is resolved unless ``page`` is a page in a
    workspace and ``user_id`` is a member of it (otherwise every bare name is
    "left"). Documents in the classic editor are never touched."""
    if (page or {}).get("editor") != "blocks":
        return markdown, []  # only pages show people; a classic document's text is its own
    names = bare_names(markdown)
    if not names:
        return markdown, []
    ws_id = (page or {}).get("workspace_id")
    if not ws_id or not user_id or page.get("encrypted") or page.get("kind") == "artifact":
        return markdown, names
    from app.services import workspace as ws_service

    if await ws_service.role_for(db, ws_id, user_id) is None:
        return markdown, names
    index = await member_names(db, ws_id)
    ids: dict[str, str] = {}
    left: list[str] = []
    for name in names[:MAX_NAMES]:
        hit = index.get(_norm(name)) or set()
        if len(hit) == 1:
            ids[_norm(name)] = next(iter(hit))
        else:
            left.append(name)
    left.extend(names[MAX_NAMES:])
    if not ids:
        return markdown, left

    def fill(text: str) -> str:
        def one(m: re.Match) -> str:
            uid = ids.get(_norm(m.group(1).strip()))
            return f'{m.group(0)}{{id="{uid}"}}' if uid else m.group(0)

        return _BARE.sub(one, text)

    return _map_outside_code(markdown, fill), left


def warning(left: list[str]) -> str | None:
    if not left:
        return None
    shown = ", ".join(left[:20]) + (f" and {len(left) - 20} more" if len(left) > 20 else "")
    return (f"These people weren't found as exactly one member of the page's workspace, so they show as "
            f"plain text: {shown}. Use list_workspace_members and write :person[Name]{{id=\"<id>\"}}.")
