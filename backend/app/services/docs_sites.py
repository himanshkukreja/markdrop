"""Docs sites: which docs folders Ask AI serves, and what each one says about itself.

Ask AI is one engine for any number of docs sites. A site is a content folder
(Markdown pages plus ``site.json``, optional ``changelog.json``,
``videos.json`` and ``ai.json``) registered under a short id:

    MARKDROP_DOCS_SITES='{"acme": "/srv/docs/acme"}'      # JSON object
    MARKDROP_DOCS_SITES='acme=/srv/docs/acme,beta=/x'      # or id=dir pairs

"markdrop" is always registered (settings.docs_content_dir, or the repo's own
frontend/content/docs) unless the setting gives it another folder, so the
deployment that predates this needs no new setting. A relative folder is taken
from the repository root.

Everything site-specific the assistant needs comes from the folder, never from
code: the product name and docs URL from ``site.json``; the site's own prompt
section, the extra hosts it may link to, whether the Markdrop account tools
apply, search synonyms and spend caps from ``ai.json``::

    {
      "prompt": "You are the assistant on …",       # opens the system prompt
      "linkHosts": ["acme.com"],                      # besides the docs site itself
      "mailDomains": ["acme.com"],                    # mailto: addresses allowed in answers
      "productTools": false,                          # Markdrop account/limits tools
      "examples": {                                   # wording examples in the rules and tools
        "searches": ["api key", "webhooks"],
        "queries": ["rotate api key"],
        "page": "/guides/webhooks"
      },
      "synonyms": {"team": ["workspace"]},            # BM25 query synonyms
      "budget": {"dailyUsd": 1, "monthlyUsd": 10}     # inside the global caps
    }

Every key is optional. Malformed files read as empty; nothing here throws on
content.

Markdrop Guides sites (the dashboard's sites, ``docs_sites`` in MongoDB) are served
too, under their 24-hex site id (their built site.json sets ``ai.site`` to it).
A file-based site of the same id wins. A studio site is known while it is live
and not deleted; its settings come from the row (``settings.ai``: on/off,
assistant name, suggestions) and its docs from the live build's snapshot (see
docs_index.aget_index). It never gets the Markdrop account tools, links only to
its own address(es), and has a monthly answer cap
(settings.docs_ai_answers_per_month) inside the global spend caps. A site whose
access isn't public gets no Ask AI: the API can't tell its readers apart.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from app.config import get_settings

log = logging.getLogger("markdrop.docs_sites")

DEFAULT_SITE = "markdrop"
_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
_HOST = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$")
REPO_ROOT = Path(__file__).resolve().parents[3]


class UnknownSite(LookupError):
    """No docs site is registered under that id."""


# ── Registry ──────────────────────────────────────────────────────────────────


def default_content_dir() -> Path:
    """Markdrop's own docs: settings.docs_content_dir, else the repo's folder."""
    configured = get_settings().docs_content_dir
    if configured:
        return Path(configured)
    return REPO_ROOT / "frontend" / "content" / "docs"


def normalize_id(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    v = value.strip().lower()
    return v if _ID.match(v) else None


def _dir(raw: Any) -> Path | None:
    if not isinstance(raw, str) or not raw.strip():
        return None
    p = Path(raw.strip()).expanduser()
    return p if p.is_absolute() else REPO_ROOT / p


_parsed: tuple[str, dict[str, Path]] | None = None


def parse_sites(raw: str) -> dict[str, Path]:
    """The setting's value → {id: folder}. Bad entries are skipped (and logged)."""
    raw = (raw or "").strip()
    if not raw:
        return {}
    pairs: list[tuple[Any, Any]] = []
    if raw.startswith("{"):
        try:
            data = json.loads(raw)
        except ValueError:
            log.warning("MARKDROP_DOCS_SITES is not valid JSON; ignored")
            return {}
        if isinstance(data, dict):
            pairs = list(data.items())
    else:
        for item in raw.split(","):
            if item.strip():
                k, sep, v = item.partition("=")
                pairs.append((k, v) if sep else (k, None))
    out: dict[str, Path] = {}
    for k, v in pairs:
        sid, path = normalize_id(k), _dir(v)
        if sid is None or path is None:
            log.warning("MARKDROP_DOCS_SITES: skipping entry %r", k)
            continue
        out[sid] = path
    return out


def registry() -> dict[str, Path]:
    """Every registered site: {id: content folder}. "markdrop" first."""
    global _parsed
    raw = get_settings().docs_sites or ""
    if _parsed is None or _parsed[0] != raw:
        _parsed = (raw, parse_sites(raw))
    return {DEFAULT_SITE: default_content_dir(), **_parsed[1]}


def resolve(site: Any = None) -> tuple[str, Path]:
    """(id, folder) for a request's site; None or "" means "markdrop"."""
    if site is None or (isinstance(site, str) and not site.strip()):
        site = DEFAULT_SITE
    sid = normalize_id(site)
    sites = registry()
    if sid is None or sid not in sites:
        raise UnknownSite(str(site)[:40])
    return sid, sites[sid]


def exists(site: Any) -> bool:
    try:
        resolve(site)
        return True
    except UnknownSite:
        return False


# ── One site's settings ───────────────────────────────────────────────────────


def _read_json(path: Path) -> dict:
    try:
        v = json.loads(path.read_text("utf-8"))
        return v if isinstance(v, dict) else {}
    except Exception:
        return {}


def _dict(v: Any) -> dict:
    return v if isinstance(v, dict) else {}


def _str(v: Any) -> str:
    return v.strip() if isinstance(v, str) else ""


def _hosts(v: Any) -> tuple[str, ...]:
    out: list[str] = []
    for h in v if isinstance(v, list) else []:
        h = _str(h).lower().rstrip(".")
        if _HOST.match(h) and h not in out:
            out.append(h)
    return tuple(out)


def _usd(v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v:
        return None
    return max(0.0, float(v))


class SiteConfig:
    """A site's settings, read from its folder's site.json and ai.json."""

    def __init__(self, site_id: str, root: Path, site: dict, ai: dict):
        self.id = site_id
        self.root = root
        self.site = site
        self.ai = ai

    @classmethod
    def load(cls, site_id: str, root: Path) -> "SiteConfig":
        return cls(site_id, root, _read_json(root / "site.json"), _read_json(root / "ai.json"))

    # ── site.json ──
    @property
    def name(self) -> str:
        """The product the docs are about: brand.name, product.name, the site's name, its id."""
        brand, product = _dict(self.site.get("brand")), _dict(self.site.get("product"))
        return (_str(brand.get("name")) or _str(product.get("name")) or _str(self.site.get("name"))
                or self.id.replace("-", " ").replace("_", " ").title())

    @property
    def url(self) -> str:
        url = _str(self.site.get("url"))
        if not url and self.id == DEFAULT_SITE:
            url = get_settings().docs_site_url
        return url.rstrip("/")

    @property
    def host(self) -> str | None:
        try:
            return (urlsplit(self.url).hostname or "").lower() or None
        except ValueError:
            return None

    @property
    def origin(self) -> str | None:
        try:
            parts = urlsplit(self.url)
        except ValueError:
            return None
        if parts.scheme not in ("http", "https") or not parts.netloc:
            return None
        return f"{parts.scheme}://{parts.netloc}".lower()

    @property
    def ai_enabled(self) -> bool:
        """site.json `ai.enabled: false` turns Ask AI off for this site."""
        return _dict(self.site.get("ai")).get("enabled") is not False

    # ── ai.json ──
    @property
    def prompt(self) -> str:
        return _str(self.ai.get("prompt"))

    @property
    def link_hosts(self) -> tuple[str, ...]:
        return _hosts(self.ai.get("linkHosts"))

    @property
    def mail_domains(self) -> tuple[str, ...]:
        return _hosts(self.ai.get("mailDomains"))

    @property
    def product_tools(self) -> bool:
        return self.ai.get("productTools") is True

    def _examples(self, key: str) -> list[str]:
        v = _dict(self.ai.get("examples")).get(key)
        return [s for s in (_str(x) for x in (v if isinstance(v, list) else [])) if s and not set(s) & set("\"'\n")][:8]

    @property
    def search_examples(self) -> list[str]:
        """Other wordings to search with, quoted in the rules ("custom domain", …)."""
        return self._examples("searches")

    @property
    def query_examples(self) -> list[str]:
        """Example search_docs queries, in the tool's description."""
        return self._examples("queries")[:3]

    @property
    def page_example(self) -> str | None:
        """An example page path for read_page's description."""
        v = _str(_dict(self.ai.get("examples")).get("page"))
        return v if re.match(r"^/[A-Za-z0-9/_.-]{0,200}$", v) else None

    @property
    def synonyms(self) -> dict[str, list[str]]:
        out: dict[str, list[str]] = {}
        for k, v in _dict(self.ai.get("synonyms")).items():
            if isinstance(k, str) and k.strip() and isinstance(v, list):
                words = [w.strip() for w in v if isinstance(w, str) and w.strip()]
                if words:
                    out[k.strip().lower()] = words
        return out

    @property
    def daily_cap(self) -> float | None:
        return _usd(_dict(self.ai.get("budget")).get("dailyUsd"))

    @property
    def monthly_cap(self) -> float | None:
        return _usd(_dict(self.ai.get("budget")).get("monthlyUsd"))

    # ── what Markdrop Guides sites set differently ──
    studio = False

    @property
    def alias_hosts(self) -> tuple[str, ...]:
        """Other hosts serving these same pages (links to them are checked like the docs host's)."""
        return ()

    @property
    def monthly_answers(self) -> int | None:
        """Answers this site may give per UTC month (None: no cap besides the spend caps)."""
        return None

    def status_extra(self) -> dict:
        """Extra fields for GET /docs/ai/status (file-based sites: none)."""
        return {}


def _stat(path: Path) -> tuple | None:
    try:
        st = path.stat()
        return st.st_mtime_ns, st.st_size
    except OSError:
        return None


_cfg_lock = threading.Lock()
_cfg_cache: dict[str, tuple[tuple, SiteConfig]] = {}


def config(site: Any = None) -> SiteConfig:
    """A registered site's settings, re-read when site.json or ai.json changes.

    Cheap (two stat calls): for CORS, the status endpoint and the admin tab,
    which must not build a whole index. Raises UnknownSite.
    """
    sid, root = resolve(site)
    key = (str(root), _stat(root / "site.json"), _stat(root / "ai.json"))
    with _cfg_lock:
        hit = _cfg_cache.get(sid)
        if hit is not None and hit[0] == key:
            return hit[1]
    cfg = SiteConfig.load(sid, root)
    live = registry()
    with _cfg_lock:
        _cfg_cache[sid] = (key, cfg)
        for stale in [k for k in _cfg_cache if k not in live]:
            _cfg_cache.pop(stale, None)
    return cfg


def configs() -> list[SiteConfig]:
    return [config(sid) for sid in registry()]


def origins() -> set[str]:
    """The docs URL origin of every registered site."""
    out = set()
    for sid in registry():
        try:
            o = config(sid).origin
        except UnknownSite:
            continue
        if o:
            out.add(o)
    return out


# ── Markdrop Guides sites ─────────────────────────────────────────────────────────

STUDIO_ID = re.compile(r"^[0-9a-f]{24}$")
# A studio site's row is re-read at most this often (publish, unpublish, the AI
# switch and a deletion show within this many seconds).
STUDIO_TTL_S = 5.0
STUDIO_CACHE_MAX = 1024
# The origins of live studio sites (CORS): re-read this often, and on an unknown
# origin at most this often (a site that just went live works within seconds).
ORIGINS_TTL_S = 60.0
ORIGINS_MISS_S = 5.0
ORIGINS_MAX_SITES = 20_000


def is_studio_id(value: Any) -> bool:
    return isinstance(value, str) and bool(STUDIO_ID.match(value))


@dataclass(frozen=True)
class StudioSite:
    """What Ask AI needs to know about a live Markdrop Guides site, from its row and live build."""

    id: str
    name: str
    url: str                        # the live address (an own domain when it has one)
    hosts: tuple[str, ...]          # every host serving the live build
    live_build_id: str
    snapshot_id: Any                # ObjectId of the live build's snapshot
    ai_enabled: bool                # settings.ai.enabled, and a public site
    ai_name: str | None
    suggestions: tuple[str, ...]
    row: dict = field(repr=False, compare=False, default_factory=dict)
    insights: bool = True           # settings.insights.enabled (services/guide_insights.py)


def _studio_from(row: dict, build: dict, snap_site: dict) -> StudioSite:
    from app.services import docs_snapshot

    settings = _dict(row.get("settings"))
    ai = _dict(settings.get("ai"))
    public = (_dict(settings.get("access")).get("level") or "public") == "public"
    slug = _str(snap_site.get("slug")) or row.get("slug")
    name = _str(snap_site.get("name")) or _str(row.get("name")) or "Docs"
    raw = ai.get("suggestions") if isinstance(ai.get("suggestions"), list) else []
    suggestions = tuple(x for x in (_str(v)[:120] for v in raw) if x)[:5]
    return StudioSite(
        id=str(row["_id"]), name=name, url=docs_snapshot.site_url(row, slug),
        hosts=tuple(h.lower() for h in docs_snapshot.site_hosts(row, slug)), live_build_id=str(build["_id"]),
        snapshot_id=build["snapshot_id"], ai_enabled=ai.get("enabled") is True and public,
        ai_name=_str(ai.get("name"))[:40] or None, suggestions=suggestions, row=row,
        insights=_dict(settings.get("insights")).get("enabled", True) is not False)


_studio_cache: dict[tuple[str, str], tuple[float, StudioSite | None]] = {}


async def studio_site(db, site_id: Any) -> StudioSite | None:
    """A live, undeleted Markdrop Guides site with a live build, or None. Cached a few seconds."""
    if not is_studio_id(site_id):
        return None
    from bson import ObjectId

    from app.services.docs_site_store import BUILDS, SITES, SNAPSHOTS

    key = (db.name, site_id)
    hit = _studio_cache.get(key)
    if hit is not None and time.monotonic() - hit[0] < STUDIO_TTL_S:
        return hit[1]
    out = None
    row = await db[SITES].find_one(
        {"_id": ObjectId(site_id), "deleted_at": None, "status": "live"},
        {"name": 1, "slug": 1, "domains": 1, "settings": 1, "engine_extra": 1, "live_build_id": 1})
    if row is not None and row.get("live_build_id"):
        build = await db[BUILDS].find_one({"_id": row["live_build_id"], "site_id": row["_id"]}, {"snapshot_id": 1})
        if build is not None and build.get("snapshot_id"):
            snap = await db[SNAPSHOTS].find_one({"_id": build["snapshot_id"]}, {"site": 1})
            if snap is not None:
                out = _studio_from(row, build, _dict(snap.get("site")))
    if len(_studio_cache) >= STUDIO_CACHE_MAX:
        _studio_cache.clear()
    _studio_cache[key] = (time.monotonic(), out)
    return out


class StudioSiteConfig(SiteConfig):
    """A Markdrop Guides site's settings: ``site`` is its built site.json (or the row's
    name and address before the index is loaded); the AI settings are the row's,
    read live (``state``)."""

    studio = True

    def __init__(self, st: StudioSite, site: dict | None = None):
        super().__init__(st.id, Path("docs-studio") / st.id, site or {
            "id": st.id, "name": st.name, "url": st.url, "brand": {"name": st.name}}, {"productTools": False})
        self.state = st

    @property
    def url(self) -> str:
        return (_str(self.site.get("url")) or self.state.url).rstrip("/")

    @property
    def ai_enabled(self) -> bool:
        return self.state.ai_enabled

    @property
    def alias_hosts(self) -> tuple[str, ...]:
        return tuple(h for h in self.state.hosts if h != self.host)

    @property
    def monthly_answers(self) -> int | None:
        return max(0, int(get_settings().docs_ai_answers_per_month))

    def status_extra(self) -> dict:
        return {"name": self.state.ai_name or "Ask AI", "suggestions": list(self.state.suggestions)}


async def aresolve(db, site: Any = None) -> str:
    """resolve() that also knows live Markdrop Guides sites: the site id, or UnknownSite."""
    try:
        return resolve(site)[0]
    except UnknownSite:
        sid = normalize_id(site)
        if sid is None or await studio_site(db, sid) is None:
            raise
        return sid


async def aconfig(db, site: Any = None) -> SiteConfig:
    """config() that also knows live Markdrop Guides sites (from the row; no snapshot is read)."""
    try:
        return config(site)
    except UnknownSite:
        st = await studio_site(db, normalize_id(site))
        if st is None:
            raise
        return StudioSiteConfig(st)


_origins: dict = {"db": None, "at": float("-inf"), "set": frozenset()}
_origins_lock: asyncio.Lock | None = None
_origins_loop: Any = None


async def _load_studio_origins(db) -> frozenset[str]:
    from app.services import docs_snapshot
    from app.services.docs_site_store import BUILDS, SITES, SNAPSHOTS

    rows = await db[SITES].find(
        {"status": "live", "deleted_at": None, "live_build_id": {"$ne": None}},
        {"slug": 1, "domains": 1, "live_build_id": 1}).to_list(ORIGINS_MAX_SITES)
    snap_of = {b["_id"]: b.get("snapshot_id") async for b in db[BUILDS].find(
        {"_id": {"$in": [r["live_build_id"] for r in rows]}}, {"snapshot_id": 1})}
    slug_of = {s["_id"]: _str(_dict(s.get("site")).get("slug")) async for s in db[SNAPSHOTS].find(
        {"_id": {"$in": [v for v in snap_of.values() if v]}}, {"site.slug": 1})}
    out: set[str] = set()
    for r in rows:
        snap = snap_of.get(r["live_build_id"])
        if not snap:
            continue
        # The live build's address, and the current slug's (a renamed site moves with its next build).
        for slug in {slug_of.get(snap) or r.get("slug"), r.get("slug")}:
            for h in docs_snapshot.site_hosts(r, slug):
                out.add(f"https://{h.lower()}")
    return frozenset(out)


async def studio_origin_allowed(origin: str | None) -> bool:
    """Is ``origin`` a live Markdrop Guides site's address? (CORS for /api/v1/docs/*.)

    Cheap: a set lookup. The set is re-read every minute, or when an unknown
    origin asks and it is a few seconds old. Never raises (no database: no).
    """
    global _origins_lock, _origins_loop
    if not origin:
        return False
    o = origin.strip().rstrip("/").lower()
    if not o.startswith("https://"):
        return False
    try:
        from app.database import get_database

        db = get_database()
    except Exception:
        return False
    loop = asyncio.get_running_loop()
    if _origins_lock is None or _origins_loop is not loop:
        _origins_lock, _origins_loop = asyncio.Lock(), loop

    def known() -> bool | None:
        if _origins["db"] != db.name:
            return None
        age = time.monotonic() - _origins["at"]
        if o in _origins["set"]:
            return True if age < ORIGINS_TTL_S else None
        return False if age < ORIGINS_MISS_S else None

    hit = known()
    if hit is not None:
        return hit
    async with _origins_lock:
        hit = known()  # another request may have just re-read it
        if hit is not None:
            return hit
        try:
            found = await _load_studio_origins(db)
        except Exception:
            log.warning("guides origins: reading the live sites failed", exc_info=True)
            found = _origins["set"] if _origins["db"] == db.name else frozenset()
        _origins.update(db=db.name, at=time.monotonic(), set=found)
    return o in found


def reset() -> None:
    """Tests: forget cached settings."""
    global _parsed
    with _cfg_lock:
        _cfg_cache.clear()
    _parsed = None
    _studio_cache.clear()
    _origins.update(db=None, at=float("-inf"), set=frozenset())
