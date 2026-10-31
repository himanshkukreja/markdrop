"""Theme presets for hosted docs sites: the API accepts every preset the docs
engine renders (frontend/src/docs/theme.mjs PRESETS), the default stays Clean,
and anything else is refused. No database or network here.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

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

    def test_unknown_preset_refused(self):
        for bad in ("Midnight", "dark", "", "night"):
            with self.subTest(bad=bad), self.assertRaises(SettingsError):
                validate(deep_merge(default_settings(), {"theme": {"preset": bad}}))


if __name__ == "__main__":
    unittest.main()
