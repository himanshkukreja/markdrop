#!/usr/bin/env node
/**
 * docs:media-manifest — writes content/docs/media.json from public/docs-assets/**:
 *
 *   { "/docs-assets/<page>/<name>.webp": { "w": 2400, "h": 1350, "bytes": 81234, "kind": "image" }, … }
 *
 *   npm run docs:media-manifest            # rewrite media.json
 *   npm run docs:media-manifest -- --check # exit 1 when media.json is out of date
 *
 * Images (webp, png, jpg, gif) are measured by a small header reader below; videos (mp4, webm) by
 * ffprobe when it is on PATH, which also gives `duration` (seconds). Without ffprobe a video keeps
 * the size it had in the previous manifest (same byte count), else gets bytes only.
 *
 * kind: `video` under docs-assets/videos/, `clip` for any other mp4/webm, `poster` for an image
 * that shares its base name with a video (x.webp beside x.mp4), `image` otherwise. Captions and
 * chapters (.vtt) are not media and are left out. The engine and docs:check read this file.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PUBLIC = path.join(ROOT, "public");
export const ASSETS = path.join(PUBLIC, "docs-assets");
const CONTENT = process.env.DOCS_CONTENT_DIR || path.join(ROOT, "content", "docs");
export const MANIFEST = path.join(CONTENT, "media.json");

const IMAGE = /\.(webp|png|jpe?g|gif)$/i;
const VIDEO = /\.(mp4|webm)$/i;

/* ── image sizes (headers only) ──────────────────────────────────────────── */
export function imageSize(buf) {
  // PNG: signature, then the IHDR chunk.
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString("ascii", 12, 16) === "IHDR")
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  // GIF: logical screen size.
  if (buf.length >= 10 && buf.toString("ascii", 0, 3) === "GIF") return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  // WebP: RIFF....WEBP then VP8 / VP8L / VP8X.
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (chunk === "VP8L" && buf[20] === 0x2f) {
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 " && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a)
      return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    return null;
  }
  // JPEG: walk the segments to the first start-of-frame marker.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

/* ── video sizes (ffprobe) ───────────────────────────────────────────────── */
let ffprobeOk;
function hasFfprobe() {
  if (ffprobeOk === undefined) {
    try {
      execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
      ffprobeOk = true;
    } catch {
      ffprobeOk = false;
    }
  }
  return ffprobeOk;
}
export function videoInfo(file) {
  if (!hasFfprobe()) return null;
  try {
    const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file], { encoding: "utf8" });
    const j = JSON.parse(out);
    const s = j.streams?.[0] ?? {};
    const d = Number(j.format?.duration);
    return { w: s.width, h: s.height, ...(Number.isFinite(d) ? { duration: Math.round(d * 100) / 100 } : {}) };
  } catch {
    return null;
  }
}

/* ── scan ────────────────────────────────────────────────────────────────── */
function walk(dir) {
  let out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else out.push(p);
  }
  return out;
}

/** The manifest for everything under public/docs-assets (keys sorted). */
export function buildManifest(previous = {}) {
  const files = walk(ASSETS).map((f) => "/" + path.relative(PUBLIC, f).split(path.sep).join("/"));
  const videos = new Set(files.filter((f) => VIDEO.test(f)).map((f) => f.replace(VIDEO, "")));
  const out = {};
  const problems = [];
  for (const rel of files.sort()) {
    const abs = path.join(PUBLIC, rel);
    const bytes = fs.statSync(abs).size;
    if (IMAGE.test(rel)) {
      const fd = fs.openSync(abs, "r");
      const buf = Buffer.alloc(Math.min(bytes, 256 * 1024));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const size = imageSize(buf);
      if (!size) problems.push(`${rel}: couldn't read the image size`);
      out[rel] = { ...(size ?? {}), bytes, kind: videos.has(rel.replace(IMAGE, "")) ? "poster" : "image" };
    } else if (VIDEO.test(rel)) {
      const kind = rel.startsWith("/docs-assets/videos/") ? "video" : "clip";
      let info = videoInfo(abs);
      if (!info) {
        const prev = previous[rel];
        info = prev && prev.bytes === bytes ? { w: prev.w, h: prev.h, ...(prev.duration ? { duration: prev.duration } : {}) } : {};
        if (!prev || prev.bytes !== bytes) problems.push(`${rel}: no ffprobe on PATH, size unknown`);
      }
      out[rel] = { ...info, bytes, kind };
    }
  }
  return { manifest: out, problems };
}

function readPrevious() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  } catch {
    return {};
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const previous = readPrevious();
  const { manifest, problems } = buildManifest(previous);
  for (const p of problems) console.warn(`warn  ${p}`);
  const text = JSON.stringify(manifest, null, 2) + "\n";
  const count = Object.keys(manifest).length;
  if (process.argv.includes("--check")) {
    const same = fs.existsSync(MANIFEST) && fs.readFileSync(MANIFEST, "utf8") === text;
    console.log(same ? `media.json is up to date (${count} files).` : "media.json is out of date: run npm run docs:media-manifest");
    process.exit(same ? 0 : 1);
  }
  fs.writeFileSync(MANIFEST, text);
  console.log(`media.json: ${count} file${count === 1 ? "" : "s"} under public/docs-assets${hasFfprobe() ? "" : " (no ffprobe: video sizes kept from the previous manifest)"}.`);
}
