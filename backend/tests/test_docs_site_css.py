"""Custom CSS for hosted docs sites: the API's check (docs_site_settings.css_problem)
accepts exactly what the docs engine's sanitizeCss() accepts.

The cases live in frontend/src/docs/customCss.corpus.json, whose ``ok`` values
were produced by running the engine; frontend/src/docs/theme.test.mjs runs the
same file against sanitizeCss(). No database or network here.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from app.services import docs_site_settings as site_settings
from app.services.docs_site_settings import CUSTOM_CSS_MAX, css_problem

CORPUS = Path(__file__).resolve().parent / ".." / ".." / "frontend" / "src" / "docs" / "customCss.corpus.json"


class Corpus(unittest.TestCase):
    def setUp(self):
        if not CORPUS.is_file():
            self.skipTest(f"the shared custom-CSS corpus is missing ({CORPUS.resolve()}); "
                          "run from a full checkout of the repo")
        self.cases = json.loads(CORPUS.read_text(encoding="utf-8"))

    def test_matches_the_engine(self):
        self.assertGreaterEqual(len(self.cases), 40)
        self.assertTrue(any(c["ok"] for c in self.cases) and not all(c["ok"] for c in self.cases))
        for case in self.cases:
            problem = css_problem(case["css"])
            with self.subTest(why=case["why"]):
                self.assertEqual(problem is None, case["ok"], f"{case['css']!r} -> {problem}")

    def test_one_readable_message_per_refusal(self):
        for case in self.cases:
            if not case["ok"]:
                problem = css_problem(case["css"])
                with self.subTest(why=case["why"]):
                    self.assertIsInstance(problem, str)
                    self.assertIn("ustom CSS", problem)
                    self.assertNotIn("\n", problem)


class Messages(unittest.TestCase):
    def test_first_reason_phrased_for_the_dashboard(self):
        for css, want in (
            ("@import url(https://x.test/a.css);", "Custom CSS can't use @import."),
            (".a { background: url(http://x.test/a.png) }",
             "url() in custom CSS must be an https:// address or an uploaded file (/docs-assets/…)."),
            (".a { color: red", "Custom CSS has a { without a matching }."),
            (".a { color: red } }", "Custom CSS has a } without a matching {."),
            (".a { b: c } /* open", "Custom CSS has a /* comment that is never closed with */."),
            (".a { b\\61ckground: red }", "Custom CSS can't use backslash escapes (\\)."),
            # </style> is reported before the bare <, as the engine orders them.
            ("</style>", "Custom CSS can't contain </style> or other HTML."),
            (".a { content: \"x\n} body { color: red } .b { content: \" }",
             "Custom CSS has a string with a line break in it; close the quote on the same line."),
            (".a { background: url(/docs-assets/a/../../api/me) }",
             "url() in custom CSS: a /docs-assets/ path can't have \"..\", \"//\" or a backslash in it."),
            (".dx-root ~ footer { display: none }",
             "Custom CSS: \".dx-root ~ footer\" reaches outside the docs root "
             "(~ or + can't follow the root, :root, html or body)."),
            ("[data-theme=dark .a { b: c }", "Custom CSS: the selector \"[data-theme=dark .a\" has a [ without a matching ]."),
        ):
            self.assertEqual(css_problem(css), want, css)
        self.assertIn("@page", css_problem("@page { margin: 0 }"))
        self.assertIn("nested block", css_problem(".a { .b { c: d } }"))
        self.assertIn("too deeply", css_problem("@media a{@media b{@media c{@media d{@media e{.x{y:z}}}}}}"))
        self.assertIsNone(css_problem("@media a{@media b{@media c{@media d{.x{y:z}}}}}"))


class SizeLimit(unittest.TestCase):
    """20 KB counted as the engine counts it: UTF-16 code units (``input.length``)."""

    def test_exactly_at_the_limit(self):
        css = "a{}".ljust(CUSTOM_CSS_MAX)
        self.assertEqual(len(css), 20480)
        self.assertIsNone(css_problem(css))
        self.assertEqual(css_problem(css + " "), "Custom CSS can be at most 20 KB.")

    def test_non_bmp_counts_twice(self):
        base = "a{content:'"
        tail = "'}"
        fill = CUSTOM_CSS_MAX - len(base) - len(tail) - 2
        at_limit = base + "x" * fill + "😀" + tail  # 20479 code points, 20480 UTF-16 units
        self.assertEqual(len(at_limit), CUSTOM_CSS_MAX - 1)
        self.assertIsNone(css_problem(at_limit))
        over = base + "x" * (fill + 1) + "😀" + tail  # 20480 code points, 20481 units
        self.assertEqual(len(over), CUSTOM_CSS_MAX)
        self.assertEqual(css_problem(over), "Custom CSS can be at most 20 KB.")

    def test_multibyte_bmp_counts_once(self):
        # "→" is 3 bytes in UTF-8 but one UTF-16 unit: 20 K of them is within the limit.
        css = "a{content:'" + "→" * (CUSTOM_CSS_MAX - 13) + "'}"
        self.assertEqual(len(css), CUSTOM_CSS_MAX)
        self.assertIsNone(css_problem(css))


class ThemeModel(unittest.TestCase):
    def test_bad_css_is_a_422_with_the_message(self):
        with self.assertRaises(site_settings.SettingsError) as ctx:
            site_settings.validate({"theme": {"custom_css": ".a { background: url(data:image/png;base64,AA) }"}})
        errors = ctx.exception.errors
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["loc"], ["settings", "theme", "custom_css"])
        self.assertEqual(errors[0]["msg"],
                         "url() in custom CSS must be an https:// address or an uploaded file (/docs-assets/…).")

    def test_good_and_blank_css(self):
        css = "@layer base, theme; @font-face { font-family: Acme; src: url(https://f.test/a.woff2) }"
        self.assertEqual(site_settings.validate({"theme": {"custom_css": css}})["theme"]["custom_css"], css)
        self.assertIsNone(site_settings.validate({"theme": {"custom_css": "  \n "}})["theme"]["custom_css"])


if __name__ == "__main__":
    unittest.main()
