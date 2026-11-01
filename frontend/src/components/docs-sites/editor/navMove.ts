/**
 * Reordering the guide's sidebar (the page tree's drag and drop, and its row menus): pure changes
 * to the nav (groups of page ids, saved whole by PUT /nav), and where a dragged row would land.
 * A page's address never depends on where it sits in the tree, so moving one changes only the nav.
 *
 * No imports: the docs:test suite runs it on node's type stripping (navMove.test.mjs).
 */

export interface NavGroupLike {
  group: string;
  pages: string[];
}

/**
 * The nav with page `id` before the page now at `index` of `group` (`index` = the group's length
 * puts it last; indexes count the group before the move). A page not in the nav yet (an unlisted
 * page) is added. Returns `nav` itself when nothing changes or the group doesn't exist.
 */
export function movePage<G extends NavGroupLike>(nav: G[], id: string, group: string, index: number): G[] {
  const target = nav.find((g) => g.group === group);
  if (!target) return nav;
  const fromGroup = nav.find((g) => g.pages.includes(id));
  const from = target.pages.indexOf(id);
  let at = Math.max(0, Math.min(target.pages.length, Math.floor(index)));
  if (from >= 0) {
    if (at === from || at === from + 1) return nav;
    if (at > from) at -= 1;
  }
  return nav.map((g) => {
    if (g === target) {
      const pages = g.pages.filter((x) => x !== id);
      pages.splice(at, 0, id);
      return { ...g, pages };
    }
    return g === fromGroup ? { ...g, pages: g.pages.filter((x) => x !== id) } : g;
  });
}

/** The nav with the group at `from` moved before the group now at `to` (`to` = length puts it last). */
export function moveGroup<G extends NavGroupLike>(nav: G[], from: number, to: number): G[] {
  if (from < 0 || from >= nav.length) return nav;
  const at = Math.max(0, Math.min(nav.length, Math.floor(to)));
  if (at === from || at === from + 1) return nav;
  const out = nav.filter((_, i) => i !== from);
  out.splice(at > from ? at - 1 : at, 0, nav[from]!);
  return out;
}

/** One place up (-1) or down (1) inside its group (the row menu's Move up / Move down). */
export function stepPage<G extends NavGroupLike>(nav: G[], id: string, dir: -1 | 1): G[] {
  const g = nav.find((x) => x.pages.includes(id));
  if (!g) return nav;
  const i = g.pages.indexOf(id);
  const j = i + dir;
  if (j < 0 || j >= g.pages.length) return nav;
  return movePage(nav, id, g.group, dir > 0 ? j + 1 : j);
}

/** To the end of another group (the row menu's Move to …). */
export function pageToGroup<G extends NavGroupLike>(nav: G[], id: string, group: string): G[] {
  const target = nav.find((g) => g.group === group);
  return target ? movePage(nav, id, group, target.pages.length) : nav;
}

/* ── Where a drag lands ─────────────────────────────────────────────────────── */

/** A place a dragged page can land: before row `index` of `group` (or at its end), drawn at `y`. */
export interface PageSlot {
  group: string;
  index: number;
  y: number;
  /** The group is collapsed or empty: the drop goes to its end, and its header lights up. */
  into?: boolean;
}

/** What the tree measured: each group a page can be dropped into, top to bottom. */
export interface MeasuredGroup {
  group: string;
  /** Pages in the group (also when collapsed, when `rows` is empty). */
  count: number;
  /** The rows shown (none when collapsed). */
  rows: { top: number; bottom: number }[];
  head: { top: number; bottom: number };
}

/** Every slot, top to bottom: the top of each row and the end of each open group; a collapsed or empty group is one slot on its header. */
export function pageSlots(groups: MeasuredGroup[]): PageSlot[] {
  const out: PageSlot[] = [];
  for (const g of groups) {
    if (!g.rows.length) {
      out.push({ group: g.group, index: g.count, y: (g.head.top + g.head.bottom) / 2, into: true });
      continue;
    }
    g.rows.forEach((r, i) => out.push({ group: g.group, index: i, y: r.top }));
    out.push({ group: g.group, index: g.rows.length, y: g.rows[g.rows.length - 1]!.bottom });
  }
  return out;
}

/** The slot nearest to `y` (the dragged row's middle). */
export function nearestSlot<S extends { y: number }>(slots: S[], y: number): S | null {
  let best: S | null = null;
  for (const s of slots) if (!best || Math.abs(s.y - y) < Math.abs(best.y - y)) best = s;
  return best;
}

/** Where the page lands, as (group, index after it leaves its place): two slots with the same key are the same drop. */
export function slotKey(nav: NavGroupLike[], id: string, s: { group: string; index: number }): string {
  const from = nav.find((g) => g.group === s.group)?.pages.indexOf(id) ?? -1;
  const at = from >= 0 && s.index > from ? s.index - 1 : s.index;
  return `${s.group}\u0000${at}`;
}

/** True when dropping at `s` leaves the page where it is. */
export function isNoop(nav: NavGroupLike[], id: string, s: { group: string; index: number }): boolean {
  const from = nav.find((g) => g.group === s.group)?.pages.indexOf(id) ?? -1;
  return from >= 0 && (s.index === from || s.index === from + 1);
}

/**
 * The next slot from `current` in direction `dir` (the keyboard's ↑ / ↓), skipping slots whose
 * `key` is the current one's (the same drop). Stays put at either end.
 */
export function stepKeyed<S extends { y: number }>(slots: S[], current: S | null, dir: -1 | 1, key: (s: S) => string): S | null {
  if (!slots.length) return null;
  let i = current ? slots.findIndex((s) => key(s) === key(current) && s.y === current.y) : -1;
  if (i < 0) i = current ? slots.indexOf(nearestSlot(slots, current.y)!) : 0;
  const here = key(slots[i]!);
  for (let j = i + dir; j >= 0 && j < slots.length; j += dir) if (key(slots[j]!) !== here) return slots[j]!;
  return slots[i]!;
}

/** `stepKeyed` for a dragged page. */
export function stepSlot<S extends PageSlot>(nav: NavGroupLike[], id: string, slots: S[], current: S | null, dir: -1 | 1): S | null {
  return stepKeyed(slots, current, dir, (s) => slotKey(nav, id, s));
}

/** A place a dragged group can land: before group `index` (or after the last), drawn at `y`. */
export interface GroupSlot {
  index: number;
  y: number;
}

/** Slots between groups, from each group's box (top to bottom), halfway across the `gap` between them. */
export function groupSlots(boxes: { top: number; bottom: number }[], gap: number): GroupSlot[] {
  const out = boxes.map((b, i) => ({ index: i, y: b.top - gap / 2 }));
  if (boxes.length) out.push({ index: boxes.length, y: boxes[boxes.length - 1]!.bottom + gap / 2 });
  return out;
}

/** Where a group lands, as its index once it leaves its place. */
export const groupKey = (from: number, s: GroupSlot) => String(s.index > from ? s.index - 1 : s.index);
