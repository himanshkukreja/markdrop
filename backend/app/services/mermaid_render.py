"""Render Mermaid diagrams to PNG via Kroki (external), server-side.

There is no pure-Python Mermaid renderer, so we delegate to Kroki
(https://kroki.io) — but we proxy the call through our own endpoint rather than
putting a ``kroki.io`` URL in the exported Doc. That way Google's importer only
ever fetches ``api.markdrop.in`` (Kroki 403s bare, UA-less requests, and we
don't want Google's fetcher to be one), we control caching, and swapping Kroki
for a self-hosted instance later is a one-line change.
"""

import base64
import zlib

import httpx

_KROKI_MERMAID_PNG = "https://kroki.io/mermaid/png/"
# Kroki 403s requests without a User-Agent.
_HEADERS = {"User-Agent": "MarkdropBot/1.0 (+https://markdrop.in)"}
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _kroki_path(source: str) -> str:
    """Kroki GET encoding: url-safe base64 of zlib-compressed source."""
    return base64.urlsafe_b64encode(zlib.compress(source.encode("utf-8"), 9)).decode("ascii")


async def fetch_mermaid_png(source: str, *, timeout: float = 20.0) -> bytes:
    """Return a rendered Mermaid PNG from Kroki. Raises on any failure."""
    url = _KROKI_MERMAID_PNG + _kroki_path(source)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        resp = await client.get(url, headers=_HEADERS)
        resp.raise_for_status()
        data = resp.content
    if data[:8] != _PNG_MAGIC:
        raise ValueError("Kroki did not return a PNG")
    return data
