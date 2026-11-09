"""Export a page (services/page_export.py).

    GET /api/v1/documents/{slug}/export?format=md|html|zip|docx&subpages=0|1&comments=footnotes|margin&comment_status=open|all
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
from fastapi.responses import HTMLResponse, Response, StreamingResponse
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
_TYPES = {"md": "text/markdown; charset=utf-8", "html": "text/html; charset=utf-8",
          "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


async def respond(db: AsyncIOMotorDatabase, raw: dict, actor: access.Actor, person: access.Actor,
                  ctx: access.Ctx, fmt: str, subpages: bool, comments: str | None = None,
                  comment_status: str = "all"):
    p = await export.plan(db, raw, actor, person, ctx, fmt=fmt, subpages=subpages, comments=comments,
                          comment_status=comment_status)
    name = export.filename(p)
    headers = {**_HEADERS, "Content-Disposition": export.content_disposition(name)}
    if p.notes:
        headers["X-Markdrop-Export-Notes"] = str(len(p.notes))
    if p.comment_style or comments:
        root = p.pages[0]
        headers["X-Markdrop-Export-Comments"] = str(len(root.comments)) if root.comments is not None else "none"
    if p.fmt == "docx":
        return Response(export.render_docx(p.pages[0], p.comment_style), media_type=_TYPES["docx"], headers=headers)
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
    format: str = Query("md", pattern="^(md|html|zip|docx)$"),
    subpages: bool = Query(False),
    comments: str | None = Query(None, pattern="^(none|footnotes|margin)$",
                                 description="Include the comment threads: footnotes or margin (Word), "
                                             "an appendix in Markdown. Only for people who can see them."),
    comment_status: str = Query("all", pattern="^(open|all)$"),
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
    return await respond(db, raw, actor, person, ctx, format, subpages,
                         comments=None if comments in (None, "none") else comments, comment_status=comment_status)


def _wants_page(request: Request) -> bool:
    """A browser opening the link (a click in an AI app), not a script or curl."""
    accept = request.headers.get("accept") or ""
    return "text/html" in accept and request.headers.get("sec-fetch-dest", "document") in ("document", "")


_REFUSAL_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Export link · Markdrop</title><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f9;color:#1d1f23;
font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:440px;margin:24px;padding:28px 28px 24px;border:1px solid #e3e6ea;border-radius:12px;background:#fff}
h1{margin:0 0 8px;font-size:20px;line-height:1.3}p{margin:0 0 12px;color:#5f6670}a{color:#2563eb}
@media (prefers-color-scheme:dark){body{background:#111317;color:#e8eaed}main{background:#1a1d22;border-color:#2c3038}
p{color:#a0a7b1}a{color:#7aa2ff}}
</style></head><body><main><h1>%(title)s</h1><p>%(message)s</p>
<p>Ask your AI app to export the page again for a fresh link, or open the page on Markdrop and use
<strong>Export…</strong> in its ⋯ menu.</p></main></body></html>
"""


def _refusal_page(status: int, message: str) -> HTMLResponse:
    """The same refusal as a short page: a link opened in a browser never shows raw JSON."""
    title = "This download link has expired" if status == 404 else "This page can't be exported"
    body = _REFUSAL_PAGE % {"title": export.esc(title), "message": export.esc(message)}
    return HTMLResponse(body, status_code=status, headers={
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"})


@router.get("/{slug}/export/download")
@limiter.limit("30/minute")
async def export_download(request: Request, slug: str, token: str = Query(..., max_length=2000),
                          db: AsyncIOMotorDatabase = Depends(get_db)):
    """An export link from ``export_page`` (MCP), for the user it was made for. A browser that
    opens a link which no longer works gets a short page saying so (an API client, the JSON)."""
    try:
        return await _export_download(slug, token, db)
    except HTTPException as e:
        if not _wants_page(request):
            raise
        detail = e.detail if isinstance(e.detail, str) else "This export link doesn't work any more."
        return _refusal_page(e.status_code, detail)


async def _export_download(slug: str, token: str, db: AsyncIOMotorDatabase):
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
    return await respond(db, raw, actor, actor, ctx, data["f"], bool(data.get("sp")), comments=data.get("c"),
                         comment_status=data.get("cs") or "all")
