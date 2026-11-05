"""Theme presets for hosted docs sites: the API accepts every preset the docs
engine renders (frontend/src/docs/theme.mjs PRESETS), the default stays Clean,
and anything else is refused. No database or network here.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

from tests import _email_env  # noqa: F401  (pins settings before app.config is first imported)

from app.services import docs_site_settings as site_settings
from app.services.docs_site_settings import PRESETS, SettingsError, default_settings, deep_merge, validate

THEME_MJS = Path(__file__).resolve().parent / ".." / ".." / "frontend" / "src" / "docs" / "theme.mjs"

NEW = ("midnight", "paper", "terminal", "corporate", "studio", "academic", "atlas", "pastel")


def engine_presets(src: str) -> list[str]:
    """The keys of `export const PRESETS = { … };` in theme.mjs, in order (two-space-indented ids)."""
    block = src.split("export const PRESETS = {", 1)[1].split("\n};", 1)[0]
    return re.findall(r"^  ([a-z]+): \{", block, re.M)


class Presets(unittest.TestCase):
    def test_same_list_as_the_engine(self):
        if not THEME_MJS.is_file():
            self.skipTest(f"the docs engine is missing ({THEME_MJS.resolve()}); run from a full checkout of the repo")
        self.assertEqual(engine_presets(THEME_MJS.read_text(encoding="utf-8")), list(PRESETS))
        self.assertEqual(len(PRESETS), 14)

    def test_each_new_preset_validates(self):
        for preset in NEW:
            with self.subTest(preset=preset):
                got = validate(deep_merge(default_settings(), {"theme": {"preset": preset, "mode": "dark"}}))
                self.assertEqual((got["theme"]["preset"], got["theme"]["mode"]), (preset, "dark"))
                # Match my brand works with every preset (the engine derives the palette).
                got = validate(deep_merge(default_settings(), {"theme": {"preset": preset, "brand": {"enabled": True, "colors": ["#0F766E"]}}}))
                self.assertEqual(got["theme"]["brand"]["colors"], ["#0f766e"])

    def test_defaults_unchanged(self):
        self.assertEqual(default_settings()["theme"]["preset"], "clean")
        self.assertEqual(site_settings.Theme().preset, "clean")

    def test_same_fonts_and_custom_theme_lists_as_the_engine(self):
        """theme.mjs FONTS, CUSTOM_COLORS, CUSTOM_OPTIONS, CUSTOM_BOOLS and CUSTOM_RANGES: the API's
        lists are the engine's (snake_case here, camelCase there)."""
        if not THEME_MJS.is_file():
            self.skipTest("the docs engine is missing; run from a full checkout of the repo")
        src = THEME_MJS.read_text(encoding="utf-8")
        snake = lambda k: re.sub(r"[A-Z]", lambda m: "_" + m.group(0).lower(), k)  # noqa: E731
        fonts_block = src.split("export const FONTS = {", 1)[1].split("\n};", 1)[0]
        fonts = re.findall(r'^  "?([a-z0-9-]+)"?: \{ label: "[^"]+", kind: "(\w+)"', fonts_block, re.M)
        self.assertEqual(sorted(f for f, _ in fonts), sorted(site_settings.FONT_IDS))
        self.assertEqual(sorted(f for f, k in fonts if k == "mono"), sorted(site_settings.MONO_FONT_IDS))
        colors = re.search(r"export const CUSTOM_COLORS = \[([^\]]+)\]", src).group(1)
        self.assertEqual([snake(c) for c in re.findall(r'"(\w+)"', colors)], list(site_settings.CUSTOM_COLORS))
        opts_block = src.split("export const CUSTOM_OPTIONS = {", 1)[1].split("\n};", 1)[0]
        opts = {snake(k): tuple(re.findall(r'"(\w+)"', v)) for k, v in re.findall(r"^  (\w+): \[([^\]]+)\]", opts_block, re.M)}
        self.assertEqual(opts, site_settings.CUSTOM_OPTIONS)
        bools = re.search(r"export const CUSTOM_BOOLS = \[([^\]]+)\]", src).group(1)
        self.assertEqual([snake(b) for b in re.findall(r'"(\w+)"', bools)], list(site_settings.CUSTOM_BOOLS))
        ranges_block = src.split("export const CUSTOM_RANGES = {", 1)[1].split("\n};", 1)[0]
        ranges = {snake(k): tuple(float(x) for x in v.split(",")) for k, v in re.findall(r"^  (\w+): \[([^\]]+)\]", ranges_block, re.M)}
        self.assertEqual(ranges, {k: tuple(float(x) for x in v) for k, v in site_settings.CUSTOM_RANGES.items()})

    def test_unknown_preset_refused(self):
        for bad in ("Midnight", "dark", "", "night"):
            with self.subTest(bad=bad), self.assertRaises(SettingsError):
                validate(deep_merge(default_settings(), {"theme": {"preset": bad}}))


if __name__ == "__main__":
    unittest.main()
