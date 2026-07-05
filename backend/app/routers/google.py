"""Google Docs integration — opt-in export & one-click sync.

This is a SEPARATE OAuth flow from login (incremental authorization): the user
explicitly connects Google Docs, granting the `drive.file` scope + offline
access. We store an encrypted refresh token and use it to create/update Google
Docs from their markdown.

Flow
----
1. GET  /connect          → (auth) returns the Google consent URL to redirect to.
2. GET  /callback         → Google redirects here; we store the refresh token.
3. GET  /status           → (auth) is this account connected?
4. POST /disconnect       → (auth) forget the stored token.
5. POST /documents/{id}/export → (auth) create the Doc (Phase 1) or refresh an
                                  already-linked Doc from current content (Phase 2).
"""

import httpx
import jwt
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import RedirectResponse, Response
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.schemas.google import GoogleConnectResponse, GoogleExportResponse, GoogleStatusResponse
from app.services import diagram_render
from app.services import document as doc_service
from app.services import gdocs
from app.services import math_render
from app.services import mermaid_render
from app.services import oauth
from app.services import user as user_service
from app.utils import crypto

settings = get_settings()
router = APIRouter(prefix="/api/v1/google", tags=["google-docs"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _frontend_redirect(path: str, **params: str) -> RedirectResponse:
    from urllib.parse import urlencode

    url = f"{settings.frontend_url.rstrip('/')}{path}"
    if params:
        # `path` may already carry a query (e.g. a `next` of "/slug?gsync=1"),
        # so join with & in that case rather than a second ?.
        sep = "&" if "?" in path else "?"
        url = f"{url}{sep}{urlencode(params)}"
    return RedirectResponse(url, status_code=307)


def _require_ready() -> None:
    """Both OAuth and token encryption must be configured to connect."""
    if not oauth.is_configured():
        raise HTTPException(status_code=503, detail="Google is not configured on this server")
    if not crypto.is_configured():
        raise HTTPException(status_code=503, detail="Token encryption is not configured on this server")


# ── Diagram image rendering (public — Google's converter fetches this) ───────────


@router.get("/diagram.png")
@limiter.limit("120/minute")
async def diagram_image(request: Request, d: str = Query(..., description="encoded diagram")):
    """Render an ASCII/box-drawing diagram to PNG.

    Public and unauthenticated by design: Google's markdown→Doc converter fetches
    this URL anonymously while importing an exported document. The diagram text is
    carried (compressed) in ``d`` — nothing is read from the database.
    """
    try:
        text = diagram_render.decode_diagram(d)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid diagram token")
    png = await run_in_threadpool(diagram_render.render_diagram_png, text)
    return Response(
        content=png,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.get("/mermaid.png")
@limiter.limit("120/minute")
async def mermaid_image(request: Request, d: str = Query(..., description="encoded mermaid source")):
    """Render a Mermaid diagram to PNG (public — Google's converter fetches it).

    Delegates to Kroki server-side; on any failure we fall back to rendering the
    Mermaid source as a monospace image so the export never silently loses it.
    """
    try:
        source = diagram_render.decode_diagram(d)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid mermaid token")
    try:
        png = await mermaid_render.fetch_mermaid_png(source)
    except Exception:
        png = await run_in_threadpool(diagram_render.render_diagram_png, source)
    return Response(
        content=png,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.get("/math.png")
@limiter.limit("120/minute")
async def math_image(
    request: Request,
    d: str = Query(..., description="encoded LaTeX"),
    display: int = Query(0, description="1 for block/display math, 0 for inline"),
):
    """Render a LaTeX expression to PNG (public — Google's converter fetches it)."""
    try:
        latex = diagram_render.decode_diagram(d)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid math token")
    try:
        png = await run_in_threadpool(math_render.render_math_png, latex, bool(display))
    except Exception:
        # matplotlib's mathtext is a stricter subset than KaTeX (e.g. no
        # \begin{}=environments, needs \frac{}{} braces). Rather than a broken
        # image in the Doc, fall back to the LaTeX source as a monospace image.
        png = await run_in_threadpool(diagram_render.render_diagram_png, latex)
    return Response(
        content=png,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400"},
    )


# ── Connect flow ────────────────────────────────────────────────────────────────


@router.get("/connect", response_model=GoogleConnectResponse)
async def connect(
    next: str | None = Query(None),
    user: User = Depends(require_user),
):
    """Return the Google consent URL. The frontend redirects the browser to it.

    The logged-in user id is signed into the OAuth ``state`` so the callback can
    attribute the returned refresh token without an Authorization header.
    """
    _require_ready()
    state = oauth.make_docs_state(user.id, next)
    return GoogleConnectResponse(auth_url=oauth.build_docs_auth_url(state))


@router.get("/callback")
async def callback(
    code: str | None = Query(None),
    state: str | None = Query(None),
    error: str | None = Query(None),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """Handle Google's redirect: store the encrypted refresh token on the user."""
    if error or not code or not state:
        return _frontend_redirect("/dashboard", gdocs="cancelled")

    try:
        user_id, next_path = oauth.verify_docs_state(state)
    except jwt.InvalidTokenError:
        return _frontend_redirect("/dashboard", gdocs="state_error")

    try:
        tokens = await oauth.exchange_docs_code(code)
    except httpx.HTTPError:
        return _frontend_redirect("/dashboard", gdocs="failed")

    refresh_token = tokens.get("refresh_token")
    if not refresh_token:
        # Should not happen with prompt=consent, but guard anyway.
        return _frontend_redirect("/dashboard", gdocs="no_refresh_token")

    await user_service.set_google_refresh_token(db, user_id, crypto.encrypt(refresh_token))
    dest = next_path if next_path.startswith("/") else "/dashboard"
    return _frontend_redirect(dest, gdocs="connected")


@router.get("/status", response_model=GoogleStatusResponse)
async def status(user: User = Depends(require_user)):
    return GoogleStatusResponse(
        connected=bool(user.google_refresh_token_enc),
        configured=oauth.is_configured() and crypto.is_configured(),
    )


@router.post("/disconnect", response_model=GoogleStatusResponse)
async def disconnect(
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Revoke the grant at Google, then forget the stored token.

    We revoke on Google's side first so the user is fully disconnected (the app
    loses all Drive access), then clear locally regardless of whether the revoke
    call succeeded — a dead/network-failed token must not leave the account stuck
    in a "connected" state.
    """
    if user.google_refresh_token_enc and crypto.is_configured():
        try:
            refresh_token = crypto.decrypt(user.google_refresh_token_enc)
            await oauth.revoke_token(refresh_token)
        except Exception:
            # Already-revoked token, corrupt ciphertext, or a network hiccup —
            # none should block clearing the local link below.
            pass
    await user_service.set_google_refresh_token(db, user.id, None)
    return GoogleStatusResponse(connected=False, configured=oauth.is_configured() and crypto.is_configured())


# ── Export / sync (Phase 1 create + Phase 2 update) ─────────────────────────────


@router.post("/documents/{doc_id}/export", response_model=GoogleExportResponse)
@limiter.limit("30/minute")
async def export_document(
    request: Request,
    doc_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User = Depends(require_user),
):
    """Create the linked Google Doc, or refresh it from the current content.

    First call creates a Doc (Phase 1). Subsequent calls update the same Doc
    in place (Phase 2). Markdown stays the source of truth.
    """
    doc = await doc_service.get_owned_document_by_id(db, doc_id, user.id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    try:
        access_token = await gdocs.get_access_token(db, user)
    except gdocs.ReconnectRequired as exc:
        raise HTTPException(status_code=428, detail={"error": "reconnect_required", "message": str(exc)})

    title = doc.title or doc.slug
    # Convert what Drive's converter can't render into embedded images: box
    # diagrams + Mermaid → images, and $$…$$ / $…$ math → images. (Falls back to
    # source text/code fences when no public image URL is available.)
    markdown = gdocs.transform_for_gdocs(doc.content, settings.api_base_url)

    try:
        result = None
        if doc.google_doc_id:
            # Phase 2: update the existing Doc. None ⇒ it was deleted in Drive.
            result = await gdocs.update_doc(access_token, doc.google_doc_id, title, markdown)
        if result is None:
            # Phase 1 (or recreate after deletion).
            result = await gdocs.create_doc(access_token, title, markdown)
    except gdocs.ReconnectRequired as exc:
        # e.g. the user connected without granting the Drive scope.
        raise HTTPException(status_code=428, detail={"error": "reconnect_required", "message": str(exc)})
    except gdocs.GoogleDocsError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    updated = await doc_service.set_google_doc_link(
        db,
        doc_id,
        user.id,
        google_doc_id=result["id"],
        google_doc_url=result.get("webViewLink"),
        synced_rev=doc.rev,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Document not found")

    return GoogleExportResponse(
        google_doc_id=updated.google_doc_id,
        google_doc_url=updated.google_doc_url,
        synced_rev=updated.google_doc_synced_rev,
        rev=updated.rev,
    )
