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
  headerTabs,
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
  CUSTOM_COLORS,
  CUSTOM_OPTIONS,
  CUSTOM_RADIUS,
  codeTokens,
  contrastGuard,
  normalizeCustom,
  themeAttrs,
  validateCustom,
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
  assert.deepEqual(layout, {
    clean: "sidebar", editorial: "top", technical: "sidebar", minimal: "top", playful: "sidebar", helpcenter: "helpcenter",
    midnight: "sidebar", paper: "sidebar", terminal: "sidebar", corporate: "sidebar", studio: "sidebar", academic: "sidebar", atlas: "sidebar", pastel: "sidebar",
  });
  // The help center's home: its own layout, and Atlas's card-grid home in front of sidebar articles.
  const homes = Object.keys(PRESETS).filter((p) => resolveTheme({ preset: p }).home === "categories");
  assert.deepEqual(homes, ["helpcenter", "atlas"]);
  assert.equal(resolveTheme({ preset: "clean" }).home, "hero");
  assert.equal(resolveTheme({ preset: "terminal" }).fonts.heading, "jetbrains-mono");
  assert.equal(resolveTheme({ preset: "corporate" }).radius.md, 2);
  assert.equal(resolveTheme({ preset: "studio" }).radius.lg, 12);
  assert.equal(resolveTheme({ preset: "pastel" }).radius.lg, 10);
  for (const p of ["paper", "academic"]) assert.equal(FONTS[resolveTheme({ preset: p }).fonts.body].kind, "serif", p);
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

/**
 * The eight presets of the Themes board's "Choose a look" (Midnight … Pastel): what readers get,
 * per theme, as paletteReport gives it (the minimum over the page, cards, raised and inset grounds).
 * A change to one of these palettes should be a decision, so the numbers are pinned here.
 */
const NEW_PRESETS = {
  midnight: { light: { text: 16.1, muted: 5.9, links: 6.2, button: 7.1 }, dark: { text: 13.2, muted: 6.8, links: 6.1, button: 7.4 } },
  paper: { light: { text: 13.4, muted: 5.4, links: 6.4, button: 7.3 }, dark: { text: 12.6, muted: 5.9, links: 8.7, button: 11.9 } },
  terminal: { light: { text: 16.2, muted: 6.3, links: 5.2, button: 5 }, dark: { text: 14, muted: 7.1, links: 9.4, button: 11.6 } },
  corporate: { light: { text: 15.1, muted: 6.4, links: 7.4, button: 8.7 }, dark: { text: 12.2, muted: 6, links: 8.3, button: 11.2 } },
  studio: { light: { text: 17, muted: 6.1, links: 5.3, button: 4.7 }, dark: { text: 14.3, muted: 7.2, links: 6.1, button: 7.5 } },
  academic: { light: { text: 16, muted: 6.3, links: 5.3, button: 5.5 }, dark: { text: 13.1, muted: 6.5, links: 8, button: 10.5 } },
  atlas: { light: { text: 15.5, muted: 6, links: 5.2, button: 5.9 }, dark: { text: 12.8, muted: 6.2, links: 6.9, button: 9.4 } },
  pastel: { light: { text: 14.9, muted: 5.8, links: 5.4, button: 6 }, dark: { text: 13.1, muted: 7.1, links: 6.1, button: 7.6 } },
};

test("contrast: the eight new presets, as designed (WCAG AA in both themes, nothing rescued by clamping)", () => {
  assert.deepEqual(Object.keys(PRESETS).slice(6), Object.keys(NEW_PRESETS));
  for (const [id, want] of Object.entries(NEW_PRESETS)) {
    const pal = buildPalette(id, {});
    assert.deepEqual(paletteReport(pal), want, id);
    for (const theme of ["light", "dark"]) {
      const p = PRESETS[id].palette[theme];
      const t = paletteTokens(pal, theme);
      // The palette's own text colours already pass: the maths keeps them as written.
      assert.equal(t["--text"], p.text, `${id} ${theme} text kept`);
      assert.equal(t["--text-muted"], p.muted, `${id} ${theme} muted kept`);
      const on = (fg, keys) => Math.min(...keys.map((k) => contrast(parseHex(fg), parseHex(p[k]))));
      assert.ok(on(p.text, ["bg", "card", "header"]) >= 12, `${id} ${theme} text`);
      assert.ok(on(p.muted, ["bg", "card", "header"]) >= 4.5, `${id} ${theme} muted`);
      assert.ok(contrast(parseHex(p.codeText), parseHex(p.code)) >= 7, `${id} ${theme} code`);
      // Secondary text (lists, ledes) is body text too.
      assert.ok(contrast(parseHex(t["--text-secondary"]), parseHex(t["--bg"])) >= 4.5, `${id} ${theme} secondary`);
      // The accent fill is a visible UI shape on the page (3:1) in the dark theme.
      if (theme === "dark") assert.ok(contrast(parseHex(t["--accent"]), parseHex(t["--bg"])) >= 3, `${id} dark fill`);
    }
  }
});

test("a preset's own dark accent: used without brand colours, replaced by a brand accent", () => {
  assert.equal(buildPalette("midnight", {}).accentDark, "#a78bfa");
  assert.equal(paletteTokens(buildPalette("midnight", {}), "dark")["--accent"], "#a78bfa");
  // Match my brand replaces both accents (the dark one is derived from the brand's)...
  assert.equal(buildPalette("midnight", { colors: ["#0f766e"] }).accentDark, undefined);
  assert.equal(buildPalette("midnight", { accent: "#0f766e" }).accentDark, undefined);
  // ...unless the brand names its own dark accent.
  assert.equal(buildPalette("midnight", { colors: ["#0f766e"], accentDark: "#5eead4" }).accentDark, "#5eead4");
  // The six first presets have none: their output is what it was.
  for (const id of ["editorial", "technical", "minimal", "playful", "helpcenter"]) assert.equal(buildPalette(id, {}).accentDark, undefined, id);
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

test("Atlas: the header shows the nav groups as tabs when the site has no tabs of its own", () => {
  assert.equal(resolveTheme({ preset: "atlas" }).sectionTabs, true);
  assert.equal(resolveTheme({ preset: "helpcenter" }).sectionTabs, false);
  const groups = [
    { group: "Getting started", tab: "docs", items: [{ path: "/intro", available: true }, { path: "/quickstart", available: true }] },
    { group: "Guides", tab: "docs", items: [{ path: "/soon", available: false }, { path: "/connect", available: true }] },
    { group: "Drafts", tab: "docs", items: [{ path: "/draft", available: false }] },
    { group: "Endpoints", tab: "api", items: [{ path: "/api/list", available: true }] },
  ];
  const one = [{ id: "docs", label: "Docs", href: "/" }];
  assert.deepEqual(headerTabs(one, groups, { sections: true, current: "/connect" }), [
    { key: "g-Getting started", label: "Getting started", href: "/intro", current: false },
    { key: "g-Guides", label: "Guides", href: "/connect", current: true },
  ]);
  // Another theme, or a site with tabs of its own: its tabs as they are.
  assert.deepEqual(headerTabs(one, groups, { sections: false, activeTab: "docs" }), [{ key: "docs", label: "Docs", href: "/", current: true }]);
  const two = [...one, { id: "api", label: "API", href: "/api" }];
  assert.deepEqual(headerTabs(two, groups, { sections: true, activeTab: "api" }).map((t) => [t.label, t.current]), [["Docs", false], ["API", true]]);
  // Fewer than two sections: no point in tabs.
  assert.deepEqual(headerTabs([], groups.slice(0, 1), { sections: true }), []);
});

/* ── custom themes (the theme builder) ───────────────────────────────────── */

test("custom: presets stay exactly as they were without a custom block", () => {
  for (const p of Object.keys(PRESETS)) {
    const plain = resolveTheme({ preset: p });
    for (const empty of [undefined, null, {}, { light: {}, dark: {} }, { baseSize: "big", icons: "emoji" }]) {
      const t = resolveTheme({ preset: p, custom: empty });
      assert.equal(t.custom, null, p);
      assert.equal(themeCss(t, {}), themeCss(plain, {}), p);
      assert.deepEqual(themeAttrs(t), { "data-preset": p, "data-layout": plain.layout });
    }
  }
  // Clean with no colours still writes no palette.
  assert.ok(!themeCss(resolveTheme({ preset: "clean", custom: { buttons: "pill" } }), {}).includes("--bg"));
});

test("custom: validation (engine and docs:check)", () => {
  assert.deepEqual(validateCustom(undefined), []);
  assert.deepEqual(validateCustom({ light: { bg: "#fff", accent: null }, buttons: "pill", baseSize: 16.5, headingWeight: 700, sectionTabs: false }), []);
  const errs = validateCustom({ light: { bg: "white", glow: "#fff" }, buttons: "blob", baseSize: 30, headingWeight: 650, lineHeight: 1.33, contentWidth: 2000, sidebarIcons: "yes", sparkle: 1 });
  for (const re of [/light.bg "white" must be a hex/, /light.glow is not a colour setting/, /buttons "blob" must be one of square, rounded, pill/, /baseSize must be a number from 14 to 20/, /headingWeight/, /lineHeight/, /contentWidth/, /sidebarIcons must be true or false/, /sparkle is not a setting/]) {
    assert.ok(errs.some((e) => re.test(e)), `${re} in ${errs.join(" | ")}`);
  }
  assert.match(validateCustom("dark")[0], /must be an object/);
  const msgs = validateTheme({ custom: { icons: "emoji", extra: 1 } }).map((p) => `${p.level}: ${p.msg}`);
  assert.ok(msgs.includes('error: theme.custom.icons "emoji" must be one of regular, light, bold, duotone'), msgs.join("\n"));
  assert.ok(msgs.includes("warn: theme.custom.extra is not a setting"));
  // normalizeCustom keeps only what is valid, colours as lower-case 6-digit hex.
  assert.deepEqual(normalizeCustom({ light: { bg: "#FFF", text: "nope" }, cards: "raised", baseSize: 15.25, icons: "duotone" }), { light: { bg: "#ffffff" }, cards: "raised", icons: "duotone" });
  for (const [k, v] of Object.entries(CUSTOM_OPTIONS)) assert.equal(new Set(v).size, v.length, k);
  assert.equal(CUSTOM_COLORS.length, 15);
  // A code font may head a page (Terminal does), never be the body.
  const mono = resolveTheme({ preset: "clean", fonts: { heading: "fira-code", body: "fira-code" } });
  assert.equal(mono.fonts.heading, "fira-code");
  assert.equal(mono.fonts.body, "manrope");
  assert.deepEqual(validateTheme({ fonts: { heading: "jetbrains-mono" } }), []);
  for (const id of ["space-grotesk", "plus-jakarta-sans", "figtree", "fraunces", "crimson-pro", "fira-code", "source-code-pro"]) assert.ok(FONTS[id], id);
});

test("custom: colours per mode override the preset (and Match my brand), typography and shape", () => {
  const t = resolveTheme(
    { preset: "editorial", custom: { light: { bg: "#fbfaf7", accent: "#0f766e", sidebar: "#f1efe8", note: "#2563eb" }, dark: { accent: "#5eead4" }, radius: "none", headingWeight: 500, baseSize: 17, lineHeight: 1.7, contentWidth: 720, sectionTabs: true } },
    { colors: ["#e11d48"] },
  );
  assert.equal(t.palette.light.bg, "#fbfaf7");
  assert.equal(t.palette.accent, "#0f766e");
  assert.equal(t.palette.accentDark, "#5eead4");
  assert.equal(t.palette.custom, true);
  assert.deepEqual(t.radius, CUSTOM_RADIUS.none);
  assert.equal(t.headingWeight, 500);
  assert.equal(t.sectionTabs, true);
  const css = themeCss(t, {});
  assert.ok(css.includes("--dx-measure:720px"));
  assert.ok(css.includes("--radius-lg:0px"));
  assert.ok(css.includes("--dx-sidebar-bg:#f1efe8"));
  assert.ok(css.includes("--dx-note-soft:"));
  assert.ok(css.includes(".dx-root.dx-root[data-custom] .dx-prose.md-prose--reading{font-size:17px;line-height:1.7}"));
  assert.ok(css.includes("font-weight:500"));
  assert.ok(css.includes("minmax(0,720px)"));
  assert.equal(paletteTokens(t.palette, "light")["--bg"], "#fbfaf7");
  // Clean with a custom colour: Markdrop's own neutrals underneath.
  const clean = resolveTheme({ preset: "clean", custom: { light: { accent: "#7c3aed" } } });
  assert.equal(clean.palette.light.bg, "#e3e7ed");
  assert.equal(clean.palette.accent, "#7c3aed");
  // The custom radius beats theme.corners.
  assert.deepEqual(resolveTheme({ preset: "clean", corners: "round", custom: { radius: "small" } }).radius, CORNERS.sharp);
});

test("custom: the root's attributes, and themes.css styles each of them", () => {
  const t = resolveTheme({ preset: "clean", custom: { buttons: "pill", cards: "flat", headerAlign: "center", headerStyle: "transparent", tabStyle: "underline", sidebarStyle: "lines", sidebarIcons: false, callouts: "bar", codeTheme: "dark", links: "plain", icons: "duotone", light: { sidebar: "#f4f4f5" } } });
  assert.deepEqual(themeAttrs(t), {
    "data-preset": "clean", "data-layout": "sidebar", "data-custom": "", "data-buttons": "pill", "data-cards": "flat", "data-header-align": "center", "data-header-style": "transparent",
    "data-tab-style": "underline", "data-sidebar": "lines", "data-callouts": "bar", "data-code": "dark", "data-links": "plain", "data-icons": "duotone", "data-sidebar-icons": "off", "data-sidebar-bg": "",
  });
  assert.deepEqual(themeAttrs(null), {});
  const css = readFileSync(new URL("./themes.css", import.meta.url), "utf8");
  const ATTR = { buttons: "buttons", cards: "cards", headerAlign: "header-align", headerStyle: "header-style", tabStyle: "tab-style", sidebarStyle: "sidebar", callouts: "callouts", links: "links", icons: "icons" };
  // Values that are the design system's own look need no rule.
  const plain = { headerAlign: "left", headerStyle: "solid", callouts: "tinted", links: "underline", icons: "regular" };
  for (const [k, attr] of Object.entries(ATTR)) {
    for (const v of CUSTOM_OPTIONS[k]) if (plain[k] !== v) assert.ok(css.includes(`[data-${attr}="${v}"]`), `themes.css styles data-${attr}="${v}"`);
  }
  assert.ok(css.includes('[data-sidebar-icons="off"]'));
  assert.ok(css.includes("[data-sidebar-bg]"));
});

test("custom: code blocks follow the code theme, text readable on the block", () => {
  const dark = resolveTheme({ preset: "clean", custom: { codeTheme: "dark", light: { accent: "#2563eb" } } });
  const tok = codeTokens(dark.palette, "light", "dark");
  assert.equal(tok["color-scheme"], "dark");
  assert.equal(tok["--code-bg"], "#0d1117");
  assert.ok(contrast(parseHex(tok["--text"]), parseHex(tok["--code-bg"])) >= 4.5);
  assert.equal(tok["--syntax-keyword"], "#ff7b72");
  assert.equal(codeTokens(dark.palette, "dark", "light")["color-scheme"], "light");
  // The owner's code colours: kept, text clamped to stay readable.
  const own = resolveTheme({ preset: "minimal", custom: { light: { codeBg: "#1e293b", codeText: "#334155" } } });
  const o = codeTokens(own.palette, "light", undefined);
  assert.equal(o["--code-bg"], "#1e293b");
  assert.ok(contrast(parseHex(o["--text"]), parseHex("#1e293b")) >= 4.5);
  // No code theme and no code colours: the preset's code, no extra rule.
  assert.equal(codeTokens(resolveTheme({ preset: "minimal", custom: { light: { bg: "#ffffff" } } }).palette, "light", undefined), null);
  assert.ok(themeCss(dark, {}).includes(".dx-root.dx-root .md-codeblock{color-scheme:dark"));
});

test("custom: never publishes illegible text, whatever colours the owner picks", () => {
  const awful = [
    { bg: "#ffffff", surface: "#ffffff", text: "#eeeeee", muted: "#f5f5f5", accent: "#fef08a", note: "#fde68a", tip: "#bbf7d0", warning: "#fef3c7", danger: "#fecaca", selection: "#111111", sidebar: "#fafafa", header: "#ffffff" },
    { bg: "#0b0b0c", surface: "#111111", text: "#1f1f1f", muted: "#222222", accent: "#1e1b4b", note: "#1e3a8a", tip: "#14532d", warning: "#451a03", danger: "#450a0a", selection: "#fafafa" },
    // A dark ground in the light theme: text moves toward white, not black.
    { bg: "#101828", surface: "#1d2939", text: "#344054", muted: "#475467", accent: "#344054" },
  ];
  for (const colours of awful) {
    for (const mode of ["light", "dark"]) {
      const t = resolveTheme({ preset: "clean", custom: { [mode]: colours } });
      const tok = paletteTokens(t.palette, mode);
      const g = ["--bg", "--surface", "--surface-raised", "--surface-inset", "--dx-header-bg"].map((k) => parseHex(tok[k]));
      if (tok["--dx-sidebar-bg"]) g.push(parseHex(tok["--dx-sidebar-bg"]));
      for (const k of ["--text", "--text-muted", "--text-secondary", "--accent-text"]) {
        for (const ground of g) assert.ok(contrast(parseHex(tok[k]), ground) >= 4.5, `${mode} ${k} ${tok[k]} on ${ground} (${JSON.stringify(colours)})`);
      }
      assert.ok(contrast(parseHex(tok["--on-accent"]), parseHex(tok["--accent"])) >= 4.5);
      for (const kind of ["note", "tip", "warning", "danger"]) {
        if (tok[`--dx-${kind}`]) assert.ok(contrast(parseHex(tok[`--dx-${kind}`]), parseHex(tok[`--dx-${kind}-soft`])) >= 4.5, `${mode} ${kind}`);
      }
      if (tok["--dx-selection"]) assert.ok(contrast(parseHex(tok["--text"]), parseHex(tok["--dx-selection"])) >= 4.5);
    }
  }
});

test("custom: the builder's contrast guard flags failing pairs and offers a passing fix (without changing the colour)", () => {
  const theme = { preset: "clean", custom: { light: { bg: "#ffffff", text: "#9ca3af", accent: "#facc15", tip: "#86efac", selection: "#e5e7eb", codeBg: "#f8fafc", codeText: "#cbd5e1" } } };
  const rows = contrastGuard(theme);
  const get = (mode, label) => rows.find((r) => r.mode === mode && r.label === label);
  for (const label of ["Body text", "Links", "Tip callout", "Selected text", "Code"]) {
    const r = get("light", label);
    assert.ok(r, label);
    assert.equal(r.ok, false, label);
    assert.ok(r.ratio < 4.5);
    assert.match(r.fix, /^#[0-9a-f]{6}$/);
  }
  const text = get("light", "Body text");
  assert.equal(text.fg, "#9ca3af"); // reported as picked
  assert.ok(contrast(parseHex(text.fix), parseHex("#ffffff")) >= 4.5);
  // Applying a fix makes the pair pass.
  const tip = get("light", "Tip callout");
  const fixed = contrastGuard({ preset: "clean", custom: { light: { ...theme.custom.light, tip: tip.fix } } }).find((r) => r.mode === "light" && r.label === "Tip callout");
  assert.equal(fixed.ok, true);
  // The guard never touches the theme.
  assert.equal(theme.custom.light.text, "#9ca3af");
  // The untouched dark theme passes, and so does every preset as designed (links are derived from the accent).
  assert.ok(rows.filter((r) => r.mode === "dark").every((r) => r.ok || r.label === "Links"));
  for (const p of Object.keys(PRESETS)) for (const r of contrastGuard({ preset: p })) assert.ok(r.ok || r.label === "Links", `${p} ${r.mode} ${r.label} ${r.ratio}`);
});
