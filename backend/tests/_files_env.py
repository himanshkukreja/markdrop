"""Fixtures for the file upload / versions tests.

R2 is replaced by :class:`FakeR2`, an in-memory object store with multipart
uploads, so nothing here can reach a bucket (the real R2 keys are blanked too,
as in tests/_mcp_env.py). The database is the local test MongoDB when it is
reachable (MARKDROP_TEST_MONGODB_URI, default mongodb://localhost:27018) and
otherwise an in-process mongomock_motor database, so these tests run either way.
"""

from __future__ import annotations

import asyncio
import hashlib
import secrets
import unittest
from unittest import mock

from tests import _email_env as env  # noqa: F401  (pins settings first)

import httpx
from bson import ObjectId

from app import database
from app.config import get_settings
from app.limiter import limiter
from app.main import app
from app.services import file_uploads, media, r2, revalidate
from app.utils.auth import create_access_token

settings = get_settings()
API = "https://api.markdrop.in"
ORIGIN = "https://markdrop-artifacts.example.workers.dev"
_R2_SETTINGS = ("r2_account_id", "r2_access_key_id", "r2_secret_access_key", "r2_bucket")
KB = 1024
MB = 1024 * 1024


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class FakeClientError(Exception):
    """Shaped like botocore's ClientError, which _r2_reason reads."""

    def __init__(self, code: str):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class FakeR2:
    """Just enough of services/r2.py, in memory."""

    def __init__(self):
        self.objects: dict[str, dict] = {}
        self.uploads: dict[str, dict] = {}
        self.deleted: list[str] = []
        self.aborted: list[str] = []
        self.public_calls: list[tuple[str, bool]] = []
        self.hash_delay = 0.0
        self.min_part = 5 * MB

    def patches(self) -> list:
        names = ("is_configured", "head", "delete", "set_public", "set_public_prefix", "delete_prefix",
                 "put_bytes", "get_bytes", "presign_put", "presign_get", "presign_upload_part",
                 "create_multipart", "list_parts", "complete_multipart", "abort_multipart", "sha256_of")
        return [mock.patch.object(r2, n, getattr(self, n)) for n in names]

    # objects
    def is_configured(self) -> bool:
        return True

    def head(self, key):
        o = self.objects.get(key)
        if o is None:
            return None
        return {"size": len(o["data"]), "content_type": o["content_type"], "etag": "x"}

    def delete(self, key):
        self.deleted.append(key)
        self.objects.pop(key, None)

    def set_public(self, key, public, content_type=None):
        self.public_calls.append((key, public))
        if key in self.objects:
            self.objects[key]["public"] = public
        return True

    def set_public_prefix(self, prefix, public):
        return 0

    def delete_prefix(self, prefix):
        for k in [k for k in self.objects if k.startswith(prefix)]:
            self.delete(k)
        return 0

    def put_bytes(self, key, data, content_type, public=True, live=False):
        self.objects[key] = {"data": data, "content_type": content_type, "public": public}
        return True

    def get_bytes(self, key, max_bytes):
        o = self.objects.get(key)
        return o["data"][:max_bytes] if o else None

    def presign_put(self, key, content_type):
        return f"https://r2.example/{key}?put"

    def presign_get(self, key, expires_in=300):
        return f"https://r2.example/{key}?get"

    # multipart
    def presign_upload_part(self, key, upload_id, part_number, expires_in):
        return f"https://r2.example/{key}?uploadId={upload_id}&partNumber={part_number}"

    def create_multipart(self, key, content_type, public):
        uid = "r2-" + secrets.token_hex(6)
        self.uploads[uid] = {"key": key, "content_type": content_type, "public": public, "parts": {}}
        return uid

    def put_part(self, r2_upload_id: str, n: int, data: bytes) -> str:
        """What a client's PUT to a part URL does. Returns the ETag."""
        etag = hashlib.md5(data).hexdigest()
        self.uploads[r2_upload_id]["parts"][n] = (data, etag)
        return etag

    def list_parts(self, key, upload_id):
        up = self.uploads.get(upload_id)
        if up is None:
            raise FakeClientError("NoSuchUpload")
        return [{"part_number": n, "etag": e, "size": len(d)} for n, (d, e) in sorted(up["parts"].items())]

    def complete_multipart(self, key, upload_id, parts):
        up = self.uploads.get(upload_id)
        if up is None:
            raise FakeClientError("NoSuchUpload")
        chunks = []
        for i, p in enumerate(sorted(parts, key=lambda p: p["part_number"])):
            got = up["parts"].get(int(p["part_number"]))
            if got is None or got[1] != p["etag"].strip('"'):
                raise FakeClientError("InvalidPart")
            if i < len(parts) - 1 and len(got[0]) < self.min_part:
                raise FakeClientError("EntityTooSmall")
            chunks.append(got[0])
        self.objects[key] = {"data": b"".join(chunks), "content_type": up["content_type"],
                             "public": up["public"]}
        del self.uploads[upload_id]

    def abort_multipart(self, key, upload_id):
        self.aborted.append(upload_id)
        self.uploads.pop(upload_id, None)

    def sha256_of(self, key, on_progress=None, chunk_size=8 * MB):
        import time

        if self.hash_delay:
            time.sleep(self.hash_delay)
        data = self.objects[key]["data"]
        if on_progress:
            on_progress(len(data))
        return hashlib.sha256(data).hexdigest(), len(data)


class FilesTestCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.db_name = f"markdrop_test_files_{secrets.token_hex(4)}"
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
        self._saved_r2 = {k: getattr(settings, k) for k in _R2_SETTINGS}
        for k in _R2_SETTINGS:
            setattr(settings, k, "")
        await self.db["documents"].create_index("slug", unique=True)
        await self.db["users"].create_index("email", unique=True)
        await self.db["file_versions"].create_index([("doc_id", 1), ("version", -1)], unique=True)
        limiter.reset()

        self.r2 = FakeR2()
        self.revalidated: list[str] = []
        self.probed: list[tuple] = []

        async def fake_post(slug):
            self.revalidated.append(slug)

        def fake_schedule(db, doc_id, version, blob_key, mime):
            self.probed.append((doc_id, version, blob_key, mime))

        patches = [
            *self.r2.patches(),
            mock.patch.object(settings, "artifact_origin", ORIGIN),
            mock.patch.object(settings, "artifact_signing_key", "k"),
            mock.patch.object(settings, "page_revalidate_enabled", True),
            mock.patch.object(revalidate, "_post", fake_post),
            mock.patch.object(media, "schedule", fake_schedule),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=API)
        self.user_id = await self.make_user("priya@example.com", "Priya")
        self.other_id = await self.make_user("sam@example.com", "Sam")
        self.auth = {"Authorization": f"Bearer {create_access_token(self.user_id, 'priya@example.com')[0]}"}
        self.other_auth = {"Authorization": f"Bearer {create_access_token(self.other_id, 'sam@example.com')[0]}"}

    async def asyncTearDown(self):
        # Let fire-and-forget tasks (revalidation) finish inside this loop.
        await asyncio.sleep(0)
        for task in list(file_uploads._RUNNING.values()):
            await asyncio.wait({task}, timeout=5)
        await self.http.aclose()
        if env.MONGO:
            await self.client.drop_database(self.db_name)
            self.client.close()
        database._client, settings.mongodb_db = self._saved
        for k, v in self._saved_r2.items():
            setattr(settings, k, v)

    async def make_user(self, email: str, name: str) -> str:
        from datetime import datetime, timezone

        now = datetime.now(timezone.utc)
        res = await self.db["users"].insert_one({
            "_id": ObjectId(), "email": email, "name": name, "providers": ["email"],
            "created_at": now, "updated_at": now,
        })
        return str(res.inserted_id)

    # ── Upload helpers ──

    async def start(self, data: bytes, name: str = "demo.mp4", *, content_type: str = "video/mp4",
                    auth=None, digest: str | None = None, size: int | None = None, **extra) -> httpx.Response:
        body = {"file_name": name, "size_bytes": size if size is not None else len(data),
                "content_type": content_type, "sha256": digest or sha(data), **extra}
        return await self.http.post("/api/v1/files/uploads", json=body, headers=auth or self.auth)

    async def session(self, upload_id: str) -> dict:
        return await self.db["file_uploads"].find_one({"_id": upload_id})

    async def send_parts(self, upload_id: str, data: bytes, numbers: list[int] | None = None) -> list[dict]:
        sess = await self.session(upload_id)
        size = sess["part_size"]
        out = []
        for n in range(1, sess["part_count"] + 1):
            if numbers is not None and n not in numbers:
                continue
            etag = self.r2.put_part(sess["r2_upload_id"], n, data[(n - 1) * size: n * size])
            out.append({"part_number": n, "etag": etag})
        return out

    async def upload(self, data: bytes, name: str = "demo.mp4", *, auth=None, **extra) -> dict:
        """create → send every part → complete; the result."""
        r = await self.start(data, name, auth=auth, **extra)
        self.assertEqual(r.status_code, 200, r.text)
        upload_id = r.json()["upload_id"]
        parts = await self.send_parts(upload_id, data)
        r = await self.http.post(f"/api/v1/files/uploads/{upload_id}/complete",
                                 json={"parts": parts}, headers=auth or self.auth)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def doc(self, slug: str) -> dict:
        return await self.db["documents"].find_one({"slug": slug})

    async def rows(self, slug: str) -> list[dict]:
        raw = await self.doc(slug)
        return await self.db["file_versions"].find({"doc_id": str(raw["_id"])}).sort("version", 1).to_list(length=100)
