"""Mint an MCP OAuth access token for a seeded user (the same rows the OAuth flow writes).

  STACK_ID=5 DOCS_MEDIA_DATA=… python mint_mcp.py <email> [read]   → prints the access token
"""
import asyncio
import contextlib
import importlib.util
import io
import os
import secrets
import sys
from pathlib import Path

os.environ.setdefault("STACK_ID", "5")
RUN_API = Path(__file__).resolve().parents[3] / "scripts" / "docs-media" / "stack" / "run_api.py"
spec = importlib.util.spec_from_file_location("run_api", RUN_API)
mod = importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()):
    spec.loader.exec_module(mod)

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from app.services import oauth_server  # noqa: E402


async def main():
    email = sys.argv[1]
    write = not (len(sys.argv) > 2 and sys.argv[2] == "read")
    db = AsyncIOMotorClient(mod.settings.mongodb_uri)[mod.settings.mongodb_db]
    u = await db["users"].find_one({"email": email})
    scopes = ["documents:read", "documents:write"] if write else ["documents:read"]
    out = await oauth_server._issue(db, user_id=str(u["_id"]), client_id="e2e-client", scopes=scopes,
                                    family_id=secrets.token_hex(4))
    print(out["access_token"])


asyncio.run(main())
