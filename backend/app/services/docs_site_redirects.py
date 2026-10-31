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


# ── A page moves ──────────────────────────────────────────────────────────────


def _retarget(to: str, old: str, new: str) -> str:
    """``to`` re-pointed from page ``old`` to page ``new`` (its #anchor kept); other targets as they are."""
    if to.lower().startswith("https://"):
        return to
    base, sep, anchor = to.partition("#")
    if _page_of(base) != old:
        return to
    return new + (sep + anchor if sep else "")


def points_at(to: str, page: str) -> bool:
    """Whether a redirect's ``to`` lands on ``page`` (any #anchor, trailing slash or .md twin)."""
    return not to.lower().startswith("https://") and _page_of(to) == page


def after_move(redirects: list[dict], old: str, new: str, *, add: bool) -> list[dict]:
    """A site's redirects after its page at ``old`` moved to ``new``: redirects that led to ``old``
    lead to ``new`` (no chains), a redirect away from ``new`` is dropped (the page lives there now:
    the caller only moves a page there when that redirect led to this page), and, with ``add``
    (``old`` was on the live site, so people have links to it), ``old`` → ``new`` is added.
    Redirects that would now point to themselves are dropped; the list stays within MAX_REDIRECTS."""
    out: list[dict] = []
    for r in redirects or []:
        frm, to = r.get("from"), r.get("to")
        if not isinstance(frm, str) or not isinstance(to, str) or frm in (new, old):
            continue
        to = _retarget(to, old, new)
        if not to.lower().startswith("https://") and _page_of(to) == _page_of(frm):
            continue
        out.append({"from": frm, "to": to})
    if add and old != new and len(out) < MAX_REDIRECTS:
        out.append({"from": old, "to": new})
    return out


# ── The build's redirects.json ────────────────────────────────────────────────


def merged(settings_redirects, imported, pages: set[str] | frozenset[str] = frozenset()) -> dict[str, str]:
    """What the build writes to redirects.json: an import's redirects (``engine_extra.redirects``, a
    map or a list of {from, to}) with the site's own (``settings.redirects``) over them, which win
    on the same ``from``. Chains are followed to their end (an imported /a → /b with /b → /c in
    Settings becomes /a → /c, keeping /a's #anchor), so a reader takes one hop; never through one
    of ``pages`` (a page answers before any redirect, so a redirect away from it is never used)."""
    def pairs(src) -> list[tuple[str, str]]:
        if isinstance(src, dict):
            items = list(src.items())
        elif isinstance(src, list):
            items = [(r.get("from"), r.get("to")) for r in src if isinstance(r, dict)]
        else:
            return []
        return [(f, t) for f, t in items if isinstance(f, str) and isinstance(t, str) and f and t]

    out: dict[str, str] = {}
    for f, t in pairs(imported):
        out[f] = t
    for f, t in pairs(settings_redirects):
        out.pop(f, None)  # settings order last, as before for a site with no import
        out[f] = t
    by_page = {_page_of(f): f for f in out if _page_of(f) not in pages}

    def final(frm: str, to: str) -> str:
        first = to
        seen = {_page_of(frm)}
        for _ in range(20):
            if to.lower().startswith("https://"):
                return to
            base, sep, anchor = to.partition("#")
            nxt = by_page.get(_page_of(base))
            if nxt is None:
                return to
            if _page_of(base) in seen:
                return first  # a loop: leave it as it was written
            seen.add(_page_of(base))
            target = out[nxt]
            # Keep this hop's anchor unless the next target names its own.
            to = target if "#" in target or not sep else target + sep + anchor
        return to

    return {f: final(f, t) for f, t in out.items()}
