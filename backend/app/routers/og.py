"""Dynamic Open Graph / link-preview images (public, no auth).

``GET /api/v1/og/{slug}.png`` renders a 1200×630 preview card for a document so
that pasting a ``markdrop.in/<slug>`` link into Slack, Twitter/X, LinkedIn, etc.
shows a rich card. Social crawlers fetch this anonymously, so the endpoint is
public — but it reads only non-sensitive fields (title, a snippet, view count)
and renders a generic, content-free card for password-protected documents.
"""

from fastapi import APIRouter, Depends, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.services import artifact, og_render
from app.services import domain as domain_service
from app.services import workspace as ws_service

router = APIRouter(prefix="/api/v1/og", tags=["og-image"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _png(data: bytes, *, max_age: int) -> Response:
    return Response(
        content=data,
        media_type="image/png",
        headers={"Cache-Control": f"public, max-age={max_age}"},
    )


async def _card_host(db: AsyncIOMotorDatabase, workspace_id: str, host: str | None) -> str | None:
    """Which address to print on the card.

    A workspace can have several domains, and a card unfurled from one of them
    should name that one — being linked content.senseloaf.ai and shown a card
    reading cdn.senseloaf.ai reads as the wrong company's link.

    The host is validated against the workspace's verified domains before it is
    drawn. It arrives as a query parameter on a public, unauthenticated image
    endpoint, so untrusted text rendered straight onto an image we serve would
    let anyone put any brand they liked on somebody else's preview card.
    """
    if host and await domain_service.host_belongs_to(db, workspace_id, host):
        return host.strip().lower()
    return await domain_service.primary_host(db, workspace_id)


@router.get("/{slug}.png")
@limiter.limit("120/minute")
async def og_image(
    request: Request, slug: str,
    # The domain the card was unfurled from. Validated in `_card_host`.
    host: str | None = Query(None, max_length=253),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    # Read-only, only the fields we render — never the password hash content.
    raw = await db["documents"].find_one(
        {"slug": slug},
        {
            "title": 1, "content": 1, "views": 1, "read_password_hash": 1,
            "kind": 1, "mime": 1, "size_bytes": 1, "original_filename": 1,
            "encrypted": 1, "workspace_id": 1,
        },
    )

    if not raw:
        # Unknown/expired slug: a generic branded card (200) keeps the preview
        # from breaking and leaks nothing.
        png = await run_in_threadpool(
            og_render.render_og_png,
            title="Markdrop",
            snippet="Publish markdown, share files, sync from VS Code.",
            views=0,
            protected=False,
        )
        return _png(png, max_age=300)

    # An encrypted document's title and body are both ciphertext, so it gets the
    # same content-free card as a password-protected one. Rendering `content`
    # here would put base64 on a social card — and leak nothing useful anyway.
    protected = bool(raw.get("read_password_hash")) or bool(raw.get("encrypted"))
    is_artifact = raw.get("kind") == "artifact"
    title = (raw.get("title") or raw.get("original_filename") or slug) if not protected else ""

    if is_artifact:
        # `content` is only a filename stand-in for artifacts, so a text snippet
        # would be noise. The type pill and size carry the information instead.
        snippet = ""
        kind = artifact.renderer_for(raw.get("mime") or "")
        label = artifact.label_for(raw.get("mime") or "")
        size = int(raw.get("size_bytes") or 0)
    else:
        snippet = "" if protected else og_render.make_snippet(raw.get("content") or "")
        kind = label = None
        size = None

    # A document that belongs to a workspace wears that workspace's brand
    # wherever the card is unfurled — the point of white-labelling is that the
    # card in Slack doesn't say Markdrop, regardless of which host was linked.
    brand = None
    workspace_id = raw.get("workspace_id")
    if workspace_id:
        workspace = await ws_service.get_workspace(db, workspace_id)
        if workspace is not None:
            b = workspace.branding
            brand = og_render.CardBrand(
                site_name=b.site_name,
                accent=og_render.parse_hex_color(b.accent_color),
                footer=await _card_host(db, workspace_id, host),
                hide_markdrop_branding=b.hide_markdrop_branding,
            )

    png = await run_in_threadpool(
        og_render.render_og_png,
        title=title,
        snippet=snippet,
        views=int(raw.get("views", 0) or 0),
        protected=protected,
        artifact_kind=kind,
        artifact_label=label,
        artifact_size=size,
        artifact_filename=raw.get("original_filename") if is_artifact else None,
        brand=brand,
    )
    # 1h cache: title/snippet edits and view counts propagate within the hour
    # without hammering the renderer on every crawler hit.
    return _png(png, max_age=3600)
