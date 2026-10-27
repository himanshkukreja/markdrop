"""The access-policy fixture world (access policy §6).

Users: owner, ownv (doc owner who is a W1 *viewer*), ownx (doc owner who left
W1), stranger, gv / ge (named viewer / editor on every fixture doc), wv, wm,
wa, wo (W1 roles), wm2 (member of W2 only), former (was WM, removed),
invitee (pending invitation to W1).

Workspaces: W1 (live domain docs.acme.test), WR — identical membership with
``require_auth_to_view`` on (live domain docs-r.acme.test), W2 (live domain
w2.test).

R2 is :class:`tests._files_env.FakeR2` (in memory); MongoDB is the local test
server when reachable, otherwise mongomock (MARKDROP_TEST_MONGOMOCK or simply
unreachable Mongo — as tests/_files_env.py does).
"""

from __future__ import annotations

import asyncio
import secrets
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from tests import _email_env as env  # noqa: F401  (pins settings first)

import bcrypt
import httpx
from bson import ObjectId

from app import database
from app.config import get_settings
from app.limiter import limiter
from app.main import app
from app.services import access, api_token, file_uploads, media, oauth_server, r2, revalidate
from app.utils.auth import create_access_token, create_tenant_token
from tests._files_env import FakeR2

settings = get_settings()
API = "https://api.markdrop.in"
ORIGIN = "https://markdrop-artifacts.example.workers.dev"
_R2_SETTINGS = ("r2_account_id", "r2_access_key_id", "r2_secret_access_key", "r2_bucket")

# Cheap hashes: bcrypt's default cost would make a 300-document world slow.
ES_SECRET = "sk_test_edit_secret"
ES_HASH = bcrypt.hashpw(ES_SECRET.encode(), bcrypt.gensalt(rounds=4)).decode()
PASSWORD = "pw-correct"
PW_HASH = bcrypt.hashpw(PASSWORD.encode(), bcrypt.gensalt(rounds=4)).decode()

USERS = ("owner", "ownv", "ownx", "stranger", "gv", "ge", "wv", "wm", "wa", "wo", "wm2",
         "former", "invitee")
HOSTS = {"W1": "docs.acme.test", "WR": "docs-r.acme.test", "W2": "w2.test"}


def now() -> datetime:
    return datetime.now(timezone.utc)


class AccessWorld(unittest.IsolatedAsyncioTestCase):
    """Builds the world; each test gets a fresh database."""

    async def asyncSetUp(self):
        self.db_name = f"markdrop_test_access_{secrets.token_hex(4)}"
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
        await self.db["document_grants"].create_index([("document_id", 1), ("email", 1)], unique=True)
        await self.db["memberships"].create_index([("workspace_id", 1), ("user_id", 1)], unique=True)
        limiter.reset()
        access.password_attempts.reset()
        oauth_server.clear_access_cache()

        self.r2 = FakeR2()
        self.posted: list[dict] = []
        self.post_status = 200

        async def fake_post(payload):
            self.posted.append(payload)
            return self.post_status

        self.probed: list = []
        patches = [
            *self.r2.patches(),
            mock.patch.object(settings, "artifact_origin", ORIGIN),
            mock.patch.object(settings, "artifact_signing_key", "k"),
            mock.patch.object(settings, "page_revalidate_enabled", False),
            mock.patch.object(revalidate, "_post", fake_post),
            mock.patch.object(media, "schedule", lambda *a, **k: self.probed.append(a)),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=API)
        self.uid: dict[str, str] = {}
        self.email: dict[str, str] = {}
        for name in USERS:
            self.email[name] = f"{name}@example.com"
            self.uid[name] = await self.make_user(self.email[name], name.upper())
        self.ws: dict[str, str] = {}
        self.ws["W1"] = await self.make_workspace("Acme", "wo", require_auth=False)
        self.ws["WR"] = await self.make_workspace("Acme Private", "wo", require_auth=True)
        self.ws["W2"] = await self.make_workspace("Other", "wm2", require_auth=False)
        for key in ("W1", "WR"):
            for name, role in (("wa", "admin"), ("wm", "member"), ("wv", "viewer"),
                               ("owner", "member"), ("ownv", "viewer")):
                await self.add_member(key, name, role)
            await self.add_domain(key, HOSTS[key])
        await self.add_domain("W2", HOSTS["W2"])
        await self.db["invitations"].insert_one({
            "workspace_id": self.ws["W1"], "email": self.email["invitee"], "role": "member",
            "status": "pending", "created_at": now(), "expires_at": now() + timedelta(days=7)})
        self._tokens: dict = {}

    async def asyncTearDown(self):
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
        oauth_server.clear_access_cache()

    # ── World building ──

    async def make_user(self, email: str, name: str | None = None) -> str:
        res = await self.db["users"].insert_one({
            "_id": ObjectId(), "email": email, "name": name, "providers": ["email"],
            "created_at": now(), "updated_at": now()})
        return str(res.inserted_id)

    async def make_workspace(self, name: str, owner: str, *, require_auth: bool) -> str:
        res = await self.db["workspaces"].insert_one({
            "name": name, "owner_id": self.uid[owner], "created_at": now(), "updated_at": now(),
            "branding": {"site_name": name}, "settings": {"require_auth_to_view": require_auth}})
        ws_id = str(res.inserted_id)
        await self.db["memberships"].insert_one({
            "workspace_id": ws_id, "user_id": self.uid[owner], "role": "owner", "created_at": now(),
            "email": self.email[owner], "name": owner.upper()})
        return ws_id

    async def add_member(self, ws_key: str, who: str, role: str) -> None:
        await self.db["memberships"].update_one(
            {"workspace_id": self.ws[ws_key], "user_id": self.uid[who]},
            {"$set": {"role": role, "created_at": now(), "email": self.email[who], "name": who.upper()}},
            upsert=True)

    async def remove_member(self, ws_key: str, who: str) -> None:
        await self.db["memberships"].delete_one({"workspace_id": self.ws[ws_key], "user_id": self.uid[who]})

    async def add_domain(self, ws_key: str, host: str, **extra) -> None:
        await self.db["domains"].insert_one({
            "host": host, "workspace_id": self.ws[ws_key], "kind": "app", "status": "verified",
            "verification_token": "t", "created_at": now(), "attached": True, "is_primary": True,
            **extra})

    async def set_require_auth(self, ws_key: str, on: bool) -> None:
        await self.db["workspaces"].update_one(
            {"_id": ObjectId(self.ws[ws_key])}, {"$set": {"settings.require_auth_to_view": on}})

    async def mkdoc(self, state: str = "W", *, owner: str = "owner", ws: str | None = "W1",
                    kind: str = "markdown", grants: bool = True, slug: str | None = None,
                    bundle: bool = False, encrypted: bool = False, **extra) -> dict:
        """A document in ``state``: L, LP, P, W, or R-prefixed (filed in WR),
        or 'U' + one of those for unfiled. ``owner`` None = owner-less."""
        if state.startswith("U"):
            # Unfiled: R· has no meaning without a workspace.
            ws, state = None, state[1:].removeprefix("R")
        elif state.startswith("R"):
            ws, state = "WR", state[1:]
        level = {"L": "link", "LP": "link", "P": "private", "W": "workspace"}[state]
        slug = slug or f"d-{secrets.token_hex(5)}"
        owner_id = self.uid[owner] if owner else None
        doc = {
            "slug": slug, "title": f"Title {slug}", "content": f"# Body {slug}",
            "edit_secret_hash": ES_HASH, "created_at": now(), "updated_at": now(),
            "expires_at": None, "views": 0, "rev": 1, "owner_id": owner_id,
            "access_level": level, "read_password_hash": PW_HASH if state == "LP" else None,
            "workspace_id": self.ws[ws] if ws else None, "folder_id": None, "folder_path": [],
            "access_epoch": 0, "encrypted": encrypted,
        }
        if ws:
            doc["allow_resharing"] = False
        if kind == "artifact":
            prefix = f"art/{owner_id or 'anon'}/"
            if bundle:
                bp = f"{prefix}b{secrets.token_hex(4)}/"
                doc.update(kind="artifact", mime="text/html", bundle_prefix=bp,
                           blob_key=f"{bp}index.html", size_bytes=10, original_filename="site.zip")
                self.r2.put_bytes(f"{bp}index.html", b"<h1>site</h1>", "text/html", False)
                self.r2.put_bytes(f"{bp}app.js", b"1", "text/javascript", False)
            else:
                key = f"{prefix}{secrets.token_hex(6)}.html"
                doc.update(kind="artifact", mime="text/html", blob_key=key, size_bytes=12,
                           original_filename="page.html", file_version=1)
                self.r2.put_bytes(key, b"<h1>page</h1>", "text/html", False)
        doc.update(extra)
        res = await self.db["documents"].insert_one(doc)
        doc["_id"] = res.inserted_id
        if kind == "artifact":
            from app.services import publicity

            public = publicity.is_public(doc, require_auth=(ws == "WR"))
            for k in [k for k in self.r2.objects if k == doc.get("blob_key")
                      or (doc.get("bundle_prefix") and k.startswith(doc["bundle_prefix"]))]:
                self.r2.objects[k]["public"] = public
        if grants and owner_id:
            for who, role in (("gv", "viewer"), ("ge", "editor")):
                await self.db["document_grants"].insert_one({
                    "document_id": str(doc["_id"]), "email": self.email[who], "role": role,
                    "created_at": now(), "granted_by_email": self.email[owner],
                    "granted_by_user_id": owner_id, "granted_via": None})
        return doc

    async def doc(self, slug: str) -> dict | None:
        return await self.db["documents"].find_one({"slug": slug})

    async def jobs(self) -> set[str]:
        return await revalidate.all_keys(self.db)

    # ── Credentials ──

    def session(self, who: str) -> dict:
        return {"Authorization": f"Bearer {create_access_token(self.uid[who], self.email[who])[0]}"}

    def tenant(self, who: str, ws_key: str, *, origin: str | None = None) -> dict:
        token, _ = create_tenant_token(self.uid[who], self.email[who], self.ws[ws_key], HOSTS[ws_key])
        return {"Authorization": f"Bearer {token}", "Origin": origin or f"https://{HOSTS[ws_key]}"}

    async def api_token(self, who: str) -> dict:
        if ("at", who) not in self._tokens:
            raw, _rec = await api_token.create_token(self.db, self.uid[who], "test")
            self._tokens[("at", who)] = raw
        return {"Authorization": f"Bearer {self._tokens[('at', who)]}"}

    async def mcp_token(self, who: str, *, write: bool = True) -> str:
        key = ("mcp", who, write)
        if key not in self._tokens:
            scopes = ["documents:read", "documents:write"] if write else ["documents:read"]
            out = await oauth_server._issue(self.db, user_id=self.uid[who], client_id="test-client",
                                            scopes=scopes, family_id=secrets.token_hex(4))
            self._tokens[key] = out["access_token"]
        return self._tokens[key]

    async def headers(self, actor: str, doc: dict | None = None) -> dict:
        """Request headers for a matrix actor name."""
        if actor == "AN":
            return {}
        if actor == "ES":
            return {"X-Edit-Secret": ES_SECRET}
        if actor == "TS":
            key = "WR" if doc and doc.get("workspace_id") == self.ws["WR"] else "W1"
            return self.tenant("wm", key)
        if actor == "TX":
            return self.tenant("wm2", "W2")
        if actor == "AT":
            return await self.api_token("wm")
        name = {"ST": "stranger", "FM": "former", "IN": "invitee", "OW": "owner", "OWv": "ownv",
                "OWx": "ownx", "GV": "gv", "GE": "ge", "WV": "wv", "WM": "wm", "WA": "wa",
                "WO": "wo"}[actor]
        return self.session(name)

    @staticmethod
    def owner_for(actor: str) -> str:
        return {"OWv": "ownv", "OWx": "ownx"}.get(actor, "owner")

    # ── MCP ──

    async def mcp_call(self, token: str, name: str, arguments: dict) -> tuple[int, dict | None]:
        r = await self.http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                               "params": {"name": name, "arguments": arguments}},
                                 headers={"Authorization": f"Bearer {token}",
                                          "Accept": "application/json, text/event-stream"})
        if r.status_code != 200:
            return r.status_code, None
        return 200, r.json()["result"]

    async def get(self, slug: str, headers: dict | None = None, **kw) -> httpx.Response:
        return await self.http.get(f"/api/v1/documents/{slug}", headers=headers or {}, **kw)
