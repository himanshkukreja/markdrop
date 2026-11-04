"use client";

/**
 * The page tree in the rail of a page's reading view: the top page of this one's chain and its
 * sub-pages, with drag and drop to move pages (editors) and a ⋯ menu on each row. Loaded on its
 * own (DocumentView imports it lazily), so a plain document never ships the drag code.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DndContext, DragOverlay, PointerSensor, TouchSensor, useDraggable, useSensor, useSensors, type DragEndEvent, type DragMoveEvent, type DragStartEvent, type Modifier } from "@dnd-kit/core";
import { getEventCoordinates } from "@dnd-kit/utilities";
import { Anchor, Dropdown, Icon, IconButton, Skeleton, Spinner, copyText, cx, useToast, type MenuEntry } from "@/components/ui";
import { type ChildPage, type Crumb } from "@/lib/pages";
import { childrenSlot, fetchChildren, useNavVersion } from "@/lib/navStore";
import { pagePath } from "@/lib/pageBlocks.mjs";
import { TREE_INDENT, dropAt, subtree, type TreeDrop, type TreeRow } from "@/lib/pageTree.mjs";
import { workspaceChanged } from "@/lib/workspaceStore";
import type { PageAddressing } from "./PageChrome";
import { MovePageDialog, useMovePage } from "./MovePage";
import { useDuplicatePage } from "./DuplicatePage";
import "./pages.css";
import "./pageTree.css";

const hrefFor = (slug: string, ancestors: string[], a: PageAddressing) => pagePath(slug, { tenant: a.tenant, folderPath: a.folderPath, ancestors });

interface TreeItem {
  slug: string;
  title: string | null;
  has_children: boolean;
  access_inherit?: boolean | null;
  icon?: string | null;
  icon_url?: string | null;
}

interface Row {
  item: TreeItem;
  depth: number;
  parent: string | null;
  ancestors: string[];
}

type Kids = Record<string, ChildPage[] | "loading" | "error">;

/** The row a page shows as: what's known of its sub-pages wins over the flag it came with. */
const kidsKnown = (kidsOf: Kids, slug: string) => (Array.isArray(kidsOf[slug]) ? (kidsOf[slug] as ChildPage[]) : null);
const hasKids = (kidsOf: Kids, item: TreeItem) => {
  const k = kidsKnown(kidsOf, item.slug);
  return k ? k.length > 0 : item.has_children;
};

function flatten(root: TreeItem, rootParent: string | null, kidsOf: Kids, open: Set<string>): Row[] {
  const out: Row[] = [];
  const walk = (item: TreeItem, depth: number, parent: string | null, ancestors: string[]) => {
    out.push({ item, depth, parent, ancestors });
    const kids = kidsKnown(kidsOf, item.slug);
    if (open.has(item.slug) && kids) for (const k of kids) walk(k, depth + 1, item.slug, [...ancestors, item.slug]);
  };
  walk(root, 0, rootParent, []);
  return out;
}

/** `row` with the page's current title and icon (the same row when they match). */
function asNow(row: Row, title: string | null, icon: string | null): Row {
  const it = row.item;
  if (it.title === title && (it.icon ?? null) === icon) return row;
  return { ...row, item: { ...it, title, icon, icon_url: (it.icon ?? null) === icon ? it.icon_url : null } };
}

/** Notion's hover-hold: a collapsed page opens after the pointer rests "inside" it this long. */
const HOLD_MS = 600;

/** The dragged page's chip rides just below and right of the pointer, so the rows stay visible. */
const followPointer: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  const p = activatorEvent ? getEventCoordinates(activatorEvent) : null;
  if (!p || !draggingNodeRect) return transform;
  return { ...transform, x: transform.x + p.x - draggingNodeRect.left + 14, y: transform.y + p.y - draggingNodeRect.top + 10 };
};

/** A page's icon in the tree: its emoji, its image, else the page glyph. */
function RowIcon({ item }: { item: TreeItem }) {
  if (item.icon_url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <span className="pb-tree__icon" aria-hidden><img src={item.icon_url} alt="" /></span>;
  }
  if (item.icon && !item.icon.startsWith("asset:")) return <span className="pb-tree__icon pb-tree__icon--emoji" aria-hidden>{item.icon}</span>;
  return <span className="pb-tree__icon" aria-hidden><Icon name="doc" size={14} /></span>;
}

/** A long title shows in full on hover, only when it's cut off. */
const tipIfCut = (e: React.PointerEvent<HTMLElement>, text: string) => {
  const t = e.currentTarget.querySelector<HTMLElement>(".pb-tree__text");
  if (t && t.scrollWidth > t.clientWidth + 1) e.currentTarget.title = text;
  else e.currentTarget.removeAttribute("title");
};

function TreeRowView({ row, kidsOf, open, current, addressing, toggle, canEdit, draggingSlug, drop, busy, menu, suppress }: {
  row: Row;
  kidsOf: Kids;
  open: Set<string>;
  current: string;
  addressing: PageAddressing;
  toggle: (slug: string) => void;
  canEdit: boolean;
  draggingSlug: string | null;
  drop: TreeDrop | null;
  busy: string | null;
  menu: (row: Row) => MenuEntry[];
  suppress: React.RefObject<number>;
}) {
  const { item, depth } = row;
  const isOpen = open.has(item.slug);
  const kids = kidsOf[item.slug];
  const expandable = hasKids(kidsOf, item);
  const draggable = canEdit && depth > 0;
  const drag = useDraggable({ id: `pt:${item.slug}`, data: { slug: item.slug }, disabled: !draggable });
  const into = !!drop && drop.kind === "inside" && drop.row === item.slug && drop.valid && !drop.noop;
  const items = menu(row);
  const name = item.title || "Untitled";
  return (
    <div
      ref={drag.setNodeRef}
      className={cx("pb-tree__row", draggingSlug === item.slug && "pb-tree__row--source", into && "pb-tree__row--into", busy === item.slug && "pb-tree__row--busy")}
      style={{ paddingLeft: depth * TREE_INDENT, "--pt-depth": depth } as React.CSSProperties}
      data-pt-row={item.slug}
      data-drag-on={draggable ? "" : undefined}
      {...(draggable ? drag.listeners : {})}
    >
      {expandable ? (
        <button
          type="button"
          className="pb-tree__toggle md-focus"
          aria-expanded={isOpen}
          aria-label={`${isOpen ? "Collapse" : "Expand"} ${name}`}
          onClick={() => toggle(item.slug)}
        >
          {isOpen && kids === "loading" ? <Spinner size={10} /> : <Icon name="chevronRight" size={12} />}
        </button>
      ) : (
        <span className="pb-tree__spacer" aria-hidden />
      )}
      <Anchor
        href={hrefFor(item.slug, row.ancestors, addressing)}
        className="pb-tree__link md-focus"
        aria-current={item.slug === current ? "page" : undefined}
        dir="auto"
        draggable={false}
        data-level={depth}
        onPointerEnter={(e) => tipIfCut(e, name)}
        onClickCapture={(e) => {
          // A drag that ended over its own row isn't a click.
          if (Date.now() - (suppress.current ?? 0) < 350) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        <RowIcon item={item} />
        <span className="pb-tree__text ph-sensitive ph-mask">{name}</span>
      </Anchor>
      {items.length > 0 && (
        <span className="pt-row-menu" onPointerDown={(e) => e.stopPropagation()}>
          {canEdit && !addressing.tenant && (
            <Anchor href={`/pages/new?parent=${encodeURIComponent(item.slug)}`} className="pt-row-add md-focus" aria-label={`Add a page inside ${name}`} title={`Add a page inside ${name}`}>
              <Icon name="plus" size={14} />
            </Anchor>
          )}
          <Dropdown portal align="right" minWidth={200} aria-label={`Actions for ${name}`} trigger={<IconButton icon="more" label={`Actions for ${name}`} size="sm" variant="ghost" />} items={items} />
        </span>
      )}
    </div>
  );
}

const TreeBranch = memo(function TreeBranch(props: {
  row: Row;
  rows: Row[];
  kidsOf: Kids;
  open: Set<string>;
  current: string;
  addressing: PageAddressing;
  toggle: (slug: string) => void;
  canEdit: boolean;
  draggingSlug: string | null;
  drop: TreeDrop | null;
  busy: string | null;
  menu: (row: Row) => MenuEntry[];
  suppress: React.RefObject<number>;
}) {
  const { row, rows, kidsOf, open } = props;
  const isOpen = open.has(row.item.slug);
  const kids = kidsOf[row.item.slug];
  const childRows = rows.filter((r) => r.parent === row.item.slug && r.depth === row.depth + 1);
  return (
    <li>
      <TreeRowView {...props} />
      {isOpen && hasKids(kidsOf, row.item) && (
        kids === "loading" || kids === undefined ? (
          <div className="py-1" style={{ paddingLeft: (row.depth + 1) * TREE_INDENT + 20 }}><Skeleton width="70%" /></div>
        ) : kids === "error" ? (
          <p className="text-caption text-text-muted m-0" style={{ paddingLeft: (row.depth + 1) * TREE_INDENT + 20 }}>Couldn&apos;t load</p>
        ) : (
          <ul>
            {childRows.map((r) => (
              <TreeBranch key={r.item.slug} {...props} row={r} />
            ))}
          </ul>
        )
      )}
    </li>
  );
});

export interface PageTreeProps {
  slug: string;
  title: string | null;
  crumbs: Crumb[];
  childrenCount: number;
  addressing: PageAddressing;
  /** Signed-in editors on markdrop.in: drag pages to move them, and each row's ⋯ menu. */
  canEdit?: boolean;
  /** The page's workspace (Move to lists its folders and pages). */
  workspaceId?: string | null;
  /** The parent of the tree's top page: null = it's at the top level; undefined = not known (an
   *  ancestor this reader can't open), so nothing can be dropped beside it. */
  rootParent?: string | null;
  /** A page in the tree moved from one parent to another (null: the top level); the reading view
   *  re-reads this page when its place or its sub-pages changed. */
  onMoved?: (slug: string, from: string | null, to: string | null) => void;
  /** This page's icon (an emoji or asset:<id>), so its row shows the current one. */
  icon?: string | null;
}

/**
 * The page tree in the rail: the top page of this one's chain and its sub-pages, the path to this
 * page open. Sub-pages load when a branch opens (GET …/children).
 *
 * Editors drag a page onto another (it goes inside, as the last sub-page), between two (a line
 * shows the level it lands at: further left at the end of a branch is a level up), or below the
 * last row at the far left (the top level). A collapsed page opens when the pointer rests on it.
 * The move shows at once and rolls back if the API refuses; a move that changes who can read the
 * page asks first. Each row's ⋯ menu has Move to… (the keyboard way to do the same), Duplicate
 * and Copy link.
 */
export function PageTree({ slug, title, crumbs, childrenCount, addressing: addressingProp, canEdit = false, workspaceId = null, rootParent, onMoved, icon = null }: PageTreeProps) {
  const toast = useToast();
  const mover = useMovePage();
  const dup = useDuplicatePage();
  // The reading view rebuilds `addressing` on every render; rows are memoised, so keep one object
  // per actual value.
  const folderKey = addressingProp.folderPath.join("/");
  const addressing = useMemo<PageAddressing>(() => addressingProp, [addressingProp.tenant, folderKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const root: TreeItem = crumbs.length
    ? { slug: crumbs[0].slug, title: crumbs[0].title, has_children: true, icon: crumbs[0].slug === slug ? icon : crumbs[0].icon ?? null }
    : { slug, title, has_children: childrenCount > 0, icon };
  const [open, setOpen] = useState<Set<string>>(() => new Set([...crumbs.map((c) => c.slug), ...(childrenCount > 0 ? [slug] : [])]));
  const [kidsOf, setKidsOf] = useState<Kids>({});
  const [draggingSlug, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<TreeDrop | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const [moving, setMoving] = useState<Row | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const suppress = useRef(0);
  const hold = useRef<{ slug: string; t: ReturnType<typeof setTimeout> } | null>(null);
  const dropRef = useRef<TreeDrop | null>(null);
  const kidsRef = useRef(kidsOf);
  kidsRef.current = kidsOf;
  const rootParentKnown = rootParent !== undefined;
  const topParent = rootParent ?? null;

  // Sub-pages come from the shared cache (lib/navStore): the rail, this tree and "Pages inside"
  // never fetch the same list twice at once; `force` asks the API.
  // The cache's list each branch last took: a newer one there (a rename patched in, a refresh
  // after a change elsewhere) replaces this tree's copy; this tree's own optimistic edits (a move
  // in flight) never get overwritten by the older cached list.
  const adopted = useRef(new Map<string, ChildPage[]>());
  const load = useCallback((s: string, force = false) => {
    setKidsOf((m) => (!force && m[s] && m[s] !== "error" ? m : { ...m, [s]: Array.isArray(m[s]) && force ? m[s] : "loading" }));
    fetchChildren(s, force ? 0 : 5_000)
      .then((k) => {
        adopted.current.set(s, k);
        setKidsOf((m) => ({ ...m, [s]: k }));
      })
      .catch(() => setKidsOf((m) => ({ ...m, [s]: "error" })));
  }, []);
  const navVersion = useNavVersion();
  useEffect(() => {
    setKidsOf((m) => {
      let next = m;
      for (const s of Object.keys(m)) {
        const c = childrenSlot(s);
        if (!Array.isArray(m[s]) || !Array.isArray(c) || c === adopted.current.get(s)) continue;
        adopted.current.set(s, c);
        if (next === m) next = { ...m };
        next[s] = c;
      }
      return next;
    });
  }, [navVersion]);

  useEffect(() => {
    open.forEach((s) => {
      if (!kidsOf[s]) load(s);
    });
  }, [open, kidsOf, load]);

  const toggle = useCallback((s: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(s)) n.delete(s);
      else n.add(s);
      return n;
    }), []);

  // This page's row shows its title and icon as they are now (being edited), not as listed.
  const rows = useMemo(
    () => flatten(root, topParent, kidsOf, open).map((r) => (r.item.slug === slug ? asNow(r, title, icon) : r)),
    [root.slug, root.title, root.has_children, root.icon, topParent, kidsOf, open, slug, title, icon], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const titleOf = (s: string | null) => (s ? rows.find((r) => r.item.slug === s)?.item.title?.trim() || "Untitled" : null);

  /* ── moving ── */

  /** Where `s` sits now: its parent and the sibling before it. */
  const placeOf = (s: string): { parent: string | null; prev: string | null } => {
    const r = rowsRef.current.find((x) => x.item.slug === s);
    const parent = r?.parent ?? null;
    const sibs = parent ? kidsKnown(kidsRef.current, parent) ?? [] : [];
    const i = sibs.findIndex((k) => k.slug === s);
    return { parent, prev: i > 0 ? sibs[i - 1]!.slug : null };
  };

  const perform = async (s: string, to: string | null, after: string | null | undefined, opts: { undo?: { parent: string | null; prev: string | null } | null } = {}) => {
    const row = rowsRef.current.find((x) => x.item.slug === s);
    const item: ChildPage = { slug: s, title: row?.item.title ?? null, has_children: row ? hasKids(kidsRef.current, row.item) : false, access_inherit: row?.item.access_inherit ?? null };
    const from = row?.parent ?? null;
    const snapshot = kidsRef.current;
    const openBefore = open;
    // Show it there now.
    setKidsOf((m) => {
      const n = { ...m };
      if (from && Array.isArray(n[from])) n[from] = (n[from] as ChildPage[]).filter((k) => k.slug !== s);
      if (to) {
        const toRow = rowsRef.current.find((x) => x.item.slug === to);
        const known = Array.isArray(n[to]) ? (n[to] as ChildPage[]) : toRow && !hasKids(m, toRow.item) ? [] : null;
        if (known) {
          const list = known.filter((k) => k.slug !== s);
          const at = after === undefined ? list.length : after === null ? 0 : Math.max(0, list.findIndex((k) => k.slug === after) + 1) || list.length;
          list.splice(at, 0, item);
          n[to] = list;
        }
      }
      return n;
    });
    if (to) setOpen((o) => new Set(o).add(to));
    setBusy(s);
    const doc = await mover.move({ slug: s, title: item.title, parent: to, after });
    setBusy(null);
    if (!doc) {
      setKidsOf(snapshot);
      setOpen(openBefore);
      setSaid("Not moved.");
      return false;
    }
    // A parent whose sub-pages weren't loaded yet: load them now (with the moved page among them).
    if (to && !Array.isArray(snapshot[to]) && rowsRef.current.find((x) => x.item.slug === to && x.item.has_children)) load(to, true);
    if (workspaceId) workspaceChanged(workspaceId);
    const where = to ? `into “${titleOf(to) ?? "Untitled"}”` : "to the top level";
    setSaid(`Moved ${item.title || "Untitled"} ${where}.`);
    const back = opts.undo;
    toast.toast({
      message: `Moved “${item.title?.trim() || "Untitled"}” ${where}`,
      kind: "success",
      action: back ? { label: "Undo", onClick: () => void perform(s, back.parent, back.prev, { undo: null }) } : undefined,
    });
    onMoved?.(s, from, to);
    return true;
  };

  /* ── drag and drop ── */

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 8 } }),
  );

  const clearHold = () => {
    if (hold.current) clearTimeout(hold.current.t);
    hold.current = null;
  };

  const measure = (): TreeRow[] => {
    const box = boxRef.current;
    if (!box) return [];
    return rowsRef.current
      .map((r): TreeRow | null => {
        const el = box.querySelector<HTMLElement>(`[data-pt-row="${CSS.escape(r.item.slug)}"]`);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const kids = kidsKnown(kidsRef.current, r.item.slug);
        return { slug: r.item.slug, depth: r.depth, top: rect.top, bottom: rect.bottom, parent: r.parent, ancestors: r.ancestors, open: open.has(r.item.slug), hasKids: hasKids(kidsRef.current, r.item), kids: kids ? kids.map((k) => k.slug) : null };
      })
      .filter((r): r is TreeRow => !!r);
  };

  const describe = (d: TreeDrop | null): string => {
    if (!d || d.noop) return "Back in its place.";
    if (!d.valid) return "A page can't go inside itself or one of its own sub-pages.";
    if (d.kind === "inside") return `Inside ${titleOf(d.row)}.`;
    if (!d.parent) return "At the top level.";
    return `In ${titleOf(d.parent) ?? "its parent"}, ${d.after ? `after ${titleOf(d.after)}` : "first"}.`;
  };

  const onDragStart = (e: DragStartEvent) => {
    const s = (e.active.data.current as { slug?: string } | undefined)?.slug;
    if (!s) return;
    setDragging(s);
    setDrop(null);
    dropRef.current = null;
    setSaid(`Moving ${titleOf(s)}. Drop on a page to put it inside, or between two pages.`);
  };

  const onDragMove = (e: DragMoveEvent) => {
    const s = draggingSlug ?? (e.active.data.current as { slug?: string } | undefined)?.slug;
    const box = boxRef.current;
    if (!s || !box) return;
    const ev = e.activatorEvent as PointerEvent | TouchEvent;
    const p0 = "touches" in ev ? ev.touches[0] : ev;
    if (!p0) return;
    const x = p0.clientX + e.delta.x;
    const y = p0.clientY + e.delta.y;
    const b = box.getBoundingClientRect();
    // Off the tree sideways: nothing.
    if (x < b.left - 40 || x > b.right + 40 || y < b.top - 24 || y > b.bottom + 32) {
      clearHold();
      if (dropRef.current) setSaid("Not over the tree.");
      dropRef.current = null;
      setDrop(null);
      return;
    }
    const place = placeOf(s);
    const blocked = subtree(s, Object.fromEntries(Object.entries(kidsRef.current).filter(([, v]) => Array.isArray(v))));
    const d = dropAt(measure(), { x, y, left: b.left + 10 }, { slug: s, parent: place.parent, prev: place.prev, blocked, minDepth: rootParentKnown ? 0 : 1 });
    const prev = dropRef.current;
    const same = prev && d && prev.kind === d.kind && prev.row === d.row && prev.parent === d.parent && prev.after === d.after;
    if (!same) {
      dropRef.current = d;
      setDrop(d ? { ...d, y: d.y - b.top } : null);
      setSaid(describe(d));
    }
    // Hover-hold on a collapsed page with sub-pages opens it.
    if (d && d.kind === "inside" && d.valid) {
      const row = rowsRef.current.find((r) => r.item.slug === d.row);
      if (row && !open.has(d.row) && hasKids(kidsRef.current, row.item)) {
        if (hold.current?.slug !== d.row) {
          clearHold();
          hold.current = { slug: d.row, t: setTimeout(() => { setOpen((o) => new Set(o).add(d.row)); hold.current = null; }, HOLD_MS) };
        }
        return;
      }
    }
    clearHold();
  };

  const end = () => {
    clearHold();
    setDragging(null);
    setDrop(null);
    dropRef.current = null;
    suppress.current = Date.now();
  };

  const onDragEnd = (e: DragEndEvent) => {
    const s = (e.active.data.current as { slug?: string } | undefined)?.slug;
    const d = dropRef.current;
    end();
    if (!s || !d || !d.valid || d.noop) {
      setSaid(d && !d.valid ? "Not moved: a page can't go inside itself." : "Not moved.");
      return;
    }
    const was = placeOf(s);
    void perform(s, d.parent, d.after, { undo: was });
  };

  /* ── row menus ── */

  const menuFor = (row: Row): MenuEntry[] => {
    if (!canEdit) return [];
    const name = row.item.title || "Untitled";
    const out: MenuEntry[] = [];
    if (row.depth > 0 || rootParentKnown) out.push({ label: "Move to…", icon: "arrowRight", onClick: () => setMoving(row) });
    out.push({ label: "Duplicate", icon: "copy", onClick: () => void dup.duplicate({ slug: row.item.slug, title: row.item.title }, { onDone: () => { if (row.parent) load(row.parent, true); else if (workspaceId) workspaceChanged(workspaceId); } }) });
    out.push({
      label: "Copy link",
      icon: "link",
      onClick: () => void copyText(new URL(hrefFor(row.item.slug, row.ancestors, addressing), window.location.origin).toString()).then((ok) => (ok ? toast.success(`Link to “${name}” copied`) : toast.error("Couldn't copy"))),
    });
    return out;
  };
  // Rows are memoised: they get one function that always runs the latest menu.
  const menuRef = useRef(menuFor);
  menuRef.current = menuFor;
  const menu = useCallback((row: Row) => menuRef.current(row), []);

  if (!hasKids(kidsOf, root) && !crumbs.length) return null;
  const rootRow = rows[0]!;
  const line = drop && drop.kind !== "inside" && drop.valid && !drop.noop ? drop : null;
  const dragged = draggingSlug ? rows.find((r) => r.item.slug === draggingSlug) : null;
  const tree = (
    <div ref={boxRef} className="pt-tree" data-dragging={draggingSlug ? "" : undefined}>
      <ul className="pb-tree ph-no-capture">
        <TreeBranch row={rootRow} rows={rows} kidsOf={kidsOf} open={open} current={slug} addressing={addressing} toggle={toggle} canEdit={canEdit} draggingSlug={draggingSlug} drop={drop} busy={busy} menu={menu} suppress={suppress} />
      </ul>
      {line && <div className="pt-line" aria-hidden style={{ top: line.y, left: 20 + line.depth * TREE_INDENT }} data-pt-line={line.kind} />}
    </div>
  );
  return (
    <nav aria-label="Pages" className="no-print">
      <h2 className="text-eyebrow uppercase text-text-muted mb-2 mt-0">Pages</h2>
      {canEdit ? (
        <DndContext
          sensors={sensors}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
          onDragCancel={() => { end(); setSaid("Move cancelled."); }}
          accessibility={{
            screenReaderInstructions: { draggable: "To move a page without dragging, open its actions menu and choose Move to." },
            announcements: { onDragStart: () => undefined, onDragOver: () => undefined, onDragEnd: () => undefined, onDragCancel: () => undefined },
          }}
        >
          {tree}
          <DragOverlay dropAnimation={null} zIndex={60} modifiers={[followPointer]}>
            {dragged ? (
              <div className={cx("pt-ghost ph-no-capture", drop && !drop.valid && "pt-ghost--no")}>
                <Icon name={hasKids(kidsOf, dragged.item) ? "layers" : "lines"} size={14} aria-hidden />
                <span className="ph-sensitive ph-mask" dir="auto">{dragged.item.title || "Untitled"}</span>
                {drop && !drop.valid && <span className="pt-ghost__why">Can&apos;t go inside itself</span>}
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : (
        tree
      )}
      <p className="md-visually-hidden" aria-live="assertive" aria-atomic="true">{said}</p>
      {mover.dialog}
      {dup.dialog}
      {moving && (
        <MovePageDialog
          open
          onClose={() => setMoving(null)}
          page={{
            slug: moving.item.slug,
            title: moving.item.title,
            workspaceId,
            parent: moving.parent,
            parentTitle: titleOf(moving.parent),
            childrenCount: hasKids(kidsOf, moving.item) ? 1 : 0,
            folderPath: addressing.folderPath,
          }}
          onMoved={(to) => {
            toast.success(`Moved “${moving.item.title?.trim() || "Untitled"}” to ${to.label}`);
            // Ask again for every open branch (the page left one and may have joined another).
            setKidsOf({});
            if (to.parent) setOpen((o) => new Set(o).add(to.parent!));
            onMoved?.(moving.item.slug, moving.parent, to.parent);
          }}
        />
      )}
    </nav>
  );
}

export default PageTree;
