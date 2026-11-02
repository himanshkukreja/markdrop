/**
 * The studio's previews draw a guide in its SAVED design with the engine's own rules (guideTheme.ts):
 * the editor's Preview after Design › Save shows the new design, never the live build's.
 * Runs on node's TypeScript type stripping (node ≥ 22.18); skipped without it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CORNERS, CUSTOM_RADIUS, codeTokens, paletteTokens, resolveTheme, themeAttrs, themeCss } from "../../docs/theme.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let mod = null;
if (process.features?.typescript) {
  const src = pathToFileURL(path.resolve(HERE, "../..") + "/").href;
  // `@/x` → src/x(.ts unless it names its extension), and `./x` from a .ts file → ./x.ts; .ts files
  // load as ES modules.
  const hook = `export async function resolve(s, c, next) {
    const ext = /\\.(m?js|ts|json|css)$/.test(s);
    const spec = s.startsWith("@/") ? ${JSON.stringify(src)} + s.slice(2) + (ext ? "" : ".ts")
      : s.startsWith(".") && !ext && c.parentURL?.endsWith(".ts") ? s + ".ts" : s;
    const r = await next(spec, c);
    return r.url.endsWith(".ts") ? { ...r, format: "module-typescript" } : r;
  }`;
  register("data:text/javascript," + encodeURIComponent(hook));
  mod = await import("./guideTheme.ts");
}
const skip = mod ? false : "needs node with TypeScript type stripping";

const theme = (over = {}) => ({ preset: "clean", brand: { enabled: false, colors: [] }, fonts: {}, mode: "both", corners: null, ...over });

test("the settings become the site.json the snapshot writer makes (backend docs_snapshot _theme/_brand)", { skip }, () => {
  assert.deepEqual(mod.engineInput(theme()), { theme: { preset: "clean", mode: "both" } });
  assert.deepEqual(
    mod.engineInput(theme({ preset: "paper", fonts: { heading: "lora", body: null }, corners: "sharp", brand: { enabled: true, colors: ["#d9480f", "#111111"], accent: null, accent_dark: "#ffa94d" } })),
    { theme: { preset: "paper", fonts: { heading: "lora" }, mode: "both", corners: "sharp" }, brand: { accent: "#d9480f", accentDark: "#ffa94d", colors: ["#d9480f", "#111111"] } },
  );
  // Match my brand off: no brand colours reach the theme.
  assert.equal(mod.engineInput(theme({ brand: { enabled: false, colors: ["#d9480f"], accent: "#d9480f" } })).brand, undefined);
});

test("a saved design's tokens are the engine's: palette, brand accent, fonts, corners", { skip }, () => {
  const saved = theme({ preset: "paper", brand: { enabled: true, colors: ["#d9480f"], accent: "#d9480f" }, corners: "round", fonts: { heading: "newsreader", body: "inter" } });
  const v = mod.guideThemeVars(saved, false);
  const engine = paletteTokens(resolveTheme({ preset: "paper", corners: "round", fonts: { heading: "newsreader", body: "inter" }, mode: "both" }, { accent: "#d9480f", colors: ["#d9480f"] }).palette, "light");
  for (const k of ["--bg", "--text", "--accent", "--accent-text", "--border", "--surface"]) assert.equal(v[k], engine[k], k);
  assert.match(v["--font-sans"], /^"Inter"/);
  assert.match(v["--dx-font-heading"], /^"Newsreader"/);
  assert.equal(v["--radius-lg"], `${CORNERS.round.lg}px`);
  // Dark is the engine's dark palette.
  assert.notEqual(mod.guideThemeVars(saved, true)["--bg"], v["--bg"]);
});

test("changing and saving the design changes what the preview draws", { skip }, () => {
  const before = mod.guideThemeVars(theme({ preset: "editorial" }), false);
  const after = mod.guideThemeVars(theme({ preset: "midnight" }), false);
  assert.notEqual(before["--bg"], after["--bg"]);
  assert.notEqual(before["--dx-font-heading"], after["--dx-font-heading"]);
  // Clean has no palette of its own: Markdrop's tokens, with the brand accent swapped in.
  const clean = mod.guideThemeVars(theme({ brand: { enabled: true, colors: [], accent: "#0f766e" } }), false);
  assert.equal(clean["--bg"], undefined);
  assert.equal(clean["--accent"], "#0f766e");
  assert.equal(mod.guideThemeVars(theme(), false)["--accent"], undefined);
});

test("the preview opens in the guide's own default mode", { skip }, () => {
  assert.equal(mod.opensDark(theme()), false);
  assert.equal(mod.opensDark(theme({ preset: "midnight" })), true);
  assert.equal(mod.opensDark(theme({ preset: "terminal", mode: "light" })), false);
  assert.equal(mod.opensDark(theme({ mode: "dark" })), true);
});

test("a custom theme from the theme builder reaches the preview (snake_case settings → the engine's keys)", { skip }, () => {
  const saved = theme({ preset: "clean", custom: { light: { bg: "#fbfaf7", accent: "#0f766e", code_bg: null }, dark: {} } });
  assert.deepEqual(mod.engineInput(saved).theme.custom, { light: { bg: "#fbfaf7", accent: "#0f766e" } });
  const v = mod.guideThemeVars(saved, false);
  assert.equal(v["--bg"], "#fbfaf7");
  assert.notEqual(v["--accent"], mod.guideThemeVars(theme(), false)["--accent"]);
  // Nothing set: no custom block at all, like the snapshot writer.
  assert.equal(mod.engineInput(theme({ custom: { light: {}, dark: { bg: null } } })).theme.custom, undefined);
});

// A custom theme with layout options as the API stores it (snake_case), and the same as site.json.
const LAYOUT = {
  light: { bg: "#fbfaf7", accent: "#0f766e", code_bg: "#101418", code_text: "#e6edf3" },
  cards: "flat", callouts: "bar", links: "plain", icons: "duotone", buttons: "pill", sidebar_style: "lines", tab_style: "underline",
  sidebar_icons: false, base_size: 17, line_height: 1.8, heading_weight: 800, content_width: 900, radius: "xlarge", code_theme: "dark",
};
const LAYOUT_ENGINE = {
  light: { bg: "#fbfaf7", accent: "#0f766e", codeBg: "#101418", codeText: "#e6edf3" },
  cards: "flat", callouts: "bar", links: "plain", icons: "duotone", buttons: "pill", sidebarStyle: "lines", tabStyle: "underline",
  sidebarIcons: false, baseSize: 17, lineHeight: 1.8, headingWeight: 800, contentWidth: 900, radius: "xlarge", codeTheme: "dark",
};

test("the Preview's root gets the published layout's attributes for a custom theme (themeAttrs)", { skip }, () => {
  const saved = theme({ preset: "paper", custom: LAYOUT });
  const look = mod.guideLook(saved, false, '[data-dx-preview="p1"]');
  // Exactly the attributes the published layout spreads on .dx-root (src/app/docs-site/layout.tsx).
  assert.deepEqual(look.attrs, themeAttrs(resolveTheme({ preset: "paper", mode: "both", custom: LAYOUT_ENGINE })));
  assert.equal(look.attrs["data-custom"], "");
  assert.equal(look.attrs["data-preset"], "paper");
  assert.equal(look.attrs["data-cards"], "flat");
  assert.equal(look.attrs["data-callouts"], "bar");
  assert.equal(look.attrs["data-links"], "plain");
  assert.equal(look.attrs["data-icons"], "duotone");
  assert.equal(look.attrs["data-buttons"], "pill");
  assert.equal(look.attrs["data-sidebar"], "lines");
  assert.equal(look.attrs["data-tab-style"], "underline");
  assert.equal(look.attrs["data-sidebar-icons"], "off");
  // A preset as designed: no custom attribute at all, like a published guide without a custom theme.
  assert.equal("data-custom" in mod.guideLook(theme({ preset: "paper" }), false, "[data-dx-preview=x]").attrs, false);
});

test("the Preview gets the custom theme's type, width, radius and code block (the engine's rules, scoped to it)", { skip }, () => {
  const saved = theme({ preset: "paper", custom: LAYOUT });
  const look = mod.guideLook(saved, false, '[data-dx-preview="p1"]');
  const R = '.dx-root.dx-root[data-dx-preview="p1"]';
  assert.ok(look.css.includes(`${R}[data-custom] .dx-prose.md-prose--reading{font-size:17px;line-height:1.8}`), look.css);
  assert.ok(look.css.includes(`${R}[data-custom] :is(.dx-title,.dx-hero__title,.dx-home__h)`), look.css);
  assert.ok(look.css.includes("font-weight:800"));
  // The forced dark code theme: the block's own tokens, on this root's code blocks only.
  assert.ok(look.css.includes(`${R} .md-codeblock{color-scheme:dark;--code-bg:#101418`), look.css);
  // Nothing global: every rule names this root.
  for (const rule of look.css.split("\n").filter((l) => !l.startsWith("@media"))) assert.ok(rule.startsWith(R), rule);
  // Root properties: the custom radius scale, heading weight and content width.
  assert.equal(look.vars["--radius-lg"], `${CUSTOM_RADIUS.xlarge.lg}px`);
  assert.equal(look.vars["--dx-heading-weight"], "800");
  assert.equal(look.vars["--dx-measure"], "900px");
  // The published stylesheet makes the same rules for the whole page (themeCss): same declarations.
  const published = themeCss(resolveTheme({ preset: "paper", mode: "both", custom: LAYOUT_ENGINE }), {});
  assert.ok(published.includes(".dx-root.dx-root[data-custom] .dx-prose.md-prose--reading{font-size:17px;line-height:1.8}"));
  // A preset as designed: no scoped rules at all.
  assert.equal(mod.guideLook(theme({ preset: "paper" }), false, "[data-dx-preview=x]").css, "");
});

test("the Preview draws the guide's custom CSS, kept inside the preview", { skip }, () => {
  const look = mod.guideLook(theme({ custom_css: ".dx-title { letter-spacing: 0 }\nbody { color: red }" }), false, '[data-dx-preview="p1"]');
  assert.ok(look.css.includes('.dx-root[data-dx-preview="p1"] .dx-title'), look.css);
  assert.ok(!/(^|[\s,}])\.dx-title/.test(look.css.replace(/\.dx-root\[data-dx-preview="p1"\] \.dx-title/g, "")), look.css);
  // CSS the engine refuses is refused here too (nothing drawn).
  assert.equal(mod.guideLook(theme({ custom_css: "@import url(http://x.test/a.css);" }), false, "[data-dx-preview=x]").css, "");
});

test("a code face from the theme builder reaches the Preview, the app's own faces through its font variables", { skip }, () => {
  assert.match(mod.guideThemeVars(theme({ fonts: { mono: "fira-code" } }), false)["--font-mono"], /^"Fira Code"/);
  assert.match(mod.guideThemeVars(theme(), false)["--font-mono"], /^var\(--font-jetbrains\)/);
  assert.match(mod.guideThemeVars(theme(), false)["--font-sans"], /^var\(--font-manrope\)/);
});

// The Guides home's cards (presets.ts summaryTokens, from GET /docs-sites' summary_theme).
let presets = null;
if (mod) presets = await import("./presets.ts").catch((e) => (console.warn(`presets.ts not loadable here: ${e.message}`), null));
const skipCards = presets ? false : "needs node with TypeScript type stripping";
const summary = (over = {}) => ({ preset: "clean", theme: { preset: "clean", mode: "both", corners: null, brand: { enabled: false, colors: [] }, ...over } });

test("a guide's card draws its custom theme's colours, corners and type, not the preset's", { skip: skipCards }, () => {
  const plain = presets.summaryTokens(summary({ preset: "paper" }), false);
  const custom = presets.summaryTokens(summary({ preset: "paper", fonts: { heading: "fraunces" }, custom: LAYOUT }), false);
  const engine = paletteTokens(resolveTheme({ preset: "paper", mode: "both", custom: LAYOUT_ENGINE }).palette, "light");
  assert.equal(custom.bg, "#fbfaf7");
  assert.equal(custom.bg, engine["--bg"]);
  assert.equal(custom.accent, engine["--accent"]);
  assert.equal(custom.accentText, engine["--accent-text"]);
  assert.notEqual(custom.accent, plain.accent);
  assert.equal(custom.r, `${CUSTOM_RADIUS.xlarge.lg}px`);
  assert.equal(custom.headW, 800);
  assert.match(custom.head, /Fraunces/);
  // Dark: the custom theme sets no dark colours, so the preset's dark ground with the custom accent.
  assert.equal(presets.summaryTokens(summary({ preset: "paper", custom: LAYOUT }), true).bg, paletteTokens(resolveTheme({ preset: "paper", custom: LAYOUT_ENGINE }).palette, "dark")["--bg"]);
  // A custom sidebar colour fills the card's sidebar.
  assert.equal(presets.summaryTokens(summary({ custom: { light: { sidebar: "#eef2ff" } } }), false).sidebarBg, "#eef2ff");
  assert.equal(plain.sidebarBg, undefined);
  // A listing without the new keys (older API) still draws the preset.
  assert.deepEqual(presets.summaryTokens(summary({ preset: "paper" }), false), presets.summaryTokens({ preset: "paper", theme: { preset: "paper", mode: "both", brand: { enabled: false, colors: [] } } }, false));
});

test("Match my brand on a card uses every brand colour, like the published palette", { skip: skipCards }, () => {
  const card = presets.summaryTokens(summary({ preset: "paper", brand: { enabled: true, colors: ["#d9480f", "#111111"] } }), false);
  const engine = paletteTokens(resolveTheme({ preset: "paper", mode: "both" }, { colors: ["#d9480f", "#111111"] }).palette, "light");
  assert.equal(card.text, engine["--text"]);
  assert.equal(card.accent, engine["--accent"]);
});

test("the Design panel's drawing gets the theme builder's layout choices through the engine (guideLayout)", { skip }, () => {
  const L = mod.guideLayout(theme({ preset: "paper", custom: { ...LAYOUT, header_align: "center", header_style: "transparent" } }));
  assert.deepEqual(L, {
    layout: "sidebar", sectionTabs: false, headerAlign: "center", headerStyle: "transparent", tabStyle: "underline",
    sidebarStyle: "lines", sidebarIcons: false, buttons: "pill", cards: "flat", callouts: "bar", links: "plain", icons: "duotone",
    codeTheme: "dark", contentWidth: 900, baseSize: 17, lineHeight: 1.8,
  });
  // Exactly what the engine resolves from the same site.json (the Preview's path).
  const t = resolveTheme({ preset: "paper", mode: "both", custom: { ...LAYOUT_ENGINE, headerAlign: "center", headerStyle: "transparent" } });
  for (const k of ["sidebarStyle", "tabStyle", "buttons", "cards", "callouts", "links", "contentWidth", "baseSize", "lineHeight", "headerAlign", "headerStyle"]) assert.equal(L[k], t.custom[k], k);
  // A preset as designed: the preset's own look, nothing chosen.
  assert.deepEqual(mod.guideLayout(theme({ preset: "editorial" })), {
    layout: "top", sectionTabs: false, headerAlign: "left", headerStyle: "solid", tabStyle: null, sidebarStyle: null, sidebarIcons: true,
    buttons: null, cards: null, callouts: null, links: null, icons: null, codeTheme: null, contentWidth: null, baseSize: null, lineHeight: null,
  });
  // Section tabs: the preset's (Atlas has them) unless the builder turns them on or off.
  assert.equal(mod.guideLayout(theme({ preset: "atlas" })).sectionTabs, true);
  assert.equal(mod.guideLayout(theme({ preset: "atlas", custom: { section_tabs: false } })).sectionTabs, false);
  assert.equal(mod.guideLayout(theme({ preset: "clean", custom: { section_tabs: true } })).sectionTabs, true);
  // Values the engine refuses are the preset's here too (never drawn as something it won't publish).
  const bad = mod.guideLayout(theme({ custom: { sidebar_style: "zigzag", content_width: 5000, base_size: 15.3, header_align: "right" } }));
  assert.deepEqual([bad.sidebarStyle, bad.contentWidth, bad.baseSize, bad.headerAlign], [null, null, null, "left"]);
});

test("the drawing's code block follows a custom code theme (codeTokens), else the palette", { skip }, () => {
  const custom = { light: { bg: "#fbfaf7" }, code_theme: "dark" };
  const forced = mod.guideCode(theme({ preset: "paper", custom }), false);
  const engine = codeTokens(resolveTheme({ preset: "paper", custom: { light: { bg: "#fbfaf7" }, codeTheme: "dark" } }).palette, "light", "dark");
  assert.deepEqual(forced, { bg: engine["--code-bg"], text: engine["--text"] });
  assert.equal(forced.bg, "#0d1117");
  // The palette's code colours: a preset as designed, or (as the engine has it) a code theme on a
  // custom theme that sets no colour.
  assert.equal(mod.guideCode(theme({ preset: "paper" }), false), null);
  assert.equal(mod.guideCode(theme({ preset: "paper", custom: { code_theme: "dark" } }), false), null);
  if (presets) {
    const p = presets.previewTokens(theme({ preset: "paper", custom }), false);
    assert.equal(p.code, forced.bg);
    assert.equal(p.codeText, forced.text);
  }
});
