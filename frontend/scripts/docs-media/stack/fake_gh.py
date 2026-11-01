"""A stand-in for GitHub in the docs media stack: the "Markdrop Guides" app, its installation on a
fictional "acme" organisation, and two fictional repositories (acme/docs, public; acme/handbook,
private), served from repo-demo/acme-docs. Nothing here talks to the real GitHub.

- In both the sandbox API (run_api.py) and the Guides worker (run_docs_worker.py),
  :func:`install` gives the app fake credentials and swaps GitHub's transport
  (services/docs_github_app.TRANSPORT) for :func:`handler`, so the API's calls (repositories,
  branches, the tree, files, installation tokens, the OAuth exchange) are answered here.
- The sandbox API also serves (:data:`router`):
    GET  /__fakegh/codeload/<owner>/<name>/tar.gz/<ref>     the repository as GitHub's tarball
         (the import runner downloads it: MARKDROP_DOCS_GITHUB_CODELOAD points here)
    GET  /__fakegh/web/apps/<slug>/installations/new?state=  "install": straight back to the app's
         /guides/github/installed with a code and the installation id (no fake GitHub page)
    GET  /__fakegh/web/login/oauth/authorize?state=&redirect_uri=   the same for "link an installation"
    POST /__sandbox/gh/push {repo?, files: {path: text | null}, message?}   change files, then deliver
         a signed push webhook to this API (a sync, as GitHub would start it)
    POST /__sandbox/gh/reset {}     back to the demo repository as committed

The repository state (files changed by pushes) is a JSON file in the stack's data folder, shared by
the two processes.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import tarfile
import time
from pathlib import Path
from urllib.parse import urlencode

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse, Response

HERE = Path(__file__).resolve().parent
DEMO = HERE.parent / "repo-demo" / "acme-docs"
APP_ID = "424242"
INSTALLATION = 4242
SLUG = "markdrop-guides"
REPOS = {
    "acme/docs": {"id": 9001, "private": False, "description": "Acme's product docs (MDX)."},
    "acme/handbook": {"id": 9002, "private": True, "description": "The Acme team handbook."},
}
_cfg: dict = {}


def _state_file() -> Path:
    return Path(_cfg["data"]) / "fake-gh.json"


def _state() -> dict:
    try:
        return json.loads(_state_file().read_text())
    except Exception:
        return {"overlay": {}, "pushes": 0}


def _save(state: dict) -> None:
    _state_file().write_text(json.dumps(state))


def files(repo: str) -> dict[str, bytes]:
    out: dict[str, bytes] = {}
    if repo == "acme/docs":
        for f in sorted(DEMO.rglob("*")):
            if f.is_file() and not f.name.startswith("."):
                out[f.relative_to(DEMO).as_posix()] = f.read_bytes()
        for path, b64 in (_state().get("overlay") or {}).items():
            if b64 is None:
                out.pop(path, None)
            else:
                out[path] = base64.b64decode(b64)
    elif repo == "acme/handbook":
        out["README.md"] = b"# Acme handbook\n\nHow the Acme team works.\n"
        out["handbook/index.md"] = b"---\ntitle: Welcome\n---\n\nHow we work at Acme.\n"
        out["handbook/time-off.md"] = b"---\ntitle: Time off\n---\n\nTake the time you need. Tell your team a week ahead.\n"
    return out


def commit(repo: str) -> str:
    h = hashlib.sha1()
    for path, data in sorted(files(repo).items()):
        h.update(path.encode() + b"\0" + hashlib.sha1(data).digest())
    return h.hexdigest()


def tarball(repo: str) -> bytes:
    sha = commit(repo)
    prefix = f"{repo.replace('/', '-')}-{sha[:7]}"
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", format=tarfile.PAX_FORMAT, pax_headers={"comment": sha}) as tar:
        for path, data in sorted(files(repo).items()):
            info = tarfile.TarInfo(f"{prefix}/{path}")
            info.size = len(data)
            info.mtime = 1_700_000_000
            info.mode = 0o644
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def _repo_json(full: str) -> dict:
    owner, name = full.split("/")
    meta = REPOS[full]
    return {"id": meta["id"], "name": name, "full_name": full, "owner": {"login": owner}, "private": meta["private"],
            "default_branch": "main", "description": meta["description"], "pushed_at": "2026-11-01T09:30:00Z"}


def _installation() -> dict:
    return {"id": INSTALLATION, "app_id": int(APP_ID), "app_slug": SLUG, "repository_selection": "selected",
            "account": {"login": "acme", "type": "Organization", "id": 77,
                        "avatar_url": None}, "suspended_at": None}


def handler(request: httpx.Request) -> httpx.Response:
    """GitHub's API, web OAuth exchange and raw files, for the fictional acme repositories."""
    from app.services import docs_github_app as gh

    u = request.url
    path = u.path
    authed = (request.headers.get("authorization") or "").startswith("token ghs_sandbox")
    if path.endswith("/login/oauth/access_token"):
        return httpx.Response(200, json={"access_token": "gho_sandbox", "token_type": "bearer"})
    if path.startswith("/applications/"):
        return httpx.Response(204)
    if path == "/user/installations":
        return httpx.Response(200, json={"total_count": 1, "installations": [_installation()]})
    if path == f"/app/installations/{INSTALLATION}/access_tokens":
        return httpx.Response(201, json={"token": "ghs_sandbox", "expires_at": "2099-01-01T00:00:00Z"})
    if path == f"/app/installations/{INSTALLATION}":
        return httpx.Response(200, json=_installation())
    if path == "/installation/repositories":
        return httpx.Response(200, json={"total_count": len(REPOS), "repositories": [_repo_json(r) for r in REPOS]})
    parts = path.strip("/").split("/")
    if u.host == "raw.githubusercontent.com" and len(parts) >= 4:
        full = f"{parts[0]}/{parts[1]}"
        f = "/".join(parts[3:])
        data = files(full).get(f) if full in REPOS and not REPOS[full]["private"] else None
        return httpx.Response(200, content=data) if data is not None else httpx.Response(404, text="404: Not Found")
    if parts[0] == "repos" and len(parts) >= 3:
        full = f"{parts[1]}/{parts[2]}".lower()
        if full not in REPOS or (REPOS[full]["private"] and not authed):
            return httpx.Response(404, json={"message": "Not Found"})
        rest = parts[3:]
        if not rest:
            return httpx.Response(200, json=_repo_json(full))
        if rest == ["branches"]:
            return httpx.Response(200, json=[{"name": "main"}, {"name": "next"}])
        if rest[0] == "commits":
            if rest[1] not in ("main", "next"):
                return httpx.Response(404, json={"message": "No commit found for SHA"})
            return httpx.Response(200, text=commit(full))
        if rest[:2] == ["git", "trees"]:
            return httpx.Response(200, json={"sha": commit(full), "truncated": False,
                                             "tree": [{"path": p, "type": "blob"} for p in files(full)]})
        if rest[0] == "contents":
            data = files(full).get("/".join(rest[1:]))
            return httpx.Response(200, content=data) if data is not None else httpx.Response(404, json={"message": "Not Found"})
        if rest[0] == "tarball":
            return httpx.Response(302, headers={"location": f"{gh.CODELOAD_HOST}/{full}/legacy.tar.gz/{rest[1]}?token=sandbox"})
    return httpx.Response(404, json={"message": f"fake GitHub: no {request.method} {path}"})


def install(settings, api_base: str, data_dir: Path) -> None:
    """Fake app credentials and transport, in this process."""
    from app.services import docs_github_app as gh

    _cfg.update({"api": api_base.rstrip("/"), "data": str(data_dir)})
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    settings.docs_github_app_id = APP_ID
    settings.docs_github_app_slug = SLUG
    settings.docs_github_app_private_key = key
    settings.docs_github_webhook_secret = "sandbox-webhook-secret-0123456789"
    settings.docs_github_client_id = "Iv23liSandbox"
    settings.docs_github_client_secret = "sandbox-client-secret"
    settings.docs_github_api = "https://api.github.com"
    settings.docs_github_web = f"{_cfg['api']}/__fakegh/web"
    gh.TRANSPORT = httpx.MockTransport(handler)
    gh.CODELOAD_HOST = f"{_cfg['api']}/__fakegh/codeload"


router = APIRouter(include_in_schema=False)


@router.get("/__fakegh/codeload/{owner}/{name}/{kind}/{ref:path}")
async def codeload(owner: str, name: str, kind: str, ref: str):
    full = f"{owner}/{name}".lower()
    if full not in REPOS or kind not in ("tar.gz", "legacy.tar.gz"):
        raise HTTPException(status_code=404)
    return Response(tarball(full), media_type="application/x-gzip")


@router.get("/__fakegh/web/apps/{slug}/installations/new")
async def install_page(request: Request, slug: str, state: str = ""):
    from app.config import get_settings

    back = f"{get_settings().frontend_url.rstrip('/')}/guides/github/installed"
    q = urlencode({"code": "sandbox-code", "installation_id": INSTALLATION, "setup_action": "install", "state": state})
    return RedirectResponse(f"{back}?{q}", status_code=302)


@router.get("/__fakegh/web/login/oauth/authorize")
async def authorize_page(request: Request, state: str = "", redirect_uri: str = ""):
    if not redirect_uri.startswith(("http://localhost:", "http://127.0.0.1:")):
        raise HTTPException(status_code=400)
    return RedirectResponse(f"{redirect_uri}?{urlencode({'code': 'sandbox-code', 'state': state})}", status_code=302)


@router.post("/__sandbox/gh/reset")
async def reset(request: Request):
    _save({"overlay": {}, "pushes": 0})
    return {"ok": True, "sha": commit("acme/docs")}


@router.post("/__sandbox/gh/push")
async def push(request: Request, body: dict):
    """Change files in acme/docs and deliver GitHub's push webhook (signed) to this API."""
    from app.config import get_settings

    if (request.client.host if request.client else "") not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(status_code=404)
    before = commit("acme/docs")
    state = _state()
    changed: dict[str, list[str]] = {"added": [], "modified": [], "removed": []}
    current = files("acme/docs")
    for path, text in (body.get("files") or {}).items():
        if text is None:
            state["overlay"][path] = None
            changed["removed"].append(path)
        else:
            state["overlay"][path] = base64.b64encode(str(text).encode()).decode()
            changed["modified" if path in current else "added"].append(path)
    state["pushes"] = int(state.get("pushes") or 0) + 1
    _save(state)
    after = commit("acme/docs")
    payload = {
        "ref": f"refs/heads/{body.get('branch') or 'main'}", "before": before, "after": after, "forced": False,
        "repository": {"id": REPOS["acme/docs"]["id"], "full_name": "acme/docs"},
        "installation": {"id": INSTALLATION}, "pusher": {"name": body.get("pusher") or "ada"},
        "sender": {"login": body.get("pusher") or "ada"},
        "commits": [{"id": after, "message": body.get("message") or "Update docs", **changed}],
        "head_commit": {"id": after, "message": body.get("message") or "Update docs", **changed},
    }
    raw = json.dumps(payload).encode()
    sig = "sha256=" + hmac.new(get_settings().docs_github_webhook_secret.encode(), raw, hashlib.sha256).hexdigest()
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(f"{_cfg['api']}/api/v1/github/webhook", content=raw, headers={
            "content-type": "application/json", "x-github-event": "push", "x-github-delivery": f"sandbox-{time.time_ns()}",
            "x-hub-signature-256": sig})
    return {"ok": r.status_code == 200, "sha": after, "webhook": r.json()}


__all__ = ["install", "router", "handler", "files", "commit", "tarball"]
