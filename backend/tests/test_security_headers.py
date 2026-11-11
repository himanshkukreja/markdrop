"""Every API response carries HSTS and nosniff (middleware/security_headers.py), streamed ones too,
and a header a route set itself wins."""

from __future__ import annotations

from tests import _email_env as env  # noqa: F401  (pins settings first)

import unittest

import httpx
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse, StreamingResponse
from starlette.routing import Route

from app.main import app
from app.middleware.security_headers import SecurityHeadersMiddleware


def _plain(request):
    return PlainTextResponse("ok")


def _own(request):
    return PlainTextResponse("ok", headers={"Strict-Transport-Security": "max-age=1"})


def _stream(request):
    async def body():
        yield b"a"
        yield b"b"
    return StreamingResponse(body(), media_type="text/event-stream")


class SecurityHeadersTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        inner = Starlette(routes=[Route("/plain", _plain), Route("/own", _own), Route("/stream", _stream)])
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=SecurityHeadersMiddleware(inner)), base_url="https://api.markdrop.in")

    async def asyncTearDown(self):
        await self.http.aclose()

    async def test_added_to_plain_and_streamed_responses(self):
        for path in ("/plain", "/stream"):
            r = await self.http.get(path)
            self.assertEqual(r.headers["strict-transport-security"], "max-age=63072000", path)
            self.assertEqual(r.headers["x-content-type-options"], "nosniff", path)
        self.assertEqual((await self.http.get("/stream")).text, "ab")

    async def test_route_header_wins_and_no_duplicates(self):
        r = await self.http.get("/own")
        self.assertEqual(r.headers.get_list("strict-transport-security"), ["max-age=1"])

    async def test_installed_on_the_app_outermost(self):
        self.assertIs(app.user_middleware[0].cls, SecurityHeadersMiddleware)
