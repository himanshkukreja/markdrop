"""Docs site settings: the model, defaults, deep-merge and validation.

A PATCH sends only what changes; it is merged onto the stored settings and the
whole result is validated, so a partial update can never leave an invalid mix.
Custom CSS is checked rather than rewritten, by the same rules as the docs
engine's sanitizeCss(): CSS the engine would drop is refused with a message
saying what to change.
"""

from __future__ import annotations

import copy
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

PRESETS = ("clean", "editorial", "technical", "minimal", "playful", "helpcenter")
# Font ids the engine can serve (self-hosted or Google). None = the theme's own.
FONT_IDS = (
    "system", "inter", "manrope", "geist", "dmsans", "plex", "nunito", "source-sans-3",
    "newsreader", "source-serif-4", "lora", "jetbrains-mono", "plex-mono",
)
CUSTOM_CSS_MAX = 20 * 1024
_HEX = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def normalize_hex(value: str) -> str:
    if not isinstance(value, str) or not _HEX.match(value.strip()):
        raise ValueError("Use a hex colour like #2563eb.")
    v = value.strip().lower()
    if len(v) == 4:
        v = "#" + "".join(c * 2 for c in v[1:])
    return v


def _image_url(value: str | None) -> str | None:
    if value is None:
        return None
    v = value.strip()
    if not v:
        return None
    if len(v) > 2048:
        raise ValueError("That address is too long.")
    if v.startswith("https://") or (v.startswith("/docs-assets/") and ".." not in v):
        return v
    raise ValueError("Use an https:// address or an uploaded image (/docs-assets/…).")


# ── Custom CSS ────────────────────────────────────────────────────────────────
#
# A port of the accept/reject logic of sanitizeCss() in
# frontend/src/docs/theme.mjs, the engine that inlines the CSS: the API refuses
# exactly what the engine would drop. Both test suites run the shared corpus
# frontend/src/docs/customCss.corpus.json to keep the two in step.
# JavaScript regex semantics are reproduced on purpose:
#   * ``\s`` and String.prototype.trim() use the JS whitespace set (it has
#     U+FEFF, lacks U+0085 and U+001C-U+001F), not Python's str.isspace();
#   * ``\w``, ``\b`` and the ``i`` flag are ASCII-only (no ``u`` flag in JS), so
#     every pattern is compiled with re.ASCII ("ſrc(" is not "src(");
#   * ``$`` without the ``m`` flag is the very end of the string (``\Z`` here);
#   * the 20 KB limit counts UTF-16 code units, like ``input.length``.

_JS_WS = ("\t\n\x0b\x0c\r   " + "".join(chr(c) for c in range(0x2000, 0x200B))
          + "    　﻿")
_JS_WS_SET = frozenset(_JS_WS)
_S = f"[{_JS_WS}]"  # JS \s
_NS = f"[^{_JS_WS}]"  # JS [^\s]
_RX = re.ASCII
_RXI = re.ASCII | re.IGNORECASE


def _js_trim(s: str) -> str:
    return s.strip(_JS_WS)


def _utf16_len(s: str) -> int:
    return len(s.encode("utf-16-le", "surrogatepass")) // 2


_CSS_COMMENT = re.compile(r"/\*[\s\S]*?\*/", _RX)
# (pattern, what the dashboard says), in the order of the engine's BANNED list.
_CSS_BANNED = [
    (re.compile(rf"</?{_S}*style", _RXI), "Custom CSS can't contain </style> or other HTML."),
    (re.compile(r"<"), "Custom CSS can't contain the < character."),
    (re.compile(r"\\"), "Custom CSS can't use backslash escapes (\\)."),
    (re.compile(rf"expression{_S}*\(", _RXI), "Custom CSS can't use expression()."),
    (re.compile(rf"javascript{_S}*:", _RXI), "Custom CSS can't contain javascript: links."),
    (re.compile(rf"vbscript{_S}*:", _RXI), "Custom CSS can't contain vbscript: links."),
    (re.compile(r"-moz-binding", _RXI), "Custom CSS can't use -moz-binding."),
    (re.compile(rf"\bbehaviou?r{_S}*:", _RXI), "Custom CSS can't use the behavior property."),
    (re.compile(r"@import", _RXI), "Custom CSS can't use @import."),
    (re.compile(rf"\bsrc{_S}*\(", _RXI), "Custom CSS can't use src(); use url() with an https:// address."),
    (re.compile(rf"image-set{_S}*\(", _RXI), "Custom CSS can't use image-set(); use url() with an https:// address."),
]
_CSS_URL = re.compile(rf"url{_S}*\({_S}*(['\"]?)([^'\")]*)\1{_S}*\)", _RXI)
_CSS_URL_OPEN = re.compile(rf"url{_S}*\(", _RXI)
_CSS_URL_HTTPS = re.compile(rf"https://{_NS}+\Z", _RXI)
_CSS_URL_ASSET = re.compile(rf"/docs-assets/{_NS}*\Z", _RX)
_CSS_WS_RUN = re.compile(rf"{_S}+")
_CSS_LAYER_STATEMENT = re.compile(rf"@layer{_S}+[\w-]+(?:{_S}*,{_S}*[\w-]+)*\Z", _RXI)
_CSS_AT_NAME = re.compile(r"@([\w-]+)", _RX)
_CSS_STRINGS = re.compile(r"\"[^\"\n\r\f]*\"|'[^'\n\r\f]*'")
_CSS_ROOT_SELECTOR = re.compile(rf"(html|:root|body)((?:\[[^\]]*\])*)(?=\Z|[{_JS_WS}>+~:.#\[])", _RXI)
_CSS_DATA_THEME = re.compile(r"\[data-theme", _RXI)
_CSS_ATTRS = re.compile(r"(?:\[[^\]]*\])+")
# At-rules whose block holds rules (checked like the top level) / is kept as written.
_CSS_GROUPING = frozenset({"media", "supports", "container", "layer"})
_CSS_VERBATIM = frozenset({"keyframes", "-webkit-keyframes", "font-face", "property"})
_CSS_SCOPE = ".dx-root"
_CSS_QUERY_OR_FRAGMENT = re.compile(r"[?#]")
_CSS_DOT_DOT = re.compile(r"(?:\.|%2e){2}\Z", _RXI)
# A browser ends a string at a line break; one running across lines would be read differently.
_CSS_BREAKS = "\n\r\f"
_CSS_STRING_BREAK = "Custom CSS has a string with a line break in it; close the quote on the same line."


class _CssError(Exception):
    """Where the engine's parser throws; the message is the dashboard's."""


def _css_split_top(s: str, sep: str) -> list[str]:
    """splitTop(): split on ``sep`` outside strings, () and []."""
    out, depth, quote, start = [], 0, None, 0
    for i, c in enumerate(s):
        if quote:
            if c == quote:
                quote = None
            elif c in _CSS_BREAKS:
                raise _CssError(_CSS_STRING_BREAK)
        elif c in "\"'":
            quote = c
        elif c in "([":
            depth += 1
        elif c in ")]":
            depth -= 1
        elif c == sep and depth == 0:
            out.append(s[start:i])
            start = i + 1
    out.append(s[start:])
    return out


def _css_check_after_scope(rest: str, sel: str) -> None:
    """checkAfterScope(): past the rest of the scope's own compound, ``~`` or
    ``+`` would reach the docs root's siblings."""
    i, depth, quote, n = 0, 0, None, len(rest)
    while i < n:
        c = rest[i]
        if quote:
            if c == quote:
                quote = None
        elif c in "\"'":
            quote = c
        elif c in "([":
            depth += 1
        elif c in ")]":
            depth -= 1
        elif depth <= 0 and (c in _JS_WS_SET or c in ">+~"):
            break
        i += 1
    while i < n and rest[i] in _JS_WS_SET:
        i += 1
    if i < n and rest[i] in "~+":
        raise _CssError(f'Custom CSS: "{sel[:40]}" reaches outside the docs root '
                        "(~ or + can't follow the root, :root, html or body).")


def _css_selector_ok(sel: str) -> bool:
    """scopeSelector(), reduced to what decides acceptance: False for an empty
    selector; raises where the engine throws (a selector reaching the scope's
    siblings, or ``[data-theme`` with no ``]``)."""
    s = _CSS_WS_RUN.sub(" ", _js_trim(sel))
    if not s:
        return False
    if s == _CSS_SCOPE or any(s.startswith(_CSS_SCOPE + x) for x in " .[:>+~"):
        _css_check_after_scope(s[len(_CSS_SCOPE):], s)
        return True
    m = _CSS_ROOT_SELECTOR.match(s)
    if m:
        rest = s[m.end():]
        if m.group(1).lower() != "body" and m.group(2) and rest and not rest.startswith(" "):
            rest = " " + rest
        _css_check_after_scope(rest, s)
        return True
    if _CSS_DATA_THEME.match(s):
        t = _CSS_ATTRS.match(s)
        if not t:
            raise _CssError(f'Custom CSS: the selector "{s[:40]}" has a [ without a matching ].')
        _css_check_after_scope(s[t.end():], s)
    return True


def _css_check_rules(src: str, depth: int = 0) -> None:
    """scopeRules() without the output: raises :class:`_CssError` where the
    engine's parser throws."""
    n = len(src)

    def read_block(start: int) -> int:
        # start: just after "{"; returns the index of the matching "}".
        d, quote = 1, None
        for j in range(start, n):
            c = src[j]
            if quote:
                if c == quote:
                    quote = None
                elif c in _CSS_BREAKS:
                    raise _CssError(_CSS_STRING_BREAK)
            elif c in "\"'":
                quote = c
            elif c == "{":
                d += 1
            elif c == "}":
                d -= 1
                if d == 0:
                    return j
        raise _CssError("Custom CSS has a { without a matching }.")

    i = 0
    while i < n:
        while i < n and src[i] in _JS_WS_SET:
            i += 1
        if i >= n:
            break
        # Prelude: up to "{", ";" or "}" outside strings and parentheses.
        j, quote, paren = i, None, 0
        while j < n:
            c = src[j]
            if quote:
                if c == quote:
                    quote = None
                elif c in _CSS_BREAKS:
                    raise _CssError(_CSS_STRING_BREAK)
            elif c in "\"'":
                quote = c
            elif c == "(":
                paren += 1
            elif c == ")":
                paren -= 1
            elif paren == 0 and c in "{;}":
                break
            j += 1
        prelude = _js_trim(src[i:j])
        if j >= n:
            raise _CssError(f'Custom CSS: "{prelude[:40]}" needs a {{ … }} block after it.')
        if src[j] == "}":
            raise _CssError("Custom CSS has a } without a matching {.")
        if src[j] == ";":
            # The only statement at-rule is `@layer a, b;`.
            if not _CSS_LAYER_STATEMENT.match(prelude):
                what = f'"{prelude[:40]};"' if prelude else "a stray ;"
                raise _CssError(f"Custom CSS can't have {what} there (the only statement allowed is @layer name, …;).")
            i = j + 1
            continue
        end = read_block(j + 1)
        body = src[j + 1:end]
        if prelude.startswith("@"):
            m = _CSS_AT_NAME.match(prelude)
            name = m.group(1).lower() if m else ""
            if name in _CSS_GROUPING:
                if depth > 3:
                    raise _CssError("Custom CSS nests @media, @supports, @container or @layer too deeply "
                                    "(at most 4 levels).")
                _css_check_rules(body, depth + 1)
            elif name not in _CSS_VERBATIM:
                raise _CssError(f"Custom CSS can't use @{name} (only @media, @supports, @container, @layer, "
                                "@keyframes, @font-face and @property).")
        else:
            if not prelude:
                raise _CssError("Custom CSS has a { … } block with no selector in front of it.")
            if "{" in _CSS_STRINGS.sub("", body):
                raise _CssError(f'Custom CSS: "{prelude[:40]}" has a nested block (CSS nesting isn\'t supported here).')
            # Every selector is looked at before the empty check, as the engine's map() does.
            oks = [_css_selector_ok(s) for s in _css_split_top(prelude, ",")]
            if not all(oks):
                raise _CssError(f'Custom CSS: "{prelude[:40]}" has an empty selector (check for a stray comma).')
        i = end + 1


def _css_asset_path_ok(u: str) -> bool:
    """assetPathOk(): the path stays in /docs-assets/ (no ``..`` segment, also
    spelled %2e, no ``//`` or backslash)."""
    path = _CSS_QUERY_OR_FRAGMENT.split(u, 1)[0]
    return "//" not in path and "\\" not in path and not any(_CSS_DOT_DOT.match(seg) for seg in path.split("/"))


def css_problem(css: str) -> str | None:
    """Why the docs engine would refuse this custom CSS (its first reason,
    phrased for the dashboard), or None when the engine accepts it."""
    if not isinstance(css, str):
        return "Custom CSS must be text."
    if _utf16_len(css) > CUSTOM_CSS_MAX:
        return "Custom CSS can be at most 20 KB."
    src = _CSS_COMMENT.sub(" ", css)
    if "/*" in src:
        return "Custom CSS has a /* comment that is never closed with */."
    for rx, message in _CSS_BANNED:
        if rx.search(src):
            return message
    for m in _CSS_URL.finditer(src):
        u = _js_trim(m.group(2))
        if _CSS_URL_HTTPS.match(u):
            continue
        if not _CSS_URL_ASSET.match(u):
            return "url() in custom CSS must be an https:// address or an uploaded file (/docs-assets/…)."
        if not _css_asset_path_ok(u):
            return "url() in custom CSS: a /docs-assets/ path can't have \"..\", \"//\" or a backslash in it."
    if _CSS_URL_OPEN.search(_CSS_URL.sub("", src)):
        return "Custom CSS has a url() that isn't a plain address; write url(https://…) or url(\"https://…\")."
    try:
        _css_check_rules(src)
    except _CssError as exc:
        return str(exc)
    return None


# ── The model ─────────────────────────────────────────────────────────────────


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Brand(_Strict):
    enabled: bool = False
    logo_url: str | None = None
    logo_dark_url: str | None = None
    colors: list[str] = Field(default_factory=list, max_length=6)
    accent: str | None = None
    accent_dark: str | None = None

    @field_validator("logo_url", "logo_dark_url")
    @classmethod
    def _logo(cls, v):
        return _image_url(v)

    @field_validator("colors")
    @classmethod
    def _colors(cls, v):
        return [normalize_hex(c) for c in v]

    @field_validator("accent", "accent_dark")
    @classmethod
    def _accent(cls, v):
        return None if v in (None, "") else normalize_hex(v)


class Fonts(_Strict):
    heading: Literal[FONT_IDS] | None = None  # type: ignore[valid-type]
    body: Literal[FONT_IDS] | None = None  # type: ignore[valid-type]


class Theme(_Strict):
    preset: Literal[PRESETS] = "clean"  # type: ignore[valid-type]
    brand: Brand = Field(default_factory=Brand)
    fonts: Fonts = Field(default_factory=Fonts)
    mode: Literal["both", "light", "dark"] = "both"
    corners: Literal["sharp", "soft", "round"] | None = None
    custom_css: str | None = None

    @field_validator("custom_css")
    @classmethod
    def _css(cls, v):
        if v is None or not v.strip():
            return None
        problem = css_problem(v)
        if problem:
            raise ValueError(problem)
        return v


class AI(_Strict):
    enabled: bool = False
    name: str | None = Field(None, max_length=40)
    suggestions: list[str] = Field(default_factory=list, max_length=5)

    @field_validator("suggestions")
    @classmethod
    def _suggestions(cls, v):
        out = [s.strip() for s in v if s and s.strip()]
        if any(len(s) > 120 for s in out):
            raise ValueError("Each suggestion can be at most 120 characters.")
        return out


class Access(_Strict):
    level: Literal["public", "password", "members"] = "public"
    password_hash: str | None = None

    @field_validator("level")
    @classmethod
    def _private_needs_edge(cls, v: str) -> str:
        from app.config import get_settings
        if v != "public" and not get_settings().docs_private_sites_enabled:
            raise ValueError("Password and members-only sites are coming soon. For now a docs site is public.")
        return v


class SEO(_Strict):
    index: bool = True


class Review(_Strict):
    required: bool = False


class NavGroup(_Strict):
    group: str = Field(..., min_length=1, max_length=80)
    pages: list[str] = Field(default_factory=list, max_length=1000)


class SiteSettings(_Strict):
    theme: Theme = Field(default_factory=Theme)
    ai: AI = Field(default_factory=AI)
    access: Access = Field(default_factory=Access)
    seo: SEO = Field(default_factory=SEO)
    review: Review = Field(default_factory=Review)
    nav: list[NavGroup] = Field(default_factory=list, max_length=100)
    # [{from, to}] → the build's redirects.json. Shape checked here; against the site's pages
    # (targets exist, no page hidden, no chains) on save (docs_site_redirects.problems_against).
    redirects: list[dict] = Field(default_factory=list)

    @field_validator("redirects", mode="before")
    @classmethod
    def _redirects(cls, v):
        from app.services.docs_site_redirects import clean

        return clean(v)


def default_settings() -> dict:
    return SiteSettings().model_dump()


def deep_merge(base: dict, patch: dict) -> dict:
    """``patch`` onto ``base``: objects merge key by key, anything else
    (lists, scalars, null) replaces."""
    out = copy.deepcopy(base)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


class SettingsError(ValueError):
    """Invalid settings; ``errors`` is the list a 422 carries."""

    def __init__(self, errors: list[dict]):
        super().__init__("invalid settings")
        self.errors = errors


def validate(settings: dict) -> dict:
    """The validated, normalised settings, or :class:`SettingsError`."""
    try:
        return SiteSettings.model_validate(settings).model_dump()
    except ValidationError as exc:
        errors = []
        for e in exc.errors():
            msg = e.get("msg", "Invalid value")
            if msg.startswith("Value error, "):
                msg = msg[len("Value error, "):]
            errors.append({"loc": ["settings", *e.get("loc", ())], "msg": msg, "type": e.get("type")})
        raise SettingsError(errors) from None


def public_view(settings: dict) -> dict:
    """Settings as the API returns them: never the password hash."""
    out = copy.deepcopy(settings or {})
    access = out.get("access") or {}
    access["has_password"] = bool(access.pop("password_hash", None))
    out["access"] = access
    return out

