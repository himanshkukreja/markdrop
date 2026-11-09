"""Read-once-per-request lookups: who the caller is, a workspace's row, someone's role in it.

One page load asks the same few questions many times over within one request — ``require_user``, then
``require_role``, then ``access.can`` per item, then a list's own membership check — and each asked the
database again (a dashboard's 12 calls cost ~110 Mongo operations, a third of them repeats). On the
production cluster every operation counts against its throughput cap, so within one *read* request
(GET/HEAD) the answer to each question is remembered and shared, including by concurrent branches of
an ``asyncio.gather``.

Never across requests, and never for a request that writes (POST/PUT/PATCH/DELETE: it may change a
role or a workspace and then read it back), so nothing here can serve a stale answer to a later request —
except the page editor's own writes (a save, the edit lock and its heartbeat: ``EDITOR_WRITES``), which
come every few seconds while someone types and never change a person, a workspace or a role.
"""

from __future__ import annotations

import asyncio
import re
from contextvars import ContextVar
from typing import Any, Awaitable, Callable

_memo: ContextVar[dict | None] = ContextVar("markdrop_request_memo", default=None)

READ_METHODS = ("GET", "HEAD")
# The editor's autosave (PUT /documents/{slug}), its lock (POST/DELETE …/lock, POST …/lock/keep, the
# close beacon …/lock/release).
EDITOR_WRITES = re.compile(r"^/api/v1/documents/[^/]+(?:/lock(?:/keep|/release)?)?$")


async def remember(key: tuple, factory: Callable[[], Awaitable[Any]]) -> Any:
    """``await factory()`` once per read request for ``key``; outside one, just ``await factory()``."""
    memo = _memo.get()
    if memo is None:
        return await factory()
    fut = memo.get(key)
    if fut is None:
        fut = asyncio.ensure_future(factory())
        memo[key] = fut
    try:
        return await asyncio.shield(fut)
    except BaseException:
        if fut.done() and (fut.cancelled() or fut.exception() is not None):
            memo.pop(key, None)  # a failed lookup is asked again, never remembered
        raise


def prime(key: tuple, value: Any) -> None:
    """Record an answer already in hand (a list that carried it), for the rest of this read request."""
    memo = _memo.get()
    if memo is None or key in memo:
        return
    fut = asyncio.get_running_loop().create_future()
    fut.set_result(value)
    memo[key] = fut


def forget(*key_prefix: Any) -> None:
    """Drop remembered answers whose key starts with ``key_prefix`` (all of them with no prefix)."""
    memo = _memo.get()
    if not memo:
        return
    n = len(key_prefix)
    for k in [k for k in memo if k[:n] == key_prefix]:
        memo.pop(k, None)


def memo_applies(method: str, path: str) -> bool:
    if method in READ_METHODS:
        return True
    if not EDITOR_WRITES.match(path):
        return False
    # The document itself only by its save (PUT); the lock by POST/DELETE.
    return method == "PUT" if path.count("/") == 4 else method in ("POST", "DELETE")


class RequestMemoMiddleware:
    """Pure ASGI: a fresh memo for each read request and the editor's own writes, none otherwise."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        if not memo_applies(scope.get("method") or "", scope.get("path") or ""):
            return await self.app(scope, receive, send)
        token = _memo.set({})
        try:
            await self.app(scope, receive, send)
        finally:
            _memo.reset(token)
