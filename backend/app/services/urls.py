"""Where a document lives on the web (workspaces v2 spec, "URLs in responses").

``canonical_url(doc)`` is the custom-domain address
``https://<live primary host>/<folder_path…>/<slug>`` when the document is filed
in a workspace with a live primary app domain, else ``markdrop.in/<slug>``.
``workspace_url`` is the custom-domain address or None. Responses keep ``url`` =
markdrop.in for backwards compatibility, except MCP tools and files API results,
which return ``url`` = canonical and ``markdrop_url`` = markdrop.in.

A host is *live* when its domain row is ``kind=app ∧ status=verified ∧
attached ∧ ¬lapsed`` (policy §1.3, S3; :func:`is_live`). The canonical host is
the workspace's explicit primary if live, else its oldest live app domain.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings

settings = get_settings()
PUBLIC_BASE = "https://markdrop.in"


def markdrop_url(slug: str) -> str:
    """markdrop.in/<slug>; a local sandbox links to its own frontend instead."""
    front = urlsplit(settings.frontend_url)
    if (front.hostname or "") in ("localhost", "127.0.0.1"):
        return f"{settings.frontend_url.rstrip('/')}/{slug}"
    return f"{PUBLIC_BASE}/{slug}"


def _get(doc: Any, name: str, default=None):
    if isinstance(doc, dict):
        return doc.get(name, default)
    return getattr(doc, name, default)


class HostCache:
    """workspace id → live primary host (or None), per request."""

    def __init__(self, db: AsyncIOMotorDatabase):
        self.db = db
        self._hosts: dict[str, str | None] = {}

    async def primary(self, workspace_id: str | None) -> str | None:
        if not workspace_id:
            return None
        if workspace_id not in self._hosts:
            self._hosts[workspace_id] = await live_primary_host(self.db, workspace_id)
        return self._hosts[workspace_id]


def domain_status(row: dict) -> str:
    if row.get("status") == "lapsed" or row.get("lapsed"):
        return "lapsed"
    return "verified" if row.get("status") == "verified" else "pending"


def is_live(row: dict | None) -> bool:
    """A live app host (policy §1.3, S3): kind app ∧ verified ∧ attached ∧ ¬lapsed."""
    return bool(
        row
        and row.get("kind") == "app"
        and row.get("status") == "verified"
        and row.get("attached")
        and not row.get("lapsed")
    )


async def live_primary_host(db: AsyncIOMotorDatabase, workspace_id: str) -> str | None:
    """The workspace's primary host among its *live* app domains: the explicit
    primary if live, else the oldest live one."""
    rows = await db["domains"].find({"workspace_id": workspace_id, "kind": "app"}).to_list(length=50)
    live = [r for r in rows if is_live(r)]
    if not live:
        return None
    chosen = next((r for r in live if r.get("is_primary")), None)
    if chosen is None:
        live.sort(key=lambda r: r.get("created_at") or 0)
        chosen = live[0]
    return chosen["host"]


def normalize_host(raw: str | None) -> str:
    return (raw or "").strip().lower().split(":")[0].rstrip(".")


async def live_host(db: AsyncIOMotorDatabase, raw_host: str | None) -> dict | None:
    """The domain row for a live app host, or None (unknown, pending, cdn,
    detached or lapsed hosts never resolve)."""
    host = normalize_host(raw_host)
    if not host:
        return None
    row = await db["domains"].find_one({"host": host, "status": "verified"})
    return row if is_live(row) else None


def build_workspace_url(host: str | None, folder_path: list[str] | None, slug: str) -> str | None:
    if not host:
        return None
    path = "/".join([*(folder_path or []), slug])
    return f"https://{host}/{path}"


async def workspace_url(db: AsyncIOMotorDatabase, doc: Any, hosts: HostCache | None = None) -> str | None:
    ws_id = _get(doc, "workspace_id")
    if not ws_id:
        return None
    host = await (hosts or HostCache(db)).primary(ws_id)
    return build_workspace_url(host, _get(doc, "folder_path") or [], _get(doc, "slug"))


async def canonical_url(db: AsyncIOMotorDatabase, doc: Any, hosts: HostCache | None = None) -> str:
    return await workspace_url(db, doc, hosts) or markdrop_url(_get(doc, "slug"))
