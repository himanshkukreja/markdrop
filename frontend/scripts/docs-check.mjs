#!/usr/bin/env node
/**
 * docs:check — validates the docs content folder the way the engine reads it.
 *
 *   npm run docs:check                 # everything
 *   npm run docs:check -- workspaces   # only report problems in files under these sections
 *   npm run docs:check -- --strict     # warnings fail too
 *
 * Checks: frontmatter (required fields, lengths, dates, nav label), nav ↔ page consistency
 * (listed but not written, written but not listed), internal links and #anchors (to pages,
 * prerequisites, card hrefs, changelog docs), directive names / attributes / balance, card icons,
 * tabs structure, one video slot per page, headings (no H1, unique ids), changelog.json and
 * videos.json, and media (see "media" below). Errors exit 1; warnings (pages not written yet,
 * orphans) don't, unless --strict.
 *
 * Media (files under public/docs-assets, sizes in content/docs/media.json):
 *   error  a referenced file is missing from public/ or from media.json (npm run docs:media-manifest)
 *   error  an image or clip has no alt text, or alt text that reads like a file name
 *   error  a clip has no .mp4 or no poster (<src>.webp); theme="both" without the .dark files
 *   error  videos.json: bad shape, missing files, bad duration, chapters/captions that aren't WebVTT
 *   warn   a UI screenshot without a .dark variant (names starting diagram-, photo-, art- or logo-
 *          are not UI screenshots), over budget (image 220 KB, clip 1.6 MB, video 25 MB), a clip
 *          without .webm, a file in docs-assets nothing uses, a stale media.json entry
 *
 * Heading slugs mirror src/components/reading/slug.ts (createSlugger + inlineText); keep in step.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { buildApiReference } from "../src/docs/openapi.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT = process.env.DOCS_CONTENT_DIR || path.join(ROOT, "content", "docs");
const args = process.argv.slice(2);
const STRICT = args.includes("--strict");
const ONLY = args.filter((a) => !a.startsWith("--")).map((a) => a.replace(/^\/+|\/+$/g, ""));

const CONTAINERS = new Set(["note", "tip", "warning", "danger", "steps", "tabs", "tab", "cards", "card", "details"]);
const LEAVES = new Set(["video", "clip", "embed"]);
const TEXTS = new Set(["kbd"]);
const SYNC = new Set(["os", "lang", "dns"]);
const KINDS = new Set(["new", "improved", "fixed"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FIXED_ROUTES = new Set(["/", "/changelog", "/llms.txt", "/llms-full.txt", "/skill.md", "/changelog.rss", "/changelog.json", "/changelog.md", "/sitemap.xml", "/robots.txt", "/index.md"]);

/* ── output ──────────────────────────────────────────────────────────────── */
const problems = [];
function report(level, file, msg, line) {
  problems.push({ level, file, msg, line });
}
const err = (f, m, l) => report("error", f, m, l);
const warn = (f, m, l) => report("warn", f, m, l);

/* ── slugs (mirror of reading/slug.ts) ───────────────────────────────────── */
function slugify(text) {
  return text.replace(/\s+/g, " ").trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
}
function createSlugger() {
  const seen = new Map();
  return (text) => {
    const base = slugify(text) || "section";
    let slug = base;
    while (seen.has(slug)) {
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      slug = `${base}-${n}`;
    }
    seen.set(slug, 0);
    return slug;
  };
}
function inlineText(src) {
  const keep = [];
  const stash = (s) => `\u0000${keep.push(s) - 1}\u0001`;
  let s = src
    .replace(/\\([!-/:-@[-`{-~])/g, (_, c) => stash(c))
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, c) => stash(c.replace(/^ (.*) $/, "$1")))
    .replace(/(\${1,2})([^$]+?)\1/g, (_, _d, c) => stash(c));
  s = s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/\*(?=\S)([\s\S]*?\S)\*/g, "$1")
    .replace(/(^|[^\p{L}\p{N}])_(?=\S)([\s\S]*?\S)_(?![\p{L}\p{N}])/gu, "$1$2")
    .replace(/~~?(?=\S)([\s\S]*?\S)~~?/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
  s = s.replace(/\u0000(\d+)\u0001/g, (_, i) => keep[+i] ?? "");
  return s.replace(/\s+/g, " ").trim();
}
const headingText = (line) => inlineText(line.replace(/^\s{0,3}#{1,6}(?=\s|$)/, "").replace(/(?:^|\s+)#+\s*$/, ""));

/* ── helpers ─────────────────────────────────────────────────────────────── */
function readJson(file, fallback) {
  const p = path.join(CONTENT, file);
  if (!fs.existsSync(p)) return { value: fallback, missing: true };
  try {
    return { value: JSON.parse(fs.readFileSync(p, "utf8")) };
  } catch (e) {
    err(file, `invalid JSON: ${e.message}`);
    return { value: fallback };
  }
}
function walk(dir, rel = "") {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name.startsWith("_")) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name !== "video-scenes" && e.name !== "node_modules") out = out.concat(walk(path.join(dir, e.name), r));
    } else if (e.name.endsWith(".md")) out.push(r);
  }
  return out;
}
const toPath = (file) => "/" + file.replace(/\.md$/, "").replace(/\/index$/, "");
function parseAttrs(src) {
  const out = {};
  if (!src) return out;
  const re = /([A-Za-z_][\w-]*)(?:=(?:"([^"]*)"|'([^']*)'|([^\s"']+)))?|#([\w-]+)|\.([\w-]+)/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[5]) out.id = m[5];
    else if (m[1]) out[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}
function iconNames() {
  try {
    const src = fs.readFileSync(path.join(ROOT, "src/components/ui/icons.ts"), "utf8");
    return new Set([...src.matchAll(/^\s{2}([A-Za-z][\w]*):\s*"/gm)].map((m) => m[1]));
  } catch {
    return null;
  }
}
const ICONS = iconNames();

function unquote(v) {
  const t = v.trim();
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
}
function looseFrontmatter(block) {
  const out = {};
  for (const line of block.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].trim();
    out[m[1]] = /^\[.*\]$/.test(v) ? v.slice(1, -1).split(",").map(unquote).filter(Boolean) : unquote(v);
  }
  return out;
}

/* ── load ────────────────────────────────────────────────────────────────── */
if (!fs.existsSync(CONTENT)) {
  console.error(`docs:check: content folder not found: ${CONTENT}`);
  process.exit(1);
}
const site = readJson("site.json", {}).value;
const changelog = readJson("changelog.json", { entries: [] });
const videos = readJson("videos.json", {}).value;
const mediaJson = readJson("media.json", {});
const media = mediaJson.value && typeof mediaJson.value === "object" && !Array.isArray(mediaJson.value) ? mediaJson.value : {};
const mediaRefs = []; // { file, line, type: image | clip, src, alt, theme }
const videoIds = new Set();

const files = walk(CONTENT);
const pages = new Map(); // path → { file, fm, body, lines, ids:Set, links:[] }
for (const file of files) {
  const src = fs.readFileSync(path.join(CONTENT, file), "utf8").replace(/^\uFEFF/, "");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  let fm = {};
  let body = src;
  let offset = 0;
  if (!m) err(file, "missing frontmatter (a --- block at the very top)", 1);
  else {
    offset = m[0].split("\n").length - 1;
    body = src.slice(m[0].length);
    try {
      const v = parseYaml(m[1]);
      if (v && typeof v === "object" && !Array.isArray(v)) fm = v;
      else err(file, "frontmatter is not a key: value map", 1);
    } catch (e) {
      // The engine falls back to reading `key: value` lines, so this builds; it's still worth fixing.
      fm = looseFrontmatter(m[1]);
      warn(file, `frontmatter isn't valid YAML (the site reads it leniently): ${String(e.message).split("\n")[0]}. Quote values that contain ": ".`, 1);
    }
  }
  pages.set(toPath(file), { file, fm, body, lines: body.split(/\r?\n/), offset, ids: new Set(), links: [] });
}

/* ── generated API reference (site.json `openapi`) ───────────────────────── */
// Built with the engine's own generator, then checked below exactly like a written page: links
// (including the overlay's prose and guide links), anchors, directives, headings, frontmatter.
const apiPaths = new Map(); // path → nav group title
if (site.openapi?.spec) {
  const cfg = site.openapi;
  const spec = readJson(cfg.spec, null);
  const overlay = cfg.overlay ? readJson(cfg.overlay, {}).value : {};
  if (spec.missing || !spec.value) err("site.json", `openapi.spec ${cfg.spec} is missing: run npm run docs:openapi`);
  else {
    let ref = null;
    try {
      ref = buildApiReference(spec.value, overlay, { server: cfg.server, base: cfg.base });
    } catch (e) {
      err(cfg.overlay || cfg.spec, `the API reference doesn't build: ${e.message}`);
    }
    if (ref) {
      if (cfg.tab && !(site.tabs ?? []).some((t) => t.id === cfg.tab)) err("site.json", `openapi.tab "${cfg.tab}" isn't in tabs`);
      for (const msg of ref.problems) (/no title|no group/.test(msg) ? warn : err)(cfg.overlay || cfg.spec, msg);
      const updated = spec.value.info?.["x-markdrop-exported"];
      if (!updated) err(cfg.spec, "no info.x-markdrop-exported date: refresh it with npm run docs:openapi");
      for (const op of ref.ops) {
        if (pages.has(op.path)) {
          warn(pages.get(op.path).file, `${op.path} is also generated for ${op.key}; the written page wins`);
          continue;
        }
        if (!op.description) warn(cfg.overlay || cfg.spec, `${op.key}: no description (add one to the overlay, or a docstring)`);
        const fm = { title: op.title, description: op.summary, updated, keywords: op.keywords };
        pages.set(op.path, { file: `${cfg.spec} → ${op.path}`, fm, body: op.markdown, lines: op.markdown.split(/\r?\n/), offset: 0, ids: new Set(), links: [], generated: true });
        apiPaths.set(op.path, op.group.title);
      }
    }
  }
}

/* ── per-page checks ─────────────────────────────────────────────────────── */
const asDate = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? undefined : String(v));
for (const [p, pg] of pages) {
  const { file, fm } = pg;
  const isHome = file === "index.md";
  const ln = (i) => i + pg.offset + 1;
  const title = fm.title == null ? "" : String(fm.title).trim();
  const desc = fm.description == null ? "" : String(fm.description).trim();
  if (!title) err(file, "frontmatter: title is required", 1);
  else if (/^[a-z]/.test(title)) warn(file, `title should start with a capital letter: "${title}"`, 1);
  if (!desc) err(file, "frontmatter: description is required", 1);
  else if (desc.length > 160) err(file, `frontmatter: description is ${desc.length} chars (max 160)`, 1);
  const updated = asDate(fm.updated);
  if (!updated) err(file, "frontmatter: updated is required (YYYY-MM-DD)", 1);
  else if (!DATE.test(updated)) err(file, `frontmatter: updated "${updated}" is not YYYY-MM-DD`, 1);
  const checked = asDate(fm.checked);
  if (checked && !DATE.test(checked)) err(file, `frontmatter: checked "${checked}" is not YYYY-MM-DD`, 1);
  if (fm.nav != null) {
    const nav = String(fm.nav).trim();
    if (!nav) err(file, "frontmatter: nav is empty", 1);
    else if (nav.length > 40) err(file, `frontmatter: nav is ${nav.length} chars (max 40)`, 1);
  }
  if (fm.prerequisites != null && !Array.isArray(fm.prerequisites)) err(file, "frontmatter: prerequisites must be a list like [/a/b, /c/d]", 1);
  for (const pre of Array.isArray(fm.prerequisites) ? fm.prerequisites : []) pg.links.push({ href: String(pre), line: 1, what: "prerequisite" });
  if (fm.keywords != null && !Array.isArray(fm.keywords)) err(file, "frontmatter: keywords must be a list like [a, b]", 1);
  const known = new Set(["title", "description", "updated", "checked", "prerequisites", "since", "keywords", "nav"]);
  for (const k of Object.keys(fm)) if (!known.has(k)) warn(file, `frontmatter: unknown field "${k}" (ignored)`, 1);

  // Body scan
  const slug = createSlugger();
  const stack = []; // { name, colons, line, children:[] }
  let fence = null;
  let math = false;
  let videos = 0;
  pg.lines.forEach((raw, i) => {
    const line = raw.replace(/^\s{0,3}(?:>\s?)+/, "");
    if (fence) {
      const c = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (c && c[1][0] === fence.ch && c[1].length >= fence.len) fence = null;
      return;
    }
    if (math) {
      if (/^\s{0,3}\$\$\s*$/.test(line)) math = false;
      return;
    }
    const open = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { ch: open[1][0], len: open[1].length, line: i };
      const meta = open[2].trim();
      if (meta && /\{/.test(meta) && !/\{[\d,\s-]+\}/.test(meta)) warn(file, `code fence meta "${meta}": line highlights look like {2,4-5}`, ln(i));
      return;
    }
    if (/^\s{0,3}\$\$(?!.*\$\$)/.test(line)) {
      math = true;
      return;
    }
    // Headings
    const h = /^\s{0,3}(#{1,6})(?:\s|$)/.exec(line);
    if (h) {
      const depth = h[1].length;
      if (depth === 1 && !isHome) err(file, "don't repeat the title as an H1; start sections at ##", ln(i));
      const text = headingText(line);
      if (!text) err(file, "empty heading", ln(i));
      if (depth <= 4) {
        const id = slug(text);
        if (/-\d+$/.test(id) && pg.ids.has(id.replace(/-\d+$/, ""))) warn(file, `duplicate heading "${text}" (its anchor becomes #${id})`, ln(i));
        pg.ids.add(id);
      }
      if (stack.length && stack[stack.length - 1].name === "steps") stack[stack.length - 1].steps++;
    }
    // Container directives
    const c = /^\s*(:{3,})([A-Za-z][\w-]*)(?:\[([^\]]*)\])?(?:\{([^}]*)\})?\s*$/.exec(raw);
    if (c) {
      const [, colons, name, label, attrs] = c;
      const a = parseAttrs(attrs);
      if (!CONTAINERS.has(name)) err(file, `unknown directive :::${name} (known: ${[...CONTAINERS].join(", ")})`, ln(i));
      const parent = stack[stack.length - 1];
      if (parent && colons.length >= parent.colons) err(file, `:::${name} is inside :::${parent.name} (line ${ln(parent.line)}) but uses ${colons.length} colons; the outer one needs more colons than the inner`, ln(i));
      if (name === "tab" && parent?.name !== "tabs") err(file, ":::tab must be inside ::::tabs", ln(i));
      if (name === "card" && parent?.name !== "cards") warn(file, ":::card is usually inside ::::cards", ln(i));
      if (name === "tabs" && a.sync && !SYNC.has(a.sync)) warn(file, `tabs sync="${a.sync}" is not one of ${[...SYNC].join(", ")}`, ln(i));
      if (name === "tab" && !label) err(file, ":::tab needs a label, like :::tab[macOS]", ln(i));
      if (name === "details" && !label) err(file, ":::details needs the question as its label, like :::details[Why?]", ln(i));
      if (name === "card") {
        if (!label) err(file, ":::card needs a title, like :::card[Title]{href=\"/a/b\"}", ln(i));
        if (a.href) pg.links.push({ href: a.href, line: ln(i), what: "card href" });
        if (a.icon && ICONS && !ICONS.has(a.icon)) err(file, `card icon "${a.icon}" is not a design-system icon`, ln(i));
      }
      if (parent) parent.children.push(name);
      stack.push({ name, colons: colons.length, line: i, children: [], steps: 0 });
      return;
    }
    if (/^\s*:{3,}\s*$/.test(raw)) {
      const top = stack.pop();
      if (!top) err(file, "closing ::: without an opening directive", ln(i));
      else {
        const closeLen = raw.trim().length;
        if (closeLen !== top.colons) warn(file, `:::${top.name} opened with ${top.colons} colons (line ${ln(top.line)}) but closed with ${closeLen}`, ln(i));
        if (top.name === "tabs" && !top.children.length) err(file, "::::tabs has no :::tab children", ln(top.line));
        if (top.name === "cards" && !top.children.length) err(file, "::::cards has no :::card children", ln(top.line));
        if (top.name === "steps" && !top.steps) err(file, "::::steps has no ### step headings", ln(top.line));
      }
      return;
    }
    // Leaf directives
    const leaf = /^\s*::([A-Za-z][\w-]*)(?:\[([^\]]*)\])?(?:\{([^}]*)\})?\s*$/.exec(raw);
    if (leaf) {
      const [, name, , attrs] = leaf;
      const a = parseAttrs(attrs);
      if (!LEAVES.has(name)) err(file, `unknown directive ::${name} (known: ${[...LEAVES].join(", ")})`, ln(i));
      if (name === "clip") mediaRefs.push({ file, line: ln(i), type: "clip", src: a.src, alt: a.alt, theme: a.theme });
      if (name === "video") {
        videos++;
        if (a.id) videoIds.add(a.id);
        if (!a.id) err(file, "::video needs an id, like ::video{id=\"publish-first-document\" title=\"…\"}", ln(i));
        else if (!/^[a-z0-9][a-z0-9-]*$/.test(a.id)) err(file, `video id "${a.id}" should be lowercase-with-dashes`, ln(i));
        if (!a.title) warn(file, "::video should have a title", ln(i));
      }
      if (name === "embed" && !/^https:\/\//.test(a.src ?? "")) err(file, "::embed needs src=\"https://…\"", ln(i));
      return;
    }
    if (/^\s*::[A-Za-z]/.test(raw)) err(file, `malformed directive: ${raw.trim()}`, ln(i));
    // Text directives (outside inline code)
    const prose = line.replace(/`[^`]*`/g, "");
    for (const t of prose.matchAll(/(^|[^\w:\\/])(:+)([A-Za-z][\w-]*)\[/g)) {
      if (t[2].length !== 1) continue;
      if (!TEXTS.has(t[3])) err(file, `unknown text directive :${t[3]}[…] (known: ${[...TEXTS].join(", ")})`, ln(i));
    }
    // Images
    for (const im of prose.matchAll(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)/g)) mediaRefs.push({ file, line: ln(i), type: "image", src: im[2], alt: im[1] });
    // Links
    for (const l of prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) pg.links.push({ href: l[1], line: ln(i), what: "link" });
    if (/\]\(\.{0,2}\/?[a-z][\w-]*\/[\w-]+\.md\)/.test(prose)) warn(file, "link to a .md file: use the page address (/section/page)", ln(i));
  });
  if (fence) err(file, "code fence is never closed", ln(fence.line));
  for (const s of stack) err(file, `:::${s.name} is never closed`, ln(s.line));
  if (videos > 1) warn(file, `${videos} ::video slots (at most 1 per page)`);
}

/* ── nav ↔ pages ─────────────────────────────────────────────────────────── */
const listed = new Map();
const tabIds = new Set((site.tabs ?? []).map((t) => t.id));
const missing = [];
for (const g of site.nav ?? []) {
  if (g.tab && !tabIds.has(g.tab)) err("site.json", `nav group "${g.group}" uses tab "${g.tab}", which isn't in tabs`);
  if (g.icon && ICONS && !ICONS.has(g.icon)) err("site.json", `nav group "${g.group}" icon "${g.icon}" is not a design-system icon`);
  for (const p of g.pages ?? []) {
    if (listed.has(p)) err("site.json", `${p} is listed twice (in "${listed.get(p)}" and "${g.group}")`);
    listed.set(p, g.group);
    if (!pages.has(p)) missing.push({ p, g: g.group });
  }
}
for (const s of site.home?.start ?? []) if (!listed.has(s.page)) warn("site.json", `home.start page ${s.page} is not in the nav`);
for (const a of site.home?.areas ?? []) if (!(site.nav ?? []).some((g) => g.group === a)) err("site.json", `home.areas "${a}" is not a nav group`);
for (const [p, g] of apiPaths) if (!listed.has(p)) listed.set(p, g);
for (const [p, pg] of pages) if (pg.file !== "index.md" && !listed.has(p)) warn(pg.file, `${p} is not in site.json nav (it builds, but nobody can find it)`);

/* ── links ───────────────────────────────────────────────────────────────── */
const entryIds = new Set((changelog.value.entries ?? []).map((e) => e.id));
function checkLink(file, href, line, what) {
  if (!href.startsWith("/") || href.startsWith("//")) {
    const own = /^https?:\/\/docs\.markdrop\.in(\/[^#?]*)?/.exec(href);
    if (own && !FIXED_ROUTES.has(own[1] || "/") && !/\.(md|txt|xml|rss|json)$/.test(own[1] || "")) warn(file, `${what} ${href}: link to docs pages with a path (/section/page)`, line);
    return;
  }
  const [p0, hash] = href.split("#");
  const p = p0.replace(/\/+$/, "") || "/";
  if (FIXED_ROUTES.has(p) || p.startsWith("/docs-assets/")) return;
  if (p.startsWith("/changelog/")) {
    if (!entryIds.has(p.slice(11))) err(file, `${what} ${href}: no changelog entry "${p.slice(11)}"`, line);
    return;
  }
  const target = pages.get(p.replace(/\.md$/, ""));
  if (!target) {
    if (listed.has(p)) warn(file, `${what} ${href}: page not written yet`, line);
    else err(file, `${what} ${href}: no such page`, line);
    return;
  }
  if (hash && !target.ids.has(hash)) err(file, `${what} ${href}: no heading #${hash} on ${p} (has: ${[...target.ids].slice(0, 8).join(", ")}${target.ids.size > 8 ? ", …" : ""})`, line);
}
// The app's links into the docs: DOCS_PAGES (src/lib/docsLinks.ts) and docsUrl("/…") calls.
{
  const SRC = new URL("../src/", import.meta.url).pathname;
  const files = [];
  const scan = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "docs" && e.name !== "docs-site") scan(f); }
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(f);
    }
  };
  scan(SRC);
  for (const f of files) {
    const rel = path.relative(path.join(SRC, ".."), f);
    const text = fs.readFileSync(f, "utf8");
    const isMap = rel.endsWith(path.join("lib", "docsLinks.ts"));
    text.split("\n").forEach((l, i) => {
      for (const m of l.matchAll(/docsUrl\("([^"]+)"\)/g)) checkLink(rel, m[1], i + 1, "app link");
      if (isMap) for (const m of l.matchAll(/^\s+\w+:\s*"(\/[^"]*)"/g)) checkLink(rel, m[1], i + 1, "app link");
    });
  }
}
for (const [, pg] of pages) for (const l of pg.links) {
  if (l.href.startsWith("#")) {
    if (l.href.length > 1 && !pg.ids.has(l.href.slice(1))) err(pg.file, `link ${l.href}: no such heading on this page`, l.line);
  } else checkLink(pg.file, l.href, l.line, l.what);
}

/* ── changelog.json ──────────────────────────────────────────────────────── */
if (!changelog.missing) {
  const cl = changelog.value;
  const products = new Set((cl.products ?? []).map((x) => x.id));
  const seen = new Set();
  if (!Array.isArray(cl.entries)) err("changelog.json", "entries must be a list");
  (cl.entries ?? []).forEach((e, i) => {
    const where = `entries[${i}]${e?.id ? ` (${e.id})` : ""}`;
    if (!e || typeof e !== "object") return err("changelog.json", `${where}: not an object`);
    if (!e.id || !/^[a-z0-9][a-z0-9-]*$/.test(e.id)) err("changelog.json", `${where}: id must be lowercase-with-dashes`);
    if (seen.has(e.id)) err("changelog.json", `${where}: duplicate id`);
    seen.add(e.id);
    if (!DATE.test(e.date ?? "")) err("changelog.json", `${where}: date must be YYYY-MM-DD`);
    if (!e.title) err("changelog.json", `${where}: title is required`);
    if (!KINDS.has(e.kind)) err("changelog.json", `${where}: kind must be new, improved or fixed`);
    if (!e.area) err("changelog.json", `${where}: area is required`);
    if (!e.summary) err("changelog.json", `${where}: summary is required`);
    for (const p of e.products ?? []) if (!products.has(p)) err("changelog.json", `${where}: product "${p}" isn't in products`);
    for (const k of Object.keys(e.versions ?? {})) if (!products.has(k)) err("changelog.json", `${where}: versions.${k} isn't a product`);
    for (const d of e.docs ?? []) checkLink("changelog.json", d, undefined, `${where} docs`);
    if (e.try && (!e.try.label || !e.try.href)) err("changelog.json", `${where}: try needs label and href`);
    if (e.media?.video && !/^[a-z0-9][a-z0-9-]*$/.test(e.media.video)) err("changelog.json", `${where}: media.video must be a video id`);
    if (e.media?.image && !e.media.alt) warn("changelog.json", `${where}: media.image needs alt text`);
    if (e.body && /^\s*#\s/m.test(e.body)) warn("changelog.json", `${where}: body shouldn't contain an H1`);
  });
}

/* ── media ───────────────────────────────────────────────────────────────── */
const PUBLIC = path.join(ROOT, "public");
const ASSETS_DIR = path.join(PUBLIC, "docs-assets");
const KB = 1024;
const BUDGET = { image: 220 * KB, poster: 220 * KB, clip: 1.6 * KB * KB, video: 25 * KB * KB };
const usedAssets = new Set();
const exists = (rel) => {
  try {
    return fs.statSync(path.join(PUBLIC, rel)).isFile();
  } catch {
    return false;
  }
};
const darkOf = (p) => (/\.[a-z0-9]+$/i.test(p) ? p.replace(/(\.[a-z0-9]+)$/i, ".dark$1") : `${p}.dark`);
const isDark = (p) => /\.dark(\.[a-z0-9]+)?$/i.test(p);
const fmtBytes = (n) => (n >= KB * KB ? `${(n / KB / KB).toFixed(2)} MB` : `${Math.round(n / KB)} KB`);
/** "IMG_2041", "settings-page.webp", "screenshot 3": a file name, not a description. */
function filenameLike(alt) {
  const t = alt.trim();
  return /\.(webp|png|jpe?g|gif|svg|avif|mp4|webm)$/i.test(t) || (/^[\w.@-]+$/.test(t) && /[-_]/.test(t)) || /^(image|img|screenshot|screen ?shot|picture|photo|clip|video|gif|untitled|alt)\s*\d*$/i.test(t);
}
function checkAlt(r, what) {
  const alt = (r.alt ?? "").trim();
  if (!alt) err(r.file, `${what} ${r.src}: alt text is required (what it shows and why it matters)`, r.line);
  else if (filenameLike(alt)) err(r.file, `${what} ${r.src}: alt "${alt}" reads like a file name; describe what it shows`, r.line);
}
const budgetWarned = new Set();
/** A file the docs use: in public/, in media.json, within budget. Returns false when missing. */
function checkAsset(file, line, rel, budget, what = "") {
  usedAssets.add(rel);
  if (!exists(rel)) {
    err(file, `${what}${rel} doesn't exist in public/`, line);
    return false;
  }
  const m = media[rel];
  if (!m) err(file, `${what}${rel} isn't in media.json: run npm run docs:media-manifest`, line);
  const bytes = m?.bytes ?? fs.statSync(path.join(PUBLIC, rel)).size;
  if (budget && bytes > BUDGET[budget] && !budgetWarned.has(rel)) {
    budgetWarned.add(rel);
    warn(file, `${what}${rel} is ${fmtBytes(bytes)} (budget for ${budget === "image" ? "an" : "a"} ${budget}: ${fmtBytes(BUDGET[budget])})`, line);
  }
  return true;
}
const NOT_UI = /^(diagram|photo|art|logo)-/;

for (const r of mediaRefs) {
  if (r.type === "image") {
    checkAlt(r, "image");
    if (/^https?:\/\//.test(r.src)) {
      warn(r.file, `image ${r.src}: keep docs images under /docs-assets/ (an external image can move, change or track readers)`, r.line);
      continue;
    }
    if (!r.src.startsWith("/docs-assets/")) {
      err(r.file, `image ${r.src}: images live under /docs-assets/<page>/ in frontend/public`, r.line);
      continue;
    }
    if (isDark(r.src)) warn(r.file, `image ${r.src}: reference the light file; its .dark variant is picked up automatically`, r.line);
    if (!checkAsset(r.file, r.line, r.src, "image", "image ")) continue;
    const dark = darkOf(r.src);
    if (exists(dark)) checkAsset(r.file, r.line, dark, "image", "dark variant ");
    else if (!isDark(r.src) && !NOT_UI.test(path.basename(r.src))) warn(r.file, `image ${r.src}: no dark variant (${path.basename(dark)}); dark-theme readers get the light screenshot`, r.line);
    continue;
  }
  // ::clip
  if (!r.src) {
    err(r.file, '::clip needs src="/docs-assets/<page>/<name>" (no extension)', r.line);
    continue;
  }
  checkAlt(r, "clip");
  if (!r.src.startsWith("/docs-assets/")) {
    err(r.file, `clip ${r.src}: clips live under /docs-assets/<page>/ in frontend/public`, r.line);
    continue;
  }
  if (/\.(mp4|webm|webp|gif|mov)$/i.test(r.src)) {
    err(r.file, `clip ${r.src}: give src without an extension; .webm, .mp4 and the .webp poster are picked up`, r.line);
    continue;
  }
  if (r.theme !== undefined && r.theme !== "light" && r.theme !== "both") err(r.file, `clip ${r.src}: theme must be "light" or "both"`, r.line);
  const variants = [r.src];
  const dark = darkOf(r.src);
  const hasDark = exists(`${dark}.mp4`) || exists(`${dark}.webm`);
  if (r.theme === "both") variants.push(dark);
  else if (hasDark) {
    warn(r.file, `clip ${r.src}: has a dark variant; add theme="both" to use it`, r.line);
    for (const x of [".mp4", ".webm", ".webp"]) if (exists(dark + x)) usedAssets.add(dark + x);
  }
  for (const base of variants) {
    const label = base === r.src ? "clip " : "dark clip ";
    const mp4 = checkAsset(r.file, r.line, `${base}.mp4`, "clip", label);
    if (exists(`${base}.webm`)) checkAsset(r.file, r.line, `${base}.webm`, "clip", label);
    else if (mp4) warn(r.file, `${label}${base}.webm is missing (browsers that prefer WebM download the larger MP4)`, r.line);
    if (!exists(`${base}.webp`)) err(r.file, `${label}${base}: no poster (${path.basename(base)}.webp)`, r.line);
    else checkAsset(r.file, r.line, `${base}.webp`, "poster", "poster ");
  }
}

// Changelog images
(changelog.value.entries ?? []).forEach((e, i) => {
  const img = e?.media?.image;
  if (typeof img === "string" && img.startsWith("/docs-assets/")) checkAsset("changelog.json", undefined, img, "image", `entries[${i}] media.image `);
  if (e?.media?.video) videoIds.add(e.media.video);
});

// videos.json
const VIDEO_KEYS = new Set(["src", "poster", "duration", "title", "chapters", "captions", "markdrop", "url"]);
function checkVtt(id, key, rel) {
  if (typeof rel !== "string" || !rel.startsWith("/docs-assets/") || !rel.endsWith(".vtt")) return err("videos.json", `${id}: ${key} must be a /docs-assets/….vtt path`);
  usedAssets.add(rel);
  if (!exists(rel)) return err("videos.json", `${id}: ${key} ${rel} doesn't exist in public/`);
  if (!/^\uFEFF?WEBVTT/.test(fs.readFileSync(path.join(PUBLIC, rel), "utf8"))) err("videos.json", `${id}: ${key} ${rel} isn't WebVTT (it must start with WEBVTT)`);
}
if (videos && (typeof videos !== "object" || Array.isArray(videos))) err("videos.json", 'must be an object: { "<id>": { "src": "/docs-assets/videos/<id>.mp4", "poster", "duration", "chapters"?, "captions"?, "markdrop"? } }');
else
  for (const [id, v] of Object.entries(videos ?? {})) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) err("videos.json", `${id}: id should be lowercase-with-dashes`);
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      err("videos.json", `${id}: must be an object`);
      continue;
    }
    for (const k of Object.keys(v)) if (!VIDEO_KEYS.has(k)) warn("videos.json", `${id}: unknown field "${k}" (ignored)`);
    for (const k of ["markdrop", "url"]) if (v[k] !== undefined && (typeof v[k] !== "string" || !/^https:\/\//.test(v[k]))) err("videos.json", `${id}: ${k} must be an https link`);
    if (v.src === undefined && !v.markdrop && !v.url) err("videos.json", `${id}: needs src (an MP4 under /docs-assets/videos/) or markdrop (a Markdrop link)`);
    if (v.src !== undefined) {
      if (typeof v.src !== "string" || !v.src.startsWith("/docs-assets/") || !/\.mp4$/i.test(v.src)) err("videos.json", `${id}: src must be a /docs-assets/….mp4 path`);
      else checkAsset("videos.json", undefined, v.src, "video", `${id}: `);
      if (v.poster === undefined) warn("videos.json", `${id}: no poster (the player shows a black frame until it plays)`);
    }
    if (v.poster !== undefined) {
      if (typeof v.poster !== "string" || !v.poster.startsWith("/docs-assets/")) err("videos.json", `${id}: poster must be a /docs-assets/ path`);
      else checkAsset("videos.json", undefined, v.poster, "poster", `${id}: poster `);
    }
    if (v.duration === undefined) warn("videos.json", `${id}: no duration (shown on the poster, like "0:45")`);
    else if (typeof v.duration !== "string" || !/^(\d+:)?\d{1,2}:\d{2}$/.test(v.duration)) err("videos.json", `${id}: duration "${v.duration}" should look like 0:45 or 1:02:03`);
    if (v.chapters !== undefined) checkVtt(id, "chapters", v.chapters);
    if (v.captions !== undefined) checkVtt(id, "captions", v.captions);
    if (!videoIds.has(id)) warn("videos.json", `${id}: no page has ::video{id="${id}"} (and no changelog entry uses it)`);
  }

// Every file in docs-assets is used; every media.json entry still exists.
function walkAssets(dir) {
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
    if (e.isDirectory()) out = out.concat(walkAssets(p));
    else out.push("/" + path.relative(PUBLIC, p).split(path.sep).join("/"));
  }
  return out;
}
const assetFiles = walkAssets(ASSETS_DIR);
for (const rel of assetFiles) if (!usedAssets.has(rel)) warn("public/docs-assets", `${rel} isn't used by any page, changelog entry or videos.json`);
for (const rel of Object.keys(media)) if (!exists(rel)) warn("media.json", `${rel} no longer exists: run npm run docs:media-manifest`);

/* ── print ───────────────────────────────────────────────────────────────── */
const inScope = (f) => !ONLY.length || ONLY.some((s) => f === s || f.startsWith(`${s}/`) || f.startsWith(s));
const shown = problems.filter((x) => inScope(x.file));
const byFile = new Map();
for (const x of shown) {
  if (!byFile.has(x.file)) byFile.set(x.file, []);
  byFile.get(x.file).push(x);
}
const RED = process.stdout.isTTY ? "\x1b[31m" : "", YEL = process.stdout.isTTY ? "\x1b[33m" : "", DIM = process.stdout.isTTY ? "\x1b[2m" : "", OFF = process.stdout.isTTY ? "\x1b[0m" : "";
for (const [file, list] of [...byFile.entries()].sort()) {
  console.log(`\n${file}`);
  for (const x of list.sort((a, b) => (a.line ?? 0) - (b.line ?? 0)))
    console.log(`  ${x.level === "error" ? `${RED}error${OFF}` : `${YEL}warn ${OFF}`} ${x.line ? `${DIM}${String(x.line).padStart(4)}${OFF} ` : "     "}${x.msg}`);
}
const missingShown = missing.filter((m) => inScope(m.p.slice(1)));
if (missingShown.length) {
  console.log(`\n${YEL}Not written yet${OFF} (${missingShown.length}; greyed in the nav during dev, left out of the build):`);
  for (const m of missingShown) console.log(`  ${m.p}  ${DIM}(${m.g})${OFF}`);
}
const errors = shown.filter((x) => x.level === "error").length;
const warnings = shown.filter((x) => x.level === "warn").length;
console.log(`\n${pages.size} files, ${listed.size} nav entries, ${listed.size - missing.length} written. ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}.`);
process.exit(errors || (STRICT && (warnings || missingShown.length)) ? 1 : 0);
