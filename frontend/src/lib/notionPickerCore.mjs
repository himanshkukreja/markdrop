/**
 * Connect Notion's picker, as data (NotionPicker.tsx draws it). Pure: no React, no fetches, so node --test
 * can check it (notionPickerCore.test.mjs).
 *
 * The listing (GET /notion/connections/{id}/pages) names each item's real parent: a page, a database, or a
 * database row (`parent_kind: "row"`). Rows aren't in it: a database's rows load when it's opened
 * (GET …/databases/{id}/rows), and `row_parents` says which database each row with listed sub-pages is in.
 *
 * Selection is two sets: `roots` (ticked on their own: what POST /notion/import gets as `pages`) and
 * `excluded` (unticked under a ticked parent: its `exclude`). Whether an item is ticked is the nearest
 * decision walking up from it (a root wins over an exclusion on the same item), else not ticked.
 */

/** @typedef {{ id: string, kind: "page" | "database" | "row", title: string, icon?: string | null, parent_id: string | null, parent_kind?: "page" | "database" | "row" | null, row_count?: number }} Item */
/** @typedef {{ roots: Set<string>, excluded: Set<string> }} Selection */

export const emptySelection = () => ({ roots: new Set(), excluded: new Set() });

const byTitle = (a, b) => (a.title || "").localeCompare(b.title || "");

/**
 * The tree: top-level items with their children (pages under pages; a database's loaded rows, in Notion's
 * order, then anything else in it; a row's sub-pages under the row). Items under a row whose database
 * isn't opened yet aren't shown, but `parentOf` still knows where they are.
 * @param {Item[]} items
 * @param {Map<string, Item[]> | Record<string, Item[]>} rowsByDb  rows loaded so far, by database id
 * @param {Record<string, string>} rowParents  row id → database id (from the listing)
 */
export function buildTree(items, rowsByDb = new Map(), rowParents = {}) {
  const rows = rowsByDb instanceof Map ? rowsByDb : new Map(Object.entries(rowsByDb || {}));
  const byId = new Map();
  const parentOf = new Map();
  for (const it of items) byId.set(it.id, { ...it, children: [] });
  for (const [db, list] of rows) {
    for (const r of list) {
      if (!byId.has(r.id)) byId.set(r.id, { ...r, kind: "row", parent_id: db, parent_kind: "database", children: [] });
    }
  }
  for (const [row, db] of Object.entries(rowParents || {})) if (!parentOf.has(row)) parentOf.set(row, db);
  const roots = [];
  for (const n of byId.values()) {
    if (n.parent_id && n.parent_id !== n.id) parentOf.set(n.id, n.parent_id);
    const p = n.parent_id ? byId.get(n.parent_id) : undefined;
    if (p && p !== n) p.children.push(n);
    else if (!n.parent_id || n.parent_kind !== "row") roots.push(n);
    // (under a row not loaded yet: shown once its database is opened)
  }
  for (const n of byId.values()) {
    if (n.kind === "database") {
      const order = new Map((rows.get(n.id) || []).map((r, i) => [r.id, i]));
      n.children.sort((a, b) => (order.has(a.id) ? order.get(a.id) : 1e9) - (order.has(b.id) ? order.get(b.id) : 1e9) || byTitle(a, b));
      n.rowsLoaded = rows.has(n.id);
    } else {
      n.children.sort(byTitle);
    }
  }
  roots.sort(byTitle);
  return { roots, byId, parentOf };
}

/** Is `id` inside `anc` (strictly)? */
export function isUnder(id, anc, parentOf) {
  let p = parentOf.get(id);
  for (let i = 0; p && i < 64; i++) {
    if (p === anc) return true;
    p = parentOf.get(p);
  }
  return false;
}

/** Ticked? The nearest decision walking up from it. */
export function isOn(id, sel, parentOf) {
  let cur = id;
  for (let i = 0; cur && i < 64; i++) {
    if (sel.roots.has(cur)) return true;
    if (sel.excluded.has(cur)) return false;
    cur = parentOf.get(cur);
  }
  return false;
}

/** Some of what's under it is ticked differently from it (the tri-state "some"). */
export function isMixed(id, sel, parentOf) {
  const on = isOn(id, sel, parentOf);
  for (const x of [...sel.roots, ...sel.excluded]) {
    if (x !== id && isUnder(x, id, parentOf) && isOn(x, sel, parentOf) !== on) return true;
  }
  return false;
}

/** Tick or untick `id` (and everything under it, which takes its state: earlier choices inside it go). */
export function toggle(id, sel, parentOf) {
  const on = isOn(id, sel, parentOf);
  const next = { roots: new Set(sel.roots), excluded: new Set(sel.excluded) };
  for (const x of [...next.roots]) if (x === id || isUnder(x, id, parentOf)) next.roots.delete(x);
  for (const x of [...next.excluded]) if (x === id || isUnder(x, id, parentOf)) next.excluded.delete(x);
  const p = parentOf.get(id);
  const parentOn = p ? isOn(p, next, parentOf) : false;
  if (on && parentOn) next.excluded.add(id);
  if (!on && !parentOn) next.roots.add(id);
  return next;
}

/**
 * What POST /notion/import gets: `pages` (the roots: a row ticked on its own is a page) and `exclude`.
 * @param {Selection} sel
 * @param {Map<string, any>} byId
 */
export function importBody(sel, byId) {
  const pages = [...sel.roots].map((id) => {
    const it = byId.get(id);
    return { id, kind: it?.kind === "database" ? "database" : "page", title: it?.title || "Untitled" };
  });
  return { pages, exclude: [...sel.excluded] };
}

/** "12 pages, 1 database · 3 left out" (rows of a database not opened yet count from its row count). */
export function summary(sel, tree) {
  let pages = 0, databases = 0;
  for (const n of tree.byId.values()) {
    if (!isOn(n.id, sel, tree.parentOf)) continue;
    if (n.kind === "database") {
      databases++;
      if (!n.rowsLoaded) pages += n.row_count || 0;
    } else pages++;
  }
  const leftOut = sel.excluded.size;
  const plural = (k, one) => `${k} ${one}${k === 1 ? "" : "s"}`;
  const parts = [];
  if (pages || !databases) parts.push(plural(pages, "page"));
  if (databases) parts.push(plural(databases, "database"));
  const text = parts.join(", ") + (leftOut ? ` · ${leftOut} left out` : "");
  return { pages, databases, leftOut, text };
}

/** Rows left out of a database (the picker's hint: new rows still come on sync). */
export function leavesOutRows(sel, byId) {
  for (const x of sel.excluded) if (byId.get(x)?.kind === "row") return true;
  return false;
}
