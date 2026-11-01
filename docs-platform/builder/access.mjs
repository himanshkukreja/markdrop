/**
 * Private pages and sections in a build: what the edge must protect, a public MCP snapshot, and a
 * leak check over everything a reader can fetch without signing in.
 *
 * The rules are the engine's own (frontend/src/docs/access.mjs, imported from the engine folder):
 * a page's rule is its frontmatter `access`, else its nav group's; a `:::private{access=…}` section
 * is cut out of the public page and lives only in variant routes. From the content folder this
 * module works out, without trusting the crawl:
 *
 *   pages     page path → rule: its HTML, RSC payload, `.md` twin and OG card get `a: <rule>` in
 *             the manifest (the edge serves them only to readers the rule lets in)
 *   sections  page path → the rules of its private sections: the page route gets `sec`, and each
 *             `x-access/<rules>/<page>` route is a `variant` (never served at its own address)
 *   files     a site file only protected content refers to gets `a: [rules]` (any of them opens it)
 *
 * leakCheck then reads every object a signed-out reader can get (public routes and their
 * payloads, the 404 page, public files, the MCP snapshot) for text that only protected content
 * has, and the aggregate outputs for protected page addresses. Any hit fails the build.
 */
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/** The engine's access module and YAML parser (the same code the pages are rendered with). */
export async function loadAccessTools(engineDir) {
  const access = await import(pathToFileURL(path.join(engineDir, "src", "docs", "access.mjs")).href);
  let parseYaml = null;
  try {
    parseYaml = createRequire(path.join(engineDir, "package.json"))("yaml").parse;
  } catch {
    /* the line reader below */
  }
  return { access, parseYaml };
}

const FM = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Frontmatter `access` and the body of a page file. */
export function readPage(src, parseYaml) {
  const m = FM.exec(src);
  if (!m) return { access: undefined, body: src };
  let access;
  try {
    const data = parseYaml ? parseYaml(m[1]) : null;
    if (data && typeof data === "object") access = data.access;
    else throw new Error("no yaml");
  } catch {
    const line = /^access:\s*(.+?)\s*$/m.exec(m[1]);
    access = line ? line[1].replace(/^["']|["']$/g, "") : undefined;
  }
  return { access, body: src.slice(m[0].length) };
}

/** content-relative .md file → page path (the engine's fileToPath; index.md is the home, not a page). */
function pagePath(rel) {
  if (rel === "index.md") return null;
  if (rel.split("/").some((s) => s.startsWith(".") || s.startsWith("_"))) return null;
  return "/" + rel.replace(/\.md$/, "").replace(/\/index$/, "");
}

/**
 * The access plan of a content snapshot ({"/site/<rel>": text}, build.mjs contentSnapshot).
 * Returns {pages, sections, rules, publicText, privateText (rule → text), canaries, publicSnapshot}.
 */
export function accessPlan(snapshot, { access, parseYaml }) {
  let site = {};
  try {
    site = JSON.parse(snapshot["/site/site.json"] || "{}");
  } catch {
    /* no rules */
  }
  const groupAccess = new Map();
  for (const g of Array.isArray(site.nav) ? site.nav : []) {
    for (const p of Array.isArray(g?.pages) ? g.pages : []) if (!groupAccess.has(p)) groupAccess.set(p, g.access);
  }
  const pages = new Map();
  const sections = new Map();
  const privateText = new Map();
  const addPrivate = (rule, text) => privateText.set(rule, (privateText.get(rule) || "") + "\n" + text);
  const publicParts = [];
  const publicSnapshot = {};
  const canaries = [];
  for (const [key, text] of Object.entries(snapshot)) {
    const rel = key.startsWith("/site/") ? key.slice(6) : null;
    const p = rel && rel.endsWith(".md") ? pagePath(rel) : null;
    if (!p) {
      publicSnapshot[key] = text;
      if (!key.startsWith("/public/")) publicParts.push(text);
      continue;
    }
    const { access: own, body } = readPage(text, parseYaml);
    const rule = access.effectiveRule(own, groupAccess.get(p));
    if (rule) {
      // A protected page: not in the public snapshot at all. Its own private sections still get
      // variants (for the readers of the page whom a section's rule also lets in).
      pages.set(p, rule);
      if (access.hasPrivate(body)) {
        const split = access.splitPrivate(body, null);
        if (split.rules.length) sections.set(p, split.rules);
      }
      addPrivate(rule, body);
      canaries.push(...canariesOf(body).map((c) => ({ text: c, where: `page ${p}` })));
      continue;
    }
    if (access.hasPrivate(body)) {
      const split = access.splitPrivate(body, null);
      if (split.rules.length) sections.set(p, split.rules);
      const head = text.slice(0, text.length - body.length);
      publicSnapshot[key] = head + split.body;
      publicParts.push(split.body);
      // Each rule's sections: the full text revealed for that rule alone, minus the public lines.
      const shown = new Set(split.body.split(/\r?\n/));
      for (const r of split.rules) {
        const only = access.splitPrivate(body, new Set([r]), "").body.split(/\r?\n/).filter((l) => !shown.has(l)).join("\n");
        addPrivate(r, only);
        canaries.push(...canariesOf(only).map((c) => ({ text: c, where: `section (${r}) of ${p}` })));
      }
      continue;
    }
    publicSnapshot[key] = text;
    publicParts.push(body);
  }
  const publicText = publicParts.join("\n");
  // Text that public content also has proves nothing.
  const kept = canaries.filter((c) => !publicText.includes(c.text));
  const rules = new Set([...pages.values(), ...[...sections.values()].flat()]);
  return { pages, sections, rules, publicText, privateText, canaries: kept, publicSnapshot };
}

/** Distinctive runs of words from protected text (the leak check looks for them in public objects). */
export function canariesOf(text, max = 24) {
  const out = [];
  let inFence = false;
  for (const raw of String(text).split(/\r?\n/)) {
    if (/^\s*(`{3,}|~{3,})/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (/^\s*:{2,}/.test(raw)) continue; // directive lines
    const runs = raw.replace(/\[[^\]]*\]\([^)]*\)/g, " ").match(/[A-Za-z0-9][A-Za-z0-9 ]{22,}[A-Za-z0-9]/g) || [];
    const best = runs.sort((a, b) => b.length - a.length)[0];
    if (best && best.split(" ").length >= 3) out.push(best.slice(0, 60).trim());
    if (out.length >= max) break;
  }
  return [...new Set(out)];
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whether `text` refers to the site file at `url` (itself, its light file, or its clip base). */
function refersTo(text, url) {
  const light = url.replace(/\.dark(\.[a-z0-9]+)?$/i, "$1");
  const base = (u) => u.replace(/\.[a-z0-9]+$/i, "");
  return [url, light, base(url), base(light)].some((c) => text.includes(c) && new RegExp(`${esc(c)}(?![\\w-])`).test(text));
}

const route = (p) => (p === "/" ? "/docs-site" : `/docs-site${p}`);

/**
 * Mark the manifest: protected routes (`a`), pages with private sections (`sec`), their variant
 * routes (`variant`), protected site files (`a: [rules]`), and manifest.access (the rules in use).
 * Throws when a protected page or a variant the plan expects isn't in the build.
 */
export function annotate(manifest, plan, { access }) {
  if (!plan.rules.size) return { protectedRoutes: 0, variants: 0, protectedFiles: 0 };
  let protectedRoutes = 0;
  let variants = 0;
  let protectedFiles = 0;
  for (const [p, rule] of plan.pages) {
    const keys = [route(p), `/docs-site/md${p}`, `/docs-site/og${p}`];
    if (!manifest.routes[keys[0]]) throw new Error(`access: the protected page ${p} isn't in the build`);
    for (const k of keys) {
      if (manifest.routes[k]) {
        manifest.routes[k].a = rule;
        protectedRoutes++;
      }
    }
  }
  for (const [p, rules] of plan.sections) {
    const base = manifest.routes[route(p)];
    if (!base) throw new Error(`access: the page ${p} isn't in the build`);
    const sets = access.ruleSets(rules);
    base.sec = [...new Set(sets.flat())].sort();
    for (const set of sets) {
      const k = `/docs-site/${access.VARIANT_SEGMENT}/${access.ruleSetKey(set)}${p}`;
      const v = manifest.routes[k];
      if (!v) throw new Error(`access: the variant ${k} isn't in the build`);
      v.variant = true;
      variants++;
    }
  }
  // Protected pages can have private sections too: their variants keep the page's rule.
  for (const [k, r] of Object.entries(manifest.routes)) {
    const m = new RegExp(`^/docs-site/${access.VARIANT_SEGMENT}/[^/]+(/.*)$`).exec(k);
    if (!m) continue;
    r.variant = true;
    const rule = plan.pages.get(m[1]);
    if (rule) r.a = rule;
  }
  for (const [p, f] of Object.entries(manifest.files)) {
    if (!p.startsWith("/docs-assets/")) continue;
    if (refersTo(plan.publicText, p)) continue;
    const rules = [...plan.privateText].filter(([, text]) => refersTo(text, p)).map(([r]) => r).sort();
    if (rules.length) {
      f.a = rules;
      protectedFiles++;
    }
  }
  manifest.access = { rules: [...plan.rules].sort() };
  return { protectedRoutes, variants, protectedFiles };
}

/** Bodies a signed-out reader can fetch: [{where, read()}]. */
function publicObjects(manifest) {
  const out = [];
  for (const [k, r] of Object.entries(manifest.routes)) {
    if (r.a || r.variant) continue;
    if (r.t && !/^(text\/|application\/(json|xml|rss|feed|javascript|x-component))/.test(r.t)) continue; // OG PNGs hold no page text anyone could copy
    out.push({ where: k, o: r.o });
    if (r.rsc) out.push({ where: `${k} (RSC)`, o: r.rsc.o });
    if (r.prefetch) out.push({ where: `${k} (prefetch)`, o: r.prefetch.o });
  }
  if (manifest.notFound) out.push({ where: "404", o: manifest.notFound.o });
  for (const [p, f] of Object.entries(manifest.files)) {
    if (f.a || f.immutable || !/^(text\/|application\/(json|xml))/.test(f.t || "")) continue;
    out.push({ where: p, o: f.o });
  }
  if (manifest.mcp) out.push({ where: "MCP snapshot", o: manifest.mcp.o });
  return out;
}

/**
 * Every leak of protected content into what a signed-out reader can fetch: [{where, what}].
 * `readObject(hash)` → Buffer. Text is compared after decoding HTML/JSON escapes for quotes and
 * ampersands, the way it reaches a reader.
 */
export function leakCheck(manifest, plan, readObject) {
  if (!plan.rules.size) return [];
  const leaks = [];
  const norm = (s) => s.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;|\\"/g, '"').replace(/\s+/g, " ");
  for (const obj of publicObjects(manifest)) {
    const text = norm(readObject(obj.o).toString("utf8"));
    for (const c of plan.canaries) if (text.includes(c.text)) leaks.push({ where: obj.where, what: `text of the ${c.where}: "${c.text}"` });
  }
  // Protected addresses must not be listed by the outputs that list pages.
  const url = manifest.site?.url || "";
  const lists = {
    "/docs-site/sitemap.xml": (p) => `<loc>${url}${p}</loc>`,
    "/docs-site/llms.txt": (p) => `(${url}${p}.md)`,
    "/docs-site/search-index.json": (p) => `"href":"${p}"`,
    "/docs-site/skill.md": (p) => `(${url}${p}.md)`,
  };
  for (const [k, needle] of Object.entries(lists)) {
    const r = manifest.routes[k];
    if (!r) continue;
    const text = readObject(r.o).toString("utf8").replace(/"href": "/g, '"href":"');
    for (const p of plan.pages.keys()) if (text.includes(needle(p))) leaks.push({ where: k, what: `lists the protected page ${p}` });
  }
  return leaks;
}
