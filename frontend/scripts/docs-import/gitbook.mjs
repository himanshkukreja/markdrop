#!/usr/bin/env node
/**
 * GitBook → Markdrop Docs importer.
 *
 *   node scripts/docs-import/gitbook.mjs https://docs.example.com --out /path/to/site [options]
 *
 *   --out <dir>       content folder to write (DOCS_CONTENT_DIR). Emptied first (its .cache is kept).
 *   --cache <dir>     HTTP cache (default <out>/.cache/<host>); reruns refetch nothing
 *   --id <id>         site id (default: from the host, docs.acme.com → acme)
 *   --date <date>     frontmatter `updated` (default: today)
 *   --keep-dates      frontmatter `updated` from GitBook's "Last updated" (default: --date)
 *   --keep-gifs       keep animated GIFs as images (default: MP4 clips when ffmpeg is on PATH)
 *   --refresh         ignore the cache
 *   --allow-repo      allow --out inside this git repository (imported content is someone else's)
 *
 * How it reads a public GitBook site (no API token, nothing GitBook-internal):
 *   1. /llms.txt                 every page (incl. hidden ones) with its .md URL and description
 *   2. the site's HTML           sidebar groups and order, nav labels, site name, logo, favicon, accent
 *   3. <page>.md per page        GitBook's Markdown export of the page (converted, see lib/convert.mjs)
 *   4. <page> HTML per page      heading ids (to report deep links whose #anchor changes) and the
 *                                download URLs behind {% file %} blocks
 *   5. images and files          downloaded into <out>/public/docs-assets/<id>/<page>/
 *
 * Output (all inside --out):
 *   site.json, index.md, <section>/<page>.md, media.json, videos.json (when there are videos),
 *   public/docs-assets/<id>/…, redirects.json (every GitBook path → its new path),
 *   _IMPORT_REPORT.md (the leading _ keeps the engine and docs:check from reading it as a page).
 *
 * Assets: the engine serves /docs-assets/ from the app's public/ folder, so for now a site's
 * assets live in <out>/public/docs-assets/<id>/ and have to be copied (or linked) into the app's
 * public/docs-assets/<id>/ to render; docs:check finds them in <out>/public on its own.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFetcher } from "./lib/fetch.mjs";
import { decodeEntities, lighten } from "./lib/html.mjs";
import { createSite } from "./lib/site.mjs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { convertBody, firstParagraph, parseGitbookPage, trimDescription, unescapeMd, videoEmbedUrl } from "./lib/convert.mjs";
import { headingIds, looseId, slugify } from "./lib/slug.mjs";
import { imageSize, videoInfo } from "../docs-media-manifest.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");

/* ── args ────────────────────────────────────────────────────────────────── */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (["refresh", "allow-repo", "keep-gifs", "keep-dates"].includes(k)) out[k] = true;
      else out[k] = argv[++i];
    } else out._.push(a);
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
if (!args._[0] || !args.out) {
  console.error("usage: node scripts/docs-import/gitbook.mjs <site-url> --out <dir> [--cache dir] [--id id] [--date YYYY-MM-DD] [--refresh]");
  process.exit(2);
}
const SITE = new URL(args._[0].replace(/\/*$/, "/"));
const ORIGIN = SITE.origin;
const BASE = SITE.pathname.replace(/\/$/, ""); // a site under a path: https://x.gitbook.io/docs
const OUT = path.resolve(args.out);
const ID = args.id || SITE.hostname.replace(/^(docs|www|help|developer|developers)\./, "").split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "-");
const TODAY = args.date || new Date().toISOString().slice(0, 10);
const CACHE = path.resolve(args.cache || path.join(OUT, ".cache", SITE.hostname));
const ASSET_BASE = `/docs-assets/${ID}`;

if (!args["allow-repo"] && (OUT + path.sep).startsWith(REPO + path.sep)) {
  console.error(`refusing to write into the repository (${OUT}): imported docs are third-party content. Use a folder outside it, or --allow-repo.`);
  process.exit(2);
}
if (fs.existsSync(path.join(OUT, ".git")) || fs.existsSync(path.join(OUT, "package.json"))) {
  console.error(`refusing to empty ${OUT}: it looks like a project folder.`);
  process.exit(2);
}

// ffmpeg turns animated GIFs into clips (MP4 + WebP poster); ffprobe measures them for media.json.
function findTool(name) {
  for (const d of [...(process.env.PATH || "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]) if (d && fs.existsSync(path.join(d, name))) return path.join(d, name);
  return null;
}
const FFMPEG = args["keep-gifs"] ? null : findTool("ffmpeg");
const FFPROBE = findTool("ffprobe");
if (FFPROBE) process.env.PATH = `${path.dirname(FFPROBE)}:${process.env.PATH}`;

const log = (...a) => console.log(...a);
const http = createFetcher({ cacheDir: CACHE, refresh: !!args.refresh, log: process.env.DEBUG ? log : () => {} });

/* ── report state ────────────────────────────────────────────────────────── */
const counts = new Map(); // kind → Map(how → n)
const issues = []; // { page, line, kind, msg }
const broken = []; // { page, line, href, reason }
const missing = []; // { page, line, src, reason }
const altGenerated = []; // { page, line, alt }
const anchorFixes = []; // { page, href, to }
const notes = [];
function count(kind, how) {
  if (!counts.has(kind)) counts.set(kind, new Map());
  const m = counts.get(kind);
  m.set(how, (m.get(how) ?? 0) + 1);
}

/* ── 1. discover ─────────────────────────────────────────────────────────── */
const { abs, gbPathOf, parseLlms, parseSidebar, detectBrand, fileLinks } = createSite(ORIGIN, BASE);

/* ── main ────────────────────────────────────────────────────────────────── */
log(`GitBook import: ${ORIGIN}${BASE} → ${OUT} (site id "${ID}", cache ${CACHE})`);

const llmsRes = await http.text(abs("llms.txt"));
if (!llmsRes.ok) {
  console.error(`no llms.txt at ${abs("llms.txt")} (HTTP ${llmsRes.status}); is this a public GitBook site?`);
  process.exit(1);
}
const sections = parseLlms(llmsRes.text);
const llmsPages = sections.flatMap((s, si) => s.pages.map((p) => ({ ...p, section: si })));
log(`llms.txt: ${llmsPages.length} pages in ${sections.length} section(s)`);

const rootHtml = (await http.text(abs(""))).text;
const brand = detectBrand(rootHtml);

// Sidebar per section (one section: the root page's sidebar).
const sidebars = [];
for (let si = 0; si < Math.max(1, sections.length); si++) {
  const first = sections[si]?.pages[0];
  const html = si === 0 || !first ? rootHtml : (await http.text(abs(first.gb.slice(1)))).text;
  const sb = parseSidebar(html);
  if (sb) sidebars.push({ section: si, ...sb });
}
const multiSection = sections.length > 1 && sidebars.length > 1;

/* ── 2. pages: paths, fetch ──────────────────────────────────────────────── */
const pages = []; // { gb, our, file, mdUrl, htmlUrl, title, navTitle, llmsDesc, inNav, section }
const byGb = new Map();
const used = new Set();
function addPage(gb, info) {
  if (byGb.has(gb)) return byGb.get(gb);
  let our = gb;
  if (gb === "/") our = "/" + (slugify(info.title || "welcome") || "welcome");
  // A GitBook path that our engine can't use verbatim (odd characters): slug each segment.
  our = "/" + our.slice(1).split("/").map((s) => slugify(s) || "page").join("/");
  let n = 2;
  const baseOur = our;
  while (used.has(our)) our = `${baseOur}-${n++}`;
  used.add(our);
  const p = { gb, our, file: our.slice(1) + ".md", mdUrl: info.url || abs((gb === "/" ? "readme" : gb.slice(1)) + ".md"), htmlUrl: abs(gb === "/" ? "" : gb.slice(1)), title: info.title, navTitle: info.navTitle, llmsDesc: info.description ?? "", inNav: false, section: info.section ?? 0 };
  pages.push(p);
  byGb.set(gb, p);
  return p;
}
const llmsByGb = new Map(llmsPages.map((p) => [p.gb, p]));
for (const sb of sidebars)
  for (const g of sb.groups)
    for (const it of g.items) {
      const l = llmsByGb.get(it.gb);
      const p = addPage(it.gb, { title: l?.title ?? it.title, navTitle: it.title, url: l?.url, description: l?.description, section: sb.section });
      p.inNav = true;
    }
for (const l of llmsPages) addPage(l.gb, { title: l.title, url: l.url, description: l.description, section: l.section });

log(`pages: ${pages.length} (${pages.filter((p) => p.inNav).length} in the sidebar, ${pages.filter((p) => !p.inNav).length} hidden)`);

for (const p of pages) {
  const md = await http.text(p.mdUrl);
  if (!md.ok) {
    issues.push({ page: p.gb, line: 0, kind: "fetch", msg: `couldn't fetch ${p.mdUrl} (HTTP ${md.status})` });
    p.failed = true;
    continue;
  }
  p.src = md.text;
  const html = await http.text(p.htmlUrl);
  p.html = html.ok ? html.text : "";
  const parsed = parseGitbookPage(p.src, p.llmsDesc);
  p.title = parsed.title || p.title || p.navTitle || p.gb;
  p.gbDescription = parsed.description;
  p.body = parsed.body;
  p.bodyLine = parsed.bodyLine;
  p.gbIds = [...(p.html.matchAll(/<h[1-4][^>]*\sid="([^"]+)"/g) ?? [])].map((m) => decodeEntities(m[1]));
  p.files = fileLinks(p.html);
  // --keep-dates: GitBook's "Last updated" (<time dateTime="…">) instead of the import date.
  p.gbUpdated = /dateTime="(\d{4}-\d{2}-\d{2})T/.exec(p.html)?.[1];
  p.updated = (args["keep-dates"] && p.gbUpdated) || TODAY;
}
const live = pages.filter((p) => !p.failed);

// Links to pages that moved: GitBook still redirects their old paths, so ask it where they went.
const moved = new Map(); // old GitBook path → current GitBook path
{
  const candidates = new Set();
  for (const p of live)
    for (const m of p.body.matchAll(/\]\(([^)\s]+)|href="([^"]+)"|url="([^"]+)"/g)) {
      const href = unescapeMd(decodeEntities(m[1] ?? m[2] ?? m[3]));
      if (/^(#|mailto:|tel:|broken:)/.test(href)) continue;
      const gb = gbPathOf(href, p.gb);
      if (gb && gb !== "/" && !byGb.has(gb) && !/^\/(~gitbook|~\/files|files)\//.test(gb) && !/\.[a-z0-9]{2,5}$/i.test(gb)) candidates.add(gb);
    }
  for (const gb of candidates) {
    const r = await http.get(abs(gb.slice(1)));
    const to = r.ok ? gbPathOf(r.url) : null;
    if (to && to !== gb && byGb.has(to)) moved.set(gb, to);
  }
  if (candidates.size) log(`links to unknown paths: ${candidates.size}, ${moved.size} resolved through GitBook redirects`);
}

/* ── 3. convert ──────────────────────────────────────────────────────────── */
const assets = new Map(); // url → { token, kind, page, base, dark?, alt, … }
let tokenN = 0;
const videos = {};
const FILE_HOSTS = /(^|\.)(files\.gitbook\.io|content\.gitbook\.com|gitbook-x-prod\.appspot\.com|firebasestorage\.googleapis\.com)$/;

function assetFor(url, kind, page, hint) {
  if (assets.has(url)) return assets.get(url);
  const a = { token: `@@ASSET${++tokenN}@@`, url, kind, page, hint };
  assets.set(url, a);
  return a;
}

function pageCtx(p) {
  const at = (line) => (typeof line === "number" ? line + 1 : 0);
  let images = 0;
  return {
    count,
    issue: (kind, line, msg) => issues.push({ page: p.gb, line: at(line), kind, msg }),
    link(href, { line } = {}) {
      const h = decodeEntities(String(href ?? "")).trim();
      if (!h) return null;
      if (h.startsWith("#")) return h;
      if (/^broken:/.test(h)) {
        broken.push({ page: p.gb, line: at(line), href: h, reason: "broken link in GitBook itself (its target page was deleted)" });
        return null;
      }
      if (/^(mailto|tel):/i.test(h)) return h;
      let u;
      try {
        u = new URL(h, ORIGIN + BASE + (p.gb === "/" ? "/" : p.gb));
      } catch {
        broken.push({ page: p.gb, line: at(line), href: h, reason: "not a valid URL" });
        return null;
      }
      if (FILE_HOSTS.test(u.hostname) || u.pathname.includes("/~/files/")) {
        count("file link", "downloaded to docs-assets");
        return assetFor(u.href, "file", p, { name: decodeURIComponent(u.pathname.split("/").pop().split("%2F").pop()) }).token;
      }
      if (u.origin !== ORIGIN) return h;
      const gb = gbPathOf(u.href);
      const hash = u.hash ? decodeURIComponent(u.hash) : "";
      if (gb === "/") return "/" + (hash ? hash : "");
      const target = byGb.get(gb);
      if (target && !target.failed) return target.our + hash;
      if (moved.has(gb)) {
        count("link to a moved page", "rewritten to where GitBook redirects it");
        return byGb.get(moved.get(gb)).our + hash;
      }
      broken.push({ page: p.gb, line: at(line), href: h, reason: "no such page in the import: kept as a link to the original site" });
      return ORIGIN + BASE + gb + hash;
    },
    image(src, { alt, caption, darkSrc, line }) {
      if (!src) return null;
      let u;
      try {
        u = new URL(src, ORIGIN + BASE + "/");
      } catch {
        missing.push({ page: p.gb, line: at(line), src, reason: "invalid URL" });
        return null;
      }
      if (u.protocol === "data:") {
        missing.push({ page: p.gb, line: at(line), src: src.slice(0, 40) + "…", reason: "inline data: image not imported" });
        return null;
      }
      images++;
      let a = alt || caption;
      if (!a || /^(image|img|screenshot|untitled|alt)\s*\d*$/i.test(a)) {
        a = `Screenshot from “${p.title}”${images > 1 ? ` (${images})` : ""}`;
        altGenerated.push({ page: p.gb, line: at(line), alt: a });
      }
      const asset = assetFor(u.href, "image", p, { name: caption || alt, darkSrc });
      return { src: asset.token, alt: a };
    },
    file(index, src, { line } = {}) {
      const f = /^https?:/.test(src) ? { url: src, name: decodeURIComponent(src.split("?")[0].split("/").pop().split("%2F").pop()) } : p.files[index];
      if (!f) return null;
      const a = assetFor(f.url, "file", p, { name: f.name });
      const ext = (/\.([a-z0-9]+)$/i.exec(f.name)?.[1] ?? "").toLowerCase();
      return { href: a.token, name: f.name, ext, size: f.size };
    },
    video(url, title) {
      const id = (slugify(title).slice(0, 40) || `video-${Object.keys(videos).length + 1}`).replace(/^-+|-+$/g, "");
      let vid = `${slugify(p.our.split("/").pop())}-${id}`.slice(0, 60).replace(/-+$/, "");
      if (videos[vid]) vid += `-${Object.keys(videos).length + 1}`;
      videos[vid] = { url: videoEmbedUrl(url), title };
      return vid;
    },
    pageInfo(href) {
      const gb = gbPathOf(String(href ?? ""), p.gb);
      const t = gb && byGb.get(gb);
      if (!t) return null;
      return { title: t.title, description: t.gbDescription ? trimDescription(t.gbDescription) : t.llmsDesc ? trimDescription(t.llmsDesc) : "" };
    },
  };
}

for (const p of live) p.out = convertBody(p.body, p.bodyLine, pageCtx(p));

/* ── 4. download assets ──────────────────────────────────────────────────── */
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/avif": "avif" };
const taken = new Set();
const media = {};
let bytesTotal = 0;
/** A unique `<dir>/<slug><suffix>.<ext>` (suffix "@1x" marks an image shown at its pixel width). */
function assetName(dir, base, ext, suffix = "") {
  let stem = slugify(base.replace(/\.[a-z0-9]{2,5}$/i, "")).replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60).replace(/-$/, "") || "image";
  let rel = `${dir}/${stem}${suffix}.${ext}`;
  for (let n = 2; taken.has(rel); n++) rel = `${dir}/${stem}-${n}${suffix}.${ext}`;
  taken.add(rel);
  return rel;
}

/**
 * Animated GIF → clip: <base>.mp4 (H.264) and its poster <base>.webp, cached by URL so reruns
 * don't re-encode. GitBook pages are full of multi-megabyte screen-recording GIFs (often 20-60 MB);
 * the engine's ::clip plays the MP4 at a fraction of the size. Returns the clip base or null.
 */
function gifToClip(buf, a, dir, name) {
  const key = crypto.createHash("sha1").update(a.url).digest("hex");
  const cdir = path.join(CACHE, "clips");
  fs.mkdirSync(cdir, { recursive: true });
  const mp4 = path.join(cdir, `${key}.mp4`);
  const webp = path.join(cdir, `${key}.webp`);
  try {
    if (!fs.existsSync(mp4) || !fs.existsSync(webp)) {
      const gif = path.join(cdir, `${key}.gif`);
      fs.writeFileSync(gif, buf);
      execFileSync(FFMPEG, ["-y", "-v", "error", "-i", gif, "-movflags", "+faststart", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-preset", "medium", "-crf", "26", "-an", mp4], { stdio: "ignore" });
      execFileSync(FFMPEG, ["-y", "-v", "error", "-i", gif, "-frames:v", "1", "-c:v", "libwebp", "-quality", "80", webp], { stdio: "ignore" });
      fs.rmSync(gif, { force: true });
    }
  } catch (e) {
    issues.push({ page: a.page.gb, line: 0, kind: "gif", msg: `ffmpeg couldn't convert ${a.url.slice(0, 80)}…: kept the GIF (${String(e.message).split("\n")[0]})` });
    return null;
  }
  const rel = assetName(dir, name, "mp4").replace(/\.mp4$/, "");
  taken.add(`${rel}.webp`);
  write(`${rel}.mp4`, fs.readFileSync(mp4));
  write(`${rel}.webp`, fs.readFileSync(webp));
  const info = videoInfo(path.join(PUBLIC, `${rel}.mp4`)) ?? {};
  media[`${rel}.mp4`] = { ...info, bytes: fs.statSync(mp4).size, kind: "clip" };
  media[`${rel}.webp`] = { ...(imageSize(fs.readFileSync(webp)) ?? {}), bytes: fs.statSync(webp).size, kind: "poster" };
  gifStats.before += buf.length;
  gifStats.after += fs.statSync(mp4).size + fs.statSync(webp).size;
  gifStats.n++;
  return rel;
}
const gifStats = { n: 0, before: 0, after: 0 };
const PUBLIC = path.join(OUT, "public");
async function download(url) {
  const r = await http.get(url);
  return r.ok && r.body.length ? r : null;
}
log(`assets: ${assets.size} to download`);
for (const a of assets.values()) {
  const r = await download(a.url);
  if (!r) {
    a.failed = true;
    missing.push({ page: a.page.gb, line: 0, src: a.url, reason: "download failed: kept the original URL" });
    continue;
  }
  const dir = `${ASSET_BASE}/${a.page.our.slice(1)}`;
  const type = (r.type.split(";")[0] || "").trim().toLowerCase();
  const urlName = decodeURIComponent(new URL(a.url).pathname.split("/").pop() ?? "").split("/").pop();
  if (a.kind === "image") {
    if (type && !type.startsWith("image/")) {
      a.failed = true;
      missing.push({ page: a.page.gb, line: 0, src: a.url, reason: `not an image (${type}): kept the original URL` });
      continue;
    }
    const ext = EXT[type] ?? (/\.([a-z0-9]+)$/i.exec(urlName)?.[1] ?? "png").toLowerCase().replace("jpeg", "jpg");
    if (ext === "gif" && FFMPEG && !a.hint?.darkSrc) {
      a.clip = gifToClip(r.body, a, dir, a.hint?.name || urlName);
      if (a.clip) {
        a.rel = `${a.clip}.webp`;
        bytesTotal += media[`${a.clip}.mp4`].bytes + media[`${a.clip}.webp`].bytes;
        continue;
      }
    }
    const size = imageSize(r.body);
    // The engine shows images at half their pixel width (2x captures) unless named …@1x; GitBook
    // shows them at column width. Smaller than 1600px: mark 1x so they still fill the column.
    a.rel = assetName(dir, a.hint?.name || urlName, ext, size?.w && size.w < 1600 ? "@1x" : "");
    write(a.rel, r.body);
    media[a.rel] = { ...(size ?? {}), bytes: r.body.length, kind: "image" };
    if (a.hint?.darkSrc) {
      const d = await download(new URL(a.hint.darkSrc, ORIGIN).href);
      const dtype = d ? (d.type.split(";")[0] || "").trim().toLowerCase() : "";
      if (d && (EXT[dtype] ?? ext) === ext) {
        const drel = a.rel.replace(/(\.[a-z0-9]+)$/i, ".dark$1");
        write(drel, d.body);
        media[drel] = { ...(imageSize(d.body) ?? {}), bytes: d.body.length, kind: "image" };
        count("dark image", "saved as <name>.dark.<ext>");
      } else missing.push({ page: a.page.gb, line: 0, src: a.hint.darkSrc, reason: "dark variant not saved (download failed or different format)" });
    }
  } else {
    const name = a.hint?.name || urlName || "file";
    const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "bin";
    a.rel = assetName(dir, name, ext);
    write(a.rel, r.body);
  }
  bytesTotal += r.body.length;
}
// A GIF that became a clip: a figure line becomes ::clip; inline uses keep the poster.
{
  const byToken = new Map([...assets.values()].map((a) => [a.token, a]));
  const av = (s) => unescapeMd(s).replace(/"/g, "'").replace(/[{}]/g, (c) => (c === "{" ? "(" : ")"));
  for (const p of live)
    p.out = p.out.replace(/^([ \t]*)!\[([^\]]*)\]\((@@ASSET\d+@@)(?: "([^"]*)")?\)[ \t]*$/gm, (m, ind, alt, tok, cap) => {
      const a = byToken.get(tok);
      if (!a?.clip) return m;
      count("animated GIF", `::clip (MP4 + WebP poster via ffmpeg)`);
      return `${ind}::clip{src="${a.clip}" alt="${av(alt)}"${cap ? ` caption="${av(cap)}"` : ""}}`;
    });
}
function write(rel, buf) {
  const f = path.join(PUBLIC, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, buf);
}
const tokenMap = new Map([...assets.values()].map((a) => [a.token, a.failed ? a.url : a.rel]));
const detok = (s) => s.replace(/@@ASSET\d+@@/g, (t) => tokenMap.get(t) ?? t);
for (const p of live) p.out = detok(p.out);

/* ── 5. descriptions, anchors ────────────────────────────────────────────── */
for (const p of live) {
  const d = p.gbDescription || p.llmsDesc;
  // GitBook shows the description under the title; the engine only uses it as metadata, so it
  // also stays in the page as the opening paragraph.
  if (p.gbDescription) p.out = `${p.gbDescription}\n\n${p.out}`;
  if (d && d.length <= 160) p.description = d;
  else if (d) {
    p.description = trimDescription(d);
    notes.push(`${p.gb}: description was ${d.length} chars; trimmed to ${p.description.length} for the frontmatter (the full text is the first paragraph)`);
  } else {
    p.description = trimDescription(firstParagraph(p.out) || `${p.title}.`);
    p.descriptionFromBody = true;
  }
  p.ids = headingIds(p.out);
}
const byOur = new Map(live.map((p) => [p.our, p]));
// GitBook ids: "id-" before a leading digit, "&" spelled "and", one dash per run of punctuation.
const anchorKey = (id) => looseId(String(id).replace(/^id-(?=\d)/, "")).replace(/and/g, "");
for (const p of live) {
  p.out = p.out.replace(/\]\((\/[^)\s#]*|)#([^)\s]+)\)/g, (m, target, hash) => {
    const t = target ? byOur.get(target.replace(/\/$/, "")) : p;
    if (!t) return m;
    if (t.ids.some((h) => h.id === hash)) return m;
    const loose = t.ids.find((h) => anchorKey(h.id) === anchorKey(hash));
    if (loose) {
      anchorFixes.push({ page: p.gb, href: `${target}#${hash}`, to: `${target}#${loose.id}` });
      return `](${target}#${loose.id})`;
    }
    broken.push({ page: p.gb, line: 0, href: `${target}#${hash}`, reason: "no such heading: link kept without the #anchor" });
    return target ? `](${target})` : m.replace(/#[^)\s]+/, "#");
  });
}
// Deep links into GitBook pages that now land on a different #id.
const idChanges = [];
for (const p of live) {
  const ours = p.ids.map((h) => h.id);
  for (const gid of p.gbIds) {
    if (ours.includes(gid) || /^undefined(-\d+)?$/.test(gid)) continue;
    const loose = p.ids.find((h) => anchorKey(h.id) === anchorKey(gid));
    idChanges.push({ page: p.our, from: gid, to: loose?.id ?? null });
  }
}

/* ── 6. site.json ────────────────────────────────────────────────────────── */
const GROUP_ICONS = [
  [/start|welcome|intro|overview|basics/i, "home"],
  [/integration|connector|plugin|app/i, "layers"],
  [/agent|ai\b|assistant|model/i, "sparkle"],
  [/workflow|process|automation/i, "listTree"],
  [/pipeline|candidate|search|filter/i, "filter"],
  [/output|report|analytic|insight|metric/i, "chart"],
  [/setting|admin|config|account/i, "settings"],
  [/api|sdk|developer|reference|code/i, "code"],
  [/security|privacy|compliance|governance/i, "shield"],
  [/help|faq|support|troubleshoot/i, "info"],
  [/release|changelog|update/i, "history"],
];
const groupIcon = (name) => GROUP_ICONS.find(([re]) => re.test(name))?.[1] ?? "doc";
const tabs = multiSection ? sections.map((s, si) => ({ id: slugify(s.title) || `section-${si + 1}`, label: s.title || `Section ${si + 1}`, href: byGb.get(s.pages[0].gb)?.our ?? "/" })) : [];
const nav = [];
const external = [];
for (const sb of sidebars) {
  external.push(...sb.external);
  let pendingUngrouped = [];
  for (const g of sb.groups) {
    const items = g.items.map((it) => byGb.get(it.gb)).filter((p) => p && !p.failed);
    const pathsOf = (list) => [...new Set(list.map((p) => p.our))];
    if (!g.group) {
      pendingUngrouped.push(...items);
      continue;
    }
    nav.push({ group: g.group, icon: groupIcon(g.group), ...(tabs.length ? { tab: tabs[sb.section]?.id } : {}), pages: pathsOf([...pendingUngrouped, ...items]) });
    if (pendingUngrouped.length) notes.push(`Top-level sidebar page(s) ${pendingUngrouped.map((p) => p.our).join(", ")} have no group in GitBook; they open the "${g.group}" group.`);
    pendingUngrouped = [];
  }
  if (pendingUngrouped.length) nav.push({ group: "More", icon: "doc", ...(tabs.length ? { tab: tabs[sb.section]?.id } : {}), pages: [...new Set(pendingUngrouped.map((p) => p.our))] });
}
// A page listed in two groups: keep the first.
{
  const seen = new Set();
  for (const g of nav) g.pages = g.pages.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
}

const root = byGb.get("/");
const brandName = brand.siteName.replace(/\s+(docs|documentation|help center|help|developer docs)$/i, "").trim() || brand.siteName;
const embedHosts = [...new Set(live.flatMap((p) => [...p.out.matchAll(/::embed\{src="https:\/\/([^/"]+)/g)].map((m) => m[1])))];

// Home: hero from the root page, start cards from its first card grid.
const start = [];
if (root?.out) {
  const grid = /::::cards\n([\s\S]*?)\n::::/.exec(root.out)?.[1] ?? "";
  for (const m of grid.matchAll(/:::card\[[^\]]*\]\{([^}]*)\}/g)) {
    const href = /href="(\/[^"#]*)"/.exec(m[1])?.[1];
    const icon = /icon="([^"]+)"/.exec(m[1])?.[1];
    if (href && byOur.has(href) && !start.some((s) => s.page === href)) start.push({ page: href, ...(icon ? { icon } : {}) });
  }
}
const intro = root?.out ? firstParagraph(root.out) : "";

// Brand assets.
const brandOut = { name: brandName, label: "Docs" };
async function brandAsset(url, stem) {
  if (!url) return null;
  const r = await download(url);
  if (!r) {
    missing.push({ page: "site.json", line: 0, src: url, reason: `brand ${stem} download failed` });
    return null;
  }
  const type = (r.type.split(";")[0] || "").trim().toLowerCase();
  const ext = EXT[type] ?? (type.includes("icon") ? "ico" : "png");
  const rel = `${ASSET_BASE}/brand/${stem}.${ext}`;
  write(rel, r.body);
  media[rel] = { ...(imageSize(r.body) ?? {}), bytes: r.body.length, kind: "image" };
  return rel;
}
const logoRel = await brandAsset(brand.logo, "logo");
const faviconRel = brand.favicon === brand.logo ? logoRel : await brandAsset(brand.favicon, "favicon");
if (logoRel) brandOut.logo = { light: logoRel, alt: brand.logoAlt || brandName, ...(brand.wordmark ? { wordmark: true } : {}) };
if (faviconRel) brandOut.favicon = faviconRel;
if (brand.accent) {
  brandOut.accent = brand.accent;
  brandOut.accentDark = lighten(brand.accent, 0.45);
  brandOut.og = { background: brand.tint && brand.tint !== brand.accent ? "#17131f" : "#111111", accent: lighten(brand.accent, 0.45) };
}

const site = {
  id: ID,
  name: brand.siteName,
  description: trimDescription(intro || root?.gbDescription || `Documentation for ${brandName}.`, 200),
  url: ORIGIN + BASE,
  ...(embedHosts.length ? { embedHosts } : {}),
  eyebrow: brand.siteName,
  headline: root?.gbDescription || root?.title || brand.siteName,
  tabs,
  home: {
    ...(start.length ? { start } : {}),
    askPlaceholder: `Search the ${brandName} docs`,
  },
  nav,
  footer: [{ label: "llms.txt", href: "/llms.txt" }],
  brand: brandOut,
  ai: { enabled: false },
  integrations: { markdropApp: false },
};

/* ── 7. write ────────────────────────────────────────────────────────────── */
// Empty the output (keep the cache), then write everything.
fs.mkdirSync(OUT, { recursive: true });
for (const e of fs.readdirSync(OUT)) if (e !== ".cache" && e !== "public") fs.rmSync(path.join(OUT, e), { recursive: true, force: true });

const yamlStr = (s) => (/^[\w(][^:#]*$/.test(s) && !/^(true|false|null|yes|no|on|off|~|\d[\d.]*)$/i.test(s) && !/[\s]$/.test(s) && !/[{}[\],&*!|>'"%@`]/.test(s[0]) ? s : JSON.stringify(s));
for (const p of live) {
  const fm = ["---", `title: ${yamlStr(p.title)}`];
  if (p.navTitle && p.navTitle !== p.title && p.navTitle.length <= 40) fm.push(`nav: ${yamlStr(p.navTitle)}`);
  else if (p.title.length > 40 && p.navTitle && p.navTitle.length <= 40) fm.push(`nav: ${yamlStr(p.navTitle)}`);
  fm.push(`description: ${yamlStr(p.description)}`, `updated: ${p.updated}`, "---", "");
  const f = path.join(OUT, p.file);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, fm.join("\n") + "\n" + p.out);
}
// index.md: the home's Markdown twin (the root page's content).
if (root?.out) {
  fs.writeFileSync(path.join(OUT, "index.md"), ["---", `title: ${yamlStr(brand.siteName)}`, `description: ${yamlStr(trimDescription(root.gbDescription || site.description))}`, `updated: ${TODAY}`, "---", "", root.out].join("\n"));
}
fs.writeFileSync(path.join(OUT, "site.json"), JSON.stringify(site, null, 2) + "\n");
fs.writeFileSync(path.join(OUT, "media.json"), JSON.stringify(Object.fromEntries(Object.entries(media).sort()), null, 2) + "\n");
if (Object.keys(videos).length) fs.writeFileSync(path.join(OUT, "videos.json"), JSON.stringify(videos, null, 2) + "\n");

const redirects = [];
for (const p of pages) {
  // GitBook's root page is the site's "/": it stays "/" (the home); its content is also at p.our.
  const to = p.failed ? null : p.gb === "/" ? "/" : p.our;
  redirects.push({ from: p.gb, to, ...(p.gb === to ? { same: true } : {}) });
  if (p.gb !== "/" && to) redirects.push({ from: `${p.gb}.md`, to: `${to}.md`, ...(p.gb === to ? { same: true } : {}) });
}
redirects.push({ from: "/readme.md", to: "/index.md" });
for (const [from, to] of moved) redirects.push({ from, to: byGb.get(to).our, via: "GitBook redirect (found through a link)" });
fs.writeFileSync(path.join(OUT, "redirects.json"), JSON.stringify({ source: ORIGIN + BASE, generated: TODAY, status: 301, note: "every GitBook path → its Markdrop path; same:true means the path is unchanged", redirects }, null, 2) + "\n");

// Remove assets from earlier runs that this run didn't write.
{
  const keep = new Set([...Object.keys(media), ...[...assets.values()].filter((a) => a.rel).map((a) => a.rel)]);
  const walk = (d) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (!keep.has("/" + path.relative(PUBLIC, f).split(path.sep).join("/"))) fs.rmSync(f);
    }
  };
  walk(path.join(PUBLIC, "docs-assets", ID));
}

/* ── 8. report ───────────────────────────────────────────────────────────── */
const hidden = live.filter((p) => !p.inNav);
const fmtLine = (x) => `\`${x.page}\`${x.line ? `:${x.line}` : ""}`;
const R = [];
R.push(`# Import report: ${brand.siteName}`, "");
R.push(`Source: ${ORIGIN + BASE} (GitBook), imported ${TODAY} by scripts/docs-import/gitbook.mjs into \`${OUT}\`. Line numbers refer to the page's GitBook Markdown (\`<page>.md\`).`, "");
R.push("## Summary", "");
R.push(`| | |`, `| --- | --- |`);
R.push(`| Pages | ${live.length} imported${pages.length - live.length ? `, ${pages.length - live.length} failed` : ""} (${live.filter((p) => p.inNav).length} in the sidebar, ${hidden.length} hidden in GitBook) |`);
R.push(`| Nav | ${nav.length} groups${tabs.length ? `, ${tabs.length} tabs` : ", no tabs (one GitBook section)"} |`);
R.push(`| Assets | ${[...assets.values()].filter((a) => a.kind === "image" && !a.failed).length} images, ${[...assets.values()].filter((a) => a.kind === "file" && !a.failed).length} files, ${(bytesTotal / 1024 / 1024).toFixed(1)} MB, in public${ASSET_BASE}/ |`);
if (gifStats.n) R.push(`| Animated GIFs | ${gifStats.n} converted to clips (MP4 + poster): ${(gifStats.before / 1048576).toFixed(0)} MB → ${(gifStats.after / 1048576).toFixed(1)} MB |`);
else if (!FFMPEG) R.push(`| Animated GIFs | kept as GIFs (${args["keep-gifs"] ? "--keep-gifs" : "no ffmpeg on PATH"}) |`);
R.push(`| Descriptions | ${live.filter((p) => !p.descriptionFromBody).length} from GitBook, ${live.filter((p) => p.descriptionFromBody).length} from the first paragraph |`);
R.push(`| Problems | ${issues.length} conversion notes, ${broken.length} broken links, ${missing.length} missing images/files, ${altGenerated.length} generated alt texts |`);
R.push(`| HTTP | ${http.stats.network} network requests, ${http.stats.cached} from cache, ${http.stats.failed} failed |`, "");
R.push("## How the content was read", "");
R.push("- `llms.txt` for the page list (all pages, hidden ones included) and page descriptions.");
R.push("- The site's HTML for the sidebar (groups, order, labels), the site name, logo, favicon and accent colour.");
R.push("- `<page>.md` (GitBook's Markdown export) for each page's content; the page HTML for heading ids and file downloads.", "");
R.push("## Blocks found and how they were converted", "");
R.push("| Block | Count | Converted to |", "| --- | ---: | --- |");
for (const [kind, hows] of [...counts.entries()].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0)))
  for (const [how, n] of hows) R.push(`| \`${kind.replace(/\|/g, "\\|")}\` | ${n} | ${how} |`);
R.push("");
R.push("## Brand detected", "");
R.push(`- Name: ${brand.siteName} (brand.name "${brandName}")`);
R.push(`- Logo: ${brand.logo ? `${brand.logo} → ${logoRel ?? "not saved"}${brand.wordmark ? " (wordmark)" : ""}` : "none found"}`);
R.push(`- Favicon: ${brand.favicon ? `${brand.favicon} → ${faviconRel ?? "not saved"}` : "none found"}`);
R.push(`- Accent: ${brand.accent ?? "not found"}${brand.accent ? ` (GitBook --primary-original); accentDark ${brandOut.accentDark} is derived, not read` : ""}`);
R.push(`- GitBook theme classes: \`${brand.themeClass.split(/\s+/).filter((c) => /theme|tint|corners|sidebar|font/.test(c)).join(" ")}\` (not carried over)`, "");
const section = (title, rows, render, empty = "None.") => {
  R.push(`## ${title}`, "");
  if (!rows.length) R.push(empty);
  else for (const r of rows) R.push(render(r));
  R.push("");
};
section("Unconverted or lossy (check these)", issues, (x) => `- ${fmtLine(x)} **${x.kind}**: ${x.msg}`);
section("Broken links", broken, (x) => `- ${fmtLine(x)} \`${x.href}\`: ${x.reason}`);
section("Missing images and files", missing, (x) => `- ${fmtLine(x)} ${x.src}: ${x.reason}`);
section("Alt text written by the importer (GitBook had none; please describe these)", altGenerated, (x) => `- ${fmtLine(x)} “${x.alt}”`);
section("Hidden pages (in llms.txt, not in the sidebar; imported, left out of the nav)", hidden, (p) => `- \`${p.our}\` ${p.title}`);
section("Sidebar links that aren't pages (not imported)", external, (x) => `- [${x.title}](${x.href})`);
section("Links to moved pages (GitBook redirects them; rewritten, and added to redirects.json)", [...moved], ([from, to]) => `- \`${from}\` → \`${byGb.get(to).our}\``);
section("#anchor links rewritten to the engine's heading ids", anchorFixes, (x) => `- \`${x.page}\` ${x.href} → ${x.to}`);
R.push("## Heading ids that changed (deep links from outside)", "");
R.push(`${idChanges.length} GitBook heading ids differ from the engine's ids (GitBook collapses repeated dashes; the engine keeps one per removed character). A link like \`/page#id\` from elsewhere lands on the page but not the heading:`, "");
for (const c of idChanges.slice(0, 60)) R.push(`- \`${c.page}#${c.from}\` → ${c.to ? `\`#${c.to}\`` : "no matching heading"}`);
if (idChanges.length > 60) R.push(`- … and ${idChanges.length - 60} more`);
R.push("");
section("Other notes", notes, (n) => `- ${n}`);
R.push("## Redirects", "");
R.push(`redirects.json maps all ${pages.length} GitBook paths (and their .md twins). ${redirects.filter((r) => r.to && !r.same).length} change; the rest keep their path, so pointing ${SITE.hostname} at the new site keeps every old URL working once those few redirects are served.`, "");
R.push("## Assets", "");
R.push(`The engine serves /docs-assets/ from the app's public/ folder. This site's files are in \`${PUBLIC}${ASSET_BASE}/\`; copy or link that folder to \`frontend/public${ASSET_BASE}/\` to render it (docs:check reads them from \`${PUBLIC}\` when DOCS_CONTENT_DIR is set).`, "");
fs.writeFileSync(path.join(OUT, "_IMPORT_REPORT.md"), R.join("\n"));

log(`done: ${live.length} pages, ${assets.size} assets, ${issues.length} notes, ${broken.length} broken links, ${missing.length} missing → ${path.join(OUT, "_IMPORT_REPORT.md")}`);
log(`HTTP: ${http.stats.network} network, ${http.stats.cached} cached, ${http.stats.failed} failed`);
