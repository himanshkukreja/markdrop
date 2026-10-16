"""Read-only PostHog client for the admin Journeys and Live sections.

Every call uses the personal API key from settings, server side, so the key never reaches a
browser and recordings are never exposed through PostHog's public share links. What the browser
sends to PostHog is decided in frontend lib/thirdPartyAnalytics.ts: no slugs (an opaque `doc_ref`
instead), no URL fragments, no tokens, no editor contents. This module only reads it back.

PostHog's limits for a personal API key (posthog.com/docs/api/queries): the query endpoint takes
240 requests a minute and 2,400 an hour, 3 concurrent queries and ~10 s of execution, within an
hourly read budget in bytes (429 `api_queries_budget_exceeded` once spent). The recordings and
persons REST endpoints take 240 a minute and 1,200 an hour. ClickHouse sheds load with 503
`clickhouse_at_capacity` and a Retry-After.

Transport rules:
  * at most 3 requests in flight (`_slots`), the rest wait their turn;
  * `cached` shares one in-flight request between concurrent callers and keeps the answer for a
    few seconds to minutes (per query, see services/journeys.py);
  * stale-while-error: the last good answer per cache key (at most 300 keys and ~150k rows, at
    most 6 h old) is served when PostHog fails with a rate limit, a spent budget, capacity, a
    timeout or a 5xx. The request records that (`track_stale`, `stale_summary`) so the response
    can say how old the data is; only a failure with nothing to fall back on is an error;
  * a circuit breaker per bucket ("query" = /query, "rest" = recordings and persons): a 429, or a
    5xx with Retry-After, opens it for Retry-After (60 s without one; 10 min when the read budget
    is spent); three transient failures in a row open it for 30 s. While it is open nothing is
    sent to PostHog: calls fail fast with 429 and the cache serves the last good answer;
  * a HogQL query that times out or hits a 5xx is retried once after a jittered 0.8-2.2 s. A 429,
    or any answer carrying Retry-After, is never retried;
  * errors are mapped to statuses the admin console can show. Never 401/403: a 401 from our API
    signs the admin out, so a revoked PostHog key must not look like an expired admin session.

PostHog caches HogQL results itself: the default `refresh` ("blocking") hands back a cached answer
to an identical query text for minutes, `now()` included. Live queries pass "force_blocking".

Personal-key HogQL has two traps: OFFSET is refused (page by keyset on timestamp, or use the REST
endpoints' offsets) and an unbounded scan of `events` times out (every query bounds `timestamp`).
"""

import asyncio
import base64
import contextvars
import email.utils
import gzip
import json
import logging
import random
import re
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any, TypeVar
from urllib.parse import urlparse

import httpx

from app.config import get_settings

settings = get_settings()
log = logging.getLogger(__name__)

T = TypeVar("T")

# Failures the last good answer may stand in for, and how the console words them.
REASON_TEXT = {
    "budget": "PostHog's hourly query budget for our key is spent",
    "rate_limited": "PostHog is rate-limiting us",
    "capacity": "PostHog is at capacity",
    "slow": "PostHog is slow to answer",
    "unavailable": "PostHog is having trouble",
}
_REASON_ORDER = ("budget", "rate_limited", "capacity", "slow", "unavailable")


class PostHogError(Exception):
    """An upstream failure, already mapped to the status our API answers with.

    `upstream` is PostHog's own status (or None for a network failure); `scope` names the missing
    personal-API-key scope when PostHog refused the request for one. `reason` (see REASON_TEXT)
    is set for failures that pass: those may be answered with the last good result. `retry_after`
    is how long PostHog asked us to wait (seconds); `skipped` means the breaker was open and
    PostHog was never asked.
    """

    def __init__(
        self,
        status: int,
        message: str,
        *,
        scope: str | None = None,
        upstream: int | None = None,
        reason: str | None = None,
        retry_after: float | None = None,
        skipped: bool = False,
    ):
        super().__init__(message)
        self.status = status
        self.message = message
        self.scope = scope
        self.upstream = upstream
        self.reason = reason
        self.retry_after = retry_after
        self.skipped = skipped

    @property
    def stale_ok(self) -> bool:
        return self.reason in REASON_TEXT


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
        "limits": limits(),
    }


def not_configured() -> dict:
    """Returned with HTTP 200 by every data endpoint while PostHog isn't set up."""
    return {"configured": False, "status": status()}


def app_url(path: str) -> str:
    """A link into the PostHog app for this project."""
    return f"{ui_host()}/project/{settings.posthog_project_id}{path}"


# ── Circuit breaker ──────────────────────────────────────────────────────────

COOLDOWN_DEFAULT = 60.0  # a 429 without Retry-After
COOLDOWN_BUDGET = 600.0  # the hourly read budget is spent
COOLDOWN_STREAK = 30.0  # three transient failures in a row
COOLDOWN_MAX = 3600.0
STREAK_TRIP = 3

_breaker: dict[str, tuple[float, str]] = {}  # bucket → (open until, monotonic; reason)
_streak: dict[str, int] = {}


def bucket_for(path: str) -> str:
    """Query and REST endpoints are limited separately, so each has its own breaker."""
    return "query" if path.startswith("/query") else "rest"


def cooldown_left(bucket: str) -> tuple[float, str] | None:
    """(seconds left, reason) while the bucket's breaker is open."""
    hit = _breaker.get(bucket)
    if not hit:
        return None
    left = hit[0] - time.monotonic()
    if left <= 0:
        _breaker.pop(bucket, None)
        return None
    return left, hit[1]


def trip(bucket: str, seconds: float, reason: str) -> None:
    """Open the breaker for `seconds` (never shortening one already open for longer)."""
    seconds = max(1.0, min(float(seconds), COOLDOWN_MAX))
    until = time.monotonic() + seconds
    cur = _breaker.get(bucket)
    if not cur or cur[0] < until:
        _breaker[bucket] = (until, reason)


def _note_failure(bucket: str, reason: str) -> None:
    n = _streak.get(bucket, 0) + 1
    _streak[bucket] = n
    if n >= STREAK_TRIP:
        _streak[bucket] = 0
        trip(bucket, COOLDOWN_STREAK, reason)


def limits() -> dict:
    """Open breakers, for the console: {bucket: {cooldown_s, reason}}."""
    out = {}
    for b in ("query", "rest"):
        x = cooldown_left(b)
        if x:
            out[b] = {"cooldown_s": max(1, round(x[0])), "reason": x[1]}
    return out


def parse_retry_after(value: str | None) -> float | None:
    """Retry-After as seconds: delta-seconds or an HTTP date; None when absent or unreadable."""
    if not value:
        return None
    v = value.strip()
    try:
        return max(0.0, float(v))
    except ValueError:
        pass
    try:
        dt = email.utils.parsedate_to_datetime(v)
    except (TypeError, ValueError, IndexError):
        return None
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return max(0.0, (dt - datetime.now(timezone.utc)).total_seconds())


def _wait_text(seconds: float) -> str:
    s = max(1, round(seconds))
    return f"{s} s" if s < 90 else f"{round(s / 60)} min"


# ── Transport ────────────────────────────────────────────────────────────────

_slots: asyncio.Semaphore | None = None
_client: httpx.AsyncClient | None = None
_TIMEOUT = 20.0

_SCOPE_IN_TEXT = re.compile(r"\b([a-z_]+:(?:read|write))\b")
_SLOW = re.compile(r"execution time|timeout|timed out|took too long|too long to", re.I)
_CAPACITY = re.compile(r"at capacity|too busy|too many simultaneous|too many concurrent|memory limit", re.I)


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


def _json_body(res: httpx.Response) -> dict | None:
    try:
        body = res.json()
    except ValueError:
        return None
    return body if isinstance(body, dict) else None


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
    body = _json_body(res)
    kind = (body or {}).get("code")
    retry_after = parse_retry_after(res.headers.get("retry-after"))
    # PostHog answers an invalid key with 403 on some endpoints (/query) and 401 on others.
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
        if kind == "api_queries_budget_exceeded" or "budget" in detail.lower():
            wait = max(retry_after or 0.0, COOLDOWN_BUDGET)
            return PostHogError(
                429, f"{REASON_TEXT['budget']}; trying again in {_wait_text(wait)}.",
                upstream=code, reason="budget", retry_after=wait,
            )
        if _CAPACITY.search(detail):
            wait = retry_after if retry_after is not None else 10.0
            return PostHogError(
                429, f"{REASON_TEXT['capacity']}; trying again in {_wait_text(wait)}.",
                upstream=code, reason="capacity", retry_after=wait,
            )
        wait = retry_after if retry_after is not None else COOLDOWN_DEFAULT
        return PostHogError(
            429, f"{REASON_TEXT['rate_limited']}; trying again in {_wait_text(wait)}.",
            upstream=code, reason="rate_limited", retry_after=wait,
        )
    if code >= 500 or kind == "clickhouse_at_capacity":
        if kind == "clickhouse_at_capacity" or _CAPACITY.search(detail):
            return PostHogError(503, f"{REASON_TEXT['capacity']} ({code}).", upstream=code, reason="capacity", retry_after=retry_after)
        if code == 504 or _SLOW.search(detail):
            return PostHogError(504, f"PostHog query timed out ({detail or code}).", upstream=code, reason="slow", retry_after=retry_after)
        return PostHogError(502, f"PostHog {code}: {detail or res.reason_phrase}", upstream=code, reason="unavailable", retry_after=retry_after)
    if path.startswith("/query") and code == 400:
        return hogql_error(detail, upstream=code)
    return PostHogError(502, f"PostHog {code}: {detail or res.reason_phrase}", upstream=code)


def hogql_error(text: str, upstream: int | None = None) -> PostHogError:
    """A HogQL failure reported in a body: capacity and timeouts pass, the rest is our bug."""
    if _CAPACITY.search(text):
        return PostHogError(503, f"{REASON_TEXT['capacity']}.", upstream=upstream, reason="capacity")
    if _SLOW.search(text):
        return PostHogError(504, f"PostHog query timed out ({text[:200]}).", upstream=upstream, reason="slow")
    return PostHogError(502, f"HogQL: {text}", upstream=upstream)


# Development hook (MARKDROP_POSTHOG_FAULT_INJECTION): canned PostHog answers that go through the
# real error mapping, breaker and stale path. The router refuses it unless the setting is on.
_faults: list[dict] = []


def inject_fault(*, status: int = 429, headers: dict | None = None, body: Any = None, count: int = 1,
                 path: str = "/", timeout: bool = False) -> None:
    _faults.append({"status": status, "headers": headers or {}, "body": body, "count": max(1, count), "path": path, "timeout": timeout})


def _take_fault(path: str) -> dict | None:
    for f in _faults:
        if path.startswith(f["path"]):
            f["count"] -= 1
            if f["count"] <= 0:
                _faults.remove(f)
            return f
    return None


def clear_faults() -> None:
    """Drop injected faults and close the breakers."""
    _faults.clear()
    _breaker.clear()
    _streak.clear()


def reset() -> None:
    """Forget caches, breakers and injected faults (tests and the development hook)."""
    global _good_rows
    _cache.clear()
    _good.clear()
    _good_rows = 0
    _breaker.clear()
    _streak.clear()
    _faults.clear()


# Request counts and time per query name / endpoint, since start (development hook and logs).
_stats: dict[str, dict] = {}
_stats_since = time.time()


def _label(path: str, body: dict | None) -> str:
    if path == "/query/":
        return str((body or {}).get("name") or "query").removeprefix("admin_journeys_")
    if path.startswith("/query/"):
        return "query_poll"
    if path.endswith("/snapshots"):
        return "snapshots"
    return path.strip("/").split("/")[0] or path


def _stat(label: str, started: float | None = None, *, error: bool = False, skipped: bool = False) -> None:
    st = _stats.setdefault(label, {"sent": 0, "errors": 0, "skipped": 0, "ms": 0.0, "max_ms": 0.0})
    if skipped:
        st["skipped"] += 1
        return
    ms = (time.monotonic() - started) * 1000 if started is not None else 0.0
    st["sent"] += 1
    st["errors"] += int(error)
    st["ms"] += ms
    st["max_ms"] = max(st["max_ms"], ms)
    if ms > 5000:
        log.info("posthog %s took %.1f s%s", label, ms / 1000, " (failed)" if error else "")


def stats() -> dict:
    """Requests sent to PostHog per query name / endpoint since start (or the last reset)."""
    mins = max((time.time() - _stats_since) / 60, 1e-9)
    by = {k: {**v, "ms": round(v["ms"]), "max_ms": round(v["max_ms"]), "avg_ms": round(v["ms"] / v["sent"]) if v["sent"] else 0}
          for k, v in sorted(_stats.items())}
    sent = sum(v["sent"] for v in _stats.values())
    return {"minutes": round(mins, 2), "sent": sent, "per_minute": round(sent / mins, 2), "by": by}


def reset_stats() -> None:
    global _stats_since
    _stats.clear()
    _stats_since = time.time()


def _check_breaker(bucket: str, label: str) -> None:
    open_ = cooldown_left(bucket)
    if open_:
        left, why = open_
        _stat(label, skipped=True)
        raise PostHogError(
            429, f"{REASON_TEXT.get(why, 'PostHog is unavailable')}; trying again in {_wait_text(left)}.",
            reason=why, retry_after=left, skipped=True,
        )


async def request(
    method: str,
    path: str,
    *,
    json_body: dict | None = None,
    params: dict | None = None,
    timeout: float = _TIMEOUT,
) -> httpx.Response:
    """One call to `{host}/api/projects/{id}{path}`, through the breaker and the 3-slot queue."""
    bucket = bucket_for(path)
    url = f"{ui_host()}/api/projects/{settings.posthog_project_id}{path}"
    headers = {"Authorization": f"Bearer {settings.posthog_personal_api_key}"}
    label = _label(path, json_body)
    _check_breaker(bucket, label)
    async with _semaphore():
        # Checked after queueing too: a caller ahead of us may have opened it.
        _check_breaker(bucket, label)
        started = time.monotonic()
        try:
            fault = _take_fault(path) if _faults else None
            if fault and fault["timeout"]:
                raise httpx.ReadTimeout("injected timeout")
            if fault:
                req = httpx.Request(method, url)
                res = httpx.Response(fault["status"], headers=fault["headers"], json=fault["body"], request=req)
            else:
                res = await _http().request(method, url, headers=headers, json=json_body, params=params, timeout=timeout)
        except httpx.TimeoutException:
            _stat(label, started, error=True)
            _note_failure(bucket, "slow")
            raise PostHogError(504, "PostHog took too long to answer", reason="slow") from None
        except httpx.HTTPError as e:
            _stat(label, started, error=True)
            _note_failure(bucket, "unavailable")
            raise PostHogError(504, f"Can't reach PostHog: {e.__class__.__name__}", reason="unavailable") from None
    _stat(label, started, error=res.status_code >= 400)
    if res.status_code >= 400:
        err = _map_error(res, path, method)
        if err.retry_after is not None and err.reason:
            trip(bucket, err.retry_after, err.reason)
        elif err.reason:
            _note_failure(bucket, err.reason)
        raise err
    _streak[bucket] = 0
    return res


# ── Last good answers (stale-while-error) ────────────────────────────────────

GOOD_KEYS = 300
GOOD_ROWS = 150_000
GOOD_AGE = 6 * 3600.0

# key → (stored at: monotonic, stored at: wall clock, value, weight in rows)
_good: "OrderedDict[str, tuple[float, float, Any, int]]" = OrderedDict()
_good_rows = 0


def _weight(value: Any) -> int:
    if isinstance(value, list):
        return max(1, len(value))
    if isinstance(value, dict):
        rows = value.get("results")
        return max(1, len(rows)) if isinstance(rows, list) else 1
    return 1


def remember(key: str, value: Any) -> None:
    """Keep `value` as the last good answer for `key`, evicting the least recently used."""
    global _good_rows
    old = _good.pop(key, None)
    if old:
        _good_rows -= old[3]
    w = _weight(value)
    _good[key] = (time.monotonic(), time.time(), value, w)
    _good_rows += w
    while len(_good) > 1 and (len(_good) > GOOD_KEYS or _good_rows > GOOD_ROWS):
        _, gone = _good.popitem(last=False)
        _good_rows -= gone[3]


def recall(key: str) -> tuple[float, Any] | None:
    """(stored at, wall clock; value) of the last good answer, unless it is too old."""
    global _good_rows
    hit = _good.get(key)
    if not hit:
        return None
    if time.monotonic() - hit[0] > GOOD_AGE:
        _good.pop(key, None)
        _good_rows -= hit[3]
        return None
    _good.move_to_end(key)
    return hit[1], hit[2]


_notes: contextvars.ContextVar[list | None] = contextvars.ContextVar("posthog_stale_notes", default=None)


def track_stale() -> list[dict]:
    """Start collecting stale notes for the current request (child tasks share the list)."""
    notes: list[dict] = []
    _notes.set(notes)
    return notes


def note_stale(as_of: float, reason: str | None) -> None:
    notes = _notes.get()
    if notes is not None:
        notes.append({"as_of": as_of, "reason": reason})


def stale_summary(notes: list[dict] | None) -> dict | None:
    """What the console shows when part of an answer is old: its age, why, and when we retry."""
    if not notes:
        return None
    oldest = min(n["as_of"] for n in notes)
    reasons = {n.get("reason") for n in notes}
    reason = next((r for r in _REASON_ORDER if r in reasons), "unavailable")
    waits = [x[0] for b in ("query", "rest") if (x := cooldown_left(b))]
    return {
        "age_s": max(0, round(time.time() - oldest)),
        "as_of": datetime.fromtimestamp(oldest, timezone.utc).isoformat(),
        "reason": reason,
        "message": REASON_TEXT[reason],
        "retry_in": max(1, round(max(waits))) if waits else None,
    }


# ── Cache ────────────────────────────────────────────────────────────────────


class _Entry:
    __slots__ = ("expires", "fut", "stale", "kept")

    def __init__(self, expires: float, fut: asyncio.Future, stale: tuple[float, str | None] | None = None):
        self.expires = expires
        self.fut = fut
        self.stale = stale  # (as_of, reason) when this entry stands in for a failed refresh
        self.kept = False


_cache: dict[str, _Entry] = {}
_CACHE_MAX = 400
_HOLD_MIN, _HOLD_MAX = 15.0, 60.0


def _failed(fut: asyncio.Future) -> bool:
    return fut.done() and (fut.cancelled() or fut.exception() is not None)


def _resolved(value: Any) -> asyncio.Future:
    fut = asyncio.get_running_loop().create_future()
    fut.set_result(value)
    return fut


def _prune(now: float) -> None:
    if len(_cache) <= _CACHE_MAX:
        return
    for k, e in list(_cache.items()):
        if e.expires <= now and e.fut.done():
            _cache.pop(k, None)
    if len(_cache) > _CACHE_MAX:
        done = sorted((e.expires, k) for k, e in _cache.items() if e.fut.done())
        for _, k in done[: len(_cache) - _CACHE_MAX]:
            _cache.pop(k, None)


async def cached(key: str, ttl: float, fn: Callable[[], Awaitable[T]], *, keep: bool = True) -> T:
    """Memoise `fn()` for `ttl` seconds. Concurrent callers share one request; a failure is
    evicted at once so the next call retries. With `keep`, the last good answer stands in for a
    failure that passes (rate limit, budget, capacity, timeout, 5xx): it is served, held for a
    moment so PostHog isn't asked again at once, and noted as stale. Treat what comes back as
    read-only."""
    now = time.monotonic()
    entry = _cache.get(key)
    if entry is None or entry.expires <= now or _failed(entry.fut):
        entry = _Entry(now + ttl, asyncio.ensure_future(fn()))
        _cache[key] = entry
        _prune(now)
    try:
        value = await asyncio.shield(entry.fut)
    except PostHogError as e:
        if entry.fut.done() and _cache.get(key) is entry:
            _cache.pop(key, None)
        if keep and e.stale_ok:
            got = recall(key)
            if got is not None:
                as_of, value = got
                hold = e.retry_after if e.retry_after else min(max(ttl, _HOLD_MIN), _HOLD_MAX)
                if key not in _cache:
                    _cache[key] = _Entry(time.monotonic() + hold, _resolved(value), (as_of, e.reason))
                note_stale(as_of, e.reason)
                return value
        raise
    except BaseException:
        # Evict a failed request; a caller that merely went away leaves it running for the others.
        if entry.fut.done() and _cache.get(key) is entry:
            _cache.pop(key, None)
        raise
    if entry.stale is not None:
        note_stale(*entry.stale)
    elif keep and not entry.kept:
        entry.kept = True
        remember(key, value)
    return value


def uncache(prefix: str) -> None:
    for k in [k for k in _cache if k.startswith(prefix)]:
        _cache.pop(k, None)


# ── HogQL ────────────────────────────────────────────────────────────────────


def _retryable(e: PostHogError) -> bool:
    """Worth one more try: a timeout or 5xx that didn't ask us to wait."""
    return not e.skipped and e.retry_after is None and e.upstream != 429 and e.reason in ("slow", "unavailable", "capacity")


async def _poll_query(query_id: str, deadline: float = 55.0) -> dict:
    """Wait for an async query (GET /query/{id}/), backing off from 0.8 s to 3 s."""
    start = time.monotonic()
    delay = 0.8
    while True:
        await asyncio.sleep(delay)
        delay = min(delay * 1.5, 3.0)
        st = (await request("GET", f"/query/{query_id}/", timeout=15)).json().get("query_status") or {}
        if st.get("complete"):
            if st.get("error"):
                raise hogql_error(str(st.get("error_message") or "the query failed"))
            return st.get("results") or {}
        if time.monotonic() - start > deadline:
            raise PostHogError(504, "PostHog is still computing this; try again in a minute.", reason="slow")


async def hogql(
    query: str,
    values: dict | None = None,
    *,
    name: str,
    ttl: float = 30,
    refresh: str | None = None,
    keep: bool = True,
) -> list[dict]:
    """Run a HogQL query; rows come back as dicts keyed by column alias.

    `values` fill `{name}` placeholders (PostHog escapes them). Numbers for INTERVAL and LIMIT
    are validated by the caller and inlined. `refresh` is PostHog's execution mode: None (its
    "blocking", which may hand back PostHog's own cached answer), "force_blocking" for live data,
    or "async" for slow queries (started, then polled). `keep=False` skips the last-good store
    (queries whose text changes every call).
    """
    q: dict[str, Any] = {"kind": "HogQLQuery", "query": query}
    if values:
        q["values"] = values
    body: dict[str, Any] = {"query": q, "name": f"admin_journeys_{name}"}
    key = "q:" + json.dumps(body, sort_keys=True, default=str)
    if refresh:
        body["refresh"] = refresh

    async def run() -> list[dict]:
        for attempt in (0, 1):
            try:
                data = (await request("POST", "/query/", json_body=body, timeout=25)).json()
                st = data.get("query_status")
                if refresh == "async" and isinstance(st, dict) and not st.get("complete") and st.get("id"):
                    data = await _poll_query(str(st["id"]))
                if data.get("error"):
                    raise hogql_error(str(data["error"]))
            except PostHogError as e:
                if attempt == 0 and _retryable(e):
                    await asyncio.sleep(random.uniform(0.8, 2.2))
                    continue
                raise
            cols = data.get("columns") or []
            return [dict(zip(cols, r)) for r in data.get("results") or []]
        return []  # unreachable

    return await cached(key, ttl, run, keep=keep)


# ── Session recordings ───────────────────────────────────────────────────────


async def list_recordings(params: dict, *, ttl: float = 60) -> dict:
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


# PostHog serves at most 20 blob_v2 keys per request ("Cannot request more than 20 blob keys at once").
BLOB_SPAN = 20


async def _sources(recording_id: str, *, live: bool) -> list[dict] | None:
    path = f"/session_recordings/{recording_id}/snapshots"

    async def run() -> list[dict] | None:
        try:
            return (await request("GET", path, params={"blob_v2": "true"}, timeout=30)).json().get("sources") or []
        except PostHogError as e:
            if e.upstream == 404:
                return None
            raise

    # A live viewer polls for new blobs; a plain open can share a slightly older list.
    return await cached(f"snapsrc:{recording_id}:{'live' if live else 'full'}", 8 if live else 30, run, keep=False)


async def _blob_events(recording_id: str, keys: list[int]) -> list[dict]:
    path = f"/session_recordings/{recording_id}/snapshots"
    events: list[dict] = []
    for i in range(0, len(keys), BLOB_SPAN):
        chunk = keys[i : i + BLOB_SPAN]
        res = await request(
            "GET", path,
            params={"source": "blob_v2", "start_blob_key": str(chunk[0]), "end_blob_key": str(chunk[-1])},
            timeout=60,
        )
        events.extend(_parse_lines(res.text))
    events.sort(key=lambda e: e.get("timestamp") or 0)
    return events


async def snapshots(recording_id: str, *, after: int | None = None) -> dict | None:
    """A recording's rrweb events, decompressed and in time order, as
    `{events, last_key, live_edge}`; None when PostHog has no such recording (too short, Do Not
    Track, or past retention).

    With `after` (a blob key from an earlier answer) only the blobs after it are fetched: an
    ongoing recording grows by new blob_v2 keys, so a live viewer polls with the last key it has.
    `live_edge` is the end time of the newest blob."""
    sources = await _sources(recording_id, live=after is not None)
    if sources is None:
        return None
    v2 = sorted(
        (int(s["blob_key"]), s)
        for s in sources
        if s.get("source") == "blob_v2" and str(s.get("blob_key", "")).isdigit()
    )
    if v2:
        keys = [k for k, _ in v2 if after is None or k > after]
        events: list[dict] = []
        if keys:
            events = await cached(
                f"snap:{recording_id}:{keys[0]}:{keys[-1]}", 300, lambda: _blob_events(recording_id, keys), keep=False
            )
        return {"events": events, "last_key": v2[-1][0], "live_edge": v2[-1][1].get("end_timestamp")}
    if after is not None:
        return {"events": [], "last_key": after, "live_edge": None}

    # Older recordings: one request per blob source.
    async def legacy() -> list[dict]:
        path = f"/session_recordings/{recording_id}/snapshots"
        out: list[dict] = []
        for s in sources:
            if s.get("source") != "blob":
                continue
            res = await request("GET", path, params={"source": "blob", "blob_key": s.get("blob_key")}, timeout=60)
            out.extend(_parse_lines(res.text))
        out.sort(key=lambda e: e.get("timestamp") or 0)
        return out

    events = await cached(f"snap:{recording_id}:legacy", 300, legacy, keep=False)
    return {"events": events, "last_key": None, "live_edge": None}
