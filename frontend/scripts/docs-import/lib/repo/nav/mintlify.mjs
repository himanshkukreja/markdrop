/**
 * Mintlify: mint.json (navigation: [{group, pages}], tabs, anchors, logo, favicon, colors, name,
 * redirects, openapi) or docs.json (navigation: {tabs | anchors | dropdowns | groups | pages |
 * versions | languages}, menus inside tabs, `global` anchors, the same brand keys). `$ref` parts
 * (`{"$ref": "./redirects.json"}`) are read from the project folder.
 *
 * - Page references ("quickstart", "api/get", {page: "x"}) are files under the project folder
 *   (.mdx, else .md). Nested groups flatten into their parent, a group's `root` page leads it.
 * - Tabs (and anchors, dropdowns) become the engine's tabs (site.json tabs + group.tab); `href`
 *   entries to other sites are links, not pages (reported).
 * - `hidden: true` tabs, groups or pages: imported, left out of the sidebar.
 * - versions / languages: the first one is the guide; pages only the others list aren't imported.
 */
import { humanize, joinRepo, normRepoPath, pathSegment, resolveRepo } from "../paths.mjs";
import { folderNav } from "./folders.mjs";

/** Resolves `{"$ref": "./x.json"}` objects (files under `root`, 5 deep at most). */
export function resolveRefs(value, { from, root, readText, depth = 0, seen = new Set() }) {
  if (depth > 5 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, { from, root, readText, depth, seen }));
  if (typeof value.$ref === "string" && !/^[a-z]+:/i.test(value.$ref)) {
    const target = resolveRepo(from, value.$ref);
    if (!target || seen.has(target) || (root && !target.startsWith(root + "/"))) return {};
    try {
      const v = JSON.parse(readText(target) ?? "null");
      const rest = Object.fromEntries(Object.entries(value).filter(([k]) => k !== "$ref"));
      const merged = v && typeof v === "object" && !Array.isArray(v) ? { ...v, ...rest } : v;
      return resolveRefs(merged, { from: target, root, readText, depth: depth + 1, seen: new Set([...seen, target]) });
    } catch {
      return {};
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = resolveRefs(v, { from, root, readText, depth, seen });
  return out;
}

function readConfig(env) {
  if (!env.det.config) return null;
  try {
    const raw = JSON.parse(env.readText(env.det.config) ?? "");
    return resolveRefs(raw, { from: env.det.config, root: env.det.folder, readText: env.readText });
  } catch {
    env.note(`${env.det.config} isn't valid JSON: the sidebar follows the folders`);
    return null;
  }
}

/** A page reference → its file (under the project folder), or null. */
export function mintlifyPageFile(ref, root, files) {
  const r = normRepoPath(String(ref ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.(mdx|md)$/i, ""));
  if (r === null || r === "") return null;
  for (const ext of [".mdx", ".md"]) {
    const f = joinRepo(root, r + ext);
    if (files.has(f)) return f;
  }
  for (const idx of ["/index.mdx", "/index.md"]) {
    const f = joinRepo(root, r + idx);
    if (files.has(f)) return f;
  }
  return null;
}

const isExternal = (h) => typeof h === "string" && /^[a-z][a-z0-9+.-]*:/i.test(h);

/**
 * A pages array → { refs, hidden, links }: page references in order (nested groups flattened, a
 * group's root first), references under `hidden`, and links to other sites.
 */
function walkPages(pages, acc = { refs: [], hidden: [], links: [] }, hidden = false) {
  for (const p of Array.isArray(pages) ? pages : []) {
    if (typeof p === "string") (hidden ? acc.hidden : acc.refs).push(p);
    else if (p && typeof p === "object") {
      const h = hidden || p.hidden === true;
      if (typeof p.page === "string") (h ? acc.hidden : acc.refs).push(p.page);
      else if (isExternal(p.href) && !p.pages && !p.groups) acc.links.push({ title: p.title ?? p.label ?? p.group ?? p.href, href: p.href });
      if (typeof p.root === "string") (h ? acc.hidden : acc.refs).push(p.root);
      walkPages(p.pages, acc, h);
      for (const k of ["groups", "tabs", "anchors", "menu", "dropdowns"]) if (Array.isArray(p[k])) for (const g of p[k]) walkPages([g], acc, h || g?.hidden === true);
    }
  }
  return acc;
}

/** A docs.json navigation section → { groups: [{group, refs, icon, hidden}], links }. */
function sectionGroups(sec, hidden = false) {
  const groups = [];
  const links = [];
  if (!sec || typeof sec !== "object") return { groups, links };
  const groupOf = (g) => {
    const w = walkPages([...(g.root ? [g.root] : []), ...(g.pages ?? [])], undefined, hidden || g.hidden === true);
    links.push(...w.links);
    return { group: g.group ?? "Docs", refs: w.refs, hiddenRefs: w.hidden, icon: g.icon };
  };
  if (Array.isArray(sec.groups)) for (const g of sec.groups) if (g && typeof g === "object") groups.push(groupOf(g));
  if (Array.isArray(sec.pages)) {
    let run = [];
    const flush = () => {
      if (run.length) groups.push(groupOf({ group: groups.length ? "More" : "Getting started", pages: run }));
      run = [];
    };
    for (const p of sec.pages) {
      if (p && typeof p === "object" && p.group) {
        flush();
        groups.push(groupOf(p));
      } else run.push(p);
    }
    flush();
  }
  // Menus, anchors or dropdowns inside a tab: their groups join it.
  for (const k of ["menu", "anchors", "dropdowns", "tabs"]) {
    if (!Array.isArray(sec[k])) continue;
    for (const item of sec[k]) {
      if (!item || typeof item !== "object") continue;
      if (isExternal(item.href) && !item.groups && !item.pages) {
        links.push({ title: item.item ?? item.anchor ?? item.dropdown ?? item.tab ?? item.href, href: item.href });
        continue;
      }
      const inner = sectionGroups(item, hidden || item.hidden === true);
      groups.push(...inner.groups);
      links.push(...inner.links);
    }
  }
  return { groups, links };
}

/**
 * docs.json navigation → { sections: [{ label, icon, groups, hidden }], links, others } where `others`
 * are the page references of the versions/languages after the first (not imported).
 */
export function docsJsonNav(nav) {
  let n = nav;
  const others = [];
  const otherDirs = [];
  for (let guard = 0; guard < 6 && n && typeof n === "object"; guard++) {
    const key = Array.isArray(n.versions) && n.versions.length ? "versions" : Array.isArray(n.languages) && n.languages.length ? "languages" : null;
    if (!key) break;
    const list = n[key].filter((x) => x && typeof x === "object");
    const first = list.find((x) => x.default === true) ?? list[0];
    for (const o of list) {
      if (o === first) continue;
      others.push(...walkPages([o]).refs, ...walkPages([o]).hidden);
      // A language's own folder (fr/, es/…): its pages belong to that language.
      if (key === "languages" && typeof o.language === "string" && /^[a-z]{2}(-[a-z0-9]+)?$/i.test(o.language)) otherDirs.push(o.language);
    }
    n = first;
  }
  const links = [];
  for (const a of Array.isArray(nav?.global?.anchors) ? nav.global.anchors : []) if (isExternal(a?.href)) links.push({ title: a.anchor ?? a.href, href: a.href });
  if (!n || typeof n === "object" === false) return { sections: [], links, others, otherDirs };
  for (const [key, labelKey] of [["tabs", "tab"], ["anchors", "anchor"], ["dropdowns", "dropdown"]]) {
    if (!Array.isArray(n[key]) || !n[key].length) continue;
    const sections = [];
    for (const t of n[key]) {
      if (!t || typeof t !== "object") continue;
      if (isExternal(t.href) && !t.groups && !t.pages && !t.menu) {
        links.push({ title: t[labelKey] ?? t.href, href: t.href });
        continue;
      }
      const s = sectionGroups(t, t.hidden === true);
      links.push(...s.links);
      if (s.groups.length) sections.push({ label: t[labelKey] ?? t.name ?? "Docs", icon: t.icon, groups: s.groups, hidden: t.hidden === true });
    }
    return { sections, links, others, otherDirs };
  }
  const s = sectionGroups(n);
  return { sections: [{ label: null, groups: s.groups }], links: [...links, ...s.links], others, otherDirs };
}

/** Back-compat: the sections alone. */
export const docsJsonSections = (nav) => docsJsonNav(nav).sections;

/** mint.json navigation + tabs → sections like docsJsonNav. */
export function mintJsonSections(cfg) {
  const groups = (Array.isArray(cfg.navigation) ? cfg.navigation : [])
    .filter((g) => g && typeof g === "object")
    .map((g) => {
      const w = walkPages(g.pages, undefined, g.hidden === true);
      return { group: g.group ?? "Docs", refs: w.refs, hiddenRefs: w.hidden, icon: g.icon };
    });
  const tabs = [...(Array.isArray(cfg.tabs) ? cfg.tabs : []), ...(Array.isArray(cfg.anchors) ? cfg.anchors : [])]
    .filter((t) => t?.url && !isExternal(t.url))
    .map((t) => ({ label: t.name ?? humanize(t.url), url: String(t.url).replace(/^\/+|\/+$/g, "") }));
  if (!tabs.length) return [{ label: null, groups }];
  const primary = { label: cfg.primaryTab?.name ?? "Documentation", groups: [] };
  const sections = [primary, ...tabs.map((t) => ({ ...t, groups: [] }))];
  for (const g of groups) {
    const first = String(g.refs[0] ?? "").replace(/^\/+/, "");
    const tab = tabs.find((t) => first === t.url || first.startsWith(t.url + "/"));
    (tab ? sections.find((s) => s.url === tab.url) : primary).groups.push(g);
  }
  return sections.filter((s) => s.groups.length);
}

/** Every OpenAPI file a config names (strings, arrays, {source}), repo paths that exist. */
function configOpenapi(cfg, root, files, from) {
  const found = [];
  const add = (v) => {
    if (typeof v === "string") {
      if (/^[a-z]+:\/\//i.test(v)) return;
      const p = joinRepo(root, normRepoPath(v.replace(/^\.?\/+/, "")) ?? "");
      if (p && files.has(p) && !found.some((x) => x.path === p)) found.push({ path: p, from });
    } else if (Array.isArray(v)) v.forEach(add);
    else if (v && typeof v === "object" && typeof v.source === "string") add(v.source);
  };
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== "object" || depth > 14) return;
    if (Array.isArray(o)) return o.forEach((x) => walk(x, depth + 1));
    for (const [k, v] of Object.entries(o)) {
      if (k === "openapi") add(v);
      else walk(v, depth + 1);
    }
  };
  walk(cfg);
  return found;
}

/** Files Mintlify never treats as pages, and `.mintignore` patterns (a gitignore subset). */
const AUTO_IGNORED = /(^|\/)(readme|license|changelog|contributing)\.md$/i;
export function mintignore(text) {
  const pats = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("!"));
  const res = pats.map((p) => {
    const anchored = p.startsWith("/");
    const dir = p.endsWith("/");
    const body = p.replace(/^\/|\/$/g, "").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, "(?:.*/)?");
    return new RegExp(`${anchored || body.includes("/") ? "^" : "(^|/)"}${body}${dir ? "/" : "(/|$)"}`);
  });
  return (rel) => res.some((re) => re.test(rel));
}

export default {
  name: "mintlify",
  flavor: "mintlify",
  /** Mintlify's address for a file: its path without the extension; only `index` stands for its folder. */
  natural(page) {
    const segs = page.rel.replace(/\.(md|mdx)$/i, "").split("/");
    if (/^index$/i.test(segs[segs.length - 1])) segs.pop();
    return segs;
  },
  /** Pages Mintlify itself would never serve (README, LICENSE…, `.mintignore`). */
  ignore(env) {
    const ig = mintignore(env.readText(joinRepo(env.det.folder, ".mintignore")) ?? "");
    return (rel) => AUTO_IGNORED.test(rel) || ig(rel);
  },
  nav(env) {
    const cfg = readConfig(env);
    const root = env.det.contentRoot;
    if (!cfg) {
      const f = folderNav(env.pages, { root });
      return { groups: f.groups, tabs: [], navTitles: new Map(), home: f.home, redirects: [] };
    }
    env.config = cfg;
    const isDocsJson = /docs\.json$/.test(env.det.config);
    const parsed = isDocsJson ? docsJsonNav(cfg.navigation) : { sections: mintJsonSections(cfg), links: [], others: [] };
    for (const l of parsed.links) env.external.push(l);
    if (!isDocsJson) for (const a of Array.isArray(cfg.anchors) ? cfg.anchors : []) if (isExternal(a?.url)) env.external.push({ title: a.name ?? a.url, href: a.url });
    const sections = parsed.sections.filter((s) => !s.hidden);
    const useTabs = sections.length > 1;
    const tabs = [];
    const groups = [];
    const missing = new Set();
    const fileOf = (ref) => {
      const f = mintlifyPageFile(ref, root, env.files);
      if (f && env.byFile.has(f)) return f;
      missing.add(ref);
      return null;
    };
    for (const s of sections) {
      let tabId;
      if (useTabs) {
        tabId = pathSegment(s.label ?? "docs");
        while (tabs.some((t) => t.id === tabId)) tabId += "-2";
        tabs.push({ id: tabId, label: s.label ?? "Docs" });
      }
      for (const g of s.groups) {
        const files = g.refs.map(fileOf).filter(Boolean);
        for (const r of g.hiddenRefs ?? []) fileOf(r);
        if (!files.length) continue;
        const icon = g.icon && typeof g.icon === "string" ? env.iconFor(g.icon, { where: `group “${g.group}”` }) : undefined;
        groups.push({ group: g.group, files, ...(icon ? { icon } : {}), ...(tabId ? { tab: tabId } : {}) });
      }
    }
    for (const ref of missing) env.note(`The navigation lists “${ref}”, which has no .mdx or .md file: left out`);
    // Pages only another version or language lists: not part of this guide.
    const listed = new Set(groups.flatMap((g) => g.files));
    const dirs = (parsed.otherDirs ?? []).map((d) => joinRepo(root, d));
    const inOtherDir = (f) => dirs.some((d) => f.startsWith(d + "/"));
    const exclude = [...new Set([...parsed.others.map((r) => mintlifyPageFile(r, root, env.files)), ...env.pages.map((p) => p.file).filter(inOtherDir)])].filter((f) => f && !listed.has(f));
    if (exclude.length) env.note(`${exclude.length} pages of other versions or languages were left out (the first one is imported)`);
    // Redirects of the languages left out aren't this guide's.
    const otherLang = (src) => (parsed.otherDirs ?? []).some((d) => String(src ?? "").replace(/^\/+/, "").startsWith(d + "/"));
    const redirects = (Array.isArray(cfg.redirects) ? cfg.redirects : []).filter((r) => r && typeof r === "object" && !otherLang(r.source)).map((r) => ({ from: r.source, to: r.destination, ref: true }));
    return { groups, tabs, navTitles: new Map(), home: null, redirects, exclude, excludeDirs: dirs };
  },
  /** A redirect destination ("/quickstart") → a page file. */
  refFile(env, ref) {
    return mintlifyPageFile(String(ref ?? "").split("#")[0], env.det.contentRoot, env.files);
  },
  brand(env) {
    const cfg = env.config;
    if (!cfg) return {};
    const root = env.det.contentRoot;
    const file = (v) => (typeof v === "string" && !/^[a-z]+:/i.test(v) ? joinRepo(root, normRepoPath(v.replace(/^\.?\/+/, "")) ?? "") || null : null);
    const pair = (v) => (typeof v === "string" ? { light: file(v) } : v && typeof v === "object" ? { light: file(v.light), dark: file(v.dark) } : null);
    const logo = pair(cfg.logo);
    const favicon = pair(cfg.favicon);
    const hex = (v) => (typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v.trim()) ? v.trim() : undefined);
    return {
      name: typeof cfg.name === "string" ? cfg.name : undefined,
      description: typeof cfg.description === "string" ? cfg.description : undefined,
      logo: logo?.light ? { light: logo.light, ...(logo.dark && logo.dark !== logo.light ? { dark: logo.dark } : {}) } : undefined,
      favicon: favicon?.light ?? favicon?.dark ?? undefined,
      accent: hex(cfg.colors?.primary),
      accentDark: hex(cfg.colors?.light),
    };
  },
  openapi(env) {
    if (!env.config) return [];
    return configOpenapi(env.config, env.det.contentRoot, env.files, /docs\.json$/.test(env.det.config) ? "docs.json" : "mint.json");
  },
};
