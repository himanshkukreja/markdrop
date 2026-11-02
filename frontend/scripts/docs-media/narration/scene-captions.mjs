#!/usr/bin/env node
/**
 * The on-screen captions of the animated scenes that are docs videos, as rendered: each scene
 * (content/docs/video-scenes/<id>) is loaded with ?render=1 and stepped at 30 fps, reading the
 * caption element (#cap). Writes scene-captions.json next to this file, for narrate.py.
 *
 *   node scripts/docs-media/narration/scene-captions.mjs [ids…]
 *
 * who-can-open has no caption pill (its header steps are the captions): its cues are in lines.json.
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, "../../..");
const OUT = path.join(HERE, "scene-captions.json");
const DEFAULT = ["cli-send-receive", "cli-upload-replace", "connect-claude", "local-mcp-publish", "vscode-conflict", "vscode-sync"];
const ids = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".mp4": "video/mp4", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" };
const ALLOWED = [path.join(FRONTEND, "content/docs/video-scenes"), path.join(FRONTEND, "src/app/fonts")];

const srv = http.createServer((req, res) => {
  const f = path.join(FRONTEND, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!ALLOWED.some((a) => f.startsWith(a + path.sep)) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch();
const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
try {
  for (const id of ids) {
    const page = await browser.newPage();
    await page.goto(`${base}/content/docs/video-scenes/${id}/index.html?render=1`, { waitUntil: "load" });
    await page.waitForFunction(() => window.__ready, null, { timeout: 30000 });
    await page.evaluate(() => window.__ready);
    const meta = await page.evaluate(() => window.__scene);
    const n = Math.round(meta.duration * 30);
    const cues = [];
    let cur = null;
    for (let i = 0; i < n; i++) {
      const t = i / 30;
      const s = await page.evaluate((tt) => {
        window.__setTime(tt);
        const c = document.getElementById("cap");
        return c && Number(c.style.opacity) > 0.01 ? c.textContent : "";
      }, t);
      if (s !== (cur?.text ?? "")) {
        if (cur) cues.push({ ...cur, t1: t });
        cur = s ? { t0: t, text: s } : null;
      }
    }
    if (cur) cues.push({ ...cur, t1: n / 30 });
    out[id] = { duration: meta.duration, cues };
    console.log(`${id}: ${cues.length} captions`);
    await page.close();
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
} finally {
  await browser.close();
  srv.close();
}
