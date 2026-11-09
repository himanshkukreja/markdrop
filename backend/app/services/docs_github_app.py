"""Markdrop Guides ↔ GitHub: the "Markdrop Guides" GitHub App and GitHub's REST API.

Two ways in:

- **The app** (MARKDROP_DOCS_GITHUB_*; docs-platform/setup-github-app.md): read-only Contents +
  Metadata on the repositories someone installs it on, and a webhook (push, installation,
  installation_repositories). The app authenticates as itself with a short-lived RS256 JWT
  (:func:`app_jwt`) and reads a repository with an installation token (:func:`installation_token`,
  one hour, cached until five minutes before it expires).
- **Public repositories without the app**: unauthenticated calls (GitHub allows 60 an hour per
  address, so the answers are cached briefly) and files from raw.githubusercontent.com /
  codeload.github.com, which aren't counted against that limit.

Who may use an installation is never taken from a query string: the install (or "link an
installation") round trip ends with a GitHub OAuth code, exchanged here for a user token that is
used once, to list the installations that GitHub user can reach (:func:`user_installations`).
The ``state`` that goes out and comes back is signed and bound to the Markdrop user
(:func:`sign_state` / :func:`verify_state`).

Webhook deliveries are checked with X-Hub-Signature-256 (:func:`verify_signature`, constant time).

Every request goes to the configured GitHub hosts only (``docs_github_api``, ``docs_github_web``,
raw.githubusercontent.com); nothing here takes a URL from a user. Tests swap the transport
(:data:`TRANSPORT`) for an httpx.MockTransport.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import time
from typing import Any
from urllib.parse import quote, urlencode

import httpx
import jwt

from app.config import get_settings
from app.utils.http import shared_ssl

log = logging.getLogger("markdrop.docs_github")

APP_NAME = "Markdrop Guides"
RAW_HOST = "https://raw.githubusercontent.com"
CODELOAD_HOST = "https://codeload.github.com"
USER_AGENT = "markdrop-guides"
TIMEOUT = 20.0
STATE_TTL = 30 * 60
TOKEN_SLACK = 5 * 60  # renew an installation token this long before it expires
PUBLIC_CACHE_TTL = 120.0
TREE_CACHE_TTL = 600.0
MAX_TREE_PATHS = 20_000

# Tests replace this with an httpx.MockTransport (no network).
TRANSPORT: httpx.AsyncBaseTransport | None = None

_tokens: dict[int, tuple[str, float]] = {}
_cache: dict[str, tuple[float, Any]] = {}
_token_lock = asyncio.Lock()


class GitHubError(Exception):
    """A GitHub call that didn't work. ``status`` is what the API answers its own caller."""

    def __init__(self, status: int, message: str, *, retry_after: int | None = None, upstream: int | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.retry_after = retry_after
        self.upstream = upstream


# ── Settings ──────────────────────────────────────────────────────────────────


def _s():
    return get_settings()


def configured() -> bool:
    """The app is set up: every one of its six settings is present."""
    s = _s()
    return all((s.docs_github_app_id, s.docs_github_app_slug, s.docs_github_app_private_key,
                s.docs_github_webhook_secret, s.docs_github_client_id, s.docs_github_client_secret))


def app_view() -> dict:
    s = _s()
    return {"configured": configured(), "slug": s.docs_github_app_slug or None, "name": APP_NAME}


def api_base() -> str:
    return _s().docs_github_api.rstrip("/")


def web_base() -> str:
    return _s().docs_github_web.rstrip("/")


def private_key() -> str:
    """The app's PEM, with a one-line value's literal "\\n" escapes turned back into newlines."""
    key = (_s().docs_github_app_private_key or "").strip().strip('"').strip("'")
    if "\\n" in key and "\n" not in key:
        key = key.replace("\\n", "\n")
    return key


def app_jwt(at: float | None = None) -> str:
    """The app's own credential: an RS256 JWT, issued 60 s in the past (clock drift), valid 9 minutes."""
    t = int(at if at is not None else time.time())
    payload = {"iat": t - 60, "exp": t + 9 * 60, "iss": str(_s().docs_github_app_id)}
    return jwt.encode(payload, private_key(), algorithm="RS256")


# ── State (install / authorize round trip) ────────────────────────────────────


def _state_key() -> bytes:
    s = _s()
    return hmac.new(s.auth_secret.encode(), b"markdrop-guides-github-state|" + s.docs_github_client_secret.encode(),
                    hashlib.sha256).digest()


def sign_state(user_id: str, workspace_id: str | None, return_to: str, *, at: float | None = None) -> str:
    body = {"u": user_id, "w": workspace_id or None, "r": return_to, "e": int((at or time.time()) + STATE_TTL),
            "n": base64.urlsafe_b64encode(hashlib.sha256(f"{user_id}{time.time_ns()}".encode()).digest()[:9]).decode()}
    raw = base64.urlsafe_b64encode(json.dumps(body, separators=(",", ":")).encode()).decode().rstrip("=")
    sig = base64.urlsafe_b64encode(hmac.new(_state_key(), raw.encode(), hashlib.sha256).digest()).decode().rstrip("=")
    return f"{raw}.{sig}"


def verify_state(state: str, user_id: str, *, at: float | None = None) -> dict | None:
    """The state's {workspace_id, return_to} when it is ours, unexpired and was made for this user."""
    if not isinstance(state, str) or state.count(".") != 1 or len(state) > 2000:
        return None
    raw, sig = state.split(".")
    want = base64.urlsafe_b64encode(hmac.new(_state_key(), raw.encode(), hashlib.sha256).digest()).decode().rstrip("=")
    if not hmac.compare_digest(sig, want):
        return None
    try:
        body = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
    except ValueError:
        return None
    if not isinstance(body, dict) or body.get("u") != user_id or int(body.get("e") or 0) < (at or time.time()):
        return None
    return {"workspace_id": body.get("w") or None, "return_to": body.get("r") or "/guides"}


def install_url(state: str) -> str:
    return f"{web_base()}/apps/{quote(_s().docs_github_app_slug)}/installations/new?{urlencode({'state': state})}"


def authorize_url(state: str, redirect_uri: str) -> str:
    q = {"client_id": _s().docs_github_client_id, "state": state, "redirect_uri": redirect_uri, "allow_signup": "false"}
    return f"{web_base()}/login/oauth/authorize?{urlencode(q)}"


def verify_signature(body: bytes, header: str | None) -> bool:
    """X-Hub-Signature-256 (``sha256=<hex HMAC of the raw body>``), compared in constant time."""
    secret = _s().docs_github_webhook_secret
    if not secret or not header or not header.startswith("sha256="):
        return False
    want = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(header.strip().encode(), want.encode())


# ── HTTP ──────────────────────────────────────────────────────────────────────


def _client(**kw) -> httpx.AsyncClient:
    return httpx.AsyncClient(verify=shared_ssl(), timeout=TIMEOUT, transport=TRANSPORT, headers={"user-agent": USER_AGENT}, **kw)


def _headers(auth: str | None) -> dict:
    h = {"accept": "application/vnd.github+json", "x-github-api-version": "2022-11-28"}
    if auth:
        h["authorization"] = auth
    return h


def _rate_limited(r: httpx.Response) -> GitHubError | None:
    if r.status_code not in (403, 429):
        return None
    remaining = r.headers.get("x-ratelimit-remaining")
    retry = r.headers.get("retry-after")
    if r.status_code == 429 or remaining == "0" or retry:
        wait = None
        if retry and retry.isdigit():
            wait = int(retry)
        elif r.headers.get("x-ratelimit-reset", "").isdigit():
            wait = max(1, int(r.headers["x-ratelimit-reset"]) - int(time.time()))
        return GitHubError(429, "GitHub's limit for reading repositories is reached for now. "
                                "Try again in a few minutes, or connect GitHub to read through the app.",
                           retry_after=wait, upstream=r.status_code)
    return None


async def _call(method: str, url: str, *, auth: str | None = None, params: dict | None = None,
                json_body: dict | None = None, accept: str | None = None, follow: bool = True,
                not_found: str = "Not found on GitHub.") -> httpx.Response:
    headers = _headers(auth)
    if accept:
        headers["accept"] = accept
    try:
        async with _client(follow_redirects=follow) as c:
            r = await c.request(method, url, params=params, json=json_body, headers=headers)
    except httpx.HTTPError as e:
        raise GitHubError(502, f"GitHub didn't answer ({type(e).__name__}). Try again.") from None
    limited = _rate_limited(r)
    if limited:
        raise limited
    if r.status_code == 404:
        raise GitHubError(404, not_found, upstream=404)
    if r.status_code in (401, 403):
        raise GitHubError(403, "GitHub refused the request: the app may not have access to this repository.",
                          upstream=r.status_code)
    if r.status_code >= 500:
        raise GitHubError(502, f"GitHub had a problem (HTTP {r.status_code}). Try again.", upstream=r.status_code)
    return r


def _cached(key: str, ttl: float) -> Any:
    hit = _cache.get(key)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    if hit:
        _cache.pop(key, None)
    return None


def _store(key: str, value: Any, ttl: float) -> Any:
    if len(_cache) > 2000:
        _cache.clear()
    _cache[key] = (time.monotonic() + ttl, value)
    return value


def clear_caches() -> None:
    _tokens.clear()
    _cache.clear()


# ── The app's credentials ─────────────────────────────────────────────────────


async def installation_token(installation_id: int) -> str:
    """An installation access token (read-only, the installation's repositories), cached."""
    if not configured():
        raise GitHubError(503, "The Markdrop Guides GitHub App isn't set up yet.")
    iid = int(installation_id)
    hit = _tokens.get(iid)
    if hit and hit[1] - TOKEN_SLACK > time.time():
        return hit[0]
    async with _token_lock:
        hit = _tokens.get(iid)
        if hit and hit[1] - TOKEN_SLACK > time.time():
            return hit[0]
        r = await _call("POST", f"{api_base()}/app/installations/{iid}/access_tokens", auth=f"Bearer {app_jwt()}",
                        not_found="That GitHub installation no longer exists.")
        if r.status_code not in (200, 201):
            raise GitHubError(502, f"GitHub didn't give an installation token (HTTP {r.status_code}).")
        body = r.json()
        token = body.get("token") or ""
        exp = _parse_time(body.get("expires_at")) or time.time() + 3000
        _tokens[iid] = (token, exp)
        return token


def forget_installation(installation_id: int) -> None:
    _tokens.pop(int(installation_id), None)


def _parse_time(v: Any) -> float | None:
    from datetime import datetime

    if not isinstance(v, str):
        return None
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


async def get_installation(installation_id: int) -> dict:
    """The installation as the app sees it (GET /app/installations/{id})."""
    r = await _call("GET", f"{api_base()}/app/installations/{int(installation_id)}", auth=f"Bearer {app_jwt()}",
                    not_found="That GitHub installation no longer exists.")
    return r.json()


async def _auth_for(installation_id: int | None) -> str | None:
    return f"token {await installation_token(installation_id)}" if installation_id else None


# ── OAuth (proving who installed) ─────────────────────────────────────────────


async def exchange_code(code: str) -> str:
    """A GitHub OAuth code → a user access token (used once, never stored)."""
    s = _s()
    try:
        async with _client() as c:
            r = await c.post(f"{web_base()}/login/oauth/access_token", headers={"accept": "application/json"},
                             data={"client_id": s.docs_github_client_id, "client_secret": s.docs_github_client_secret,
                                   "code": code})
    except httpx.HTTPError as e:
        raise GitHubError(502, f"GitHub didn't answer ({type(e).__name__}). Try again.") from None
    try:
        body = r.json()
    except ValueError:
        body = {}
    token = body.get("access_token") if isinstance(body, dict) else None
    if r.status_code != 200 or not token:
        raise GitHubError(400, "GitHub didn't accept the sign-in (the link may have expired). Try connecting again.")
    return token


async def user_installations(user_token: str) -> list[dict]:
    """Every installation of this app the GitHub user can reach (GET /user/installations)."""
    out: list[dict] = []
    for page in range(1, 6):
        r = await _call("GET", f"{api_base()}/user/installations", auth=f"token {user_token}",
                        params={"per_page": 100, "page": page})
        rows = (r.json() or {}).get("installations") or []
        out.extend(rows)
        if len(rows) < 100:
            break
    return out


async def revoke_user_token(user_token: str) -> None:
    """Best effort: the user token was needed for one listing only."""
    s = _s()
    try:
        async with _client() as c:
            await c.request("DELETE", f"{api_base()}/applications/{s.docs_github_client_id}/token",
                            auth=(s.docs_github_client_id, s.docs_github_client_secret),
                            json={"access_token": user_token}, headers=_headers(None))
    except Exception:  # noqa: BLE001 - it expires on its own
        pass


# ── Repositories ──────────────────────────────────────────────────────────────


def repo_view(r: dict, installation_id: int | None = None) -> dict:
    owner = (r.get("owner") or {}).get("login") or ""
    return {
        "id": r.get("id"),
        "owner": owner,
        "name": r.get("name") or "",
        "full_name": r.get("full_name") or f"{owner}/{r.get('name')}",
        "private": bool(r.get("private")),
        "default_branch": r.get("default_branch") or "main",
        "description": (r.get("description") or "")[:300] or None,
        "pushed_at": r.get("pushed_at"),
        "installation_id": installation_id,
    }


async def installation_repos(installation_id: int, q: str | None = None, limit: int = 300) -> tuple[list[dict], bool]:
    auth = await _auth_for(installation_id)
    out: list[dict] = []
    truncated = False
    for page in range(1, 11):
        r = await _call("GET", f"{api_base()}/installation/repositories", auth=auth,
                        params={"per_page": 100, "page": page})
        body = r.json() or {}
        rows = body.get("repositories") or []
        out.extend(repo_view(x, int(installation_id)) for x in rows)
        if len(rows) < 100:
            break
        if len(out) >= limit:
            truncated = True
            break
    if q:
        needle = q.lower().strip()
        out = [x for x in out if needle in x["full_name"].lower()]
    out.sort(key=lambda x: x.get("pushed_at") or "", reverse=True)
    return out[:limit], truncated


def _repo_path(owner: str, name: str) -> str:
    return f"{quote(owner, safe='')}/{quote(name, safe='')}"


async def get_repo(owner: str, name: str, installation_id: int | None = None) -> dict:
    key = f"repo:{owner}/{name}".lower()
    if not installation_id and (hit := _cached(key, PUBLIC_CACHE_TTL)) is not None:
        return hit
    r = await _call("GET", f"{api_base()}/repos/{_repo_path(owner, name)}", auth=await _auth_for(installation_id),
                    not_found="We couldn't find that repository. Check the address, or connect GitHub for a private one.")
    view = repo_view(r.json(), int(installation_id) if installation_id else None)
    return view if installation_id else _store(key, view, PUBLIC_CACHE_TTL)


async def branches(owner: str, name: str, installation_id: int | None = None) -> list[str]:
    key = f"branches:{owner}/{name}".lower()
    if not installation_id and (hit := _cached(key, PUBLIC_CACHE_TTL)) is not None:
        return hit
    auth = await _auth_for(installation_id)
    out: list[str] = []
    for page in range(1, 4):
        r = await _call("GET", f"{api_base()}/repos/{_repo_path(owner, name)}/branches", auth=auth,
                        params={"per_page": 100, "page": page})
        rows = r.json() or []
        out.extend(str(b.get("name")) for b in rows if isinstance(b, dict) and b.get("name"))
        if len(rows) < 100:
            break
    return out if installation_id else _store(key, out, PUBLIC_CACHE_TTL)


async def branch_sha(owner: str, name: str, branch: str, installation_id: int | None = None) -> str:
    """The commit a branch points at (one call: the commits endpoint's sha media type)."""
    r = await _call("GET", f"{api_base()}/repos/{_repo_path(owner, name)}/commits/{quote(branch, safe='')}",
                    auth=await _auth_for(installation_id), accept="application/vnd.github.sha",
                    not_found=f"There is no branch {branch!r} in this repository.")
    sha = r.text.strip()
    if len(sha) != 40 or any(c not in "0123456789abcdef" for c in sha):
        try:
            sha = str((r.json() or {}).get("sha") or "")
        except ValueError:
            sha = ""
    if len(sha) != 40:
        raise GitHubError(502, "GitHub didn't say which commit the branch is on.")
    return sha


async def tree(owner: str, name: str, sha: str, installation_id: int | None = None) -> tuple[list[str], bool]:
    """Every file path at a commit (recursive git tree), and whether GitHub cut the list short."""
    key = f"tree:{owner}/{name}@{sha}".lower()
    if (hit := _cached(key, TREE_CACHE_TTL)) is not None:
        return hit
    r = await _call("GET", f"{api_base()}/repos/{_repo_path(owner, name)}/git/trees/{quote(sha, safe='')}",
                    auth=await _auth_for(installation_id), params={"recursive": "1"})
    body = r.json() or {}
    paths = [str(t["path"]) for t in body.get("tree") or [] if isinstance(t, dict) and t.get("type") == "blob"]
    truncated = bool(body.get("truncated")) or len(paths) > MAX_TREE_PATHS
    return _store(key, (paths[:MAX_TREE_PATHS], truncated), TREE_CACHE_TTL)


async def file_bytes(owner: str, name: str, sha: str, path: str, installation_id: int | None = None,
                     max_bytes: int = 1_000_000) -> bytes | None:
    """A file's bytes at a commit (None: missing or larger than ``max_bytes``). Public: from
    raw.githubusercontent.com (not counted against the API limit); with the app: the contents API."""
    key = f"file:{owner}/{name}@{sha}:{path}".lower()
    if (hit := _cached(key, TREE_CACHE_TTL)) is not None:
        return hit or None
    p = quote(path.strip("/"))
    try:
        if installation_id:
            r = await _call("GET", f"{api_base()}/repos/{_repo_path(owner, name)}/contents/{p}",
                            auth=await _auth_for(installation_id), params={"ref": sha},
                            accept="application/vnd.github.raw")
        else:
            r = await _call("GET", f"{RAW_HOST}/{_repo_path(owner, name)}/{quote(sha, safe='')}/{p}")
    except GitHubError as e:
        if e.status == 404:
            _store(key, b"", TREE_CACHE_TTL)
            return None
        raise
    data = r.content
    if r.status_code != 200 or len(data) > max_bytes:
        return None
    _store(key, data, TREE_CACHE_TTL)
    return data


async def tarball_url(owner: str, name: str, sha: str, installation_id: int | None = None) -> str:
    """Where the import runner downloads the repository at ``sha``. Public: codeload directly. With
    the app: GitHub's short-lived codeload link (its token is in the address, valid a few minutes),
    asked for without following the redirect, so the API never downloads the archive itself."""
    if not installation_id:
        return f"{CODELOAD_HOST}/{_repo_path(owner, name)}/tar.gz/{quote(sha, safe='')}"
    r = await _call("GET", f"{api_base()}/repos/{_repo_path(owner, name)}/tarball/{quote(sha, safe='')}",
                    auth=await _auth_for(installation_id), follow=False)
    loc = r.headers.get("location") or ""
    if r.status_code not in (301, 302, 303, 307, 308) or not loc.startswith(CODELOAD_HOST + "/"):
        raise GitHubError(502, "GitHub didn't give a download link for the repository.")
    return loc


def commit_url(owner: str, name: str, sha: str | None) -> str | None:
    return f"{web_base()}/{owner}/{name}/commit/{sha}" if sha else None


def edit_url(owner: str, name: str, branch: str, path: str) -> str:
    return f"{web_base()}/{owner}/{name}/edit/{quote(branch, safe='/')}/{quote(path.strip('/'), safe='/')}"


def repo_url(owner: str, name: str, branch: str | None = None, path: str | None = None) -> str:
    base = f"{web_base()}/{owner}/{name}"
    if branch and path:
        return f"{base}/tree/{quote(branch, safe='/')}/{quote(path.strip('/'), safe='/')}"
    return base
