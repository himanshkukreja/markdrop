"""Meetings × Google: pick the Meet transcript / Gemini notes Docs and read them.

Reuses the Google Docs integration (services/gdocs.py, routers/google.py): the same opt-in
connection (incremental authorization, scope ``drive.file`` only), the same encrypted refresh
token. ``drive.file`` reaches a file only once the person picks it in the **Google Picker**, so the
browser asks :func:`picker_credentials` for a short-lived access token (theirs, minted from their
own refresh token) to open the Picker with, and sends back the picked file ids; the server then
reads each Doc through the Docs API (``includeTabsContent`` — Gemini notes keep the transcript in
a second tab), falling back to Drive's plain-text export.
"""

from __future__ import annotations

import logging

import httpx
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.services import gdocs, oauth
from app.services import meeting_parse as mp
from app.utils import crypto
from app.utils.http import shared_ssl

log = logging.getLogger("markdrop.meeting_google")

DOCS_API = "https://docs.googleapis.com/v1/documents"
DRIVE_API = "https://www.googleapis.com/drive/v3/files"
GDOC_MIME = "application/vnd.google-apps.document"
MAX_EXPORT_BYTES = 10_000_000


class PickError(RuntimeError):
    """A picked file that can't be read; the message says what to do."""


def picker_configured() -> bool:
    s = get_settings()
    return bool(oauth.is_configured() and crypto.is_configured() and s.google_picker_api_key and s.google_cloud_app_id)


def state(user) -> dict:
    """What the Import dialog's Google tab needs to know."""
    return {"configured": picker_configured(), "connected": bool(getattr(user, "google_refresh_token_enc", None))}


async def picker_credentials(db: AsyncIOMotorDatabase, user) -> dict:
    """A fresh access token (drive.file) and the Picker's keys. Raises gdocs.ReconnectRequired."""
    s = get_settings()
    token = await gdocs.get_access_token(db, user)
    return {"access_token": token, "api_key": s.google_picker_api_key, "app_id": s.google_cloud_app_id,
            "client_id": s.google_client_id, "scope": "https://www.googleapis.com/auth/drive.file"}


def doc_url(file_id: str) -> str:
    return f"https://docs.google.com/document/d/{file_id}/edit"


async def owner(access_token: str, file_id: str) -> dict | None:
    """The picked file's owner in Drive ({name, email}): who organized the call. None when Google
    doesn't say (a shared drive, an error)."""
    try:
        async with httpx.AsyncClient(verify=shared_ssl(), timeout=15) as client:
            r = await client.get(f"{DRIVE_API}/{file_id}", params={"fields": "owners(displayName,emailAddress)",
                                                                    "supportsAllDrives": "true"},
                                 headers={"Authorization": f"Bearer {access_token}"})
        if r.status_code != 200:
            return None
        o = (r.json().get("owners") or [None])[0] or {}
        name, email = o.get("displayName"), (o.get("emailAddress") or "").lower() or None
        return {"name": name, "email": email} if (name or email) else None
    except (httpx.HTTPError, ValueError):
        return None


async def fetch(access_token: str, file_id: str) -> tuple[str, str, str]:
    """(title, text, link) of a picked Google Doc. Raises :class:`PickError`."""
    if not file_id or not all(c.isalnum() or c in "-_" for c in file_id) or len(file_id) > 200:
        raise PickError("That isn't a Google Doc id.")
    headers = {"Authorization": f"Bearer {access_token}"}
    async with httpx.AsyncClient(verify=shared_ssl(), timeout=30) as client:
        r = await client.get(f"{DOCS_API}/{file_id}", params={"includeTabsContent": "true"}, headers=headers)
        if r.status_code == 200:
            doc = r.json()
            return (doc.get("title") or "Google Doc"), mp.gdoc_text(doc), doc_url(file_id)
        if r.status_code in (401,):
            raise gdocs.ReconnectRequired("Google access expired — reconnect Google Docs")
        if r.status_code not in (403, 404, 400):
            raise PickError(f"Google couldn't open that Doc ({r.status_code}). Try again.")
        # Not a Docs-API document (or the API is off): Drive's plain-text export.
        meta = await client.get(f"{DRIVE_API}/{file_id}", params={"fields": "name,mimeType"}, headers=headers)
        if meta.status_code == 404:
            raise PickError("Markdrop can't see that file. Pick it again in the Google picker.")
        if meta.status_code == 403:
            gdocs._raise_if_insufficient_scope(meta)
            raise PickError("Markdrop can't open that file. Pick it again in the Google picker.")
        if meta.status_code != 200:
            raise PickError(f"Google couldn't open that file ({meta.status_code}).")
        info = meta.json()
        if info.get("mimeType") != GDOC_MIME:
            raise PickError(f"{info.get('name') or 'That file'} isn't a Google Doc. Download it and upload it instead.")
        ex = await client.get(f"{DRIVE_API}/{file_id}/export", params={"mimeType": "text/plain"}, headers=headers)
        if ex.status_code != 200:
            raise PickError(f"Google couldn't export {info.get('name') or 'that Doc'} ({ex.status_code}).")
        if len(ex.content) > MAX_EXPORT_BYTES:
            raise PickError(f"{info.get('name') or 'That Doc'} is too big to import.")
        return info.get("name") or "Google Doc", ex.content.decode("utf-8", "replace"), doc_url(file_id)
