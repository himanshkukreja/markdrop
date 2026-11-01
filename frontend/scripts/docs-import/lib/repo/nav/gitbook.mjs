/**
 * GitBook Git Sync: `.gitbook.yaml` (root, structure.readme / structure.summary, redirects) and
 * SUMMARY.md (`## Group` headings → groups, nested `* [Title](page.md)` items → pages in order; the
 * first items before any heading → "Getting started"). README.md (structure.readme) is the home.
 */
import { parse as parseYaml } from "yaml";
import { joinRepo, normRepoPath, resolveRepo } from "../paths.mjs";
import { folderNav } from "./folders.mjs";

/** SUMMARY.md → [{ group, items: [{ title, href, depth }] }] (group "" before the first heading). */
export function parseSummary(src) {
  const groups = [{ group: "", items: [] }];
  for (const raw of String(src ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
    if (h) {
      if (h[1].length === 1) continue; // "# Table of contents"
      const name = h[2].replace(/<[^>]*>/g, "").replace(/\*\*|__/g, "").trim();
      groups.push({ group: name, items: [] });
      continue;
    }
    const it = /^(\s*)[*+-]\s+\[((?:[^\]\\]|\\.)*)\]\(\s*<?([^)>]*?)>?\s*(?:"[^"]*")?\s*\)/.exec(raw);
    if (it) {
      const depth = Math.floor(it[1].replace(/\t/g, "  ").length / 2);
      groups[groups.length - 1].items.push({ title: it[2].replace(/\\(.)/g, "$1").trim(), href: it[3].trim(), depth });
    }
  }
  return groups.filter((g) => g.items.length);
}

function gitbookYaml(env) {
  if (!env.det.config) return {};
  try {
    return parseYaml(env.readText(env.det.config) ?? "", { logLevel: "silent" }) ?? {};
  } catch {
    env.note(".gitbook.yaml couldn't be read: used the defaults");
    return {};
  }
}

export default {
  name: "gitbook",
  flavor: "gitbook",
  nav(env) {
    const y = gitbookYaml(env);
    const root = env.det.contentRoot;
    const at = (rel, def) => joinRepo(root, normRepoPath(String(rel ?? def).replace(/^\.\//, "")) ?? def);
    const summaryFile = at(y.structure?.summary, "SUMMARY.md");
    const readmeFile = at(y.structure?.readme, "README.md");
    const home = env.byFile.has(readmeFile) ? readmeFile : null;
    const navTitles = new Map();
    const redirects = [];
    if (y.redirects && typeof y.redirects === "object") {
      for (const [from, to] of Object.entries(y.redirects)) {
        const file = typeof to === "string" ? resolveRepo(joinRepo(root, "x"), to.replace(/^\.\//, "")) : null;
        redirects.push({ from: "/" + String(from).replace(/^\/+|\/+$/g, ""), toFile: file, raw: to });
      }
    }
    const summary = env.readText(summaryFile);
    if (summary == null) {
      env.note(`No ${summaryFile || "SUMMARY.md"}: the sidebar follows the folders`);
      const f = folderNav(env.pages, { root });
      return { groups: f.groups, tabs: [], navTitles, home: home ?? f.home, redirects };
    }
    const groups = [];
    let first = true;
    for (const g of parseSummary(summary)) {
      const files = [];
      for (const it of g.items) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(it.href)) {
          env.external.push({ title: it.title, href: it.href });
          continue;
        }
        const file = resolveRepo(summaryFile, it.href.split("#")[0]);
        const page = file != null ? env.byFile.get(file) : null;
        if (!page) {
          env.note(`SUMMARY.md lists ${it.href} (“${it.title}”), which isn't a page in the folder`);
          continue;
        }
        if (it.title) navTitles.set(page.file, it.title);
        files.push(page.file);
      }
      const name = g.group || (first ? "Getting started" : "More");
      first = false;
      if (files.length) groups.push({ group: name, files });
    }
    return { groups, tabs: [], navTitles, home, redirects };
  },
  brand() {
    return {};
  },
};
