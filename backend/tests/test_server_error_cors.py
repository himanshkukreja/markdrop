"""An unhandled error answers a JSON 500 the browser can read (middleware/errors.py).

Before: Starlette wrote its plain 500 outside the CORS middlewares, so the response had no
Access-Control-Allow-Origin and the studio showed "Couldn't reach Markdrop. Check your
connection" for a bug on our side. Now the 500 carries the same CORS headers as any answer.
"""

from __future__ import annotations

from tests import _email_env as env  # noqa: F401  (pins settings first)

import unittest
from datetime import datetime, timezone
from unittest import mock

import httpx
from bson import ObjectId
from fastapi import HTTPException
from starlette.applications import Starlette
from starlette.responses import StreamingResponse
from starlette.routing import Route

from app import database
from app.config import get_settings
from app.limiter import limiter
from app.main import app
from app.middleware.errors import DETAIL, ServerErrorJSONMiddleware
from app.models.user import User
from app.routers.auth import require_user
from app.services import docs_site_pages, docs_site_store

settings = get_settings()
API = "https://api.markdrop.in"
APP_ORIGIN = "https://markdrop.in"


class ServerErrorCORSTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._origins = list(settings.cors_origins)
        # The routes only need a client to exist (the reads they make are patched below).
        from mongomock_motor import AsyncMongoMockClient

        self._client = database._client
        database._client = AsyncMongoMockClient()
        if APP_ORIGIN not in settings.cors_origins:
            settings.cors_origins.append(APP_ORIGIN)
        t = datetime.now(timezone.utc)
        self.user = User(id=str(ObjectId()), email="ada@example.com", created_at=t, updated_at=t, name="Ada")
        app.dependency_overrides[require_user] = lambda: self.user
        limiter.reset()
        self.site_id, self.page_id = str(ObjectId()), str(ObjectId())
        site = {"_id": ObjectId(self.site_id), "name": "Example guide"}
        page = {"_id": ObjectId(self.page_id), "site_id": site["_id"], "path": "/intro", "title": "Intro"}
        self.patches = [
            mock.patch.object(docs_site_store, "load_site", mock.AsyncMock(return_value=(site, "admin"))),
            mock.patch.object(docs_site_pages, "load_page", mock.AsyncMock(return_value=page)),
        ]
        for p in self.patches:
            p.start()

    async def asyncTearDown(self):
        for p in self.patches:
            p.stop()
        app.dependency_overrides.pop(require_user, None)
        settings.cors_origins[:] = self._origins
        database._client = self._client

    def http(self):
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=API)

    async def test_an_error_in_a_page_view_is_a_readable_500(self):
        boom = mock.AsyncMock(side_effect=RuntimeError("a value the view couldn't handle"))
        with mock.patch.object(docs_site_pages, "view", boom), self.assertLogs("app.errors", "ERROR") as logs:
            async with self.http() as c:
                r = await c.get(f"/api/v1/docs-sites/{self.site_id}/pages/{self.page_id}", headers={"Origin": APP_ORIGIN})
        self.assertEqual(r.status_code, 500)
        self.assertEqual(r.json(), {"detail": DETAIL})
        self.assertEqual(r.headers.get("access-control-allow-origin"), APP_ORIGIN)
        self.assertEqual(r.headers.get("access-control-allow-credentials"), "true")
        self.assertTrue(any("RuntimeError" in line and "/pages/" in line for line in logs.output), logs.output)

    async def test_a_page_view_answers_as_before(self):
        async def view(_db, _site, page):
            return {"id": str(page["_id"]), "title": page["title"]}

        with mock.patch.object(docs_site_pages, "view", view):
            async with self.http() as c:
                r = await c.get(f"/api/v1/docs-sites/{self.site_id}/pages/{self.page_id}", headers={"Origin": APP_ORIGIN})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"id": self.page_id, "title": "Intro"})
        self.assertEqual(r.headers.get("access-control-allow-origin"), APP_ORIGIN)

    async def test_http_errors_keep_their_own_status(self):
        with mock.patch.object(docs_site_pages, "load_page", mock.AsyncMock(side_effect=HTTPException(404, "Page not found"))):
            async with self.http() as c:
                r = await c.get(f"/api/v1/docs-sites/{self.site_id}/pages/{self.page_id}", headers={"Origin": APP_ORIGIN})
        self.assertEqual(r.status_code, 404)
        self.assertEqual(r.json(), {"detail": "Page not found"})
        self.assertEqual(r.headers.get("access-control-allow-origin"), APP_ORIGIN)


class AlreadyStartedTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_stream_that_fails_half_way_is_not_replaced(self):
        async def chunks():
            yield b"first part"
            raise RuntimeError("the stream broke")

        async def stream(_request):
            return StreamingResponse(chunks())

        inner = Starlette(routes=[Route("/s", stream)])
        transport = httpx.ASGITransport(app=ServerErrorJSONMiddleware(inner))
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            # Re-raised as it was (Starlette's streaming wraps it in an exception group).
            with self.assertRaises(Exception) as caught:
                await c.get("/s")
        self.assertIn("the stream broke", repr(caught.exception) + repr(getattr(caught.exception, "exceptions", "")))


if __name__ == "__main__":
    unittest.main()
