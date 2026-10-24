"""Shared fixtures for the MCP and OAuth tests.

Reuses the email tests' environment pinning (in-memory rate limiter, fixed
hosts: API https://api.markdrop.in, frontend https://markdrop.in) and points
the app's global database at a throwaway MongoDB database, because the OAuth
and MCP code reads `get_database()` directly rather than through a dependency.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
import unittest
from urllib.parse import parse_qs, urlsplit

from tests import _email_env as env  # noqa: F401  (pins settings first)

import httpx
from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorClient

from app import database
from app.config import get_settings
from app.limiter import limiter
from app.main import app
from app.services import cimd, oauth_server
from app.utils.auth import create_access_token

settings = get_settings()
API = "https://api.markdrop.in"
RESOURCE = f"{API}/mcp"
REDIRECT = "https://client.example/callback"
_R2_SETTINGS = ("r2_account_id", "r2_access_key_id", "r2_secret_access_key", "r2_bucket")


def pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    return verifier, challenge


def query(url: str) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}


@unittest.skipUnless(env.MONGO, "MongoDB not reachable")
class McpTestCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.db_name = f"markdrop_test_mcp_{secrets.token_hex(4)}"
        self.client = AsyncIOMotorClient(env.MONGO_URI)
        self.db = self.client[self.db_name]
        self._saved = (database._client, settings.mongodb_db)
        database._client = self.client
        settings.mongodb_db = self.db_name
        # A developer's .env may hold real R2 keys: never let a test reach the bucket. Tests that
        # need storage mock the r2 module instead.
        self._saved_r2 = {k: getattr(settings, k) for k in _R2_SETTINGS}
        for k in _R2_SETTINGS:
            setattr(settings, k, "")
        await self.db["documents"].create_index("slug", unique=True)
        await self.db["users"].create_index("email", unique=True)
        await self.db["oauth_grants"].create_index([("user_id", 1), ("client_id", 1)], unique=True)
        limiter.reset()
        oauth_server.clear_access_cache()
        cimd.clear_cache()
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=API)
        self.user_id = await self.make_user("priya@example.com", "Priya")
        self.session, _ = create_access_token(self.user_id, "priya@example.com")

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.client.drop_database(self.db_name)
        self.client.close()
        database._client, settings.mongodb_db = self._saved
        for k, v in self._saved_r2.items():
            setattr(settings, k, v)
        oauth_server.clear_access_cache()
        cimd.clear_cache()

    async def make_user(self, email: str, name: str | None = None) -> str:
        res = await self.db["users"].insert_one({
            "_id": ObjectId(), "email": email, "name": name, "providers": ["email"],
            "created_at": oauth_server._now(), "updated_at": oauth_server._now(),
        })
        return str(res.inserted_id)

    # ── OAuth helpers ──

    async def register(self, **overrides) -> dict:
        body = {"client_name": "Test App", "redirect_uris": [REDIRECT], **overrides}
        r = await self.http.post("/oauth/register", json=body)
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    async def authorize(self, client_id: str, challenge: str, *, redirect_uri: str = REDIRECT,
                        scope: str | None = None, state: str = "st-1", **extra) -> httpx.Response:
        params = {
            "response_type": "code", "client_id": client_id, "redirect_uri": redirect_uri,
            "code_challenge": challenge, "code_challenge_method": "S256", "state": state,
            "resource": RESOURCE, **extra,
        }
        if scope is not None:
            params["scope"] = scope
        return await self.http.get("/oauth/authorize", params=params)

    async def consent(self, authorize_response: httpx.Response, approve: bool = True,
                      session: str | None = None) -> str:
        self.assertEqual(authorize_response.status_code, 302, authorize_response.text)
        location = authorize_response.headers["location"]
        self.assertTrue(location.startswith("https://markdrop.in/oauth/consent?request="), location)
        request_id = query(location)["request"]
        r = await self.http.post(
            f"/api/v1/oauth/requests/{request_id}/decision", json={"approve": approve},
            headers={"Authorization": f"Bearer {session or self.session}"},
        )
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["redirect_url"]

    async def exchange(self, client_id: str, code: str, verifier: str, *,
                       redirect_uri: str = REDIRECT, **extra) -> httpx.Response:
        form = {"grant_type": "authorization_code", "code": code, "code_verifier": verifier,
                "client_id": client_id, "redirect_uri": redirect_uri, "resource": RESOURCE, **extra}
        return await self.http.post("/oauth/token", data=form)

    async def connect(self, scope: str | None = None) -> tuple[dict, dict]:
        """Register, authorize, approve and exchange: (client, tokens)."""
        client = await self.register()
        verifier, challenge = pkce()
        redirect = await self.consent(await self.authorize(client["client_id"], challenge, scope=scope))
        r = await self.exchange(client["client_id"], query(redirect)["code"], verifier)
        self.assertEqual(r.status_code, 200, r.text)
        return client, r.json()

    # ── MCP helpers ──

    async def rpc(self, token: str, method: str, params: dict | None = None, *, id_=1,
                  headers: dict | None = None) -> httpx.Response:
        body = {"jsonrpc": "2.0", "id": id_, "method": method}
        if params is not None:
            body["params"] = params
        return await self.http.post("/mcp", json=body, headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json, text/event-stream",
            **(headers or {}),
        })

    async def call(self, token: str, name: str, arguments: dict) -> dict:
        r = await self.rpc(token, "tools/call", {"name": name, "arguments": arguments})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["result"]
