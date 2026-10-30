"""Docs CORS for Try it (middleware/docs_cors.py).

The docs origins may call the public API without credentials; admin, sign-in,
email-link and other internal routes stay closed to them; every other origin,
and markdrop.in's own credentialed CORS, behave exactly as before.
"""

from __future__ import annotations

from tests import _email_env as env  # noqa: F401  (pins settings first)

import secrets
import unittest
from datetime import datetime, timezone

import httpx

from app import database
from app.config import get_settings
from app.limiter import limiter
from app.main import app
from app.middleware import docs_cors
from app.middleware.tenant_cors import clear_cache
from app.utils.auth import create_access_token

settings = get_settings()
API = "https://api.markdrop.in"
DOCS = "https://docs.markdrop.in"
LOCAL_DOCS = "http://docs.localhost:3470"
APP_ORIGIN = "https://markdrop.in"

PUBLIC = [
    ("POST", "/api/v1/documents"),
    ("GET", "/api/v1/documents/some-slug"),
    ("PUT", "/api/v1/documents/some-slug"),
    ("DELETE", "/api/v1/documents/some-slug"),
    ("PATCH", "/api/v1/documents/some-slug/settings"),
    ("GET", "/api/v1/me/documents"),
    ("GET", "/api/v1/auth/me"),
    ("POST", "/api/v1/files/uploads"),
    ("GET", "/api/v1/workspaces"),
    ("GET", "/api/v1/me/connections/https://claude.ai/x"),
]
CLOSED = [
    ("GET", "/api/v1/admin/documents"),
    ("POST", "/api/v1/admin/login"),
    ("POST", "/api/v1/auth/email/request"),
    ("POST", "/api/v1/auth/logout"),
    ("GET", "/api/v1/auth/google/login"),
    ("POST", "/api/v1/auth/tenant-token"),
    ("GET", "/api/v1/email/u/sometoken"),
    ("POST", "/api/v1/email/webhooks/resend"),
    ("GET", "/api/v1/google/status"),
    ("POST", "/api/v1/sync"),
    ("GET", "/api/v1/oauth/requests/abc"),
    ("GET", "/api/v1/me/digest/off"),
    ("POST", "/api/v1/beat"),
    ("GET", "/api/v1/host"),
    ("POST", "/api/v1/share/transfer"),
    ("POST", "/api/v1/documents/some-slug/events"),  # tracking: not in the schema
    ("GET", "/api/v1/no-such-route"),
]


def preflight(method: str, origin: str, headers: str = "authorization, content-type") -> dict:
    return {"Origin": origin, "Access-Control-Request-Method": method, "Access-Control-Request-Headers": headers}


class DocsCORSTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.db_name = f"markdrop_test_docscors_{secrets.token_hex(4)}"
        if env.MONGO:
            from motor.motor_asyncio import AsyncIOMotorClient

            self.client = AsyncIOMotorClient(env.MONGO_URI)
        else:
            from mongomock_motor import AsyncMongoMockClient

            self.client = AsyncMongoMockClient()
        self.db = self.client[self.db_name]
        self._saved = (database._client, settings.mongodb_db, list(settings.cors_origins))
        database._client = self.client
        settings.mongodb_db = self.db_name
        if APP_ORIGIN not in settings.cors_origins:
            settings.cors_origins.append(APP_ORIGIN)
        await self.db["documents"].create_index("slug", unique=True)
        limiter.reset()
        clear_cache()

    async def asyncTearDown(self):
        database._client, settings.mongodb_db, origins = self._saved
        settings.cors_origins[:] = origins
        if env.MONGO:
            await self.client.drop_database(self.db_name)
        self.client.close()
        clear_cache()

    def http(self):
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=API)

    # ── which paths ───────────────────────────────────────────────────────────
    def test_path_rules(self):
        for _m, p in PUBLIC:
            self.assertTrue(docs_cors.is_public_api_path(p, app), p)
        for _m, p in CLOSED:
            self.assertFalse(docs_cors.is_public_api_path(p, app), p)
        # The docs endpoints keep their own rules; non-API paths are never touched.
        for p in ("/api/v1/docs/ask", "/mcp", "/oauth/token", "/health", "/openapi.json"):
            self.assertFalse(docs_cors.is_public_api_path(p, app), p)

    def test_every_schema_header_is_allowed(self):
        allowed = {h.strip().lower() for h in docs_cors.API_ALLOW_HEADERS.split(",")}
        for path, ops in app.openapi()["paths"].items():
            if not docs_cors.is_public_api_path(path.replace("{", "x").replace("}", ""), app):
                continue
            for op in ops.values():
                for p in op.get("parameters", []):
                    if p["in"] == "header":
                        self.assertIn(p["name"].lower(), allowed, f"{path} {p['name']}")

    # ── preflight ─────────────────────────────────────────────────────────────
    async def test_preflight_public_paths(self):
        async with self.http() as c:
            for origin in (DOCS, LOCAL_DOCS):
                for method, path in PUBLIC:
                    r = await c.options(path, headers=preflight(method, origin))
                    self.assertEqual(r.status_code, 204, (origin, path))
                    self.assertEqual(r.headers["access-control-allow-origin"], origin)
                    self.assertNotIn("access-control-allow-credentials", r.headers)
                    self.assertIn(method, r.headers["access-control-allow-methods"])
                    allow = [h.strip().lower() for h in r.headers["access-control-allow-headers"].split(",")]
                    self.assertIn("authorization", allow)
                    self.assertIn("content-type", allow)
                    self.assertIn("x-edit-secret", allow)
                    self.assertNotIn("*", r.headers["access-control-allow-headers"])
                    self.assertIn("Origin", r.headers["vary"])

    async def test_preflight_closed_paths_get_nothing(self):
        async with self.http() as c:
            for method, path in CLOSED:
                r = await c.options(path, headers=preflight(method, DOCS))
                self.assertNotEqual(r.headers.get("access-control-allow-origin"), DOCS, path)
                self.assertNotIn("access-control-allow-origin", r.headers, path)

    async def test_other_origins_unchanged(self):
        async with self.http() as c:
            for origin in ("https://evil.example", "https://docs.markdrop.in.evil.example",
                           "http://docs.markdrop.in", "http://docs.localhost.evil.example"):
                r = await c.options("/api/v1/documents", headers=preflight("POST", origin))
                self.assertNotIn("access-control-allow-origin", r.headers, origin)
                r = await c.post("/api/v1/documents", json={}, headers={"Origin": origin})
                self.assertNotIn("access-control-allow-origin", r.headers, origin)

    async def test_app_origin_keeps_credentials(self):
        async with self.http() as c:
            r = await c.options("/api/v1/documents", headers=preflight("POST", APP_ORIGIN))
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.headers["access-control-allow-origin"], APP_ORIGIN)
            self.assertEqual(r.headers["access-control-allow-credentials"], "true")
            r = await c.get("/api/v1/me/documents", headers={"Origin": APP_ORIGIN})
            self.assertEqual(r.headers["access-control-allow-origin"], APP_ORIGIN)
            self.assertEqual(r.headers["access-control-allow-credentials"], "true")
            self.assertIn("X-Markdrop-Gate", r.headers["access-control-expose-headers"])
            # Admin paths too: the app's CORS is untouched by this layer.
            r = await c.options("/api/v1/admin/documents", headers=preflight("GET", APP_ORIGIN))
            self.assertEqual(r.headers["access-control-allow-origin"], APP_ORIGIN)

    async def test_public_cors_untouched(self):
        async with self.http() as c:
            r = await c.options("/oauth/token", headers=preflight("POST", DOCS))
            self.assertEqual(r.headers["access-control-allow-origin"], "*")
            self.assertNotIn("access-control-allow-credentials", r.headers)

    # ── actual requests ───────────────────────────────────────────────────────
    async def test_anonymous_publish_from_docs(self):
        async with self.http() as c:
            r = await c.post("/api/v1/documents", json={"title": "Try it", "content": "# Hi", "expires_in": "1d"},
                             headers={"Origin": DOCS})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.headers["access-control-allow-origin"], DOCS)
        self.assertNotIn("access-control-allow-credentials", r.headers)
        expose = r.headers["access-control-expose-headers"]
        for h in ("Retry-After", "X-RateLimit-Remaining", "X-Markdrop-Gate"):
            self.assertIn(h, expose)
        self.assertIn("Origin", r.headers["vary"])
        self.assertEqual(r.headers.get_list("access-control-allow-origin"), [DOCS])
        self.assertIsNotNone(r.json()["expires_at"])

    async def test_token_request_and_errors_from_docs(self):
        now = datetime.now(timezone.utc)
        res = await self.db["users"].insert_one({"email": "t@example.com", "name": "T", "created_at": now,
                                                 "updated_at": now, "providers": ["email"]})
        token, _ = create_access_token(str(res.inserted_id), "t@example.com")
        async with self.http() as c:
            ok = await c.get("/api/v1/me/documents", headers={"Origin": LOCAL_DOCS, "Authorization": f"Bearer {token}"})
            anon = await c.get("/api/v1/me/documents", headers={"Origin": LOCAL_DOCS})
            bad = await c.post("/api/v1/documents", json={}, headers={"Origin": DOCS})
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual(ok.headers["access-control-allow-origin"], LOCAL_DOCS)
        self.assertEqual(anon.status_code, 401)
        self.assertEqual(anon.headers["access-control-allow-origin"], LOCAL_DOCS)
        self.assertEqual(bad.status_code, 422)
        self.assertEqual(bad.headers["access-control-allow-origin"], DOCS)
        for r in (ok, anon, bad):
            self.assertNotIn("access-control-allow-credentials", r.headers)

    async def test_closed_paths_actual_request_get_nothing(self):
        async with self.http() as c:
            r = await c.get("/api/v1/admin/documents", headers={"Origin": DOCS})
            self.assertNotEqual(r.headers.get("access-control-allow-origin"), DOCS)
            r = await c.post("/api/v1/auth/email/request", json={"email": "x@example.com"}, headers={"Origin": DOCS})
            self.assertNotEqual(r.headers.get("access-control-allow-origin"), DOCS)

    async def test_rate_limit_retry_after_readable(self):
        async with self.http() as c:
            last = None
            for i in range(12):
                last = await c.post("/api/v1/documents", json={"content": f"# {i}", "expires_in": "1d"},
                                    headers={"Origin": DOCS})
        self.assertEqual(last.status_code, 429)
        self.assertEqual(last.headers["access-control-allow-origin"], DOCS)
        self.assertIn("Retry-After", last.headers["access-control-expose-headers"])
        self.assertIn("retry-after", last.headers)


if __name__ == "__main__":
    unittest.main()
