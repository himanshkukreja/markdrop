"""The docs-media sandbox API (scripts/docs-media/stack/run_api.py, STACK_ID=5: :8230, db
markdrop_docs_demo_5), with the cache purge delivered to the local Next server like production does
(run_api.py swallows it), so an access change really purges /<slug>."""
import importlib.util
import os
from pathlib import Path

import httpx

os.environ.setdefault("STACK_ID", "5")
STACK_ID = int(os.environ["STACK_ID"])
NEXT_PORT = 3400 + 10 * STACK_ID
RUN_API = Path(__file__).resolve().parents[3] / "scripts" / "docs-media" / "stack" / "run_api.py"
spec = importlib.util.spec_from_file_location("run_api", RUN_API)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

from app.services import revalidate  # noqa: E402

mod.settings.page_revalidate_enabled = True
# The workspace domain used in the E2E is acme.localhost (WebKit can't map a real host name to
# 127.0.0.1); the domain service refuses *.localhost as reserved, so its origin is allowed statically.
mod.settings.cors_origins.append(f"http://acme.localhost:{NEXT_PORT}")


async def _post(payload: dict) -> int:
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.post(f"http://localhost:{NEXT_PORT}/api/revalidate", json=payload)
            return r.status_code
    except Exception:
        return 0


revalidate._post = _post

# PB_R2_LATENCY_MS=N: every publicity change on the fake R2 takes N ms, like a HEAD + copy against the
# real bucket, so a big workspace's sign-in change takes long enough to watch (lock.mjs).
_lat = float(os.environ.get("PB_R2_LATENCY_MS") or 0) / 1000
if _lat:
    import time

    from app.services import r2

    _set_public = r2.set_public

    def _slow_set_public(key, public, content_type=None, epoch=None):
        time.sleep(_lat)
        return _set_public(key, public, content_type, epoch)

    def _slow_set_public_prefix(prefix, public, epoch=None):
        keys = r2.list_prefix(prefix)
        for k in keys:
            _slow_set_public(k, public, None, epoch)
        return len(keys)

    r2.set_public = _slow_set_public
    r2.set_public_prefix = _slow_set_public_prefix

import uvicorn  # noqa: E402

uvicorn.run(mod.asgi, host="127.0.0.1", port=8180 + 10 * STACK_ID, log_level="warning")
