/**
 * Which docs format a repo folder holds, where its pages are, and which folders to offer
 * (pure: `paths` is the repo's file list, `readFile(path)` → text | null). The backend's preview
 * (services/docs_github) follows the same rules; keep the two in step.
 *
 *   1. mintlify    F/docs.json (a JSON object with `navigation`) or F/mint.json; content root F
 *   2. gitbook     F/.gitbook.yaml (content root F/<root:>) or F/SUMMARY.md (content root F)
 *   3. mkdocs      F/mkdocs.yml|yaml; content root F/<docs_dir> (default docs)
 *   4. docusaurus  F/docusaurus.config.{js,ts,mjs,cjs}; content root F/docs (or the docs `path:`)
 *   5. markdown    content root F
 */
import { parse as parseYaml } from "yaml";
import { IGNORED_DIRS, baseOf, dirOf, joinRepo, normRepoPath, relTo, within } from "./paths.mjs";

export const FORMATS = ["markdown", "gitbook", "mintlify", "docusaurus", "mkdocs"];
export const PAGE_FILE = /\.(md|mdx)$/i;
const DOCUSAURUS_CONFIGS = ["docusaurus.config.js", "docusaurus.config.ts", "docusaurus.config.mjs", "docusaurus.config.cjs"];

const has = (set, p) => set.has(p);
const asSet = (paths) => (paths instanceof Set ? paths : new Set(paths));

function readJson(readFile, p) {
  const t = readFile(p);
  if (t == null) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
function readYaml(readFile, p) {
  const t = readFile(p);
  if (t == null) return null;
  try {
    const v = parseYaml(t, { logLevel: "silent" });
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/** A relative folder from a config (`./docs/`, `docs`) under F, or null when it leaves F. */
function subFolder(F, rel) {
  const r = normRepoPath(String(rel ?? "").trim().replace(/^\.\/+/, "").replace(/\/+$/, ""));
  if (r === null) return null;
  return joinRepo(F, r);
}

/** The docs plugin's `path:` in a Docusaurus config, read as text (never run). */
export function docusaurusDocsPath(configText) {
  const s = String(configText ?? "");
  const at = s.search(/\bdocs\s*:\s*\{/);
  const scope = at >= 0 ? s.slice(at, at + 2000) : "";
  const m = /\bpath\s*:\s*['"`]([^'"`]+)['"`]/.exec(scope) ?? /plugin-content-docs['"`][\s\S]{0,400}?\bpath\s*:\s*['"`]([^'"`]+)['"`]/.exec(s);
  return m ? m[1] : null;
}

/** The docs plugin's `routeBasePath:` ("docs" by default; "" when the docs are the site root). */
export function docusaurusRouteBase(configText) {
  const s = String(configText ?? "");
  const at = s.search(/\bdocs\s*:\s*\{/);
  const scope = at >= 0 ? s.slice(at, at + 2000) : s;
  const m = /\brouteBasePath\s*:\s*['"`]([^'"`]*)['"`]/.exec(scope);
  return m ? m[1].replace(/^\/+|\/+$/g, "") : "docs";
}

/**
 * The format of folder `F` → { format, folder, contentRoot, config, staticDir? } (`format` forces one:
 * its content root is still found the same way, falling back to F).
 */
export function detectFormat(paths, readFile, folder = "", format = "auto") {
  const set = asSet(paths);
  const F = normRepoPath(folder) ?? "";
  const at = (name) => joinRepo(F, name);
  const want = (f) => format === "auto" || !format || format === f;

  if (want("mintlify")) {
    const docs = has(set, at("docs.json")) ? readJson(readFile, at("docs.json")) : null;
    if (docs && "navigation" in docs) return { format: "mintlify", folder: F, contentRoot: F, config: at("docs.json") };
    if (has(set, at("mint.json"))) return { format: "mintlify", folder: F, contentRoot: F, config: at("mint.json") };
    if (format === "mintlify") return { format, folder: F, contentRoot: F, config: null };
  }
  if (want("gitbook")) {
    if (has(set, at(".gitbook.yaml"))) {
      const y = readYaml(readFile, at(".gitbook.yaml")) ?? {};
      const root = (y.root && subFolder(F, y.root)) ?? F;
      return { format: "gitbook", folder: F, contentRoot: root, config: at(".gitbook.yaml") };
    }
    if (has(set, at("SUMMARY.md"))) return { format: "gitbook", folder: F, contentRoot: F, config: null };
    if (format === "gitbook") return { format, folder: F, contentRoot: F, config: null };
  }
  if (want("mkdocs")) {
    const cfg = has(set, at("mkdocs.yml")) ? at("mkdocs.yml") : has(set, at("mkdocs.yaml")) ? at("mkdocs.yaml") : null;
    if (cfg || format === "mkdocs") {
      const y = cfg ? readYaml(readFile, cfg) ?? {} : {};
      const root = subFolder(F, typeof y.docs_dir === "string" ? y.docs_dir : "docs") ?? at("docs");
      return { format: "mkdocs", folder: F, contentRoot: root, config: cfg };
    }
  }
  if (want("docusaurus")) {
    const cfg = DOCUSAURUS_CONFIGS.map(at).find((p) => has(set, p)) ?? null;
    if (cfg || format === "docusaurus") {
      const text = cfg ? readFile(cfg) ?? "" : "";
      const rel = docusaurusDocsPath(text);
      const root = (rel && subFolder(F, rel)) ?? at("docs");
      return { format: "docusaurus", folder: F, contentRoot: root, config: cfg, staticDir: at("static"), routeBase: docusaurusRouteBase(text) };
    }
  }
  return { format: "markdown", folder: F, contentRoot: F, config: null };
}

/** Whether a page file sits under a hidden, private or vendored folder (relative to the content root). */
function skippedPage(rel, format) {
  const segs = rel.split("/");
  for (const s of segs.slice(0, -1)) if (s.startsWith(".") || s.startsWith("_") || s === "node_modules") return true;
  const name = segs[segs.length - 1];
  if (name.startsWith(".")) return true;
  if (format === "docusaurus" && name.startsWith("_")) return true;
  return false;
}

/** The page files of a detected folder (repo paths, sorted). */
export function listPages(paths, det) {
  const out = [];
  for (const p of paths) {
    if (!PAGE_FILE.test(p) || !within(p, det.contentRoot)) continue;
    const rel = relTo(p, det.contentRoot);
    if (skippedPage(rel, det.format)) continue;
    if (det.format === "gitbook" && /^summary\.md$/i.test(rel)) continue;
    if (det.format === "mintlify" && (/^readme\.mdx?$/i.test(rel) || rel.startsWith("snippets/"))) continue;
    out.push(p);
  }
  return out.sort();
}

const ignored = (p) => p.split("/").some((s) => IGNORED_DIRS.has(s));

/** Folders to offer in the picker, in the spec's order, deduped. */
export function suggestFolders(paths, readFile) {
  const list = [...paths].filter((p) => !ignored(p));
  const out = [];
  const add = (f) => {
    if (!out.includes(f)) out.push(f);
  };
  const byDepth = (a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0);
  const foldersOf = (test) => [...new Set(list.filter((p) => test(baseOf(p), p)).map(dirOf))].sort(byDepth);
  foldersOf((n, p) => n === "mint.json" || (n === "docs.json" && (!readFile || "navigation" in (readJson(readFile, p) ?? {})))).forEach(add);
  if (list.includes(".gitbook.yaml")) add("");
  foldersOf((n) => n === "SUMMARY.md").forEach(add);
  foldersOf((n) => n === "mkdocs.yml" || n === "mkdocs.yaml").forEach(add);
  foldersOf((n) => DOCUSAURUS_CONFIGS.includes(n)).forEach(add);
  for (const f of ["docs", "website/docs", "documentation"]) if (list.some((p) => within(p, f) && p !== f && PAGE_FILE.test(p))) add(f);
  add("");
  return out;
}

/** Each suggested folder with its format and page count (the backend's inspect `folders`). */
export function inspectFolders(paths, readFile) {
  const set = asSet(paths);
  return suggestFolders(set, readFile).map((f) => {
    const det = detectFormat(set, readFile, f);
    return { path: f, format: det.format, pages: listPages(set, det).length };
  });
}
