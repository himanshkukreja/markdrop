"""Google Docs export/sync via the Drive API.

We rely on Drive's native Markdown importer: uploading ``text/markdown`` with a
target mimeType of ``application/vnd.google-apps.document`` converts it to a
fully-formatted Google Doc (headings, bold/italic, lists, tables, links, code
blocks, blockquotes). The same media upload on an *update* re-runs the converter
and replaces the whole document — so one code path creates and refreshes.

Only ``httpx`` is used (no google-api-python-client) to match the codebase's
lightweight style. Access tokens are minted on demand from the stored refresh
token; we never persist short-lived access tokens.
"""

import json

import httpx
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.models.user import User
from app.services import oauth
from app.services import user as user_service
from app.utils import crypto

DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files"
DOC_MIME = "application/vnd.google-apps.document"
MD_MIME = "text/markdown"

# Fields we ask Drive to echo back after a create/update.
_FIELDS = "id,name,webViewLink"


# Box-drawing / arrow glyphs that signal an ASCII diagram. When several lines of
# a block carry these, the block is a flow chart / sequence diagram whose meaning
# lives entirely in its column alignment.
_DIAGRAM_GLYPHS = frozenset(
    "─│┌┐└┘├┤┬┴┼"          # light box drawing
    "━┃┏┓┗┛┣┫┳┻╋"          # heavy box drawing
    "═║╔╗╚╝╠╣╦╩╬"          # double box drawing
    "╭╮╯╰"                  # rounded corners
    "▶◀▲▼►◄◆●○◦■□▪▫"        # nodes / markers
    "→←↑↓↔↕⟶⟵⇒⇐⇔"          # arrows
)


def _is_fence(line: str) -> bool:
    stripped = line.lstrip()
    return stripped.startswith("```") or stripped.startswith("~~~")


def fence_diagrams(markdown: str) -> str:
    """Wrap unfenced ASCII/box-drawing diagrams in ``` code fences.

    Drive's markdown→Doc converter renders ordinary text in a proportional font,
    which collapses the column alignment that box-drawing diagrams depend on and
    makes them look broken. Fenced code blocks instead import as a monospace
    ("Courier New") block, so the alignment survives the conversion.

    We only touch blank-line-delimited blocks that are already *outside* a fence
    and where at least two lines contain diagram glyphs — this keeps prose that
    merely mentions an arrow, and markdown tables (which use ASCII ``|``, not the
    box-drawing ``│``), untouched.
    """
    lines = markdown.split("\n")
    out: list[str] = []
    i = 0
    n = len(lines)
    in_fence = False
    while i < n:
        line = lines[i]
        if _is_fence(line):
            in_fence = not in_fence
            out.append(line)
            i += 1
            continue
        if in_fence or line.strip() == "":
            out.append(line)
            i += 1
            continue
        # Gather one blank-line-delimited block of non-fenced text.
        block: list[str] = []
        while i < n and lines[i].strip() != "" and not _is_fence(lines[i]):
            block.append(lines[i])
            i += 1
        diagram_lines = sum(1 for b in block if any(ch in _DIAGRAM_GLYPHS for ch in b))
        if diagram_lines >= 2:
            out.append("```text")
            out.extend(block)
            out.append("```")
        else:
            out.extend(block)
    return "\n".join(out)


class GoogleDocsError(RuntimeError):
    """Generic failure talking to Google (surfaced as a 502 upstream)."""


class ReconnectRequired(RuntimeError):
    """The stored refresh token is missing/revoked, or the granted scopes are
    insufficient — either way the user must reconnect (and approve Drive)."""


def _raise_if_insufficient_scope(resp: httpx.Response) -> None:
    """A 403 ``insufficientPermissions`` means the user connected but didn't grant
    the Drive scope. That's fixable only by reconnecting, so surface it as a
    :class:`ReconnectRequired` with an actionable message rather than a raw 502.
    """
    if resp.status_code == 403 and "insufficient" in resp.text.lower():
        raise ReconnectRequired(
            "Markdrop wasn't granted permission to create Google Docs. Please "
            "reconnect and approve the Google Drive permission when prompted."
        )


async def get_access_token(db: AsyncIOMotorDatabase, user: User) -> str:
    """Decrypt the user's refresh token and mint a fresh access token.

    Raises :class:`ReconnectRequired` if not connected or the token is dead.
    """
    if not user.google_refresh_token_enc:
        raise ReconnectRequired("Google Docs is not connected for this account")
    try:
        refresh_token = crypto.decrypt(user.google_refresh_token_enc)
    except Exception as exc:  # corrupt ciphertext / rotated key
        raise ReconnectRequired("Stored Google credentials are invalid") from exc
    try:
        return await oauth.refresh_access_token(refresh_token)
    except httpx.HTTPStatusError as exc:
        # 400/401 from the token endpoint == revoked/expired grant.
        if exc.response.status_code in (400, 401):
            # Clear the dead token so the UI shows "connect" again.
            await user_service.set_google_refresh_token(db, user.id, None)
            raise ReconnectRequired("Google access was revoked — please reconnect") from exc
        raise GoogleDocsError("Failed to refresh Google access token") from exc


def _multipart_body(metadata: dict, markdown: str) -> tuple[bytes, str]:
    """Build a multipart/related body (JSON metadata + markdown media)."""
    boundary = "markdrop-gdocs-boundary"
    parts = (
        f"--{boundary}\r\n"
        "Content-Type: application/json; charset=UTF-8\r\n\r\n"
        f"{json.dumps(metadata)}\r\n"
        f"--{boundary}\r\n"
        f"Content-Type: {MD_MIME}; charset=UTF-8\r\n\r\n"
        f"{markdown}\r\n"
        f"--{boundary}--"
    )
    return parts.encode("utf-8"), f"multipart/related; boundary={boundary}"


async def create_doc(access_token: str, title: str, markdown: str) -> dict:
    """Create a new Google Doc from markdown. Returns {id, name, webViewLink}."""
    metadata = {"name": title or "Untitled", "mimeType": DOC_MIME}
    body, content_type = _multipart_body(metadata, markdown)
    params = {"uploadType": "multipart", "fields": _FIELDS}
    headers = {"Authorization": f"Bearer {access_token}", "Content-Type": content_type}
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(DRIVE_UPLOAD_URL, params=params, headers=headers, content=body)
    _raise_if_insufficient_scope(resp)
    if resp.status_code >= 400:
        raise GoogleDocsError(f"Drive create failed ({resp.status_code}): {resp.text[:300]}")
    return resp.json()


async def update_doc(access_token: str, file_id: str, title: str, markdown: str) -> dict | None:
    """Replace an existing Doc's content from markdown (re-converts).

    Returns {id, name, webViewLink}, or ``None`` if the file no longer exists
    (deleted in Drive) so the caller can fall back to creating a new one.
    """
    # Media-only update replaces content + re-runs the markdown converter.
    params = {"uploadType": "media", "fields": _FIELDS}
    headers = {"Authorization": f"Bearer {access_token}", "Content-Type": MD_MIME}
    url = f"{DRIVE_UPLOAD_URL}/{file_id}"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.patch(
            url, params=params, headers=headers, content=markdown.encode("utf-8")
        )
    if resp.status_code == 404:
        return None
    _raise_if_insufficient_scope(resp)
    if resp.status_code >= 400:
        raise GoogleDocsError(f"Drive update failed ({resp.status_code}): {resp.text[:300]}")
    result = resp.json()
    # A media update doesn't rename; if the title changed, patch metadata too.
    if title and result.get("name") != title:
        await _rename(access_token, file_id, title)
        result["name"] = title
    return result


async def _rename(access_token: str, file_id: str, title: str) -> None:
    """Best-effort metadata rename (non-fatal if it fails)."""
    url = f"https://www.googleapis.com/drive/v3/files/{file_id}"
    headers = {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=15) as client:
        await client.patch(url, headers=headers, content=json.dumps({"name": title}))
