/**
 * Themes: palettes keep their contrast promises for every preset and any brand colour, the custom
 * CSS sanitiser, docs:check's validation, and the stylesheet the engine inlines.
 *   node --test src/docs/theme.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PRESETS,
  FONTS,
  CORNERS,
  accentFor,
  brandRoles,
  buildPalette,
  contrast,
  paletteReport,
  paletteTokens,
  parseHex,
  resolveTheme,
  sanitizeCss,
  themeCss,
  validateBrandColors,
  validateTheme,
} from "./theme.mjs";

/** Awkward brand colours: yellow, lime, white-ish, near-black, pure primaries, greys, the board's teal. */
const BRANDS = ["#facc15", "#a3e635", "#f8fafc", "#0b0b0b", "#ff0000", "#00ff00", "#0000ff", "#808080", "#0f766e", "#7c3aed", "#ec4899", "#14b8a6", "#f97316", "#1e3a8a", "#fde68a"];

test("no theme key: nothing to render (docs.markdrop.in stays as it is)", () => {
  assert.equal(resolveTheme(undefined), null);
  assert.equal(resolveTheme(null), null);
  assert.equal(resolveTheme("editorial"), null);
});

test("defaults: an empty theme is the clean preset, both modes, Markdrop's tokens", () => {
  const t = resolveTheme({});
  assert.equal(t.preset, "clean");
  assert.equal(t.layout, "sidebar");
  assert.equal(t.mode, "both");
  assert.equal(t.palette, null);
  assert.deepEqual(t.radius, CORNERS.soft);
  assert.deepEqual(t.fonts, { heading: "manrope", body: "manrope", mono: "jetbrains-mono" });
});

test("presets: layouts, fonts and corners as designed", () => {
  const layout = Object.fromEntries(Object.keys(PRESETS).map((p) => [p, resolveTheme({ preset: p }).layout]));
  assert.deepEqual(layout, { clean: "sidebar", editorial: "top", technical: "sidebar", minimal: "top", playful: "sidebar", helpcenter: "helpcenter" });
  assert.equal(resolveTheme({ preset: "editorial" }).fonts.heading, "newsreader");
  assert.equal(resolveTheme({ preset: "technical" }).fonts.mono, "plex-mono");
  assert.equal(resolveTheme({ preset: "technical" }).radius.lg, 3);
  assert.equal(resolveTheme({ preset: "playful" }).radius.xl, 16);
  // corners and fonts override the preset; a code font can't be the body.
  const t = resolveTheme({ preset: "technical", corners: "round", fonts: { heading: "lora", body: "jetbrains-mono" } });
  assert.deepEqual(t.radius, CORNERS.round);
  assert.equal(t.fonts.heading, "lora");
  assert.equal(t.fonts.body, "plex");
  for (const p of Object.values(PRESETS)) for (const id of Object.values(p.fonts)) assert.ok(FONTS[id], `${id} is in the allow-list`);
});

test("the API's shape: its font ids, nulls for defaults, brand colours in brand.colors", () => {
  for (const id of ["system", "inter", "manrope", "geist", "dmsans", "plex", "nunito", "source-sans-3", "newsreader", "source-serif-4", "lora", "jetbrains-mono", "plex-mono"]) assert.ok(FONTS[id], id);
  const t = resolveTheme({ preset: "editorial", fonts: { heading: null, body: "plex" }, corners: null, mode: "both", customCss: null }, { name: "Acme", accent: null, accentDark: null, colors: ["#0f766e", "#13203a"] });
  assert.equal(t.fonts.heading, "newsreader");
  assert.equal(t.fonts.body, "plex");
  assert.deepEqual(t.radius, PRESETS.editorial.corners);
  assert.equal(t.palette.accent, "#0f766e");
  assert.equal(t.palette.light.text, "#13203a");
  // Brand colours without a theme key still build a palette on the clean layout.
  assert.equal(resolveTheme(undefined, { colors: ["#7c3aed"] }).palette.accent, "#7c3aed");
  assert.equal(resolveTheme(undefined, { colors: [] }), null);
});

function assertReport(r, what) {
  for (const theme of ["light", "dark"]) {
    const x = r[theme];
    assert.ok(x.text >= 12, `${what} ${theme} text ${x.text}`);
    assert.ok(x.muted >= 4.5, `${what} ${theme} muted ${x.muted}`);
    assert.ok(x.links >= 4.5, `${what} ${theme} links ${x.links}`);
    assert.ok(x.button >= 4.5, `${what} ${theme} button ${x.button}`);
  }
}

test("contrast: every preset palette meets text 12:1, muted / links / buttons 4.5:1, both themes", () => {
  for (const id of Object.keys(PRESETS)) {
    const pal = buildPalette(id, {});
    if (pal) assertReport(paletteReport(pal), id);
  }
});

test("contrast: any brand colour on any preset still meets it (Match my brand)", () => {
  for (const id of Object.keys(PRESETS)) {
    for (const c of BRANDS) {
      assertReport(paletteReport(buildPalette(id, { colors: [c] })), `${id} ${c}`);
      assertReport(paletteReport(buildPalette(id, { colors: [c, "#13203a", "#e6f4f1"] })), `${id} ${c}+ink+tint`);
    }
  }
});

test("contrast: links also clear 4.5:1 on their own wash and a dark fill stays visible on a dark page", () => {
  for (const c of BRANDS) {
    for (const theme of ["light", "dark"]) {
      const t = paletteTokens(buildPalette("clean", { colors: [c] }), theme);
      const bg = parseHex(t["--bg"]);
      const wash = theme === "light" ? 0.14 : 0.28;
      const fill = parseHex(t["--accent"]);
      const washed = bg.map((v, i) => v + (parseHex(c)[i] - v) * wash);
      assert.ok(contrast(parseHex(t["--accent-text"]), washed) >= 4.5, `${c} ${theme} link on wash`);
      if (theme === "dark") assert.ok(contrast(fill, bg) >= 2.9, `${c} dark fill vs page ${contrast(fill, bg)}`);
    }
  }
});

test("brand roles: accent, ink and tint picked from a logo's colours", () => {
  assert.deepEqual(brandRoles(["#0f766e", "#13203a", "#f59e0b", "#e6f4f1"]), { accent: "#0f766e", ink: "#13203a", tint: "#e6f4f1" });
  assert.deepEqual(brandRoles(["#13203a", "#f59e0b"]), { accent: "#f59e0b", ink: "#13203a", tint: undefined });
  assert.equal(brandRoles(["nope"]), null);
  // brand.accent wins over the colours' accent.
  assert.equal(buildPalette("clean", { colors: ["#0f766e"], accent: "#2563eb" }).accent, "#2563eb");
});

test("same accent maths as components/tenant/branding.ts on Markdrop's grounds", async (t) => {
  let branding;
  try {
    branding = await import("../components/tenant/branding.ts");
  } catch {
    return t.skip("this Node can't load .ts (needs type stripping, Node 22.18+)");
  }
  const LIGHT = [[227, 231, 237], [235, 238, 242], [242, 244, 247]];
  const DARK = [[3, 7, 18], [16, 24, 40], [30, 41, 57]];
  for (const c of BRANDS) {
    const ref = branding.accentTokens(c);
    const light = accentFor(c, "light", LIGHT);
    assert.deepEqual([light.accent, light.accentHover, light.onAccent, light.text, light.textHover], [ref.accent, ref.accentHover, ref.onAccent, ref.text.light.base, ref.text.light.hover], c);
    const dark = accentFor(c, "dark", DARK);
    assert.deepEqual([dark.text, dark.textHover], [ref.text.dark.base, ref.text.dark.hover], c);
  }
});

test("custom CSS: scoped under the docs root", () => {
  const { css, errors } = sanitizeCss(`
    /* a comment */
    :root { --accent: #f00 }
    h1, .dx-title:hover { letter-spacing: 0 }
    html[data-theme="dark"] .dx-card { border-color: #333 }
    [data-theme="light"] p { color: #111 }
    body > main { padding: 0 }
    .dx-root .x { margin: 0 }
    @media (max-width: 600px) { .a { b: c } @supports (display: grid) { .d { e: f } } }
    @keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }
    .bg { background: url("https://cdn.example.com/a.png") center / cover, url(/docs-assets/b.png) }
    a[href^="https://x"] { content: "a, b { }" }
  `);
  assert.deepEqual(errors, []);
  assert.ok(css.includes(".dx-root{--accent: #f00}"), css);
  assert.ok(css.includes(".dx-root h1,.dx-root .dx-title:hover{"), css);
  assert.ok(css.includes('html[data-theme="dark"] .dx-root .dx-card{'), css);
  assert.ok(css.includes('[data-theme="light"] .dx-root p{'), css);
  assert.ok(css.includes(".dx-root > main{"), css);
  assert.ok(css.includes(".dx-root .x{"), css);
  assert.ok(css.includes("@media (max-width: 600px){.dx-root .a{b: c}@supports (display: grid){.dx-root .d{e: f}}}"), css);
  assert.ok(css.includes("@keyframes spin{from { transform: rotate(0) } to { transform: rotate(360deg) }}"), css);
  assert.ok(css.includes('.dx-root a[href^="https://x"]{content: "a, b { }"}'), css);
  assert.ok(!css.includes("comment"));
});

test("custom CSS: rejects what could escape the stylesheet or load from elsewhere", () => {
  const bad = {
    "</style><script>alert(1)</script>": "</style",
    ".a { color: red } </STYLE >": "</style",
    "@import url(https://evil.example/x.css);": "@import",
    ".a { width: expression(alert(1)) }": "expression()",
    ".a { background: url(javascript:alert(1)) }": "javascript:",
    ".a { background: url(http://insecure.example/a.png) }": "https URL",
    ".a { background: url(data:image/png;base64,AAAA) }": "https URL",
    ".a { background: url(//evil.example/a.png) }": "https URL",
    ".a { -moz-binding: url(https://x/x.xml#x) }": "-moz-binding",
    ".a { behavior: url(https://x/x.htc) }": "behavior:",
    ".a { b\\61ckground: red }": "backslash",
    ".a { background: image-set('https://x/a.png' 1x) }": "image-set()",
    "@font-face { font-family: X; src: url(http://x/a.woff2) }": "https URL",
    "@page { margin: 0 }": "@page",
    "@namespace svg url(https://x);": "not allowed",
    ".a { color: red": "no matching }",
    ".a { color: red } }": "no matching {",
    ".a { .b { c: d } }": "nested block",
    "{ color: red }": "no selector",
    // A browser ends a string at a line break: `body {…}` would land outside the scope.
    '.a { content: "x\n} body { color: red } .b { content: " }': "line break",
    ".dx-root ~ footer { display: none }": "outside the docs root",
    "body + x { b: c }": "outside the docs root",
    ".a { background: url(/docs-assets/a/../../api/me) }": '".."',
    ".a { background: url(/docs-assets//x.png) }": '"//"',
    "[data-theme=dark .a { b: c }": "[ without a matching ]",
  };
  for (const [input, want] of Object.entries(bad)) {
    const { css, errors } = sanitizeCss(input);
    assert.equal(css, "", input);
    assert.ok(errors.some((e) => e.includes(want)), `${input} → ${errors.join(" | ")}`);
  }
  assert.ok(sanitizeCss("a{}".padEnd(20 * 1024 + 1, " ")).errors[0].includes("limit"));
  assert.deepEqual(sanitizeCss(42).errors, ["customCss must be a string"]);
});

test("custom CSS: the corpus the API's validator (docs_site_settings.css_problem) also runs", () => {
  // Shared with backend/tests/test_docs_site_css.py so the API refuses exactly what the engine drops.
  const corpus = JSON.parse(readFileSync(new URL("./customCss.corpus.json", import.meta.url), "utf8"));
  assert.ok(corpus.length >= 40);
  for (const { css, ok, why } of corpus) {
    const { errors } = sanitizeCss(css);
    assert.equal(errors.length === 0, ok, `${why}: ${JSON.stringify(css)} → ${errors.join(" | ")}`);
  }
  // The limit counts UTF-16 units: a non-BMP character is two.
  assert.deepEqual(sanitizeCss("a{}".padEnd(20 * 1024, " ")).errors, []);
  assert.ok(sanitizeCss("a{}".padEnd(20 * 1024 - 1, " ") + "😀").errors[0].includes("limit"));
});

test("validation: what docs:check reports", () => {
  assert.deepEqual(validateTheme(undefined), []);
  assert.deepEqual(validateTheme({ preset: "editorial", fonts: { heading: "lora" }, corners: "round", mode: "dark", customCss: ".a{b:c}" }), []);
  // What the API writes for "Theme default": nulls.
  assert.deepEqual(validateTheme({ preset: "clean", fonts: { heading: null, body: null }, corners: null, mode: "both", customCss: null }), []);
  const msgs = (t) => validateTheme(t).map((p) => `${p.level}: ${p.msg}`);
  assert.match(msgs("x")[0], /theme must be an object/);
  assert.match(msgs({ preset: "fancy" })[0], /^error: theme.preset "fancy"/);
  assert.match(msgs({ fonts: { heading: "comic-sans" } })[0], /^error: theme.fonts.heading "comic-sans" isn't an available font/);
  assert.match(msgs({ fonts: { mono: "inter" } })[0], /isn't a monospaced font/);
  assert.match(msgs({ fonts: { body: "geist-mono" } })[0], /is a code font/);
  assert.match(msgs({ corners: "pointy" })[0], /sharp, soft or round/);
  assert.match(msgs({ mode: "auto" })[0], /both, light or dark/);
  assert.match(msgs({ colors: ["#000"] })[0], /^warn: theme.colors is not a setting/);
  assert.deepEqual(validateBrandColors(undefined), []);
  assert.deepEqual(validateBrandColors(["#0f766e", "#13203a"]), []);
  assert.match(validateBrandColors(["teal"])[0], /brand.colors\[0\] "teal"/);
  assert.match(validateBrandColors("teal")[0], /up to 8 hex colours/);
  assert.match(msgs({ customCss: "@import url(https://x)" })[0], /^error: theme.customCss: @import/);
  assert.match(msgs({ layout: "x" })[0], /^warn: theme.layout is not a setting/);
});

test("stylesheet: fonts, corners, palette per mode, custom CSS last", () => {
  const families = { newsreader: "'__news_1'", "source-sans-3": "'__ss3_1'", "jetbrains-mono": "var(--font-jetbrains)" };
  const both = themeCss(resolveTheme({ preset: "editorial", customCss: ".x{y:z}" }), families);
  assert.ok(both.startsWith("html:root{--font-sans:'__ss3_1', ui-sans-serif, system-ui, sans-serif;--font-mono:var(--font-jetbrains), ui-monospace"), both);
  assert.ok(both.includes("--dx-font-heading:'__news_1', ui-serif, Georgia, serif"));
  assert.ok(both.includes("--radius-lg:4px"));
  assert.ok(both.includes(':root,[data-theme="dark"][data-theme]{--bg:#1a1612;'));
  assert.ok(both.includes('[data-theme="light"][data-theme]{--bg:#fbf8f3;'));
  assert.ok(both.trimEnd().endsWith(".dx-root .x{y:z}"));
  // A forced mode writes one palette for every theme attribute.
  const dark = themeCss(resolveTheme({ preset: "editorial", mode: "dark" }), families);
  assert.ok(dark.includes(":root,[data-theme][data-theme]{--bg:#1a1612;"));
  assert.ok(!dark.includes("#fbf8f3"));
  // Clean without colours: no palette at all (Markdrop's own tokens).
  assert.ok(!themeCss(resolveTheme({ preset: "clean" }), families).includes("--bg"));
  // Invalid custom CSS is dropped, the rest of the theme stays.
  const t = resolveTheme({ preset: "minimal", customCss: "</style>" });
  assert.equal(t.customCss, "");
  assert.ok(t.customCssErrors.length > 0);
});
