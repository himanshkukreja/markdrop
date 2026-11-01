"""Reset design: a guide's design back to the one it started with.

A guide's design is ``settings.theme``, exactly what the studio's Design screen edits: the theme
(preset), "Match my brand" (logo, dark logo, brand colours, accent), fonts, colour mode, corners,
custom CSS and the custom theme (the theme builder). Nothing else is part of it: pages, the nav,
domains, people, access, Ask AI and the import's extras (``engine_extra``: favicon, logo alt
text, hero...) are never touched by a reset.

The baseline, on the site row:

    design_baseline         the starting design (a validated ``settings.theme``)
    design_baseline_source  "created" (the design the guide was created with) or "import" (the
                            design right after an import brought GitBook's look and brand)
    design_baseline_how     "recorded"      stored when it happened (create, import)
                            "unchanged"     a guide from before resets were recorded whose design
                                            was never saved since: its current design
                            "rebuilt"       rebuilt exactly (a created guide: the default design
                                            with its template's preset, all that creating sets)
                            "reconstructed" rebuilt from the import's record (Clean, light and
                                            dark, the imported logo and colour; corners and fonts
                                            from the first publish after the import when that
                                            still had the import's look)
                            "default"       nothing to rebuild from: the default design
    design_baseline_at      when it was recorded or derived

A guide from before resets were recorded gets its baseline derived (and stored) the first time
it's asked for, or just before its first design save, so a design that was never changed is
kept exactly. A reset is a design save (services/docs_site_store.update_site): the Publish
screen's changes, Preview and the home's card follow; nothing is published by it. Uploaded
logos are never deleted; the baseline names them by address.
"""

from __future__ import annotations

import copy
import math
import re
from datetime import datetime
from typing import Any

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import docs_site_settings as site_settings
from app.services import docs_site_templates as templates
from app.services.docs_site_store import ASSETS, JOBS, SITES, SNAPSHOTS, aware, now

_HEX6 = re.compile(r"^#[0-9a-fA-F]{6}$")

# The changes a reset would make, in the Design screen's order, with its words.
FIELDS: tuple[tuple[str, str], ...] = (
    ("preset", "Theme"),
    ("brand_enabled", "Match my brand"),
    ("logo", "Logo"),
    ("brand_colors", "Brand colours"),
    ("fonts", "Fonts"),
    ("mode", "Colour mode"),
    ("corners", "Corners"),
    ("custom", "Custom theme"),
    ("custom_css", "Custom CSS"),
)

NOTES = {
    "default": "This guide was created before resets were recorded, so it goes back to the default design.",
    "reconstructed": "This guide was imported before resets were recorded, so its starting design is rebuilt "
                     "from the import: the Clean theme with the logo and colour the import brought.",
}
NOTE_NO_SHAPE = " GitBook's corners and font weren't recorded, so those follow the theme."
NOTE_SHAPE_FROM_PUBLISH = " Corners and fonts are the ones your first publish after the import had."


def _aware(dt: datetime | None) -> datetime | None:
    return aware(dt)


def _valid_theme(theme: Any) -> dict | None:
    """A full, validated ``settings.theme``, or None when the settings model refuses it."""
    if not isinstance(theme, dict):
        return None
    try:
        return site_settings.validate({**site_settings.default_settings(), "theme": theme})["theme"]
    except site_settings.SettingsError:
        return None


def current_theme(site: dict) -> dict:
    return _valid_theme((site.get("settings") or {}).get("theme")) or site_settings.default_settings()["theme"]


def created_theme(site: dict) -> dict:
    """The design creating the guide gives it (docs_site_store.create_site): the default, with a
    template's preset."""
    theme = site_settings.default_settings()["theme"]
    src = site.get("source") or {}
    if src.get("kind") == "template" and src.get("template") in templates.PRESET_FOR:
        theme["preset"] = templates.PRESET_FOR[src["template"]]
    return theme


# ── Comparing ─────────────────────────────────────────────────────────────────


def _custom(c: Any) -> dict | None:
    """A custom theme without its unset values; None when nothing is set (the preset as designed)."""
    if not isinstance(c, dict):
        return None
    out: dict = {}
    for k, v in c.items():
        if isinstance(v, dict):
            v = {ck: cv for ck, cv in v.items() if cv not in (None, "")} or None
        if v is not None:
            out[k] = v
    return out or None


def _parts(theme: dict) -> dict:
    b = theme.get("brand") or {}
    f = theme.get("fonts") or {}
    return {
        "preset": theme.get("preset") or "clean",
        "brand_enabled": bool(b.get("enabled")),
        "logo": (b.get("logo_url") or None, b.get("logo_dark_url") or None),
        "brand_colors": (list(b.get("colors") or []), b.get("accent") or None, b.get("accent_dark") or None),
        "fonts": (f.get("heading") or None, f.get("body") or None, f.get("mono") or None),
        "mode": theme.get("mode") or "both",
        "corners": theme.get("corners") or None,
        "custom": _custom(theme.get("custom")),
        "custom_css": (theme.get("custom_css") or "").strip() or None,
    }


def changes(current: dict, baseline: dict) -> list[dict]:
    """What a reset changes, ``[{field, label}]``, in the Design screen's order."""
    a, b = _parts(current), _parts(baseline)
    return [{"field": k, "label": label} for k, label in FIELDS if a[k] != b[k]]


# ── Deriving a baseline (guides from before resets were recorded) ─────────────


def _lighten(hex_: str, amount: float) -> str | None:
    """The importer's lighten() (frontend/scripts/docs-import/lib/html.mjs), JS rounding."""
    if not isinstance(hex_, str) or not _HEX6.match(hex_):
        return None
    c = [int(hex_[i:i + 2], 16) for i in (1, 3, 5)]
    return "#" + "".join(f"{math.floor(v + (255 - v) * amount + 0.5):02x}" for v in c)


async def _imported_logo(db: AsyncIOMotorDatabase, site_id: Any, stem: str) -> str | None:
    """The address of the logo an import copied (``import/brand/<stem>.<ext>``), from its file row."""
    row = await db[ASSETS].find_one({"site_id": site_id, "source": "import",
                                     "name": {"$regex": f"^import/brand/{re.escape(stem)}\\.[a-z0-9]+$"}},
                                    {"url": 1, "name": 1})
    if not row:
        return None
    return row.get("url") or f"/docs-assets/{row['name']}"


async def _reconstruct(db: AsyncIOMotorDatabase, site: dict, job: dict) -> tuple[dict, str] | None:
    """The design an old import left, from what its job and the site's files record:
    (theme, note) or None."""
    result = job.get("result") or {}
    if any("imported brand" in str(s) for s in result.get("skipped") or []):
        return None  # the import kept the design as it was (docs_import_job.apply_import)
    picked = ((result.get("report") or {}).get("brand")) or {}
    theme = created_theme(site)
    # The importer's look (gitbook.mjs: Clean, light and dark, GitBook's corners and font).
    theme.update({"preset": "clean", "mode": "both"})
    brand: dict = {"enabled": True}
    if picked.get("logo") is not False:
        brand["logo_url"] = await _imported_logo(db, site["_id"], "logo")
        if brand["logo_url"] and picked.get("logoDark") is not False:
            brand["logo_dark_url"] = await _imported_logo(db, site["_id"], "logo-dark")
    accent = picked.get("accent")
    if isinstance(accent, str) and _HEX6.match(accent):
        brand.update(accent=accent.lower(), colors=[accent.lower()], accent_dark=_lighten(accent.lower(), 0.45))
    theme["brand"] = {**theme["brand"], **brand}
    note = NOTES["reconstructed"]
    # Corners and fonts: the first publish after the import, if it still had the import's look.
    first = await db[SNAPSHOTS].find_one(
        {"site_id": site["_id"], **({"created_at": {"$gte": job["finished_at"]}} if job.get("finished_at") else {})},
        {"settings.theme": 1}, sort=[("created_at", 1)])
    t = ((first or {}).get("settings") or {}).get("theme") or {}
    tb = t.get("brand") or {}
    if t and t.get("preset") == "clean" and (t.get("mode") or "both") == "both" and not _custom(t.get("custom")) \
            and not (t.get("custom_css") or "").strip() and (tb.get("accent") or None) == theme["brand"].get("accent") \
            and (tb.get("logo_url") or None) == theme["brand"].get("logo_url"):
        theme["corners"] = t.get("corners") or None
        fonts = t.get("fonts") or {}
        theme["fonts"] = {"heading": fonts.get("heading") or None, "body": fonts.get("body") or None, "mono": None}
        note += NOTE_SHAPE_FROM_PUBLISH
    else:
        note += NOTE_NO_SHAPE
    valid = _valid_theme(theme)
    return (valid, note) if valid else None


async def derive(db: AsyncIOMotorDatabase, site: dict) -> dict:
    """The best baseline for a guide that has none recorded: {theme, source, how, note}."""
    saved_at = _aware(site.get("design_saved_at"))
    job = None
    if (site.get("source") or {}).get("kind") == "gitbook":
        if site.get("last_import_job_id"):
            job = await db[JOBS].find_one({"_id": site["last_import_job_id"]})
        if job is None:
            job = await db[JOBS].find_one({"site_id": site["_id"], "kind": "import"}, sort=[("created_at", -1)])
    if job is not None and job.get("status") == "done":
        result = job.get("result") or {}
        if _valid_theme(result.get("design")):
            # An import that recorded the design it left (docs_import_job.apply_import).
            return {"theme": _valid_theme(result["design"]), "source": "import", "how": "recorded", "note": None}
        finished = _aware(job.get("finished_at"))
        if saved_at is None or (finished is not None and saved_at <= finished):
            return {"theme": current_theme(site), "source": "import", "how": "unchanged", "note": None}
        rebuilt = await _reconstruct(db, site, job)
        if rebuilt:
            return {"theme": rebuilt[0], "source": "import", "how": "reconstructed", "note": rebuilt[1]}
        if any("imported brand" in str(s) for s in result.get("skipped") or []):
            return {"theme": created_theme(site), "source": "created", "how": "rebuilt", "note": None}
        return {"theme": site_settings.default_settings()["theme"], "source": "created", "how": "default",
                "note": NOTES["default"]}
    if (site.get("source") or {}).get("kind") == "gitbook" and job is None:
        # An imported guide with no record of its import: nothing to rebuild from.
        if saved_at is None:
            return {"theme": current_theme(site), "source": "import", "how": "unchanged", "note": None}
        return {"theme": site_settings.default_settings()["theme"], "source": "created", "how": "default",
                "note": NOTES["default"]}
    # Created (blank, template, GitHub), or an import that hasn't finished or failed (it leaves the
    # design as created): creating sets only the template's preset, so this is exact.
    if saved_at is None:
        return {"theme": current_theme(site), "source": "created", "how": "unchanged", "note": None}
    return {"theme": created_theme(site), "source": "created", "how": "rebuilt", "note": None}


# ── Recording ─────────────────────────────────────────────────────────────────


def baseline_fields(theme: dict, source: str, how: str = "recorded", note: str | None = None) -> dict:
    return {"design_baseline": copy.deepcopy(theme), "design_baseline_source": source,
            "design_baseline_how": how, "design_baseline_note": note, "design_baseline_at": now()}


async def ensure(db: AsyncIOMotorDatabase, site: dict) -> dict:
    """The site's baseline {theme, source, how, note, at}, deriving and storing one if it has none."""
    theme = _valid_theme(site.get("design_baseline"))
    if theme is not None:
        return {"theme": theme, "source": site.get("design_baseline_source") or "created",
                "how": site.get("design_baseline_how") or "recorded", "note": site.get("design_baseline_note"),
                "at": _aware(site.get("design_baseline_at"))}
    d = await derive(db, site)
    fields = baseline_fields(d["theme"], d["source"], d["how"], d["note"])
    # Only where there's still none (two first requests at once store the same thing once).
    await db[SITES].update_one({"_id": site["_id"], "design_baseline": None}, {"$set": fields})
    site.update(fields)
    return {"theme": d["theme"], "source": d["source"], "how": d["how"], "note": d["note"],
            "at": fields["design_baseline_at"]}


async def record_after_import(db: AsyncIOMotorDatabase, site: dict, before: dict | None, after: dict) -> None:
    """An import finished: the design it left becomes the baseline when it changed the design (a
    re-import that brings the same look, or none, leaves the baseline alone)."""
    if before is not None and not changes(before, after):
        return
    await db[SITES].update_one({"_id": site["_id"]}, {"$set": baseline_fields(after, "import")})


async def reset(db: AsyncIOMotorDatabase, site: dict) -> dict:
    """The design back to the baseline, as a design save (the site row after it). Already the
    baseline: nothing is written."""
    from app.services import docs_site_store as store

    baseline = await ensure(db, site)
    if not changes(current_theme(site), baseline["theme"]):
        return site
    return await store.update_site(db, site, name=None, slug=None, settings_patch={"theme": baseline["theme"]})


# ── The API's view ────────────────────────────────────────────────────────────


def view(site: dict, baseline: dict) -> dict:
    """GET /docs-sites/{id}/design/baseline: what a reset goes back to and what it would change."""
    cur = current_theme(site)
    diff = changes(cur, baseline["theme"])
    return {
        "source": baseline["source"],
        "how": baseline["how"],
        "note": baseline.get("note"),
        "recorded_at": baseline.get("at"),
        "theme": baseline["theme"],
        "changes": diff,
        "same": not diff,
    }
