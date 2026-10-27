"""Purge the frontend's cached render of a document after its file changes.

``/[slug]`` is ISR-cached for 60 seconds, so without this a replaced video
keeps its old page (and old poster, size and duration) for up to a minute.
The frontend's ``POST /api/revalidate {slug}`` purges it. Fire and forget: a
3 second timeout, and a failure is only logged, never the request's problem.
"""

from __future__ import annotations

import asyncio
import logging

import httpx

from app.config import get_settings

settings = get_settings()
log = logging.getLogger(__name__)

TIMEOUT_S = 3.0
_TASKS: set[asyncio.Task] = set()


async def _post(slug: str) -> None:
    url = f"{settings.frontend_url.rstrip('/')}/api/revalidate"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            await client.post(url, json={"slug": slug})
    except Exception:
        log.info("page revalidate failed for %s", slug, exc_info=True)


def page(slug: str | None) -> None:
    """Schedule the purge and return at once."""
    if not slug or not settings.page_revalidate_enabled:
        return
    try:
        task = asyncio.get_running_loop().create_task(_post(slug))
    except RuntimeError:
        return
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
