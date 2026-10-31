#!/usr/bin/env python3
"""The Markdrop Guides job worker for the docs media stack (stack.sh starts it after the API).

Runs the REAL local worker (backend/scripts/docs_build_worker.py: builds, imports, restores,
unpublishes) with the sandbox's settings: stack/.env (never backend/.env: cwd is this folder and
every inherited MARKDROP_* variable is dropped), this instance's Mongo db, and the folder store
``.data/docs-store`` instead of the docs R2 bucket. A publish in the studio is built by the real
engine (docs-platform/runner → builder) and published into that folder, which stack.sh serves by
hostname, so ``http://<slug>.guides.markdrop.in:<docs port>`` shows the real site.

    STACK_ID=N backend/.venv/bin/python frontend/scripts/docs-media/stack/run_docs_worker.py [--once]

Ports: the build's crawl server uses 3406 + 10N (beside Next's 3400 + 10N).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
MEDIA_ROOT = HERE.parent
REPO = MEDIA_ROOT.parents[2]
BACKEND = REPO / "backend"
STACK_ID = int(os.environ.get("STACK_ID") or 0)
_BASE = Path(os.environ.get("DOCS_MEDIA_DATA") or (MEDIA_ROOT / ".data")).resolve()
DATA = _BASE if STACK_ID == 0 else _BASE / str(STACK_ID)
API_PORT = 8180 + 10 * STACK_ID
NEXT_PORT = 3400 + 10 * STACK_ID
LOOPBACK = {"127.0.0.1", "localhost", "::1"}

os.chdir(HERE)  # pydantic-settings reads ./.env: this folder's, never backend/.env
for key in [k for k in os.environ if k.startswith("MARKDROP_")]:
    del os.environ[key]
env_file = HERE / ".env" if (HERE / ".env").exists() else HERE / ".env.example"
for line in env_file.read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
        v = v[1:-1]
    os.environ[k.strip()] = v
if STACK_ID:
    os.environ.update({
        "MARKDROP_MONGODB_DB": f"markdrop_docs_demo_{STACK_ID}",
        "MARKDROP_FRONTEND_URL": f"http://localhost:{NEXT_PORT}",
        "MARKDROP_API_BASE_URL": f"http://127.0.0.1:{API_PORT}",
        "MARKDROP_CORS_ORIGINS": json.dumps([f"http://localhost:{NEXT_PORT}"]),
    })
(DATA / "docs-store").mkdir(parents=True, exist_ok=True)
os.environ.update({
    "MARKDROP_DOCS_BUILD_TARGETS": "local",
    "MARKDROP_DOCS_STORE_DIR": str(DATA / "docs-store"),
    "MARKDROP_DOCS_WORK_DIR": str(DATA / "docs-work"),
    "MARKDROP_DOCS_BUILD_PORT_BASE": str(NEXT_PORT + 6),
    "MARKDROP_DOCS_WORKER_POLL_SECONDS": "1",
    "MARKDROP_DOCS_WORKER_KINDS": "build,restore,unpublish",
    "MARKDROP_DOCS_NICE": "0",
    "MARKDROP_DOCS_BUILD_CPUS": os.environ.get("MARKDROP_DOCS_BUILD_CPUS", "2"),
})
sys.path.insert(0, str(BACKEND))

from app.config import get_settings  # noqa: E402

settings = get_settings()
problems = []
if (urlsplit(settings.mongodb_uri).hostname or "") not in LOOPBACK:
    problems.append(f"mongodb_uri {settings.mongodb_uri}")
if not settings.mongodb_db.startswith("markdrop_docs_demo"):
    problems.append(f"mongodb_db {settings.mongodb_db}")
if settings.docs_r2_configured:
    problems.append("a docs R2 bucket is configured")
if problems:
    sys.exit("run_docs_worker.py: refusing to start, not local-only: " + "; ".join(problems))

from app.services import docs_dispatch  # noqa: E402


async def _no_probe(url, *, client=None):
    return 5


# Imports would fetch the GitBook source over the internet: this worker never takes them
# (MARKDROP_DOCS_WORKER_KINDS below), and routing one never reads the source's llms.txt.
# seed_extra_studio.py --import-run plays the import with synthetic content instead.
docs_dispatch.probe_import_pages = _no_probe

from scripts.docs_build_worker import main  # noqa: E402

if __name__ == "__main__":
    print(f"[docs-media] stack {STACK_ID}: Markdrop Guides worker on db {settings.mongodb_db}, "
          f"store {os.environ['MARKDROP_DOCS_STORE_DIR']}", flush=True)
    sys.exit(main())
