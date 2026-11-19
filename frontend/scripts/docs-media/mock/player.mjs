#!/usr/bin/env node
/**
 * The video player screenshot (files/video-and-audio/video-player-controls), without the artifacts
 * Worker running: renders worker/src/index.js videoViewer() to HTML, serves it with a sample video
 * and captions from a tiny local server, frames it in a parent page that sends the workspace accent
 * and the chapters ({md:1, ev:"theme"|"chapters"}, as the app does), pauses mid-video and shoots.
 *
 *   node scripts/docs-media/make_fixtures.mjs        (once: .data/fixtures/product-demo-v1.mp4)
 *   node scripts/docs-media/mock/player.mjs [--video path.mp4]
 *
 * The demo video has its scene titles burned in at the bottom; they're cropped off so they don't
 * fight the player's own captions.
 */
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, "../../..");
const WORKER = path.resolve(FRONTEND, "../worker/src/index.js");
const OUT = path.join(FRONTEND, "public/docs-assets/files/video-and-audio/video-player-controls");
const FFMPEG = process.env.FFMPEG || "/opt/homebrew/bin/ffmpeg";
const CWEBP = process.env.CWEBP || "/opt/homebrew/bin/cwebp";
const arg = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : null; };
const SRC_VIDEO = arg("--video") || path.join(process.env.DOCS_MEDIA_DATA || path.join(HERE, "../.data"), "fixtures/product-demo-v1.mp4");
if (!existsSync(SRC_VIDEO)) throw new Error(`no ${SRC_VIDEO}: run make_fixtures.mjs first (or pass --video)`);

const ACCENT = "#0D9488"; // Acme's brand teal (the workspace accent)
const CHAPTERS = [
  { t: 0, title: "Welcome to Acme Cloud" }, { t: 3, title: "Connect your data" }, { t: 11, title: "Dashboards that update live" },
  { t: 15, title: "Share a dashboard" }, { t: 19, title: "Alerts" }, { t: 23, title: "On your phone" }, { t: 31, title: "What teams get" },
];
const VTT = `WEBVTT

00:00:00.500 --> 00:00:03.000
Welcome to Acme Cloud.

00:00:03.200 --> 00:00:07.000
First, connect your data: Postgres, Stripe and Sheets.

00:00:07.200 --> 00:00:10.800
Acme syncs every source every five minutes.

00:00:11.000 --> 00:00:15.000
Your revenue dashboard updates while you watch.

00:00:15.200 --> 00:00:19.000
Share it with the people who need it.

00:00:19.200 --> 00:00:23.000
Alerts go to Slack, email or PagerDuty.
`;

// videoViewer() isn't exported: import a copy of the Worker that exports it (next to it, for its imports).
const tmpMod = path.join(path.dirname(WORKER), `.player-shot-${process.pid}.mjs`);
writeFileSync(tmpMod, `${readFileSync(WORKER, "utf8")}\nexport { videoViewer as __videoViewer };\n`);
let videoViewer;
try { ({ __videoViewer: videoViewer } = await import(pathToFileURL(tmpMod).href)); } finally { rmSync(tmpMod, { force: true }); }

const tmp = mkdtempSync(path.join(os.tmpdir(), "md-player-"));
const video = path.join(tmp, "video.mp4");
execFileSync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-i", SRC_VIDEO, "-vf", "crop=1280:664:0:0", "-an", "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", video]);
const player = videoViewer("/video.mp4", null, "/captions.vtt", 0);
const parent = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#000}iframe{border:0;width:100%;height:100%;display:block}</style></head>
<body><iframe id="f" src="/player.html" allow="fullscreen; picture-in-picture"></iframe><script>
const f=document.getElementById('f');
f.addEventListener('load',()=>{f.contentWindow.postMessage({md:1,ev:'theme',accent:${JSON.stringify(ACCENT)}},'*');f.contentWindow.postMessage({md:1,ev:'chapters',list:${JSON.stringify(CHAPTERS)}},'*');});
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(parent); }
  if (u.pathname === "/player.html") { res.writeHead(200, { "content-type": "text/html" }); return res.end(player); }
  if (u.pathname === "/captions.vtt") { res.writeHead(200, { "content-type": "text/vtt" }); return res.end(VTT); }
  if (u.pathname === "/video.mp4") {
    const size = statSync(video).size;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
    const buf = readFileSync(video);
    if (!m) { res.writeHead(200, { "content-type": "video/mp4", "content-length": size, "accept-ranges": "bytes" }); return res.end(buf); }
    const a = m[1] ? Number(m[1]) : 0, b = m[2] ? Number(m[2]) : size - 1;
    res.writeHead(206, { "content-type": "video/mp4", "content-range": `bytes ${a}-${b}/${size}`, "content-length": b - a + 1, "accept-ranges": "bytes" });
    return res.end(buf.subarray(a, b + 1));
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ channel: "chrome", args: ["--hide-scrollbars", "--force-color-profile=srgb", "--autoplay-policy=no-user-gesture-required"] });
try {
  const vp = { width: 1230, height: 746 };
  const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 2, colorScheme: "dark" });
  await page.goto(base + "/", { waitUntil: "load" });
  const fr = page.frameLocator("#f");
  const frame = page.frames().find((x) => x.url().endsWith("/player.html"));
  await frame.waitForFunction(() => document.querySelector("video")?.readyState >= 2, null, { timeout: 30_000 });
  // Paused in "Dashboards that update live", with its caption on screen.
  await frame.evaluate(async () => {
    const v = document.querySelector("video");
    v.muted = true;
    await v.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
    v.pause();
    v.currentTime = 13.4;
    await new Promise((r) => v.addEventListener("seeked", r, { once: true }));
  });
  await page.waitForTimeout(800);
  // Point at the scrubber over a later chapter: the controls show, with its title above the time.
  const bar = await fr.locator(".bar").first().boundingBox();
  await page.mouse.move(bar.x + bar.width * 0.84, bar.y + bar.height / 2, { steps: 8 });
  await page.waitForTimeout(700);
  const png = path.join(tmp, "shot.png");
  await page.screenshot({ path: png });
  for (const q of [84, 78, 72, 66, 60]) {
    execFileSync(CWEBP, ["-quiet", "-q", String(q), "-m", "6", png, "-o", `${OUT}.webp`]);
    if (statSync(`${OUT}.webp`).size <= 180_000) break;
  }
  // The player is dark in both app themes: the dark variant is the same picture.
  copyFileSync(`${OUT}.webp`, `${OUT}.dark.webp`);
  if (process.argv.includes("--keep-png")) copyFileSync(png, path.join(HERE, ".player.png"));
  console.log(`✓ ${path.relative(FRONTEND, OUT)}.webp (+ .dark.webp) ${Math.round(statSync(`${OUT}.webp`).size / 1024)} KB`);
} finally {
  await browser.close();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}
