// Generates the CSS from tokens/tokens.json. Run: npm run build:tokens
//   tokens/tokens.css          custom properties for both themes + @font-face pointing at /fonts/ (what the app imports)
//   tokens/type-classes.css    .h1 / .body / .caption … classes for non-Tailwind pages and the previews
//   tokens/tailwind-theme.css  @theme block so Tailwind v4 gets bg-surface, text-text-muted, text-h1 …
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const t = JSON.parse(fs.readFileSync(path.join(root, "tokens/tokens.json"), "utf8"));
const esc = (n) => n.replace(/\./g, "\\.");
const themes = t.color.themes.map((x) => x.id);
const first = themes[0];
const paletteNames = new Set(t.color.tokens.map((x) => x.name));
const isPalette = (n) => /^[a-z]+-\d{2,3}$/.test(n);

const valueFor = (tok, theme) => {
  const v = typeof tok.value === "string" ? tok.value : tok.value[theme] ?? tok.value[first];
  if (typeof v === "string" && v.startsWith("{")) {
    const ref = v.slice(1, -1);
    if (!paletteNames.has(ref)) throw new Error(`${tok.name}: alias to missing token ${ref}`);
    return `var(--${esc(ref)})`;
  }
  return v;
};
const decls = (list, theme) => list.map((x) => `  --${esc(x.name)}: ${valueFor(x, theme)};`).join("\n");
const themed = [...t.color.tokens, ...(t.shadow?.tokens ?? [])];
const flat = [...(t.spacing?.tokens ?? []), ...(t.radius?.tokens ?? []), ...(t.zIndex?.tokens ?? [])];
const header = (what) => `/* ${t.name} — ${what}. Generated from tokens.json by scripts/build-tokens.mjs; do not edit by hand. */`;

let css = header("design tokens") + "\n\n";
for (const f of t.type.fonts ?? []) {
  css += `@font-face {\n  font-family: "${f.family}";\n  src: url("/${f.file}") format("woff2");\n  font-weight: ${f.weight};\n  font-style: ${f.style ?? "normal"};\n  font-display: swap;\n}\n`;
}
css += `\n:root, [data-theme="${first}"] {\n  color-scheme: ${first};\n${decls(themed, first)}\n}\n`;
for (const th of themes.slice(1)) css += `\n[data-theme="${th}"] {\n  color-scheme: ${th};\n${decls(themed, th)}\n}\n`;
// No-JS readers follow the OS once light launches (REVAMP_PLAN 5.3). Off by default: until then a
// JS-disabled visitor must get dark, like everyone else. Build with --no-js-light (or NO_JS_LIGHT=1) at launch.
// With JS, the head script always sets data-theme before paint, so this block never applies.
const noJsLight = process.argv.includes("--no-js-light") || process.env.NO_JS_LIGHT === "1";
if (noJsLight && themes.includes("light")) css += `\n@media (prefers-color-scheme: light) {\n  :root:not([data-theme]) {\n    color-scheme: light;\n${decls(themed, "light").replace(/^/gm, "  ")}\n  }\n}\n`;
const motion = t.motion?.tokens ?? [];
const layout = t.layout?.tokens ?? [];
css += `\n:root {\n${decls([...flat, ...motion, ...layout], first)}\n  --motion-scale: 1;\n${Object.entries(t.type.families).map(([k, v]) => `  --font-${k}: ${v};`).join("\n")}\n}\n`;
css += `\n@media (prefers-reduced-motion: reduce) {\n  :root { --motion-scale: 0; }\n}\n`;
fs.writeFileSync(path.join(root, "tokens/tokens.css"), css);

let typeCss = header("type styles") + "\n\n";
for (const g of t.type.groups) for (const s of g.styles) {
  typeCss += `.${s.name} { font-family: var(--font-${s.family ?? g.family}); font-size: ${s.fontSize}; line-height: ${s.lineHeight}; font-weight: ${s.fontWeight};${s.letterSpacing ? ` letter-spacing: ${s.letterSpacing};` : ""}${s.name === "eyebrow" ? " text-transform: uppercase;" : ""} }\n`;
}
fs.writeFileSync(path.join(root, "tokens/type-classes.css"), typeCss);

// Tailwind v4: semantic colours only (never the raw scales), and type styles as text-* sizes.
const semantic = t.color.tokens.filter((x) => !isPalette(x.name));
const colorNames = new Set(semantic.map((x) => x.name));
let tw = header("Tailwind v4 theme") + "\n/* Import after tokens.css and `@import \"tailwindcss\"`. Utilities: bg-surface, text-text-muted, border-border-strong, text-h1, text-body … */\n\n@theme inline {\n";
tw += semantic.map((x) => `  --color-${x.name}: var(--${x.name});`).join("\n") + "\n\n";
for (const g of t.type.groups) for (const s of g.styles) {
  if (colorNames.has(s.name) || String(s.fontSize).endsWith("em")) continue; // e.g. code-inline is em-relative and shares a colour's name
  tw += `  --text-${s.name}: ${s.fontSize};\n  --text-${s.name}--line-height: ${s.lineHeight};\n  --text-${s.name}--font-weight: ${s.fontWeight};\n`;
  if (s.letterSpacing) tw += `  --text-${s.name}--letter-spacing: ${s.letterSpacing};\n`;
}
// Layout widths as max-w-* utilities (max-w-app, max-w-tool, max-w-reading …).
for (const l of layout) tw += `  --container-${l.name.replace(/^layout-/, "")}: var(--${l.name});\n`;
// Motion as Tailwind keys, so pages stop hand-rolling keyframes (REVAMP_PLAN 6.2).
tw += `  --ease-brand: var(--ease-out);\n`;
tw += `  --animate-rise: md-rise var(--duration-reveal) var(--ease-out) both;\n`;
tw += `  --animate-pop: md-pop var(--duration-menu) var(--ease-out) both;\n`;
tw += `  --animate-sweep: md-sweep var(--loop-sweep) cubic-bezier(.4,0,.2,1) infinite;\n`;
tw += `\n  @keyframes md-rise { from { opacity: 0; transform: translateY(12px) scale(.98); } }\n`;
tw += `  @keyframes md-pop { from { opacity: 0; transform: translateY(8px) scale(.98); } }\n`;
tw += `  @keyframes md-sweep { from { transform: translateX(-110%); } to { transform: translateX(310%); } }\n`;
tw += "}\n";
fs.writeFileSync(path.join(root, "tokens/tailwind-theme.css"), tw);

console.log(`tokens.css: ${themed.length} themed × ${themes.length} themes, ${flat.length} flat · type-classes.css · tailwind-theme.css: ${semantic.length} colours`);
