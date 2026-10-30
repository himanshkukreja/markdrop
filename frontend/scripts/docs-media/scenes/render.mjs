#!/usr/bin/env node
/**
 * docs:scenes — renders the animated scenes in frontend/content/docs/video-scenes/<id>/index.html
 * into the docs' clips, videos and stills.
 *
 *   npm run docs:scenes                       # every scene
 *   npm run docs:scenes -- who-can-open p2p-direct-vs-relay
 *   npm run docs:scenes -- e2e-key-in-link --at 2,7.5,15   # just these moments, as PNGs (review)
 *   npm run docs:scenes -- e2e-key-in-link --sheet         # also a contact sheet of the frames
 *   options: --workers N (parallel pages, default 4), --keep (keep the frames), --no-manifest,
 *            --stills-only, --no-stills
 *
 * A scene is a pure function of time (see _kit/kit.js): the page is loaded with ?render=1, and for
 * every frame at 30 fps the renderer calls window.__setTime(t) and screenshots the stage. Frames
 * are rendered by several pages at once (any frame can be drawn at any time), then ffmpeg encodes:
 *
 *   clip  (meta.out = {kind: "clip", page: "/docs/page", name})
 *         → public/docs-assets/<page>/<name>.mp4 (H.264, yuv420p, faststart) + .webm (VP9)
 *           + .webp poster (at meta.poster), ≤ 1.6 MB each, poster ≤ 180 KB
 *   video (meta.out = {kind: "video", id, title})
 *         → public/docs-assets/videos/<id>.mp4 + .webp poster + .vtt chapters (meta.chapters),
 *           and the entry in content/docs/videos.json
 *   still (meta.stills = [{t, page, name, themes, width, height, scale, query}])
 *         → public/docs-assets/<page>/<name>.webp (+ .dark.webp), 2× DPR, ≤ 180 KB
 *
 * then content/docs/media.json is regenerated (npm run docs:media-manifest). Fonts and scene files
 * are served from frontend/ by a throwaway local HTTP server; nothing else is fetched.
 */
import { chromium } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, "../../..");
const SCENES = path.join(FRONTEND, "content/docs/video-scenes");
const PUBLIC = path.join(FRONTEND, "public");
const ASSETS = path.join(PUBLIC, "docs-assets");
const VIDEOS_JSON = path.join(FRONTEND, "content/docs/videos.json");
const FFMPEG = process.env.FFMPEG || (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg");
const FFPROBE = process.env.FFPROBE || (existsSync("/opt/homebrew/bin/ffprobe") ? "/opt/homebrew/bin/ffprobe" : "ffprobe");
const KB = 1024;
const BUDGET = { clip: 1.6 * KB * KB, video: 25 * KB * KB, poster: 180 * KB, videoPoster: 220 * KB, still: 180 * KB };

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : null;
};
const OPTS_WITH_VALUE = new Set(["--workers", "--at"]);
const ids = argv.filter((a, i) => !a.startsWith("--") && !OPTS_WITH_VALUE.has(argv[i - 1]));
const WORKERS = Number(opt("--workers") || 4);
const mine = new Set(); // videos.json ids this run rendered

// ── Static server (frontend/ only) ────────────────────────────────────────────

const MIME = { ".mp4": "video/mp4", ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };
const ALLOWED = [path.join(FRONTEND, "content/docs/video-scenes"), path.join(FRONTEND, "src/app/fonts")];

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      const file = path.join(FRONTEND, p);
      if (!ALLOWED.some((a) => file.startsWith(a + path.sep)) || !existsSync(file) || statSync(file).isDirectory()) {
        res.writeHead(404).end();
        return;
      }
      const type = MIME[path.extname(file)] || "application/octet-stream";
      const size = statSync(file).size;
      // Byte ranges, so <video> elements can seek.
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
      if (m) {
        const start = m[1] ? Number(m[1]) : size - Number(m[2]);
        const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
        res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": end - start + 1, "cache-control": "no-store" });
        createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size, "cache-control": "no-store" });
      createReadStream(file).pipe(res);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

// ── ffmpeg ────────────────────────────────────────────────────────────────────

const ff = (args) => execFileSync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", ...args]);
const kb = (f) => `${(statSync(f).size / KB).toFixed(0)} KB`;

function probe(file) {
  const out = execFileSync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file]).toString();
  const j = JSON.parse(out);
  return { width: j.streams?.[0]?.width, height: j.streams?.[0]?.height, duration: Number(j.format?.duration || 0) };
}

function encodeMp4(frames, out, { crf, maxBytes, width }) {
  for (let c = crf; c <= crf + 12; c += 2) {
    const vf = width ? ["-vf", `scale=${width}:-2:flags=lanczos`] : [];
    ff(["-framerate", "30", "-i", path.join(frames, "%05d.png"), ...vf, "-an", "-c:v", "libx264", "-preset", "slow", "-tune", "animation",
      "-crf", String(c), "-pix_fmt", "yuv420p", "-profile:v", "high", "-movflags", "+faststart", out]);
    if (statSync(out).size <= maxBytes) return c;
  }
  console.warn(`  ! ${path.relative(FRONTEND, out)} is ${kb(out)}, over budget`);
  return null;
}

function encodeWebm(frames, out, { crf, maxBytes }) {
  for (let c = crf; c <= crf + 15; c += 3) {
    ff(["-framerate", "30", "-i", path.join(frames, "%05d.png"), "-an", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String(c),
      "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", "-pix_fmt", "yuv420p", out]);
    if (statSync(out).size <= maxBytes) return c;
  }
  console.warn(`  ! ${path.relative(FRONTEND, out)} is ${kb(out)}, over budget`);
  return null;
}

function toWebp(png, out, { maxBytes, quality = 86, width }) {
  for (let q = quality; q >= 50; q -= 6) {
    const vf = width ? ["-vf", `scale=${width}:-2:flags=lanczos`] : [];
    ff(["-i", png, "-frames:v", "1", ...vf, "-c:v", "libwebp", "-quality", String(q), "-compression_level", "6", "-preset", "picture", out]);
    if (statSync(out).size <= maxBytes) return q;
  }
  console.warn(`  ! ${path.relative(FRONTEND, out)} is ${kb(out)}, over budget`);
  return null;
}

function vtt(chapters, total) {
  const ts = (s) => {
    const ms = Math.max(0, Math.round(s * 1000));
    const hh = String(Math.floor(ms / 3600000)).padStart(2, "0");
    const mm = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
    const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
    return `${hh}:${mm}:${ss}.${String(ms % 1000).padStart(3, "0")}`;
  };
  const cs = chapters.map((c, i) => ({ start: c.t, end: chapters[i + 1]?.t ?? total, text: c.title }));
  return `WEBVTT\n\n${cs.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}`).join("\n\n")}\n`;
}

const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const pageDir = (page) => path.join(ASSETS, page.replace(/^\/+|\/+$/g, ""));

function sheet(frames, n, out) {
  // 12 frames evenly spread over the scene, 4×3, each 480 px wide.
  const files = readdirSync(frames).filter((f) => f.endsWith(".png")).sort();
  const pick = Array.from({ length: 12 }, (_, i) => files[Math.min(files.length - 1, Math.round((i * (files.length - 1)) / 11))]);
  const list = path.join(frames, "sheet.txt");
  writeFileSync(list, pick.map((f) => `file '${path.join(frames, f)}'\nduration 1`).join("\n"));
  ff(["-f", "concat", "-safe", "0", "-i", list, "-vf", "scale=480:-2:flags=lanczos,tile=4x3:padding=6:color=white", "-frames:v", "1", out]);
}

// ── Render ────────────────────────────────────────────────────────────────────

async function readMeta(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`  page error: ${e.message}`));
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready, null, { timeout: 30_000 });
  await page.evaluate(() => window.__ready);
  const meta = await page.evaluate(() => window.__scene);
  await ctx.close();
  return meta;
}

async function pagesFor(browser, url, meta, n, { scale = 1 } = {}) {
  const pages = [];
  for (let i = 0; i < n; i++) {
    const ctx = await browser.newContext({ viewport: { width: meta.width, height: meta.height }, deviceScaleFactor: scale });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error(`  page error: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") console.error(`  console: ${m.text()}`); });
    await page.goto(url, { waitUntil: "load" });
    await page.evaluate(() => window.__ready);
    pages.push(page);
  }
  return pages;
}

async function shoot(page, t, file) {
  await page.evaluate((tt) => window.__setTime(tt), t);
  await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
}

async function renderFrames(browser, url, meta, dir) {
  const fps = meta.fps || 30;
  const n = Math.round(meta.duration * fps);
  const pages = await pagesFor(browser, url, meta, WORKERS, { scale: meta.scale || 1 });
  let done = 0;
  const t0 = Date.now();
  await Promise.all(pages.map(async (page, w) => {
    for (let i = w; i < n; i += pages.length) {
      await shoot(page, i / fps, path.join(dir, `${String(i).padStart(5, "0")}.png`));
      done++;
      if (w === 0 && i % (pages.length * 30) === 0) process.stdout.write(`\r  frames ${done}/${n}`);
    }
  }));
  process.stdout.write(`\r  frames ${n}/${n} in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
  await Promise.all(pages.map((p) => p.context().close()));
  return n;
}

async function renderScene(browser, base, id, videosJson, written) {
  const url = `${base}/content/docs/video-scenes/${id}/index.html?render=1`;
  const meta = await readMeta(browser, url);
  const out = meta.out || {};
  const sc = meta.scale || 1;
  console.log(`▸ ${id}  [${out.kind || "stills"}]  ${Math.round(meta.width * sc)}×${Math.round(meta.height * sc)}  ${meta.duration}s`);
  const tmp = mkdtempSync(path.join(os.tmpdir(), `scene-${id}-`));

  if (opt("--at")) {
    const pages = await pagesFor(browser, url, meta, 1, { scale: meta.scale || 1 });
    for (const t of opt("--at").split(",").map(Number)) {
      const f = path.join(tmp, `${id}-${t.toFixed(2)}.png`);
      await shoot(pages[0], t, f);
      console.log(`  ${f}`);
    }
    await pages[0].context().close();
    return;
  }

  if (out.kind && !flag("--stills-only")) {
    const frames = path.join(tmp, "frames");
    mkdirSync(frames);
    await renderFrames(browser, url, meta, frames);
    const posterFrame = path.join(frames, `${String(Math.round((meta.poster ?? meta.duration - 0.5) * 30)).padStart(5, "0")}.png`);
    if (out.kind === "clip") {
      const dir = pageDir(out.page);
      mkdirSync(dir, { recursive: true });
      const b = path.join(dir, out.name || id);
      encodeMp4(frames, `${b}.mp4`, { crf: out.crf || 24, maxBytes: BUDGET.clip });
      encodeWebm(frames, `${b}.webm`, { crf: out.webmCrf || 36, maxBytes: BUDGET.clip });
      toWebp(posterFrame, `${b}.webp`, { maxBytes: BUDGET.poster });
      written.push(`${b}.mp4`, `${b}.webm`, `${b}.webp`);
    } else if (out.kind === "video") {
      const dir = path.join(ASSETS, "videos");
      mkdirSync(dir, { recursive: true });
      const b = path.join(dir, out.id || id);
      const px = Math.round(meta.width * (meta.scale || 1));
      encodeMp4(frames, `${b}.mp4`, { crf: out.crf || 20, maxBytes: BUDGET.video, width: px === 1920 ? null : 1920 });
      toWebp(posterFrame, `${b}.webp`, { maxBytes: BUDGET.videoPoster, width: px === 1920 ? null : 1920 });
      const total = probe(`${b}.mp4`).duration;
      const entry = { src: `/docs-assets/videos/${path.basename(b)}.mp4`, poster: `/docs-assets/videos/${path.basename(b)}.webp`, duration: fmtDur(total) };
      if (out.title) entry.title = out.title;
      if (meta.chapters?.length) {
        writeFileSync(`${b}.vtt`, vtt(meta.chapters, total));
        entry.chapters = `/docs-assets/videos/${path.basename(b)}.vtt`;
        written.push(`${b}.vtt`);
      }
      videosJson[out.id || id] = entry;
      mine.add(out.id || id);
      written.push(`${b}.mp4`, `${b}.webp`);
    }
    if (flag("--sheet")) {
      const s = path.join(os.tmpdir(), `${id}-sheet.png`);
      sheet(frames, 12, s);
      console.log(`  sheet ${s}`);
    }
  }

  if (meta.stills?.length && !flag("--no-stills")) {
    for (const st of meta.stills) {
      for (const theme of st.themes || ["light"]) {
        const q = new URLSearchParams({ render: "1", theme, ...(st.query || {}) });
        const surl = `${base}/content/docs/video-scenes/${id}/index.html?${q}`;
        const smeta = { ...meta, width: st.width || meta.width, height: st.height || meta.height };
        const [page] = await pagesFor(browser, surl, smeta, 1, { scale: st.scale || 2 });
        const png = path.join(tmp, `${st.name}.${theme}.png`);
        await shoot(page, st.t, png);
        await page.context().close();
        const dir = pageDir(st.page);
        mkdirSync(dir, { recursive: true });
        const f = path.join(dir, `${st.name}${theme === "dark" ? ".dark" : ""}.webp`);
        toWebp(png, f, { maxBytes: BUDGET.still, quality: 88 });
        written.push(f);
      }
    }
  }
  if (!flag("--keep")) rmSync(tmp, { recursive: true, force: true });
  else console.log(`  kept ${tmp}`);
}

async function main() {
  const all = readdirSync(SCENES, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_") && existsSync(path.join(SCENES, e.name, "index.html")))
    .map((e) => e.name)
    .sort();
  if (flag("--list")) {
    console.log(all.join("\n"));
    return;
  }
  const chosen = ids.length ? ids : all;
  for (const id of chosen) if (!all.includes(id)) throw new Error(`no scene ${id} (have: ${all.join(", ")})`);

  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--hide-scrollbars", "--force-color-profile=srgb", "--font-render-hinting=none", "--disable-lcd-text"] });
  let videosJson = {};
  try {
    videosJson = JSON.parse(readFileSync(VIDEOS_JSON, "utf8"));
  } catch {}
  const written = [];
  const failures = [];
  try {
    for (const id of chosen) {
      const t = Date.now();
      try {
        await renderScene(browser, base, id, videosJson, written);
        console.log(`  done in ${((Date.now() - t) / 1000).toFixed(1)} s`);
      } catch (e) {
        console.error(`  FAILED: ${e.stack || e}`);
        failures.push(id);
      }
    }
  } finally {
    await browser.close();
    srv.close();
  }
  for (const f of written) {
    const extra = /\.(mp4|webm)$/.test(f) ? (() => { const p = probe(f); return `  ${p.width}×${p.height}  ${p.duration.toFixed(1)} s`; })() : "";
    console.log(`  ${path.relative(PUBLIC, f)}  ${kb(f)}${extra}`);
  }
  if (!opt("--at") && !flag("--no-manifest") && written.length) {
    // Other runners write videos.json too: merge this run's entries into the file as it is now.
    let now = {};
    try {
      now = JSON.parse(readFileSync(VIDEOS_JSON, "utf8"));
    } catch {}
    for (const id of mine) now[id] = videosJson[id];
    const sorted = Object.fromEntries(Object.entries(now).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(VIDEOS_JSON, `${JSON.stringify(sorted, null, 2)}\n`);
    const r = spawnSync(process.execPath, [path.join(FRONTEND, "scripts/docs-media-manifest.mjs")], {
      cwd: FRONTEND, stdio: "inherit", env: { ...process.env, PATH: `${path.dirname(FFPROBE)}:${process.env.PATH}` },
    });
    if (r.status !== 0) console.warn("  ! docs-media-manifest.mjs failed");
  }
  if (failures.length) {
    console.error(`\n${failures.length} failed: ${failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
