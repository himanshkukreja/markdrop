"""Admin Journeys: who visits, what they do, where they click, and their replays, from PostHog.

The queries and the pure model (event → label, sessions → paths and funnel) live here; the
transport (queue, cache, retry, error mapping) is services/posthog_api.py and the routes are
routers/admin_journeys.py.

Documents. PostHog never sees a slug: document pages arrive as `$pathname = "/[slug]"` with an
opaque `doc_ref` (services/doc_ref.py). Everything that aggregates pages keys a document page as
`doc:<ref>`, so two documents never collapse into one "/[slug]" row, and the admin resolves the
ref to the document's title and link from our own database. A ref is only trusted on a
"/[slug]" page view: other pages must never be counted as a document.
"""

import asyncio
import json
import re
from collections import Counter
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote, urlparse

from app.config import get_settings
from app.services import posthog_api as ph

settings = get_settings()

# ref → {slug, title, kind, encrypted} (services/doc_ref.resolve_refs)
DocResolver = Callable[[set[str]], Awaitable[dict[str, dict]]]

# ── Filters shared by every query ────────────────────────────────────────────

# Bookkeeping, not something a person did.
NOISE = (
    "$snapshot", "$heatmap", "$$heatmap", "$feature_flag_called", "$web_vitals", "$set", "$groupidentify",
    "$identify", "$opt_in", "$pageleave", "$dead_clicks_get_config", "$feature_view", "$feature_interaction",
    "$autocapture_config", "survey shown",
)
NOISE_SQL = "(" + ", ".join("'" + e.replace("'", "\\'") + "'" for e in NOISE) + ")"


def not_local() -> str:
    """Local development traffic is tagged by host and hidden unless MARKDROP_POSTHOG_INCLUDE_LOCAL."""
    if settings.posthog_include_local:
        return "1 = 1"
    return "NOT (properties.$host LIKE 'localhost%' OR properties.$host LIKE '127.0.0.1%')"


DAY_CHOICES = (1, 7, 30, 90)


def clamp_days(v: Any, fallback: int) -> int:
    try:
        n = int(v)
    except (TypeError, ValueError):
        return fallback
    return n if n in DAY_CHOICES else fallback


_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_REF = re.compile(r"^[0-9a-f]{8,32}$")


def is_uuid(v: str | None) -> bool:
    return bool(v and _UUID.match(v))


# ── Pages: route shapes and documents ────────────────────────────────────────

# A page view's key: documents by ref, everything else by its route shape.
PATH_KEY = (
    "if(properties.$pathname = '/[slug]' AND notEmpty(toString(properties.doc_ref)), "
    "concat('doc:', toString(properties.doc_ref)), toString(properties.$pathname))"
)

APP_TITLES = {
    "/": "Home",
    "/new": "Editor",
    "/upload": "Upload a file",
    "/builder": "README builder",
    "/share": "Share files",
    "/share/[id]": "Share room",
    "/dashboard": "Dashboard",
    "/login": "Sign in",
    "/enterprise": "Enterprise",
    "/privacy": "Privacy",
    "/invite/[token]": "Workspace invite",
    "/extension": "VS Code extension",
    "/extension/authorize": "VS Code · authorize",
    "/settings": "Settings",
    "/[slug]": "A document",
    "/h/[workspace-doc]": "A workspace document",
}

# Pages where people start making something: the funnel's second step.
CREATOR_PATHS = ("/new", "/upload", "/builder")


def app_title(path: str | None) -> str | None:
    if not path:
        return None
    p = path.split("?")[0].split("#")[0]
    if len(p) > 1:
        p = p.rstrip("/")
    if p in APP_TITLES:
        return APP_TITLES[p]
    if p.startswith("/settings/"):
        return "Settings · " + p.split("/", 2)[2].replace("-", " ")
    if p.startswith("/auth"):
        return "Sign-in"
    return None


def page_filter(key: str) -> tuple[str, dict]:
    """A WHERE clause matching page views of a page key, and its values."""
    if key.startswith("doc:"):
        return "properties.$pathname = '/[slug]' AND properties.doc_ref = {ref}", {"ref": key[4:]}
    return "properties.$pathname = {path}", {"path": key}


def valid_page_key(key: str) -> bool:
    if key.startswith("doc:"):
        return bool(_REF.match(key[4:]))
    return key.startswith("/") and len(key) <= 300


def doc_label(doc: dict | None) -> str:
    if not doc or not doc.get("slug"):
        return "Unknown document"
    if doc.get("encrypted"):
        return "Encrypted document"
    return (doc.get("title") or "").strip() or "Untitled document"


class Pages:
    """Turns page keys into the page objects the console renders, resolving documents once."""

    def __init__(self, resolve: DocResolver):
        self._resolve = resolve
        self.docs: dict[str, dict] = {}

    async def load(self, keys: list[str | None] | set[str | None], refs: set[str] | None = None) -> None:
        want = {k[4:] for k in keys if k and k.startswith("doc:")} | (refs or set())
        want = {r for r in want if r and r not in self.docs}
        if want:
            self.docs.update(await self._resolve(want))

    def doc(self, ref: str | None, kind: str | None = None, access: str | None = None) -> dict | None:
        if not ref:
            return None
        d = self.docs.get(ref)
        out = {
            "ref": ref,
            "slug": d.get("slug") if d else None,
            "title": doc_label(d),
            "kind": (d.get("kind") if d else None) or kind or "document",
            "encrypted": bool(d.get("encrypted")) if d else access == "encrypted",
        }
        if access:
            out["access"] = access
        return out

    def page(self, key: str | None, *, kind: str | None = None, access: str | None = None) -> dict | None:
        if not key:
            return None
        if key.startswith("doc:"):
            doc = self.doc(key[4:], kind, access)
            return {"key": key, "path": "/[slug]", "title": doc["title"] if doc else "A document", "doc": doc}
        return {"key": key, "path": key, "title": app_title(key), "doc": None}


# ── Event → label ────────────────────────────────────────────────────────────

# Columns pulled for every timeline/stream row (positional, after the head columns).
EVENT_PROPS = (
    "$session_id", "$pathname", "$el_text", "$event_type", "doc_ref", "doc_kind", "doc_access",
    "pct", "engaged_sec", "est_minutes", "depth", "seconds",
    "access", "encrypted", "expires", "password", "workspace", "source", "sections", "from", "files", "of",
    "toy", "id", "n", "how", "section",
    "$exception_message", "$exception_type", "$geoip_country_code", "$geoip_city_name", "$device_type", "$browser",
)


def event_props_select() -> str:
    return ", ".join(f"properties.{p} AS p{i}" for i, p in enumerate(EVENT_PROPS))


def props_from(row: dict) -> dict:
    out: dict[str, Any] = {}
    for i, p in enumerate(EVENT_PROPS):
        v = row.get(f"p{i}")
        if v is None or v == "":
            continue
        out[p] = v
    return out


_SPLIT = re.compile(r";(?=[a-zA-Z0-9_-]+[.:])")
_TAG = re.compile(r"^([a-zA-Z0-9_-]+)")
_TEXT = re.compile(r'(?:^|[":])text="((?:[^"\\]|\\.)*)"')
_HREF = re.compile(r'(?:attr__href|href)="((?:[^"\\]|\\.)*)"')
_ARIA = re.compile(r'attr__aria-label="((?:[^"\\]|\\.)*)"')


def parse_elements(chain: str | None) -> dict:
    """PostHog `elements_chain`: elements from the clicked one outwards, `;`-separated, e.g.
    `button.btn:text="Publish"nth-child="2"attr__href="/new";div.wrap:nth-child="1"`."""
    if not chain:
        return {"tag": None, "text": None, "href": None}
    parts = _SPLIT.split(chain)
    first = parts[0] if parts else ""
    m = _TAG.match(first)
    tag = m.group(1) if m else None
    text = None
    for p in parts[:4]:
        m = _TEXT.search(p)
        if m and m.group(1).strip():
            text = m.group(1).replace('\\"', '"').strip()
            break
    if not text:
        # Icon buttons: the accessible name is the label.
        for p in parts[:3]:
            m = _ARIA.search(p)
            if m and m.group(1).strip():
                text = m.group(1).replace('\\"', '"').strip()
                break
    href = None
    for p in parts[:4]:
        m = _HREF.search(p)
        if m:
            href = m.group(1)
            break
    return {"tag": tag, "text": text, "href": href}


def clip(s: Any, n: int = 60) -> str:
    s = re.sub(r"\s+", " ", str(s)).strip()
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def truthy(v: Any) -> bool:
    return v is True or v == "true" or v == 1


def _num(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _secs(v: Any) -> str | None:
    n = _num(v)
    if n is None:
        return None
    n = round(n)
    return f"{n}s" if n < 90 else f"{n // 60} min {n % 60:02d}s" if n < 3600 else f"{n // 3600} h {(n % 3600) // 60} min"


TOYS = {
    "linkforge": "link forge", "keylab": "key lab", "syncdesk": "sync desk", "sendsim": "send simulator",
    "domainstudio": "domain studio", "renderbench": "render bench",
}


def _humanize(name: str) -> str:
    return name.lstrip("$").replace("_", " ").strip() or "event"


def describe(event: str, p: dict, chain: str | None, page: dict | None) -> dict:
    """One event as a person's timeline reads it: {kind, label, detail}."""
    title = (page or {}).get("title")
    path = p.get("$pathname")
    is_doc = bool(page and page.get("doc"))
    where = title if title else path
    doc_name = page["doc"]["title"] if is_doc else None
    artifact = is_doc and page["doc"].get("kind") == "artifact"

    def el() -> dict:
        e = parse_elements(chain)
        text = p.get("$el_text") or e["text"]
        return {"text": clip(text, 60) if text else None, "tag": e["tag"], "href": e["href"]}

    if event == "$pageview":
        if is_doc:
            access = p.get("doc_access")
            detail = " · ".join(x for x in ("file" if artifact else None, access if access and access != "public" else None) if x) or None
            return {"kind": "pageview", "label": f"Opened {'file ' if artifact else ''}“{clip(doc_name, 80)}”", "detail": detail}
        if title:
            return {"kind": "pageview", "label": f"Viewed “{title}”", "detail": path}
        return {"kind": "pageview", "label": f"Viewed {path}" if path else "Viewed a page", "detail": None}

    if event == "$autocapture":
        kind = p.get("$event_type")
        e = el()
        if kind == "submit":
            return {"kind": "form", "label": "Submitted a form", "detail": where}
        if kind == "change":
            return {"kind": "form", "label": "Changed a dropdown" if e["tag"] == "select" else "Changed an input", "detail": where}
        if kind in ("copy", "cut"):
            return {"kind": "click", "label": "Copied text", "detail": where}
        label = f"Clicked “{e['text']}”" if e["text"] else f"Clicked a {e['tag']}" if e["tag"] else "Clicked something"
        parts = []
        if e["href"] and e["href"] != path:
            parts.append(f"→ {clip(e['href'], 70)}")
        if where:
            parts.append(str(where))
        return {"kind": "click", "label": label, "detail": " · ".join(parts) or None}

    if event in ("$rageclick", "$dead_click"):
        e = el()
        target = f"“{e['text']}”" if e["text"] else e["tag"] or "an element"
        label = f"Rage-clicked {target}" if event == "$rageclick" else f"Dead click on {target}"
        return {"kind": "rage", "label": label, "detail": where}

    if event == "read_progress":
        pct = _num(p.get("pct"))
        what = f"“{clip(doc_name, 70)}”" if doc_name else "a document"
        bits = [f"{_secs(p.get('engaged_sec'))} engaged" if p.get("engaged_sec") is not None else None,
                f"~{int(_num(p.get('est_minutes')) or 0)} min read" if p.get("est_minutes") is not None else None]
        return {"kind": "read", "label": f"Read {int(pct) if pct is not None else '?'}% of {what}", "detail": " · ".join(b for b in bits if b) or None}

    if event == "document_read":
        what = f"“{clip(doc_name, 70)}”" if doc_name else "a document"
        secs = _secs(p.get("seconds"))
        depth = _num(p.get("depth"))
        return {
            "kind": "read",
            "label": f"Read {what}" + (f" for {secs}" if secs else ""),
            "detail": f"got {int(depth)}% of the way down" if depth is not None else None,
        }

    if event == "doc_published":
        flags = [p.get("access") or None]
        flags += [name for name, key in (("end-to-end encrypted", "encrypted"), ("password", "password"), ("expires", "expires"), ("in a workspace", "workspace")) if truthy(p.get(key))]
        return {"kind": "publish", "label": "Published a document", "detail": " · ".join(str(f) for f in flags if f) or None}
    if event == "artifact_uploaded":
        bits = [f"from {p['source']}" if p.get("source") else None, p.get("access"), "in a workspace" if truthy(p.get("workspace")) else None]
        return {"kind": "publish", "label": "Uploaded a file", "detail": " · ".join(str(b) for b in bits if b) or None}
    if event == "builder_published":
        n = _num(p.get("sections"))
        return {"kind": "publish", "label": "Published a README from the builder", "detail": f"{int(n)} sections" if n is not None else None}
    if event == "doc_copy_link":
        return {"kind": "share", "label": f"Copied the link to {f'“{clip(doc_name, 60)}”' if doc_name else 'a document'}", "detail": None}
    if event == "doc_export_pdf":
        return {"kind": "export", "label": f"Exported {f'“{clip(doc_name, 60)}”' if doc_name else 'a document'} as PDF", "detail": None}
    if event == "google_docs_export":
        return {"kind": "export", "label": "Exported to Google Docs", "detail": f"from the {p['from']}" if p.get("from") else None}
    if event == "share_download":
        files, of = _num(p.get("files")), _num(p.get("of"))
        return {"kind": "export", "label": "Downloaded shared files", "detail": f"{int(files)} of {int(of)} files" if files is not None and of is not None else None}
    if event == "workspace_created":
        return {"kind": "connect", "label": "Created a workspace", "detail": None}
    if event == "vscode_connected":
        return {"kind": "connect", "label": "Connected VS Code", "detail": None}
    if event == "logged_in":
        return {"kind": "signin", "label": "Signed in", "detail": where}
    if event == "$identify":
        return {"kind": "signin", "label": "Identified (signed in)", "detail": None}
    if event == "landing_cta":
        bits = [p.get("id"), f"in {p['section']}" if p.get("section") else None]
        return {"kind": "cta", "label": "Clicked a call to action", "detail": " · ".join(str(b) for b in bits if b) or None}
    if event == "hero_play":
        return {"kind": "play", "label": "Played the hero", "detail": f"by {p['how']}" if p.get("how") else None}
    if event == "hero_found":
        n = _num(p.get("n"))
        return {"kind": "play", "label": f"Found “{p.get('id') or 'a feature'}” in the hero", "detail": f"{int(n)} found so far" if n is not None else None}
    if event == "hero_finale":
        return {"kind": "play", "label": "Finished the hero game", "detail": None}
    if event in ("toy_play", "toy_done"):
        toy = TOYS.get(str(p.get("toy") or ""), str(p.get("toy") or "a")).strip()
        return {"kind": "play", "label": f"{'Played' if event == 'toy_play' else 'Finished'} the {toy} demo", "detail": where}
    if event == "$exception":
        msg = p.get("$exception_message") or p.get("$exception_type")
        return {"kind": "error", "label": "Hit a JS error", "detail": clip(msg, 90) if msg else where}
    return {"kind": "event", "label": _humanize(event), "detail": where}


def event_page_key(event: str, p: dict) -> str | None:
    """The page an event happened on. A ref only counts on a document page view's route."""
    path = p.get("$pathname")
    if not isinstance(path, str) or not path:
        return None
    if path == "/[slug]" and p.get("doc_ref"):
        return f"doc:{p['doc_ref']}"
    return path


def who_of(email: Any, name: Any, distinct: Any, person: Any) -> str:
    if email:
        return str(email)
    if name:
        return str(name)
    if distinct:
        return f"anon {str(distinct)[-6:]}"
    if person:
        return f"anon {str(person)[-6:]}"
    return "anonymous"


def _iso(v: Any) -> str | None:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v)


async def _timeline_rows(rows: list[dict], pages: Pages) -> list[dict]:
    """Shared by the live stream and a person's timeline: rows → described events."""
    parsed = [(r, props_from(r)) for r in rows]
    keys = {event_page_key(r["event"], p) for r, p in parsed}
    refs = {str(p["doc_ref"]) for _, p in parsed if p.get("doc_ref") and p.get("$pathname") == "/[slug]"}
    await pages.load(keys, refs)
    out = []
    for r, p in parsed:
        key = event_page_key(r["event"], p)
        page = pages.page(key, kind=p.get("doc_kind"), access=p.get("doc_access"))
        d = describe(r["event"], p, r.get("chain"), page)
        out.append(
            {
                "id": r["uuid"],
                "t": _iso(r["timestamp"]),
                "event": r["event"],
                **d,
                "page": page,
                "session": p.get("$session_id"),
                "_p": p,
            }
        )
    return out


# ── Live ─────────────────────────────────────────────────────────────────────

STREAM_HEAD = (
    "toString(uuid) AS uuid, event, timestamp, elements_chain AS chain, toString(person_id) AS person_id, "
    "distinct_id, person.properties.email AS email, person.properties.name AS name"
)


async def live(resolve: DocResolver) -> dict:
    nl = not_local()
    count_q = ph.hogql(
        f"SELECT count(DISTINCT person_id) AS n FROM events WHERE timestamp > now() - INTERVAL 5 MINUTE AND {nl}",
        name="live_count", ttl=10,
    )
    pages_q = ph.hogql(
        f"""SELECT {PATH_KEY} AS path, count(DISTINCT person_id) AS n FROM events
            WHERE event = '$pageview' AND timestamp > now() - INTERVAL 5 MINUTE AND {nl}
            GROUP BY path ORDER BY n DESC LIMIT 10""",
        name="live_pages", ttl=10,
    )
    stream_q = ph.hogql(
        f"""SELECT {STREAM_HEAD}, {event_props_select()} FROM events
            WHERE timestamp > now() - INTERVAL 1 DAY AND event NOT IN {NOISE_SQL} AND {nl}
            ORDER BY timestamp DESC LIMIT 60""",
        name="live_stream", ttl=10,
    )
    count, live_pages, stream = await asyncio.gather(count_q, pages_q, stream_q)
    pages = Pages(resolve)
    await pages.load({r["path"] for r in live_pages})
    events = []
    for e, r in zip(await _timeline_rows(stream, pages), stream):
        p = e.pop("_p")
        events.append(
            {
                **e,
                "person_id": r.get("person_id"),
                "who": who_of(r.get("email"), r.get("name"), r.get("distinct_id"), r.get("person_id")),
                "identified": bool(r.get("email")),
                "country": p.get("$geoip_country_code"),
                "city": p.get("$geoip_city_name"),
                "device": p.get("$device_type"),
            }
        )
    return {
        "configured": True,
        "live": int((count[0] if count else {}).get("n") or 0),
        "pages": [{"page": pages.page(r["path"]), "n": int(r["n"])} for r in live_pages if r.get("path")],
        "events": events,
    }


# ── People ───────────────────────────────────────────────────────────────────

PEOPLE_LIMIT = 300


async def people(resolve: DocResolver, days: int, kind: str, q: str | None) -> dict:
    where = ""
    values: dict[str, Any] = {}
    if q:
        where = (
            "AND (toString(person.properties.email) ILIKE {q} OR toString(person.properties.name) ILIKE {q}"
            " OR distinct_id ILIKE {q} OR toString(person_id) ILIKE {q}"
            " OR properties.$geoip_country_code ILIKE {q} OR properties.$geoip_city_name ILIKE {q})"
        )
        values["q"] = f"%{q[:80]}%"
    having = ""
    if kind == "identified":
        having = "HAVING email IS NOT NULL AND email != ''"
    elif kind == "anonymous":
        having = "HAVING email IS NULL OR email = ''"
    rows = await ph.hogql(
        f"""
        SELECT toString(person_id) AS id,
            any(distinct_id) AS did,
            any(person.properties.email) AS email,
            any(person.properties.name) AS name,
            any(person.created_at) AS created,
            min(timestamp) AS first_event,
            max(timestamp) AS last_seen,
            count(DISTINCT properties.$session_id) AS sessions,
            countIf(event = '$pageview') AS pageviews,
            count() AS n,
            argMax(properties.$geoip_country_code, timestamp) AS country,
            argMax(properties.$geoip_city_name, timestamp) AS city,
            argMax(properties.$device_type, timestamp) AS device,
            argMax(properties.$browser, timestamp) AS browser,
            argMax(properties.$os, timestamp) AS os,
            argMin(properties.$referring_domain, timestamp) AS referrer,
            topK(3)(if(event = '$pageview', {PATH_KEY}, NULL)) AS top_pages
          FROM events
          WHERE timestamp > now() - INTERVAL {days} DAY AND event NOT IN {NOISE_SQL} AND {not_local()} {where}
          GROUP BY person_id
          {having}
          ORDER BY last_seen DESC
          LIMIT {PEOPLE_LIMIT}
        """,
        values or None,
        name="people",
        ttl=30,
    )
    pages = Pages(resolve)
    await pages.load({k for r in rows for k in (r.get("top_pages") or []) if k})
    out = []
    for r in rows:
        ref = r.get("referrer")
        out.append(
            {
                "id": r["id"],
                "distinct_id": r.get("did"),
                "email": r.get("email") or None,
                "name": r.get("name") or None,
                "identified": bool(r.get("email")),
                "first_seen": min(x for x in (_iso(r.get("created")), _iso(r.get("first_event")), _iso(r.get("last_seen"))) if x),
                "last_seen": _iso(r.get("last_seen")),
                "sessions": int(r.get("sessions") or 0),
                "pageviews": int(r.get("pageviews") or 0),
                "events": int(r.get("n") or 0),
                "country": r.get("country"),
                "city": r.get("city"),
                "device": r.get("device"),
                "browser": r.get("browser"),
                "os": r.get("os"),
                "referrer": "direct" if ref == "$direct" else ref,
                "top_pages": [pages.page(k) for k in (r.get("top_pages") or []) if k],
            }
        )
    return {"configured": True, "people": out, "days": days, "capped": len(out) >= PEOPLE_LIMIT}


# ── Recordings ───────────────────────────────────────────────────────────────

RECORDINGS_PAGE = 50
_LOCAL_HOSTS = ("localhost", "127.0.0.1")


def _start_key(url: Any) -> str | None:
    if not url:
        return None
    try:
        return urlparse(str(url)).path or "/"
    except ValueError:
        return None


def _local_url(url: Any) -> bool:
    try:
        return (urlparse(str(url)).hostname or "") in _LOCAL_HOSTS
    except ValueError:
        return False


async def _session_extras(ids: list[str]) -> dict[str, dict]:
    """Pages in visit order, page views, rage and dead clicks, per session (≤200 ids)."""
    ids = [i for i in ids if is_uuid(i)][:200]
    if not ids:
        return {}
    in_list = ", ".join(f"'{i}'" for i in ids)
    try:
        rows = await ph.hogql(
            f"""
            SELECT properties.$session_id AS sid,
                arrayMap(x -> x.2, arraySort(x -> x.1, groupArrayIf(tuple(timestamp, {PATH_KEY}), event = '$pageview'))) AS pages,
                countIf(event = '$pageview') AS pv,
                countIf(event = '$rageclick') AS rage,
                countIf(event = '$dead_click') AS dead
              FROM events
              WHERE properties.$session_id IN ({in_list}) AND timestamp > now() - INTERVAL 90 DAY
              GROUP BY sid
            """,
            name="session_extras",
            ttl=60,
        )
    except ph.PostHogError:
        return {}
    out = {}
    for r in rows:
        trail: list[str] = []
        for k in r.get("pages") or []:
            if k and (not trail or trail[-1] != k):
                trail.append(k)
        out[r["sid"]] = {"pages": trail, "pv": int(r.get("pv") or 0), "rage": int(r.get("rage") or 0), "dead": int(r.get("dead") or 0)}
    return out


def _expires_soon(r: dict) -> bool:
    exp = r.get("expiry_time")
    now = datetime.now(timezone.utc)
    try:
        if exp:
            return datetime.fromisoformat(str(exp).replace("Z", "+00:00")) - now < timedelta(days=5)
        start = datetime.fromisoformat(str(r.get("start_time")).replace("Z", "+00:00"))
        return now - start > timedelta(days=25)
    except ValueError:
        return False


def _map_recording(r: dict, extras: dict, pages: Pages) -> dict:
    person = r.get("person") or {}
    pprops = person.get("properties") or {}
    x = extras.get(r.get("id") or "", {})
    start_key = _start_key(r.get("start_url"))
    trail = x.get("pages") or ([start_key] if start_key else [])
    return {
        "id": r.get("id"),
        "start": r.get("start_time"),
        "end": r.get("end_time"),
        "duration": int(r.get("recording_duration") or 0),
        "active": int(r.get("active_seconds") or 0),
        "clicks": int(r.get("click_count") or 0),
        "keys": int(r.get("keypress_count") or 0),
        "errors": int(r.get("console_error_count") or 0),
        "start_page": pages.page(start_key),
        "person_id": person.get("uuid"),
        "who": who_of(pprops.get("email"), pprops.get("name"), r.get("distinct_id"), person.get("uuid")),
        "identified": bool(pprops.get("email")),
        "ongoing": bool(r.get("ongoing")),
        "viewed": bool(r.get("viewed")),
        "pages": [pages.page(k) for k in trail[:6]],
        "more_pages": max(0, len(trail) - 6),
        "pageviews": x.get("pv") or len(trail),
        "rage": x.get("rage", 0),
        "dead": x.get("dead", 0),
        "expires_soon": _expires_soon(r),
        "app_url": ph.app_url(f"/replay/{r.get('id')}"),
    }


async def _sessions_on_page(key: str, days: int) -> list[str]:
    cond, values = page_filter(key)
    rows = await ph.hogql(
        f"""SELECT properties.$session_id AS sid, max(timestamp) AS t FROM events
            WHERE event = '$pageview' AND {cond} AND timestamp > now() - INTERVAL {days} DAY
              AND notEmpty(toString(properties.$session_id))
            GROUP BY sid ORDER BY t DESC LIMIT 200""",
        values,
        name="sessions_on_page",
        ttl=60,
    )
    return [r["sid"] for r in rows if is_uuid(r.get("sid"))]


async def recordings(
    resolve: DocResolver, *, days: int, offset: int = 0, person: str | None = None, path: str | None = None,
    limit: int = RECORDINGS_PAGE,
) -> dict:
    params: dict[str, Any] = {"limit": limit, "offset": offset, "date_from": f"-{days}d"}
    if person:
        params["person_uuid"] = person
    pages = Pages(resolve)
    filter_page = None
    if path:
        await pages.load({path})
        filter_page = pages.page(path)
        # Filter before paging (PostHog accepts the session ids), so every page is full.
        sids = await _sessions_on_page(path, days)
        if not sids:
            return {"configured": True, "recordings": [], "has_next": False, "filter_page": filter_page}
        params["session_ids"] = json.dumps(sids)
    data = await ph.list_recordings(params)
    results = [r for r in data.get("results") or [] if isinstance(r, dict)]
    if person:
        results = [r for r in results if (r.get("person") or {}).get("uuid") in (None, person)]
    if not settings.posthog_include_local:
        results = [r for r in results if not _local_url(r.get("start_url"))]
    extras = await _session_extras([r.get("id") for r in results if r.get("id")])
    await pages.load({k for x in extras.values() for k in x["pages"]} | {_start_key(r.get("start_url")) for r in results})
    has_next = data.get("has_next")
    if has_next is None:
        has_next = bool(data.get("next"))
    return {
        "configured": True,
        "recordings": [_map_recording(r, extras, pages) for r in results],
        "has_next": bool(has_next),
        "filter_page": filter_page,
    }


# ── Person ───────────────────────────────────────────────────────────────────

EVENT_LIMIT = 1500
_OBJECT_ID = re.compile(r"^[0-9a-f]{24}$")


async def resolve_person(raw: str) -> str | None:
    """A PostHog person id from a person id or any distinct id (a Markdrop user id included)."""
    raw = raw.strip()[:200]
    if not raw:
        return None

    async def run() -> str | None:
        rows = await ph.hogql(
            "SELECT toString(person_id) AS id FROM person_distinct_ids WHERE distinct_id = {d} LIMIT 1",
            {"d": raw},
            name="resolve_person",
            ttl=300,
        )
        if rows and rows[0].get("id"):
            return rows[0]["id"]
        return raw.lower() if is_uuid(raw) else None

    return await ph.cached(f"resolve:{raw}", 300, run)


def _parse_props(v: Any) -> dict:
    if isinstance(v, dict):
        return v
    if isinstance(v, str):
        try:
            out = json.loads(v)
            return out if isinstance(out, dict) else {}
        except ValueError:
            return {}
    return {}


async def person(resolve: DocResolver, find_account: Callable[[list[str], str | None], Awaitable[dict | None]], raw_id: str, days: int) -> dict | None:
    pid = await resolve_person(raw_id)
    if not pid:
        return None
    info_q = ph.hogql(
        "SELECT toString(id) AS id, created_at, properties FROM persons WHERE id = {id} LIMIT 1",
        {"id": pid},
        name="person_info",
        ttl=60,
    )
    ids_q = ph.hogql(
        "SELECT distinct_id FROM person_distinct_ids WHERE person_id = {id} LIMIT 50",
        {"id": pid},
        name="person_ids",
        ttl=60,
    )
    events_q = ph.hogql(
        f"""SELECT toString(uuid) AS uuid, event, timestamp, elements_chain AS chain, {event_props_select()}
            FROM events
            WHERE person_id = {{id}} AND timestamp > now() - INTERVAL {days} DAY AND event NOT IN {NOISE_SQL} AND {not_local()}
            ORDER BY timestamp DESC LIMIT {EVENT_LIMIT}""",
        {"id": pid},
        name="person_events",
        ttl=30,
    )

    async def recs() -> tuple[list[dict], dict | None]:
        try:
            r = await recordings(resolve, days=max(days, 30), person=pid)
            return r["recordings"], None
        except ph.PostHogError as e:
            return [], {"error": e.message, "scope": e.scope}

    info_rows, id_rows, rows, (recs_list, recs_error) = await asyncio.gather(info_q, ids_q, events_q, recs())
    info = info_rows[0] if info_rows else None
    if not info and not rows:
        return None
    props = _parse_props(info.get("properties") if info else None)
    pages = Pages(resolve)
    events = await _timeline_rows(rows, pages)
    for e in events:
        e.pop("_p", None)
    distinct_ids = [str(r.get("distinct_id")) for r in id_rows if r.get("distinct_id")]
    # Signed-in people are identified by their Markdrop user id.
    user_id = next((d for d in distinct_ids if _OBJECT_ID.match(d)), None)
    email = props.get("email") or None
    account = await find_account(distinct_ids, email)
    ref = props.get("$initial_referring_domain")
    distinct = user_id or (distinct_ids[0] if distinct_ids else None)
    return {
        "configured": True,
        "person": {
            "id": pid,
            "distinct_id": distinct,
            "email": email,
            "name": props.get("name") or None,
            "identified": bool(email),
            "created_at": _iso(info.get("created_at")) if info else None,
            "country": props.get("$geoip_country_code"),
            "city": props.get("$geoip_city_name"),
            "device": props.get("$device_type"),
            "browser": props.get("$browser"),
            "os": props.get("$os"),
            "referrer": "direct" if ref == "$direct" else ref,
            "app_url": ph.app_url(f"/person/{quote(distinct or pid, safe='')}"),
            "account": account,
        },
        "events": events,
        "recordings": recs_list,
        "recordings_error": recs_error,
        "days": days,
        "truncated": len(rows) >= EVENT_LIMIT,
    }


# ── Paths & funnel ───────────────────────────────────────────────────────────

FUNNEL_STEPS = (
    {"key": "land", "label": "Landed"},
    {"key": "creator", "label": "Opened a creator"},
    {"key": "publish", "label": "Published"},
    {"key": "share", "label": "Shared a link"},
    {"key": "signin", "label": "Signed in"},
)
PUBLISH_EVENTS = ("doc_published", "artifact_uploaded", "builder_published")
FUNNEL_EVENTS = ("$pageview", *PUBLISH_EVENTS, "doc_copy_link", "logged_in")


def _step_hit(step: str, event: str, path: str | None) -> bool:
    if step == "land":
        return event == "$pageview"
    if step == "creator":
        return event == "$pageview" and path in CREATOR_PATHS
    if step == "publish":
        return event in PUBLISH_EVENTS
    if step == "share":
        return event == "doc_copy_link"
    if step == "signin":
        return event == "logged_in"
    return False


def compute_paths(rows: list[tuple[str, str, str | None, str | None, str]], days: int) -> dict:
    """rows: (event, person, session, page key, iso time). Sessions → entry/exit pages, the most
    common first-4-page paths, an ordered funnel and page views."""
    ordered = sorted(rows, key=lambda r: r[4] or "")
    sessions: dict[str, list[str]] = {}
    views: Counter[str] = Counter()
    visitors: dict[str, set[str]] = {}
    furthest: dict[str, int] = {}
    for event, person, session, path, _t in ordered:
        if event == "$pageview" and path:
            sid = session or f"p:{person}"
            seq = sessions.setdefault(sid, [])
            if not seq or seq[-1] != path:
                seq.append(path)
            views[path] += 1
            visitors.setdefault(path, set()).add(person)
        # Ordered funnel: a step counts only after the previous one (one step per event at most).
        at = furthest.get(person, -1)
        nxt = at + 1
        if nxt < len(FUNNEL_STEPS) and _step_hit(FUNNEL_STEPS[nxt]["key"], event, path):
            furthest[person] = nxt
    seqs = list(sessions.values())
    entries = Counter(s[0] for s in seqs if s)
    exits = Counter(s[-1] for s in seqs if s)
    path_counts: Counter[tuple[str, ...]] = Counter(tuple(s[:4]) for s in seqs if len(s) > 1)
    funnel = [
        {**step, "n": sum(1 for v in furthest.values() if v >= i)}
        for i, step in enumerate(FUNNEL_STEPS)
    ]
    return {
        "days": days,
        "sessions": len(seqs),
        "entries": entries.most_common(12),
        "exits": exits.most_common(8),
        "paths": path_counts.most_common(12),
        "funnel": funnel,
        "pages": sorted(((k, views[k], len(visitors[k])) for k in views), key=lambda x: (-x[1], -x[2]))[:30],
    }


async def paths(resolve: DocResolver, days: int) -> dict:
    events_sql = ", ".join(f"'{e}'" for e in FUNNEL_EVENTS)
    rows = await ph.hogql(
        f"""SELECT event, toString(person_id) AS person, properties.$session_id AS session, {PATH_KEY} AS path, timestamp
            FROM events
            WHERE timestamp > now() - INTERVAL {days} DAY AND event IN ({events_sql}) AND {not_local()}
            ORDER BY timestamp ASC
            LIMIT 50000""",
        name="paths",
        ttl=300,
    )
    res = compute_paths([(r["event"], r["person"], r.get("session"), r.get("path"), _iso(r.get("timestamp")) or "") for r in rows], days)
    keys = {k for k, _ in res["entries"]} | {k for k, _ in res["exits"]} | {k for p, _ in res["paths"] for k in p} | {k for k, _, _ in res["pages"]}
    pages = Pages(resolve)
    await pages.load(keys)
    return {
        "configured": True,
        "days": days,
        "sessions": res["sessions"],
        "people": res["funnel"][0]["n"],
        "truncated": len(rows) >= 50000,
        "entries": [{"page": pages.page(k), "n": n} for k, n in res["entries"]],
        "exits": [{"page": pages.page(k), "n": n} for k, n in res["exits"]],
        "paths": [{"steps": [pages.page(k) for k in steps], "n": n} for steps, n in res["paths"]],
        "funnel": res["funnel"],
        "pages": [{"page": pages.page(k), "views": v, "visitors": u} for k, v, u in res["pages"]],
    }


# ── Page detail ──────────────────────────────────────────────────────────────


def site_url() -> str:
    """The public site, as PostHog recorded it ($current_url): the apex redirects to www."""
    base = settings.frontend_url.rstrip("/")
    host = urlparse(base).hostname or ""
    return base.replace("://markdrop.in", "://www.markdrop.in") if host == "markdrop.in" else base


async def page(resolve: DocResolver, key: str, days: int) -> dict:
    cond, values = page_filter(key)
    clicks_q = ph.hogql(
        f"""SELECT coalesce(properties.$el_text, '') AS text, any(elements_chain) AS chain,
                countIf(event = '$autocapture') AS n, countIf(event = '$rageclick') AS rage, countIf(event = '$dead_click') AS dead
            FROM events
            WHERE event IN ('$autocapture', '$rageclick', '$dead_click') AND {cond}
              AND timestamp > now() - INTERVAL {days} DAY AND {not_local()}
            GROUP BY text ORDER BY n + rage DESC LIMIT 20""",
        values,
        name="page_clicks",
        ttl=300,
    )
    is_doc = key.startswith("doc:")

    async def depth() -> list[dict] | None:
        if not is_doc:
            return None
        rows = await ph.hogql(
            f"""SELECT toInt(properties.pct) AS pct, count(DISTINCT person_id) AS readers FROM events
                WHERE event = 'read_progress' AND properties.doc_ref = {{ref}}
                  AND timestamp > now() - INTERVAL {days} DAY AND {not_local()}
                GROUP BY pct ORDER BY pct""",
            {"ref": key[4:]},
            name="page_depth",
            ttl=300,
        )
        got = {int(r["pct"]): int(r["readers"]) for r in rows if r.get("pct") is not None}
        return [{"pct": p, "readers": got.get(p, 0)} for p in (25, 50, 75, 100)]

    click_rows, depth_rows = await asyncio.gather(clicks_q, depth())
    pages = Pages(resolve)
    await pages.load({key})
    clicks = []
    for r in click_rows:
        el = parse_elements(r.get("chain"))
        text = (r.get("text") or "").strip() or el["text"]
        clicks.append(
            {
                "text": clip(text, 80) if text else f"({el['tag'] or 'element'} without text)",
                "tag": el["tag"],
                "n": int(r.get("n") or 0),
                "rage": int(r.get("rage") or 0),
                "dead": int(r.get("dead") or 0),
            }
        )
    site = site_url()
    return {
        "configured": True,
        "page": pages.page(key),
        "days": days,
        "clicks": clicks,
        "depth": depth_rows,
        # Document pages are never recorded and their URLs are never sent: no overlay for them.
        "heatmap_url": None if is_doc else ph.app_url(f"/heatmaps?pageURL={quote(site + key, safe='')}"),
        "toolbar_url": ph.app_url("/toolbar"),
        "site_url": None if is_doc or "[" in key else site + key,
    }
