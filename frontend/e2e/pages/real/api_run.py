"""The docs-media sandbox API (scripts/docs-media/stack/run_api.py, STACK_ID=5: :8230, db
markdrop_docs_demo_5), with the cache purge delivered to the local Next server like production does
(run_api.py swallows it), so an access change really purges /<slug>."""
import importlib.util
import os
from pathlib import Path

import httpx

os.environ.setdefault("STACK_ID", "5")
RUN_API = Path(__file__).resolve().parents[3] / "scripts" / "docs-media" / "stack" / "run_api.py"
spec = importlib.util.spec_from_file_location("run_api", RUN_API)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

from app.services import revalidate  # noqa: E402

mod.settings.page_revalidate_enabled = True
# The workspace domain used in the E2E is acme.localhost (WebKit can't map a real host name to
# 127.0.0.1); the domain service refuses *.localhost as reserved, so its origin is allowed statically.
mod.settings.cors_origins.append("http://acme.localhost:3450")


async def _post(payload: dict) -> int:
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.post("http://localhost:3450/api/revalidate", json=payload)
            return r.status_code
    except Exception:
        return 0


revalidate._post = _post

import uvicorn  # noqa: E402

uvicorn.run(mod.asgi, host="127.0.0.1", port=8230, log_level="warning")
