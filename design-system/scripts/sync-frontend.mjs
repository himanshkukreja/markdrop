// Vendors the design system into the Next.js app (REVAMP_PLAN 10.1, 10.5).
//   node scripts/sync-frontend.mjs           copy tokens → frontend/src/styles/ds/, fonts → frontend/src/app/fonts/
//   node scripts/sync-frontend.mjs --check   exit 1 if the frontend copies differ (run before a frontend build)
//   Components are not synced: frontend/src/components/ui is the canonical copy (README step 4), and
//   scripts/build-bundle.mjs builds the preview bundle from it.
// The app deploys from frontend/ as its root, so it can't import ../design-system at build time; and a commit
// that touches only design-system/ would not trigger a frontend deploy. Hence copies, plus a drift check.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const app = path.resolve(root, "../frontend");
const check = process.argv.includes("--check");

const banner = "/* Vendored from design-system/ by scripts/sync-frontend.mjs — edit design-system/tokens/tokens.json, never this file. */\n";
// The app loads Manrope and JetBrains Mono through next/font/local (preload, size-adjusted fallbacks,
// hashed URLs) and points --font-sans/--font-mono at them, so the token @font-face rules are dropped.
const stripFontFace = (css) => css.replace(/@font-face\s*\{[^}]*\}\s*/g, "");

const files = [
  ["tokens/tokens.css", "src/styles/ds/tokens.css", (s) => banner + stripFontFace(s)],
  ["tokens/tailwind-theme.css", "src/styles/ds/tailwind-theme.css", (s) => banner + s],
  ["tokens/type-classes.css", "src/styles/ds/type-classes.css", (s) => banner + s],
  ["fonts/Manrope-Variable.woff2", "src/app/fonts/Manrope-Variable.woff2", null],
  ["fonts/JetBrainsMono-Variable.woff2", "src/app/fonts/JetBrainsMono-Variable.woff2", null],
  ["fonts/OFL-Manrope.txt", "src/app/fonts/OFL-Manrope.txt", null],
  ["fonts/OFL-JetBrainsMono.txt", "src/app/fonts/OFL-JetBrainsMono.txt", null],
];

let drift = 0;
for (const [from, to, transform] of files) {
  const src = path.join(root, from), dst = path.join(app, to);
  const want = transform ? Buffer.from(transform(fs.readFileSync(src, "utf8"))) : fs.readFileSync(src);
  const have = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
  if (have && Buffer.compare(have, want) === 0) continue;
  if (check) { drift++; console.log(`drift: frontend/${to} differs from design-system/${from}`); continue; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, want);
  console.log(`wrote frontend/${to}`);
}
if (check) { console.log(drift ? `${drift} vendored file(s) out of date: run node design-system/scripts/sync-frontend.mjs` : "design-system copies are in sync"); process.exit(drift ? 1 : 0); }
