"""Read-only PostHog client for the admin Journeys tab.

Every call uses the personal API key from settings, server side, so the key
never reaches a browser and recordings are never exposed through PostHog's
public share links. Results are cached briefly in-process: the admin pages poll
and re-render, and PostHog rate-limits its query API.

What the browser sends to PostHog is decided in frontend lib/thirdPartyAnalytics.ts:
no slugs (an opaque `doc_ref` instead), no URL fragments, no tokens, no editor
contents. This module only reads it back.
"""

import base64
import gzip
import json
import re
import time
from datetime import datetime
from typing import Any

import httpx

from app.config import get_settings

settings = get_settings()

_TIMEOUT = httpx.Timeout(30.0, connect=10.0)
_cache: dict[str, tuple[float, Any]] = {}


class PostHogError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {settings.posthog_personal_api_key}"}


def _base() -> str:
    return f"{settings.posthog_host.rstrip('/')}/api/projects/{settings.posthog_project_id}"


async def _request(method: str, path: str, *, json_body: dict | None = None, params: dict | None = None) -> httpx.Response:
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        res = await client.request(method, f"{_base()}{path}", headers=_headers(), json=json_body, params=params)
    if res.status_code >= 400:
        try:
            detail = res.json().get("detail") or res.text[:300]
        except ValueError:
            detail = res.text[:300]
        raise PostHogError(res.status_code, str(detail))
    return res


def _cached(key: str, ttl: float) -> Any | None:
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < ttl:
        return hit[1]
    return None


def _store(key: str, value: Any) -> Any:
    if len(_cache) > 500:
        _cache.clear()
    _cache[key] = (time.monotonic(), value)
    return value


async def hogql(query: str, values: dict | None = None, *, ttl: float = 30) -> list[dict]:
    """Run a HogQL query; rows come back as dicts keyed by column name."""
    key = "q:" + json.dumps([query, values], sort_keys=True, default=str)
    hit = _cached(key, ttl)
    if hit is not None:
        return hit
    body: dict[str, Any] = {"query": {"kind": "HogQLQuery", "query": query}}
    if values:
        body["query"]["values"] = values
    res = await _request("POST", "/query/", json_body=body)
    data = res.json()
    cols = data.get("columns") or []
    rows = [dict(zip(cols, r)) for r in data.get("results") or []]
    return _store(key, rows)


# Traffic from local development is tagged by host; leave it out of the console (unless a
# development API asks for it with MARKDROP_POSTHOG_INCLUDE_LOCAL=true).
_NOT_LOCAL = (
    "1 = 1"
    if settings.posthog_include_local
    else "NOT (properties.$host LIKE 'localhost%' OR properties.$host LIKE '127.0.0.1%')"
)


def _days(days: int) -> int:
    return max(1, min(int(days), 90))


async def summary(days: int) -> dict:
    rows = await hogql(
        f"""
        SELECT
          uniq(person_id) AS people,
          uniqIf(person_id, notEmpty(toString(person.properties.email))) AS identified,
          uniq(properties.$session_id) AS sessions,
          countIf(event = '$pageview') AS pageviews
        FROM events
        WHERE timestamp > now() - INTERVAL {_days(days)} DAY AND {_NOT_LOCAL}
        """,
        ttl=60,
    )
    return rows[0] if rows else {"people": 0, "identified": 0, "sessions": 0, "pageviews": 0}


async def people(days: int, search: str | None, identified_only: bool, limit: int, before: str | None) -> list[dict]:
    """People by most recent activity. Pages by keyset: `before` is the last row's last_seen
    (PostHog refuses OFFSET on personal-API-key queries)."""
    where = [f"timestamp > now() - INTERVAL {_days(days)} DAY", _NOT_LOCAL, "event != '$snapshot'"]
    values: dict[str, Any] = {}
    if search:
        where.append(
            "(toString(person.properties.email) ILIKE {q} OR toString(person.properties.name) ILIKE {q}"
            " OR toString(person_id) = {exact} OR distinct_id = {exact})"
        )
        values["q"] = f"%{search}%"
        values["exact"] = search
    if identified_only:
        where.append("notEmpty(toString(person.properties.email))")
    having = "HAVING last_seen < parseDateTimeBestEffort({before})" if before else ""
    return await hogql(
        f"""
        SELECT
          toString(person_id) AS id,
          argMax(toString(person.properties.email), timestamp) AS email,
          argMax(toString(person.properties.name), timestamp) AS name,
          min(timestamp) AS first_seen,
          max(timestamp) AS last_seen,
          count() AS events,
          countIf(event = '$pageview') AS pageviews,
          uniq(properties.$session_id) AS sessions,
          argMax(properties.$geoip_country_code, timestamp) AS country,
          argMax(properties.$geoip_city_name, timestamp) AS city,
          argMax(properties.$browser, timestamp) AS browser,
          argMax(properties.$os, timestamp) AS os,
          argMax(properties.$device_type, timestamp) AS device,
          argMin(properties.$referring_domain, timestamp) AS first_referrer,
          argMin(properties.utm_source, timestamp) AS first_utm_source,
          argMax(properties.$pathname, timestamp) AS last_path
        FROM events
        WHERE {' AND '.join(where)}
        GROUP BY person_id
        {having}
        ORDER BY last_seen DESC
        LIMIT {max(1, min(limit, 100))}
        """,
        ({**values, "before": before} if before else values) or None,
    )


_UUID = re.compile(r"^[0-9a-fA-F-]{32,36}$")


def valid_person_id(person_id: str) -> bool:
    return bool(_UUID.match(person_id))


async def person(person_id: str) -> dict | None:
    rows = await hogql(
        "SELECT toString(id) AS id, created_at, properties FROM persons WHERE id = {id} LIMIT 1",
        {"id": person_id},
    )
    if not rows:
        return None
    row = rows[0]
    props = row.get("properties")
    if isinstance(props, str):
        try:
            props = json.loads(props)
        except ValueError:
            props = {}
    row["properties"] = props or {}
    return row


# Events that are bookkeeping, not something a person did.
_SKIP_EVENTS = ("$snapshot", "$feature_flag_called", "$set", "$identify", "$groupidentify", "$web_vitals", "$opt_in", "$pageleave_bounce")

_TAG = re.compile(r"^([a-zA-Z0-9-]+)")
_TEXT = re.compile(r'(?:^|[^_])text="((?:[^"\\]|\\.)*)"')
_HREF = re.compile(r'attr__href="((?:[^"\\]|\\.)*)"')
_ARIA = re.compile(r'attr__aria-label="((?:[^"\\]|\\.)*)"')


def describe_element(chain: str | None) -> dict | None:
    """The clicked element from an elements_chain: tag, visible text, link target."""
    if not chain:
        return None
    first = chain.split(";", 1)[0]
    tag = _TAG.match(first)
    text = _TEXT.search(first)
    href = _HREF.search(first)
    aria = _ARIA.search(first)
    # The text often sits on the clicked element's parent (an icon inside a button).
    if not text:
        for seg in chain.split(";")[1:4]:
            text = _TEXT.search(seg)
            if text:
                break
    return {
        "tag": tag.group(1) if tag else None,
        "text": (text.group(1) if text else None) or (aria.group(1) if aria else None),
        "href": href.group(1) if href else None,
    }


_KEEP_PROPS = {
    "$session_id", "$pathname", "$current_url", "$referrer", "$referring_domain",
    "$browser", "$os", "$device_type", "$geoip_city_name", "$geoip_country_code",
    "$event_type", "$exception_message", "$exception_type", "$prev_pageview_pathname",
    "$prev_pageview_duration", "$prev_pageview_max_scroll_percentage", "$prev_pageview_max_content_percentage",
    "utm_source", "utm_medium", "utm_campaign", "doc_ref", "doc_kind", "doc_access", "$screen_width",
}


async def timeline(person_id: str, before: datetime | None, limit: int) -> list[dict]:
    # The tuple's repr is valid HogQL: ('$snapshot', '$feature_flag_called', ...).
    # A time bound keeps ClickHouse on the partition index; an unbounded scan times out.
    where = ["timestamp > now() - INTERVAL 90 DAY", "person_id = {id}", f"event NOT IN {_SKIP_EVENTS!r}"]
    values: dict[str, Any] = {"id": person_id}
    if before:
        where.append("timestamp < parseDateTimeBestEffort({before})")
        values["before"] = before.isoformat()
    rows = await hogql(
        f"""
        SELECT toString(uuid) AS uuid, event, timestamp, properties, elements_chain
        FROM events
        WHERE {' AND '.join(where)}
        ORDER BY timestamp DESC
        LIMIT {max(1, min(limit, 500))}
        """,
        values,
        ttl=15,
    )
    out = []
    for r in rows:
        props = r.get("properties")
        if isinstance(props, str):
            try:
                props = json.loads(props)
            except ValueError:
                props = {}
        props = props or {}
        kept = {k: v for k, v in props.items() if k in _KEEP_PROPS}
        # Product events (publish, share, ...) carry their own small props.
        custom = {k: v for k, v in props.items() if not k.startswith("$") and k not in _KEEP_PROPS and k not in ("token", "distinct_id")}
        out.append(
            {
                "uuid": r["uuid"],
                "event": r["event"],
                "timestamp": r["timestamp"],
                "props": kept,
                "custom": custom if not r["event"].startswith("$") else {},
                "element": describe_element(r.get("elements_chain")),
            }
        )
    return out


def _recording(r: dict) -> dict:
    person = r.get("person") or {}
    pprops = person.get("properties") or {}
    return {
        "id": r.get("id"),
        "start_time": r.get("start_time"),
        "end_time": r.get("end_time"),
        "duration": r.get("recording_duration"),
        "active_seconds": r.get("active_seconds"),
        "click_count": r.get("click_count"),
        "keypress_count": r.get("keypress_count"),
        "start_url": r.get("start_url"),
        "ongoing": r.get("ongoing"),
        "person": {
            "id": person.get("uuid") or person.get("id"),
            "email": pprops.get("email"),
            "name": pprops.get("name"),
        } if person else None,
    }


async def recordings(person_id: str | None, limit: int, offset: int) -> list[dict]:
    params: dict[str, Any] = {"limit": max(1, min(limit, 50)), "offset": max(0, offset)}
    if person_id:
        params["person_uuid"] = person_id
    key = "rec:" + json.dumps(params, sort_keys=True)
    hit = _cached(key, 30)
    if hit is not None:
        return hit
    res = await _request("GET", "/session_recordings/", params=params)
    return _store(key, [_recording(r) for r in res.json().get("results") or []])


# ── Snapshots ────────────────────────────────────────────────────────────────


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


async def snapshots(recording_id: str) -> list[dict]:
    """Every rrweb event of a recording, decompressed and in time order."""
    key = f"snap:{recording_id}"
    hit = _cached(key, 300)
    if hit is not None:
        return hit
    path = f"/session_recordings/{recording_id}/snapshots"
    sources = (await _request("GET", path, params={"blob_v2": "true"})).json().get("sources") or []
    blob_keys = [s.get("blob_key") for s in sources if s.get("source") == "blob_v2" and s.get("blob_key") is not None]
    events: list[dict] = []
    if blob_keys:
        ints = sorted(int(k) for k in blob_keys)
        res = await _request(
            "GET", path,
            params={"source": "blob_v2", "start_blob_key": str(ints[0]), "end_blob_key": str(ints[-1])},
        )
        events = _parse_lines(res.text)
    else:
        # Older recordings: one request per blob source.
        for s in sources:
            if s.get("source") != "blob":
                continue
            res = await _request("GET", path, params={"source": "blob", "blob_key": s.get("blob_key")})
            events.extend(_parse_lines(res.text))
        events.sort(key=lambda e: e.get("timestamp") or 0)
    return _store(key, events)
