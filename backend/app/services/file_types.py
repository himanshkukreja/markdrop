"""File types: the "what is it" filter on My files (and MCP list_documents).

A document is one of nine types. Markdown documents and pages are
``document``; an artifact's type follows from its MIME type through the same
whitelist that decides how it renders (``services.artifact``), so a new
artifact type lands in the right bucket by its renderer alone:

    document  markdown documents and pages (anything that isn't an artifact)
    pdf       PDF
    video     mp4, mov, webm, ogv
    image     png, jpg, gif, webp, svg
    sheet     xlsx, xls, csv
    slides    pptx
    word      docx
    html      HTML pages and web bundles (sites)
    other     every other artifact: text, JSON, audio, and anything unknown

The Mongo clause (``type_clause``) and the Python mapping (``type_of``) are
built from one table, so a row is counted under exactly the type that a filter
on that type returns.
"""

from app.services.artifact import _TYPES

FILE_TYPES: tuple[str, ...] = (
    "document", "pdf", "video", "image", "sheet", "slides", "word", "html", "other",
)

# Renderer → type. Renderers not listed here ("text", "audio", "download") are "other".
_BY_RENDERER = {
    "pdf": "pdf",
    "video": "video",
    "image": "image",
    "sheet": "sheet",
    "pptx": "slides",
    "docx": "word",
    "html": "html",
    "bundle": "html",
}

_MIMES: dict[str, tuple[str, ...]] = {
    t: tuple(a.mime for a in _TYPES if _BY_RENDERER.get(a.renderer) == t)
    for t in FILE_TYPES if t not in ("document", "other")
}
_NAMED_MIMES: tuple[str, ...] = tuple(m for ms in _MIMES.values() for m in ms)
_TYPE_BY_MIME: dict[str, str] = {m: t for t, ms in _MIMES.items() for m in ms}

# The pattern the HTTP route validates `type=` against.
TYPE_PATTERN = "^(" + "|".join(FILE_TYPES) + ")$"


def type_of(kind: str | None, mime: str | None) -> str:
    """The file type of a stored document (``kind`` absent on old documents = markdown)."""
    if kind != "artifact":
        return "document"
    return _TYPE_BY_MIME.get(mime or "", "other")


def type_clause(file_type: str | None) -> dict | None:
    """A Mongo filter for one type, or None for no filter (None, "", "all")."""
    if not file_type or file_type == "all":
        return None
    if file_type == "document":
        # Documents created before artifacts existed have no `kind` field.
        return {"kind": {"$ne": "artifact"}}
    if file_type == "other":
        # $nin also matches an artifact with no mime at all.
        return {"kind": "artifact", "mime": {"$nin": list(_NAMED_MIMES)}}
    mimes = _MIMES.get(file_type)
    if mimes is None:
        raise ValueError(f"unknown file type: {file_type}")
    return {"kind": "artifact", "mime": {"$in": list(mimes)}}


def empty_counts() -> dict[str, int]:
    return {t: 0 for t in FILE_TYPES}


def counts_from_groups(rows: list[dict]) -> dict[str, int]:
    """Fold ``$group`` rows keyed ``{"kind", "mime"}`` (with ``n``) into per-type counts."""
    out = empty_counts()
    for r in rows:
        key = r.get("_id") or {}
        out[type_of(key.get("kind"), key.get("mime"))] += int(r.get("n") or 0)
    return out
