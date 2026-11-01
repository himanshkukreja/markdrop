/**
 * Navigation from folders (plain Markdown, and the fallback of every config format): the root's
 * pages form "Getting started", each top-level folder a group (named by its README/index title, a
 * Docusaurus _category_ label, or the folder name), deeper folders flattened into their group in
 * order. Order: front matter sidebar_position / order / nav_order / weight, then a number prefix,
 * then the name; a folder's README/index leads.
 */
import { baseOf, humanize, numberPrefix, relTo, stemOf, stripNumberPrefix, within } from "../paths.mjs";

const INDEX = /^(readme|index)$/i;

/** A page's explicit order from its front matter, or null. */
export function fmOrder(fm) {
  for (const k of ["sidebar_position", "order", "nav_order", "weight", "position"]) {
    const v = fm?.[k];
    if (v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/** Whether a page file is its folder's index (README/index, or Docusaurus's `<folder>/<folder>.md`). */
export function isIndexFile(rel, { folderNamed = false } = {}) {
  const segs = rel.split("/");
  const stem = stemOf(segs[segs.length - 1]);
  if (INDEX.test(stem)) return true;
  return folderNamed && segs.length > 1 && stripNumberPrefix(stem).toLowerCase() === stripNumberPrefix(segs[segs.length - 2]).toLowerCase();
}

const cmp = (a, b) => {
  const x = a.order ?? Infinity;
  const y = b.order ?? Infinity;
  if (x !== y) return x - y;
  const p = a.prefix ?? Infinity;
  const q = b.prefix ?? Infinity;
  if (p !== q) return p - q;
  return a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" });
};

/**
 * pages: [{ file, rel (to `root`), fm, title }]. category(dir) → { label?, position? } | null (dir is
 * a path relative to `root`). Returns { groups: [{ group, files }], home: file | null }.
 */
export function folderNav(pages, { root = "", category = () => null, folderNamed = false, firstGroup = "Getting started" } = {}) {
  const list = pages.filter((p) => within(p.file, root)).map((p) => ({ ...p, rel: relTo(p.file, root) }));
  // A tree of folders.
  const mk = (dir) => ({ dir, pages: [], dirs: new Map() });
  const tree = mk("");
  for (const p of list) {
    const segs = p.rel.split("/");
    let node = tree;
    for (let i = 0; i < segs.length - 1; i++) {
      const d = segs.slice(0, i + 1).join("/");
      if (!node.dirs.has(segs[i])) node.dirs.set(segs[i], mk(d));
      node = node.dirs.get(segs[i]);
    }
    node.pages.push(p);
  }
  const indexOf = (node) => node.pages.find((p) => isIndexFile(p.rel, { folderNamed }) && p.rel.split("/").length === (node.dir ? node.dir.split("/").length + 1 : 1));
  const entries = (node) => {
    const idx = indexOf(node);
    const items = [];
    for (const p of node.pages) {
      if (p === idx) continue;
      const name = baseOf(p.rel);
      items.push({ kind: "page", page: p, order: fmOrder(p.fm), prefix: numberPrefix(name), name: stripNumberPrefix(stemOf(name)) });
    }
    for (const [name, d] of node.dirs) {
      const cat = category(d.dir) ?? {};
      const di = indexOf(d);
      items.push({ kind: "dir", node: d, order: cat.position ?? fmOrder(di?.fm), prefix: numberPrefix(name), name: stripNumberPrefix(name) });
    }
    return { idx, items: items.sort(cmp) };
  };
  const flatten = (node) => {
    const { idx, items } = entries(node);
    const out = idx ? [idx.file] : [];
    for (const it of items) out.push(...(it.kind === "page" ? [it.page.file] : flatten(it.node)));
    return out;
  };
  const top = entries(tree);
  const groups = [];
  const rootPages = top.items.filter((it) => it.kind === "page").map((it) => it.page.file);
  if (rootPages.length) groups.push({ group: firstGroup, files: rootPages });
  for (const it of top.items) {
    if (it.kind !== "dir") continue;
    const cat = category(it.node.dir) ?? {};
    const idx = indexOf(it.node);
    const files = flatten(it.node);
    if (!files.length) continue;
    groups.push({ group: cat.label || idx?.title || humanize(stripNumberPrefix(baseOf(it.node.dir))), files });
  }
  return { groups, home: top.idx?.file ?? null };
}
