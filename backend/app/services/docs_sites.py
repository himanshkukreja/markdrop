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
"""

from __future__ import annotations

import json
import logging
import re
import threading
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


def reset() -> None:
    """Tests: forget cached settings."""
    global _parsed
    with _cfg_lock:
        _cfg_cache.clear()
    _parsed = None
