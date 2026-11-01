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
import { CORNERS, paletteTokens, resolveTheme } from "../../docs/theme.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let mod = null;
if (process.features?.typescript) {
  const src = pathToFileURL(path.resolve(HERE, "../..") + "/").href;
  // `@/x` → src/x(.ts unless it names its extension); .ts files load as ES modules.
  const hook = `export async function resolve(s, c, next) {
    const spec = s.startsWith("@/") ? ${JSON.stringify(src)} + s.slice(2) + (/\\.m?js$/.test(s) ? "" : ".ts") : s;
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
