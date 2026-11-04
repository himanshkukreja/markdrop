"""Page properties, kept in the page's Markdown as front matter.

    ---
    icon: 🚀                  # an emoji, or asset:<id> (an image uploaded to the page)
    cover: asset:<id>         # or gallery:<name> (a built-in cover the app ships, GALLERY), or an https URL
    cover_y: 35               # the cover's focal point, 0 (top) .. 100 (bottom); default 50
    full_width: true
    small_text: true
    font: serif               # default | serif | mono
    locked: true              # only the owner and workspace admins may edit
    allow_export: false       # readers can't export it (editors always can)
    ---

The block is the first thing in the file, one ``key: value`` per line. Keys we
don't know are kept as written (the Markdown round-trips byte for byte); values
we can't read are ignored rather than refused, so a hand-edited file never
breaks the page. :func:`parse` answers what the page shows, :func:`apply`
writes a change back while keeping everything else in the block in place.
"""

from __future__ import annotations

import re
from typing import Any

KEYS = ("icon", "cover", "cover_y", "full_width", "small_text", "font", "locked", "allow_export")
FONTS = ("default", "serif", "mono")
# The built-in covers, gallery:<name> (the app ships them: frontend/public/page-covers, whose
# manifest.json lists the same names).
GALLERY = ("mist", "linen", "graphite", "fold", "halftone", "dusk",
           "contour", "blueprint", "strata", "dawn", "sage", "moonlit")
# The first gallery's gradients, still on existing pages: each now shows the nearest cover above.
GALLERY_ALIASES = {"aurora": "dusk", "ocean": "dusk", "sunset": "dawn", "peach": "dawn",
                   "sand": "linen", "slate": "graphite", "forest": "sage", "mint": "sage"}
_ASSET = re.compile(r"^asset:([A-Za-z0-9_-]{8,64})$")
_GALLERY = re.compile(r"^gallery:([a-z0-9][a-z0-9-]{0,39})$")
_LINE = re.compile(r"^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*?)[ \t]*$")
MAX_BLOCK_LINES = 60
_HTTPS = re.compile(r"^https://[^\s\"'<>()]{1,2000}$")
DEFAULTS: dict[str, Any] = {"icon": None, "cover": None, "cover_y": 50, "full_width": False,
                            "small_text": False, "font": "default", "locked": False, "allow_export": True}


def split(markdown: str | None) -> tuple[list[str] | None, str]:
    """(the front-matter lines, the body) — (None, markdown) when there is none."""
    text = markdown or ""
    if not text.startswith("---\n") and not text.startswith("---\r\n"):
        return None, text
    lines = text.split("\n")
    for i in range(1, min(len(lines), MAX_BLOCK_LINES + 2)):
        if lines[i].rstrip("\r") in ("---", "..."):
            return [ln.rstrip("\r") for ln in lines[1:i]], "\n".join(lines[i + 1:])
    return None, text


def _unquote(v: str) -> str:
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    return v


def _bool(v: str) -> bool | None:
    t = v.strip().lower()
    if t in ("true", "yes", "on", "1"):
        return True
    if t in ("false", "no", "off", "0", ""):
        return False
    return None


def gallery_cover(name: str) -> str | None:
    """``gallery:<name>`` for a built-in cover (an old name gives the cover that replaced it);
    None for a name the gallery doesn't have."""
    name = GALLERY_ALIASES.get(name, name)
    return f"gallery:{name}" if name in GALLERY else None


def _value(key: str, raw: str) -> Any:
    v = _unquote(raw.split(" #", 1)[0].strip() if not raw.startswith(("'", '"')) else raw.strip())
    if key == "icon":
        if _ASSET.match(v):
            return v
        if v and len(v) <= 16 and "\n" not in v and not v.startswith(("http:", "https:", "javascript:")):
            return v
        return None
    if key == "cover":
        g = _GALLERY.match(v)
        if g:
            return gallery_cover(g.group(1))
        return v if (_ASSET.match(v) or _HTTPS.match(v)) else None
    if key == "cover_y":
        try:
            f = float(v)
        except ValueError:
            return None
        if f != f:
            return None
        if "." in v and 0 <= f <= 1:
            f *= 100  # written as a fraction (0.35): the same point as 35
        f = min(100.0, max(0.0, f))
        return int(f) if f == int(f) else round(f, 2)
    if key == "font":
        return v.lower() if v.lower() in FONTS else None
    return _bool(v)


def parse(markdown: str | None) -> dict:
    """The page's properties (every key, defaults filled in)."""
    out = dict(DEFAULTS)
    lines, _body = split(markdown)
    for line in lines or []:
        m = _LINE.match(line)
        if not m or m.group(1) not in KEYS:
            continue
        val = _value(m.group(1), m.group(2))
        if val is not None:
            out[m.group(1)] = val
    return out


def is_locked(markdown: str | None) -> bool:
    return bool(parse(markdown)["locked"])


def asset_ids(props: dict) -> list[str]:
    out = []
    for k in ("icon", "cover"):
        m = _ASSET.match(props.get(k) or "")
        if m:
            out.append(m.group(1))
    return out


def _format(key: str, value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if key == "cover_y":
        return f"{float(value):.2f}".rstrip("0").rstrip(".") or "0"
    text = str(value)
    if text != text.strip() or ":" in text and not _ASSET.match(text) and not _GALLERY.match(text) \
            or text.startswith(("#", "'", '"', "-", "[", "{")):
        return '"' + text.replace('"', "'") + '"'
    return text


def validate(changes: dict) -> dict:
    """The changes, checked: a value of None clears the key. ValueError with
    a message when a value isn't allowed."""
    clean: dict = {}
    for k, v in changes.items():
        if k not in KEYS:
            raise ValueError(f"Unknown page property {k!r}. Known: {', '.join(KEYS)}.")
        if v is None:
            clean[k] = None
            continue
        if k in ("full_width", "small_text", "locked", "allow_export"):
            if not isinstance(v, bool):
                raise ValueError(f"{k} must be true or false.")
        elif k == "cover_y":
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 <= v <= 100:
                raise ValueError("cover_y must be a number from 0 (top) to 100 (bottom).")
            v = int(round(float(v)))
        elif k == "font":
            if v not in FONTS:
                raise ValueError(f"font must be one of {', '.join(FONTS)}.")
        elif k == "icon":
            if not isinstance(v, str) or _value("icon", v) != v:
                raise ValueError("icon must be an emoji (a few characters) or asset:<id> of an image "
                                 "uploaded to the page.")
        elif k == "cover":
            # An old gallery name is written as the cover that replaced it.
            val = _value("cover", v) if isinstance(v, str) else None
            if val is None or (val != v and not _GALLERY.match(v)):
                raise ValueError("cover must be asset:<id> (an image uploaded to the page), "
                                 f"gallery:<name> (a built-in cover: {', '.join(GALLERY)}) "
                                 "or an https:// image address.")
            v = val
        clean[k] = v
    return clean


def apply(markdown: str | None, changes: dict) -> str:
    """The Markdown with ``changes`` written into its front matter (None or a
    default value removes the key). Other keys and lines keep their place; the
    block goes away when nothing is left in it."""
    changes = validate(changes)
    lines, body = split(markdown)
    lines = list(lines or [])
    seen: set[str] = set()
    out: list[str] = []
    for line in lines:
        m = _LINE.match(line)
        key = m.group(1) if m else None
        if key in changes:
            if key in seen:
                continue
            seen.add(key)
            v = changes[key]
            if v is None or v == DEFAULTS[key]:
                continue
            out.append(f"{key}: {_format(key, v)}")
        else:
            out.append(line)
    for key in KEYS:
        if key in changes and key not in seen:
            v = changes[key]
            if v is not None and v != DEFAULTS[key]:
                out.append(f"{key}: {_format(key, v)}")
    if not any(ln.strip() for ln in out):
        return body if lines else (markdown or "")
    if lines is not None and markdown and split(markdown)[0] is not None:
        return "---\n" + "\n".join(out) + "\n---\n" + body
    return "---\n" + "\n".join(out) + "\n---\n" + (markdown or "")
