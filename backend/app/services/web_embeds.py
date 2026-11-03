"""Web embeds in pages (``::embed{src="…"}``): an allowlist of providers.

:func:`resolve` turns a link a person pasted into the provider's own embed
address, or None. Only these providers, only https, and the embed URL is always
built here from the parts we recognise (never the pasted URL passed through),
so a page can't frame an arbitrary site. The app frames the result in a
sandboxed iframe; ``GET /api/v1/web-embeds/resolve?url=`` exposes the same
function, and the MCP page tools refuse ``::embed`` blocks it doesn't accept.
"""

from __future__ import annotations

import re
from urllib.parse import parse_qs, quote, urlsplit

PROVIDERS = (
    {"id": "youtube", "name": "YouTube", "example": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
    {"id": "vimeo", "name": "Vimeo", "example": "https://vimeo.com/76979871"},
    {"id": "loom", "name": "Loom", "example": "https://www.loom.com/share/<id>"},
    {"id": "figma", "name": "Figma", "example": "https://www.figma.com/design/<key>/<name>"},
    {"id": "google_maps", "name": "Google Maps", "example": "https://www.google.com/maps/embed?pb=…"},
    {"id": "codepen", "name": "CodePen", "example": "https://codepen.io/<user>/pen/<id>"},
)
_YT_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_NUM = re.compile(r"^\d{1,12}$")


def _host(u) -> str:
    return (u.hostname or "").lower().rstrip(".")


def _start(qs: dict) -> int | None:
    t = (qs.get("t") or qs.get("start") or [""])[0]
    m = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?", t or "")
    if not t or not m:
        return None
    h, mi, s = (int(x) if x else 0 for x in m.groups())
    total = h * 3600 + mi * 60 + s
    return total or None


def resolve(url: str | None) -> dict | None:
    """``{provider, name, embed_url, aspect_ratio, url}`` for an allowlisted link, else None."""
    text = (url or "").strip()
    if not text or len(text) > 2048:
        return None
    try:
        u = urlsplit(text)
    except ValueError:
        return None
    if u.scheme != "https" or u.username or u.password or u.port not in (None, 443):
        return None
    host = _host(u)
    segs = [s for s in u.path.split("/") if s]
    qs = parse_qs(u.query)

    def out(pid: str, embed: str, ratio: str = "16:9") -> dict:
        name = next(p["name"] for p in PROVIDERS if p["id"] == pid)
        return {"provider": pid, "name": name, "embed_url": embed, "aspect_ratio": ratio, "url": text}

    if host in ("youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtube-nocookie.com"):
        vid = None
        if host == "youtu.be" and segs:
            vid = segs[0]
        elif segs[:1] == ["watch"]:
            vid = (qs.get("v") or [""])[0]
        elif len(segs) >= 2 and segs[0] in ("embed", "shorts", "live", "v"):
            vid = segs[1]
        if vid and _YT_ID.match(vid):
            start = _start(qs)
            return out("youtube", f"https://www.youtube-nocookie.com/embed/{vid}" + (f"?start={start}" if start else ""),
                       "9:16" if segs[:1] == ["shorts"] else "16:9")
        return None
    if host in ("vimeo.com", "www.vimeo.com", "player.vimeo.com"):
        nums = [s for s in segs if _NUM.match(s)]
        if nums:
            return out("vimeo", f"https://player.vimeo.com/video/{nums[0]}")
        return None
    if host in ("loom.com", "www.loom.com"):
        if len(segs) >= 2 and segs[0] in ("share", "embed") and _ID.match(segs[1]):
            return out("loom", f"https://www.loom.com/embed/{segs[1]}")
        return None
    if host in ("figma.com", "www.figma.com"):
        if len(segs) >= 2 and segs[0] in ("file", "design", "proto", "board", "slides") and _ID.match(segs[1]):
            clean = f"https://www.figma.com/{segs[0]}/{segs[1]}" + (f"/{quote(segs[2])}" if len(segs) > 2 else "")
            node = (qs.get("node-id") or [""])[0]
            if node and re.fullmatch(r"[0-9]+[-:][0-9]+", node):
                clean += f"?node-id={node}"
            return out("figma", "https://www.figma.com/embed?embed_host=markdrop&url=" + quote(clean, safe=""), "4:3")
        return None
    if host in ("google.com", "www.google.com", "maps.google.com"):
        if segs[:2] == ["maps", "embed"] and qs.get("pb") and re.fullmatch(r"[\w!.:%*,+\-]{1,4000}", qs["pb"][0]):
            return out("google_maps", "https://www.google.com/maps/embed?pb=" + quote(qs["pb"][0], safe="!.:%*,+-_"),
                       "4:3")
        return None
    if host == "codepen.io":
        if len(segs) >= 3 and segs[1] in ("pen", "embed", "full") and _ID.match(segs[0]) and _ID.match(segs[2]):
            return out("codepen", f"https://codepen.io/{segs[0]}/embed/{segs[2]}?default-tab=result", "4:3")
        return None
    return None


_EMBED = re.compile(r"(?<![A-Za-z0-9_:])::embed(?:\[[^\]\n]*\])?\{([^}\n]*)\}")


def check_markdown(markdown: str | None) -> list[str]:
    """The ``::embed{src}`` links in ``markdown`` that aren't allowlisted."""
    from app.services.pages import _ATTR, _unescape

    bad = []
    for m in _EMBED.finditer(markdown or ""):
        src = None
        for a in _ATTR.finditer(m.group(1)):
            if a.group(1) in ("src", "url"):
                v = a.group(3) if a.group(3) is not None else (a.group(4) if a.group(4) is not None else a.group(5))
                src = _unescape(v or "")
        if not resolve(src):
            bad.append(src or m.group(0))
    return bad


def providers_text() -> str:
    return ", ".join(p["name"] for p in PROVIDERS)
