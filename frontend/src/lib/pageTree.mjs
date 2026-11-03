/**
 * Moving and copying pages: the pure parts (no React, no network), shared by the page tree's drag
 * and drop, the "Move to" picker and "Duplicate". Tested by pageTree.test.mjs.
 *
 * A tree is a list of visible rows, top to bottom, each with its depth (0 = the top row) and the
 * slugs of its ancestors in the tree. A drop lands:
 *   - "inside" a row: it becomes that page's last sub-page;
 *   - "before" a row: a sibling just above it;
 *   - "after" a row: a sibling below it, or (with the pointer further left, at the end of a branch)
 *     a sibling of one of its ancestors; below an open row with sub-pages it becomes the first one.
 * `after` names the sibling it goes after (null: first; undefined: last).
 */

/** Pixels of indent per level in the tree. */
export const TREE_INDENT = 14;

/**
 * Where a drag at (x, y) would land.
 * @param {Array<{slug:string, depth:number, top:number, bottom:number, parent:string|null, ancestors:string[], open:boolean, hasKids:boolean, kids?:string[]|null}>} rows
 * @param {{x:number, y:number, left:number}} at  pointer, and the tree's content left edge
 * @param {{slug:string, parent:string|null, prev:string|null, blocked:Set<string>|string[], minDepth?:number}} drag
 */
export function dropAt(rows, at, drag) {
  if (!rows.length) return null;
  const blocked = drag.blocked instanceof Set ? drag.blocked : new Set(drag.blocked ?? []);
  const minDepth = drag.minDepth ?? 0;
  let i = rows.findIndex((r) => at.y >= r.top && at.y < r.bottom);
  let zone;
  if (i < 0) {
    if (at.y < rows[0].top) { i = 0; zone = "before"; }
    else { i = rows.length - 1; zone = "after"; }
  } else {
    const r = rows[i];
    const rel = (at.y - r.top) / Math.max(1, r.bottom - r.top);
    zone = rel < 0.28 ? "before" : rel > 0.72 ? "after" : "inside";
  }
  const row = rows[i];
  const chain = [...row.ancestors, row.slug];
  let out;
  if (zone === "inside") {
    const kids = row.kids ?? null;
    out = { kind: "inside", row: row.slug, parent: row.slug, after: kids ? kids.filter((k) => k !== drag.slug).at(-1) ?? null : undefined, depth: row.depth + 1, y: (row.top + row.bottom) / 2 };
  } else if (zone === "before") {
    if (row.depth < minDepth) return null;
    // The sibling above it (in the same parent), if any.
    let prev = null;
    for (let j = i - 1; j >= 0; j--) {
      if (rows[j].depth < row.depth) break;
      if (rows[j].depth === row.depth) { prev = rows[j].slug; break; }
    }
    out = { kind: "before", row: row.slug, parent: row.parent, after: prev, depth: row.depth, y: row.top };
  } else if (row.open && row.hasKids && rows[i + 1] && rows[i + 1].depth > row.depth) {
    // Below an open page with sub-pages: its first sub-page.
    out = { kind: "after", row: row.slug, parent: row.slug, after: null, depth: row.depth + 1, y: row.bottom };
  } else {
    // After a row at the end of a branch: as deep as the row, or as shallow as the next row,
    // chosen by how far left the pointer is.
    const next = rows[i + 1];
    const lo = Math.max(minDepth, Math.min(row.depth, next ? next.depth : minDepth));
    if (lo > row.depth) return null;
    const want = Math.floor((at.x - at.left) / TREE_INDENT);
    const depth = Math.min(row.depth, Math.max(lo, want));
    const anchor = chain[depth];
    const parent = depth === 0 ? (rows.find((r) => r.slug === anchor)?.parent ?? null) : chain[depth - 1];
    out = { kind: "after", row: anchor, parent, after: anchor, depth, y: row.bottom };
  }
  // Never into itself or one of its own sub-pages.
  const valid = out.kind === "inside"
    ? out.row !== drag.slug && !blocked.has(out.row)
    : out.parent !== drag.slug && !(out.parent && blocked.has(out.parent));
  const noop = out.parent === drag.parent && (out.after === drag.slug || (out.after !== undefined && out.after === drag.prev));
  return { ...out, valid, noop };
}

/** The slugs of a page's sub-pages, all levels, from a children map (what's loaded). */
export function subtree(slug, kidsOf) {
  const out = new Set();
  const walk = (s) => {
    const kids = kidsOf[s];
    if (!Array.isArray(kids)) return;
    for (const k of kids) {
      const ks = typeof k === "string" ? k : k.slug;
      if (out.has(ks)) continue;
      out.add(ks);
      walk(ks);
    }
  };
  walk(slug);
  return out;
}

/**
 * Move `slug` from `from` to `to` (parents; null = off this tree) in a children map, placed after
 * `after` (null: first; undefined: last). Returns a new map; the moved row keeps its fields.
 */
export function moveIn(kidsOf, slug, from, to, after) {
  const next = { ...kidsOf };
  let item = null;
  const fromKey = from ?? "";
  const toKey = to ?? "";
  if (Array.isArray(next[fromKey])) {
    item = next[fromKey].find((k) => k.slug === slug) ?? null;
    next[fromKey] = next[fromKey].filter((k) => k.slug !== slug);
  }
  item = item ?? { slug, title: null, has_children: false };
  if (Array.isArray(next[toKey])) {
    const list = next[toKey].filter((k) => k.slug !== slug);
    const at = after === undefined ? list.length : after === null ? 0 : list.findIndex((k) => k.slug === after) + 1;
    list.splice(at <= 0 && after ? list.length : at, 0, item);
    next[toKey] = list;
  }
  return next;
}

/* ── Duplicate ─────────────────────────────────────────────────────────── */

/** "Plan" → "Plan (1)"; "Plan (1)" → "Plan (2)"; skipping titles already taken nearby. */
export function copyTitle(title, taken = []) {
  const base0 = String(title ?? "").trim() || "Untitled";
  const m = /^(.*\S)\s+\((\d+)\)$/.exec(base0);
  const base = m ? m[1] : base0;
  let n = m ? Number(m[2]) + 1 : 1;
  const set = new Set(taken.map((t) => String(t ?? "").trim()));
  while (set.has(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}

const ID = "[A-Za-z0-9_-]{1,128}";

/** The page images a page's Markdown uses (`asset:<id>` in images and in the front matter's icon / cover), in order. */
export function assetIdsIn(markdown) {
  const out = [];
  const re = new RegExp(`asset\\\\?:(${ID})(?![A-Za-z0-9_-])`, "g");
  for (const m of String(markdown ?? "").matchAll(re)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** Swap page image ids: `asset:<old>` → `asset:<new>` (also the escaped `asset\:` form). */
export function rewriteAssets(markdown, map) {
  const re = new RegExp(`(asset\\\\?:)(${ID})(?![A-Za-z0-9_-])`, "g");
  return String(markdown ?? "").replace(re, (all, pre, id) => (map[id] ? `${pre}${map[id]}` : all));
}

/** Point sub-page links (`::page{src=<slug>}`) at the copies. */
export function rewritePageLinks(markdown, map) {
  return String(markdown ?? "").replace(/(::page\{[^}\n]*?\bsrc=)("?)([A-Za-z0-9_-]+)\2/g, (all, pre, q, slug) => (map[slug] ? `${pre}${q}${map[slug]}${q}` : all));
}

/** A file name for a copied image, from its type. */
export function imageName(id, mime) {
  const ext = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" }[String(mime ?? "").split(";")[0].trim()] ?? "png";
  return `${id}.${ext}`;
}

/** The access sentence the API sends (`readers_before` / `readers_after`), or a neutral fallback. */
export function readersText(v) {
  return typeof v === "string" && v.trim() ? v.trim() : "different people";
}
