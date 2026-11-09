"""Suggested edits on comment threads (CONTRACT §1.1 ``suggestion``, §7; Track B).

A thread anchored to selected text can carry one suggestion: replacement text for that quote. Anyone who
can comment proposes one (with the thread, a reply, or later); an editor accepts it in one click, rejects it,
or its author withdraws it. The page's Markdown never carries any of this (content stays clean).

``thread.suggestion`` (only this module writes it)::

    {text, state: open | accepted | rejected | stale, by, at, decided_by, decided_at, version_id,
     ai: bool,                                   # drafted with "Apply with AI"
     offer: None | {to, to_name, by, by_name, at}}   # accepted while someone else held the edit lock

**Accepting is an edit**, under the page's own rules (services/document.update_document): the acceptor must
be able to edit; one editor at a time (someone else holding the edit lock → the suggestion is *offered* to
them instead: their comments panel shows it with Apply, and their Apply goes through their own lock — their
open editor then loads the change, or merges it under unsaved typing like any newer version); a page locked
by its ``locked`` property, signed-off sections, ``base_rev`` all apply. The quote is found again in the
current Markdown (inside the thread's block when the anchor knows it, inline formatting between its
characters allowed); when it isn't there any more the suggestion is ``stale`` (409), and when it spans
formatting it can't safely replace (half a bold run, a link), 409 ``suggestion_unappliable``: copy it by hand.

An accepted suggestion is its own version in the page's history (``author_kind: "suggestion"``, ``event``
``{type: "suggestion", thread_id}``), and the thread's ``suggestion.version_id`` / history entry name that
version (its number, as a string): history ↔ thread both ways. Markdown documents have no version history
(services/page_history.records): ``version_id`` stays None there.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from fastapi import HTTPException

from app.services.comments import events, model

log = logging.getLogger(__name__)

MAX_TEXT = model.MAX_BODY
STATES = ("open", "accepted", "rejected", "stale")
_MARK = "[*_~`]"
_RETRIES = 3


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _err(status: int, detail: str, code: str, **extra) -> HTTPException:
    from app.services.pages import PageError

    return PageError(status, {"detail": detail, "code": code, **extra})


def _name(actor) -> str:
    from app.services import viewers

    user = getattr(actor, "user", None)
    return viewers.display_name(user) if user is not None else "Someone"


def clean_text(text: str | None) -> str:
    """The suggestion as stored: line endings normalised, NULs out, trailing space trimmed per line end."""
    t = str(text or "").replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")
    return t.strip("\n")


def _oid(v: Any) -> ObjectId | None:
    try:
        return v if isinstance(v, ObjectId) else ObjectId(str(v))
    except Exception:
        return None


# ── Finding the quote in the Markdown ─────────────────────────────────────────


def _front_matter_end(md: str) -> int:
    if not md.startswith("---\n"):
        return 0
    end = md.find("\n---", 4)
    if end < 0:
        return 0
    nl = md.find("\n", end + 4)
    return len(md) if nl < 0 else nl + 1


def _pattern(exact: str) -> re.Pattern | None:
    """The quote (normalised plain text) as a regex over Markdown source: whitespace runs match any
    whitespace, and inline markers (``*``, ``_``, ``~``, `````) may sit between its characters."""
    words = [w for w in re.split(r"\s+", exact.strip()) if w]
    if not words:
        return None
    gap = f"{_MARK}{{0,3}}"
    parts = []
    for w in words:
        parts.append(gap.join(re.escape(ch) for ch in w))
    try:
        return re.compile(f"{gap}\\s+{gap}".join(parts))
    except re.error:  # pragma: no cover - escaped input
        return None


def _plain(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(_MARK, "", s)).strip()


def _balanced(segment: str) -> bool:
    """Replacing ``segment`` keeps the Markdown's inline formatting whole: every marker run it holds is
    closed inside it, and it doesn't cut a link or an image in half."""
    s = segment
    for marker in ("**", "__", "~~", "`", "*", "_"):
        n = s.count(marker)
        if n % 2:
            return False
        s = s.replace(marker, "")
    if s.count("[") != s.count("]") or "](" in segment and segment.count("(") != segment.count(")"):
        return False
    return True


def _block(md: str, anchor: dict):
    """The anchored block (services/comments/anchoring.blocks), or None."""
    try:
        from app.services.comments import anchoring

        bs = anchoring.blocks(md)
    except Exception:
        return None
    bid, fp, idx = anchor.get("block_id"), anchor.get("block_fp"), anchor.get("block_index")
    hit = None
    if bid:
        hit = next((b for b in bs if b.bid == bid), None)
    if hit is None and fp:
        try:
            hit = next((b for b in bs if anchoring.fingerprint(b.text) == fp), None)
        except Exception:
            hit = None
    if hit is None and isinstance(idx, int) and 0 <= idx < len(bs):
        hit = bs[idx]
    return hit


def _block_range(md: str, anchor: dict) -> tuple[int, int] | None:
    """The anchored block's [start, end) in the Markdown, or None."""
    hit = _block(md, anchor)
    if hit is None or not isinstance(hit.start, int) or not isinstance(hit.end, int) or hit.end <= hit.start:
        return None
    return hit.start, hit.end


def _in_rendered_block(md: str, anchor: dict, exact: str) -> bool:
    """The quote is still in the block as readers see it, though not in its Markdown as plain text: it spans
    something rendered from markup (a Jira chip, a mention), so a plain replacement can't be made."""
    hit = _block(md, anchor)
    q = _plain(exact)
    return bool(q) and hit is not None and q in _plain(getattr(hit, "text", "") or "")


def locate(md: str, anchor: dict) -> tuple[int, int] | str:
    """Where the anchor's quote is in ``md``: (start, end), or why not: ``stale`` (not there any more) or
    ``unappliable`` (there, but across formatting a plain replacement would break)."""
    quote = (anchor or {}).get("quote") or {}
    exact = str(quote.get("exact") or "")
    pat = _pattern(exact)
    if pat is None:
        return "stale"
    lo = _front_matter_end(md)
    rng = _block_range(md, anchor)
    found = [m for m in pat.finditer(md, lo)]
    if rng is not None:
        inside = [m for m in found if m.start() >= rng[0] and m.end() <= rng[1]]
        if inside:
            found = inside
    if not found:
        return "unappliable" if _in_rendered_block(md, anchor, exact) else "stale"
    prefix = _plain(str(quote.get("prefix") or ""))
    suffix = _plain(str(quote.get("suffix") or ""))

    def score(m: re.Match) -> tuple[int, int]:
        before = _plain(md[max(0, m.start() - 120):m.start()])
        after = _plain(md[m.end():m.end() + 120])
        s = 0
        if prefix and before.endswith(prefix):
            s += 2
        elif prefix and prefix[-8:] and before.endswith(prefix[-8:]):
            s += 1
        if suffix and after.startswith(suffix):
            s += 2
        elif suffix and suffix[:8] and after.startswith(suffix[:8]):
            s += 1
        near = -abs(m.start() - rng[0]) if rng is not None else 0
        return s, near

    best = max(found, key=score)
    start, end = best.start(), best.end()
    if not _balanced(md[start:end]):
        return "unappliable"
    return start, end


def apply_text(md: str, anchor: dict, text: str) -> str | str:
    """``md`` with the quote replaced by ``text``; or the reason (``stale`` / ``unappliable``)."""
    at = locate(md, anchor)
    if isinstance(at, str):
        return at
    start, end = at
    return md[:start] + text + md[end:]


# ── Reading ───────────────────────────────────────────────────────────────────


async def _thread(db, raw: dict, thread_id: str) -> dict:
    from app.services.comments import service

    t = await service.load_thread(db, str(raw["_id"]), thread_id)
    if t is None or t.get("deleted_at") is not None:
        raise _err(404, "That comment thread isn't there any more.", "not_found")
    return t


async def _out(db, actor, raw: dict, ctx, thread: dict) -> dict:
    from app.services.comments import service

    return await service.thread_out(db, actor, raw, ctx, thread)


async def _people(db, ids: set[str]) -> dict[str, dict]:
    from app.services import page_history

    return await page_history._people(db, {i for i in ids if i})


def _person(pid: str | None, people: dict[str, dict], fallback: str | None = None) -> dict | None:
    if not pid and not fallback:
        return None
    who = people.get(pid or "") or {}
    return {"id": pid or None, "name": who.get("name") or fallback or "Someone", "picture": who.get("picture")}


async def detail(db, actor, raw: dict, ctx, thread_id: str) -> dict:
    """The thread's suggestion for this viewer, with what accepting it would do now:
    ``{suggestion, applies: bool, reason: None | stale | unappliable | locked | changed, holder, offer,
    before, after, can: {accept, reject, withdraw, edit}}``."""
    from app.services import pages
    from app.services.comments import perms

    p = await perms.require(db, actor, raw, ctx, "view")
    t = await _thread(db, raw, thread_id)
    s = t.get("suggestion") or None
    if not s:
        return {"suggestion": None, "applies": False, "reason": None, "holder": None, "offer": None,
                "before": None, "after": None, "can": {"accept": False, "reject": False, "withdraw": False,
                                                       "edit": False}}
    people = await _people(db, {s.get("by"), s.get("decided_by"), (s.get("offer") or {}).get("to"),
                                (s.get("offer") or {}).get("by")})
    me = actor.user_id
    is_open = s.get("state") == "open" and t.get("status") == "open"
    reason, before, after = None, None, None
    md = raw.get("content") or ""
    if is_open:
        if t.get("anchor_status") == "changed":
            reason = "changed"
        else:
            at = locate(md, t.get("anchor") or {})
            if isinstance(at, str):
                reason = at
            else:
                a, b = at
                ls = md.rfind("\n", 0, a) + 1
                le = md.find("\n", b)
                le = len(md) if le < 0 else le
                before = md[ls:le][:2000]
                after = (md[ls:a] + s.get("text", "") + md[b:le])[:4000]
    lock = pages.lock_view(raw.get("edit_lock"))
    holder = None
    if lock is not None and lock.get("user_id") != me:
        holder = {"name": lock.get("name") or "Someone", "you": False}
        if reason is None and is_open:
            reason = "locked"
    elif lock is not None:
        holder = {"name": lock.get("name") or "You", "you": True}
    offer = s.get("offer") or None
    offer_out = None
    if offer and is_open:
        offer_out = {"to": _person(offer.get("to"), people, offer.get("to_name")),
                     "by": _person(offer.get("by"), people, offer.get("by_name")),
                     "at": pages.iso(offer.get("at")), "mine": bool(me) and offer.get("to") == me}
    view = {"text": s.get("text") or "", "state": s.get("state"), "ai": bool(s.get("ai")),
            "by": _person(s.get("by"), people), "at": pages.iso(s.get("at")),
            "decided_by": _person(s.get("decided_by"), people), "decided_at": pages.iso(s.get("decided_at")),
            "version_id": s.get("version_id")}
    author = bool(me) and s.get("by") == me
    return {"suggestion": view, "applies": is_open and reason in (None, "locked") and p.accept,
            "reason": reason, "holder": holder, "offer": offer_out, "before": before, "after": after,
            "can": {"accept": is_open and p.accept, "reject": is_open and p.accept and not author,
                    "withdraw": is_open and author, "edit": is_open and author and p.comment}}


# ── Writing ───────────────────────────────────────────────────────────────────


async def _set(db, raw: dict, thread: dict, sets: dict, *, push: dict | None = None,
               expect_state: str | None = None) -> dict | None:
    q: dict = {"_id": thread["_id"]}
    if expect_state is not None:
        q["suggestion.state"] = expect_state
    upd: dict = {"$set": {**sets, "updated_at": now_utc()}}
    if push:
        upd["$push"] = {"history": {"$each": [push], "$slice": -model.HISTORY_MAX}}
    from pymongo import ReturnDocument

    return await db[model.THREADS].find_one_and_update(q, upd, return_document=ReturnDocument.AFTER)


async def _announce(db, raw: dict, thread: dict, kind: str, actor, extra: dict | None = None) -> None:
    from app.services.comments import service

    try:
        await service.touch(db, raw, thread, op=kind, actor=actor)
    except Exception:
        log.warning("comments: touch after %s failed", kind, exc_info=True)
    try:
        await events.emit(db, kind, doc=raw, thread=thread, actor=actor, extra=extra or {})
    except Exception:
        log.warning("comments: emit %s failed", kind, exc_info=True)


def _new(text: str, actor, *, ai: bool = False) -> dict:
    return {"text": text, "state": "open", "by": actor.user_id, "at": now_utc(), "decided_by": None,
            "decided_at": None, "version_id": None, "ai": bool(ai), "offer": None}


def _check_text(text: str) -> str:
    t = clean_text(text)
    if not t.strip():
        raise _err(422, "Write the text you suggest.", "empty")
    if len(t) > MAX_TEXT:
        raise _err(422, f"A suggestion can be up to {MAX_TEXT:,} characters.", "too_long")
    return t


async def on_create(db, raw: dict, thread: dict, text: str | None, actor) -> dict | None:
    """A new thread or a reply carried ``suggestion`` text (service.create_thread / reply, after the
    insert): stored on the thread when it is anchored to text and open. Returns the thread row after,
    or None when nothing was stored (no text, not a text anchor, closed)."""
    if text is None or not clean_text(text).strip():
        return None
    if (thread.get("anchor") or {}).get("type") != "text" or thread.get("status") != "open":
        return None
    t = _check_text(text)
    cur = thread.get("suggestion") or None
    if cur and cur.get("state") == "open" and cur.get("by") != actor.user_id:
        return None  # someone else's open suggestion stays; theirs to withdraw or an editor's to decide
    after = await _set(db, raw, thread, {"suggestion": _new(t, actor)})
    if after is not None:
        await _announce(db, raw, after, "suggestion_created", actor)
    return after


async def propose(db, actor, raw: dict, ctx, thread_id: str, text: str, *, ai: bool = False) -> dict:
    """Suggest ``text`` for the thread's quote (replacing your own open suggestion). ThreadOut."""
    from app.services.comments import perms

    await perms.require(db, actor, raw, ctx, "comment")
    t = await _thread(db, raw, thread_id)
    if (t.get("anchor") or {}).get("type") != "text":
        raise _err(422, "Suggested edits need a comment on selected text.", "needs_text_anchor")
    if t.get("status") != "open":
        raise _err(409, "Reopen the thread to suggest an edit.", "resolved")
    body = _check_text(text)
    cur = t.get("suggestion") or None
    if cur and cur.get("state") == "open" and cur.get("by") != actor.user_id:
        raise _err(409, "This thread already has a suggestion. Its author can withdraw it, or an editor can "
                        "decide on it first.", "suggestion_exists")
    after = await _set(db, raw, t, {"suggestion": _new(body, actor, ai=ai)})
    if after is None:
        raise _err(404, "That comment thread isn't there any more.", "not_found")
    await _announce(db, raw, after, "suggestion_created", actor, {"ai": bool(ai)})
    return await _out(db, actor, raw, ctx, after)


async def reject(db, actor, raw: dict, ctx, thread_id: str) -> dict:
    """Its author withdraws an open suggestion, or an editor rejects it. ThreadOut."""
    from app.services.comments import perms

    p = await perms.require(db, actor, raw, ctx, "comment")
    t = await _thread(db, raw, thread_id)
    s = t.get("suggestion") or None
    if not s or s.get("state") != "open":
        raise _err(409, "There's no open suggestion on this thread.", "no_suggestion")
    if s.get("by") != actor.user_id and not p.accept:
        raise _err(403, "Only the person who suggested it or an editor can do that.", "forbidden")
    at = now_utc()
    after = await _set(db, raw, t, {"suggestion.state": "rejected", "suggestion.decided_by": actor.user_id,
                                     "suggestion.decided_at": at, "suggestion.offer": None},
                       push={"action": "suggestion_rejected", "by": actor.user_id, "at": at, "to": None,
                             "version_id": None}, expect_state="open")
    if after is None:
        raise _err(409, "The suggestion changed meanwhile. Look again.", "suggestion_changed")
    await _announce(db, raw, after, "suggestion_rejected", actor,
                    {"withdrawn": s.get("by") == actor.user_id})
    return await _out(db, actor, raw, ctx, after)


async def _mark_stale(db, raw: dict, t: dict, actor) -> None:
    after = await _set(db, raw, t, {"suggestion.state": "stale", "suggestion.offer": None}, expect_state="open")
    if after is not None:
        from app.services.comments import service

        try:
            await service.touch(db, raw, after, op="suggestion_rejected", actor=actor)
        except Exception:
            log.warning("comments: touch after stale failed", exc_info=True)


async def accept(db, actor, raw: dict, ctx, thread_id: str, *, resolve: bool = True) -> dict:
    """Accept the thread's open suggestion: ``{"applied": bool, "offered": bool, "holder": name | None,
    "version_id": str | None, "rev": int | None, "thread": ThreadOut}``.

    Applied server-side when nobody else holds the page's edit lock (an MCP call: when nobody holds it at
    all); else offered to the holder (``applied`` False, ``offered`` True). Raises 409 ``suggestion_stale``
    (the quote isn't in the page any more: the suggestion is marked stale), ``suggestion_unappliable``,
    ``no_suggestion``; 423 for a locked page / signed-off section; 403 without edit rights."""
    from app.schemas.document import DocumentUpdate
    from app.services import document as doc_service
    from app.services import page_history, pages
    from app.services.comments import perms

    await perms.require(db, actor, raw, ctx, "accept")
    t = await _thread(db, raw, thread_id)
    s = t.get("suggestion") or None
    if not s or s.get("state") != "open":
        raise _err(409, "There's no open suggestion on this thread.", "no_suggestion")
    if t.get("status") != "open":
        raise _err(409, "Reopen the thread to accept its suggestion.", "resolved")
    for _attempt in range(_RETRIES):
        cur = await db["documents"].find_one({"_id": raw["_id"]})
        if cur is None:
            raise _err(404, "Document not found", "not_found")
        md = cur.get("content") or ""
        new = apply_text(md, t.get("anchor") or {}, s.get("text") or "")
        if new == "stale":
            await _mark_stale(db, cur, t, actor)
            raise _err(409, "The text this suggestion replaces has changed, so it can't be applied. "
                            "Suggest it again on the current text.", "suggestion_stale")
        if new == "unappliable":
            raise _err(409, "This suggestion crosses formatting (bold, a link…) that a one-click edit would "
                            "break. Copy it and edit the page by hand.", "suggestion_unappliable")
        lock = pages.lock_view(cur.get("edit_lock"))
        mcp = actor.cred == "mcp"
        if lock is not None and (mcp or lock.get("user_id") != actor.user_id):
            return await _offer(db, actor, cur, ctx, t, lock)
        if len(new) > _max_chars():
            raise _err(413, "The page would be longer than a page may be.", "too_long")
        event = {"type": "suggestion", "thread_id": str(t["_id"]),
                 "text": f"Suggested edit accepted ({_excerpt(s.get('text') or '', 120)})"}
        try:
            data = DocumentUpdate(title=cur.get("title") or None, content=new or "\n",
                                  base_rev=int(cur.get("rev") or 1))
        except Exception:
            raise _err(422, "That edit can't be saved.", "invalid")
        try:
            after_doc = await doc_service.update_document(db, cur["slug"], data, actor, ctx,
                                                          history={"kind": "suggestion", "event": event})
        except doc_service.StaleRevision:
            continue
        except HTTPException as exc:
            # Someone took the lock between our look and the write: offer it to them instead.
            if exc.status_code == 423 and (getattr(exc, "body", None) or {}).get("code") == "locked":
                fresh = await db["documents"].find_one({"_id": raw["_id"]}, {"edit_lock": 1})
                held = pages.lock_view((fresh or {}).get("edit_lock"))
                if held is not None:
                    return await _offer(db, actor, {**cur, "edit_lock": (fresh or {}).get("edit_lock")}, ctx, t, held)
            raise
        version_id = None
        if page_history.records(after_doc):
            top = await page_history.latest(db, str(after_doc["_id"]), {"n": 1, "event": 1})
            if top is not None and (top.get("event") or {}).get("thread_id") == str(t["_id"]):
                version_id = str(int(top["n"]))
        at = now_utc()
        done = await _set(db, after_doc, t, {
            "suggestion.state": "accepted", "suggestion.decided_by": actor.user_id, "suggestion.decided_at": at,
            "suggestion.version_id": version_id, "suggestion.offer": None},
            push={"action": "suggestion_accepted", "by": actor.user_id, "at": at, "to": None,
                  "version_id": version_id}, expect_state="open")
        if done is None:  # decided meanwhile (another editor): the page edit stands, the thread says theirs
            done = await _thread(db, after_doc, thread_id)
        await _reanchor_after(db, after_doc, done, s.get("text") or "")
        await _announce(db, after_doc, done, "suggestion_accepted", actor, {"version_id": version_id})
        if resolve and done.get("status") == "open":
            from app.services.comments import service

            try:
                await service.resolve(db, actor, after_doc, ctx, thread_id)
            except HTTPException:
                pass
        final = await _thread(db, after_doc, thread_id)
        return {"applied": True, "offered": False, "holder": None, "version_id": version_id,
                "rev": int(after_doc.get("rev") or 1), "thread": await _out(db, actor, after_doc, ctx, final)}
    raise _err(409, "The page kept changing. Try again.", "busy")


def _max_chars() -> int:
    from app.config import get_settings

    return int(get_settings().max_content_chars)


def _excerpt(text: str, n: int) -> str:
    t = re.sub(r"\s+", " ", text or "").strip()
    return t if len(t) <= n else t[: n - 1].rstrip() + "…"


async def _offer(db, actor, raw: dict, ctx, t: dict, lock: dict) -> dict:
    """Someone else is editing: the suggestion waits for them (their panel shows Apply)."""
    at = now_utc()
    offer = {"to": lock.get("user_id"), "to_name": lock.get("name") or "Someone", "by": actor.user_id,
             "by_name": _name(actor), "at": at}
    after = await _set(db, raw, t, {"suggestion.offer": offer}, expect_state="open")
    if after is None:
        raise _err(409, "The suggestion changed meanwhile. Look again.", "suggestion_changed")
    from app.services.comments import service

    try:
        await service.touch(db, raw, after, op="suggestion_created", actor=actor)
    except Exception:
        log.warning("comments: touch after offer failed", exc_info=True)
    return {"applied": False, "offered": True, "holder": lock.get("name") or "Someone", "version_id": None,
            "rev": int(raw.get("rev") or 1), "thread": await _out(db, actor, raw, ctx, after)}


async def _reanchor_after(db, doc: dict, thread: dict, text: str) -> None:
    """The accepted text is the thread's quote now (else the re-anchor on save just marked it changed)."""
    try:
        from app.services.comments import anchoring

        old = thread.get("anchor") or {}
        q = old.get("quote") or {}
        plain = re.sub(r"\s+", " ", re.sub(_MARK, "", text)).strip()[: model.MAX_QUOTE]
        if not plain:
            return
        anchor_in = {"type": "text", "block_id": old.get("block_id"),
                     "quote": {"exact": plain, "prefix": q.get("prefix") or "", "suffix": q.get("suffix") or ""},
                     "start": old.get("start")}
        new = anchoring.make_anchor(doc.get("content") or "", anchor_in, int(doc.get("rev") or 1))
        await db[model.THREADS].update_one({"_id": thread["_id"]},
                                           {"$set": {"anchor": new, "anchor_status": "attached"}})
        thread["anchor"], thread["anchor_status"] = new, "attached"
    except Exception:
        log.info("comments: re-anchoring an accepted suggestion failed", exc_info=True)


# ── Events ────────────────────────────────────────────────────────────────────


async def _on_resolved(db, ev: events.CommentEvent) -> None:
    """A thread resolved with its suggestion still open: the offer (if any) is dropped; the suggestion
    stays open so reopening brings it back."""
    s = (ev.thread or {}).get("suggestion") or None
    if s and s.get("state") == "open" and s.get("offer"):
        await db[model.THREADS].update_one({"_id": ev.thread["_id"], "suggestion.state": "open"},
                                           {"$set": {"suggestion.offer": None}})


events.on(_on_resolved, kinds=["resolved"], name="b.suggestions.resolved")


async def open_count(db, doc_id: str) -> int:
    """Open suggestions on an item (the sign-off guard and listings)."""
    return await db[model.THREADS].count_documents({"doc_id": doc_id, "status": "open", "deleted_at": None,
                                                    "suggestion.state": "open"})
