/**
 * A repository folder → a Markdrop content folder (the GitBook importer's output contract, see
 * docs-platform/runner/lib.mjs readImportFolder). Reads files only: never runs repo code, never
 * fetches anything (remote images stay remote, reported in keptOriginal).
 *
 *   convertRepo({ dir, path, format, repo, ref, branch, date, id }) → the result in memory
 *   writeOutput(result, out)                                         → the folder on disk
 *
 * Pipeline per page: front matter (yaml), title (front matter → leading H1 → file name), the format's
 * components (lib/repo/mdx.mjs, admonitions.mjs), then lib/repo/rewrite.mjs: link and image targets
 * resolved against the repo, raw HTML (and GitBook blocks) through lib/convert.mjs convertBody like
 * the GitBook import. Fidelity first: everything else in a page is kept byte for byte (no reflow,
 * no heading shifts, list markers, emphasis, tables, code and spacing as written).
 *
 * Page addresses are a pure function of the repo file (+ slug/id front matter): the same file maps
 * to the same page on every sync; a collision keeps the first file by repo path (the other is
 * skipped and reported).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { faName, trimDescription, unescapeMd, videoEmbedUrl } from "../convert.mjs";
import { decodeEntities } from "../html.mjs";
import { IMAGE_EXTS, IMPORT_EXTS, isSvg, sniffExt, svgSelfContained } from "../guard.mjs";
import { imageSize } from "../../../docs-media-manifest.mjs";
import { detectFormat, listPages } from "./detect.mjs";
import { convertMdx, stripComments } from "./mdx.mjs";
import { SENT, settle } from "./blocks.mjs";
import { rewriteBody } from "./rewrite.mjs";
import { assetRel, baseOf, dirOf, extOf, humanize, normRepoPath, pagePath, relTo, repoPathAllowed, resolveRepo, stemOf, stripNumberPrefix, within } from "./paths.mjs";
import markdown from "./nav/markdown.mjs";
import gitbook from "./nav/gitbook.mjs";
import mintlify from "./nav/mintlify.mjs";
import docusaurus, { docUrlSegments } from "./nav/docusaurus.mjs";
import mkdocs from "./nav/mkdocs.mjs";

export const FORMAT_MODULES = { markdown, gitbook, mintlify, docusaurus, mkdocs };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_TEXT = 5 * 1024 * 1024;
const MAX_ASSET = 100 * 1024 * 1024;
const LINKABLE = new Set([...IMPORT_EXTS, "svg"]);

export class ImportError extends Error {
  constructor(message) {
    super(message);
    this.name = "ImportError";
  }
}

/* ── the repo on disk ────────────────────────────────────────────────────── */

/**
 * Lists a checkout's files (repo-relative, posix) without following symlinks, skipping .git,
 * node_modules and hidden paths (lib/repo/paths.mjs repoPathAllowed). readText/readBytes read only
 * listed files.
 */
export function readRepoDir(dir) {
  const root = path.resolve(dir);
  const files = new Set();
  const walk = (abs, rel, depth) => {
    if (depth > 40) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        if (e.name.startsWith(".") && e.name !== ".gitbook") continue;
        walk(path.join(abs, e.name), r, depth + 1);
      } else if (e.isFile() && repoPathAllowed(r)) files.add(r);
    }
  };
  walk(root, "", 0);
  const abs = (p) => path.join(root, ...p.split("/"));
  const read = (p, max) => {
    if (!files.has(p)) return null;
    try {
      const st = fs.lstatSync(abs(p));
      if (!st.isFile() || st.size > max) return null;
      return fs.readFileSync(abs(p));
    } catch {
      return null;
    }
  };
  return { root, files, readText: (p) => read(p, MAX_TEXT)?.toString("utf8") ?? null, readBytes: (p) => read(p, MAX_ASSET), abs };
}

/* ── icons ───────────────────────────────────────────────────────────────── */

let iconNames;
/** The design system's icon names (frontend/src/components/ui/icons.ts PATHS keys). */
export function designIcons() {
  if (iconNames) return iconNames;
  iconNames = new Set();
  try {
    const src = fs.readFileSync(path.resolve(HERE, "../../../../src/components/ui/icons.ts"), "utf8");
    const body = src.slice(src.indexOf("const PATHS"), src.indexOf("export type IconName"));
    for (const m of body.matchAll(/^\s+([A-Za-z][\w]*)\s*:\s*"/gm)) iconNames.add(m[1]);
  } catch {
    /* no icons file: only Font Awesome names map */
  }
  return iconNames;
}

/** A Mintlify / Font Awesome / lucide icon name → a design-system icon, or undefined. */
export function mapIcon(name) {
  const n = String(name ?? "").trim();
  if (!n || n.startsWith("{") || /^(https?:|\/)/.test(n)) return undefined;
  const icons = designIcons();
  if (icons.has(n)) return n;
  const fa = faName(n);
  if (fa) return fa;
  const camel = n.toLowerCase().replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
  if (icons.has(camel)) return camel;
  const alias = LUCIDE_ALIASES[n.toLowerCase()];
  if (alias && icons.has(alias)) return alias;
  return undefined;
}

/** lucide names (Mintlify `icons.library: lucide`) with a close design-system stand-in. */
const LUCIDE_ALIASES = {
  bot: "sparkle", "bot-message-square": "sparkle", brain: "sparkle", wand: "sparkle", "wand-sparkles": "sparkle", sparkles: "sparkle",
  wrench: "settings", cog: "settings", "settings-2": "settings", "sliders-horizontal": "settings", pen: "edit", pencil: "edit", "pen-line": "edit", "square-pen": "edit",
  "refresh-cw": "refresh", "refresh-ccw": "refresh", "rotate-cw": "rotate", "rotate-ccw": "rotate", "message-circle": "message", "message-square": "message",
  "message-circle-plus": "message", "messages-square": "message", "message-square-text": "message", blocks: "layers", boxes: "layers", box: "layers", package: "layers",
  puzzle: "layers", "layout-grid": "layers", "file-text": "doc", "file-code": "code", "file-braces": "code", "file-json": "code", braces: "code", "code-xml": "code",
  "book-open": "doc", book: "doc", "library-big": "doc", newspaper: "doc", notebook: "doc", rocket: "zap", bolt: "zap", "circle-help": "info", "help-circle": "info",
  "circle-alert": "alertCircle", "triangle-alert": "alert", "badge-check": "checkCircle", "circle-check": "checkCircle", "check-circle": "checkCircle", "shield-check": "shield",
  "lock-keyhole": "lock", "key-round": "key", "git-branch": "github", "git-merge": "github", "git-pull-request": "github", route: "listTree", workflow: "listTree", network: "listTree",
  "chart-line": "chart", "chart-bar": "chart", "bar-chart": "chart", "line-chart": "chart", gauge: "chart", activity: "chart", "trending-up": "chart",
  database: "server", "hard-drive": "server", cloud: "server", "cloud-upload": "upload", plug: "link", "plug-zap": "link", webhook: "link", "link-2": "link",
  "mouse-pointer-click": "arrowUpRight", "external-link": "external", "square-arrow-out-up-right": "external", "arrow-up-right": "arrowUpRight",
  "circle-play": "play", video: "film", clapperboard: "film", "image-plus": "image", images: "image", "user-round": "user", "users-round": "users", "user-plus": "userPlus",
  "calendar-days": "calendar", "clock-3": "clock", timer: "clock", history: "history", "list-checks": "checkSquare", "list-todo": "checkSquare", "list-tree": "listTree",
  folder: "folder", "folder-open": "folder", "folder-tree": "listTree", search: "search", "text-search": "search", tag: "hash", tags: "hash", hash: "hash", languages: "globe", earth: "globe",
  "globe-2": "globe", house: "home", "house-plus": "home", handshake: "users", trophy: "sparkle", "piggy-bank": "chart", "credit-card": "lock", "square-dashed-text": "lines", "text-cursor": "lines",
  "align-left": "lines", "scroll-text": "lines", "file-pen": "edit", palette: "palette", paintbrush: "palette", brush: "palette", droplet: "droplet", terminal: "terminal", "square-terminal": "terminal",
  monitor: "monitor", laptop: "laptop", smartphone: "phone", "mail-open": "mail", inbox: "inbox", send: "send", megaphone: "megaphone", flag: "flag", bug: "bug", filter: "filter",
};

/* ── pages ───────────────────────────────────────────────────────────────── */

const FM = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Text → { fm, body, bodyLine, error }. */
export function splitFrontMatter(src) {
  const s = String(src ?? "").replace(/\r\n?/g, "\n");
  const m = FM.exec(s);
  if (!m) return { fm: {}, body: s.replace(/^\uFEFF/, ""), bodyLine: 0 };
  let fm = {};
  let error = null;
  try {
    const doc = parseDocument(m[1], { logLevel: "silent" });
    if (doc.errors.length) error = String(doc.errors[0].message).split("\n")[0];
    else {
      const v = doc.toJS();
      if (v && typeof v === "object" && !Array.isArray(v)) fm = v;
    }
  } catch (e) {
    error = String(e.message).split("\n")[0];
  }
  return { fm, body: s.slice(m[0].length), bodyLine: m[0].split("\n").length - 1, error };
}

const str = (v) => (v === undefined || v === null ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v)).trim();
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** Inline Markdown → its text (for titles). */
export function plainTitle(s) {
  return decodeEntities(
    String(s ?? "")
      .replace(/\s*\{\s*#[\w-]+[^}]*\}\s*$/, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(^|\W)[*_](\S.*?)[*_](?=\W|$)/g, "$1$2")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, "$1"),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** The body's leading H1 (ATX or setext; blank, comment and import lines before it skipped) → { text, from, to } (line indexes). */
export function leadingH1(body, mdx) {
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && (!lines[i].trim() || /^\s*<!--.*-->\s*$/.test(lines[i]) || (mdx && (/^(import|export)\s/.test(lines[i]) || /^\s*\{\/\*.*\*\/\}\s*$/.test(lines[i]))))) i++;
  const atx = /^\s{0,3}#\s+(.*?)\s*#*\s*$/.exec(lines[i] ?? "");
  if (atx) return { text: atx[1], from: i, to: i };
  if (lines[i]?.trim() && /^\s{0,3}=+\s*$/.test(lines[i + 1] ?? "")) return { text: lines[i].trim(), from: i, to: i + 1 };
  return null;
}

/** Headings with attribute lists (`## Title {#id}`) lose them, outside code. */
function stripHeadingAttrs(body) {
  let fence = null;
  return body
    .split("\n")
    .map((l) => {
      const f = /^\s*(`{3,}|~{3,})(.*)$/.exec(l);
      if (fence) {
        if (f && f[1][0] === fence[0] && !f[2].trim()) fence = null;
        return l;
      }
      if (f) {
        fence = f[1];
        return l;
      }
      return /^\s{0,3}#{1,6}\s/.test(l) ? l.replace(/\s*\{\s*#[\w-]+[^}]*\}\s*$/, "") : l;
    })
    .join("\n");
}

/* ── SVG → PNG ───────────────────────────────────────────────────────────── */

let sharpMod;
async function loadSharp() {
  if (sharpMod === undefined) {
    try {
      sharpMod = (await import("sharp")).default;
    } catch {
      sharpMod = null;
    }
  }
  return sharpMod;
}

/** A self-contained SVG → PNG bytes (about 2x, at most 2400 px wide), else null. */
/**
 * Drawing tools write the standard SVG 1.0/1.1 public DOCTYPE (no internal subset, nothing
 * fetched): dropped, so the rest is checked like any SVG. Any other DOCTYPE still refuses the file.
 */
export const dropSvgDoctype = (text) => String(text).replace(/<!DOCTYPE\s+svg\s+PUBLIC\s+"-\/\/W3C\/\/DTD SVG 1\.[01](?: Basic| Tiny)?\/\/EN"\s+"http:\/\/www\.w3\.org\/(?:Graphics\/SVG\/1\.1\/DTD\/svg11(?:-basic|-tiny)?|TR\/2001\/REC-SVG-20010904\/DTD\/svg10)\.dtd"\s*>/i, "");

export async function svgToPng(input) {
  const text = dropSvgDoctype(input.toString("utf8"));
  let buf = Buffer.from(text, "utf8");
  if (!isSvg(buf) || !svgSelfContained(text)) return null;
  const sharp = await loadSharp();
  if (!sharp) return null;
  try {
    const img = sharp(buf, { density: 144, limitInputPixels: 40_000_000 });
    const meta = await img.metadata();
    const out = meta.width && meta.width > 2400 ? img.resize({ width: 2400 }) : img;
    return await out.png({ compressionLevel: 9 }).toBuffer();
  } catch {
    return null;
  }
}

/* ── convert ─────────────────────────────────────────────────────────────── */

/** "owner/name" → { owner, name } | null. */
export function parseRepoName(repo) {
  const m = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(String(repo ?? "").trim());
  return m ? { owner: m[1], name: m[2].replace(/\.git$/, "") } : null;
}

const enc = (p) => p.split("/").map(encodeURIComponent).join("/");

/**
 * Converts a repo folder. Returns { site, pages, redirects, videos, assets, report, reportMd,
 * origins, openapi, format, det, dir, source }. Throws ImportError when the folder has no pages.
 */
export async function convertRepo({ dir, path: folder = "", format = "auto", repo, ref, branch, date, id = "import", log = () => {}, source: given } = {}) {
  const src = given ?? readRepoDir(dir);
  const today = date || new Date().toISOString().slice(0, 10);
  const gh = parseRepoName(repo);
  const linkRef = branch || ref || "HEAD";
  const blobUrl = (p, raw) => (gh ? `https://github.com/${gh.owner}/${gh.name}/blob/${encodeURIComponent(linkRef)}/${enc(p)}${raw ? "?raw=true" : ""}` : null);

  const det = detectFormat(src.files, src.readText, folder, format);
  const mod = FORMAT_MODULES[det.format];
  const mdxFlavor = mod.flavor === "mintlify" || mod.flavor === "docusaurus";
  const ignored = mod.ignore?.({ det, readText: src.readText }) ?? (() => false);
  const pageFiles = listPages(src.files, det).filter((f) => !ignored(relTo(f, det.folder)));
  log(`pages: ${pageFiles.length}`);
  if (!pageFiles.length) throw new ImportError(`no pages: ${det.contentRoot || "the repository root"} has no .md or .mdx files (format ${det.format})`);

  /* report state */
  const counts = new Map();
  const count = (kind, how) => {
    if (!counts.has(kind)) counts.set(kind, new Map());
    const m = counts.get(kind);
    m.set(how, (m.get(how) ?? 0) + 1);
  };
  const issues = []; // { file, line, kind, message }
  const broken = [];
  const missing = [];
  const keptOriginal = [];
  const altGenerated = [];
  const external = [];
  const unmatched = new Map(); // icon → [where]
  const siteNotes = [];

  /* pages */
  let pages = pageFiles.map((file) => {
    const { fm, body, bodyLine, error } = splitFrontMatter(src.readText(file) ?? "");
    const rel = relTo(file, det.contentRoot);
    if (error) issues.push({ file, line: 1, kind: "front matter", message: `front matter isn't valid YAML (${error}): ignored` });
    const h1 = leadingH1(body, mdxFlavor);
    const h1Title = h1 ? plainTitle(h1.text) : "";
    const fmTitle = str(fm.title);
    const stem = stemOf(baseOf(rel));
    const fallback = /^(readme|index)$/i.test(stem) ? (dirOf(rel) ? humanize(stripNumberPrefix(baseOf(dirOf(rel)))) : "Introduction") : humanize(stripNumberPrefix(stem));
    const title = fmTitle || h1Title || fallback;
    return {
      file,
      rel,
      fm,
      body,
      bodyLine,
      h1,
      dropH1: !!h1 && (!fmTitle || norm(h1Title) === norm(fmTitle)),
      title,
      titleFrom: fmTitle ? "fm" : h1Title ? "h1" : "file",
      description: str(fm.description),
      navTitle: str(fm.sidebarTitle ?? fm.sidebar_label ?? fm.nav_title ?? "") || null,
    };
  });
  const byFile = new Map(pages.map((p) => [p.file, p]));

  const iconFor = (name, { where } = {}) => {
    const icon = mapIcon(name);
    if (!icon && name && !String(name).startsWith("{")) unmatched.set(String(name), [...(unmatched.get(String(name)) ?? []), where ?? ""]);
    return icon;
  };
  const env = {
    det,
    files: src.files,
    readText: src.readText,
    pages,
    byFile,
    external,
    iconFor,
    config: undefined,
    note: (message) => siteNotes.push(message),
  };
  const navRes = mod.nav(env);
  if (navRes.exclude?.length) {
    const ex = new Set(navRes.exclude);
    pages = pages.filter((p) => !ex.has(p.file));
    for (const f of ex) byFile.delete(f);
    env.pages = pages;
  }

  /*
   * Addresses: a pure function of the repo file (and its slug/id front matter), so a file keeps its
   * page across syncs. Two files on one address: the first by repo path keeps it, the other is
   * skipped (reported). The home rule (no README/index/slug "/": the first page in the nav becomes
   * "/", with a redirect from its own address) depends on the config only.
   */
  const naturalSegs = (p) => {
    if (mod.natural) return mod.natural(p, env);
    const segs = p.rel.replace(/\.(md|mdx)$/i, "").split("/");
    if (/^(readme|index)$/i.test(segs[segs.length - 1])) segs.pop();
    return segs;
  };
  for (const p of pages) p.natural = pagePath(naturalSegs(p));
  {
    const owners = new Map();
    for (const p of [...pages].sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0))) {
      const owner = owners.get(p.natural);
      if (owner) {
        p.skipped = owner;
        issues.push({ file: p.file, line: 0, kind: "duplicate address", message: `${p.file} has the same address (${p.natural}) as ${owner.file}: not imported` });
        continue;
      }
      owners.set(p.natural, p);
      p.path = p.natural;
    }
    pages = pages.filter((p) => !p.skipped);
  }
  const order = [];
  {
    const seen = new Set();
    for (const g of navRes.groups) for (const f of g.files) if (byFile.get(f) && !byFile.get(f).skipped && !seen.has(f)) seen.add(f), order.push(f);
    for (const p of pages) if (!seen.has(p.file)) seen.add(p.file), order.push(p.file);
  }
  const redirectList = [];
  let home = pages.find((p) => p.path === "/");
  if (!home) {
    const pick = navRes.home && byFile.get(navRes.home);
    home = pick && !pick.skipped ? pick : byFile.get(order[0]);
    redirectList.push({ from: home.path, to: "/", why: "the first page became the home" });
    home.path = "/";
    count("home", `${home.file} became the home page (redirect from ${home.natural})`);
  }
  const byPath = new Map(pages.map((p) => [p.path, p]));

  /* nav, tabs */
  const navTitles = navRes.navTitles ?? new Map();
  for (const p of pages) p.navTitle = navTitles.get(p.file) ?? p.navTitle;
  const nav = [];
  const placed = new Set();
  const tabHref = new Map();
  for (const g of navRes.groups) {
    const paths = [];
    for (const f of g.files) {
      const p = byFile.get(f);
      if (!p || p.skipped) continue;
      if (g.tab && !tabHref.has(g.tab)) tabHref.set(g.tab, p.path);
      if (p.path === "/" || placed.has(p.path)) continue;
      placed.add(p.path);
      paths.push(p.path);
    }
    if (paths.length) nav.push({ group: g.group, pages: paths, ...(g.icon ? { icon: g.icon } : {}), ...(g.tab ? { tab: g.tab } : {}) });
  }
  let tabs = (navRes.tabs ?? []).filter((t) => tabHref.has(t.id)).map((t) => ({ id: t.id, label: t.label, href: tabHref.get(t.id) }));
  if (tabs.length < 2) {
    tabs = [];
    for (const g of nav) delete g.tab;
  }

  /* icons */
  for (const p of pages) if (p.fm.icon) p.icon = iconFor(p.fm.icon, { where: p.path });

  /* assets and links */
  const assets = new Map(); // repo path → { token, repoPath, kind, page, rel?, failed? }
  let tokenN = 0;
  const assetFor = (repoPath, kind, page) => {
    if (!assets.has(repoPath)) assets.set(repoPath, { token: `@@ASSET${++tokenN}@@`, repoPath, kind, page: page?.path ?? "site.json" });
    return assets.get(repoPath);
  };
  const absRoots = () => (mod.name === "mintlify" ? [det.contentRoot] : mod.name === "docusaurus" ? [det.staticDir, det.contentRoot] : ["", det.contentRoot]);
  /** Repo paths an href could mean (null: it climbs out of the repo). */
  const bases = (p, pathPart) => {
    const roots = pathPart.startsWith("/") ? absRoots() : [null];
    const out = roots.map((r) => (r === null ? resolveRepo(p?.file ?? det.contentRoot + "/x", pathPart) : resolveRepo("", pathPart, r)));
    // MkDocs serves pages as folders (/guide/page/): raw HTML and images written against that
    // address climb one more level.
    if (mod.name === "mkdocs" && p && !pathPart.startsWith("/")) {
      const viaUrl = resolveRepo(p.file.replace(/\.(md|mdx)$/i, "") + "/x", pathPart);
      if (viaUrl !== null && within(viaUrl, det.contentRoot)) out.push(viaUrl);
    }
    return out.every((x) => x === null) ? null : out.filter((x) => x !== null);
  };
  const pageCandidates = (b) => {
    const s = b.replace(/\/+$/, "");
    const list = [s, `${s}.md`, `${s}.mdx`, `${s}/README.md`, `${s}/readme.md`, `${s}/index.md`, `${s}/index.mdx`, `${s}/README.mdx`];
    if (/\.html?$/i.test(s)) list.push(s.replace(/\.html?$/i, ".md"), s.replace(/\.html?$/i, ".mdx"));
    if (!s) list.push("README.md", "index.md");
    return list;
  };
  // Docusaurus addresses (/docs/guides/setup) → pages.
  const docUrls = new Map();
  if (mod.name === "docusaurus") {
    const base = det.routeBase ? `/${det.routeBase}` : "";
    for (const p of pages) if (!p.skipped) docUrls.set(`${base}/${docUrlSegments(p.rel, p.fm).join("/")}`.replace(/\/+$/, "").toLowerCase() || "/", p);
  }
  const findPage = (p, pathPart) => {
    if (mod.name === "docusaurus" && pathPart.startsWith("/")) {
      const hit = docUrls.get(pathPart.replace(/\/+$/, "").toLowerCase() || "/");
      if (hit) return hit;
    }
    const bs = bases(p, pathPart);
    if (bs === null) return null;
    for (const b of bs) for (const c of pageCandidates(b)) if (byFile.has(c)) return byFile.get(c).skipped ?? byFile.get(c);
    return undefined;
  };
  // Redirect sources (Mintlify `redirects`, .gitbook.yaml) → their page, to repair links to old addresses.
  const redirectPages = new Map();
  for (const r of navRes.redirects ?? []) {
    const from = "/" + String(r.from ?? "").replace(/^\/+|\/+$/g, "");
    let f = null;
    if (r.toFile !== undefined) f = r.toFile;
    else if (r.ref && typeof r.to === "string" && !/^[a-z]+:/i.test(r.to)) f = mod.refFile?.(env, r.to);
    const pg = f && byFile.get(f);
    if (pg && !/[:*]/.test(from)) redirectPages.set(from.toLowerCase(), pg.skipped ?? pg);
  }
  const redirectTarget = (pathPart) => (pathPart.startsWith("/") ? redirectPages.get(pathPart.replace(/\/+$/, "").toLowerCase() || "/") ?? null : null);
  const brokenRef = (h) => /^(\.\.?\/)*broken-reference(\.md)?$/.test(h);

  /** A github.com blob/raw or raw.githubusercontent.com URL into this repo → its repo path, or null. */
  const ownRepoPath = (url) => {
    if (!gh) return null;
    let u;
    try {
      u = new URL(url.startsWith("//") ? `https:${url}` : url);
    } catch {
      return null;
    }
    const segs = u.pathname.split("/").filter(Boolean).map((x) => {
      try {
        return decodeURIComponent(x);
      } catch {
        return x;
      }
    });
    const same = (o, n) => o?.toLowerCase() === gh.owner.toLowerCase() && n?.toLowerCase() === gh.name.toLowerCase();
    let rest = null;
    if (u.hostname === "github.com" && same(segs[0], segs[1]) && (segs[2] === "blob" || segs[2] === "raw")) rest = segs.slice(4);
    else if (u.hostname === "raw.githubusercontent.com" && same(segs[0], segs[1])) rest = segs.slice(3);
    if (!rest?.length) return null;
    return normRepoPath(rest.join("/")) || null;
  };
  const videos = {};
  function pageCtx(p) {
    const at = (line) => (typeof line === "number" ? line + 1 : 0);
    let images = 0;
    const ctx = {
      count,
      issue: (kind, line, message) => issues.push({ file: p.file, line: at(line), kind, message }),
      link(href, { line, card } = {}) {
        let h = unescapeMd(decodeEntities(String(href ?? ""))).trim();
        if (!h) return null;
        if (h.startsWith("@@") || h.startsWith("/docs-assets/")) return h;
        if (h.startsWith("#")) return h;
        if (/^(mailto|tel):/i.test(h)) return h;
        if (h.startsWith("//")) return `https:${h}`;
        if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return h;
        if (brokenRef(h)) {
          broken.push({ file: p.file, line: at(line), href: h, reason: card ? `card “${card}” links to a page GitBook couldn't resolve: imported without a link` : "broken link in GitBook itself: imported as plain text" });
          return null;
        }
        const hashAt = h.indexOf("#");
        const hash = hashAt >= 0 ? h.slice(hashAt) : "";
        const pathPart = (hashAt >= 0 ? h.slice(0, hashAt) : h).split("?")[0];
        if (!pathPart) return hash || null;
        const target = findPage(p, pathPart);
        if (target === null) {
          broken.push({ file: p.file, line: at(line), href: h, reason: "points outside the repository: imported as plain text" });
          return null;
        }
        if (target) return target.path + hash;
        // A link to an address the format redirects (Mintlify redirects, .gitbook.yaml): its target.
        const via = redirectTarget(pathPart);
        if (via) {
          count("link to a redirected address", "rewritten to the redirect's page");
          return via.path + hash;
        }
        const bs = bases(p, pathPart) ?? [];
        const file = bs.find((b) => src.files.has(b));
        if (file && LINKABLE.has(extOf(file))) {
          count("link to a repo file", "copied to docs-assets");
          return assetFor(file, "file", p).token;
        }
        if (pathPart.startsWith("/") && (mod.name === "mintlify" || mod.name === "docusaurus")) {
          broken.push({ file: p.file, line: at(line), href: h, reason: "no such page in the import: kept as written" });
          return h;
        }
        const repoPath = file ?? bs[0];
        const url = repoPath !== undefined ? blobUrl(repoPath) : null;
        if (url) {
          count("link to a repo file", "GitHub link");
          external.push({ file: p.file, line: at(line), href: h, url });
          return url + hash;
        }
        broken.push({ file: p.file, line: at(line), href: h, reason: "not a page of the import: kept as written" });
        return h;
      },
      image(srcIn, { alt, caption, line, decorative } = {}) {
        let s = unescapeMd(decodeEntities(String(srcIn ?? ""))).trim();
        const req = /require\(\s*['"]([^'"]+)['"]\s*\)/.exec(s);
        if (req) s = req[1];
        if (!s) return null;
        const altText = () => {
          if (decorative) return "";
          images++;
          let a = (alt || caption || "").trim();
          if (!a || /^(image|img|screenshot|untitled|alt|picture)\s*\d*$/i.test(a)) {
            a = `Image from “${p.title}”${images > 1 ? ` (${images})` : ""}`;
            altGenerated.push({ file: p.file, line: at(line), alt: a });
          }
          return a;
        };
        // This repo's own file written as a GitHub URL (…/blob/<ref>/x.png?raw=true, raw.githubusercontent):
        // the file itself, when it's in the folder read.
        const own = ownRepoPath(s);
        if (own && src.files.has(own)) return { src: assetFor(own, "image", p).token, alt: altText() };
        if (/^https?:\/\//i.test(s) || s.startsWith("//")) {
          const url = s.startsWith("//") ? `https:${s}` : s;
          keptOriginal.push({ file: p.file, line: at(line), src: url, reason: "a remote image: it stays on its own host (the import never downloads)" });
          return { src: url, alt: altText() };
        }
        if (/^data:/i.test(s)) {
          missing.push({ file: p.file, line: at(line), src: s.slice(0, 40) + "…", reason: "an inline data: image isn't imported" });
          return null;
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
          missing.push({ file: p.file, line: at(line), src: s, reason: "not a file in the repository" });
          return null;
        }
        const pathPart = s.split(/[?#]/)[0];
        const bs = bases(p, pathPart);
        if (bs === null) {
          missing.push({ file: p.file, line: at(line), src: s, reason: "points outside the repository" });
          return null;
        }
        const file = bs.find((b) => src.files.has(b));
        if (!file) {
          missing.push({ file: p.file, line: at(line), src: s, reason: "no such file in the repository folder" });
          return null;
        }
        return { src: assetFor(file, "image", p).token, alt: altText() };
      },
      file(index, srcIn, { line } = {}) {
        const s = unescapeMd(decodeEntities(String(srcIn ?? ""))).trim().split(/[?#]/)[0];
        if (!s || /^[a-z][a-z0-9+.-]*:/i.test(s)) return null;
        const file = (bases(p, s) ?? []).find((b) => src.files.has(b));
        if (!file) {
          missing.push({ file: p.file, line: at(line), src: s, reason: "no such file in the repository folder" });
          return null;
        }
        return { href: assetFor(file, "file", p).token, name: baseOf(file), ext: extOf(file) };
      },
      video(url, title) {
        const leaf = p.path === "/" ? "home" : p.path.split("/").pop();
        let vid = `${leaf}-${(title || "video").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "video"}`.slice(0, 60).replace(/-+$/, "");
        if (videos[vid]) vid += `-${Object.keys(videos).length + 1}`;
        videos[vid] = { url: videoEmbedUrl(url), title: title || "Video" };
        return vid;
      },
      pageInfo(href) {
        const h = unescapeMd(decodeEntities(String(href ?? ""))).split("#")[0];
        if (!h || /^[a-z][a-z0-9+.-]*:/i.test(h)) return null;
        const t = findPage(p, h);
        return t ? { title: t.title, description: t.description ? trimDescription(t.description) : "" } : null;
      },
      icon: (name, { line } = {}) => iconFor(name, { where: `${p.path}${line ? `:${at(line)}` : ""}` }),
      snippet(modPath) {
        const m = String(modPath ?? "");
        const f = m.startsWith("/") ? resolveRepo("", m, det.contentRoot) : resolveRepo(p.file, m);
        return f && within(f, det.folder) ? src.readText(f) : null;
      },
    };
    return ctx;
  }

  pages.forEach((p, i) => {
    let body = p.body;
    if (p.dropH1) {
      const lines = body.split("\n");
      for (let k = p.h1.from; k <= p.h1.to; k++) lines[k] = SENT;
      body = lines.join("\n");
    }
    if (mod.flavor !== "gitbook") body = stripHeadingAttrs(body);
    else {
      // Git Sync writes a content-ref's link text as the file name: the page's title reads better.
      body = body.replace(/(\{%\s*content-ref\s+url="([^"]+)"\s*%\}\s*\n\s*)\[([^\]\n]*\.md)\]\(([^)\s]+)\)/g, (m, pre, url, _t, href) => {
        const t = findPage(p, url.split("#")[0]);
        return t ? `${pre}[${t.title.replace(/[[\]]/g, "")}](${href})` : m;
      });
      body = stripComments(body.split("\n"), false).join("\n");
    }
    const ctx = pageCtx(p);
    let md = mod.flavor === "gitbook" ? body : convertMdx(body, { flavor: mod.flavor, line0: p.bodyLine, ctx, raw: true });
    // A Mintlify API page (`openapi: GET /users`): the engine's operation card.
    const op = mod.name === "mintlify" ? /^(?:\S+\.(?:json|ya?ml)\s+)?((?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/\S*)\s*$/i.exec(str(p.fm.openapi)) : null;
    if (op) {
      md = `::api{op="${op[1].replace(/\s+/, " ").replace(/^\w+/, (w) => w.toUpperCase())}"}\n${SENT}\n${md}`;
      count("openapi page", "::api{op} card");
    }
    p.out = settle(rewriteBody(md, ctx, { line0: p.bodyLine, gitbook: mod.flavor === "gitbook" }));
    log(`progress: pages ${i + 1}/${pages.length}`);
  });

  /* brand */
  const b = mod.brand(env) ?? {};
  // Plain Markdown: the README's own H1 names the project better than the repo does.
  const homeTitle = mod.name === "markdown" && home.titleFrom === "h1" ? home.title : "";
  const name = str(b.name) || homeTitle || (gh ? humanize(gh.name) : humanize(baseOf(det.folder)) || "Docs");
  const brandOut = { name };
  const brandTokens = {};
  const brandAsset = (file, what) => {
    if (!file) return null;
    if (!src.files.has(file)) {
      missing.push({ file: "site.json", line: 0, src: file, reason: `brand ${what}: no such file in the repository folder` });
      return null;
    }
    return assetFor(file, "image", null).token;
  };
  if (b.logo?.light) {
    const light = brandAsset(b.logo.light, "logo");
    const dark = b.logo.dark ? brandAsset(b.logo.dark, "dark logo") : null;
    if (light) brandTokens.logo = { light, ...(dark ? { dark } : {}), alt: str(b.logo.alt) || name };
  }
  if (b.favicon) brandTokens.favicon = brandAsset(b.favicon, "favicon");
  const hex = (v) => (typeof v === "string" && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v) ? v.toLowerCase() : undefined);
  if (hex(b.accent)) brandOut.accent = hex(b.accent);
  if (hex(b.accentDark)) brandOut.accentDark = hex(b.accentDark);

  /* asset files */
  const taken = new Set();
  let assetsDone = 0;
  let svgsDrawn = 0;
  for (const a of assets.values()) {
    log(`progress: assets ${++assetsDone}/${assets.size}`);
    const fail = (reason) => {
      a.failed = true;
      a.fallback = blobUrl(a.repoPath, a.kind === "image");
      const brandOnly = a.page === "site.json";
      keptOriginal.push({ file: byPath.get(a.page)?.file ?? a.page, line: 0, src: a.repoPath, reason: `${reason}${brandOnly ? ": the brand goes without it" : a.fallback ? ": linked to the file on GitHub" : ""}` });
    };
    let buf = src.readBytes(a.repoPath);
    if (!buf) {
      a.failed = true;
      a.fallback = blobUrl(a.repoPath, a.kind === "image");
      missing.push({ file: byPath.get(a.page)?.file ?? a.page, line: 0, src: a.repoPath, reason: `couldn't be read (larger than ${MAX_ASSET / 1048576} MB?)` });
      continue;
    }
    let ext = sniffExt(buf);
    if (!ext && (isSvg(buf) || isSvg(Buffer.from(dropSvgDoctype(buf.toString("utf8", 0, 4096)))))) {
      const png = await svgToPng(buf);
      if (!png) {
        fail(svgSelfContained(buf.toString("utf8")) ? "an SVG that couldn't be drawn into a PNG (sharp unavailable)" : "an SVG that isn't self-contained (it refers to other files): not copied");
        continue;
      }
      buf = png;
      ext = "png";
      a.data = png;
      svgsDrawn++;
      count("SVG image", "drawn into a PNG (sharp)");
    }
    const ok = a.kind === "image" ? IMAGE_EXTS.has(ext) || ext === "ico" : IMPORT_EXTS.has(ext);
    if (!ok) {
      fail(ext ? `a .${extOf(a.repoPath)} file isn't copied (only images, PDFs and MP4/WebM video)` : `not an image, PDF or video by its bytes (.${extOf(a.repoPath) || "no extension"})`);
      continue;
    }
    const size = IMAGE_EXTS.has(ext) ? imageSize(buf) : null;
    a.rel = assetRel(a.repoPath, extOf(a.repoPath) === "jpeg" && ext === "jpg" ? "jpeg" : ext, { id, taken, suffix: a.kind === "image" && size?.w && size.w < 1600 ? "@1x" : "" });
    a.bytes = buf.length;
  }
  const tokenMap = new Map([...assets.values()].map((a) => [a.token, a.rel ? `/docs-assets/${a.rel}` : a.fallback ?? a.repoPath]));
  const detok = (s) => String(s).replace(/@@ASSET\d+@@/g, (t) => tokenMap.get(t) ?? t);
  for (const p of pages) p.out = detok(p.out);
  const assetOk = (t) => t && /^\/docs-assets\//.test(tokenMap.get(t) ?? "");
  if (brandTokens.logo && assetOk(brandTokens.logo.light)) {
    brandOut.logo = { light: detok(brandTokens.logo.light), ...(assetOk(brandTokens.logo.dark) ? { dark: detok(brandTokens.logo.dark) } : {}), alt: brandTokens.logo.alt };
  }
  if (assetOk(brandTokens.favicon)) brandOut.favicon = detok(brandTokens.favicon);

  /* redirects */
  const redirects = {};
  const ourPaths = new Set(pages.map((p) => p.path));
  const addRedirect = (fromRaw, to, why) => {
    let from = String(fromRaw ?? "").trim();
    if (!from) return;
    if (!from.startsWith("/")) from = "/" + from;
    from = from.replace(/\/+$/, "").replace(/\.(md|mdx)$/i, "") || "/";
    if (from === "/" || from === to) return;
    if (/[:*?#\s]/.test(from)) return siteNotes.push(`redirect ${from} → ${to} not added: patterns aren't supported`);
    if (ourPaths.has(from)) return siteNotes.push(`redirect ${from} → ${to} not added: ${from} is a page of the import (${why})`);
    if (!(to.startsWith("/") || /^https:\/\//.test(to))) return siteNotes.push(`redirect ${from} → ${to} not added: the target isn't a page or an https address`);
    redirects[from] = to;
  };
  for (const r of redirectList) addRedirect(r.from, r.to, r.why);
  for (const r of navRes.redirects ?? []) {
    let to = null;
    if (r.toFile !== undefined) to = r.toFile && byFile.get(r.toFile) && (byFile.get(r.toFile).skipped ?? byFile.get(r.toFile)).path;
    else if (r.ref) {
      const d = String(r.to ?? "");
      const hash = d.includes("#") ? d.slice(d.indexOf("#")) : "";
      if (/^https:\/\//.test(d)) to = d;
      else {
        const f = mod.refFile?.(env, d);
        to = f && byFile.get(f) ? byFile.get(f).path + hash : null;
      }
    }
    if (!to) {
      siteNotes.push(`redirect ${r.from} → ${r.raw ?? r.to ?? r.toFile} not added: its target isn't a page of the import`);
      continue;
    }
    addRedirect(r.from, to, "format redirect");
  }

  /* OpenAPI files */
  const openapi = [...(mod.openapi?.(env) ?? [])];
  for (const f of [...src.files].sort()) {
    if (openapi.length >= 20) break;
    if ((navRes.excludeDirs ?? []).some((d) => f.startsWith(d + "/"))) continue;
    if (within(f, det.folder) && /(^|\/)(openapi|swagger)[^/]*\.(json|ya?ml)$/i.test(f) && !openapi.some((o) => o.path === f)) openapi.push({ path: f, from: "found" });
  }

  /* site.json */
  const anyDescription = pages.some((p) => p.description);
  const site = {
    name,
    ...(str(b.description) ? { description: str(b.description) } : {}),
    ...(tabs.length ? { tabs } : {}),
    nav,
    pages: { ...((mod.name === "mintlify" || mod.name === "gitbook") && anyDescription ? { showDescription: true } : {}), ...(pages.some((p) => p.icon) ? { icons: true } : {}) },
    brand: brandOut,
  };

  /* report */
  const pathOf = (file) => byFile.get(file)?.path ?? (file === "site.json" ? "site.json" : file);
  const at = (x) => ({ page: pathOf(x.file), file: x.file, line: x.line || null });
  const navNotes = siteNotes.map((message) => ({ page: null, file: det.config ?? null, line: null, kind: "nav", message }));
  const hidden = pages.filter((p) => p.path !== "/" && !placed.has(p.path));
  const sourceLabel = gh ? `github:${gh.owner}/${gh.name}@${ref || branch || "HEAD"}/${det.folder}` : `local:${path.basename(src.root ?? dir ?? ".")}/${det.folder}`;
  const unmatchedIcons = [...unmatched].map(([icon, where]) => ({ icon, pages: where }));
  const items = {
    brokenLinks: broken.map((x) => ({ ...at(x), href: x.href, reason: x.reason })),
    missing: missing.map((x) => ({ ...at(x), src: x.src, reason: x.reason })),
    keptOriginal: keptOriginal.map((x) => ({ ...at(x), src: x.src, reason: x.reason })),
    notes: [...issues.map((x) => ({ ...at(x), kind: x.kind, message: x.message })), ...navNotes],
    hidden: hidden.map((p) => ({ page: p.path, title: p.title, file: p.file })),
    altGenerated: altGenerated.map((x) => ({ ...at(x), alt: x.alt })),
    unmatchedIcons,
    external: external.map((x) => (x.file ? { ...at(x), href: x.href, url: x.url } : { title: x.title, href: x.href })),
  };
  const okAssets = [...assets.values()].filter((a) => a.rel);
  const report = {
    format: "markdrop-docs-import/1",
    source: sourceLabel,
    repoFormat: det.format,
    repo: gh ? `${gh.owner}/${gh.name}` : null,
    ref: ref || null,
    branch: branch || null,
    folder: det.folder,
    contentRoot: det.contentRoot,
    imported: today,
    site: name,
    counts: {
      pages: pages.length,
      groups: nav.length,
      tabs: tabs.length,
      images: okAssets.filter((a) => a.kind === "image").length,
      files: okAssets.filter((a) => a.kind === "file").length,
      assetBytes: okAssets.reduce((n, a) => n + (a.bytes ?? 0), 0),
      svgsDrawn,
      notes: items.notes.length,
      brokenLinks: broken.length,
      missing: missing.length,
      keptOriginal: keptOriginal.length,
      redirects: Object.keys(redirects).length,
      hidden: hidden.length,
      altGenerated: altGenerated.length,
      unmatchedIcons: unmatchedIcons.length,
      external: items.external.length,
      videos: Object.keys(videos).length,
    },
    conversions: Object.fromEntries([...counts].map(([k, m]) => [k, Object.fromEntries(m)])),
    items,
    openapi,
  };
  const origins = Object.fromEntries(pages.map((p) => [p.path, p.file]).sort((x, y) => (x[0] < y[0] ? -1 : 1)));

  const outPages = pages.map((p) => ({
    path: p.path,
    file: p.file,
    title: p.title,
    description: p.description,
    nav: p.navTitle && p.navTitle !== p.title && p.navTitle.length <= 40 ? p.navTitle : null,
    icon: p.icon ?? null,
    updated: today,
    body: p.out,
  }));
  return {
    dir: src.root ?? (dir ? path.resolve(dir) : null),
    source: src,
    det,
    format: det.format,
    site,
    pages: outPages,
    redirects: Object.fromEntries(Object.entries(redirects).sort()),
    videos,
    assets: okAssets.map((a) => ({ rel: a.rel, from: a.repoPath, kind: a.kind, ...(a.data ? { data: a.data } : {}) })),
    report,
    reportMd: reportMarkdown(report, counts),
    origins,
    openapi,
  };
}

/* ── output ──────────────────────────────────────────────────────────────── */

/** A YAML scalar: plain when that's safe, else JSON-quoted (as gitbook.mjs writes front matter). */
export const yamlStr = (s) => (/^[\w(][^:#]*$/.test(s) && !/^(true|false|null|yes|no|on|off|~|\d[\d.]*)$/i.test(s) && !/[\s]$/.test(s) && !/[{}[\],&*!|>'"%@`]/.test(s[0]) ? s : JSON.stringify(s));

/** A page's file text (front matter + body). */
export function pageText(p) {
  const fm = ["---", `title: ${yamlStr(p.title)}`];
  if (p.nav) fm.push(`nav: ${yamlStr(p.nav)}`);
  fm.push(`description: ${yamlStr(p.description ?? "")}`, `updated: ${p.updated}`);
  if (p.icon) fm.push(`icon: ${p.icon}`);
  fm.push("---", "");
  return fm.join("\n") + "\n" + p.body;
}

function reportMarkdown(r, counts) {
  const R = [];
  const c = r.counts;
  const line = (x) => `\`${x.page ?? x.file ?? ""}\`${x.line ? `:${x.line}` : ""}`;
  R.push(`# Import report: ${r.site}`, "");
  R.push(`Source: ${r.source} (${r.repoFormat}), imported ${r.imported} by scripts/docs-import/github.mjs. Content root: \`${r.contentRoot || "/"}\`.`, "");
  R.push("## Summary", "", "| | |", "| --- | --- |");
  R.push(`| Pages | ${c.pages} (${c.pages - c.hidden} in the sidebar, ${c.hidden} not in it) |`);
  R.push(`| Nav | ${c.groups} groups${c.tabs ? `, ${c.tabs} tabs` : ""} |`);
  R.push(`| Assets | ${c.images} images, ${c.files} files, ${(c.assetBytes / 1048576).toFixed(1)} MB${c.svgsDrawn ? `, ${c.svgsDrawn} SVGs drawn into PNGs` : ""} |`);
  R.push(`| Problems | ${c.notes} notes, ${c.brokenLinks} broken links, ${c.missing} missing files, ${c.keptOriginal} left where they are |`);
  R.push(`| Redirects | ${c.redirects} |`, "");
  R.push("## Blocks found and how they were converted", "", "| Block | Count | Converted to |", "| --- | ---: | --- |");
  for (const [kind, hows] of counts) for (const [how, n] of hows) R.push(`| \`${kind.replace(/\|/g, "\\|")}\` | ${n} | ${how} |`);
  R.push("");
  const section = (title, rows, render) => {
    R.push(`## ${title}`, "");
    if (!rows.length) R.push("None.");
    else for (const x of rows.slice(0, 500)) R.push(render(x));
    if (rows.length > 500) R.push(`- … and ${rows.length - 500} more`);
    R.push("");
  };
  section("Notes (check these)", r.items.notes, (x) => `- ${line(x)} **${x.kind}**: ${x.message}`);
  section("Broken links", r.items.brokenLinks, (x) => `- ${line(x)} \`${x.href}\`: ${x.reason}`);
  section("Missing images and files", r.items.missing, (x) => `- ${line(x)} ${x.src}: ${x.reason}`);
  section("Left where they are (not copied)", r.items.keptOriginal, (x) => `- ${line(x)} ${x.src}: ${x.reason}`);
  section("Links to other repo files (now GitHub links)", r.items.external.filter((x) => x.url), (x) => `- ${line(x)} \`${x.href}\` → ${x.url}`);
  section("Sidebar links that aren't pages (not imported)", r.items.external.filter((x) => !x.url), (x) => `- [${x.title}](${x.href})`);
  section("Pages not in the sidebar (imported, hidden)", r.items.hidden, (x) => `- \`${x.page}\` ${x.title} (${x.file})`);
  section("Alt text written by the importer", r.items.altGenerated, (x) => `- ${line(x)} “${x.alt}”`);
  section("Icons without a match (left out)", r.items.unmatchedIcons, (x) => `- \`${x.icon}\`: ${x.pages.join(", ")}`);
  section("OpenAPI files", r.openapi, (x) => `- \`${x.path}\` (${x.from})`);
  return R.join("\n");
}

/**
 * Writes a convertRepo result into `out` (emptied first, except .cache). Refuses a folder that
 * looks like a project (.git or package.json).
 */
export function writeOutput(result, out) {
  const OUT = path.resolve(out);
  if (fs.existsSync(path.join(OUT, ".git")) || fs.existsSync(path.join(OUT, "package.json"))) throw new ImportError(`refusing to empty ${OUT}: it looks like a project folder`);
  fs.mkdirSync(OUT, { recursive: true });
  for (const e of fs.readdirSync(OUT)) if (e !== ".cache") fs.rmSync(path.join(OUT, e), { recursive: true, force: true });
  const write = (rel, data) => {
    const f = path.join(OUT, ...rel.split("/"));
    if (!f.startsWith(OUT + path.sep)) throw new ImportError(`refusing to write outside ${OUT}: ${rel}`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, data);
  };
  for (const p of result.pages) write(p.path === "/" ? "index.md" : `${p.path.slice(1)}.md`, pageText(p));
  for (const a of result.assets) {
    const data = a.data ?? result.source?.readBytes?.(a.from);
    if (data) write(`public/docs-assets/${a.rel}`, data);
  }
  write("site.json", JSON.stringify(result.site, null, 2) + "\n");
  write("redirects.json", JSON.stringify(result.redirects, null, 2) + "\n");
  if (Object.keys(result.videos).length) write("videos.json", JSON.stringify(result.videos, null, 2) + "\n");
  write("_origins.json", JSON.stringify(result.origins, null, 2) + "\n");
  write("_import-report.json", JSON.stringify(result.report, null, 2) + "\n");
  write("_IMPORT_REPORT.md", result.reportMd);
  return OUT;
}
