/**
 * Mintlify: mint.json (navigation: [{group, pages}], tabs, anchors, logo, favicon, colors, name,
 * redirects, openapi) or docs.json (navigation: {tabs | groups | pages | anchors | dropdowns |
 * versions | languages}, the same brand keys). Page references ("quickstart", "api/get") are files
 * under the project folder (.mdx, else .md). Nested groups flatten into their parent; tabs become
 * the engine's tabs (site.json tabs + group.tab).
 */
import { humanize, joinRepo, normRepoPath, pathSegment } from "../paths.mjs";
import { folderNav } from "./folders.mjs";

function readConfig(env) {
  if (!env.det.config) return null;
  try {
    return JSON.parse(env.readText(env.det.config) ?? "");
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
  return null;
}

/** Every page reference in a pages array, nested groups flattened, in order. */
function flattenPages(pages, out = []) {
  for (const p of Array.isArray(pages) ? pages : []) {
    if (typeof p === "string") out.push(p);
    else if (p && typeof p === "object") {
      if (p.root) out.push(p.root);
      flattenPages(p.pages, out);
      for (const k of ["groups", "tabs", "anchors"]) if (Array.isArray(p[k])) for (const g of p[k]) flattenPages(g.pages ?? [], out);
    }
  }
  return out;
}

/** A docs.json navigation section → its groups: [{ group, refs, icon? }]. */
function sectionGroups(sec) {
  const groups = [];
  if (!sec || typeof sec !== "object") return groups;
  if (Array.isArray(sec.groups)) for (const g of sec.groups) groups.push({ group: g.group ?? "Docs", refs: flattenPages([...(g.root ? [g.root] : []), ...(g.pages ?? [])]), icon: g.icon });
  if (Array.isArray(sec.pages)) {
    let run = [];
    const flush = () => {
      if (run.length) groups.push({ group: groups.length ? "More" : "Getting started", refs: run });
      run = [];
    };
    for (const p of sec.pages) {
      if (typeof p === "string") run.push(p);
      else if (p?.group) {
        flush();
        groups.push({ group: p.group, refs: flattenPages([...(p.root ? [p.root] : []), ...(p.pages ?? [])]), icon: p.icon });
      }
    }
    flush();
  }
  return groups;
}

/** docs.json navigation → [{ label, icon?, groups }] (one section with label null when there are no tabs). */
export function docsJsonSections(nav) {
  let n = nav;
  for (let guard = 0; guard < 6 && n && typeof n === "object"; guard++) {
    if (Array.isArray(n.versions) && n.versions.length) n = n.versions[0];
    else if (Array.isArray(n.languages) && n.languages.length) n = n.languages[0];
    else break;
  }
  if (!n || typeof n !== "object") return [];
  for (const [key, labelKey] of [["tabs", "tab"], ["anchors", "anchor"], ["dropdowns", "dropdown"]]) {
    if (Array.isArray(n[key]) && n[key].length) {
      return n[key]
        .filter((t) => !t.href || !/^https?:/.test(t.href) || t.groups || t.pages)
        .map((t) => {
          // A tab may itself hold anchors/menus: their groups join it.
          const inner = [...sectionGroups(t), ...["anchors", "menu", "dropdowns", "tabs"].flatMap((k) => (Array.isArray(t[k]) ? t[k].flatMap(sectionGroups) : []))];
          return { label: t[labelKey] ?? t.name ?? "Docs", icon: t.icon, groups: inner, href: t.href };
        })
        .filter((t) => t.groups.length);
    }
  }
  return [{ label: null, groups: sectionGroups(n) }];
}

/** mint.json navigation + tabs → sections like docsJsonSections. */
export function mintJsonSections(cfg) {
  const groups = (Array.isArray(cfg.navigation) ? cfg.navigation : []).map((g) => ({ group: g.group ?? "Docs", refs: flattenPages(g.pages), icon: g.icon }));
  const tabs = [...(Array.isArray(cfg.tabs) ? cfg.tabs : []), ...(Array.isArray(cfg.anchors) ? cfg.anchors.filter((a) => a.url && !/^[a-z]+:/i.test(a.url)) : [])]
    .filter((t) => t.url && !/^[a-z]+:/i.test(t.url))
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
    if (!o || typeof o !== "object" || depth > 12) return;
    if (Array.isArray(o)) return o.forEach((x) => walk(x, depth + 1));
    for (const [k, v] of Object.entries(o)) {
      if (k === "openapi") add(v);
      else walk(v, depth + 1);
    }
  };
  walk(cfg);
  return found;
}

export default {
  name: "mintlify",
  flavor: "mintlify",
  nav(env) {
    const cfg = readConfig(env);
    const root = env.det.contentRoot;
    if (!cfg) {
      const f = folderNav(env.pages, { root });
      return { groups: f.groups, tabs: [], navTitles: new Map(), home: f.home, redirects: [] };
    }
    env.config = cfg;
    const isDocsJson = /docs\.json$/.test(env.det.config);
    const sections = isDocsJson ? docsJsonSections(cfg.navigation) : mintJsonSections(cfg);
    const useTabs = sections.length > 1;
    const tabs = [];
    const groups = [];
    const missing = new Set();
    for (const s of sections) {
      let tabId;
      if (useTabs) {
        tabId = pathSegment(s.label ?? "docs");
        while (tabs.some((t) => t.id === tabId)) tabId += "-2";
        tabs.push({ id: tabId, label: s.label ?? "Docs", ...(s.icon ? { icon: s.icon } : {}) });
      }
      for (const g of s.groups) {
        const files = [];
        for (const ref of g.refs) {
          const f = mintlifyPageFile(ref, root, env.files);
          if (f && env.byFile.has(f)) files.push(f);
          else missing.add(ref);
        }
        if (!files.length) continue;
        const icon = g.icon ? env.iconFor(g.icon, { where: `group “${g.group}”` }) : undefined;
        groups.push({ group: g.group, files, ...(icon ? { icon } : {}), ...(tabId ? { tab: tabId } : {}) });
      }
    }
    for (const ref of missing) env.note(`The navigation lists “${ref}”, which has no .mdx or .md file: left out`);
    const redirects = (Array.isArray(cfg.redirects) ? cfg.redirects : []).map((r) => ({ from: r.source, to: r.destination, ref: true }));
    return { groups, tabs, navTitles: new Map(), home: null, redirects };
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
    const logo = typeof cfg.logo === "string" ? { light: file(cfg.logo) } : cfg.logo && typeof cfg.logo === "object" ? { light: file(cfg.logo.light), dark: file(cfg.logo.dark) } : null;
    const hex = (v) => (typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v.trim()) ? v.trim() : undefined);
    return {
      name: typeof cfg.name === "string" ? cfg.name : undefined,
      description: typeof cfg.description === "string" ? cfg.description : undefined,
      logo: logo?.light ? { light: logo.light, ...(logo.dark ? { dark: logo.dark } : {}) } : undefined,
      favicon: file(cfg.favicon) ?? undefined,
      accent: hex(cfg.colors?.primary),
      accentDark: hex(cfg.colors?.light),
    };
  },
  openapi(env) {
    if (!env.config) return [];
    return configOpenapi(env.config, env.det.contentRoot, env.files, /docs\.json$/.test(env.det.config) ? "docs.json" : "mint.json");
  },
};
