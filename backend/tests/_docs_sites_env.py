"""Fixtures for the hosted docs sites API tests (routers/docs_sites.py).

A workspace "Acme" with an owner, an admin, a member (editor) and a viewer, plus
a stranger. The docs R2 bucket is replaced by an in-memory dict (the docs R2
settings are blanked so nothing can reach a bucket). MongoDB is the local test
server (MARKDROP_TEST_MONGODB_URI) when reachable, else mongomock.
"""

from __future__ import annotations

import secrets
import unittest
from datetime import datetime, timezone
from unittest import mock

from tests import _email_env as env  # noqa: F401  (pins settings first)

import httpx
from bson import ObjectId

from app import database
from app.config import get_settings
from app.limiter import limiter
from app.main import app
from app.services import docs_site_assets, docs_site_store
from app.utils.auth import create_access_token

settings = get_settings()
API = "https://api.markdrop.in"
BASE = "/api/v1/docs-sites"
_DOCS_R2 = ("docs_r2_bucket", "docs_r2_account_id", "docs_r2_access_key_id", "docs_r2_secret_access_key")
PEOPLE = {"owner": "owner", "admin": "admin", "editor": "member", "viewer": "viewer", "stranger": None}


def now() -> datetime:
    return datetime.now(timezone.utc)


class FakeDocsBucket:
    def __init__(self):
        self.objects: dict[str, dict] = {}
        self.configured = True
        self.fail = False

    def patches(self) -> list:
        return [
            mock.patch.object(docs_site_assets, "is_configured", lambda: self.configured),
            mock.patch.object(docs_site_assets, "put_bytes", self.put_bytes),
            mock.patch.object(docs_site_assets, "presign_get",
                              lambda key, expires_in=3600: f"https://r2.example/{key}?sig=1"),
        ]

    def put_bytes(self, key, data, content_type):
        if self.fail:
            return False
        self.objects[key] = {"data": data, "content_type": content_type}
        return True


class DocsSitesCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.db_name = f"markdrop_test_docs_sites_{secrets.token_hex(4)}"
        if env.MONGO:
            from motor.motor_asyncio import AsyncIOMotorClient

            self.client = AsyncIOMotorClient(env.MONGO_URI)
        else:
            from mongomock_motor import AsyncMongoMockClient

            self.client = AsyncMongoMockClient()
        self.db = self.client[self.db_name]
        self._saved = (database._client, settings.mongodb_db)
        database._client = self.client
        settings.mongodb_db = self.db_name
        self._saved_r2 = {k: getattr(settings, k) for k in _DOCS_R2}
        for k in _DOCS_R2:
            setattr(settings, k, "")
        await self.db["users"].create_index("email", unique=True)
        await self.db["memberships"].create_index([("workspace_id", 1), ("user_id", 1)], unique=True)
        await docs_site_store.ensure_indexes(self.db)
        limiter.reset()

        self.bucket = FakeDocsBucket()
        for p in self.bucket.patches():
            p.start()
            self.addCleanup(p.stop)

        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=API)
        self.uid: dict[str, str] = {}
        self.h: dict[str, dict] = {}
        for who in PEOPLE:
            email = f"{who}@example.com"
            res = await self.db["users"].insert_one({
                "_id": ObjectId(), "email": email, "name": who.capitalize(), "providers": ["email"],
                "created_at": now(), "updated_at": now()})
            self.uid[who] = str(res.inserted_id)
            self.h[who] = {"Authorization": f"Bearer {create_access_token(self.uid[who], email)[0]}"}
        res = await self.db["workspaces"].insert_one({
            "name": "Acme", "owner_id": self.uid["owner"], "created_at": now(), "updated_at": now(),
            "branding": {}, "settings": {}})
        self.ws = str(res.inserted_id)
        for who, role in PEOPLE.items():
            if role:
                await self.db["memberships"].insert_one({
                    "workspace_id": self.ws, "user_id": self.uid[who], "role": role, "created_at": now(),
                    "email": f"{who}@example.com", "name": who.capitalize()})

    async def asyncTearDown(self):
        await self.http.aclose()
        if env.MONGO:
            await self.client.drop_database(self.db_name)
            self.client.close()
        database._client, settings.mongodb_db = self._saved
        for k, v in self._saved_r2.items():
            setattr(settings, k, v)

    # ── helpers ──

    async def create(self, slug: str = "acme", who: str = "owner", *, workspace: bool = True,
                     source: dict | None = None, name: str = "Acme Docs", expect: int = 201) -> dict:
        body = {"workspace_id": self.ws if workspace else None, "name": name, "slug": slug,
                "source": source or {"kind": "blank"}}
        limiter.reset()  # creating is limited to 10 a minute; these tests make more
        r = await self.http.post(BASE, json=body, headers=self.h[who])
        self.assertEqual(r.status_code, expect, r.text)
        return r.json()

    async def get(self, path: str, who: str = "owner", expect: int = 200, **kw) -> dict:
        r = await self.http.get(BASE + path, headers=self.h[who], **kw)
        self.assertEqual(r.status_code, expect, r.text)
        return r.json()

    async def call(self, method: str, path: str, who: str = "owner", expect: int = 200, **kw) -> dict:
        r = await self.http.request(method, BASE + path, headers=self.h[who], **kw)
        self.assertEqual(r.status_code, expect, r.text)
        return r.json()

    async def home(self, site_id: str) -> dict:
        listing = await self.get(f"/{site_id}/pages")
        pid = next(p["id"] for p in listing["pages"] if p["path"] == "/")
        return await self.get(f"/{site_id}/pages/{pid}")

    async def mark_live(self, build_id: str, manifest: str = "m" * 64) -> None:
        """What the worker does when a build goes live."""
        b = await self.db["docs_builds"].find_one({"_id": ObjectId(build_id)})
        await self.db["docs_builds"].update_many({"site_id": b["site_id"], "status": "live"},
                                                 {"$set": {"status": "superseded"}})
        await self.db["docs_builds"].update_one({"_id": b["_id"]},
                                                {"$set": {"status": "live", "manifest_hash": manifest}})
        await self.db["docs_sites"].update_one({"_id": b["site_id"]}, {"$set": {
            "status": "live", "live_build_id": b["_id"], "last_published_at": now(),
            "last_published_by": b["requested_by"]}})
