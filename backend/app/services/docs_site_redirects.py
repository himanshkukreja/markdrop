"""A docs site's redirects (``settings.redirects``): old addresses → their new pages.

Stored as ``[{"from": "/old/path", "to": "/new/path"}, …]``; the build writes them
to the content folder's ``redirects.json`` (services/docs_snapshot.py), where the
engine answers them as 308s before any page (frontend/src/docs/siteFiles.mjs).

Two layers of checks, the same ones docs-check applies to a redirects.json
(frontend/scripts/docs-check.mjs):

- shape (:func:`clean`, run by the settings model): ``from`` is a plain path
  (no query, #anchor or spaces), not the home page; ``to`` is a docs path, with an
  optional #anchor, or an https URL; nothing redirects to itself; each ``from`` once.
- against the site (:func:`check_against_pages`, run on save, it needs the pages):
  ``from`` isn't a page (the redirect would hide it) or one of the site's own
  addresses; a docs ``to`` is a page (or one of the site's own addresses); and no
  chains: a ``to`` is never another redirect's ``from``.
"""

from __future__ import annotations

import re

MAX_REDIRECTS = 1000
_WS = re.compile(r"\s")
# Addresses the engine answers on every docs site (docs-check FIXED_ROUTES).
FIXED_ROUTES = frozenset({
    "/", "/changelog", "/llms.txt", "/llms-full.txt", "/skill.md", "/changelog.rss", "/changelog.json",
    "/changelog.md", "/sitemap.xml", "/robots.txt", "/index.md",
})
# First segments the engine serves itself (docs_site_pages.RESERVED_SEGMENTS).
OWN_SEGMENTS = frozenset({"docs-assets", "mcp", "md", "og", "_next", "api-reference-json"})


def _trim(p: str) -> str:
    """"/a/b/" → "/a/b" (the root stays "/")."""
    return (p.rstrip("/") or "/") if len(p) > 1 else p


def _page_of(path: str) -> str:
    """A docs address → the page it names: no trailing slash, no .md."""
    p = _trim(path.split("#", 1)[0])
    if p.endswith(".md") and p != "/index.md":
        p = p[:-3]
    return "/" if p == "/index.md" else p


def clean(raw) -> list[dict]:
    """The validated list (``[{from, to}]``, ``from`` without its trailing slash), or ValueError
    with the first problem, phrased for the Settings screen."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("Redirects are a list of {from, to}.")
    if len(raw) > MAX_REDIRECTS:
        raise ValueError(f"A site can have at most {MAX_REDIRECTS:,} redirects.")
    out: list[dict] = []
    seen: set[str] = set()
    for r in raw:
        if not isinstance(r, dict) or set(r) - {"from", "to"}:
            raise ValueError("Each redirect is {from, to}.")
        src, dst = r.get("from"), r.get("to")
        if not isinstance(src, str) or not isinstance(dst, str):
            raise ValueError("Each redirect needs an old address and where it goes.")
        src, dst = src.strip(), dst.strip()
        if not src.startswith("/") or src.startswith("//"):
            raise ValueError(f"{src or 'An old address'}: start the old address with /, like /old/page.")
        if len(src) > 300 or len(dst) > 2048:
            raise ValueError(f"{src[:60]}: that address is too long.")
        if re.search(r"[?#]", src) or _WS.search(src):
            raise ValueError(f"{src}: the old address is a plain path (no ?, # or spaces).")
        if not ((dst.startswith("/") and not dst.startswith("//")) or dst.lower().startswith("https://")) \
                or _WS.search(dst):
            raise ValueError(f"{src}: send it to a page of this site (/new/page) or an https:// address.")
        frm = _trim(src)
        if frm == "/":
            raise ValueError("The home page can't be redirected.")
        if not dst.lower().startswith("https://") and _trim(dst.split("#", 1)[0]) == frm:
            raise ValueError(f"{src} redirects to itself.")
        if frm in seen:
            raise ValueError(f"{frm} is redirected twice. Keep one.")
        seen.add(frm)
        out.append({"from": frm, "to": dst})
    return out


def problems_against(redirects: list[dict], page_paths: set[str]) -> list[str]:
    """What's wrong with these (already :func:`clean`) redirects for a site with these pages."""
    out: list[str] = []
    sources = {r["from"] for r in redirects}
    for r in redirects:
        frm, to = r["from"], r["to"]
        page = _page_of(frm)
        if page in page_paths:
            out.append(f"{frm} is a page of this site; the redirect would hide it. Move or delete the page first.")
            continue
        if frm in FIXED_ROUTES or frm.split("/")[1] in OWN_SEGMENTS:
            out.append(f"{frm} is one of the docs site's own addresses.")
            continue
        if to.lower().startswith("https://"):
            continue
        target = _page_of(to)
        if target in sources or _trim(to.split("#", 1)[0]) in sources:
            out.append(f"{frm} → {to}, which redirects again. Point it at the final page.")
        elif target not in page_paths and target not in FIXED_ROUTES and not target.startswith("/docs-assets/") \
                and not target.startswith("/changelog/"):
            out.append(f"{frm} → {to}: this site has no page {target}.")
    return out
