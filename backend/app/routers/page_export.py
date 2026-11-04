"""Export a page (services/page_export.py).

    GET /api/v1/documents/{slug}/export?format=md|html|zip&subpages=0|1
        The page as portable Markdown (.md), one self-contained HTML file (.html), or a .zip
        (page.md + images/, and a folder per sub-page with ``subpages=1``; ``format=html`` with
        ``subpages=1`` zips HTML pages). can(read), then editors always, readers unless the page
        has ``allow_export: false``. 422 ``{code: "encrypted"}`` for an end-to-end encrypted
        document (its browser exports it), 413 ``too_many_pages``.
    GET /api/v1/documents/{slug}/export/download?token=…
        The same, for a link ``export_page`` (MCP) handed out: ten minutes, re-checked for its
        user when it's used.
"""

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import optional_user
from app.services import access
from app.services import page_export as export

router = APIRouter(prefix="/api/v1/documents", tags=["documents"])

_HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    # An exported HTML page never runs as part of the API's origin.
    "Content-Security-Policy": "sandbox; default-src 'none'",
}
_TYPES = {"md": "text/markdown; charset=utf-8", "html": "text/html; charset=utf-8"}


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


async def respond(db: AsyncIOMotorDatabase, raw: dict, actor: access.Actor, person: access.Actor,
                  ctx: access.Ctx, fmt: str, subpages: bool):
    p = await export.plan(db, raw, actor, person, ctx, fmt=fmt, subpages=subpages)
    name = export.filename(p)
    headers = {**_HEADERS, "Content-Disposition": export.content_disposition(name)}
    if p.notes:
        headers["X-Markdrop-Export-Notes"] = str(len(p.notes))
    if not p.zip:
        root = p.pages[0]
        if p.fmt == "html":
            await export.inline_images(root)
        body = export.render(root, p.fmt)
        return Response(body.encode(), media_type=_TYPES[p.fmt], headers=headers)
    texts = export.zip_texts(p)
    return StreamingResponse(export.zip_stream(p, texts), media_type="application/zip", headers=headers)


@router.get("/{slug}/export")
@limiter.limit("30/minute")
async def export_page(
    request: Request,
    slug: str,
    format: str = Query("md", pattern="^(md|html|zip)$"),
    subpages: bool = Query(False),
    db: AsyncIOMotorDatabase = Depends(get_db),
    x_read_password: str | None = Header(None),
    x_edit_secret: str | None = Header(None),
    x_markdrop_workspace: str | None = Header(None),
    user: User | None = Depends(optional_user),
):
    """The page as a file to download (see the module docstring)."""
    from app.routers.documents import _ctx

    actor = access.actor_from_request(request, user, edit_secret=x_edit_secret, read_password=x_read_password)
    ctx = _ctx(db, request, x_markdrop_workspace)
    raw = await db["documents"].find_one({"slug": slug})
    await access.require(actor, raw, "read", ctx)
    await export.check_allowed(actor, raw, ctx)
    # Embedded items are resolved for the person (not with this page's password or secret).
    person = access.actor_from_request(request, user)
    return await respond(db, raw, actor, person, ctx, format, subpages)


@router.get("/{slug}/export/download")
@limiter.limit("30/minute")
async def export_download(request: Request, slug: str, token: str = Query(..., max_length=2000),
                          db: AsyncIOMotorDatabase = Depends(get_db)):
    """An export link from ``export_page`` (MCP), for the user it was made for."""
    from app.services import user as user_service

    gone = HTTPException(status_code=404, detail="This download link has expired. Export the page again.")
    data = export.redeem(slug, token)
    if data is None:
        raise gone
    user = await user_service.get_user_by_id(db, data["u"])
    if user is None:
        raise gone
    actor = access.Actor.of(user, cred="mcp", scopes=frozenset({"documents:read"}))
    ctx = access.Ctx(db, surface="mcp")
    raw = await db["documents"].find_one({"slug": slug})
    if not (await access.can(actor, raw, "read", ctx)).allowed:
        raise gone
    await export.check_allowed(actor, raw, ctx)
    return await respond(db, raw, actor, actor, ctx, data["f"], bool(data.get("sp")))
