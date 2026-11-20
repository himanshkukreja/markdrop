/**
 * The customizable Home's layout operations (plain JS, unit tested: dashboardCore.test.mjs). A layout is
 * `{ main: Widget[], side: Widget[] }`, each widget `{ id, type, settings }` (plus what the server adds
 * when it reads: available, note, title). The server's registry (backend services/dashboards.py) is the one
 * list of widget types and their settings; it validates every save. Here: move, add, remove, change, and
 * what to send back. Every operation returns a new layout and never changes the one it was given.
 */

export const COLUMNS = /** @type {const} */ (["main", "side"]);
export const MAX_WIDGETS = 16;

/** Where a widget is: `{ col, index }`, or null. */
export function locate(layout, id) {
  for (const col of COLUMNS) {
    const index = layout[col].findIndex((w) => w.id === id);
    if (index >= 0) return { col, index };
  }
  return null;
}

export const count = (layout) => layout.main.length + layout.side.length;
export const other = (col) => (col === "main" ? "side" : "main");

/** Up (-1) or down (+1) within its column; at the end, nothing changes. */
export function move(layout, id, dir) {
  const at = locate(layout, id);
  if (!at) return layout;
  const to = at.index + dir;
  if (to < 0 || to >= layout[at.col].length) return layout;
  const col = [...layout[at.col]];
  [col[at.index], col[to]] = [col[to], col[at.index]];
  return { ...layout, [at.col]: col };
}

/** To the other column, at the same height (or its end when that column is shorter). */
export function moveAcross(layout, id) {
  const at = locate(layout, id);
  if (!at) return layout;
  const to = other(at.col);
  const w = layout[at.col][at.index];
  const dest = [...layout[to]];
  dest.splice(Math.min(at.index, dest.length), 0, w);
  return { ...layout, [at.col]: layout[at.col].filter((x) => x.id !== id), [to]: dest };
}

export function remove(layout, id) {
  const at = locate(layout, id);
  if (!at) return layout;
  return { ...layout, [at.col]: layout[at.col].filter((x) => x.id !== id) };
}

/** A new widget's id: short, lowercase, not used in this layout. */
export function newId(layout, rand = Math.random) {
  const used = new Set([...layout.main, ...layout.side].map((w) => w.id));
  for (;;) {
    const id = `w${Math.floor(rand() * 36 ** 6).toString(36).padStart(6, "0")}`;
    if (!used.has(id)) return id;
  }
}

/** The settings a catalog entry starts with: each field's default (counts) or empty. */
export function defaultSettings(entry) {
  const out = {};
  for (const [key, f] of Object.entries(entry?.settings ?? {})) out[key] = f.default ?? null;
  return out;
}

/** Add at the top of a column (where you'll see it). null when the Home is full. */
export function add(layout, entry, col = "main", settings = undefined, max = MAX_WIDGETS, rand = Math.random) {
  if (count(layout) >= max) return null;
  const w = { id: newId(layout, rand), type: entry.type, settings: { ...defaultSettings(entry), ...(settings ?? {}) } };
  return { ...layout, [col]: [w, ...layout[col]] };
}

/** Change a widget's settings (merged); it's available again until the server says otherwise. */
export function update(layout, id, settings) {
  const at = locate(layout, id);
  if (!at) return layout;
  const col = layout[at.col].map((w) => {
    if (w.id !== id) return w;
    const { note: _n, setup: _s, title: _t, ...rest } = w;
    return { ...rest, settings: { ...w.settings, ...settings }, available: true };
  });
  return { ...layout, [at.col]: col };
}

/** What a save sends: ids, types and settings only (empty settings left out). */
export function toBody(layout) {
  const clean = (w) => {
    const settings = Object.fromEntries(Object.entries(w.settings ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== ""));
    return { id: w.id, type: w.type, settings };
  };
  return { main: layout.main.map(clean), side: layout.side.map(clean) };
}

export function sameLayout(a, b) {
  return JSON.stringify(toBody(a)) === JSON.stringify(toBody(b));
}

/** One column (phones): main, then side. */
export const stacked = (layout) => [...layout.main.map((w) => ({ ...w, col: "main" })), ...layout.side.map((w) => ({ ...w, col: "side" }))];

/** The catalog for the picker: what can be added here, in the registry's order; the rest after, disabled. */
export function pickable(catalog, layout, max = MAX_WIDGETS) {
  const full = count(layout) >= max;
  return catalog.map((c) => ({ ...c, disabled: full || !c.available }));
}

/**
 * What the Customize bar's buttons may do for this widget: up / down within its column, across, and
 * which way "across" points.
 */
export function moves(layout, id) {
  const at = locate(layout, id);
  if (!at) return { up: false, down: false, across: null };
  return { up: at.index > 0, down: at.index < layout[at.col].length - 1, across: other(at.col) };
}
