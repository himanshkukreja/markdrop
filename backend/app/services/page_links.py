"""Backlinks: which pages mention, embed or link to a document.

``page_links`` holds one row per (page, target slug, kind): ``{from_doc,
to_slug, kind}`` with kind ``embed`` (``::markdrop{src=…}``), ``mention``
(``:markdrop[…]{src=…}``) or ``link`` (a Markdown link to markdrop.in/<slug>).
It is rewritten from the page's Markdown on every write (create, save, append,
sync) and dropped with the page.

``GET /documents/{slug}/backlinks`` answers only to someone who can read the
document, and lists only the pages *they* can read (``access.can`` per page):
a page they can't open is never named, counted or hinted at.
"""

from __future__ import annotations

import logging
import re

from motor.motor_asyncio import AsyncIOMotorDatabase

log = logging.getLogger(__name__)

COLL = "page_links"
MAX_PER_PAGE = 500
MAX_RESULTS = 200
_LINK = re.compile(r"\]\(\s*<?(?:https?://(?:www\.)?markdrop\.in)?/([A-Za-z0-9_-]{1,64})/?(?:[?#][^)\s>]*)?>?"
                   r"(?:\s+\"[^\"\n]*\")?\s*\)")


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLL].create_index("from_doc")
    await db[COLL].create_index("to_slug")


def targets(markdown: str | None) -> list[tuple[str, str]]:
    from app.services import pages

    out: list[tuple[str, str]] = []
    for r in pages.embed_refs(markdown):
        out.append((r["slug"], "mention" if r["mention"] else "embed"))
    for m in _LINK.finditer(markdown or ""):
        out.append((m.group(1), "link"))
    return list(dict.fromkeys(out))[:MAX_PER_PAGE]


async def reindex(db: AsyncIOMotorDatabase, raw: dict | None) -> None:
    """Rewrite the rows for ``raw`` from its Markdown. Never fails the write."""
    if not raw or raw.get("_id") is None:
        return
    # Every content write that rewrites a page's links also moves global search's content index
    # (services/search_index.py; async, off the request): sync pushes, MCP appends, copies…
    from app.services import search_index

    search_index.touch(db, raw["_id"])
    doc_id = str(raw["_id"])
    try:
        # The page's icon, copied out of its front matter so lists (sub-pages,
        # breadcrumbs, workspace rows, backlinks) can show it without the content.
        from app.services import page_props

        plain = not (raw.get("encrypted") or raw.get("kind") == "artifact")
        icon = page_props.parse(raw.get("content"))["icon"] if plain else None
        if icon != raw.get("page_icon"):
            await db["documents"].update_one({"_id": raw["_id"]}, {"$set": {"page_icon": icon}})
        found = [] if not plain else targets(raw.get("content"))
        found = [(s, k) for s, k in found if s != raw.get("slug")]
        existing = await db[COLL].find({"from_doc": doc_id}, {"to_slug": 1, "kind": 1}).to_list(length=MAX_PER_PAGE * 2)
        if {(r["to_slug"], r["kind"]) for r in existing} == set(found):
            return
        await db[COLL].delete_many({"from_doc": doc_id})
        if found:
            await db[COLL].insert_many([{"from_doc": doc_id, "to_slug": s, "kind": k} for s, k in found])
    except Exception:  # pragma: no cover - the index is best effort, the page is saved
        log.warning("reindexing the links of %s failed", raw.get("slug"), exc_info=True)


async def forget(db: AsyncIOMotorDatabase, doc_id: str) -> None:
    await db[COLL].delete_many({"from_doc": doc_id})


async def backlinks(db: AsyncIOMotorDatabase, raw: dict, actor, ctx) -> list[dict]:
    """The pages that point at ``raw`` (any of its slugs, old ones too) that
    this caller can read: ``[{slug, title, editor, updated_at, kinds}]``."""
    from bson import ObjectId

    from app.services import access, pages

    slugs = [raw["slug"], *(raw.get("old_slugs") or [])]
    rows = await db[COLL].find({"to_slug": {"$in": slugs}}, {"from_doc": 1, "kind": 1}).to_list(length=5000)
    kinds: dict[str, set] = {}
    for r in rows:
        if r["from_doc"] != str(raw["_id"]):
            kinds.setdefault(r["from_doc"], set()).add(r["kind"])
    oids = [ObjectId(i) for i in kinds if ObjectId.is_valid(i)]
    if not oids:
        return []
    docs = await db["documents"].find({"_id": {"$in": oids}, **access.NOT_TEMPLATE}, {"content": 0}).sort(
        "updated_at", -1).to_list(
        length=len(oids))
    out = []
    for d in docs:
        if not (await access.can(actor, d, "read", ctx)).allowed:
            continue
        out.append({"slug": d["slug"], "title": d.get("title") or d["slug"], "editor": d.get("editor"),
                    "updated_at": pages.iso(d.get("updated_at")),
                    "kinds": sorted(kinds.get(str(d["_id"]), set())),
                    **await pages.icon_fields(db, d)})
        if len(out) >= MAX_RESULTS:
            break
    return out
