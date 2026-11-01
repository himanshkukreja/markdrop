/**
 * MkDocs (and Material for MkDocs): mkdocs.yml read with the `yaml` package, unknown tags
 * (`!!python/name:…`, `!ENV`) tolerated. `nav:` items are `"Title": page.md`, `"Section": [...]`,
 * plain `page.md`, or external URLs (not imported); top-level sections become groups, nested ones
 * flatten into them, and top-level pages form "Getting started". No nav → the folders. Brand:
 * site_name, site_description, theme.logo, theme.favicon, theme.palette.primary (Material's named
 * colours → hex).
 */
import { parse as parseYaml } from "yaml";
import { joinRepo, normRepoPath } from "../paths.mjs";
import { folderNav } from "./folders.mjs";

/** Material for MkDocs primary colours. */
export const MATERIAL_COLORS = {
  red: "#ef5350", pink: "#e92063", purple: "#ab47bd", "deep purple": "#7e56c2", indigo: "#4051b5", blue: "#2094f3", "light blue": "#02a6f2",
  cyan: "#00bdd6", teal: "#009485", green: "#4cae4f", "light green": "#8bc34b", lime: "#cbdc38", yellow: "#ffec3d", amber: "#ffc105",
  orange: "#ffa724", "deep orange": "#ff6e42", brown: "#795649", grey: "#757575", "blue grey": "#546d78", black: "#000000", white: "#ffffff",
};

export function readMkdocsYaml(text) {
  try {
    const v = parseYaml(String(text ?? ""), { logLevel: "silent" });
    if (v && typeof v === "object") return v;
  } catch {
    /* below: without the tags */
  }
  try {
    const v = parseYaml(String(text ?? "").replace(/!!?[\w/:.-]+/g, ""), { logLevel: "silent" });
    return v && typeof v === "object" ? v : {};
  } catch {
    return null;
  }
}

function config(env) {
  if (env.config !== undefined) return env.config;
  const t = env.det.config ? env.readText(env.det.config) : null;
  env.config = t == null ? {} : readMkdocsYaml(t);
  if (env.config === null) {
    env.note(`${env.det.config} couldn't be read: the sidebar follows the folders`);
    env.config = {};
  }
  return env.config;
}

export default {
  name: "mkdocs",
  flavor: "mkdocs",
  nav(env) {
    const cfg = config(env);
    const root = env.det.contentRoot;
    if (!Array.isArray(cfg.nav)) {
      const f = folderNav(env.pages, { root });
      return { groups: f.groups, tabs: [], navTitles: new Map(), home: f.home, redirects: [] };
    }
    const navTitles = new Map();
    const missing = new Set();
    const pageFile = (ref, title) => {
      const s = String(ref ?? "").trim();
      if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
        env.external.push({ title: title ?? s, href: s });
        return null;
      }
      const p = normRepoPath(s.replace(/^\.\//, "").split("#")[0]);
      const candidates = p == null ? [] : [p, `${p}.md`, `${p.replace(/\/$/, "")}/index.md`, `${p.replace(/\/$/, "")}/README.md`].map((x) => joinRepo(root, x));
      const f = candidates.find((c) => env.byFile.has(c));
      if (!f) {
        missing.add(s);
        return null;
      }
      if (title) navTitles.set(f, String(title));
      return f;
    };
    const flat = (items, out) => {
      for (const it of Array.isArray(items) ? items : [items]) {
        if (typeof it === "string") {
          const f = pageFile(it);
          if (f) out.push(f);
        } else if (it && typeof it === "object") {
          for (const [title, v] of Object.entries(it)) {
            if (Array.isArray(v)) flat(v, out);
            else {
              const f = pageFile(v, title);
              if (f) out.push(f);
            }
          }
        }
      }
      return out;
    };
    const groups = [];
    let run = [];
    const flush = () => {
      if (run.length) groups.push({ group: groups.length ? "More" : "Getting started", files: run });
      run = [];
    };
    for (const it of cfg.nav) {
      if (it && typeof it === "object" && !Array.isArray(it)) {
        for (const [title, v] of Object.entries(it)) {
          if (Array.isArray(v)) {
            flush();
            const files = flat(v, []);
            if (files.length) groups.push({ group: title, files });
          } else {
            const f = pageFile(v, title);
            if (f) run.push(f);
          }
        }
      } else {
        const f = pageFile(it);
        if (f) run.push(f);
      }
    }
    flush();
    for (const ref of missing) env.note(`mkdocs.yml nav lists ${ref}, which isn't a page in ${root || "the folder"}: left out`);
    return { groups, tabs: [], navTitles, home: null, redirects: [] };
  },
  brand(env) {
    const cfg = config(env);
    const theme = cfg.theme && typeof cfg.theme === "object" ? cfg.theme : {};
    const docs = env.det.contentRoot;
    const file = (v) => (typeof v === "string" && !/^[a-z]+:/i.test(v) ? joinRepo(docs, normRepoPath(v.replace(/^\.?\/+/, "")) ?? "") || null : null);
    const palette = Array.isArray(theme.palette) ? theme.palette : theme.palette ? [theme.palette] : [];
    const color = (p) => {
      const v = String(p?.primary ?? "").toLowerCase().replace(/-/g, " ").trim();
      return MATERIAL_COLORS[v] ?? (/^#[0-9a-f]{3,8}$/.test(v) ? v : undefined);
    };
    const lightP = palette.find((p) => p?.scheme !== "slate") ?? palette[0];
    const darkP = palette.find((p) => p?.scheme === "slate");
    return {
      name: typeof cfg.site_name === "string" ? cfg.site_name : undefined,
      description: typeof cfg.site_description === "string" ? cfg.site_description : undefined,
      logo: file(theme.logo) ? { light: file(theme.logo) } : undefined,
      favicon: file(theme.favicon) ?? undefined,
      accent: color(lightP),
      accentDark: darkP && color(darkP) !== color(lightP) ? color(darkP) : undefined,
    };
  },
};
