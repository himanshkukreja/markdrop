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

from bson import ObjectId
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
from app.services import file_uploads
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
# Publishing / set_access also take "workspace" (members of its workspace).
ACCESS_WITH_WORKSPACE = ["link", "private", "password", "workspace"]
SCOPE_CHOICES = ["mine", "workspaces", "all"]
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
    password access; password access without one is refused. ("workspace"
    also needs a workspace argument; the publish tools check that.)"""
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


def actor_of(ctx: Context) -> access_service.Actor:
    """The MCP caller as access.can sees them: the user, through their token's
    scopes (writes need documents:write), never with a password."""
    return access_service.Actor(user=ctx.user, cred="mcp", scopes=frozenset(ctx.scopes or []))


def _markdrop_hosts() -> set[str]:
    hosts = {"markdrop.in", "www.markdrop.in"}
    front = (urlsplit(settings.frontend_url).hostname or "").lower()
    if front:
        hosts.add(front)
    if front in ("localhost", "127.0.0.1"):
        hosts.update(("localhost", "127.0.0.1"))
    return hosts


@dataclass
class Ref:
    slug: str
    scope: str | None = None     # workspace id when the link named a custom domain


async def resolve_doc(ctx: Context, value: str) -> Ref:
    """A document reference: slug, markdrop.in link, or a link on one of a
    workspace's own domains. A custom domain must be a *live* app host, and the
    document must belong to that host's workspace — otherwise "not found"
    (unknown hosts never resolve, §4.1 #34)."""
    slug = resolve_ref(value)
    text = (value or "").strip()
    host = ""
    if "/" in text or "." in text:
        url = text if "://" in text else (f"{PUBLIC_BASE}{text}" if text.startswith("/") else f"https://{text}")
        try:
            host = (urlsplit(url).hostname or "").lower().rstrip(".")
        except ValueError:
            host = ""
    if host and host not in _markdrop_hosts():
        from app.services import urls as urls_service

        row = await urls_service.live_host(ctx.db, host)
        if row is None:
            raise ToolError(NOT_FOUND)
        return Ref(slug, row["workspace_id"])
    return Ref(slug)


def deny(d: access_service.Decision, action: str) -> ToolError:
    """An access.can refusal in the words the tools use."""
    if d.code == "password":
        return ToolError(PASSWORD_GATED)
    if d.code == "scope":
        return ToolError("This needs the documents:write permission, which this app wasn't given.")
    if d.status in (401, 404) and d.code != "account":
        return ToolError(NOT_FOUND)
    if d.code == "wrong_password":
        return ToolError(PASSWORD_GATED)
    if action in _EDITOR_ACTIONS:
        return ToolError(NOT_OWNER.format(action=action).rstrip(".") + " or can edit.")
    return ToolError(NOT_OWNER.format(action=action))


_EDITOR_ACTIONS = {"update", "replace", "see the versions of", "restore versions of", "move"}


async def load_for(ctx: Context, value: str, perm: str, action: str) -> dict:
    """The document at ``value`` (following a rename, Q4) if access.can lets
    this caller ``perm`` it."""
    from app.services import document as _doc

    ref = await resolve_doc(ctx, value)
    raw, _moved = await _doc.find_for_read(ctx.db, ref.slug)
    d = await access_service.can(actor_of(ctx), raw, perm, access_service.Ctx(ctx.db, surface="mcp",
                                                                                workspace_scope=ref.scope))
    if not d.allowed:
        # A reader who may not change it is told so; anyone else learns nothing.
        if perm != "read" and d.status == 403:
            raise deny(d, action)
        rd = await access_service.can(actor_of(ctx), raw, "read",
                                      access_service.Ctx(ctx.db, workspace_scope=ref.scope))
        raise deny(rd if not rd.allowed else d, action)
    return raw


async def read_doc(ctx: Context, value: str):
    """The document through the one read rule (access.can): every gate applies,
    and a custom-domain link is scoped to its workspace."""
    from app.services.document import _doc_from_mongo

    raw = await load_for(ctx, value, "read", "read")
    return _doc_from_mongo(raw)


async def url_pair(ctx: Context, raw_or_doc) -> dict:
    """{url: canonical, markdrop_url, workspace_url} for tool output."""
    from app.services import urls as urls_service

    slug = raw_or_doc["slug"] if isinstance(raw_or_doc, dict) else raw_or_doc.slug
    ws_url = await urls_service.workspace_url(ctx.db, raw_or_doc)
    return {"url": ws_url or public_url(slug), "markdrop_url": public_url(slug), "workspace_url": ws_url}


async def resolve_workspace(ctx: Context, value: str) -> tuple[str, Any, str]:
    """A workspace the user belongs to: by exact id, then by one of its *live*
    domains, then by a name that matches exactly ONE of the user's workspaces.

    Never the first of several same-named workspaces: anyone can create a
    workspace, name it after yours and invite you, and "publish to Acme" must
    not land in theirs (C4). Ambiguous names are refused with the candidates
    (id and domains) so the caller can pick by id or domain."""
    from app.services import urls as urls_service
    from app.services import workspace as ws_service

    text = (value or "").strip()
    pairs = await ws_service.list_for_user(ctx.db, ctx.user.id)
    if not pairs:
        raise ToolError("The user isn't in any workspace yet.")
    for ws, role in pairs:
        if ws.id == text:
            return ws.id, ws, role
    host = text.lower()
    if "://" in host:
        host = (urlsplit(host).hostname or "").lower()
    host = host.split("/")[0].rstrip(".")
    if host and "." in host:
        row = await urls_service.live_host(ctx.db, host)
        if row:
            for ws, role in pairs:
                if ws.id == row.get("workspace_id"):
                    return ws.id, ws, role
    matches = [(ws, role) for ws, role in pairs if ws.name.strip().lower() == text.lower()]
    if len(matches) == 1:
        return matches[0][0].id, matches[0][0], matches[0][1]

    async def describe(ws) -> str:
        hosts = [r["host"] for r in await ctx.db["domains"].find(
            {"workspace_id": ws.id}).to_list(length=20) if urls_service.is_live(r)]
        return f"{ws.name} (id {ws.id}" + (f", {', '.join(hosts)}" if hosts else "") + ")"

    if len(matches) > 1:
        listing = "; ".join([await describe(ws) for ws, _ in matches])
        raise ToolError(f"More than one of the user's workspaces is called '{text}': {listing}. "
                        "Name the workspace by its id or its domain instead.")
    names = "; ".join([await describe(ws) for ws, _ in pairs])
    raise ToolError(f"The user isn't in a workspace matching '{text}'. Their workspaces: {names}.")


async def resolve_folder(ctx: Context, workspace_id: str, folder: str | None) -> str | None:
    from app.services import folder as folder_service

    if not folder or folder.strip() in ("", "/"):
        return None
    try:
        return await folder_service.resolve_ref(ctx.db, workspace_id, folder)
    except HTTPException as exc:
        raise ToolError(http_message(exc))


async def place(ctx: Context, raw: dict, workspace: str | None, folder: str | None,
                access: str | None, password: str | None) -> dict:
    """File a just-created document (born private) into a workspace, then give
    it the asked-for access; on failure it stays private and the error says so."""
    from app.services import library as lib_service

    ws_id, _ws, _role = await resolve_workspace(ctx, workspace)
    folder_id = await resolve_folder(ctx, ws_id, folder)
    actor = access_service.Actor.of(ctx.user)
    actx = access_service.Ctx(ctx.db)
    try:
        await lib_service.add_document(ctx.db, ws_id, str(raw["_id"]), ctx.user, folder_id)
        fresh = await ctx.db["documents"].find_one({"_id": raw["_id"]})
        if access == "password" and password:
            import bcrypt as _bcrypt

            await ctx.db["documents"].update_one(
                {"_id": raw["_id"]},
                {"$set": {"read_password_hash": _bcrypt.hashpw(password.encode(), _bcrypt.gensalt()).decode()}})
            fresh = await ctx.db["documents"].find_one({"_id": raw["_id"]})
            await access_service.set_level(ctx.db, fresh, "link", actor, actx)
        elif access in ("link", "workspace"):
            await access_service.set_level(ctx.db, fresh, access, actor, actx)
    except HTTPException as exc:
        raise ToolError(f"Created {raw['slug']} but couldn't add it to the workspace "
                        f"({http_message(exc)}); it is private to the user.")
    return await ctx.db["documents"].find_one({"_id": raw["_id"]})


async def precheck_workspace(ctx: Context, args: dict) -> tuple[str | None, str | None]:
    """Validate workspace + folder before anything is created (nothing is
    created when either is wrong). Returns (workspace id, folder id)."""
    from app.models.workspace import role_allows

    if not args.get("workspace"):
        if args.get("folder"):
            raise ToolError("A folder needs a workspace: pass workspace too.")
        return None, None
    ws_id, _ws, role = await resolve_workspace(ctx, args["workspace"])
    if not role_allows(role, "member"):
        raise ToolError("The user is a viewer of that workspace, so they can't add documents to it.")
    folder_id = await resolve_folder(ctx, ws_id, args.get("folder"))
    return ws_id, folder_id


async def workspace_default_access(ctx: Context, ws_id: str | None, args: dict) -> str:
    from app.services import workspace as _ws

    if args.get("access") or args.get("password") or not ws_id:
        return access_choice(args)[0]
    ws = await _ws.get_workspace(ctx.db, ws_id)
    return ws.settings.default_access if ws else "link"


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
    ws_id, _folder_id = await precheck_workspace(ctx, args)
    access = await workspace_default_access(ctx, ws_id, args)
    password = args.get("password") or None
    if access == "workspace" and not ws_id:
        raise ToolError('Access "workspace" needs a workspace: pass workspace too.')
    expires_in, custom_at = expiry(args.get("expires"))
    title = (args.get("title") or "").strip() or None
    try:
        data = DocumentCreate(
            title=title,
            content=markdown,
            custom_slug=args.get("slug") or None,
            expires_in=expires_in,  # type: ignore[arg-type]
            custom_expires_at=custom_at,
            read_password=password if not ws_id else None,
            # Born private when it is to be filed; opened once it is (A11).
            access_level="private" if (ws_id or access == "private") else "link",
        )
    except ValidationError:
        raise ToolError("Those publish settings aren't valid. Check the slug, title and password.")
    try:
        doc, _secret = await doc_service.create_document(ctx.db, data, owner_id=ctx.user.id)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    raw = await ctx.db["documents"].find_one({"slug": doc.slug})
    if ws_id:
        raw = await place(ctx, raw, args["workspace"], args.get("folder"), access, password)
    out = {
        **await url_pair(ctx, raw),
        "slug": doc.slug,
        "title": doc.title,
        "access": access,
        "expires_at": iso(doc.expires_at),
    }
    return f"Published: {out['url']} (visible to {await audience(ctx, raw)}).", out


def who_text(access: str, raw: dict | None = None, *, require_auth: bool = False) -> str:
    """Who can open it, in words. In a workspace that requires sign-in a link
    is not public: only its members and the people it is shared with get in
    (with the link), whatever the level says (C13)."""
    if require_auth and access in ("link", "password"):
        return ("members of its workspace and people it is shared with (the workspace requires "
                "sign-in, so the link alone opens nothing)")
    return {"link": "anyone with the link", "private": "only you",
            "password": "anyone with the link and the password",
            "workspace": "members of its workspace (and people it is shared with)"}.get(access, access)


async def audience(ctx: Context, raw: dict | None) -> str:
    """who_text for a stored row (level, password, its workspace's sign-in rule)."""
    from app.services import publicity

    raw = raw or {}
    ra = await publicity.workspace_requires_auth(ctx.db, raw.get("workspace_id"))
    return who_text(access_of(raw.get("access_level"), bool(raw.get("read_password_hash"))), raw,
                    require_auth=ra)


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
    ws_id, _folder_id = await precheck_workspace(ctx, args)
    access = await workspace_default_access(ctx, ws_id, args)
    password = args.get("password") or None
    if access == "workspace" and not ws_id:
        raise ToolError('Access "workspace" needs a workspace: pass workspace too.')
    level = "private" if (ws_id or access == "private") else "link"
    expires_in, custom_at = expiry(args.get("expires"))
    allowed, _used = await art_service.check_quota(ctx.db, ctx.user.id, len(payload))
    if not allowed:
        raise ToolError("Your Markdrop file storage is full. Delete some files and try again.")

    blob_key = art_service.make_blob_key(ctx.user.id, mime)
    public = not ws_id and not art_service.is_guarded(
        has_password=bool(password), access_level=level)
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
            read_password=password if not ws_id else None,
            access_level=level,
        )
    except HTTPException as exc:
        await run_in_threadpool(r2.delete, blob_key)
        raise ToolError(http_message(exc))
    except Exception:
        await run_in_threadpool(r2.delete, blob_key)
        raise
    raw = await ctx.db["documents"].find_one({"slug": doc.slug})
    if ws_id:
        raw = await place(ctx, raw, args["workspace"], args.get("folder"), access, password)
    out = {
        **await url_pair(ctx, raw),
        "slug": doc.slug,
        "title": doc.title,
        "kind": "artifact",
        "access": access,
        "expires_at": iso(doc.expires_at),
    }
    return f"Published {filename}: {out['url']}", out


async def update_document(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await load_for(ctx, args["document"], "edit_content", "update")
    slug = raw["slug"]
    if raw.get("encrypted"):
        raise ToolError(ENCRYPTED_WRITE)
    content = args["content"]
    title = args.get("title")
    actor = actor_of(ctx)
    actx = access_service.Ctx(ctx.db, surface="mcp")
    if raw.get("kind") == "artifact":
        if not art_service.is_syncable(raw.get("mime")) or raw.get("bundle_prefix"):
            label = art_service.label_for(raw.get("mime") or "")
            raise ToolError(
                f"That file ({label}) isn't a text file, so it can't be updated here. To replace "
                "its bytes and keep the link, use replace_file in the local Markdrop server "
                "(markdrop mcp) for a file on the user's computer, or create_upload then "
                "complete_upload here when you have a shell."
            )
        if not r2.is_configured():
            raise ToolError("File storage isn't available on this server, so files can't be updated.")
        status, doc = await art_service.sync_push_content(
            ctx.db, str(raw["_id"]), ctx.user.id, content, raw.get("rev", 1), authorized=True
        )
        if status == "conflict":
            raise ToolError("The file changed while it was being updated. Try again.")
        if status == "too_large":
            raise ToolError(art_service.sync_size_error(len(content.encode("utf-8"))))
        if status != "ok" or doc is None:
            raise ToolError("The file couldn't be updated. Try again.")
        if title is not None:
            try:
                after = await art_service.update_settings(
                    ctx.db, slug, actor, actx, title=title, read_password=None,
                    remove_password=False, expires_in=None, custom_expires_at=None,
                )
                from app.services.document import _doc_from_mongo

                doc = _doc_from_mongo(after)
            except HTTPException as exc:
                raise ToolError(http_message(exc))
        live.publish(doc.slug, doc.rev)
        from app.services import revalidate

        await revalidate.purge_doc(ctx.db, raw)
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
            after = await doc_service.update_document(ctx.db, slug, data, actor, actx)
        except HTTPException as exc:
            raise ToolError(http_message(exc))
        from app.services.document import _doc_from_mongo

        doc = _doc_from_mongo(after)
    out = {**await url_pair(ctx, await ctx.db["documents"].find_one({"slug": doc.slug}) or raw),
           "slug": doc.slug, "rev": doc.rev, "updated_at": iso(doc.updated_at)}
    return f"Updated {out['url']} (revision {doc.rev}).", out


async def _doc_meta(ctx: Context, raw: dict) -> dict:
    """workspace_id / folder / workspace_url for get_document (P6)."""
    folder = None
    if raw.get("workspace_id") and raw.get("folder_id"):
        f = await ctx.db["folders"].find_one({"_id": ObjectId(raw["folder_id"])}, {"name": 1}) \
            if ObjectId.is_valid(raw["folder_id"]) else None
        if f:
            folder = {"id": raw["folder_id"], "name": f.get("name"),
                      "path": "/".join(raw.get("folder_path") or [])}
    return {"workspace_id": raw.get("workspace_id"), "folder": folder}


async def get_document(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await load_for(ctx, args["document"], "read", "read")
    from app.services.document import _doc_from_mongo

    doc = _doc_from_mongo(raw)
    if doc.encrypted:
        raise ToolError(ENCRYPTED_READ)
    urls_out = await url_pair(ctx, raw)
    meta = await _doc_meta(ctx, raw)
    if doc.kind == "artifact" and (not art_service.is_syncable(doc.mime) or doc.bundle_prefix):
        # A video, PDF or image has no text to return: describe the file instead.
        info = jsonable(await file_uploads.file_info_for(ctx.db, raw))
        out = {
            **urls_out,
            "slug": doc.slug,
            "title": display_title(doc),
            "kind": "artifact",
            "access": access_of(doc.access_level, bool(doc.read_password_hash)),
            "created_at": iso(doc.created_at),
            "updated_at": iso(doc.updated_at),
            "views": doc.views,
            "owner": "you" if doc.owner_id == ctx.user.id else "someone else",
            **meta,
            "file": info,
        }
        return f"{out['title'] or doc.slug} ({out['url']}): {describe_file(info)}", out
    content, note = await text_of(doc)
    content, clipped = _clip(content)
    if clipped:
        note = f"Only the first {MAX_RETURNED_CHARS:,} characters are included."
    out: dict[str, Any] = {
        **urls_out,
        "slug": doc.slug,
        "title": display_title(doc),
        "kind": kind_of(doc.kind),
        "access": access_of(doc.access_level, bool(doc.read_password_hash)),
        "created_at": iso(doc.created_at),
        "updated_at": iso(doc.updated_at),
        "views": doc.views,
        "owner": "you" if doc.owner_id == ctx.user.id else "someone else",
        **meta,
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


async def scoped_documents(ctx: Context, scope: str, *, query: str | None, kind: str | None,
                           page: int, limit: int) -> tuple[list, int]:
    """mine: the user's own; workspaces: readable rows of the workspaces they
    belong to (A1 filter); all: both, plus documents shared with them."""
    from app.services import library as lib_service
    from app.services import workspace as ws_service
    from app.services.document import _doc_from_mongo

    if scope == "mine":
        return await doc_service.list_user_documents(ctx.db, ctx.user.id, page, limit, query, kind)
    actor = access_service.Actor.of(ctx.user)
    actx = access_service.Ctx(ctx.db)
    ors: list[dict] = []
    for ws, _role in await ws_service.list_for_user(ctx.db, ctx.user.id):
        rf = await access_service.readable_filter(actor, ws.id, actx)
        ors.append({"$and": [*rf.base, rf.readable]})
    if scope == "all":
        ors.append({"owner_id": ctx.user.id})
        granted = await access_service.granted_ids(actor, actx)
        if granted:
            ors.append({"_id": {"$in": granted}})
    if not ors:
        return [], 0
    clauses = [{"$or": ors}, access_service.not_expired_clause(actx.now)]
    kc = lib_service.kind_clause(kind)
    sf = lib_service.search_filter(query)
    clauses += [c for c in (kc, sf) if c]
    q = {"$and": clauses}
    total = await ctx.db["documents"].count_documents(q)
    rows = await ctx.db["documents"].find(q).sort("updated_at", -1).skip((page - 1) * limit).limit(limit).to_list(length=limit)
    out = []
    for r in rows:
        # Belt and braces: every row passes the single read rule (A1).
        if (await access_service.can(actor, r, "read", actx)).allowed:
            out.append(_doc_from_mongo(r))
    return out, total


async def list_documents(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import urls as urls_service

    limit = int(args.get("limit") or 20)
    kind = {"all": None, "document": "document", "file": "artifact",
            "artifact": "artifact"}[args.get("kind") or "all"]
    page = _decode_cursor(args.get("cursor"))
    scope = args.get("scope") or "mine"
    docs, total = await scoped_documents(ctx, scope, query=args.get("query"), kind=kind,
                                         page=page, limit=limit)
    hosts = urls_service.HostCache(ctx.db)
    items = []
    for d in docs:
        ws_url = await urls_service.workspace_url(ctx.db, d, hosts)
        items.append({
            "url": ws_url or public_url(d.slug),
            "markdrop_url": public_url(d.slug),
            "slug": d.slug,
            "title": display_title(d),
            "kind": kind_of(d.kind),
            "access": access_of(d.access_level, bool(d.read_password_hash)),
            "views": d.views,
            "updated_at": iso(d.updated_at),
            "encrypted": d.encrypted,
            "owner": "you" if d.owner_id == ctx.user.id else "someone else",
            "workspace_id": d.workspace_id,
        })
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
    raw = await load_for(ctx, args["document"], "change_access", "change access to")
    slug = raw["slug"]
    access = args["access"]
    password = args.get("password") or None
    if access == "password" and not password:
        raise ToolError('Access "password" needs a password.')
    if access != "password" and password:
        raise ToolError('A password only applies when access is "password".')
    if access == "workspace" and not raw.get("workspace_id"):
        raise ToolError("That document isn't in a workspace. Add it to one first "
                        "(add_to_workspace), then it can be workspace-only.")
    expires_in, custom_at = expiry(args["expires"]) if args.get("expires") else (None, None)
    actor = actor_of(ctx)
    actx = access_service.Ctx(ctx.db, surface="mcp")

    # One access level per document (D1). Close before opening: narrowing
    # steps (level down, password added) go first. A password is removed only
    # when the caller asked for plain "link"; going private or workspace-only
    # leaves it inert, so a later "link" doesn't silently publish without it
    # (policy §1.2, C5).
    try:
        update = DocumentUpdate(
            title=raw.get("title"),
            content=raw["content"],
            read_password=password if access == "password" else None,
            remove_password=access == "link" and bool(raw.get("read_password_hash")),
            expires_in=expires_in,  # type: ignore[arg-type]
            custom_expires_at=custom_at,
        )
    except ValidationError:
        raise ToolError("Those access settings aren't valid.")
    try:
        if access in ("private", "workspace"):
            await access_service.set_level(ctx.db, raw, access, actor, actx)
            raw = await load_raw(ctx.db, slug)
        if (update.read_password is not None or update.remove_password or update.expires_in is not None):
            await doc_service.update_document(ctx.db, slug, update, actor, actx)
            raw = await load_raw(ctx.db, slug)
        if access in ("link", "password") and (raw.get("access_level") or "link") != "link":
            await access_service.set_level(ctx.db, raw, "link", actor, actx)
    except HTTPException as exc:
        raise ToolError(http_message(exc))

    final = await load_raw(ctx.db, slug)
    out = {
        **await url_pair(ctx, final),
        "access": access_of(final.get("access_level"), bool(final.get("read_password_hash"))),
        "expires_at": iso(final.get("expires_at")),
    }
    text = f"{out['url']} is now visible to {await audience(ctx, final)}."
    from app.services import publicity

    if (final.get("workspace_id") and out["access"] in ("link", "password")
            and not await publicity.workspace_requires_auth(ctx.db, final.get("workspace_id"))):
        text += (" One access level applies to every address of the document, so it is now "
                 "public on markdrop.in and on its workspace's domains"
                 + (" (with the password)." if out["access"] == "password" else "."))
    elif final.get("read_password_hash") and out["access"] in ("private", "workspace"):
        text += " Its password is kept (inactive) and applies again if it is made a link."
    return text, out


async def delete_document(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await load_for(ctx, args["document"], "delete", "delete")
    slug = raw["slug"]
    try:
        await doc_service.delete_document(ctx.db, slug, actor_of(ctx), access_service.Ctx(ctx.db))
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    return f"Deleted {slug}.", {"deleted": True, "slug": slug}


async def get_document_stats(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await load_for(ctx, args["document"], "view_stats", "see stats for")
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
    scope = args.get("scope") or "mine"
    limit = 20
    docs, _total = await scoped_documents(ctx, scope, query=query, kind=None, page=1, limit=limit)
    seen = {d.slug for d in docs}
    results = []
    for d in docs:
        results.append({"id": d.slug, "title": display_title(d) or d.slug,
                        "url": (await url_pair(ctx, d))["url"]})
    if query and len(results) < limit and scope == "mine":
        # Then the text of the user's own readable markdown documents.
        cursor = ctx.db["documents"].find(
            {
                "owner_id": ctx.user.id,
                "encrypted": {"$ne": True},
                "kind": {"$ne": "artifact"},
                "slug": {"$nin": list(seen)},
                "content": {"$regex": re.escape(query), "$options": "i"},
                "$or": [{"expires_at": None}, {"expires_at": {"$gt": datetime.now(timezone.utc)}}],
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
    doc = await read_doc(ctx, args["id"])
    if doc.encrypted:
        raise ToolError(ENCRYPTED_READ)
    content, note = await text_of(doc)
    content, _clipped = _clip(content)
    out = {
        "id": doc.slug,
        "title": display_title(doc) or doc.slug,
        "text": content if content is not None else (note or ""),
        "url": (await url_pair(ctx, doc))["url"],
        "metadata": {"kind": kind_of(doc.kind), "updated_at": iso(doc.updated_at)},
    }
    return json.dumps(out), out


# ── Workspaces and folders (P6) ───────────────────────────────────────────────


async def list_workspaces(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import urls as urls_service
    from app.services import workspace as ws_service

    out = []
    for ws, role in await ws_service.list_for_user(ctx.db, ctx.user.id):
        rows = await ctx.db["domains"].find({"workspace_id": ws.id}).to_list(length=50)
        primary = await urls_service.live_primary_host(ctx.db, ws.id)
        out.append({
            "workspace_id": ws.id, "name": ws.name, "role": role,
            "custom_domains": [{"domain": r["host"], "verified": r.get("status") == "verified",
                                "live": urls_service.is_live(r), "default": r["host"] == primary}
                               for r in rows if r.get("kind") == "app"],
            "default_access": ws.settings.default_access,
        })
    if not out:
        return "The user isn't in any workspace.", {"workspaces": []}
    lines = [f"- {w['name']} ({w['workspace_id']}, {w['role']})"
             + (f": {', '.join(d['domain'] for d in w['custom_domains'] if d['live'])}"
                if any(d["live"] for d in w["custom_domains"]) else "")
             for w in out]
    return f"{len(out)} workspace(s):\n" + "\n".join(lines), {"workspaces": out}


async def list_folders(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import workspace_items

    ws_id, _ws, role = await resolve_workspace(ctx, args["workspace"])
    tree = await workspace_items.tree(ctx.db, access_service.Actor.of(ctx.user),
                                      access_service.Ctx(ctx.db), ws_id, role)
    folders = [{"id": f["id"], "name": f["name"], "path": f["path"], "depth": f["depth"],
                "items": f["total_count"]} for f in tree["folders"]]
    out = {"workspace_id": ws_id, "folders": folders, "root_items": tree["unfiled_count"]}
    if not folders:
        return "No folders yet (create one with create_folder).", out
    return "Folders:\n" + "\n".join(f"- {f['path']} ({f['items']} item(s))" for f in folders), out


async def list_workspace_items(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import workspace_items

    ws_id, _ws, _role = await resolve_workspace(ctx, args["workspace"])
    folder = "all"
    if args.get("folder"):
        folder = await resolve_folder(ctx, ws_id, args["folder"]) or "root"
    try:
        res = await workspace_items.items(
            ctx.db, access_service.Actor.of(ctx.user), access_service.Ctx(ctx.db), ws_id,
            folder=folder, q=args.get("query"), cursor=args.get("cursor"),
            limit=int(args.get("limit") or 50))
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    items = [{
        "slug": i["slug"], "title": i["title"], "kind": i["kind"], "url": i["url"],
        "markdrop_url": i["markdrop_url"], "access": i["access"], "redacted": i["redacted"],
        "folder": (i["folder"] or {}).get("path") if i.get("folder") else None,
        "owner": "you" if i["owner"]["is_you"] else (i["owner"]["name"] or "someone else"),
        "updated_at": iso(i.get("updated_at")),
    } for i in res["items"] if not i["redacted"]]
    out = {"items": items, "next_cursor": res["next_cursor"]}
    if not items:
        return "Nothing here that the user can open.", out
    return f"{len(items)} item(s):\n" + "\n".join(
        f"- {i['title'] or i['slug']}: {i['url']}" for i in items), out


async def add_to_workspace(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import library as lib_service

    raw = await load_for(ctx, args["document"], "read", "add")
    ws_id, ws, _role = await resolve_workspace(ctx, args["workspace"])
    folder_id = await resolve_folder(ctx, ws_id, args.get("folder"))
    level = args.get("access")
    try:
        # access.can(file_into_workspace): the owner, member+ of the target.
        await lib_service.add_document(ctx.db, ws_id, str(raw["_id"]), ctx.user, folder_id, level=level)
    except HTTPException as exc:
        if exc.status_code == 404 and exc.detail == "Document not found":
            raise ToolError("Only the document's owner can add it to a workspace.")
        raise ToolError(http_message(exc))
    final = await load_raw(ctx.db, raw["slug"])
    out = {**await url_pair(ctx, final), "slug": final["slug"], "workspace_id": ws_id,
           "folder": "/".join(final.get("folder_path") or []) or None,
           "access": access_of(final.get("access_level"), bool(final.get("read_password_hash")))}
    return (f"Added {final['slug']} to {ws.name}: {out['url']} (visible to "
            f"{await audience(ctx, final)})."), out


async def remove_from_workspace(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import library as lib_service

    ref = await resolve_doc(ctx, args["document"])
    from app.services import document as _doc

    raw, _moved = await _doc.find_for_read(ctx.db, ref.slug)
    if raw is None or not raw.get("workspace_id"):
        raise ToolError("That document isn't in a workspace." if raw else NOT_FOUND)
    try:
        res = await lib_service.remove_raw(ctx.db, raw["workspace_id"], raw, ctx.user)
    except HTTPException as exc:
        raise ToolError(NOT_FOUND if exc.status_code == 404 else http_message(exc))
    final = await load_raw(ctx.db, raw["slug"])
    out = {"slug": res["slug"], "access_after": res["access_after"], "url": public_url(res["slug"]),
           "markdrop_url": public_url(res["slug"])}
    return (f"Removed {res['slug']} from its workspace; it is now visible to "
            f"{await audience(ctx, final)}."), out


async def create_folder(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.models.workspace import role_allows
    from app.services import folder as folder_service

    ws_id, _ws, role = await resolve_workspace(ctx, args["workspace"])
    if not role_allows(role, "member"):
        raise ToolError("The user is a viewer of that workspace, so they can't create folders.")
    try:
        folder_id, created = await folder_service.ensure_path(ctx.db, ws_id, args["path"])
        path = await folder_service.path_of(ctx.db, ws_id, folder_id)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    out = {"workspace_id": ws_id, "folder_id": folder_id, "path": "/".join(path), "created": created}
    if not created:
        return f"The folder {out['path']} already exists.", out
    return f"Created {out['path']}.", out


async def move_to_folder(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import folder as folder_service

    raw = await load_for(ctx, args["document"], "move_in_workspace", "move")
    ws_id = raw["workspace_id"]
    folder_id = await resolve_folder(ctx, ws_id, args.get("folder"))
    try:
        after = await folder_service.file_document(ctx.db, raw, ws_id, folder_id)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    out = {**await url_pair(ctx, after), "slug": after["slug"],
           "folder": "/".join(after.get("folder_path") or []) or None}
    return f"Moved {after['slug']} to {out['folder'] or 'the workspace root'}: {out['url']}", out


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


# ── Files: upload, replace, versions ──────────────────────────────────────────
#
# Bytes never travel through a tool argument. create_upload hands back
# presigned part URLs and the exact shell commands that PUT the file's parts
# straight to storage; complete_upload then verifies the sha256 and publishes.
# (The local server, `markdrop mcp`, does all of this itself from a path.)


def jsonable(value: Any) -> Any:
    """Datetimes → ISO strings, recursively, for structuredContent."""
    if isinstance(value, datetime):
        return iso(value)
    if isinstance(value, dict):
        return {k: jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [jsonable(v) for v in value]
    return value


def _duration(seconds: float | None) -> str | None:
    if not seconds:
        return None
    s = int(round(seconds))
    h, rem = divmod(s, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def describe_file(info: dict) -> str:
    """One line about a file: type, size, version, and media facts if known."""
    label = art_service.label_for(info.get("content_type") or "")
    bits = [f"{label}, {human_bytes(info.get('size_bytes'))}", f"version {info.get('version')}"]
    m = info.get("media") or {}
    if _duration(m.get("duration_s")):
        bits.append(_duration(m.get("duration_s")))
    if m.get("width") and m.get("height"):
        bits.append(f"{m['width']}x{m['height']}")
    codecs = "/".join(c for c in (m.get("video_codec"), m.get("audio_codec")) if c)
    if codecs:
        bits.append(codecs)
    if info.get("sha256"):
        bits.append(f"sha256 {info['sha256'][:12]}…")
    return "; ".join(bits) + "."


def _file_out(info: dict) -> dict:
    out = jsonable(info)
    out["markdrop_url"] = public_url(info["slug"])
    out["url"] = info.get("workspace_url") or out["markdrop_url"]
    return out


def _http_tool_error(exc: HTTPException) -> ToolError:
    """The website's read gates, in the words the other tools use."""
    gate = (exc.headers or {}).get("X-Markdrop-Gate")
    if exc.status_code == 401 and gate == "password":
        return ToolError(PASSWORD_GATED)
    if exc.status_code in (401, 404):
        return ToolError(NOT_FOUND)
    return ToolError(http_message(exc))


def _require_files() -> None:
    if not r2.is_configured() or not settings.artifact_origin_is_isolated:
        raise ToolError("File uploads aren't available on this server right now (file storage isn't configured).")


def upload_instructions(file_name: str, upload_id: str, part_size: int, parts: list[dict]) -> str:
    """The exact commands that send a file's parts to their presigned URLs.

    `split` makes files of exactly part_size bytes (R2 wants every part but the
    last the same size), and `curl --upload-file` sends each with a
    Content-Length: R2 refuses chunked uploads, so never pipe from stdin."""
    import shlex

    prefix = f"/tmp/md-{upload_id}.part."
    lines = [
        f"FILE={shlex.quote(file_name)}   # use the file's full path",
        f'split -b {part_size} -d -a 4 "$FILE" {prefix}',
    ]
    for p in parts:
        n = int(p["part_number"])
        lines.append(
            f"printf '{n} '; curl -sS --fail -X PUT --upload-file {prefix}{n - 1:04d} "
            f"'{p['url']}' -D - -o /dev/null | grep -i '^etag'"
        )
    lines.append(f"rm -f {prefix}*")
    head = (
        f"Upload {file_name} in {len(parts)} part(s) of {part_size:,} bytes with the shell commands "
        "below. Each curl prints the part number and its ETag. Then call complete_upload with "
        f'upload_id "{upload_id}" and parts [{{"part_number": N, "etag": "..."}}] (or omit parts '
        "to use the parts storage received). The URLs expire in "
        f"{settings.file_upload_url_ttl // 60} minutes; calling create_upload again with the same "
        "arguments returns fresh ones for the same upload. Use curl --upload-file as shown: "
        "storage needs each part's Content-Length, so never stream a part from stdin."
    )
    return head + "\n\n" + "\n".join(lines)


async def create_upload(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.schemas.files import UploadCreateRequest

    _require_files()
    target = None
    if args.get("target_slug"):
        ref = await resolve_doc(ctx, args["target_slug"])
        target = ref.slug
    access = password = None
    if target is None and (args.get("access") or args.get("password")):
        access, password = access_choice(args)
    ws_id = None
    if target is not None and args.get("slug"):
        raise ToolError("slug applies to new uploads only (a replaced file keeps its link).")
    if args.get("workspace"):
        if target is not None:
            raise ToolError("workspace and folder apply to new uploads only.")
        ws_id, _folder_id = await precheck_workspace(ctx, args)
    try:
        data = UploadCreateRequest(
            file_name=args["file_name"].strip().replace("\\", "/").rsplit("/", 1)[-1][:255],
            size_bytes=args["size_bytes"],
            content_type=args.get("content_type") or "",
            sha256=args["sha256"],
            target_slug=target,
            title=(args.get("title") or "").strip() or None,
            access=access,
            password=password,
            workspace=ws_id,
            folder=args.get("folder") or None,
            slug=(args.get("slug") or None) if target is None else None,
        )
    except ValidationError:
        raise ToolError("Those upload details aren't valid. Check file_name, size_bytes, sha256 "
                        "(64 hex characters) and slug.")
    try:
        session = await file_uploads.create(ctx.db, ctx.user, data)
    except HTTPException as exc:
        raise _http_tool_error(exc)
    out = jsonable(session)
    out["instructions"] = upload_instructions(data.file_name, out["upload_id"], out["part_size"],
                                              out["parts"])
    return out["instructions"], out


async def complete_upload(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.schemas.files import UploadCompleteRequest

    _require_files()
    try:
        parsed = UploadCompleteRequest(parts=args.get("parts") or None)
    except ValidationError:
        raise ToolError('parts must be a list of {"part_number": N, "etag": "..."}.')
    parts = [p.model_dump() for p in parsed.parts] if parsed.parts else None
    try:
        status, body = await file_uploads.complete(ctx.db, ctx.user.id, args["upload_id"], parts)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    if status == 200:
        out = {"state": "done", **jsonable(body)}
        out["markdrop_url"] = public_url(body["slug"])
        if body.get("workspace_error"):
            out["note"] = body["workspace_error"]
        return (f"Uploaded: {out['url']} (version {out['version']}, {human_bytes(out['size_bytes'])}, "
                "sha256 verified)."), out
    if status == 202:
        out = {"state": "verifying", "upload_id": args["upload_id"]}
        return ("The parts are in and the file is still being verified (sha256 of a large file "
                "takes a while). Call get_upload_status with this upload_id until state is \"done\" "
                "(it then includes the result) or \"failed\"."), out
    raise ToolError(body.get("detail") or "The upload couldn't be completed.")


async def get_upload_status(ctx: Context, args: dict) -> tuple[str, dict]:
    try:
        st = await file_uploads.status(ctx.db, ctx.user.id, args["upload_id"])
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    out = jsonable(st)
    if out.get("result"):
        out["result"]["markdrop_url"] = public_url(out["result"]["slug"])
    state = out["state"]
    if state == "done":
        text = f"Done: {out['result']['url']} (version {out['result']['version']})."
    elif state == "failed":
        text = f"Failed: {out.get('error')}"
    elif state == "verifying":
        text = (f"Verifying: {human_bytes(out.get('verified_bytes') or 0)} of "
                f"{human_bytes(out['size_bytes'])} checked. Ask again in a few seconds.")
    elif state == "uploading":
        text = (f"Waiting for parts: {len(out['parts_uploaded'])} of {out['part_count']} received"
                + (f". Last error: {out['error']}" if out.get("error") else "."))
    else:
        text = f"This upload has {state}; start a new one with create_upload."
    return text, out


async def get_file_info(ctx: Context, args: dict) -> tuple[str, dict]:
    ref = await resolve_doc(ctx, args["document"])
    try:
        raw = await file_uploads.readable_artifact(ctx.db, ctx.user, ref.slug, scope=ref.scope)
    except HTTPException as exc:
        raise _http_tool_error(exc)
    info = _file_out(await file_uploads.file_info_for(ctx.db, raw))
    return f"{raw.get('title') or raw['slug']} ({info['url']}): {describe_file(info)}", info


async def _owned_file(ctx: Context, document: str, action: str) -> dict:
    """A file this user may see versions of / restore (owner, editors,
    members on non-private files — Q6)."""
    perm = "restore_version" if action.startswith("restore") else "list_versions"
    raw = await load_for(ctx, document, perm, action)
    if raw.get("kind") != "artifact":
        raise ToolError(f"{raw['slug']} is a markdown document, not a file; it has no file versions.")
    return raw


async def list_file_versions(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await _owned_file(ctx, args["document"], "see the versions of")
    out = jsonable(await file_uploads.versions(ctx.db, raw))
    lines = [
        f"- v{v['version']}{' (current)' if v['current'] else ''}: {human_bytes(v['size_bytes'])}, "
        f"{v['created_at'] or 'date unknown'}" + (f", sha256 {v['sha256'][:12]}…" if v["sha256"] else "")
        for v in out["versions"]
    ]
    return f"{len(lines)} version(s) of {(await url_pair(ctx, raw))['url']}, newest first:\n" + "\n".join(lines), out


async def restore_file_version(ctx: Context, args: dict) -> tuple[str, dict]:
    _require_files()
    raw = await _owned_file(ctx, args["document"], "restore versions of")
    try:
        info = await file_uploads.restore(ctx.db, ctx.user, raw, int(args["version"]))
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    out = _file_out(info)
    return (f"Version {args['version']} of {out['url']} is current again, as version {out['version']}. "
            "The link is unchanged."), out


# ── Schemas ───────────────────────────────────────────────────────────────────

_NULLABLE_STR = {"type": ["string", "null"]}
_DOC_REF = {
    "type": "string",
    "minLength": 1,
    "maxLength": 2048,
    "description": ("The document's slug (e.g. 'q3-report') or its link: https://markdrop.in/q3-report, "
                    "or its address on a workspace's custom domain (https://docs.acme.com/guides/q3-report)."),
}
_ACCESS_OUT = {"type": "string", "enum": ["link", "private", "password", "workspace"]}
_URL_PROPS = {
    "url": {"type": "string", "description": "Canonical link: the workspace's own domain when the "
                                             "document is filed in one with a live domain, else markdrop.in."},
    "markdrop_url": {"type": "string"},
    "workspace_url": _NULLABLE_STR if False else {"type": ["string", "null"]},
}
_WORKSPACE_ARG = {"type": "string", "minLength": 1, "maxLength": 300,
                  "description": ("A workspace the user belongs to: its id, its name, or one of its "
                                  "custom domains (see list_workspaces). The user must be a member.")}
_FOLDER_ARG = {"type": "string", "minLength": 1, "maxLength": 400,
               "description": ("An existing folder of that workspace, as a path like 'guides/setup' "
                               "(see list_folders). It must exist; create it with create_folder.")}
_PUBLISH_OPTIONS = {
    "title": {"type": "string", "maxLength": 200, "description": "Optional title shown on the page."},
    "slug": {
        "type": "string", "pattern": "^[a-zA-Z0-9_-]{3,50}$",
        "description": ("Optional custom address: markdrop.in/<slug>. 3-50 letters, digits, - or _. "
                        "Random if omitted. If it is taken you get an error (never a silent rename)."),
    },
    "access": {
        "type": "string", "enum": ACCESS_WITH_WORKSPACE,
        "description": ("'link': anyone with the link (the default outside a workspace). 'private': "
                        "only the user. 'password': anyone with the link and the password. "
                        "'workspace': members of its workspace (needs workspace). With workspace and no "
                        "access, the workspace's default access applies."),
    },
    "workspace": {**_WORKSPACE_ARG, "description": (
        "Optional: file it in this workspace (id, name or custom domain) — use it when the user "
        "mentions a workspace, team space or custom domain. Its link is then on that domain.")},
    "folder": {**_FOLDER_ARG, "description": "Optional: an existing folder of that workspace (path like 'guides/setup')."},
    "password": {"type": "string", "minLength": 1, "maxLength": 100,
                 "description": "Required when access is 'password'."},
    "expires": {"type": "string", "enum": EXPIRY_CHOICES, "default": "never",
                "description": "When the link stops working."},
}


def _out(properties: dict, required: list[str] | None = None) -> dict:
    return {"type": "object", "properties": properties,
            "required": required if required is not None else list(properties)}


_NULLABLE_INT = {"type": ["integer", "null"]}
_MEDIA = {
    "type": ["object", "null"],
    "description": "ffprobe's reading of a video or audio file; null until known.",
    "properties": {
        "duration_s": {"type": ["number", "null"]}, "width": _NULLABLE_INT, "height": _NULLABLE_INT,
        "video_codec": _NULLABLE_STR, "audio_codec": _NULLABLE_STR,
    },
}
_FILE_INFO = _out(
    {
        "slug": {"type": "string"}, "url": {"type": "string"}, "title": _NULLABLE_STR,
        "markdrop_url": {"type": ["string", "null"]}, "workspace_url": {"type": ["string", "null"]},
        "content_type": {"type": "string"}, "size_bytes": {"type": "integer"},
        "sha256": _NULLABLE_STR, "version": {"type": "integer"},
        "updated_at": {"type": "string"}, "created_at": {"type": "string"},
        "media": _MEDIA, "poster_url": _NULLABLE_STR, "download_url": _NULLABLE_STR,
        "access": _ACCESS_OUT,
    },
    ["slug", "url", "content_type", "size_bytes", "sha256", "version", "updated_at", "created_at",
     "media", "poster_url"],
)
_UPLOAD_ID = {"type": "string", "minLength": 1, "maxLength": 64, "pattern": "^up_[A-Za-z0-9_-]+$",
              "description": "The upload_id from create_upload."}
_RESULT_PROPS = {
    "url": {"type": "string"}, "markdrop_url": {"type": ["string", "null"]},
    "workspace_url": {"type": ["string", "null"]}, "workspace_error": {"type": ["string", "null"]},
    "slug": {"type": "string"}, "version": {"type": "integer"},
    "size_bytes": {"type": "integer"}, "content_type": {"type": "string"}, "sha256": {"type": "string"},
}


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
            **_URL_PROPS, "slug": {"type": "string"}, "title": _NULLABLE_STR,
            "access": _ACCESS_OUT, "expires_at": _NULLABLE_STR,
        }, ["url", "markdrop_url", "slug", "title", "access", "expires_at"]),
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
            **_URL_PROPS, "slug": {"type": "string"}, "title": _NULLABLE_STR,
            "kind": {"type": "string", "enum": ["artifact"]},
            "access": _ACCESS_OUT, "expires_at": _NULLABLE_STR,
        }, ["url", "markdrop_url", "slug", "title", "kind", "access", "expires_at"]),
        annotations=_ann(False, False, False),
        handler=publish_page,
    ),
    Tool(
        name="update_document",
        title="Update a document",
        description=(
            "Replace the full content of a document or text file the user owns or can edit (a "
            "document shared with them as an editor, or a non-private document of a workspace they "
            "are a member of), keeping its link. Encrypted documents and non-text files can't be updated."
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
            **_URL_PROPS, "slug": {"type": "string"},
            "rev": {"type": "integer"}, "updated_at": {"type": "string"},
        }, ["url", "markdrop_url", "slug", "rev", "updated_at"]),
        annotations=_ann(False, True, True),
        handler=update_document,
    ),
    Tool(
        name="get_document",
        title="Read a document",
        description=(
            "Read a Markdrop document or text file by slug or link — a markdrop.in link or a link on "
            "a workspace's own custom domain: its content, title, access, view count and workspace. "
            "Works for documents the user can open (their own, shared with them, their workspaces', "
            "and anyone-with-the-link ones). Password-protected and encrypted documents can't be read."
        ),
        scope=READ,
        input_schema={"type": "object", "properties": {"document": _DOC_REF}, "required": ["document"]},
        output_schema=_out(
            {
                **_URL_PROPS, "slug": {"type": "string"}, "title": _NULLABLE_STR,
                "workspace_id": _NULLABLE_STR,
                "folder": {"type": ["object", "null"]},
                "kind": {"type": "string", "enum": ["document", "artifact"]},
                "content": {"type": "string"}, "note": {"type": "string"},
                "access": _ACCESS_OUT, "created_at": {"type": "string"},
                "updated_at": {"type": "string"}, "views": {"type": "integer"},
                "owner": {"type": "string", "enum": ["you", "someone else"]},
                "file": _FILE_INFO,
            },
            ["url", "slug", "title", "kind", "access", "created_at", "updated_at", "views", "owner"],
        ),
        annotations=_ann(True, False, True),
        handler=get_document,
    ),
    Tool(
        name="list_documents",
        title="List my documents",
        description=("List Markdrop documents and files, newest first, optionally filtered by a title "
                     "or slug search. scope 'mine' (default): the user's own; 'workspaces': what they "
                     "can open in their workspaces; 'all': both plus documents shared with them."),
        scope=READ,
        input_schema={
            "type": "object",
            "properties": {
                "query": {"type": "string", "maxLength": 200, "description": "Optional text to match in titles or slugs."},
                "kind": {"type": "string", "enum": ["all", "document", "file"], "default": "all",
                         "description": "'document' for markdown, 'file' for published pages and files."},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20},
                "cursor": {"type": "string", "maxLength": 100, "description": "next_cursor from a previous call."},
                "scope": {"type": "string", "enum": SCOPE_CHOICES, "default": "mine"},
            },
        },
        output_schema=_out({
            "items": {"type": "array", "items": _out({
                **_URL_PROPS, "slug": {"type": "string"}, "title": _NULLABLE_STR,
                "kind": {"type": "string", "enum": ["document", "artifact"]}, "access": _ACCESS_OUT,
                "views": {"type": "integer"}, "updated_at": {"type": "string"},
                "encrypted": {"type": "boolean"}, "owner": {"type": "string"},
                "workspace_id": _NULLABLE_STR,
            }, ["url", "markdrop_url", "slug", "title", "kind", "access", "views", "updated_at",
                "encrypted"])},
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
            "'private' (only the user), 'password' (anyone with the link and the password) or "
            "'workspace' (members of the workspace it is in). A document has one access level for "
            "every address it has — markdrop.in and its workspace's custom domains alike — so 'link' "
            "on a workspace document makes it public everywhere. Optionally set when the link expires."
        ),
        scope=WRITE,
        writes=True,
        input_schema={
            "type": "object",
            "properties": {
                "document": _DOC_REF,
                "access": {"type": "string", "enum": ACCESS_WITH_WORKSPACE},
                "password": {"type": "string", "minLength": 1, "maxLength": 100,
                             "description": "Required when access is 'password'."},
                "expires": {"type": "string", "enum": EXPIRY_CHOICES,
                            "description": "Optional: when the link stops working, counted from now."},
            },
            "required": ["document", "access"],
        },
        output_schema=_out({**_URL_PROPS, "access": _ACCESS_OUT, "expires_at": _NULLABLE_STR},
                           ["url", "markdrop_url", "access", "expires_at"]),
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
        description=("Search Markdrop documents by title and slug (and, for the user's own, text). "
                     "scope 'mine' (default), 'workspaces' or 'all' as for list_documents. Returns ids "
                     "to pass to fetch."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "query": {"type": "string", "minLength": 1, "maxLength": 200},
            "scope": {"type": "string", "enum": SCOPE_CHOICES, "default": "mine"}}, "required": ["query"]},
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
            "right now and how many recipients are connected. A share is listed once its first "
            "recipient has connected; before that, check its link with get_share_status. "
            "downloads_completed counts downloads "
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
    Tool(
        name="create_upload",
        title="Start a file upload",
        description=(
            "Upload a file from the machine you run shell commands on (video up to 2 GB, PDF, image, "
            "HTML, spreadsheet...) as a Markdrop link, or replace the file behind an existing link "
            "with target_slug: the link, access, title and views stay the same and the previous "
            "version is kept and can be restored. Give the file's name, exact size in bytes and "
            "sha256 (e.g. `shasum -a 256 FILE`). Returns presigned part URLs plus the exact shell "
            "commands (split + curl) that send the bytes straight to storage; then call "
            "complete_upload. Never put file contents in an argument. If the user's computer runs "
            "the local Markdrop server (markdrop mcp), its upload_file / replace_file tools are simpler."
        ),
        scope=WRITE,
        writes=True,
        input_schema={
            "type": "object",
            "properties": {
                "file_name": {"type": "string", "minLength": 1, "maxLength": 255,
                              "description": "The file's name with its extension, e.g. 'demo.mp4'."},
                "size_bytes": {"type": "integer", "minimum": 1,
                               "description": "Exact size in bytes (e.g. `wc -c < FILE`)."},
                "content_type": {"type": "string", "maxLength": 255,
                                 "description": "MIME type, e.g. 'video/mp4'. Optional: the extension decides when omitted."},
                "sha256": {"type": "string", "pattern": "^[0-9a-fA-F]{64}$",
                           "description": "Hex sha256 of the file; the upload is verified against it."},
                "target_slug": {**_DOC_REF, "description": (
                    "Replace the file at this slug or link (one the user owns) instead of creating "
                    "a new link.")},
                "title": {"type": "string", "maxLength": 200, "description": "Optional title (a new title for a replaced file)."},
                "access": {**_PUBLISH_OPTIONS["access"], "description": (
                    "New uploads only: 'link' (default), 'private', 'password' or 'workspace' (needs workspace).")},
                "password": _PUBLISH_OPTIONS["password"],
                "workspace": {**_WORKSPACE_ARG, "description": "New uploads only: file it in this workspace (id, name or custom domain)."},
                "folder": {**_FOLDER_ARG, "description": "New uploads only: an existing folder of that workspace."},
                "slug": {**_PUBLISH_OPTIONS["slug"], "description": (
                    "New uploads only: a custom address (markdrop.in/<slug>), 3-50 letters, digits, "
                    "- or _. Taken or reserved is an error before any byte is sent, never a silent "
                    "rename. Default: derived from the file name.")},
            },
            "required": ["file_name", "size_bytes", "sha256"],
        },
        output_schema=_out({
            "upload_id": {"type": "string"}, "part_size": {"type": "integer"},
            "parts": {"type": "array", "items": _out({"part_number": {"type": "integer"},
                                                       "url": {"type": "string"}})},
            "expires_at": {"type": "string"}, "instructions": {"type": "string"},
        }),
        annotations=_ann(False, False, False),
        handler=create_upload,
    ),
    Tool(
        name="complete_upload",
        title="Finish a file upload",
        description=(
            "Finish an upload started with create_upload, once every part is uploaded: storage "
            "assembles the parts, Markdrop checks the size and sha256, then publishes the file (or "
            "swaps it in behind target_slug's link as a new version). Returns the link, or "
            "state 'verifying' for a large file: then poll get_upload_status. Safe to call again."
        ),
        scope=WRITE,
        writes=True,
        input_schema={
            "type": "object",
            "properties": {
                "upload_id": _UPLOAD_ID,
                "parts": {
                    "type": "array", "maxItems": 10000,
                    "description": ("Each part's number and the ETag its upload returned. Optional: "
                                    "omitted, the parts storage received are used."),
                    "items": {"type": "object", "properties": {
                        "part_number": {"type": "integer", "minimum": 1},
                        "etag": {"type": "string", "minLength": 1}},
                        "required": ["part_number", "etag"]},
                },
            },
            "required": ["upload_id"],
        },
        output_schema=_out(
            {"state": {"type": "string", "enum": ["done", "verifying"]}, "upload_id": {"type": "string"},
             **_RESULT_PROPS},
            ["state"],
        ),
        annotations=_ann(False, False, True),
        handler=complete_upload,
    ),
    Tool(
        name="get_upload_status",
        title="Check a file upload",
        description=(
            "State of an upload from create_upload: 'uploading' (with the parts received so far), "
            "'verifying', 'done' (with the result: link and version), 'failed' (with the error), "
            "'expired' or 'cancelled'."
        ),
        scope=READ,
        input_schema={"type": "object", "properties": {"upload_id": _UPLOAD_ID}, "required": ["upload_id"]},
        output_schema=_out(
            {
                "upload_id": {"type": "string"},
                "state": {"type": "string", "enum": ["uploading", "verifying", "done", "failed",
                                                     "expired", "cancelled"]},
                "file_name": {"type": "string"}, "content_type": {"type": "string"},
                "size_bytes": {"type": "integer"}, "sha256": {"type": "string"},
                "part_size": {"type": "integer"}, "part_count": {"type": "integer"},
                "parts_uploaded": {"type": "array", "items": _out({
                    "part_number": {"type": "integer"}, "etag": {"type": "string"},
                    "size": {"type": "integer"}})},
                "target_slug": _NULLABLE_STR, "expires_at": {"type": "string"},
                "verified_bytes": {"type": "integer"},
                "result": _out(_RESULT_PROPS, ["url", "slug", "version", "size_bytes", "content_type", "sha256"]),
                "error": {"type": "string"},
            },
            ["upload_id", "state", "size_bytes", "part_size", "part_count", "parts_uploaded", "expires_at"],
        ),
        annotations=_ann(True, False, True),
        handler=get_upload_status,
    ),
    Tool(
        name="get_file_info",
        title="File details",
        description=(
            "Details of a Markdrop file (video, PDF, image, page...) by slug or link: type, size, "
            "sha256, current version, duration and dimensions for video or audio, and poster and "
            "download links. Works for the user's files and files they can open."
        ),
        scope=READ,
        input_schema={"type": "object", "properties": {"document": _DOC_REF}, "required": ["document"]},
        output_schema=_FILE_INFO,
        annotations=_ann(True, False, True),
        handler=get_file_info,
    ),
    Tool(
        name="list_file_versions",
        title="List file versions",
        description=(
            "The kept versions of one of the user's files, newest first, marking the current one. "
            f"Up to {settings.file_versions_keep} versions are kept per file; restore one with "
            "restore_file_version."
        ),
        scope=READ,
        input_schema={"type": "object", "properties": {"document": _DOC_REF}, "required": ["document"]},
        output_schema=_out({"versions": {"type": "array", "items": _out(
            {
                "version": {"type": "integer"}, "size_bytes": {"type": "integer"},
                "sha256": _NULLABLE_STR, "content_type": {"type": "string"},
                "created_at": _NULLABLE_STR, "current": {"type": "boolean"}, "media": _MEDIA,
                "filename": _NULLABLE_STR,
            },
            ["version", "size_bytes", "sha256", "content_type", "created_at", "current"],
        )}}),
        annotations=_ann(True, False, True),
        handler=list_file_versions,
    ),
    Tool(
        name="restore_file_version",
        title="Restore a file version",
        description=(
            "Make an earlier version of one of the user's files current again, keeping its link. "
            "The restored file becomes a new version; nothing is deleted, so this can be undone by "
            "restoring again."
        ),
        scope=WRITE,
        writes=True,
        input_schema={
            "type": "object",
            "properties": {
                "document": _DOC_REF,
                "version": {"type": "integer", "minimum": 1,
                            "description": "The version number from list_file_versions."},
            },
            "required": ["document", "version"],
        },
        output_schema=_FILE_INFO,
        annotations=_ann(False, False, False),
        handler=restore_file_version,
    ),
]


_WS_ITEM = _out({
    "slug": {"type": "string"}, "title": _NULLABLE_STR, "kind": {"type": "string"},
    "url": {"type": "string"}, "markdrop_url": {"type": "string"}, "access": _ACCESS_OUT,
    "redacted": {"type": "boolean"}, "folder": _NULLABLE_STR, "owner": {"type": "string"},
    "updated_at": _NULLABLE_STR,
}, ["slug", "title", "kind", "url", "markdrop_url", "access", "owner"])

TOOLS += [
    Tool(
        name="list_workspaces",
        title="List my workspaces",
        description=("The workspaces the user belongs to: id, name, their role, custom domains (and "
                     "whether each is live) and the default access for new documents. Use the id, "
                     "name or a domain as `workspace` in the other tools."),
        scope=READ,
        input_schema={"type": "object", "properties": {}},
        output_schema=_out({"workspaces": {"type": "array", "items": _out({
            "workspace_id": {"type": "string"}, "name": {"type": "string"}, "role": {"type": "string"},
            "custom_domains": {"type": "array"}, "default_access": {"type": "string"},
        })}}),
        annotations=_ann(True, False, True),
        handler=list_workspaces,
    ),
    Tool(
        name="list_folders",
        title="List a workspace's folders",
        description="The folders of a workspace as paths (e.g. 'guides/setup'), with how many items the user can open in each.",
        scope=READ,
        input_schema={"type": "object", "properties": {"workspace": _WORKSPACE_ARG}, "required": ["workspace"]},
        output_schema=_out({"workspace_id": {"type": "string"}, "folders": {"type": "array"},
                            "root_items": {"type": "integer"}}),
        annotations=_ann(True, False, True),
        handler=list_folders,
    ),
    Tool(
        name="list_workspace_items",
        title="List a workspace's documents",
        description=("Documents and files in a workspace (or one folder of it) that the user can open, "
                     "newest first, with their canonical links (custom domain when live)."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "workspace": _WORKSPACE_ARG,
            "folder": {**_FOLDER_ARG, "description": "Optional: only this folder (path)."},
            "query": {"type": "string", "maxLength": 200},
            "cursor": {"type": "string", "maxLength": 300},
            "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 50},
        }, "required": ["workspace"]},
        output_schema=_out({"items": {"type": "array", "items": _WS_ITEM}, "next_cursor": _NULLABLE_STR}),
        annotations=_ann(True, False, True),
        handler=list_workspace_items,
    ),
    Tool(
        name="add_to_workspace",
        title="Add a document to a workspace",
        description=("File one of the user's own documents into a workspace (and optionally a folder). "
                     "It stays the same document with the same link; its access only changes when "
                     "`access` is given ('workspace' = members only). Returns its canonical link."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": _DOC_REF, "workspace": _WORKSPACE_ARG,
            "folder": {**_FOLDER_ARG, "description": "Optional: an existing folder (path)."},
            "access": {"type": "string", "enum": ["link", "private", "workspace"]},
        }, "required": ["document", "workspace"]},
        output_schema=_out({**_URL_PROPS, "slug": {"type": "string"}, "workspace_id": {"type": "string"},
                            "folder": _NULLABLE_STR, "access": _ACCESS_OUT},
                           ["url", "markdrop_url", "slug", "workspace_id", "access"]),
        annotations=_ann(False, False, True),
        handler=add_to_workspace,
    ),
    Tool(
        name="remove_from_workspace",
        title="Remove a document from its workspace",
        description=("Take a document out of its workspace (its owner, or a workspace admin). It keeps "
                     "its markdrop.in link; a workspace-only document becomes private."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {"document": _DOC_REF}, "required": ["document"]},
        output_schema=_out({"slug": {"type": "string"}, "access_after": {"type": "string"},
                            "url": {"type": "string"}, "markdrop_url": {"type": "string"}}),
        annotations=_ann(False, False, True),
        handler=remove_from_workspace,
    ),
    Tool(
        name="create_folder",
        title="Create a folder",
        description="Create a folder in a workspace by path ('guides/setup'), including any missing parent folders.",
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "workspace": _WORKSPACE_ARG,
            "path": {"type": "string", "minLength": 1, "maxLength": 400,
                     "description": "Folder path, e.g. 'guides/setup'."},
        }, "required": ["workspace", "path"]},
        output_schema=_out({"workspace_id": {"type": "string"}, "folder_id": {"type": "string"},
                            "path": {"type": "string"}, "created": {"type": "array"}}),
        annotations=_ann(False, False, True),
        handler=create_folder,
    ),
    Tool(
        name="move_to_folder",
        title="Move a document to a folder",
        description="Move a workspace document to another folder of the same workspace (omit folder for the root).",
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": _DOC_REF,
            "folder": {**_FOLDER_ARG, "description": "An existing folder (path); omit for the workspace root."},
        }, "required": ["document"]},
        output_schema=_out({**_URL_PROPS, "slug": {"type": "string"}, "folder": _NULLABLE_STR},
                           ["url", "markdrop_url", "slug"]),
        annotations=_ann(False, False, True),
        handler=move_to_folder,
    ),
]

BY_NAME: dict[str, Tool] = {t.name: t for t in TOOLS}
