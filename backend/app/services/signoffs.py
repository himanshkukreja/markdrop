"""Sign-off blocks in pages (Senseloaf request 8).

    :::signoff{#b-k3x9a1 person="<user id>" label="Release approval" options="Approved for production|Not approved" lock=above}
    Optional text: what is being signed off.
    :::

The Markdown says *which* block, *who* signs it, its label, its choices and
whether it locks the section above. The **decision is never in the Markdown**:
it lives in the ``signoffs`` collection, so nobody who can edit the text can
forge one (any ``option=`` / ``signed=`` written in the block is ignored)::

    {doc_id, block_id, person_id, option, label, signer_id, signer_name,
     signed_at, via, removed, history: [{action, option, by_id, by_name, at, via}]}

Readers get the state through ``GET /documents/{slug}/signoffs`` (like
embeds: resolved per viewer; names only inside the page's circle, as for
``:person`` mentions).

Who signs
    Only the person the block names (``person``), signed in and able to read
    the page. They choose one of the options, change it, or clear it; every
    change goes into the row's history and into the page's version history
    ("Signed off by X: Approved for production").

Protection (``guard``, on every content write: the editor's save, every MCP
write, restore, append, a VS Code push)
    Once a block is signed, a save that changes its person, label, options,
    lock or text, or deletes it, is refused (423 ``signed_off``) — for editors,
    the owner and MCP alike. With ``lock=above`` the section from the previous
    heading (or the page's start) down to the block is read-only as well. The
    signer clears their decision to unlock it. A workspace admin may remove a
    signed block; that removal is recorded (row + version history).

Races: signing writes the row, then bumps the page's ``signoff_rev`` on the
revision it read; every content write carries ``signoff_rev`` in its
compare-and-swap, so a save prepared before a sign-off can't land after it.

Block ids: every sign-off block needs one (``{#b-…}``). The editor gives a new
block its own; a block written without one (an AI app, Markdown mode) gets a
deterministic one on save, so the same text always gets the same id.
"""

from __future__ import annotations

import hashlib
import inspect
import logging
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

log = logging.getLogger(__name__)

COLL = "signoffs"
NAME = "signoff"
DEFAULT_LABEL = "Sign-off"
DEFAULT_OPTIONS = ("Approved", "Not approved")
MAX_OPTIONS = 6
MAX_OPTION_CHARS = 80
MAX_LABEL_CHARS = 120
MAX_BLOCKS = 50
MAX_HISTORY = 100
SHOWN_HISTORY = 20

ANCHOR = re.compile(r"^b-[a-z0-9]{4,12}$")
_FENCE = re.compile(r"^[ \t>]*(`{3,}|~{3,})")
_OPEN = re.compile(r"^([ \t>]*)(:{3,})([A-Za-z][\w-]*)(\[(?:\\.|[^\]\\\n])*\])?(\{[^\n]*\})?[ \t]*$")
_CLOSE = re.compile(r"^[ \t>]*(:{3,})[ \t]*$")
_HEADING = re.compile(r"^[ \t>]*#{1,6}(?:[ \t]|$)")
_ATTR = re.compile(r"""#([A-Za-z0-9_-]+)|\.([A-Za-z0-9_-]+)|([A-Za-z_][\w:.-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'}]+)))?""")
_ID_TOKEN = re.compile(r"""(^|\s)#[A-Za-z0-9_-]+(?=\s|$)|(^|\s)id\s*=\s*("[^"]*"|'[^']*'|[^\s"'}]+)(?=\s|$)""")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


def _unescape(v: str) -> str:
    return v.replace("&quot;", '"').replace("&#xA;", "\n").replace("&amp;", "&")


# ── Reading the Markdown ──────────────────────────────────────────────────────


@dataclass
class Block:
    id: str | None
    person: str | None
    label: str
    options: list[str]
    lock: bool
    open_line: int          # the `:::signoff{…}` line
    end_line: int           # one past the closing fence (or the end of the page)
    section_start: int      # the previous heading's line (or the body's first line)
    head: str
    body: str
    attrs: dict = field(default_factory=dict)

    @property
    def key(self) -> tuple:
        """What a signature protects: who, what, the choices, the lock and the text."""
        return (self.person, self.label, tuple(self.options), self.lock, self.body)


def parse_attrs(text: str | None) -> dict[str, str]:
    """``{#b-x person="…" lock=above}`` → ``{"id": "b-x", "person": "…", "lock": "above"}``."""
    out: dict[str, str] = {}
    inner = (text or "").strip()
    if inner.startswith("{") and inner.endswith("}"):
        inner = inner[1:-1]
    for m in _ATTR.finditer(inner):
        if m.group(1):
            out.setdefault("id", m.group(1))
        elif m.group(2):
            continue
        elif m.group(3):
            if m.group(4) is None:
                out.setdefault(m.group(3), "")
            else:
                val = m.group(5) if m.group(5) is not None else (m.group(6) if m.group(6) is not None else m.group(7))
                out.setdefault(m.group(3), _unescape(val or ""))
    return out


def parse_options(value: str | None) -> list[str]:
    out: list[str] = []
    for part in (value or "").split("|"):
        p = " ".join(part.split())[:MAX_OPTION_CHARS]
        if p and p not in out:
            out.append(p)
        if len(out) >= MAX_OPTIONS:
            break
    return out or list(DEFAULT_OPTIONS)


def _norm(lines: list[str]) -> str:
    text = "\n".join(ln.rstrip() for ln in lines)
    return re.sub(r"\n{3,}", "\n\n", text).strip("\n")


def _body_start(lines: list[str]) -> int:
    """The first line after the front matter (page_props.split's rule)."""
    from app.services import page_props

    front, _body = page_props.split("\n".join(lines))
    return 0 if front is None else len(front) + 2


def parse(markdown: str | None) -> tuple[list[str], list[Block]]:
    """The page's lines and its sign-off blocks, in order. Code fences hide
    what they hold; containers nest by their fences (the outer one has more
    colons); an unclosed block runs to the end of the page."""
    text = (markdown or "").replace("\r\n", "\n")
    lines = text.split("\n")
    blocks: list[Block] = []
    if NAME not in text:
        return lines, blocks
    start = _body_start(lines)
    fence: tuple[str, int] | None = None
    stack: list[tuple[int, str, int, int]] = []  # (colons, name, open line, section start)
    section = start
    for i in range(start, len(lines)):
        ln = lines[i]
        if fence is not None:
            m = _FENCE.match(ln)
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= fence[1] and not ln[m.end():].strip():
                fence = None
            continue
        m = _FENCE.match(ln)
        if m:
            fence = (m.group(1)[0], len(m.group(1)))
            continue
        if _HEADING.match(ln):
            section = i
            continue
        mo = _OPEN.match(ln)
        if mo:
            stack.append((len(mo.group(2)), mo.group(3), i, section))
            continue
        mc = _CLOSE.match(ln)
        if mc and stack and len(mc.group(1)) >= stack[-1][0]:
            size, name, at, sec = stack.pop()
            if name == NAME:
                blocks.append(_block(lines, at, i + 1, sec))
    for size, name, at, sec in reversed(stack):  # unclosed: to the end of the page
        if name == NAME:
            blocks.append(_block(lines, at, len(lines), sec))
    blocks.sort(key=lambda b: b.open_line)
    return lines, blocks


def _block(lines: list[str], at: int, end: int, section: int) -> Block:
    head = lines[at]
    mo = _OPEN.match(head)
    attrs = parse_attrs(mo.group(5) if mo else None)
    bracket = (mo.group(4) or "")[1:-1] if mo and mo.group(4) else ""
    label = " ".join((attrs.get("label") or bracket or DEFAULT_LABEL).split())[:MAX_LABEL_CHARS] or DEFAULT_LABEL
    closed = end <= len(lines) and end - 1 > at and _CLOSE.match(lines[end - 1] or "") is not None
    body = lines[at + 1:end - 1] if closed else lines[at + 1:end]
    bid = attrs.get("id")
    person = (attrs.get("person") or "").strip() or None
    return Block(id=bid if bid and ANCHOR.match(bid) else None, person=person, label=label,
                 options=parse_options(attrs.get("options")), lock=attrs.get("lock") == "above",
                 open_line=at, end_line=end, section_start=section, head=head, body=_norm(body), attrs=attrs)


def blocks_of(markdown: str | None) -> list[Block]:
    return parse(markdown)[1]


def range_text(lines: list[str], b: Block) -> str:
    """The section a ``lock=above`` block locks: from the previous heading (or
    the page's start) down to the block."""
    return _norm(lines[b.section_start:b.open_line])


def find(markdown: str | None, ref: str) -> Block | None:
    """A block by its id (``b-…`` or ``#b-…``), else by its label when exactly
    one block has it (case-insensitive)."""
    ref = (ref or "").strip().lstrip("#")
    blocks = blocks_of(markdown)
    for b in blocks:
        if b.id and b.id == ref:
            return b
    hits = [b for b in blocks if b.label.casefold() == ref.casefold()]
    return hits[0] if len(hits) == 1 else None


# ── Block ids ─────────────────────────────────────────────────────────────────


def _with_id(head: str, new_id: str) -> str:
    mo = _OPEN.match(head)
    if not mo:
        return head
    attrs = mo.group(5)
    if attrs:
        inner = _ID_TOKEN.sub(lambda m: m.group(1) or m.group(2) or "", attrs[1:-1]).strip()
        attrs = "{" + " ".join(x for x in (f"#{new_id}", inner) if x) + "}"
    else:
        attrs = "{" + f"#{new_id}" + "}"
    return f"{mo.group(1)}{mo.group(2)}{mo.group(3)}{mo.group(4) or ''}{attrs}"


def _without_id(head: str) -> str:
    mo = _OPEN.match(head)
    if not mo or not mo.group(5):
        return head.strip()
    inner = _ID_TOKEN.sub(lambda m: m.group(1) or m.group(2) or "", mo.group(5)[1:-1]).strip()
    return f"{mo.group(3)}{{{inner}}}"


def _det_id(salt: str, base: str, k: int, taken: set[str]) -> str:
    n = 0
    while True:
        h = hashlib.sha256(f"{salt}|{base}|{k}|{n}".encode()).hexdigest()[:8]
        cand = f"b-{h}"
        if cand not in taken:
            return cand
        n += 1


def normalize_ids(markdown: str | None, salt: str, old: str | None = None,
                  taken: set[str] | None = None) -> str | None:
    """Every sign-off block gets an id of its own: one written without an id,
    or with one another block already has, is given a deterministic new one
    (the same text always gets the same id). Of blocks sharing an id, the one
    that matches the stored page's block keeps it."""
    if not markdown or NAME not in markdown:
        return markdown
    lines, blocks = parse(markdown)
    if not blocks:
        return markdown
    old_by_id = {b.id: b for b in blocks_of(old) if b.id}
    used = set(re.findall(r"#(b-[a-z0-9]{4,12})", markdown)) | set(taken or ())
    groups: dict[str, list[Block]] = {}
    for b in blocks:
        if b.id and not (taken and b.id in taken):
            groups.setdefault(b.id, []).append(b)
    keep: set[int] = set()
    for bid, bs in groups.items():
        ob = old_by_id.get(bid)
        match = next((b for b in bs if ob is not None and b.key == ob.key), bs[0])
        keep.add(match.open_line)
    count: Counter = Counter()
    changed = False
    for b in blocks:
        if b.open_line in keep:
            continue
        base = _without_id(b.head)
        k = count[base]
        count[base] += 1
        new = _det_id(salt, base, k, used)
        used.add(new)
        lines[b.open_line] = _with_id(b.head, new)
        changed = True
    if not changed:
        return markdown
    out = "\n".join(lines)
    return out.replace("\n", "\r\n") if "\r\n" in markdown else out


# ── Protection ────────────────────────────────────────────────────────────────


def _refusal(row: dict, b: Block, what: str) -> HTTPException:
    from app.services.pages import PageError

    name = row.get("signer_name") or "the person named in it"
    option = row.get("option") or ""
    label = b.label
    if what == "deleted":
        detail = (f"“{label}” was signed off by {name} ({option}), so it can't be removed. Ask {name} to clear "
                  "their decision first (or a workspace admin to remove the sign-off).")
    elif what == "range":
        detail = (f"The section above “{label}” is locked: {name} signed it off ({option}). Ask {name} to clear "
                  "their decision to change it.")
    else:
        detail = (f"“{label}” was signed off by {name} ({option}), so its person, label, options and text can't "
                  f"change. Ask {name} to clear their decision first.")
    return PageError(423, {"detail": detail, "code": "signed_off", "block": b.id, "label": label,
                           "signed_by": row.get("signer_name"), "reason": what, "retryable": False})


def check(old: str | None, new: str | None, rows: list[dict], *, may_remove: bool) -> list[dict]:
    """Refuses (423 ``signed_off``) a write of ``new`` over ``old`` that
    changes a signed block or its locked section. Returns the signed rows whose
    block the write removes (a workspace admin's removal)."""
    if not rows:
        return []
    old_lines, old_blocks = parse(old)
    new_lines, new_blocks = parse(new)
    old_by_id = {b.id: b for b in old_blocks if b.id}
    new_by_id: dict[str, Block] = {}
    for b in new_blocks:
        if b.id:
            new_by_id.setdefault(b.id, b)
    removed: list[dict] = []
    for row in rows:
        ob = old_by_id.get(row.get("block_id"))
        if ob is None or ob.person != row.get("person_id"):
            continue  # not on the page as stored (written some other way): nothing to protect
        nb = new_by_id.get(ob.id)
        if nb is None:
            if may_remove:
                removed.append(row)
                continue
            raise _refusal(row, ob, "deleted")
        if nb.key != ob.key:
            raise _refusal(row, ob, "changed")
        if ob.lock and range_text(new_lines, nb) != range_text(old_lines, ob):
            raise _refusal(row, ob, "range")
    return removed


async def signed_rows(db: AsyncIOMotorDatabase, doc_id) -> list[dict]:
    return await db[COLL].find({"doc_id": str(doc_id), "option": {"$ne": None}, "removed": None}) \
        .to_list(length=MAX_BLOCKS * 4)


async def is_admin(actor, raw: dict, ctx) -> bool:
    """A workspace admin (or owner) of the page's workspace."""
    if actor is None or ctx is None or not getattr(actor, "user_id", None):
        return False
    from app.models.workspace import role_allows
    from app.services import access

    f = await access.facts(actor, raw, ctx)
    return role_allows(f.ws_role, "admin")


def _applies(raw: dict | None) -> bool:
    return bool(raw) and raw.get("kind", "markdown") != "artifact" and not raw.get("encrypted")


async def guard(db: AsyncIOMotorDatabase, raw: dict | None, new: str | None, actor, ctx) -> tuple[str | None, list[dict]]:
    """Before writing ``new`` over ``raw``: ids given to blocks without one,
    signed blocks and their locked sections checked. Returns (the Markdown to
    store, the signed rows this write removes — a workspace admin's removal)."""
    if not _applies(raw) or new is None:
        return new, []
    old = raw.get("content") or ""
    if NAME not in new and NAME not in old:
        return new, []
    new = normalize_ids(new, str(raw["_id"]), old)
    from app.services.pages import PageError

    if len(blocks_of(new)) > MAX_BLOCKS:
        raise PageError(422, {"detail": f"A page can hold up to {MAX_BLOCKS} sign-off blocks.",
                              "code": "too_many_signoffs"})
    rows = await signed_rows(db, raw["_id"])
    if not rows:
        return new, []
    may_remove = False
    if any(r.get("block_id") not in {b.id for b in blocks_of(new)} for r in rows):
        may_remove = await is_admin(actor, raw, ctx)
    return new, check(old, new, rows, may_remove=may_remove)


def cas(raw: dict) -> dict:
    """What a content write adds to its compare-and-swap: no sign-off since ``raw`` was read."""
    return {"signoff_rev": raw.get("signoff_rev")}


def race_error() -> HTTPException:
    from app.services.pages import PageError

    return PageError(409, {"detail": "Someone signed off part of this page just now. Load it again and redo "
                                     "your change.", "code": "signoff_changed", "retryable": True})


async def after_write(db: AsyncIOMotorDatabase, before: dict | None, after: dict | None, actor,
                      removed: list[dict] | None = None) -> None:
    """After a content write: record a workspace admin's removals of signed
    blocks. Never fails the write. (Asking the named person to sign is
    notifications.on_page_saved's job: it reads the same ``person`` / ``label``
    attributes on every save.)"""
    if not after or not _applies(after) or not removed:
        return
    try:
        for row in removed:
            await _record_removal(db, after, row, actor)
    except Exception:
        log.warning("sign-offs: recording a removal failed", exc_info=True)


async def notify_signoff_requested(db: AsyncIOMotorDatabase, doc: dict, block_id: str, person_id: str, actor,
                                   *, label: str | None = None) -> bool:
    """Asks the named person to sign off, explicitly, through the
    notifications service (services/notifications.py; it dedupes for 24 h).
    Saves don't call this: notifications.on_page_saved already notices new
    sign-off persons. True when a notification was handed on."""
    try:
        from app.services import notifications  # type: ignore[attr-defined]
    except ImportError:
        return False  # the notifications service isn't there (a branch without it)
    try:
        res = notifications.notify(db, person_id, "signoff_requested", doc, block_id, actor, {"label": label})
        if inspect.isawaitable(res):
            await res
        return True
    except Exception:
        log.warning("sign-offs: notify failed", exc_info=True)
        return False


# ── Signing ───────────────────────────────────────────────────────────────────


def _actor_name(actor) -> str:
    from app.services import viewers

    user = getattr(actor, "user", None)
    return viewers.display_name(user) if user is not None else "Someone"


def _event_text(action: str, by: str, option: str | None, label: str, signer: str | None = None,
                was: str | None = None) -> str:
    if action == "signed":
        return f"Signed off by {by}: {option}"
    if action == "changed":
        return f"{by} changed their sign-off to: {option}"
    if action == "cleared":
        return f"{by} cleared their sign-off ({was})" if was else f"{by} cleared their sign-off"
    return f"{by} removed the sign-off “{label}” ({signer or 'signed'}: {was})"


async def _history_event(db: AsyncIOMotorDatabase, raw: dict, actor, text: str, event: dict) -> None:
    from app.services import page_history

    await page_history.record_event(db, raw, actor, text=text, event=event)


def match_option(options: list[str], value: str) -> str | None:
    v = " ".join((value or "").split())
    for o in options:
        if o == v:
            return o
    for o in options:
        if o.casefold() == v.casefold():
            return o
    return None


async def sign(db: AsyncIOMotorDatabase, raw: dict | None, block_ref: str, option: str | None, actor, ctx, *,
               via: str = "app") -> dict:
    """The named person chooses ``option`` (None clears their decision).
    Returns the block as this person sees it now."""
    from app.services import access, live, pages

    await access.require(actor, raw, "read", ctx)
    if not pages.is_page_capable(raw) or raw.get("editor") != "blocks":
        raise HTTPException(status_code=422, detail="Sign-offs work in pages (documents in the block editor).")
    if not actor.user_id:
        raise HTTPException(status_code=401, detail="Sign in to sign off.")
    if getattr(actor, "cred", None) == "tenant":
        raise HTTPException(status_code=403, detail="Open the page on Markdrop to sign off.")
    doc_id = str(raw["_id"])
    for _attempt in range(4):
        b = find(raw.get("content"), block_ref)
        if b is None or not b.id:
            raise HTTPException(status_code=404, detail=f"There's no sign-off {block_ref!r} on this page. "
                                                        "list_signoffs names them.")
        if b.person != actor.user_id:
            raise HTTPException(status_code=403, detail="Only the person this sign-off names can choose an option.")
        chosen = None
        if option is not None and str(option).strip():
            chosen = match_option(b.options, option)
            if chosen is None:
                raise HTTPException(status_code=422, detail="Choose one of: " + ", ".join(f"“{o}”" for o in b.options))
        prev_row = await db[COLL].find_one({"doc_id": doc_id, "block_id": b.id})
        prev = prev_row.get("option") if prev_row and prev_row.get("person_id") == b.person \
            and not prev_row.get("removed") else None
        if prev == chosen:
            return await entry(db, raw, b, actor, ctx)
        if prev_row is None and chosen is None:
            return await entry(db, raw, b, actor, ctx)
        action = "cleared" if chosen is None else ("signed" if prev is None else "changed")
        name = _actor_name(actor)
        at = now_utc()
        hist = {"action": action, "option": chosen, "was": prev, "by_id": actor.user_id, "by_name": name,
                "at": at, "via": via, "label": b.label}
        sets: dict[str, Any] = {"person_id": b.person, "option": chosen, "label": b.label, "options": b.options,
                                "removed": None, "updated_at": at, "via": via}
        if chosen is not None:
            sets.update(signer_id=actor.user_id, signer_name=name, signed_at=at)
        else:
            sets.update(signer_id=None, signer_name=None, signed_at=None)
        filt: dict[str, Any] = {"doc_id": doc_id, "block_id": b.id}
        if prev_row is not None:
            filt["_id"] = prev_row["_id"]
            filt["updated_at"] = prev_row.get("updated_at")
        try:
            res = await db[COLL].find_one_and_update(
                filt, {"$set": sets, "$push": {"history": {"$each": [hist], "$slice": -MAX_HISTORY}},
                       "$setOnInsert": {"created_at": at}},
                upsert=prev_row is None, return_document=True)
        except DuplicateKeyError:
            res = None
        if res is None:
            raw = await db["documents"].find_one({"_id": raw["_id"]}) or raw
            continue
        # Claim the page as read: a content write prepared before this can't land after it.
        q: dict[str, Any] = {"_id": raw["_id"]}
        q["rev"] = raw["rev"] if "rev" in raw else {"$exists": False}
        q["signoff_rev"] = raw.get("signoff_rev")
        claimed = await db["documents"].find_one_and_update(q, {"$inc": {"signoff_rev": 1}}, return_document=True)
        if claimed is None:
            # The page changed meanwhile: undo and look again.
            if prev_row is None:
                await db[COLL].delete_one({"_id": res["_id"]})
            else:
                await db[COLL].replace_one({"_id": res["_id"]}, prev_row)
            raw = await db["documents"].find_one({"_id": raw["_id"]}) or raw
            continue
        await _history_event(db, claimed, actor, _event_text(action, name, chosen, b.label, was=prev),
                             {"type": "signoff", "action": action, "block": b.id, "label": b.label,
                              "option": chosen, "was": prev})
        live.notify(claimed.get("slug"), {"type": "signoff", "block": b.id})
        return await entry(db, claimed, b, actor, ctx)
    raise HTTPException(status_code=409, detail="The page kept changing. Try again.")


async def _record_removal(db: AsyncIOMotorDatabase, raw: dict, row: dict, actor) -> None:
    name = _actor_name(actor)
    at = now_utc()
    hist = {"action": "removed", "option": None, "was": row.get("option"), "by_id": getattr(actor, "user_id", None),
            "by_name": name, "at": at, "via": "mcp" if getattr(actor, "cred", None) == "mcp" else "app",
            "label": row.get("label"), "signer_name": row.get("signer_name")}
    await db[COLL].update_one({"_id": row["_id"]}, {
        "$set": {"option": None, "removed": {"by_id": hist["by_id"], "by_name": name, "at": at,
                                             "option": row.get("option"), "signer_name": row.get("signer_name")},
                 "updated_at": at},
        "$push": {"history": {"$each": [hist], "$slice": -MAX_HISTORY}}})
    await _history_event(db, raw, actor, _event_text("removed", name, None, row.get("label") or DEFAULT_LABEL,
                                                     signer=row.get("signer_name"), was=row.get("option")),
                         {"type": "signoff", "action": "removed", "block": row.get("block_id"),
                          "label": row.get("label"), "option": None, "was": row.get("option")})


# ── Reading the state (per viewer) ───────────────────────────────────────────


def tone(option: str | None, options: list[str]) -> str | None:
    """success / danger / warning / neutral for a decision (the card's colour)."""
    if not option:
        return None
    t = option.casefold()
    if re.search(r"\b(not|no|reject\w*|declin\w*|block\w*|fail\w*|den(y|ied)|veto\w*|stop)\b", t):
        return "danger"
    if re.search(r"\b(change\w*|revis\w*|hold|wait\w*|later|condition\w*|partial\w*|minor|pending|with)\b", t):
        return "warning"
    if options and option == options[0]:
        return "success"
    if re.search(r"\b(approv\w*|yes|accept\w*|ok|go|ship\w*|lgtm|pass\w*|done|agree\w*)\b", t):
        return "success"
    return "neutral"


async def _people(db: AsyncIOMotorDatabase, ids: set[str]) -> dict[str, dict]:
    from app.services import page_history

    return await page_history._people(db, {i for i in ids if i})


async def _view(b: Block, row: dict | None, people: dict, names: bool, actor, may_remove: bool) -> dict:
    signed = bool(row) and row.get("option") is not None and not row.get("removed") \
        and row.get("person_id") == b.person
    who = people.get(b.person or "") or {}
    me = getattr(actor, "user_id", None)
    signer_id = row.get("signer_id") if signed else None
    signer = people.get(signer_id or "") or {}
    hist = []
    for h in ((row or {}).get("history") or [])[-SHOWN_HISTORY:]:
        hist.append({"action": h.get("action"), "option": h.get("option"), "was": h.get("was"),
                     "by": (h.get("by_name") if names else None), "at": _iso(h.get("at"))})
    return {
        "block": b.id, "label": b.label, "options": b.options, "lock": "above" if b.lock else None,
        "person": {"id": b.person, "name": who.get("name") if names else None,
                   "avatar": who.get("picture") if names else None} if b.person else None,
        "option": row.get("option") if signed else None,
        "tone": tone(row.get("option"), b.options) if signed else None,
        "signed_at": _iso(row.get("signed_at")) if signed else None,
        "signed_by": {"id": signer_id, "name": (signer.get("name") or row.get("signer_name")) if names else None,
                      "avatar": signer.get("picture") if names else None} if signed else None,
        "can_sign": bool(me) and me == b.person and getattr(actor, "cred", None) != "tenant",
        "can_remove": signed and may_remove,
        "history": hist,
    }


async def entry(db: AsyncIOMotorDatabase, raw: dict, b: Block, actor, ctx) -> dict:
    out = await listing(db, raw, actor, ctx, only=b.id)
    return out[0] if out else (await _view(b, None, {}, False, actor, False))


async def listing(db: AsyncIOMotorDatabase, raw: dict, actor, ctx, *, only: str | None = None) -> list[dict]:
    """The page's sign-off blocks as this viewer may see them (the caller has
    checked they can read the page). Names only inside the page's circle."""
    from app.services import access, pages

    if not _applies(raw):
        return []
    blocks = [b for b in blocks_of(raw.get("content")) if b.id and (only is None or b.id == only)]
    if not blocks:
        return []
    rows = {r["block_id"]: r for r in await db[COLL].find(
        {"doc_id": str(raw["_id"]), "block_id": {"$in": [b.id for b in blocks]}}).to_list(length=MAX_BLOCKS * 4)}
    names = await pages.sees_people(actor, raw, ctx) if ctx is not None else False
    ids = {b.person for b in blocks if b.person} | {r.get("signer_id") for r in rows.values() if r.get("signer_id")}
    people = await _people(db, ids) if names else {}
    may_remove = False
    if any(r.get("option") is not None and not r.get("removed") for r in rows.values()):
        may_remove = await is_admin(actor, raw, ctx) and (await access.can(actor, raw, "edit_content", ctx)).allowed
    return [await _view(b, rows.get(b.id), people, names, actor, may_remove) for b in blocks]


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLL].create_index([("doc_id", 1), ("block_id", 1)], unique=True)


async def forget_document(db: AsyncIOMotorDatabase, doc_id: str) -> None:
    await db[COLL].delete_many({"doc_id": str(doc_id)})
