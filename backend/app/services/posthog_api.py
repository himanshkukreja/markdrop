"""Read-only PostHog client for the admin Journeys section.

Every call uses the personal API key from settings, server side, so the key never reaches a
browser and recordings are never exposed through PostHog's public share links. What the browser
sends to PostHog is decided in frontend lib/thirdPartyAnalytics.ts: no slugs (an opaque `doc_ref`
instead), no URL fragments, no tokens, no editor contents. This module only reads it back.

Transport rules (PostHog allows 3 concurrent queries and ~240 a minute per key):
  * at most 3 requests in flight (`_slots`), the rest wait their turn;
  * an in-memory TTL cache shares one in-flight request between concurrent callers and keeps the
    answer for a few seconds to minutes (per query, see services/journeys.py);
  * a HogQL query that times out or hits a PostHog 5xx is retried once after 1.5 s;
  * errors are mapped to statuses the admin console can show. Never 401/403: a 401 from our API
    signs the admin out, so a revoked PostHog key must not look like an expired admin session.

Personal-key HogQL has two traps: OFFSET is refused (page by keyset on timestamp, or use the REST
endpoints' offsets) and an unbounded scan of `events` times out (every query bounds `timestamp`).
"""

import asyncio
import base64
import gzip
import json
import re
import time
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar
from urllib.parse import urlparse

import httpx

from app.config import get_settings

settings = get_settings()

T = TypeVar("T")


class PostHogError(Exception):
    """An upstream failure, already mapped to the status our API answers with.

    `upstream` is PostHog's own status (or None for a network failure); `scope` names the missing
    personal-API-key scope when PostHog refused the request for one.
    """

    def __init__(self, status: int, message: str, *, scope: str | None = None, upstream: int | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.scope = scope
        self.upstream = upstream


# ── Status ───────────────────────────────────────────────────────────────────


def ui_host() -> str:
    return settings.posthog_host.rstrip("/")


def region() -> str:
    h = urlparse(ui_host()).hostname or ""
    return "eu" if h.startswith("eu.") or "eu-" in h else "us"


def status() -> dict:
    """What the admin needs to render the setup state. Never includes a secret."""
    missing = [
        name
        for name, value in (
            ("MARKDROP_POSTHOG_PROJECT_ID", settings.posthog_project_id),
            ("MARKDROP_POSTHOG_PERSONAL_API_KEY", settings.posthog_personal_api_key),
        )
        if not value
    ]
    return {
        "configured": settings.posthog_configured,
        "region": region(),
        "ui_host": ui_host(),
        "project_id": settings.posthog_project_id or None,
        "include_local": settings.posthog_include_local,
        "missing": missing,
    }


def not_configured() -> dict:
    """Returned with HTTP 200 by every data endpoint while PostHog isn't set up."""
    return {"configured": False, "status": status()}


def app_url(path: str) -> str:
    """A link into the PostHog app for this project."""
    return f"{ui_host()}/project/{settings.posthog_project_id}{path}"


# ── Transport ────────────────────────────────────────────────────────────────

_slots: asyncio.Semaphore | None = None
_client: httpx.AsyncClient | None = None
_TIMEOUT = 20.0

_SCOPE_IN_TEXT = re.compile(r"\b([a-z_]+:(?:read|write))\b")


def _semaphore() -> asyncio.Semaphore:
    global _slots
    if _slots is None:
        _slots = asyncio.Semaphore(3)
    return _slots


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=httpx.Timeout(_TIMEOUT, connect=8.0))
    return _client


def scope_for(path: str, method: str) -> str:
    """The personal-API-key scope an endpoint needs (when PostHog's 403 doesn't name it)."""
    if path.startswith("/query"):
        return "query:read"
    if "/sharing" in path:
        return "sharing_configuration:read" if method == "GET" else "sharing_configuration:write"
    if path.startswith("/session_recordings"):
        return "session_recording:read"
    if path.startswith("/persons"):
        return "person:read"
    return "project:read"


def _detail(res: httpx.Response) -> str:
    try:
        body = res.json()
    except ValueError:
        return res.text[:300]
    if isinstance(body, dict):
        return str(body.get("detail") or body.get("error") or body.get("message") or "")[:500]
    return str(body)[:300]


def _map_error(res: httpx.Response, path: str, method: str) -> PostHogError:
    code = res.status_code
    detail = _detail(res)
    # PostHog answers an invalid key with 403 on some endpoints (/query) and 401 on others.
    try:
        kind = (res.json() or {}).get("code") if res.headers.get("content-type", "").startswith("application/json") else None
    except ValueError:
        kind = None
    if code == 401 or (code == 403 and kind == "authentication_failed"):
        return PostHogError(
            502, "PostHog rejected MARKDROP_POSTHOG_PERSONAL_API_KEY (revoked, or the wrong region?)", upstream=code
        )
    if code == 403:
        m = _SCOPE_IN_TEXT.search(detail)
        scope = m.group(1) if m else scope_for(path, method)
        return PostHogError(
            424,
            f"The personal API key is missing the “{scope}” scope. "
            "Add it in PostHog → Account settings → Personal API keys → edit.",
            scope=scope,
            upstream=code,
        )
    if code == 404:
        return PostHogError(502, f"PostHog: not found ({detail or 'check MARKDROP_POSTHOG_PROJECT_ID'})", upstream=code)
    if code == 429:
        return PostHogError(429, "PostHog rate limit hit, try again in a minute", upstream=code)
    if path.startswith("/query") and code == 400:
        return PostHogError(502, f"HogQL: {detail}", upstream=code)
    return PostHogError(502, f"PostHog {code}: {detail or res.reason_phrase}", upstream=code)


async def request(
    method: str,
    path: str,
    *,
    json_body: dict | None = None,
    params: dict | None = None,
    timeout: float = _TIMEOUT,
) -> httpx.Response:
    """One call to `{host}/api/projects/{id}{path}`, through the 3-slot queue."""
    url = f"{ui_host()}/api/projects/{settings.posthog_project_id}{path}"
    headers = {"Authorization": f"Bearer {settings.posthog_personal_api_key}"}
    async with _semaphore():
        try:
            res = await _http().request(method, url, headers=headers, json=json_body, params=params, timeout=timeout)
        except httpx.TimeoutException:
            raise PostHogError(504, "PostHog took too long to answer") from None
        except httpx.HTTPError as e:
            raise PostHogError(504, f"Can't reach PostHog: {e.__class__.__name__}") from None
    if res.status_code >= 400:
        raise _map_error(res, path, method)
    return res


# ── Cache ────────────────────────────────────────────────────────────────────

_cache: dict[str, tuple[float, asyncio.Future]] = {}


async def cached(key: str, ttl: float, fn: Callable[[], Awaitable[T]]) -> T:
    """Memoise `fn()` for `ttl` seconds. Concurrent callers share one request; a failure is
    evicted at once so the next call retries. Treat what comes back as read-only."""
    now = time.monotonic()
    hit = _cache.get(key)
    if hit and hit[0] > now and not (hit[1].done() and (hit[1].cancelled() or hit[1].exception() is not None)):
        return await asyncio.shield(hit[1])
    fut = asyncio.ensure_future(fn())
    _cache[key] = (now + ttl, fut)
    if len(_cache) > 300:
        for k, (exp, f) in list(_cache.items()):
            if exp <= now and f.done():
                _cache.pop(k, None)
    try:
        return await asyncio.shield(fut)
    except BaseException:
        # Evict a failed request; a caller that merely went away leaves it running for the others.
        if fut.done() and _cache.get(key, (0, None))[1] is fut:
            _cache.pop(key, None)
        raise


def uncache(prefix: str) -> None:
    for k in [k for k in _cache if k.startswith(prefix)]:
        _cache.pop(k, None)


# ── HogQL ────────────────────────────────────────────────────────────────────

_TRANSIENT = re.compile(r"execution time|timeout|timed out|took too long|server_error|too many simultaneous", re.I)


def _transient(e: PostHogError) -> bool:
    return (e.upstream is not None and e.upstream >= 500) or e.status == 504 or bool(_TRANSIENT.search(e.message))


async def hogql(query: str, values: dict | None = None, *, name: str, ttl: float = 30) -> list[dict]:
    """Run a HogQL query; rows come back as dicts keyed by column alias.

    `values` fill `{name}` placeholders (PostHog escapes them). Numbers for INTERVAL and LIMIT
    are validated by the caller and inlined.
    """
    q: dict[str, Any] = {"kind": "HogQLQuery", "query": query}
    if values:
        q["values"] = values
    body = {"query": q, "name": f"admin_journeys_{name}"}
    key = "q:" + json.dumps(body, sort_keys=True, default=str)

    async def run() -> list[dict]:
        for attempt in (0, 1):
            try:
                data = (await request("POST", "/query/", json_body=body, timeout=30)).json()
                if data.get("error"):
                    raise PostHogError(502, f"HogQL: {data['error']}")
            except PostHogError as e:
                if not _transient(e):
                    raise
                if attempt == 0:
                    await asyncio.sleep(1.5)
                    continue
                raise PostHogError(504, f"PostHog query timed out ({e.message}). Try again in a minute.") from None
            cols = data.get("columns") or []
            return [dict(zip(cols, r)) for r in data.get("results") or []]
        return []  # unreachable

    return await cached(key, ttl, run)


# ── Session recordings ───────────────────────────────────────────────────────


async def list_recordings(params: dict, *, ttl: float = 30) -> dict:
    """GET /session_recordings/ (REST: offsets are allowed here)."""
    key = "rec:" + json.dumps(params, sort_keys=True)

    async def run() -> dict:
        return (await request("GET", "/session_recordings/", params=params)).json()

    return await cached(key, ttl, run)


def _inflate(value: Any) -> Any:
    """Undo posthog-js field compression: gzip bytes carried as a latin-1 string."""
    if not isinstance(value, str):
        return value
    for decode in (lambda s: s.encode("latin-1"), base64.b64decode):
        try:
            return json.loads(gzip.decompress(decode(value)).decode("utf-8"))
        except Exception:  # noqa: BLE001 - try the next encoding
            continue
    return value


def _decompress(event: dict) -> dict:
    if not isinstance(event, dict) or event.get("cv") != "2024-10":
        return event
    data = event.get("data")
    if event.get("type") == 2:
        event = {**event, "data": _inflate(data)}
    elif event.get("type") == 3 and isinstance(data, dict):
        event = {**event, "data": {k: _inflate(v) if k in ("texts", "attributes", "removes", "adds") else v for k, v in data.items()}}
    event.pop("cv", None)
    return event


def _parse_lines(text: str) -> list[dict]:
    events: list[dict] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except ValueError:
            continue
        # Two shapes: [window_id, event] or {"window_id": ..., "data": [events]}.
        if isinstance(item, list) and len(item) == 2 and isinstance(item[1], dict):
            events.append(_decompress(item[1]))
        elif isinstance(item, dict) and isinstance(item.get("data"), list):
            events.extend(_decompress(e) for e in item["data"] if isinstance(e, dict))
        elif isinstance(item, dict) and "type" in item:
            events.append(_decompress(item))
    events.sort(key=lambda e: e.get("timestamp") or 0)
    return events


async def snapshots(recording_id: str) -> list[dict] | None:
    """Every rrweb event of a recording, decompressed and in time order; None when PostHog has
    no such recording (too short, Do Not Track, or past retention)."""

    async def run() -> list[dict] | None:
        path = f"/session_recordings/{recording_id}/snapshots"
        try:
            sources = (await request("GET", path, params={"blob_v2": "true"}, timeout=30)).json().get("sources") or []
        except PostHogError as e:
            if e.upstream == 404:
                return None
            raise
        blob_keys = [s.get("blob_key") for s in sources if s.get("source") == "blob_v2" and s.get("blob_key") is not None]
        events: list[dict] = []
        if blob_keys:
            ints = sorted(int(k) for k in blob_keys)
            res = await request(
                "GET", path,
                params={"source": "blob_v2", "start_blob_key": str(ints[0]), "end_blob_key": str(ints[-1])},
                timeout=60,
            )
            events = _parse_lines(res.text)
        else:
            # Older recordings: one request per blob source.
            for s in sources:
                if s.get("source") != "blob":
                    continue
                res = await request("GET", path, params={"source": "blob", "blob_key": s.get("blob_key")}, timeout=60)
                events.extend(_parse_lines(res.text))
            events.sort(key=lambda e: e.get("timestamp") or 0)
        return events

    return await cached(f"snap:{recording_id}", 300, run)
