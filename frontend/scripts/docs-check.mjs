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
 * videos.json. Errors exit 1; warnings (pages not written yet, orphans) don't, unless --strict.
 *
 * Heading slugs mirror src/components/reading/slug.ts (createSlugger + inlineText); keep in step.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT = process.env.DOCS_CONTENT_DIR || path.join(ROOT, "content", "docs");
const args = process.argv.slice(2);
const STRICT = args.includes("--strict");
const ONLY = args.filter((a) => !a.startsWith("--")).map((a) => a.replace(/^\/+|\/+$/g, ""));

const CONTAINERS = new Set(["note", "tip", "warning", "danger", "steps", "tabs", "tab", "cards", "card", "details"]);
const LEAVES = new Set(["video", "embed"]);
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
      if (name === "video") {
        videos++;
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
if (videos && (typeof videos !== "object" || Array.isArray(videos))) err("videos.json", "must be an object: { id: { url, poster?, duration? } }");
else for (const [id, v] of Object.entries(videos ?? {})) if (!v || typeof v.url !== "string" || !/^https:\/\//.test(v.url)) err("videos.json", `${id}: url must be an https link`);

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
