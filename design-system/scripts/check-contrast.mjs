// Token-pair contrast check (REVAMP_PLAN 11.1). Run: npm run check:contrast
// Resolves every semantic colour in both themes from tokens.json, composites translucent grounds
// over the ground they sit on, and fails when an allowed text/ground pair is under 4.5:1 (or a
// non-text pair under 3:1). Disallowed pairs are listed in BRAND.md and are not tested here.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const t = JSON.parse(fs.readFileSync(path.join(root, "tokens/tokens.json"), "utf8"));
const byName = new Map(t.color.tokens.map((x) => [x.name, x]));

function raw(name, theme) {
  const tok = byName.get(name);
  if (!tok) throw new Error(`unknown token ${name}`);
  const v = typeof tok.value === "string" ? tok.value : tok.value[theme] ?? tok.value.dark;
  return v.startsWith("{") ? raw(v.slice(1, -1), theme) : v;
}
function rgba(hex) {
  const h = hex.replace("#", "");
  const n = (i) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length >= 8 ? n(6) / 255 : 1];
}
const over = (fg, bg) => { const a = fg[3]; return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)).concat(1); };
const lum = ([r, g, b]) => [r, g, b].map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
  .reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

// A ground is either a token, or "token/parent" for a translucent tint composited over its parent.
function ground(spec, theme) {
  const [g, parent = "bg"] = spec.split("/");
  const c = rgba(raw(g, theme));
  return c[3] < 1 ? over(c, ground(parent, theme)) : c;
}

const TEXT = ["text", "text-secondary", "text-muted"];
const SOLID = ["bg", "surface", "surface-raised", "surface-inset", "surface-hover"];
const pairs = [];
for (const fg of TEXT) for (const bg of SOLID) pairs.push([fg, bg, 4.5]);
for (const fg of ["text", "text-secondary"]) for (const bg of ["accent-soft/surface", "success-soft/surface", "warning-soft/surface", "danger-soft/surface", "code-bg"]) pairs.push([fg, bg, 4.5]);
for (const fg of ["accent-text", "success", "warning", "danger"]) for (const bg of ["bg", "surface", "surface-raised"]) pairs.push([fg, bg, 4.5]);
pairs.push(["accent-text", "accent-soft/surface", 4.5], ["success", "success-soft/surface", 4.5], ["warning", "warning-soft/surface", 4.5], ["danger", "danger-soft/surface", 4.5]);
pairs.push(["on-accent", "accent", 4.5], ["on-warning", "warning-fill", 4.5], ["on-accent", "danger-fill", 4.5]);
pairs.push(["code-inline", "code-inline-bg", 4.5], ["text", "code-bg", 4.5]);
for (const s of ["keyword", "string", "comment", "number", "title", "attr", "builtin", "meta", "punct"]) pairs.push([`syntax-${s}`, "code-bg", 4.5]);
pairs.push(["syntax-addition", "syntax-addition-bg", 4.5], ["syntax-deletion", "syntax-deletion-bg", 4.5]);
// Non-text: category tints and FileIcon glyphs, chart marks, focus ring.
for (const c of ["cat-document", "cat-artifact", "cat-builder", "cat-share", "cat-sync", "cat-image", "cat-video", "cat-pdf", "cat-sheet", "cat-audio"]) for (const bg of ["surface", "surface-inset"]) pairs.push([c, bg, 3]);
for (let i = 1; i <= 6; i++) pairs.push([`chart-${i}`, "surface", 3]);
pairs.push(["border-focus", "bg", 3], ["border-focus", "surface", 3]);

let failed = 0;
for (const theme of t.color.themes.map((x) => x.id)) {
  for (const [fg, bg, min] of pairs) {
    const r = ratio(over(rgba(raw(fg, theme)), ground(bg, theme)), ground(bg, theme));
    if (r < min) { failed++; console.log(`FAIL ${theme.padEnd(5)} ${fg} on ${bg}: ${r.toFixed(2)} < ${min}`); }
    else if (process.argv.includes("--verbose")) console.log(`ok   ${theme.padEnd(5)} ${fg} on ${bg}: ${r.toFixed(2)}`);
  }
}
console.log(failed ? `${failed} contrast failure(s)` : `contrast: ${pairs.length} pairs × ${t.color.themes.length} themes pass`);
process.exit(failed ? 1 : 0);
