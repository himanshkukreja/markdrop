"""Security headers on every API response (Zoom security review, 2026-11-11).

- ``Strict-Transport-Security``: the API is HTTPS-only (nginx redirects port 80); browsers then
  refuse a downgraded connection for two years. Ignored by browsers on plain-HTTP responses, so
  local development is unaffected.
- ``X-Content-Type-Options: nosniff``: a response is only ever treated as the type it declares
  (stops a JSON or text body being run as a script or stylesheet).

Pure ASGI, so streamed responses (Ask's event stream, file proxies) aren't buffered. A header a
route already set is left alone.
"""

from __future__ import annotations

from starlette.types import ASGIApp, Message, Receive, Scope, Send

HEADERS: tuple[tuple[bytes, bytes], ...] = (
    (b"strict-transport-security", b"max-age=63072000"),
    (b"x-content-type-options", b"nosniff"),
)


class SecurityHeadersMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers") or [])
                have = {k.lower() for k, _ in headers}
                headers.extend((k, v) for k, v in HEADERS if k not in have)
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_with_headers)
