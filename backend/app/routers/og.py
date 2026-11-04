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

import hashlib
import logging
import re
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.services import access as access_service
from app.services import artifact, og_render
from app.services import branding as branding_service
from app.services import folder_preview
from app.services import domain as domain_service
from app.services import workspace as ws_service

router = APIRouter(prefix="/api/v1/og", tags=["og-image"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


# ── Share signals (creator analytics §2) ──────────────────────────────────────
# A link-preview fetch of the card means someone pasted the link somewhere.
# Recorded as an ``events`` row of type "preview" (never a view), at most one
# per document and platform every 10 minutes. Order matters: iMessage sends
# "facebookexternalhit … Twitterbot", which is left as the first match.
_PREVIEW_BOTS = (
    ("Slack", re.compile(r"Slackbot|Slack-ImgProxy", re.I)),
    ("LinkedIn", re.compile(r"LinkedInBot", re.I)),
    ("WhatsApp", re.compile(r"WhatsApp", re.I)),
    ("Facebook", re.compile(r"facebookexternalhit|Facebot", re.I)),
    # Telegram's fetcher says "TelegramBot (like TwitterBot)".
    ("Telegram", re.compile(r"TelegramBot", re.I)),
    ("X", re.compile(r"Twitterbot", re.I)),
    ("Discord", re.compile(r"Discordbot", re.I)),
    ("Teams", re.compile(r"SkypeUriPreview|MicrosoftPreview|Teams", re.I)),
    ("Google Chat", re.compile(r"Google-PageRenderer|GoogleChat|Google Chat", re.I)),
    ("Other", re.compile(r"redditbot|Embedly|Iframely|Pinterest|Mastodon|Cardyb|vkShare|Viber|"
                         r"SnapchatPreview|Snap URL Preview|Bluesky|Skype|Zoom", re.I)),
)
PREVIEW_DEDUPE = timedelta(minutes=10)


def preview_platform(user_agent: str | None) -> str | None:
    """The messaging / social platform a link-preview fetch came from, if any."""
    if not user_agent:
        return None
    for name, rx in _PREVIEW_BOTS:
        if rx.search(user_agent):
            return name
    return None


async def record_preview(db: AsyncIOMotorDatabase, raw: dict, user_agent: str | None) -> bool:
    """Insert a share signal for this fetch unless one was recorded for the
    same document and platform in the last 10 minutes. Best effort."""
    platform = preview_platform(user_agent)
    if platform is None or raw.get("_id") is None:
        return False
    try:
        doc_id = str(raw["_id"])
        now = datetime.now(timezone.utc)
        recent = await db["events"].find_one(
            {"doc_id": doc_id, "type": "preview", "platform": platform, "ts": {"$gte": now - PREVIEW_DEDUPE}},
            {"_id": 1})
        if recent is not None:
            return False
        await db["events"].insert_one({
            "doc_id": doc_id, "owner_id": raw.get("owner_id"), "type": "preview",
            "ts": now, "platform": platform})
        return True
    except Exception:  # pragma: no cover - a card is never refused over this
        logging.getLogger(__name__).warning("share signal not recorded", exc_info=True)
        return False


def _png(data: bytes, *, max_age: int) -> Response:
    return Response(
        content=data,
        media_type="image/png",
        headers={
            "Cache-Control": f"public, max-age={max_age}",
            # Browsers and link-preview bots may cache it; a CDN in front of the
            # API must not, or preview fetches after the first would never reach
            # here and share signals (record_preview) would go uncounted.
            "CDN-Cache-Control": "no-store",
            "Cloudflare-CDN-Cache-Control": "no-store",
        },
    )


# Rendered cards, keyed by everything drawn on them, so the origin stays cheap
# now that every preview fetch reaches it. Bounded, 10 minutes.
_RENDER_TTL_S = 600
_RENDER_MAX = 128
_rendered: "OrderedDict[str, tuple[float, bytes]]" = OrderedDict()


def _card_key(card: og_render.Card) -> str:
    fields = {k: v for k, v in vars(card).items() if k != "poster"}
    b = card.brand
    fields["brand"] = repr(b and {**vars(b), "logo": hashlib.sha256(b.logo).hexdigest() if b.logo else None})
    poster = hashlib.sha256(card.poster).hexdigest() if card.poster else None
    # The renderer's identity too: a different renderer (tests swap it) never
    # serves the old one's bytes.
    renderer = id(og_render.render_og_png)
    return hashlib.sha256(repr((sorted(fields.items()), poster, renderer)).encode()).hexdigest()


async def _render(card: og_render.Card) -> bytes:
    key = _card_key(card)
    hit = _rendered.get(key)
    now = time.monotonic()
    if hit is not None and now - hit[0] <= _RENDER_TTL_S:
        _rendered.move_to_end(key)
        return hit[1]
    png = await run_in_threadpool(og_render.render_og_png, card)
    _rendered[key] = (now, png)
    _rendered.move_to_end(key)
    while len(_rendered) > _RENDER_MAX:
        _rendered.popitem(last=False)
    return png


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
        png = await _render(og_render.Card(kind="generic"))
        return _png(png, max_age=300)

    await record_preview(db, raw, request.headers.get("user-agent"))

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
        png = await _render(card)
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
        from app.services.page_props import split as split_front_matter
        from app.services.pages import redact_people, strip_ref_labels

        # A preview card is for anyone: person mentions never name anyone in it,
        # and a page's front matter (icon, cover…) isn't text.
        content = strip_ref_labels(redact_people(split_front_matter(raw.get("content") or "")[1])) or ""
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

    png = await _render(card)
    # 1h cache: title/snippet edits and access changes propagate within the
    # hour without hammering the renderer on every crawler hit.
    return _png(png, max_age=300)


# ── Workspaces and folders (markdrop.in/w/<ws>[/f/<folder>], markdrop.in/f/<share>) ──
# Crawlers are never signed in, so these say only what a signed-out visitor
# could already learn (services/folder_preview.py). The page's metadata reads
# the JSON; the card is the PNG. Both answer from the same decision.

_ID = re.compile(r"^[0-9a-f]{24}$")
_SHARE = re.compile(r"^[A-Za-z0-9_-]{6,32}$")


def _items_label(n: int) -> str:
    return f"{n} item" if n == 1 else f"{n} items"


async def _logo_bytes(ws) -> bytes | None:
    """The workspace's uploaded logo, read from our own bucket — only a key
    services/branding.py wrote for this very workspace. Never a URL fetch."""
    url = ws.branding.logo_url or ""
    prefix = branding_service.public_url("")
    if not url.startswith(prefix):
        return None
    key = url[len(prefix):]
    if not re.fullmatch(rf"branding/{re.escape(ws.id)}/logo-[0-9a-f]{{16}}\.png", key):
        return None
    from app.services import r2

    if not r2.is_configured():
        return None
    return await run_in_threadpool(r2.get_bytes, key, branding_service.MAX_UPLOAD_BYTES)


async def _space_card(p: folder_preview.Preview | None, kind: str) -> og_render.Card:
    if p is None or not p.visible:
        return og_render.Card(kind=f"{kind}_private")
    ws = p.workspace
    b = ws.branding
    brand = og_render.CardBrand(
        site_name=p.workspace_name,
        accent=og_render.parse_hex_color(b.accent_color),
        footer=domain_service.clean_host(p.host) if p.host else None,
        hide_markdrop_branding=b.hide_markdrop_branding,
        logo=await _logo_bytes(ws),
        logo_well=b.logo_well,
    )
    if kind == "workspace":
        # The header already names the workspace; the title says it once more, big.
        brand.site_name = None
        return og_render.Card(kind="workspace", title=p.workspace_name or "",
                              snippet="Documents and files", meta=_items_label(p.items), brand=brand)
    return og_render.Card(kind="folder", title=p.folder_name or "",
                          snippet=f"A folder in {p.workspace_name}", meta=_items_label(p.items), brand=brand)


def _meta(p: folder_preview.Preview | None, kind: str) -> JSONResponse:
    """What the page's <title>/og tags may say. 404 when it doesn't exist."""
    if p is None:
        return JSONResponse({"detail": "Not found"}, status_code=404,
                            headers={"Cache-Control": "public, max-age=60"})
    body: dict = {"visible": p.visible}
    if p.visible:
        body.update(workspace=p.workspace_name, items=p.items, host=p.host)
        if kind == "folder":
            body["folder"] = p.folder_name
    return JSONResponse(body, headers={"Cache-Control": "public, max-age=60"})


async def _space_png(p: folder_preview.Preview | None, kind: str) -> Response:
    png = await _render(await _space_card(p, kind))
    return _png(png, max_age=300)


@router.get("/w/{workspace_id}.json", include_in_schema=False)
@limiter.limit("120/minute")
async def workspace_meta(request: Request, workspace_id: str, db: AsyncIOMotorDatabase = Depends(get_db)):
    if not _ID.match(workspace_id):
        raise HTTPException(status_code=404, detail="Not found")
    return _meta(await folder_preview.for_workspace(db, workspace_id), "workspace")


@router.api_route("/w/{workspace_id}.png", methods=["GET", "HEAD"])
@limiter.limit("120/minute")
async def workspace_image(request: Request, workspace_id: str, db: AsyncIOMotorDatabase = Depends(get_db)):
    p = await folder_preview.for_workspace(db, workspace_id) if _ID.match(workspace_id) else None
    return await _space_png(p, "workspace")


@router.get("/w/{workspace_id}/f/{folder_id}.json", include_in_schema=False)
@limiter.limit("120/minute")
async def folder_meta(request: Request, workspace_id: str, folder_id: str,
                      db: AsyncIOMotorDatabase = Depends(get_db)):
    if not (_ID.match(workspace_id) and _ID.match(folder_id)):
        raise HTTPException(status_code=404, detail="Not found")
    return _meta(await folder_preview.for_folder(db, workspace_id, folder_id), "folder")


@router.api_route("/w/{workspace_id}/f/{folder_id}.png", methods=["GET", "HEAD"])
@limiter.limit("120/minute")
async def folder_image(request: Request, workspace_id: str, folder_id: str,
                       db: AsyncIOMotorDatabase = Depends(get_db)):
    ok = _ID.match(workspace_id) and _ID.match(folder_id)
    p = await folder_preview.for_folder(db, workspace_id, folder_id) if ok else None
    return await _space_png(p, "folder")


@router.api_route("/f/{share_id}.png", methods=["GET", "HEAD"])
@limiter.limit("120/minute")
async def shared_folder_image(request: Request, share_id: str,
                              path: str = Query("", max_length=1000),
                              db: AsyncIOMotorDatabase = Depends(get_db)):
    p = await folder_preview.for_share(db, share_id, path) if _SHARE.match(share_id) else None
    return await _space_png(p, "folder")
