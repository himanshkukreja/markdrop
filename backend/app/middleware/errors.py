"""An unhandled exception answers a JSON 500 that still carries CORS headers.

Starlette turns an exception no handler caught into its plain "Internal Server
Error" in ServerErrorMiddleware, the outermost layer, so that response never
passes back through the CORS middlewares. The browser then refuses to show it
to the page and reports a network error: the studio said "Couldn't reach
Markdrop. Check your connection" for what was really a bug on our side, and the
status (500) was lost.

This layer sits innermost, right outside the routes (main.py adds it before
every CORS middleware), so the 500 it writes goes out through them like any
other response. The traceback is logged as before. When the response has
already started (a stream that failed half-way) there is nothing left to
replace, and the exception goes on to Starlette as it did.
"""

from __future__ import annotations

import logging

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

log = logging.getLogger("app.errors")

DETAIL = "Something went wrong on our side. Try again in a moment."


class ServerErrorJSONMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = False

        async def tracked(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, tracked)
        except Exception:
            if started:
                raise
            log.exception("unhandled error on %s %s", scope.get("method"), scope.get("path"))
            await JSONResponse({"detail": DETAIL}, status_code=500)(scope, receive, send)
