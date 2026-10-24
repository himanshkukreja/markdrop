"""The MCP tool catalogue and what each tool does.

Every tool is a thin layer over the services the website already uses, so the
access rules live in one place: `document.get_document` decides who may read
(password, private, workspace and grant gates included), `access.set_level`
who may change visibility, `document.update_document` / `artifact.*` how
content, passwords and expiry change. Nothing here re-implements a rule; the
only additions are narrower ones (assistants act on the user's *own* documents
for writes and stats) and refusals the API already makes elsewhere
(end-to-end encrypted content is never read or written).

Failures a model can act on are returned as tool errors (`ToolError`), in
plain language, rather than protocol errors.
"""

from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit

from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import ValidationError

from app.config import get_settings
from app.mcp.auth import READ, WRITE
from app.models.user import User
from app.routers import share as share_room
from app.schemas.document import DocumentCreate, DocumentUpdate
from app.services import access as access_service
from app.services import analytics
from app.services import artifact as art_service
from app.services import document as doc_service
from app.services import live, r2
from app.services.doc_ref import heading_title

settings = get_settings()

PUBLIC_BASE = "https://markdrop.in"
NOT_FOUND = "I couldn't find a document at that link, or you don't have access to it."
ENCRYPTED_READ = (
    "That document is end-to-end encrypted, so its contents can't be read here. "
    "Only a browser holding the key from its link can open it."
)
ENCRYPTED_WRITE = (
    "That document is end-to-end encrypted, so it can't be changed here: "
    "its key never leaves the browser that created it."
)
PASSWORD_GATED = (
    "That document is password-protected. Assistants can't unlock passwords; "
    "open the link in a browser instead."
)
NOT_OWNER = "You can only {action} documents you own."

PAGE_TYPES = {
    "html": "text/html",
    "htm": "text/html",
    "txt": "text/plain",
    "csv": "text/csv",
    "json": "application/json",
    "svg": "image/svg+xml",
}
EXPIRY_CHOICES = ["never", "1h", "1d", "7d", "30d"]
ACCESS_CHOICES = ["link", "private", "password"]
_SLUG_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# A share link is markdrop.in/share/<room id>.
SHARE_HOSTS = ("markdrop.in", "www.markdrop.in")
BAD_SHARE_LINK = (
    "That doesn't look like a Markdrop share link (https://markdrop.in/share/...) or a share id."
)
# list_shares reads at most this many of the user's newest share events before
# folding them into one row per share, so a heavy sharer can't make it scan
# their whole history.
SHARE_SCAN_ROWS = 2000
# get_document returns at most this much text, so one huge file can't flood a
# model's context; the result says when it was cut.
MAX_RETURNED_CHARS = 200_000


class ToolError(Exception):
    """A failure to report to the model as `isError: true`."""


@dataclass
class Context:
    db: AsyncIOMotorDatabase
    user: User
    client_id: str
    scopes: list[str]


@dataclass
class Tool:
    name: str
    title: str
    description: str
    scope: str
    input_schema: dict
    output_schema: dict
    annotations: dict
    handler: Callable[[Context, dict], Awaitable[tuple[str, dict]]]
    writes: bool = False

    def listing(self) -> dict:
        return {
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "inputSchema": self.input_schema,
            "outputSchema": self.output_schema,
            "annotations": {"title": self.title, **self.annotations},
        }


# ── Helpers ───────────────────────────────────────────────────────────────────


def public_url(slug: str) -> str:
    """markdrop.in/<slug>; a local sandbox links to its own frontend instead."""
    front = urlsplit(settings.frontend_url)
    if (front.hostname or "") in ("localhost", "127.0.0.1"):
        return f"{settings.frontend_url.rstrip('/')}/{slug}"
    return f"{PUBLIC_BASE}/{slug}"


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def resolve_ref(value: str) -> str:
    """A slug from a slug, '/slug', 'markdrop.in/slug' or a full link.

    A link's last path segment is the slug, which also covers workspace
    addresses such as docs.acme.com/reports/<slug>. Query strings and
    fragments (an encrypted document's key) are dropped.
    """
    text = (value or "").strip()
    if not text:
        raise ToolError("Give a document slug or its Markdrop link.")
    candidate = text
    if "/" in text or "." in text:
        if "://" in text:
            url = text
        elif text.startswith("/"):
            url = f"{PUBLIC_BASE}{text}"
        else:
            url = f"https://{text}"
        try:
            path = urlsplit(url).path
        except ValueError:
            raise ToolError("That doesn't look like a Markdrop link or slug.")
        segments = [s for s in path.split("/") if s]
        candidate = segments[-1] if segments else ""
    if not _SLUG_RE.match(candidate):
        raise ToolError("That doesn't look like a Markdrop link or slug.")
    return candidate


def access_of(level: str | None, has_password: bool) -> str:
    level = level or "link"
    if level != "link":
        return level
    return "password" if has_password else "link"


def kind_of(kind: str | None) -> str:
    return "artifact" if kind == "artifact" else "document"


def expiry(choice: str | None) -> tuple[str, datetime | None]:
    """DocumentCreate/Update's (expires_in, custom_expires_at) for a choice."""
    if choice == "1h":
        return "custom", datetime.now(timezone.utc) + timedelta(hours=1)
    return (choice or "never"), None


def access_choice(args: dict) -> tuple[str, str | None]:
    """(access, password) from publish arguments. A password alone implies
    password access; password access without one is refused."""
    password = args.get("password") or None
    access = args.get("access") or ("password" if password else "link")
    if access == "password" and not password:
        raise ToolError('Access "password" needs a password.')
    if password and access != "password":
        raise ToolError('A password only applies when access is "password".')
    return access, password


def http_message(exc: HTTPException) -> str:
    detail = exc.detail
    if isinstance(detail, str) and detail:
        return detail
    return "That didn't work. Try again."


async def load_raw(db: AsyncIOMotorDatabase, slug: str) -> dict:
    raw = await db["documents"].find_one({"slug": slug})
    if not raw:
        raise ToolError(NOT_FOUND)
    return raw


async def require_owner(ctx: Context, raw: dict, action: str) -> None:
    """Writes and stats are for the user's own documents. Someone who can see
    a document is told it isn't theirs; anyone else learns nothing."""
    if raw.get("owner_id") == ctx.user.id:
        return
    if await access_service.can_read(ctx.db, raw, ctx.user.id, ctx.user.email):
        raise ToolError(NOT_OWNER.format(action=action))
    raise ToolError(NOT_FOUND)


async def read_doc(ctx: Context, slug: str):
    """The document through the website's own read path: every gate applies."""
    try:
        return await doc_service.get_document(
            ctx.db, slug, read_password=None, edit_secret=None,
            user_id=ctx.user.id, user_email=ctx.user.email,
        )
    except HTTPException as exc:
        gate = (exc.headers or {}).get("X-Markdrop-Gate")
        if exc.status_code == 401 and gate == "password":
            raise ToolError(PASSWORD_GATED)
        raise ToolError(NOT_FOUND)


async def text_of(doc) -> tuple[str | None, str | None]:
    """(content, note): the readable text of a document or text artifact."""
    if doc.kind != "artifact":
        return doc.content, None
    label = art_service.label_for(doc.mime or "")
    if not art_service.is_syncable(doc.mime) or doc.bundle_prefix:
        return None, f"This is a {label}, not a text file, so only its link is available."
    if not r2.is_configured():
        return None, "File storage isn't available on this server, so the file can't be read."
    content = await art_service.read_content(doc)
    if content is None:
        return None, f"This {label} couldn't be read as text."
    return content, None


def _clip(content: str | None) -> tuple[str | None, bool]:
    if content is not None and len(content) > MAX_RETURNED_CHARS:
        return content[:MAX_RETURNED_CHARS], True
    return content, False


def display_title(doc) -> str | None:
    if doc.encrypted:
        return None
    if doc.title:
        return doc.title
    if doc.kind != "artifact":
        return heading_title(doc.content[:400])
    return doc.original_filename


def share_url(room_id: str) -> str:
    return public_url(f"share/{room_id}")


def resolve_share(value: str) -> str:
    """A share's room id from its link (markdrop.in/share/<id>, with or without
    www or a scheme; a local sandbox's own frontend too) or from the bare id."""
    text = (value or "").strip()
    if not text:
        raise ToolError("Give a Markdrop share link or share id.")
    if share_room._ROOM_ID.match(text):
        return text
    url = text if "://" in text else f"https://{text}"
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
    except ValueError:
        raise ToolError(BAD_SHARE_LINK)
    hosts = set(SHARE_HOSTS)
    front = (urlsplit(settings.frontend_url).hostname or "").lower()
    if front in ("localhost", "127.0.0.1"):
        hosts.update(("localhost", "127.0.0.1"))
    elif front:
        hosts.add(front)
    segments = [s for s in parts.path.split("/") if s]
    if (host not in hosts or len(segments) != 2 or segments[0] != "share"
            or not share_room._ROOM_ID.match(segments[1])):
        raise ToolError(BAD_SHARE_LINK)
    return segments[1]


def human_bytes(n: int | None) -> str | None:
    if n is None:
        return None
    if n < 1024:
        return f"{n} bytes"
    size = n / 1024
    for unit in ("KB", "MB"):
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} GB"


async def downloads_by_room(db: AsyncIOMotorDatabase, room_ids: list[str]) -> dict[str, int]:
    """Finished downloads per share, as reported by recipients' browsers."""
    if not room_ids:
        return {}
    rows = await db["share_transfers"].aggregate([
        {"$match": {"room_id": {"$in": room_ids}}},
        {"$group": {"_id": "$room_id", "n": {"$sum": 1}}},
    ]).to_list(length=len(room_ids))
    return {r["_id"]: int(r["n"]) for r in rows}


def share_fields(row: dict) -> dict:
    """The owner-only fields of a share, from its folded share_events row."""
    size = row.get("file_size")
    return {
        "file_name": row.get("file_name"),
        "file_count": int(row.get("file_count") or 1),
        "total_bytes": int(size) if isinstance(size, (int, float)) and not isinstance(size, bool) else None,
        "started_at": iso(row.get("started_at")),
    }


def share_label(fields: dict) -> str:
    name = fields["file_name"] or "a file"
    if fields["file_count"] > 1:
        name = f"{name} and {fields['file_count'] - 1} more"
    size = human_bytes(fields["total_bytes"])
    return f"{name} ({size})" if size else name


def _fold_shares(match: dict) -> list[dict]:
    """share_events → one row per share, newest first. A sender that reconnects
    logs the same room again: the newest row describes it, the oldest says when
    it started."""
    return [
        {"$match": match},
        {"$sort": {"ts": -1}},
        {"$limit": SHARE_SCAN_ROWS},
        {"$group": {
            "_id": "$room_id",
            "last": {"$first": "$ts"},
            "started_at": {"$min": "$ts"},
            "file_name": {"$first": "$file_name"},
            "file_size": {"$first": "$file_size"},
            "file_count": {"$first": "$file_count"},
        }},
        {"$sort": {"last": -1, "_id": 1}},
    ]


# ── Tools ─────────────────────────────────────────────────────────────────────


async def publish_document(ctx: Context, args: dict) -> tuple[str, dict]:
    markdown = args["markdown"]
    if len(markdown) > settings.max_content_chars:
        raise ToolError(
            f"Markdown documents are limited to {settings.max_content_chars:,} characters; "
            f"this one has {len(markdown):,}."
        )
    access, password = access_choice(args)
    expires_in, custom_at = expiry(args.get("expires"))
    title = (args.get("title") or "").strip() or None
    try:
        data = DocumentCreate(
            title=title,
            content=markdown,
            custom_slug=args.get("slug") or None,
            expires_in=expires_in,  # type: ignore[arg-type]
            custom_expires_at=custom_at,
            read_password=password,
            access_level="private" if access == "private" else "link",
        )
    except ValidationError:
        raise ToolError("Those publish settings aren't valid. Check the slug, title and password.")
    try:
        doc, _secret = await doc_service.create_document(ctx.db, data, owner_id=ctx.user.id)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    out = {
        "url": public_url(doc.slug),
        "slug": doc.slug,
        "title": doc.title,
        "access": access,
        "expires_at": iso(doc.expires_at),
    }
    who = {"link": "anyone with the link", "private": "only you",
           "password": "anyone with the link and the password"}[access]
    return f"Published: {out['url']} (visible to {who}).", out


async def publish_page(ctx: Context, args: dict) -> tuple[str, dict]:
    filename = args["filename"].strip().replace("\\", "/").rsplit("/", 1)[-1][:200]
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    mime = PAGE_TYPES.get(ext)
    if mime is None:
        raise ToolError(
            "publish_page takes .html, .htm, .txt, .csv, .json or .svg files. "
            "Use publish_document for markdown."
        )
    payload = args["content"].encode("utf-8")
    if len(payload) > art_service.MAX_SYNC_BYTES:
        mb = art_service.MAX_SYNC_BYTES // (1024 * 1024)
        raise ToolError(f"Files published here can be up to {mb} MB; this one is "
                        f"{len(payload) / (1024 * 1024):.1f} MB.")
    if not r2.is_configured() or not settings.artifact_origin_is_isolated:
        raise ToolError(
            "Publishing files isn't available on this server right now (file storage "
            "isn't configured). publish_document still works for markdown."
        )
    access, password = access_choice(args)
    level = "private" if access == "private" else "link"
    expires_in, custom_at = expiry(args.get("expires"))
    allowed, _used = await art_service.check_quota(ctx.db, ctx.user.id, len(payload))
    if not allowed:
        raise ToolError("Your Markdrop file storage is full. Delete some files and try again.")

    blob_key = art_service.make_blob_key(ctx.user.id, mime)
    public = not art_service.is_guarded(has_password=bool(password), access_level=level)
    # `live`: the bytes may later be replaced in place by update_document, so
    # the edge must revalidate rather than cache them.
    if not await run_in_threadpool(r2.put_bytes, blob_key, payload, mime, public, True):
        raise ToolError("The file couldn't be stored. Try again.")
    title = (args.get("title") or "").strip() or None
    try:
        doc, _secret = await art_service.create_artifact(
            ctx.db,
            user_id=ctx.user.id,
            blob_key=blob_key,
            mime=mime,
            size_bytes=len(payload),
            title=title,
            filename=filename,
            custom_slug=args.get("slug") or None,
            preferred_slug=filename,
            expires_in=expires_in,
            custom_expires_at=custom_at,
            read_password=password,
            access_level=level,
        )
    except HTTPException as exc:
        await run_in_threadpool(r2.delete, blob_key)
        raise ToolError(http_message(exc))
    except Exception:
        await run_in_threadpool(r2.delete, blob_key)
        raise
    out = {
        "url": public_url(doc.slug),
        "slug": doc.slug,
        "title": doc.title,
        "kind": "artifact",
        "access": access,
        "expires_at": iso(doc.expires_at),
    }
    return f"Published {filename}: {out['url']}", out


async def update_document(ctx: Context, args: dict) -> tuple[str, dict]:
    slug = resolve_ref(args["document"])
    raw = await load_raw(ctx.db, slug)
    await require_owner(ctx, raw, "update")
    if raw.get("encrypted"):
        raise ToolError(ENCRYPTED_WRITE)
    content = args["content"]
    title = args.get("title")
    if raw.get("kind") == "artifact":
        if not art_service.is_syncable(raw.get("mime")) or raw.get("bundle_prefix"):
            raise ToolError("That file isn't a text file, so it can't be updated here.")
        if not r2.is_configured():
            raise ToolError("File storage isn't available on this server, so files can't be updated.")
        status, doc = await art_service.sync_push_content(
            ctx.db, str(raw["_id"]), ctx.user.id, content, raw.get("rev", 1)
        )
        if status == "conflict":
            raise ToolError("The file changed while it was being updated. Try again.")
        if status == "too_large":
            raise ToolError(art_service.sync_size_error(len(content.encode("utf-8"))))
        if status != "ok" or doc is None:
            raise ToolError("The file couldn't be updated. Try again.")
        if title is not None:
            doc = await art_service.update_settings(
                ctx.db, slug, ctx.user.id, title=title, read_password=None,
                remove_password=False, expires_in=None, custom_expires_at=None,
            ) or doc
    else:
        if len(content) > settings.max_content_chars:
            raise ToolError(
                f"Markdown documents are limited to {settings.max_content_chars:,} characters."
            )
        try:
            data = DocumentUpdate(
                title=title if title is not None else raw.get("title"),
                content=content,
            )
        except ValidationError:
            raise ToolError("That title or content isn't valid.")
        try:
            doc = await doc_service.update_document(
                ctx.db, slug, data, None, ctx.user.id, user_email=ctx.user.email
            )
        except HTTPException as exc:
            raise ToolError(http_message(exc))
    live.publish(doc.slug, doc.rev)
    out = {"url": public_url(doc.slug), "slug": doc.slug, "rev": doc.rev,
           "updated_at": iso(doc.updated_at)}
    return f"Updated {out['url']} (revision {doc.rev}).", out


async def get_document(ctx: Context, args: dict) -> tuple[str, dict]:
    slug = resolve_ref(args["document"])
    doc = await read_doc(ctx, slug)
    if doc.encrypted:
        raise ToolError(ENCRYPTED_READ)
    content, note = await text_of(doc)
    content, clipped = _clip(content)
    if clipped:
        note = f"Only the first {MAX_RETURNED_CHARS:,} characters are included."
    out: dict[str, Any] = {
        "url": public_url(doc.slug),
        "slug": doc.slug,
        "title": display_title(doc),
        "kind": kind_of(doc.kind),
        "access": access_of(doc.access_level, bool(doc.read_password_hash)),
        "created_at": iso(doc.created_at),
        "updated_at": iso(doc.updated_at),
        "views": doc.views,
        "owner": "you" if doc.owner_id == ctx.user.id else "someone else",
    }
    if content is not None:
        out["content"] = content
    if note:
        out["note"] = note
    name = out["title"] or doc.slug
    if content is None:
        return f"{name} ({out['url']}): {note}", out
    head = f"{name} ({out['url']})" + (f"\n{note}" if note else "")
    return f"{head}\n\n{content}", out


async def list_documents(ctx: Context, args: dict) -> tuple[str, dict]:
    limit = int(args.get("limit") or 20)
    kind = {"all": None, "document": "document", "file": "artifact",
            "artifact": "artifact"}[args.get("kind") or "all"]
    page = _decode_cursor(args.get("cursor"))
    docs, total = await doc_service.list_user_documents(
        ctx.db, ctx.user.id, page, limit, args.get("query"), kind
    )
    items = [
        {
            "url": public_url(d.slug),
            "slug": d.slug,
            "title": display_title(d),
            "kind": kind_of(d.kind),
            "access": access_of(d.access_level, bool(d.read_password_hash)),
            "views": d.views,
            "updated_at": iso(d.updated_at),
            "encrypted": d.encrypted,
        }
        for d in docs
    ]
    more = page * limit < total
    out = {"items": items, "next_cursor": _encode_cursor(page + 1) if more else None}
    if not items:
        return "No documents found.", out
    lines = [f"- {i['title'] or i['slug']}: {i['url']}" for i in items]
    tail = "\n(More available: pass next_cursor.)" if more else ""
    return f"{len(items)} of {total} document(s):\n" + "\n".join(lines) + tail, out


def _encode_cursor(page: int) -> str:
    return base64.urlsafe_b64encode(f"p:{page}".encode()).decode().rstrip("=")


def _decode_cursor(cursor: str | None) -> int:
    if not cursor:
        return 1
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        page = int(raw.removeprefix("p:"))
    except (ValueError, UnicodeDecodeError):
        raise ToolError("That cursor isn't valid; start again without one.")
    if page < 1 or page > 10_000:
        raise ToolError("That cursor isn't valid; start again without one.")
    return page


async def set_access(ctx: Context, args: dict) -> tuple[str, dict]:
    slug = resolve_ref(args["document"])
    raw = await load_raw(ctx.db, slug)
    if raw.get("owner_id") != ctx.user.id:
        await require_owner(ctx, raw, "change access to")
    access = args["access"]
    password = args.get("password") or None
    if access == "password" and not password:
        raise ToolError('Access "password" needs a password.')
    if access != "password" and password:
        raise ToolError('A password only applies when access is "password".')
    expires_in, custom_at = expiry(args["expires"]) if args.get("expires") else (None, None)

    # Password and expiry go through the same update path as the site's own
    # settings dialog, which also keeps an artifact's stored bytes in step.
    try:
        update = DocumentUpdate(
            title=raw.get("title"),
            content=raw["content"],
            read_password=password if access == "password" else None,
            remove_password=access != "password",
            expires_in=expires_in,  # type: ignore[arg-type]
            custom_expires_at=custom_at,
        )
    except ValidationError:
        raise ToolError("Those access settings aren't valid.")
    try:
        # Close before opening, so the document is never more reachable in
        # between than at either end.
        if access == "private":
            await access_service.set_level(ctx.db, raw, "private", ctx.user.id)
        await doc_service.update_document(ctx.db, slug, update, None, ctx.user.id,
                                          user_email=ctx.user.email)
        if access != "private" and (raw.get("access_level") or "link") != "link":
            fresh = await load_raw(ctx.db, slug)
            await access_service.set_level(ctx.db, fresh, "link", ctx.user.id)
    except HTTPException as exc:
        raise ToolError(http_message(exc))

    final = await load_raw(ctx.db, slug)
    out = {
        "url": public_url(slug),
        "access": access_of(final.get("access_level"), bool(final.get("read_password_hash"))),
        "expires_at": iso(final.get("expires_at")),
    }
    live.publish(slug, final.get("rev", 1))
    who = {"link": "anyone with the link", "private": "only you",
           "password": "anyone with the link and the password"}.get(out["access"], out["access"])
    return f"{out['url']} is now visible to {who}.", out


async def delete_document(ctx: Context, args: dict) -> tuple[str, dict]:
    slug = resolve_ref(args["document"])
    raw = await load_raw(ctx.db, slug)
    await require_owner(ctx, raw, "delete")
    try:
        key = await doc_service.delete_document(ctx.db, slug, None, ctx.user.id)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    if key and r2.is_configured():
        if key.endswith("/"):
            await run_in_threadpool(r2.delete_prefix, key)
        else:
            await run_in_threadpool(r2.delete, key)
    return f"Deleted {slug}.", {"deleted": True, "slug": slug}


async def get_document_stats(ctx: Context, args: dict) -> tuple[str, dict]:
    slug = resolve_ref(args["document"])
    raw = await load_raw(ctx.db, slug)
    await require_owner(ctx, raw, "see stats for")
    doc_id = str(raw["_id"])
    data = await analytics.get_analytics(ctx.db, doc_id, "all")
    # Same filter as analytics.reading_stats: a read under two seconds is a bounce.
    depth_rows = await ctx.db["events"].aggregate([
        {"$match": {"doc_id": doc_id, "type": "read", "seconds": {"$gte": 2}}},
        {"$group": {"_id": None, "avg": {"$avg": "$depth"}}},
    ]).to_list(length=1)
    last = await ctx.db["events"].find(
        {"doc_id": doc_id, "type": "view"}, {"ts": 1}
    ).sort("ts", -1).limit(1).to_list(length=1)
    out = {
        "views": int(raw.get("views", 0)),
        "unique_readers": int(data["totals"]["unique_visitors"]),
        "reads": int(data["reading"]["reads"]),
        "avg_read_depth": round(depth_rows[0]["avg"], 1) if depth_rows and depth_rows[0].get("avg") is not None else None,
        "top_referrers": [
            {"referrer": r["referrer"], "views": int(r["views"])} for r in data["referrers"][:5]
        ],
        "last_viewed_at": iso(last[0]["ts"]) if last else None,
    }
    summary = f"{out['views']} view(s), {out['unique_readers']} unique reader(s)"
    if out["avg_read_depth"] is not None:
        summary += f", read {out['avg_read_depth']:.0f}% of the way on average"
    return summary + ".", out


async def search(ctx: Context, args: dict) -> tuple[str, dict]:
    query = args["query"].strip()[: doc_service.MAX_SEARCH_LEN]
    limit = 20
    docs, _total = await doc_service.list_user_documents(ctx.db, ctx.user.id, 1, limit, query, None)
    seen = {d.slug for d in docs}
    results = [{"id": d.slug, "title": display_title(d) or d.slug, "url": public_url(d.slug)} for d in docs]
    if query and len(results) < limit:
        # Then the text of the user's own readable markdown documents.
        cursor = ctx.db["documents"].find(
            {
                "owner_id": ctx.user.id,
                "encrypted": {"$ne": True},
                "kind": {"$ne": "artifact"},
                "slug": {"$nin": list(seen)},
                "content": {"$regex": re.escape(query), "$options": "i"},
            },
            {"slug": 1, "title": 1, "content": {"$substrCP": ["$content", 0, 400]}},
        ).sort("updated_at", -1).limit(limit - len(results))
        async for row in cursor:
            title = row.get("title") or heading_title(row.get("content")) or row["slug"]
            results.append({"id": row["slug"], "title": title, "url": public_url(row["slug"])})
    out = {"results": results}
    # ChatGPT's search/fetch contract: the text block is the JSON result itself.
    return json.dumps(out), out


async def fetch(ctx: Context, args: dict) -> tuple[str, dict]:
    slug = resolve_ref(args["id"])
    doc = await read_doc(ctx, slug)
    if doc.encrypted:
        raise ToolError(ENCRYPTED_READ)
    content, note = await text_of(doc)
    content, _clipped = _clip(content)
    out = {
        "id": doc.slug,
        "title": display_title(doc) or doc.slug,
        "text": content if content is not None else (note or ""),
        "url": public_url(doc.slug),
        "metadata": {"kind": kind_of(doc.kind), "updated_at": iso(doc.updated_at)},
    }
    return json.dumps(out), out


async def list_shares(ctx: Context, args: dict) -> tuple[str, dict]:
    limit = int(args.get("limit") or 20)
    live_only = bool(args.get("live_only"))
    pipeline = _fold_shares({"user_id": ctx.user.id})
    if not live_only:
        pipeline.append({"$limit": limit})
    shares: list[dict] = []
    async for row in ctx.db["share_events"].aggregate(pipeline):
        snap = share_room.room_snapshot(row["_id"])
        live = bool(snap and snap["host_online"])
        if live_only and not live:
            continue
        shares.append({
            "id": row["_id"],
            "url": share_url(row["_id"]),
            **share_fields(row),
            "live": live,
            "recipients_now": snap["guests"] if snap else 0,
        })
        if len(shares) >= limit:
            break
    done = await downloads_by_room(ctx.db, [s["id"] for s in shares])
    for s in shares:
        s["downloads_completed"] = done.get(s["id"], 0)
    out = {"shares": shares, "count": len(shares)}
    if not shares:
        if live_only:
            return "None of the user's shares is live right now.", out
        return ("No shares found. Shares started while signed in to Markdrop, or from the "
                "markdrop CLI with an API token, appear here."), out
    lines = []
    for s in shares:
        state = f"live, {s['recipients_now']} recipient(s) connected" if s["live"] else "ended"
        lines.append(f"- {share_label(s)}: {s['url']} ({state}; "
                     f"{s['downloads_completed']} download(s) completed)")
    return f"{len(shares)} share(s), newest first:\n" + "\n".join(lines), out


SHARE_REASONS = {
    "ok": "The sender is online: anyone with the link can open it and download now.",
    "held": (
        "The sender's connection dropped a moment ago. Recipients who open the link now "
        f"wait up to {share_room.KEY_HOLD_SECONDS // 60} minutes for the sender to come back."
    ),
    "no_sender": (
        "No one is sharing at this link right now: the sender stopped the share or went "
        "offline. Ask them to share again."
    ),
    "busy": (
        "The sender is online but already sending to someone, and this sender handles one "
        "recipient at a time. Try again when that download finishes."
    ),
    "full": (
        f"The sender is online but already sending to {share_room.MAX_GUESTS} people, the "
        "most at once. Try again shortly."
    ),
}


def join_state(snap: dict | None) -> tuple[bool, str]:
    """(can_join, reason): what the signalling server would do with a new
    recipient right now (routers/share.py, guest branch, in the same order)."""
    if snap is None or (not snap["host_online"] and not snap["held"]):
        return False, "no_sender"
    if snap["guests"] and not snap["multi"]:
        return False, "busy"
    if snap["guests"] >= share_room.MAX_GUESTS:
        return False, "full"
    if not snap["host_online"]:
        return True, "held"
    return True, "ok"


async def get_share_status(ctx: Context, args: dict) -> tuple[str, dict]:
    room_id = resolve_share(args["link"])
    snap = share_room.room_snapshot(room_id)  # read-only: never creates a room
    can_join, reason = join_state(snap)
    out: dict[str, Any] = {
        "id": room_id,
        "url": share_url(room_id),
        "sender_online": bool(snap and snap["host_online"]),
        "can_join": can_join,
        "reason": reason,
        "yours": False,
    }
    text = SHARE_REASONS[reason]
    # Only the user's own shares say what is being shared and to how many.
    # Anyone else learns no more than opening the link would tell them.
    rows = await ctx.db["share_events"].aggregate(
        _fold_shares({"user_id": ctx.user.id, "room_id": room_id})
    ).to_list(length=1)
    if rows:
        fields = share_fields(rows[0])
        done = (await downloads_by_room(ctx.db, [room_id])).get(room_id, 0)
        out.update(fields, yours=True, recipients_now=snap["guests"] if snap else 0,
                   downloads_completed=done)
        text += (f"\nThis is the user's share of {share_label(fields)}: "
                 f"{out['recipients_now']} recipient(s) connected now, {done} download(s) completed.")
    return text, out


# ── Schemas ───────────────────────────────────────────────────────────────────

_NULLABLE_STR = {"type": ["string", "null"]}
_DOC_REF = {
    "type": "string",
    "minLength": 1,
    "maxLength": 2048,
    "description": "The document's slug (e.g. 'q3-report') or its link (https://markdrop.in/q3-report).",
}
_ACCESS_OUT = {"type": "string", "enum": ["link", "private", "password", "workspace"]}
_PUBLISH_OPTIONS = {
    "title": {"type": "string", "maxLength": 200, "description": "Optional title shown on the page."},
    "slug": {
        "type": "string", "pattern": "^[a-zA-Z0-9_-]{3,50}$",
        "description": "Optional custom address: markdrop.in/<slug>. 3-50 letters, digits, - or _. Random if omitted.",
    },
    "access": {
        "type": "string", "enum": ACCESS_CHOICES, "default": "link",
        "description": "'link': anyone with the link (default). 'private': only the user. 'password': anyone with the link and the password.",
    },
    "password": {"type": "string", "minLength": 1, "maxLength": 100,
                 "description": "Required when access is 'password'."},
    "expires": {"type": "string", "enum": EXPIRY_CHOICES, "default": "never",
                "description": "When the link stops working."},
}


def _out(properties: dict, required: list[str] | None = None) -> dict:
    return {"type": "object", "properties": properties,
            "required": required if required is not None else list(properties)}


def _ann(read_only: bool, destructive: bool, idempotent: bool) -> dict:
    return {"readOnlyHint": read_only, "destructiveHint": destructive,
            "idempotentHint": idempotent, "openWorldHint": False}


TOOLS: list[Tool] = [
    Tool(
        name="publish_document",
        title="Publish a document",
        description=(
            "Publish markdown as a Markdrop document and get back a link that opens it "
            "rendered in any browser (headings, tables, code, Mermaid diagrams and math). "
            "Use it for notes, reports, docs and write-ups. Always give the user the returned url. "
            "Documents are readable by anyone with the link unless access is 'private' or 'password'."
        ),
        scope=WRITE,
        writes=True,
        input_schema={
            "type": "object",
            "properties": {
                "markdown": {"type": "string", "minLength": 1, "maxLength": settings.max_content_chars,
                             "description": "The document, in GitHub-flavoured markdown."},
                **_PUBLISH_OPTIONS,
            },
            "required": ["markdown"],
        },
        output_schema=_out({
            "url": {"type": "string"}, "slug": {"type": "string"}, "title": _NULLABLE_STR,
            "access": {"type": "string", "enum": ACCESS_CHOICES}, "expires_at": _NULLABLE_STR,
        }),
        annotations=_ann(False, False, False),
        handler=publish_document,
    ),
    Tool(
        name="publish_page",
        title="Publish a page or file",
        description=(
            "Publish a complete HTML page, or a text file (.txt, .csv, .json, .svg), as a Markdrop "
            "link that opens it rendered in the browser: HTML runs as a page, CSV shows as a table. "
            "Use publish_document for markdown instead. Always give the user the returned url."
        ),
        scope=WRITE,
        writes=True,
        input_schema={
            "type": "object",
            "properties": {
                "filename": {"type": "string", "minLength": 3, "maxLength": 200,
                             "description": "File name with its extension, e.g. 'report.html' or 'data.csv'."},
                "content": {"type": "string", "minLength": 1,
                            "description": "The complete file contents, as text."},
                **_PUBLISH_OPTIONS,
            },
            "required": ["filename", "content"],
        },
        output_schema=_out({
            "url": {"type": "string"}, "slug": {"type": "string"}, "title": _NULLABLE_STR,
            "kind": {"type": "string", "enum": ["artifact"]},
            "access": {"type": "string", "enum": ACCESS_CHOICES}, "expires_at": _NULLABLE_STR,
        }),
        annotations=_ann(False, False, False),
        handler=publish_page,
    ),
    Tool(
        name="update_document",
        title="Update a document",
        description=(
            "Replace the full content of a document or text file the user owns, keeping its link. "
            "Encrypted documents and non-text files can't be updated."
        ),
        scope=WRITE,
        writes=True,
        input_schema={
            "type": "object",
            "properties": {
                "document": _DOC_REF,
                "content": {"type": "string", "minLength": 1,
                            "description": "The new full content (markdown for documents, the file text for files)."},
                "title": {"type": "string", "maxLength": 200, "description": "Optional new title."},
            },
            "required": ["document", "content"],
        },
        output_schema=_out({
            "url": {"type": "string"}, "slug": {"type": "string"},
            "rev": {"type": "integer"}, "updated_at": {"type": "string"},
        }),
        annotations=_ann(False, True, True),
        handler=update_document,
    ),
    Tool(
        name="get_document",
        title="Read a document",
        description=(
            "Read a Markdrop document or text file by slug or link: its content, title, access and "
            "view count. Works for the user's own documents and for documents anyone with the link "
            "can read. Password-protected, private and encrypted documents of other people can't be read."
        ),
        scope=READ,
        input_schema={"type": "object", "properties": {"document": _DOC_REF}, "required": ["document"]},
        output_schema=_out(
            {
                "url": {"type": "string"}, "slug": {"type": "string"}, "title": _NULLABLE_STR,
                "kind": {"type": "string", "enum": ["document", "artifact"]},
                "content": {"type": "string"}, "note": {"type": "string"},
                "access": _ACCESS_OUT, "created_at": {"type": "string"},
                "updated_at": {"type": "string"}, "views": {"type": "integer"},
                "owner": {"type": "string", "enum": ["you", "someone else"]},
            },
            ["url", "slug", "title", "kind", "access", "created_at", "updated_at", "views", "owner"],
        ),
        annotations=_ann(True, False, True),
        handler=get_document,
    ),
    Tool(
        name="list_documents",
        title="List my documents",
        description="List the user's own Markdrop documents and files, newest first, optionally filtered by a title or slug search.",
        scope=READ,
        input_schema={
            "type": "object",
            "properties": {
                "query": {"type": "string", "maxLength": 200, "description": "Optional text to match in titles or slugs."},
                "kind": {"type": "string", "enum": ["all", "document", "file"], "default": "all",
                         "description": "'document' for markdown, 'file' for published pages and files."},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20},
                "cursor": {"type": "string", "maxLength": 100, "description": "next_cursor from a previous call."},
            },
        },
        output_schema=_out({
            "items": {"type": "array", "items": _out({
                "url": {"type": "string"}, "slug": {"type": "string"}, "title": _NULLABLE_STR,
                "kind": {"type": "string", "enum": ["document", "artifact"]}, "access": _ACCESS_OUT,
                "views": {"type": "integer"}, "updated_at": {"type": "string"},
                "encrypted": {"type": "boolean"},
            })},
            "next_cursor": _NULLABLE_STR,
        }),
        annotations=_ann(True, False, True),
        handler=list_documents,
    ),
    Tool(
        name="set_access",
        title="Change who can open a document",
        description=(
            "Change who can open one of the user's documents: 'link' (anyone with the link), "
            "'private' (only the user) or 'password' (anyone with the link and the password). "
            "Optionally set when the link expires."
        ),
        scope=WRITE,
        writes=True,
        input_schema={
            "type": "object",
            "properties": {
                "document": _DOC_REF,
                "access": {"type": "string", "enum": ACCESS_CHOICES},
                "password": {"type": "string", "minLength": 1, "maxLength": 100,
                             "description": "Required when access is 'password'."},
                "expires": {"type": "string", "enum": EXPIRY_CHOICES,
                            "description": "Optional: when the link stops working, counted from now."},
            },
            "required": ["document", "access"],
        },
        output_schema=_out({"url": {"type": "string"}, "access": _ACCESS_OUT, "expires_at": _NULLABLE_STR}),
        annotations=_ann(False, False, True),
        handler=set_access,
    ),
    Tool(
        name="delete_document",
        title="Delete a document",
        description="Permanently delete one of the user's documents or files. The link stops working and this can't be undone.",
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {"document": _DOC_REF}, "required": ["document"]},
        output_schema=_out({"deleted": {"type": "boolean"}, "slug": {"type": "string"}}),
        annotations=_ann(False, True, True),
        handler=delete_document,
    ),
    Tool(
        name="get_document_stats",
        title="Document stats",
        description="View counts, unique readers, read depth and top referrers for one of the user's own documents.",
        scope=READ,
        input_schema={"type": "object", "properties": {"document": _DOC_REF}, "required": ["document"]},
        output_schema=_out({
            "views": {"type": "integer"},
            "unique_readers": {"type": "integer"},
            "reads": {"type": "integer"},
            "avg_read_depth": {"type": ["number", "null"]},
            "top_referrers": {"type": "array", "items": _out({
                "referrer": {"type": "string"}, "views": {"type": "integer"}})},
            "last_viewed_at": _NULLABLE_STR,
        }),
        annotations=_ann(True, False, True),
        handler=get_document_stats,
    ),
    Tool(
        name="search",
        title="Search my documents",
        description="Search the user's own Markdrop documents by title, slug and text. Returns ids to pass to fetch.",
        scope=READ,
        input_schema={"type": "object", "properties": {
            "query": {"type": "string", "minLength": 1, "maxLength": 200}}, "required": ["query"]},
        output_schema=_out({"results": {"type": "array", "items": _out({
            "id": {"type": "string"}, "title": {"type": "string"}, "url": {"type": "string"}})}}),
        annotations=_ann(True, False, True),
        handler=search,
    ),
    Tool(
        name="fetch",
        title="Fetch a document",
        description="Fetch the full text of a document by the id returned from search (a slug or Markdrop link).",
        scope=READ,
        input_schema={"type": "object", "properties": {"id": {**_DOC_REF, "description": "An id from search, or a slug or link."}},
                      "required": ["id"]},
        output_schema=_out({
            "id": {"type": "string"}, "title": {"type": "string"}, "text": {"type": "string"},
            "url": {"type": "string"},
            "metadata": _out({"kind": {"type": "string", "enum": ["document", "artifact"]},
                              "updated_at": {"type": "string"}}),
        }),
        annotations=_ann(True, False, True),
        handler=fetch,
    ),
    Tool(
        name="list_shares",
        title="List my P2P shares",
        description=(
            "List the peer-to-peer file shares the user started while signed in (in the browser, or "
            "from the markdrop CLI with their API token), newest first, with whether each one is live "
            "right now and how many recipients are connected. downloads_completed counts downloads "
            "finished in a recipient's browser; downloads with the markdrop CLI aren't counted. "
            "This server can't send or receive files: that needs the markdrop CLI's local MCP server."
        ),
        scope=READ,
        input_schema={
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20},
                "live_only": {"type": "boolean", "default": False,
                              "description": "Only shares whose sender is online right now."},
            },
        },
        output_schema=_out({
            "shares": {"type": "array", "items": _out({
                "id": {"type": "string"}, "url": {"type": "string"},
                "file_name": _NULLABLE_STR, "file_count": {"type": "integer"},
                "total_bytes": {"type": ["integer", "null"]}, "started_at": {"type": "string"},
                "live": {"type": "boolean"}, "recipients_now": {"type": "integer"},
                "downloads_completed": {"type": "integer"},
            })},
            "count": {"type": "integer"},
        }),
        annotations=_ann(True, False, True),
        handler=list_shares,
    ),
    Tool(
        name="get_share_status",
        title="Check a share link",
        description=(
            "Check a Markdrop peer-to-peer share link (https://markdrop.in/share/...): whether the "
            "sender is online and recipients can join. For the user's own shares it also says what "
            "is being shared, how many recipients are connected and how many downloads finished."
        ),
        scope=READ,
        input_schema={
            "type": "object",
            "properties": {
                "link": {"type": "string", "minLength": 1, "maxLength": 2048,
                         "description": "The share link (https://markdrop.in/share/<id>) or just its id."},
            },
            "required": ["link"],
        },
        output_schema=_out(
            {
                "id": {"type": "string"}, "url": {"type": "string"},
                "sender_online": {"type": "boolean"}, "can_join": {"type": "boolean"},
                "reason": {"type": "string", "enum": list(SHARE_REASONS)},
                "yours": {"type": "boolean"},
                "file_name": _NULLABLE_STR, "file_count": {"type": "integer"},
                "total_bytes": {"type": ["integer", "null"]}, "started_at": {"type": "string"},
                "recipients_now": {"type": "integer"}, "downloads_completed": {"type": "integer"},
            },
            ["id", "url", "sender_online", "can_join", "reason", "yours"],
        ),
        annotations=_ann(True, False, True),
        handler=get_share_status,
    ),
]

BY_NAME: dict[str, Tool] = {t.name: t for t in TOOLS}
