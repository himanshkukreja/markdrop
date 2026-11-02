#!/usr/bin/env python3
"""Sandbox API for the docs media stack (frontend/scripts/docs-media).

Imports the REAL FastAPI app (backend/app) with its settings pinned to local-only values, and
swaps the outside world for fakes:

* settings come from ``stack/.env`` (copied from ``.env.example``); the process runs with cwd =
  this folder, so ``backend/.env`` is never read, and every inherited ``MARKDROP_*`` variable is
  dropped first;
* R2 is a disk-backed fake (``.data/r2``) served at ``/__fakes3/<key>`` (PUT/GET/HEAD, Range),
  which is also what presigned URLs point at, so the browser's direct upload, ffprobe's probe
  and the Worker harness all hit the same bytes;
* DNS for custom domains is a JSON file the sandbox controls (``POST /__sandbox/dns``), and the
  DNS-provider hint says "Cloudflare" for acme.* hosts;
* rate limiting is off; email goes to the console transport; background loops are off.

Sandbox-only routes (loopback only; the server binds 127.0.0.1):

  POST /__sandbox/user     {email, name}                → {id, email, name, token}
  POST /__sandbox/mint     {email} | {user_id}          → {token}
  POST /__sandbox/domain   {workspace_id, host, primary?, pending?} → a live domain row
                           (verified + attached), or with pending: an "Awaiting DNS" one
  POST /__sandbox/dns      {host, publish: bool}        → publish/withdraw both DNS records
  POST /__sandbox/domains/reset {workspace_id, keep: [host…]} → drop every other domain
  POST /__sandbox/cleanup  {}                            → delete documents not made by seed.py
  GET  /__sandbox/head/<key>                             → fake-R2 object metadata (Worker harness)
  GET  /__sandbox/health
  GET  /__docsstore/<key>                                → a Markdrop Guides site file (editor previews)

Markdrop Guides: the docs bucket is a folder store (``.data/docs-store``). Uploads land there, builds are
routed to the local worker (stack/run_docs_worker.py, which stack.sh starts) and publish there too,
and stack.sh serves the folder by hostname (docs-platform/server/server.mjs), so a site published in
the studio is really live at ``http://<slug>.guides.markdrop.in:<docs port>`` in the capture browser.

Run: ``backend/.venv/bin/python frontend/scripts/docs-media/stack/run_api.py`` (stack.sh does).
``STACK_ID=N`` (default 0) runs instance N: API 8180+10N, Worker 8787+10N, Next 3400+10N, db
``markdrop_docs_demo_N`` (0: ``markdrop_docs_demo``), data folder ``.data/N/`` (0: ``.data/``).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import secrets
import shutil
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

HERE = Path(__file__).resolve().parent
MEDIA_ROOT = HERE.parent
REPO = MEDIA_ROOT.parents[2]
BACKEND = REPO / "backend"
# Several stacks can run side by side (STACK_ID=N, default 0): N moves every port by 10·N and
# gives the instance its own Mongo db (markdrop_docs_demo_N) and data folder (.data/N/).
STACK_ID = int(os.environ.get("STACK_ID") or 0)
_BASE = Path(os.environ.get("DOCS_MEDIA_DATA") or (MEDIA_ROOT / ".data")).resolve()
DATA = _BASE if STACK_ID == 0 else _BASE / str(STACK_ID)
R2_DIR = DATA / "r2"
DNS_FILE = DATA / "dns.json"
PORT = int(os.environ.get("DOCS_MEDIA_API_PORT") or 8180 + 10 * STACK_ID)
WORKER_PORT = 8787 + 10 * STACK_ID
NEXT_PORT = 3400 + 10 * STACK_ID
API = f"http://127.0.0.1:{PORT}"

LOOPBACK = {"127.0.0.1", "localhost", "::1"}


# ── Settings: our .env only ──────────────────────────────────────────────────


def _load_env() -> None:
    env_file = HERE / ".env"
    if not env_file.exists():
        shutil.copyfile(HERE / ".env.example", env_file)
    for key in [k for k in os.environ if k.startswith("MARKDROP_")]:
        del os.environ[key]
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        os.environ[key.strip()] = value
    # Markdrop Guides: builds on the local worker, a folder for the docs bucket (see the docstring).
    os.environ.update({
        "MARKDROP_DOCS_BUILD_TARGETS": "local",
        "MARKDROP_DOCS_STORE_DIR": str(DATA / "docs-store"),
        # A guide's own domain is switched on against a fake Cloudflare (see "Fake DNS"): never a real token.
        "MARKDROP_DOCS_CF_API_TOKEN": "sandbox-fake-token",
        "MARKDROP_DOCS_CF_ZONE_ID": "0" * 32,
    })
    if os.environ.get("DOCS_MEDIA_REDIS_URL"):  # stack.sh with DOCS_MEDIA_REDIS=1
        os.environ["MARKDROP_REDIS_URL"] = os.environ["DOCS_MEDIA_REDIS_URL"]
    if STACK_ID:  # an extra instance: its own db, ports and origins (environment beats .env)
        app_origins = [f"http://{h}:{NEXT_PORT}" for h in
                       ("localhost", "127.0.0.1", "docs.localhost", "docs.acme.test", "docs.acme.com")]
        os.environ.update({
            "MARKDROP_MONGODB_DB": f"markdrop_docs_demo_{STACK_ID}",
            "MARKDROP_FRONTEND_URL": f"http://localhost:{NEXT_PORT}",
            "MARKDROP_API_BASE_URL": API,
            "MARKDROP_ARTIFACT_ORIGIN": f"http://127.0.0.1:{WORKER_PORT}",
            "MARKDROP_CORS_ORIGINS": json.dumps(app_origins),
            "MARKDROP_DOCS_CORS_ORIGINS": json.dumps([f"http://docs.localhost:{NEXT_PORT}"]),
        })


os.chdir(HERE)  # pydantic-settings reads ./.env — this folder's, never backend/.env
_load_env()
sys.path.insert(0, str(BACKEND))

from app.config import get_settings  # noqa: E402

settings = get_settings()


def _refuse_non_local() -> None:
    def host(url: str) -> str:
        return (urlsplit(url).hostname or "").lower()

    problems = []
    if host(settings.mongodb_uri) not in LOOPBACK:
        problems.append(f"mongodb_uri {settings.mongodb_uri}")
    if not settings.mongodb_db.startswith("markdrop_docs_demo"):
        problems.append(f"mongodb_db {settings.mongodb_db} (must start with markdrop_docs_demo)")
    for name in ("api_base_url", "frontend_url", "artifact_origin", "r2_endpoint"):
        if host(getattr(settings, name)) not in LOOPBACK:
            problems.append(f"{name} {getattr(settings, name)}")
    if settings.resend_api_key or settings.vercel_api_token or settings.anthropic_api_key:
        problems.append("a real third-party key is set")
    if problems:
        sys.exit("run_api.py: refusing to start, not local-only: " + "; ".join(problems))


_refuse_non_local()

import httpx  # noqa: E402
from bson import ObjectId  # noqa: E402
from fastapi import APIRouter, HTTPException, Request  # noqa: E402

from app import database  # noqa: E402
from app.limiter import limiter  # noqa: E402
from app.main import app  # noqa: E402
from app.services import dns_provider, domain, r2, revalidate  # noqa: E402
from app.utils.auth import create_access_token  # noqa: E402

limiter.enabled = False


# ── Fake R2 (disk-backed) ─────────────────────────────────────────────────────


class FakeR2:
    """services/r2.py, on disk under .data/r2: <sha256(key)>.bin + .json (metadata)."""

    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.uploads: dict[str, dict] = {}
        self.lock = threading.Lock()

    # storage
    def _paths(self, key: str) -> tuple[Path, Path]:
        h = hashlib.sha256(key.encode()).hexdigest()
        return self.root / f"{h}.bin", self.root / f"{h}.json"

    def meta(self, key: str) -> dict | None:
        _, m = self._paths(key)
        try:
            return json.loads(m.read_text())
        except Exception:
            return None

    def write(self, key: str, data: bytes, content_type: str, public: bool = False,
              extra: dict | None = None) -> dict:
        b, m = self._paths(key)
        with self.lock:
            b.write_bytes(data)
            meta = {"key": key, "size": len(data), "content_type": content_type,
                    "etag": hashlib.md5(data).hexdigest(), "public": bool(public), "ae": None,
                    "live": False, **(extra or {})}
            m.write_text(json.dumps(meta))
        return meta

    def _set_meta(self, key: str, **fields) -> bool:
        meta = self.meta(key)
        if meta is None:
            return False
        meta.update(fields)
        self._paths(key)[1].write_text(json.dumps(meta))
        return True

    def read(self, key: str, start: int = 0, end: int | None = None) -> bytes | None:
        b, _ = self._paths(key)
        try:
            with b.open("rb") as f:
                f.seek(start)
                return f.read() if end is None else f.read(end - start + 1)
        except FileNotFoundError:
            return None

    def keys(self) -> list[str]:
        out = []
        for m in self.root.glob("*.json"):
            try:
                out.append(json.loads(m.read_text())["key"])
            except Exception:
                pass
        return out

    # services/r2.py surface
    def is_configured(self) -> bool:
        return True

    def presign_put(self, key, content_type):
        return f"{API}/__fakes3/{quote(key)}?ct={quote(content_type, safe='')}"

    def presign_get(self, key, expires_in=300):
        return f"{API}/__fakes3/{quote(key)}"

    def head(self, key):
        m = self.meta(key)
        if m is None:
            return None
        return {"size": m["size"], "content_type": m["content_type"], "etag": m["etag"],
                "public": bool(m.get("public")), "ae": m.get("ae")}

    def delete(self, key):
        b, m = self._paths(key)
        for p in (b, m):
            try:
                p.unlink()
            except FileNotFoundError:
                pass

    def get_bytes(self, key, max_bytes):
        return self.read(key, 0, max_bytes - 1)

    def put_bytes(self, key, data, content_type, public=True, live=False):
        self.write(key, data, content_type, public=public, extra={"live": bool(live)})
        return True

    def list_prefix(self, prefix, limit=1000):
        return sorted(k for k in self.keys() if k.startswith(prefix))[:limit]

    def delete_prefix(self, prefix):
        keys = self.list_prefix(prefix)
        for k in keys:
            self.delete(k)
        return len(keys)

    def set_public(self, key, public, content_type=None, epoch=None):
        fields: dict = {"public": bool(public)}
        if epoch is not None:
            fields["ae"] = str(int(epoch))
        if content_type:
            fields["content_type"] = content_type
        return self._set_meta(key, **fields)

    def set_public_prefix(self, prefix, public, epoch=None):
        keys = self.list_prefix(prefix)
        for k in keys:
            self.set_public(k, public, None, epoch)
        return len(keys)

    # multipart (the CLI / MCP path; the web upload page uses one PUT)
    def create_multipart(self, key, content_type, public):
        uid = "fake-" + secrets.token_hex(8)
        self.uploads[uid] = {"key": key, "content_type": content_type, "public": public, "parts": {}}
        return uid

    def presign_upload_part(self, key, upload_id, part_number, expires_in):
        return f"{API}/__fakes3/{quote(key)}?uploadId={upload_id}&partNumber={part_number}"

    def put_part(self, upload_id: str, n: int, data: bytes) -> str:
        etag = hashlib.md5(data).hexdigest()
        self.uploads[upload_id]["parts"][n] = (data, etag)
        return etag

    def list_parts(self, key, upload_id):
        up = self.uploads.get(upload_id)
        if up is None:
            raise RuntimeError("NoSuchUpload")
        return [{"part_number": n, "etag": e, "size": len(d)} for n, (d, e) in sorted(up["parts"].items())]

    def complete_multipart(self, key, upload_id, parts):
        up = self.uploads.pop(upload_id, None)
        if up is None:
            raise RuntimeError("NoSuchUpload")
        data = b"".join(up["parts"][int(p["part_number"])][0]
                        for p in sorted(parts, key=lambda p: int(p["part_number"])))
        self.write(key, data, up["content_type"], public=up["public"])

    def abort_multipart(self, key, upload_id):
        self.uploads.pop(upload_id, None)

    def sha256_of(self, key, on_progress=None, chunk_size=8 * 1024 * 1024):
        data = self.read(key) or b""
        if on_progress:
            on_progress(len(data))
        return hashlib.sha256(data).hexdigest(), len(data)


FAKE = FakeR2(R2_DIR)
for _name in ("is_configured", "presign_put", "presign_get", "head", "delete", "get_bytes",
              "put_bytes", "list_prefix", "delete_prefix", "set_public", "set_public_prefix",
              "create_multipart", "presign_upload_part", "list_parts", "complete_multipart",
              "abort_multipart", "sha256_of"):
    setattr(r2, _name, getattr(FAKE, _name))


def _no_boto():
    raise RuntimeError("docs-media sandbox: real R2 is never used")


r2._client = _no_boto  # anything un-patched fails loudly instead of reaching a bucket


# Markdrop Guides' bucket (services/docs_site_assets.py): the folder store the local worker reads and
# publishes to, so an image uploaded in the editor is in the next build.
from app.services import docs_site_assets  # noqa: E402

DOCS_STORE = Path(os.environ["MARKDROP_DOCS_STORE_DIR"]).resolve()


def _docs_file(key: str) -> Path:
    f = (DOCS_STORE / key).resolve()
    if not str(f).startswith(str(DOCS_STORE) + os.sep):
        raise ValueError(f"bad key {key}")
    return f


def _docs_put(key, data, content_type, cache_control=None):
    f = _docs_file(key)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_bytes(data)
    return True


def _docs_list(prefix):
    root = _docs_file(prefix.rstrip("/") + "/_").parent
    if not root.is_dir():
        return []
    return [{"key": f.relative_to(DOCS_STORE).as_posix(), "size": f.stat().st_size}
            for f in sorted(root.rglob("*")) if f.is_file()]


def _docs_get(key):
    f = _docs_file(key)
    return f.read_bytes() if f.is_file() else None


docs_site_assets.is_configured = lambda: True
docs_site_assets.put_bytes = _docs_put
# Settings › Export & self-host reads the guide's files back (services/docs_site_export.py).
docs_site_assets.list_objects = _docs_list
docs_site_assets.get_bytes = _docs_get
docs_site_assets.presign_get = lambda key, expires_in=3600: f"{API}/__docsstore/{quote(key)}"
docs_site_assets._client = _no_boto

# Routing an import reads the source's llms.txt over the internet: never here. The demo's imports
# are played by seed_extra_studio.py --import-run (the worker doesn't take imports, see
# run_docs_worker.py), so the source is never fetched.
# ── The editor's AI help: a stand-in model ────────────────────────────────────
# The sandbox never has a key (see _refuse_non_local). The editor's Ask AI (improve, shorten, fix,
# translate a selection) talks to this instead, deterministically, so captures and browser checks
# can show a suggestion. Only the editor's module sees it: the readers' Ask AI stays "not set up".
# DOCS_MEDIA_FAKE_AI=0 turns it off.
if os.environ.get("DOCS_MEDIA_FAKE_AI", "1") != "0":
    import re as _re
    from types import SimpleNamespace as _NS

    from app.services import docs_agent as _docs_agent  # noqa: E402
    from app.services import docs_editor_ai as _editor_ai  # noqa: E402

    _FILLER = [(r"\bin order to\b", "to"), (r"\bis able to\b", "can"), (r"\bmake sure\b", "check"), (r"\bjust\b ", ""),
               (r"\breally\b ", ""), (r"\bvery\b ", ""), (r"\bbasically,? ", ""), (r"\bsimply\b ", ""), (r"\bplease\b ", "")]
    _TYPOS = {"teh": "the", "recieve": "receive", "adress": "address", "seperate": "separate", "occured": "occurred",
              "untill": "until", "wich": "which", "acount": "account", "definately": "definitely", "succesful": "successful"}
    _ES = {"create": "crea", "an": "una", "account": "cuenta", "in": "en", "under": "menos de", "a": "un", "minute": "minuto",
           "you": "puedes", "can": "", "place": "hacer", "your": "tu", "first": "primer", "order": "pedido", "right": "",
           "away": "ahora mismo", "the": "el", "and": "y", "to": "para", "is": "es", "saved": "guardado", "before": "antes de",
           "sign": "iniciar", "basket": "carrito", "even": "incluso", "with": "con", "of": "de", "for": "para", "page": "página"}

    def _fake_rewrite(action: str, text: str, language: str | None) -> str:
        if action == "shorten":
            paras = [p.strip() for p in text.split("\n\n")]
            out = []
            for p in paras:
                m = _re.match(r"(.+?[.!?])(\s|$)", p, _re.S)
                out.append(m.group(1) if m and not p.lstrip().startswith(("-", "*", "#", "1.", ":::", "|", "```")) else p)
            return "\n\n".join(out)
        if action == "fix":
            return _re.sub(r"[A-Za-z]+", lambda m: _TYPOS.get(m.group(0).lower(), m.group(0)), text)
        if action == "translate":
            if (language or "").lower().startswith("spanish"):
                words = _re.sub(r"[A-Za-z]+", lambda m: _ES.get(m.group(0).lower(), m.group(0)), text)
                return _re.sub(r"  +", " ", words).strip()
            return f"{text}\n\n({language})"
        out = text
        for pat, rep in _FILLER:
            out = _re.sub(pat, rep, out, flags=_re.I)
        out = _re.sub(r"\bYou can\b", "You can", out)
        return out if out != text else _re.sub(r"\s+", " ", text).strip().rstrip(".") + ", in a few steps."

    class _FakeMessages:
        async def create(self, **params):
            turn = params["messages"][-1]["content"][0]["text"]
            m = _re.search(r"<passage>\n(.*)\n</passage>", turn, _re.S)
            text = m.group(1) if m else ""
            first = turn.split(None, 1)[0].lower()
            action = {"improve": "improve", "shorten": "shorten", "fix": "fix", "translate": "translate"}.get(first, "improve")
            lang = _re.search(r"into (.+?)\.", turn)
            await asyncio.sleep(0.6)  # long enough to see the "Writing…" state
            out = _fake_rewrite(action, text, lang.group(1) if lang else None)
            return _NS(content=[_NS(type="text", text=out)], stop_reason="end_turn",
                       usage={"input_tokens": 400 + len(text) // 4, "output_tokens": len(out) // 4 + 5})

    _fake_client = _NS(messages=_FakeMessages())
    _editor_ai.docs_agent = _NS(enabled=_docs_agent.enabled, configured=lambda: True, get_client=lambda: _fake_client)

from app.services import docs_dispatch  # noqa: E402


async def _no_probe(url, *, client=None):
    return 5


docs_dispatch.probe_import_pages = _no_probe


async def _no_revalidate(payload):
    return 200


revalidate._post = _no_revalidate


# Mail: "configured" (so invitations and share notifications work as in production), but every
# message is appended to .data/outbox.jsonl instead of being sent.
from app.services import mailer  # noqa: E402

OUTBOX = DATA / "outbox.jsonl"


async def _outbox(payload: dict) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    with OUTBOX.open("a") as f:
        f.write(json.dumps({"at": datetime.now(timezone.utc).isoformat(), **payload}, default=str) + "\n")


mailer.is_configured = lambda: True
mailer._post = _outbox


# ── Fake DNS ──────────────────────────────────────────────────────────────────


def _dns() -> dict:
    try:
        return json.loads(DNS_FILE.read_text())
    except Exception:
        return {}


def _save_dns(state: dict) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    DNS_FILE.write_text(json.dumps(state, indent=2))


def fake_check_txt(host: str, token: str):
    rec = _dns().get(host) or {}
    values = rec.get("txt") or []
    if not values:
        return "missing", f"There is no TXT record at {domain.TXT_PREFIX}.{host}."
    if token in values:
        return "ok", None
    return "missing", (f"Found {len(values)} TXT record(s) at {domain.TXT_PREFIX}.{host}, "
                       "but none matched the expected value.")


def fake_check_routing(host: str):
    target = settings.custom_domain_cname_target.rstrip(".").lower()
    rec = _dns().get(host) or {}
    if rec.get("cname") == target or (rec.get("a") and settings.custom_domain_apex_ip in rec["a"]):
        return "ok", None
    return "missing", f"{host} has no CNAME or A record pointing at {target}."


def fake_nameservers(host: str) -> list[str]:
    zone = dns_provider.zone_of(host)
    if zone.startswith("acme."):
        return ["ada.ns.cloudflare.com.", "rob.ns.cloudflare.com."]
    return []


domain.check_txt = fake_check_txt
domain.check_routing = fake_check_routing
dns_provider.nameservers_for = fake_nameservers
# The zone and a name's CNAME as DNS has them: from the same file (no real DNS lookups).
dns_provider.zone_for = lambda host: dns_provider.zone_of(host)


def fake_cname_of(host: str) -> str | None:
    return str((_dns().get(host) or {}).get("cname") or "").rstrip(".").lower()


dns_provider.cname_of = fake_cname_of

# Markdrop Guides' own domains: switched on (Settings › Domains › Add a domain works) against a fake
# Cloudflare that only ever says "pending". The API only queues the domain job and the stack's worker
# never takes it: the domain shots set a domain's state directly (seed_extra_studio.py --guide-domain).
from app.services import docs_custom_domains, domain_connect  # noqa: E402


def _fake_cloudflare(request: httpx.Request) -> httpx.Response:
    if request.method == "GET":
        return httpx.Response(200, json={"success": True, "result": []})
    host = (json.loads(request.content or b"{}") or {}).get("hostname") or ""
    return httpx.Response(200, json={"success": True, "result": {
        "id": hashlib.sha1(host.encode()).hexdigest()[:32], "hostname": host, "status": "pending",
        "ssl": {"status": "pending_validation"}}})


docs_custom_domains._TRANSPORT = httpx.MockTransport(_fake_cloudflare)
domain_connect._TXT = lambda name: []  # no Domain Connect discovery: no one-click link


# Markdrop Guides ↔ GitHub: a fake GitHub (fake_gh.py) with the app set up and fictional acme
# repositories. Imports run on this stack's worker, which downloads the tarball from this API.
sys.path.insert(0, str(HERE))
import fake_gh  # noqa: E402

fake_gh.install(settings, API, DATA)
app.include_router(fake_gh.router)


# ── Sandbox routes ────────────────────────────────────────────────────────────

sandbox = APIRouter(prefix="/__sandbox", include_in_schema=False)


def _db():
    return database.get_database()


def _guard(request: Request) -> None:
    if (request.client.host if request.client else "") not in LOOPBACK:
        raise HTTPException(status_code=404)


@sandbox.get("/health")
async def health():
    await _db().command("ping")
    return {"ok": True, "db": settings.mongodb_db, "objects": len(FAKE.keys())}


@sandbox.post("/user")
async def make_user(request: Request, body: dict):
    _guard(request)
    email = (body.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(status_code=422, detail="email")
    now = datetime.now(timezone.utc)
    await _db()["users"].update_one(
        {"email": email},
        {"$setOnInsert": {"email": email, "created_at": now, "providers": ["email"]},
         "$set": {"name": body.get("name"), "updated_at": now,
                  **({"picture": body["picture"]} if body.get("picture") else {})}},
        upsert=True,
    )
    raw = await _db()["users"].find_one({"email": email})
    token, _ = create_access_token(str(raw["_id"]), email)
    return {"id": str(raw["_id"]), "email": email, "name": raw.get("name"), "token": token}


@sandbox.post("/mint")
async def mint(request: Request, body: dict):
    _guard(request)
    q = {"_id": ObjectId(body["user_id"])} if body.get("user_id") else {"email": (body.get("email") or "").lower()}
    raw = await _db()["users"].find_one(q)
    if raw is None:
        raise HTTPException(status_code=404, detail="no such user")
    token, exp = create_access_token(str(raw["_id"]), raw["email"])
    return {"token": token, "user_id": str(raw["_id"]), "email": raw["email"], "expires_at": exp}


@sandbox.post("/domain")
async def seed_domain(request: Request, body: dict):
    """A verified, attached (live) domain row, and its DNS published in the fake resolver."""
    _guard(request)
    ws_id, host = body["workspace_id"], domain.normalize_host(body["host"])
    now = datetime.now(timezone.utc)
    token = f"markdrop-verify={secrets.token_urlsafe(24)}"
    await _db()["domains"].delete_many({"host": host})
    if body.get("pending"):
        # Added, DNS not published yet ("Awaiting DNS").
        row = {"host": host, "workspace_id": ws_id, "kind": body.get("kind", "app"), "status": "pending",
               "verification_token": token, "created_at": now, "attached": False,
               "expires_at": now + timedelta(days=settings.domain_pending_ttl_days)}
        res = await _db()["domains"].insert_one(row)
        state = _dns()
        state.pop(host, None)
        _save_dns(state)
        return {"id": str(res.inserted_id), "host": host}
    row = {
        "host": host, "workspace_id": ws_id, "kind": body.get("kind", "app"), "status": "verified",
        "verification_token": token, "created_at": now, "verified_at": now, "last_checked_at": now,
        "attached": True, "attached_via": "dns", "is_primary": bool(body.get("primary", True)),
        "txt_ok": True, "routing_ok": True, "failures": 0, "first_failed_at": None, "last_error": None,
    }
    res = await _db()["domains"].insert_one(row)
    state = _dns()
    state[host] = {"txt": [token], "cname": settings.custom_domain_cname_target}
    _save_dns(state)
    return {"id": str(res.inserted_id), "host": host}


@sandbox.post("/dns")
async def set_dns(request: Request, body: dict):
    """Publish (or withdraw) the TXT + CNAME a domain row asks for, as if the owner edited DNS."""
    _guard(request)
    host = domain.clean_host(body["host"])
    state = _dns()
    if body.get("publish", True):
        rows = await _db()["domains"].find({"host": host}).to_list(length=50)
        state[host] = {"txt": [r["verification_token"] for r in rows],
                       "cname": settings.custom_domain_cname_target}
    else:
        state.pop(host, None)
    _save_dns(state)
    return {"host": host, "records": state.get(host)}


@sandbox.post("/domains/reset")
async def reset_domains(request: Request, body: dict):
    _guard(request)
    keep = [domain.clean_host(h) for h in body.get("keep") or []]
    q = {"workspace_id": body["workspace_id"], "host": {"$nin": keep}}
    gone = [r["host"] for r in await _db()["domains"].find(q, {"host": 1}).to_list(length=100)]
    await _db()["domains"].delete_many(q)
    state = _dns()
    for h in gone:
        state.pop(h, None)
    _save_dns(state)
    return {"removed": gone}


@sandbox.post("/cleanup")
async def cleanup(request: Request, body: dict | None = None):
    """Delete documents a capture created (anything without the seed's marker)."""
    _guard(request)
    db = _db()
    victims = await db["documents"].find({"demo_seed": {"$ne": True}}, {"_id": 1, "blob_key": 1}).to_list(length=1000)
    for v in victims:
        if v.get("blob_key"):
            FAKE.delete(v["blob_key"])
    ids = [v["_id"] for v in victims]
    if ids:
        await db["documents"].delete_many({"_id": {"$in": ids}})
        sids = [str(i) for i in ids]
        for coll in ("events", "engage_sessions", "file_versions", "access_requests"):
            await db[coll].delete_many({"doc_id": {"$in": sids}})
        await db["document_grants"].delete_many({"document_id": {"$in": sids}})
    return {"deleted": len(ids)}


@sandbox.get("/head/{key:path}")
async def head_object(request: Request, key: str):
    _guard(request)
    meta = FAKE.meta(unquote(key))
    if meta is None:
        raise HTTPException(status_code=404)
    return meta


@app.get("/__docsstore/{key:path}", include_in_schema=False)
async def docs_store_file(request: Request, key: str):
    """A file of the Markdrop Guides folder store (what presign_get points at)."""
    _guard(request)
    import mimetypes

    from fastapi.responses import Response

    try:
        f = _docs_file(unquote(key))
    except ValueError:
        raise HTTPException(status_code=404)
    if not f.is_file():
        raise HTTPException(status_code=404)
    ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
    return Response(f.read_bytes(), media_type=ctype, headers={"Cache-Control": "no-store"})


app.include_router(sandbox)


# ── /__fakes3: the bytes, outside every app middleware ───────────────────────


def _parse_range(header: str | None, size: int):
    if not header or not header.startswith("bytes="):
        return None
    spec = header[6:].split(",")[0].strip()
    a, _, b = spec.partition("-")
    try:
        if a == "":
            n = int(b)
            return max(0, size - n), size - 1
        start = int(a)
        end = int(b) if b else size - 1
        return start, min(end, size - 1)
    except ValueError:
        return None


class FakeS3:
    """ASGI wrapper: /__fakes3/<key> handled here (permissive CORS, ETag exposed),
    everything else goes to the real app."""

    CORS = [(b"access-control-allow-origin", b"*"),
            (b"access-control-allow-methods", b"GET, HEAD, PUT, OPTIONS"),
            (b"access-control-allow-headers", b"*"),
            (b"access-control-expose-headers", b"ETag, Content-Range, Content-Length")]

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/__fakes3/"):
            return await self.inner(scope, receive, send)
        client = (scope.get("client") or ("", 0))[0]
        if client not in LOOPBACK:
            return await self._reply(send, 404, b"")
        key = unquote(scope["path"][len("/__fakes3/"):])
        method = scope["method"]
        headers = {k.decode().lower(): v.decode() for k, v in scope["headers"]}
        qs = dict(p.split("=", 1) if "=" in p else (p, "") for p in scope["query_string"].decode().split("&") if p)
        if method == "OPTIONS":
            return await self._reply(send, 204, b"")
        if method == "PUT":
            body = bytearray()
            while True:
                msg = await receive()
                body.extend(msg.get("body", b""))
                if not msg.get("more_body"):
                    break
            if "uploadId" in qs:
                etag = FAKE.put_part(qs["uploadId"], int(qs["partNumber"]), bytes(body))
                return await self._reply(send, 200, b"", [(b"etag", f'"{etag}"'.encode())])
            bound = unquote(qs.get("ct", ""))
            ctype = headers.get("content-type", "application/octet-stream")
            if bound and ctype != bound:  # like a presigned PUT whose signature binds Content-Type
                return await self._reply(send, 403, b"SignatureDoesNotMatch")
            meta = FAKE.write(key, bytes(body), ctype, public=False)
            return await self._reply(send, 200, b"", [(b"etag", f'"{meta["etag"]}"'.encode())])
        if method in ("GET", "HEAD"):
            meta = FAKE.meta(key)
            if meta is None:
                return await self._reply(send, 404, b"NoSuchKey")
            size = meta["size"]
            extra = [(b"content-type", meta["content_type"].encode()), (b"accept-ranges", b"bytes"),
                     (b"etag", f'"{meta["etag"]}"'.encode())]
            rng = _parse_range(headers.get("range"), size)
            if rng and rng[0] <= rng[1]:
                start, end = rng
                data = b"" if method == "HEAD" else await asyncio.to_thread(FAKE.read, key, start, end)
                extra.append((b"content-range", f"bytes {start}-{end}/{size}".encode()))
                return await self._reply(send, 206, data, extra, length=end - start + 1)
            data = b"" if method == "HEAD" else await asyncio.to_thread(FAKE.read, key)
            return await self._reply(send, 200, data or b"", extra, length=size)
        return await self._reply(send, 405, b"")

    async def _reply(self, send, status, body, headers=None, length=None):
        hdrs = list(self.CORS) + list(headers or [])
        hdrs.append((b"content-length", str(len(body) if length is None else length).encode()))
        await send({"type": "http.response.start", "status": status, "headers": hdrs})
        await send({"type": "http.response.body", "body": body})


asgi = FakeS3(app)

if __name__ == "__main__":
    import uvicorn

    print(f"[docs-media] stack {STACK_ID}: sandbox API on {API} — db {settings.mongodb_db} @ {settings.mongodb_uri}; "
          f"fake R2 {R2_DIR}")
    uvicorn.run(asgi, host="127.0.0.1", port=PORT, log_level=os.environ.get("DOCS_MEDIA_LOG", "warning"))
