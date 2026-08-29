"""Dynamic Open Graph / link-preview images (public, no auth).

``GET /api/v1/og/{slug}.png`` renders a 1200×630 preview card for a document so
that pasting a ``markdrop.in/<slug>`` link into Slack, Twitter/X, LinkedIn, etc.
shows a rich card. Social crawlers fetch this anonymously, so the endpoint is
public — but it reads only non-sensitive fields (title, a snippet, view count)
and renders a generic, content-free card for password-protected documents.
"""

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.services import artifact, og_render

router = APIRouter(prefix="/api/v1/og", tags=["og-image"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _png(data: bytes, *, max_age: int) -> Response:
    return Response(
        content=data,
        media_type="image/png",
        headers={"Cache-Control": f"public, max-age={max_age}"},
    )


@router.get("/{slug}.png")
@limiter.limit("120/minute")
async def og_image(request: Request, slug: str, db: AsyncIOMotorDatabase = Depends(get_db)):
    # Read-only, only the fields we render — never the password hash content.
    raw = await db["documents"].find_one(
        {"slug": slug},
        {
            "title": 1, "content": 1, "views": 1, "read_password_hash": 1,
            "kind": 1, "mime": 1, "size_bytes": 1, "original_filename": 1,
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

    protected = bool(raw.get("read_password_hash"))
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

    png = await run_in_threadpool(
        og_render.render_og_png,
        title=title,
        snippet=snippet,
        views=int(raw.get("views", 0) or 0),
        protected=protected,
        artifact_kind=kind,
        artifact_label=label,
        artifact_size=size,
    )
    # 1h cache: title/snippet edits and view counts propagate within the hour
    # without hammering the renderer on every crawler hit.
    return _png(png, max_age=3600)
