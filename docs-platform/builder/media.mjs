/**
 * media.json for a content folder's own files: `<content>/public/docs-assets/**` →
 *
 *   { "/docs-assets/<site>/<page>/<name>.png": { w, h, bytes, kind }, … }
 *
 * The engine reads it for image sizes (no layout shift, 2x screenshots shown at half width), dark
 * variants (`x.dark.png` beside `x.png`) and clips (`<base>.mp4/.webm` + the `<base>.webp` poster).
 * Without it an image renders unsized and a dark variant is never used. A site edited in the
 * dashboard has no media.json of its own (its files live in R2), so the build writes one from the
 * files it fetched. The measuring code is the engine's own (frontend/scripts/docs-media-manifest.mjs:
 * header-only image sizes; ffprobe for videos when it is on PATH).
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const IMAGE = /\.(webp|png|jpe?g|gif)$/i;
const VIDEO = /\.(mp4|webm)$/i;

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** The manifest for `<publicDir>/docs-assets/**` (keys sorted), with the engine's measuring functions. */
export function mediaManifest(publicDir, { imageSize, videoInfo }) {
  const files = walk(path.join(publicDir, "docs-assets")).map((f) => "/" + path.relative(publicDir, f).split(path.sep).join("/"));
  const videos = new Set(files.filter((f) => VIDEO.test(f)).map((f) => f.replace(VIDEO, "")));
  const out = {};
  const problems = [];
  for (const rel of files.sort()) {
    const abs = path.join(publicDir, rel);
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
      out[rel] = { ...(videoInfo(abs) ?? {}), bytes, kind: "clip" };
    }
  }
  return { manifest: out, problems };
}

/**
 * Write `<content>/media.json` unless the folder already has one (an imported folder ships its own).
 * Returns what it did.
 */
export async function writeMediaManifest(contentDir, { engineDir, overwrite = false } = {}) {
  const file = path.join(contentDir, "media.json");
  if (!overwrite && fs.existsSync(file)) return { written: false, reason: "media.json exists" };
  const publicDir = path.join(contentDir, "public");
  if (!fs.existsSync(path.join(publicDir, "docs-assets"))) return { written: false, reason: "no public/docs-assets" };
  const tools = await import(pathToFileURL(path.join(engineDir, "scripts", "docs-media-manifest.mjs")).href);
  const { manifest, problems } = mediaManifest(publicDir, tools);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  return { written: true, files: Object.keys(manifest).length, problems };
}
