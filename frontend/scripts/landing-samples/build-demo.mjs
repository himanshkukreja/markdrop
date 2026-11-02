#!/usr/bin/env node
/**
 * The landing page's live renders (frontend/public/landing-demo/): Markdrop's REAL file viewers,
 * on the real sample files of this folder, as static pages the landing frames in a sandbox.
 *
 *   node frontend/scripts/landing-samples/build-demo.mjs
 *
 * The PDF, spreadsheet and video viewers are not copies: each page is what the artifact Worker
 * (worker/src/index.js) answers for `/v/<renderer>/<key>?theme=…`, fetched from the Worker module
 * itself with an in-memory bucket (as worker/test does), with only the file's address swapped from
 * the Worker's `/r/<key>` to the copy under /landing-demo/files/. The HTML page is the launch
 * dashboard file itself. next.config.ts serves /landing-demo/ with the same sandbox the guides demo has, and
 * the landing frames every page with sandbox="allow-scripts" (no allow-same-origin), like Markdrop's
 * embeds: an opaque origin with no cookies, storage or access to markdrop.in.
 *
 * Re-run after changing a sample file or the Worker's viewers.
 */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, "../..");
const OUT = path.join(FRONTEND, "public/landing-demo");
const FILES = path.join(OUT, "files");
mkdirSync(FILES, { recursive: true });

const { default: worker } = await import(pathToFileURL(path.resolve(FRONTEND, "../worker/src/index.js")).href);
const ORIGIN = "https://markdrop-artifacts.markdrop-in.workers.dev";
const env = { ARTIFACT_SIGNING_KEY: "landing", ARTIFACTS: { head: async () => null, get: async () => null } };

const SAMPLES = [
  { renderer: "pdf", file: "acme-deck.pdf" },
  { renderer: "sheet", file: "budget-2026.xlsx" },
  { renderer: "video", file: "product-demo.mp4", poster: "product-demo.jpg", themes: [null] }, // one page: the player is always dark
];

for (const s of SAMPLES) {
  copyFileSync(path.join(HERE, s.file), path.join(FILES, s.file));
  if (s.poster) copyFileSync(path.join(HERE, s.poster), path.join(FILES, s.poster));
  const key = `art/landing/${s.file}`;
  for (const theme of s.themes ?? ["light", "dark"]) {
    const q = new URLSearchParams(theme ? { theme } : {});
    const r = await worker.fetch(new Request(`${ORIGIN}/v/${s.renderer}/${key}?${q}`), env);
    if (r.status !== 200) throw new Error(`${s.renderer}: the Worker answered ${r.status}`);
    let html = await r.text();
    const from = `/r/${key}`;
    if (!html.includes(from)) throw new Error(`${s.renderer}: no ${from} in the viewer page`);
    html = html.split(from).join(`/landing-demo/files/${s.file}`);
    // The video viewer takes a poster only from the Worker's own key pattern: add the sample's.
    if (s.poster) html = html.replace('<video id="v" playsinline preload="metadata"', `<video id="v" playsinline preload="metadata" poster="/landing-demo/files/${s.poster}"`);
    const name = theme ? `${s.renderer}.${theme}.html` : `${s.renderer}.html`;
    writeFileSync(path.join(OUT, name), html);
    console.log("wrote", path.relative(FRONTEND, path.join(OUT, name)));
  }
}

// The HTML sample: the launch dashboard (the hero laptop's screen and the "what renders" card).
copyFileSync(path.join(HERE, "launch-dashboard.html"), path.join(OUT, "launch-dashboard.html"));
console.log("wrote public/landing-demo/launch-dashboard.html");
// The Markdown sample: the landing fetches it and renders it with MarkdownPreview (no frame).
copyFileSync(path.join(HERE, "launch-notes.md"), path.join(FILES, "launch-notes.md"));
console.log("wrote public/landing-demo/files/launch-notes.md");
