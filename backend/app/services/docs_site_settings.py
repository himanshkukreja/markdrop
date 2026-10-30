"""Docs site settings: the model, defaults, deep-merge and validation.

A PATCH sends only what changes; it is merged onto the stored settings and the
whole result is validated, so a partial update can never leave an invalid mix.
Custom CSS is checked rather than rewritten: anything that could load from an
insecure origin, run script or close the <style> it is placed in is refused
with a message saying what to remove.
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

_CSS_COMMENT = re.compile(r"/\*.*?\*/", re.S)
_CSS_HEX_ESCAPE = re.compile(r"\\([0-9a-fA-F]{1,6})\s?")
_CSS_CHAR_ESCAPE = re.compile(r"\\(.)", re.S)
_URL_FN = re.compile(r"url\(\s*(?P<arg>\"[^\"]*\"|'[^']*'|[^)]*)\s*\)", re.I)
_IMAGE_SET = re.compile(r"image-set\((?P<args>[^)]*)\)", re.I)
_STRING = re.compile(r"\"([^\"]*)\"|'([^']*)'")


def _decode_css(css: str) -> str:
    """What the CSS means once escapes and comments are gone (``\\65`` is "e"),
    so ``@\\69mport`` or ``expr/**/ession(`` can't slip past the checks."""
    out = _CSS_COMMENT.sub("", css)

    def hex_char(m: re.Match) -> str:
        try:
            return chr(int(m.group(1), 16))
        except (ValueError, OverflowError):
            return ""

    out = _CSS_HEX_ESCAPE.sub(hex_char, out)
    out = _CSS_CHAR_ESCAPE.sub(lambda m: m.group(1), out)
    return out


def css_problem(css: str) -> str | None:
    """Why this custom CSS can't be used, or None when it is fine."""
    if len(css.encode("utf-8")) > CUSTOM_CSS_MAX:
        return "Custom CSS can be at most 20 KB."
    if "\x00" in css:
        return "Custom CSS can't contain null characters."
    for text in (css, _decode_css(css)):
        low = text.lower()
        if "</style" in low or "<script" in low or "<!--" in low:
            return "Custom CSS can't contain HTML tags such as </style>."
        if "@import" in low:
            return "Custom CSS can't use @import."
        if "expression(" in low.replace(" ", ""):
            return "Custom CSS can't use expression()."
        if "javascript:" in low.replace(" ", "") or "vbscript:" in low.replace(" ", ""):
            return "Custom CSS can't contain javascript: links."
        if "-moz-binding" in low or re.search(r"(^|[;{\s])behavior\s*:", low):
            return "Custom CSS can't use behavior or -moz-binding."
        for m in _URL_FN.finditer(text):
            arg = m.group("arg").strip().strip("\"'").strip()
            if not arg.lower().startswith("https://"):
                return "url() in custom CSS must point to an https:// address."
        if re.search(r"(^|[^a-z-])src\(", low):
            return "Custom CSS can't use src(); use url() with an https:// address."
        for m in _IMAGE_SET.finditer(text):
            for s in _STRING.finditer(m.group("args")):
                if not (s.group(1) or s.group(2) or "").lower().startswith("https://"):
                    return "image-set() in custom CSS must point to https:// addresses."
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

