"""Dynamic Open Graph / link-preview images (public, no auth).

``GET /api/v1/og/{slug}.png`` renders a 1200×630 preview card for a document so
that pasting a ``markdrop.in/<slug>`` link into Slack, Twitter/X, LinkedIn, etc.
shows a rich card.

Social crawlers fetch this anonymously, so **the card shows only what an
anonymous reader of the document itself could see.** Anything an anonymous
visitor cannot open — a private or workspace-only document, a document in a
workspace that requires sign-in, a password-protected one, an end-to-end
encrypted one — gets a content-free card: no title, no opening text, nothing
derived from the document beyond the address the link already shows.
"""

from fastapi import APIRouter, Depends, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.services import access as access_service
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
        return domain_service.clean_host(host)
    return await domain_service.primary_host(db, workspace_id)


async def _anonymous_gate(db: AsyncIOMotorDatabase, raw: dict, workspace) -> str | None:
    """Which gate stops an anonymous reader, or None if they can read it.

    The decision is ``access.anonymous_can_read`` — ``can(AN, read)``, the
    exact position a link crawler is in (policy §4.1 #30) — not a second copy
    of the rules. Only the *kind* of content-free card is chosen here:

    - "password" when the one thing missing is the read password (a plain
      link document outside a sign-in-required workspace);
    - "private" for everything else an anonymous reader can't open (private,
      workspace-only, require-sign-in workspace, expired);
    - "encrypted" when it is readable but ciphertext to the server: its title
      and body are meaningless here and the owner chose to keep them off the
      wire.
    """
    if not await access_service.anonymous_can_read(db, raw):
        if (
            raw.get("read_password_hash")
            and (raw.get("access_level") or "link") == "link"
            and not (workspace is not None and workspace.settings.require_auth_to_view)
        ):
            return "password"
        return "private"
    if raw.get("encrypted"):
        return "encrypted"
    return None


_POSTER_MAX_BYTES = 4 * 1024 * 1024


async def _link_level_poster(raw: dict, mime: str) -> bytes | None:
    """A video's poster frame for the card, read straight from the bucket.

    Only for a *link-level* video (no password, access `link`): the card is
    public and cached for an hour, so it may only show what the public `/r/`
    URL would show anyway. Read from R2 directly, never fetched over HTTP: an
    HTTP fetch from here would be a server-side request to a URL derived from
    stored data, and would cost a round trip through the Worker for bytes we
    already hold.
    """
    key = raw.get("poster_key")
    if not key or artifact.renderer_for(mime) != "video":
        return None
    if artifact.is_guarded(
        has_password=bool(raw.get("read_password_hash")),
        access_level=raw.get("access_level"),
    ):
        return None
    from app.services import r2

    if not r2.is_configured():
        return None
    return await run_in_threadpool(r2.get_bytes, key, _POSTER_MAX_BYTES)


def _brand(workspace, footer: str | None) -> og_render.CardBrand:
    b = workspace.branding
    return og_render.CardBrand(
        site_name=b.site_name,
        accent=og_render.parse_hex_color(b.accent_color),
        footer=footer,
        hide_markdrop_branding=b.hide_markdrop_branding,
    )


@router.get("/{slug}.png")
@limiter.limit("120/minute")
async def og_image(
    request: Request, slug: str,
    # The domain the card was unfurled from. Validated before it is drawn.
    host: str | None = Query(None, max_length=253),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    # Read-only, only the fields the gate and the card need — never a hash's
    # content, only whether one exists.
    projection = {
        "title": 1, "content": 1, "read_password_hash": 1, "access_level": 1,
        "kind": 1, "mime": 1, "size_bytes": 1, "original_filename": 1,
        "encrypted": 1, "workspace_id": 1, "poster_key": 1,
        # What access.can(AN, read) looks at besides the above.
        "slug": 1, "owner_id": 1, "expires_at": 1, "access_epoch": 1,
    }
    raw = await db["documents"].find_one({"slug": slug}, projection)
    if raw is None:
        # A former slug (Q4) answers like the document it now belongs to,
        # through the same gate: a gated old link on a white-label host gets
        # that workspace's content-free card, not a Markdrop-branded generic
        # one (B7). The card prints the slug that was asked for.
        raw = await db["documents"].find_one({"old_slugs": slug}, projection)

    if not raw:
        # Unknown/expired slug: the generic branded card (200) keeps the preview
        # from breaking and says nothing about the slug.
        png = await run_in_threadpool(og_render.render_og_png, og_render.Card(kind="generic"))
        return _png(png, max_age=300)

    workspace_id = raw.get("workspace_id")
    workspace = await ws_service.get_workspace(db, workspace_id) if workspace_id else None

    gate = await _anonymous_gate(db, raw, workspace)
    if gate is not None:
        # Content-free card. Even the workspace's branding is withheld unless
        # the card was unfurled from one of that workspace's own verified
        # domains: on markdrop.in/<slug>, the site name of a private document's
        # workspace is itself something an anonymous visitor could not learn.
        brand = None
        if workspace is not None and host and await domain_service.host_belongs_to(
            db, workspace_id, host
        ):
            brand = _brand(workspace, domain_service.clean_host(host))
        card = og_render.Card(kind=gate, slug=slug, brand=brand)
        png = await run_in_threadpool(og_render.render_og_png, card)
        return _png(png, max_age=300)

    # Readable by anyone with the link: the full card.
    # A document that belongs to a workspace wears that workspace's brand
    # wherever the card is unfurled — the point of white-labelling is that the
    # card in Slack doesn't say Markdrop, regardless of which host was linked.
    brand = _brand(workspace, await _card_host(db, workspace_id, host)) if workspace else None

    title = (raw.get("title") or "").strip()
    if raw.get("kind") == "artifact":
        mime = raw.get("mime") or ""
        filename = (raw.get("original_filename") or "").strip()
        title = title or filename or slug
        size = int(raw.get("size_bytes") or 0)
        poster = await _link_level_poster(raw, mime)
        card = og_render.Card(
            poster=poster,
            kind="artifact",
            title=title,
            # `content` is only a filename stand-in for artifacts; the original
            # filename is the useful second line, when it says something new.
            snippet=filename if filename and filename != title else "",
            slug=slug,
            meta=og_render.fmt_size(size) if size else "",
            artifact_renderer=artifact.renderer_for(mime),
            artifact_label=artifact.label_for(mime),
            brand=brand,
        )
    else:
        content = raw.get("content") or ""
        heading = og_render.lead_heading(content)
        # Most documents store no title and name themselves with an opening
        # heading; use it before falling back to the slug, and don't repeat it
        # as the first words of the snippet.
        skip_heading = bool(heading) and (not title or title == heading)
        card = og_render.Card(
            kind="document",
            title=title or heading or slug,
            snippet=og_render.make_snippet(content, skip_heading=skip_heading),
            slug=slug,
            meta=og_render.reading_time(content),
            brand=brand,
        )

    png = await run_in_threadpool(og_render.render_og_png, card)
    # 1h cache: title/snippet edits and access changes propagate within the
    # hour without hammering the renderer on every crawler hit.
    return _png(png, max_age=300)
