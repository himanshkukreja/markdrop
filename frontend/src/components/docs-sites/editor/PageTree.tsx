"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  type ScreenReaderInstructions,
} from "@dnd-kit/core";
import { ICONS, Icon, IconButton, RowMenu, Skeleton, cx, type MenuItem } from "@/components/ui";
import type { NavGroup, PageSummary } from "@/lib/docsSites";
import { firstName } from "../format";
import {
  groupKey, groupSlots, isNoop, nearestSlot, pageSlots, slotKey, stepKeyed,
  type GroupSlot, type MeasuredGroup, type NavGroupLike, type PageSlot,
} from "./navMove";

export interface TreeGroup {
  group: string;
  hidden?: boolean;
  pages: PageSummary[];
}

/** The nav's groups with their pages, then a "Hidden pages" group for pages not in the nav. */
export function groupsOf(nav: NavGroup[], pages: PageSummary[]): TreeGroup[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const listed = new Set<string>();
  const out: TreeGroup[] = nav.map((g) => ({
    group: g.group,
    pages: g.pages.map((id) => {
      listed.add(id);
      return byId.get(id);
    }).filter((p): p is PageSummary => !!p),
  }));
  const rest = pages.filter((p) => !listed.has(p.id));
  if (rest.length) out.push({ group: "Hidden pages", hidden: true, pages: rest });
  return out;
}

export const pageIcon = (icon: string | null | undefined) => (icon && icon in ICONS ? icon : "doc");

/** What the dot says: new (never published) or changed since the last publish. */
export function dotLabel(p: PageSummary): string | null {
  if (!p.has_changes) return null;
  return p.published === false ? "New, not published yet" : "Changed since the last publish";
}

/** Scrolls the tree's own scroll box (the side panel, the drawer) so `el` shows; never the page. */
function revealIn(el: HTMLElement) {
  let box = el.parentElement;
  while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
  if (!box || box === document.scrollingElement || box === document.body) return;
  const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
  if (r.top < b.top + 8) box.scrollTop -= b.top + 8 - r.top + b.height / 3;
  else if (r.bottom > b.bottom - 8) box.scrollTop += r.bottom - b.bottom + 8 + b.height / 3;
}

const collapsedKey = (siteId: string) => `guides:tree-collapsed:${siteId}`;

/** The gap between groups (the nav's gap-2.5). */
const GROUP_GAP = 10;

const INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    "To move, press Space or Enter, move with the Up and Down arrow keys, then press Space or Enter to drop. Escape cancels. Move up, Move down and Move to a group are also in each page's menu.",
};

type DragWhat = { kind: "page"; page: PageSummary } | { kind: "group"; group: string; index: number };
type Slot = ({ kind: "page" } & PageSlot) | ({ kind: "group" } & GroupSlot);

/** Where a drop lands, drawn: a line at `top` (relative to the tree), or a lit collapsed group. */
interface Shown {
  slot: Slot | null;
  top: number;
  noop: boolean;
}

/** The drag handle: shown on hover or keyboard focus (always on touch screens). */
function Grip({ label, handle, className }: { label: string; handle: ReturnType<typeof useDraggable>; className?: string }) {
  return (
    <button
      type="button"
      ref={handle.setActivatorNodeRef}
      {...handle.attributes}
      {...handle.listeners}
      aria-label={label}
      title="Drag to move"
      className={cx(
        "md-focus inline-flex shrink-0 cursor-grab touch-none items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text active:cursor-grabbing",
        "opacity-100 lg:pointer-fine:opacity-0 lg:pointer-fine:focus-visible:opacity-100",
        className,
      )}
    >
      <Icon name="grip" size={13} />
    </button>
  );
}

/**
 * The editor's page tree (left): a page search and New page, then the groups (collapsible) and
 * their pages in nav order with their icons; a lock and the editor's first name on a page someone
 * else is editing; one accent dot on pages new or changed since the last publish (the legend
 * under the tree says so). Pages are links (`?page=<id>`); each has a menu to move or delete it.
 *
 * Editors drag pages by the grip left of each (within a group, into another group, an unlisted
 * page into a group) and groups by the grip on their header; a line shows where it lands. The
 * keyboard does the same from a grip (Space, arrows, Space; Escape cancels). A page's address
 * never changes with where it sits.
 */
export function PageTree({
  siteId, groups, currentId, myId, hrefFor, onOpen, canEdit, onNewPage, onMove, onMoveToGroup, onDropPage, onDropGroup, onDelete, loading, comments, privateLabels,
}: {
  siteId: string;
  groups: TreeGroup[] | null;
  currentId: string | null;
  myId: string | null;
  hrefFor: (id: string) => string;
  onOpen: (id: string) => void;
  canEdit: boolean;
  onNewPage: () => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onMoveToGroup: (id: string, group: string) => void;
  /** A page dropped in `group` before page `beforeId` (null: at the group's end). */
  onDropPage?: (id: string, group: string, beforeId: string | null) => void;
  /** The group at `from` dropped before the group now at `to` (indexes of the nav's groups). */
  onDropGroup?: (from: number, to: number) => void;
  onDelete: (p: PageSummary) => void;
  loading?: boolean;
  /** Private pages (page id → who can open it), shown with a badge. */
  privateLabels?: Record<string, string>;
  /** Open review comments per page. */
  comments?: Record<string, number>;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const raw = localStorage.getItem(collapsedKey(siteId));
      if (raw) setCollapsed(new Set(JSON.parse(raw) as string[]));
    } catch { /* a convenience only */ }
  }, [siteId]);
  const setGroupOpen = (g: string, open: boolean) => {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (open) next.delete(g);
      else next.add(g);
      try { localStorage.setItem(collapsedKey(siteId), JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };

  const visible = useMemo(() => groups?.filter((g) => !g.hidden) ?? [], [groups]);
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!groups) return null;
    if (!q) return groups;
    return groups
      .map((g) => ({ ...g, pages: g.pages.filter((p) => (p.title || "").toLowerCase().includes(q) || p.path.toLowerCase().includes(q)) }))
      .filter((g) => g.pages.length);
  }, [groups, q]);
  const anyDot = !!groups?.some((g) => g.pages.some((p) => p.has_changes));

  // The open page in a collapsed group (a deep link, a check's "create it"): open its group.
  const currentGroup = groups?.find((g) => g.pages.some((p) => p.id === currentId))?.group;
  useEffect(() => {
    if (currentGroup && collapsed.has(currentGroup)) setGroupOpen(currentGroup, true);
  }, [currentId, currentGroup]); // eslint-disable-line react-hooks/exhaustive-deps

  // The open page in a long tree (a deep link, the drawer opening): bring it into view.
  const navRef = useRef<HTMLElement>(null);
  const loaded = !!groups;
  useEffect(() => {
    const el = navRef.current?.querySelector<HTMLElement>('a[aria-current="page"]');
    if (el) revealIn(el);
  }, [currentId, loaded]);

  /* ── Drag and drop ── */
  const canDrag = canEdit && !q && !!onDropPage;
  const navLike: NavGroupLike[] = useMemo(() => visible.map((g) => ({ group: g.group, pages: g.pages.map((p) => p.id) })), [visible]);
  const [dragging, setDragging] = useState<DragWhat | null>(null);
  const [drop, setDrop] = useState<Shown | null>(null);
  const [said, setSaid] = useState("");
  const slotRef = useRef<Slot | null>(null);
  const whatRef = useRef<DragWhat | null>(null);

  /** The places the dragged row can land, measured from the tree as it is now. */
  const measure = (what: DragWhat): Slot[] => {
    const nav = navRef.current;
    if (!nav) return [];
    const els = Array.from(nav.querySelectorAll<HTMLElement>("[data-tree-group]")).filter((el) => el.dataset.treeHidden !== "1");
    if (what.kind === "group") return groupSlots(els.map((el) => el.getBoundingClientRect()), GROUP_GAP).map((s) => ({ kind: "group" as const, ...s }));
    const measured: MeasuredGroup[] = els.map((el) => {
      const name = el.dataset.treeGroup ?? "";
      const list = el.querySelector<HTMLElement>("[data-tree-list]");
      const rows = list && !list.hidden ? Array.from(list.querySelectorAll<HTMLElement>("[data-tree-row]")).map((r) => r.getBoundingClientRect()) : [];
      const head = el.querySelector<HTMLElement>("[data-tree-head]")!.getBoundingClientRect();
      return { group: name, count: navLike.find((g) => g.group === name)?.pages.length ?? 0, rows, head };
    });
    return pageSlots(measured).map((s) => ({ kind: "page" as const, ...s }));
  };
  const keyOf = (what: DragWhat) => (s: Slot): string =>
    s.kind === "page" && what.kind === "page" ? slotKey(navLike, what.page.id, s) : s.kind === "group" && what.kind === "group" ? groupKey(what.index, s) : "";
  const noopOf = (what: DragWhat, s: Slot): boolean =>
    s.kind === "page" && what.kind === "page" ? isNoop(navLike, what.page.id, s) : s.kind === "group" && what.kind === "group" ? s.index === what.index || s.index === what.index + 1 : true;

  /** What a drop at `s` does, in words (for the live region). */
  const describe = (what: DragWhat, s: Slot | null): string => {
    if (!s || noopOf(what, s)) return "Back in its place.";
    if (s.kind === "group") return s.index < visible.length ? `Before the group ${visible[s.index]!.group}.` : "After the last group.";
    const g = visible.find((x) => x.group === s.group);
    const before = s.into ? null : g?.pages[s.index];
    return before ? `In ${s.group}, before ${before.title || "Untitled"}.` : `At the end of ${s.group}.`;
  };

  const show = (what: DragWhat, s: Slot | null) => {
    const prev = slotRef.current;
    const changed = !prev !== !s || (!!s && !!prev && (keyOf(what)(s) !== keyOf(what)(prev) || noopOf(what, s) !== noopOf(what, prev)));
    slotRef.current = s;
    const top = s && navRef.current ? s.y - navRef.current.getBoundingClientRect().top : 0;
    setDrop({ slot: s, top, noop: !s || noopOf(what, s) });
    if (changed) setSaid(describe(what, s));
  };

  // The keyboard moves the dragged row from slot to slot (dnd-kit moves it there; onDragMove then reads it back).
  const coordinateGetter: KeyboardCoordinateGetter = (event, { context, currentCoordinates }) => {
    const what = whatRef.current;
    const rect = context.collisionRect;
    if (!what || !rect) return undefined;
    const dir = event.code === "ArrowDown" ? 1 : event.code === "ArrowUp" ? -1 : 0;
    if (!dir) return undefined;
    event.preventDefault();
    const slots = measure(what);
    const center = rect.top + rect.height / 2;
    // An unlisted page starts below every group: its first press goes to the nearest place.
    const next = slotRef.current ? stepKeyed(slots, slotRef.current, dir, keyOf(what)) : nearestSlot(slots, center);
    if (!next) return undefined;
    return { x: currentCoordinates.x, y: currentCoordinates.y + (next.y - center) };
  };
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter }),
  );

  const onDragStart = (e: DragStartEvent) => {
    const what = e.active.data.current as DragWhat | undefined;
    if (!what) return;
    whatRef.current = what;
    setDragging(what);
    const slots = measure(what);
    // Start on its own place, so the first arrow press moves it one place.
    const own = slots.find((s) => noopOf(what, s)) ?? null;
    slotRef.current = own;
    setDrop({ slot: own, top: 0, noop: true });
    setSaid(what.kind === "page" ? `Moving ${what.page.title || "Untitled"}.` : `Moving the group ${what.group}.`);
  };
  const onDragMove = (e: DragMoveEvent) => {
    const what = whatRef.current;
    const r = e.active.rect.current.translated;
    if (!what || !r) return;
    show(what, nearestSlot(measure(what), r.top + r.height / 2));
  };
  const end = () => {
    whatRef.current = null;
    slotRef.current = null;
    setDragging(null);
    setDrop(null);
  };
  const onDragEnd = () => {
    const what = whatRef.current;
    const s = slotRef.current;
    end();
    if (!what || !s || noopOf(what, s)) return setSaid("Not moved.");
    setSaid(`Moved. ${describe(what, s)}`);
    if (what.kind === "group" && s.kind === "group") onDropGroup?.(what.index, s.index);
    else if (what.kind === "page" && s.kind === "page") {
      const g = visible.find((x) => x.group === s.group);
      onDropPage?.(what.page.id, s.group, s.into ? null : g?.pages[s.index]?.id ?? null);
    }
  };

  const intoGroup = drop?.slot?.kind === "page" && drop.slot.into && !drop.noop ? drop.slot.group : null;
  const line = drop?.slot && !drop.noop && !intoGroup ? drop : null;

  const tree = (
    <nav ref={navRef} aria-label="Pages" className="relative flex flex-1 flex-col gap-2.5 pb-3">
      {loading && !groups && (
        <div className="flex flex-col gap-2 px-2 pt-2" aria-busy="true">
          {[70, 55, 62, 48, 66].map((w, i) => <Skeleton key={i} width={`${w}%`} />)}
        </div>
      )}
      {shown && q && !shown.length && <p className="px-2 py-3 text-[13px] text-text-muted">No pages match “<span className="ph-no-capture">{query.trim()}</span>”.</p>}
      {shown?.map((g) => {
        const open = !!q || !collapsed.has(g.group);
        const listId = `tree-${g.group.replace(/[^a-zA-Z0-9]+/g, "-")}`;
        return (
          <TreeGroupBox
            key={g.group}
            g={g}
            index={visible.findIndex((x) => x.group === g.group)}
            open={open}
            listId={listId}
            q={q}
            lit={intoGroup === g.group}
            dragOn={canDrag && !g.hidden && !!onDropGroup}
            dimmed={dragging?.kind === "group" && dragging.group === g.group}
            onToggle={() => setGroupOpen(g.group, !open)}
          >
            {g.pages.map((p, i) => {
              const lockedByOther = !!p.lock && p.lock.user_id !== myId;
              const items: MenuItem[] = [];
              if (!g.hidden && !q) {
                items.push({ label: "Move up", icon: "arrowUp", disabled: i === 0, onClick: () => onMove(p.id, -1) });
                items.push({ label: "Move down", icon: "arrowDown", disabled: i === g.pages.length - 1, onClick: () => onMove(p.id, 1) });
              }
              // A page hidden from the sidebar (its own setting) can't be listed in a group.
              if (!p.hidden) for (const other of visible) if (other.group !== g.group) items.push({ label: `Move to ${other.group}`, icon: "folder", onClick: () => onMoveToGroup(p.id, other.group), separated: other === visible.find((x) => x.group !== g.group) });
              items.push({ label: "Delete page", icon: "trash", danger: true, separated: true, disabled: lockedByOther || p.path === "/", onClick: () => onDelete(p) });
              return (
                <PageRow
                  key={p.id}
                  p={p}
                  on={p.id === currentId}
                  muted={!!g.hidden}
                  lockedByOther={lockedByOther}
                  talk={comments?.[p.id] ?? 0}
                  priv={privateLabels?.[p.id]}
                  href={hrefFor(p.id)}
                  onOpen={() => onOpen(p.id)}
                  canEdit={canEdit}
                  items={items}
                  dragOn={canDrag && !p.hidden}
                  dimmed={dragging?.kind === "page" && dragging.page.id === p.id}
                />
              );
            })}
          </TreeGroupBox>
        );
      })}
      {line && (
        <div
          aria-hidden
          className={cx("pointer-events-none absolute right-1 z-20 h-0.5 -translate-y-1/2 rounded-full bg-accent", line.slot?.kind === "group" ? "left-1.5" : "left-[18px]")}
          style={{ top: line.top }}
        >
          <span className="absolute -left-1.5 top-1/2 size-2 -translate-y-1/2 rounded-full border-2 border-accent bg-surface" />
        </div>
      )}
    </nav>
  );

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex items-center gap-1.5 px-1 pb-2">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md bg-surface-inset px-2.5 pointer-coarse:h-11 text-text-muted focus-within:ring-2 focus-within:ring-border-focus">
          <Icon name="search" size={13} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape" && query) { e.preventDefault(); setQuery(""); } }}
            placeholder="Search pages"
            aria-label="Search pages"
            className="ph-no-capture min-w-0 flex-1 border-0 bg-transparent text-[13px] text-text outline-none placeholder:text-text-muted [&::-webkit-search-cancel-button]:hidden"
          />
        </label>
        {canEdit && <IconButton icon="plus" label="New page" size="sm" variant="ghost" onClick={onNewPage} />}
      </div>
      {canDrag ? (
        <DndContext
          sensors={sensors}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
          onDragCancel={() => { end(); setSaid("Move cancelled."); }}
          accessibility={{
            screenReaderInstructions: INSTRUCTIONS,
            // The live region below says where it lands (dnd-kit's own messages would name ids).
            announcements: { onDragStart: () => undefined, onDragOver: () => undefined, onDragEnd: () => undefined, onDragCancel: () => undefined },
          }}
        >
          {tree}
          <DragOverlay dropAnimation={null} zIndex={10}>
            {dragging && (
              <div className="ph-no-capture flex h-full min-h-[30px] cursor-grabbing opacity-90 items-center gap-2 rounded-md border border-border bg-surface-raised px-2.5 text-[13px] font-medium text-text shadow-md">
                {dragging.kind === "page" ? (
                  <>
                    <span className="inline-flex shrink-0 text-text-muted"><Icon name={pageIcon(dragging.page.icon)} size={14} /></span>
                    <span className="min-w-0 flex-1 truncate">{dragging.page.title || "Untitled"}</span>
                  </>
                ) : (
                  <>
                    <span className="inline-flex shrink-0 text-text-muted"><Icon name="folder" size={13} /></span>
                    <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{dragging.group}</span>
                    <span className="shrink-0 text-[12px] text-text-muted">{countLabel(navLike.find((x) => x.group === dragging.group)?.pages.length ?? 0)}</span>
                  </>
                )}
              </div>
            )}
          </DragOverlay>
        </DndContext>
      ) : tree}
      <p className="md-visually-hidden" aria-live="assertive" aria-atomic="true">{said}</p>
      {anyDot && (
        <p className="sticky bottom-0 -mx-2.5 mt-auto flex items-center gap-2 border-t border-border bg-surface px-4 py-2.5 text-[12px] text-text-muted">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-accent" />
          New or changed since the last publish
        </p>
      )}
    </div>
  );
}

const countLabel = (n: number) => `${n} ${n === 1 ? "page" : "pages"}`;

/** A group: its header (toggle, and a grip to drag the group) and its pages. */
function TreeGroupBox({
  g, index, open, listId, q, lit, dragOn, dimmed, onToggle, children,
}: {
  g: TreeGroup;
  index: number;
  open: boolean;
  listId: string;
  q: string;
  lit: boolean;
  dragOn: boolean;
  dimmed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const handle = useDraggable({ id: `g:${g.group}`, data: { kind: "group", group: g.group, index }, disabled: !dragOn });
  return (
    // ph-no-capture: group names and page titles (in text, labels and menus) are the customer's words.
    <div
      role="group"
      aria-label={g.group}
      data-tree-group={g.group}
      data-tree-hidden={g.hidden ? "1" : undefined}
      className={cx("ph-no-capture flex flex-col gap-px", dimmed && "opacity-40")}
    >
      <div
        ref={handle.setNodeRef}
        data-tree-head=""
        className={cx("group/head flex items-center rounded-md transition-colors", lit && "bg-accent-soft ring-1 ring-accent")}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={onToggle}
          disabled={!!q}
          className={cx(
            "md-focus flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 text-left text-[12px] font-semibold disabled:cursor-default pointer-coarse:h-11",
            lit ? "text-accent-text" : g.hidden ? "text-text-subtle" : "text-text-muted",
            !q && !lit && "hover:text-text",
          )}
        >
          <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
          <span className="min-w-0 flex-1 truncate">{g.group}</span>
          {!open && g.pages.some((p) => p.has_changes) && <span aria-hidden className="mr-1.5 size-1.5 shrink-0 rounded-full bg-accent" />}
        </button>
        {dragOn && <Grip label={`Move the group ${g.group}`} handle={handle} className="mr-0.5 h-6 w-5 lg:group-hover/head:opacity-100 max-lg:h-9 max-lg:w-9 pointer-coarse:size-11" />}
      </div>
      <div id={listId} data-tree-list="" hidden={!open} className="flex flex-col gap-px">
        {children}
      </div>
    </div>
  );
}

/** A page row: the link (icon, title, lock, comments, dot), a grip on its left and its menu on the right. */
function PageRow({
  p, on, muted, lockedByOther, talk, priv, href, onOpen, canEdit, items, dragOn, dimmed,
}: {
  p: PageSummary;
  on: boolean;
  muted: boolean;
  lockedByOther: boolean;
  talk: number;
  /** Who can open it, when it is a private page. */
  priv?: string;
  href: string;
  onOpen: () => void;
  canEdit: boolean;
  items: MenuItem[];
  dragOn: boolean;
  dimmed: boolean;
}) {
  const handle = useDraggable({ id: `p:${p.id}`, data: { kind: "page", page: p }, disabled: !dragOn });
  const dot = dotLabel(p);
  return (
    <div
      ref={handle.setNodeRef}
      data-tree-row=""
      className={cx("group/row relative flex min-w-0 items-center rounded-md", on ? "bg-surface-active" : "hover:bg-surface-hover", dimmed && "opacity-40")}
    >
      {dragOn && (
        <Grip
          label={`Move ${p.title || "Untitled"}`}
          handle={handle}
          className="absolute left-0.5 top-1/2 z-[1] h-6 w-[18px] -translate-y-1/2 lg:group-hover/row:opacity-100 max-lg:left-0 max-lg:h-11 max-lg:w-[22px] pointer-coarse:left-0 pointer-coarse:h-11 pointer-coarse:w-11"
        />
      )}
      <a
        href={href}
        aria-current={on ? "page" : undefined}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          onOpen();
        }}
        className={cx(
          "md-focus flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-md pl-[22px] pr-2 text-[13px] no-underline max-lg:h-11 pointer-coarse:h-11 pointer-coarse:pl-11",
          on ? "font-semibold text-text" : "font-medium text-text-secondary",
          muted && !on && "text-text-muted",
        )}
      >
        <span className={cx("inline-flex shrink-0", on ? "text-text" : "text-text-muted")}><Icon name={pageIcon(p.icon)} size={14} /></span>
        <span className="min-w-0 flex-1 truncate" dir="auto" title={p.title || undefined}>{p.title || "Untitled"}</span>
        {priv && (
          <span className="inline-flex shrink-0 text-text-muted" title={`Private: ${priv}`} data-private="">
            <Icon name="eyeOff" size={12} />
            <span className="md-visually-hidden">, private ({priv})</span>
          </span>
        )}
        {p.origin?.kind === "github" && (
          <span className="inline-flex shrink-0 text-text-muted" title="From GitHub">
            <Icon name="github" size={11} />
            <span className="md-visually-hidden">, from GitHub</span>
          </span>
        )}
        {lockedByOther && (
          <span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-warning" title={`${p.lock!.name} is editing`}>
            <Icon name="lock" size={11} />
            {firstName(p.lock!.name)}
            <span className="md-visually-hidden"> is editing</span>
          </span>
        )}
        {talk > 0 && (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[12px] text-text-muted" title={`${talk} open ${talk === 1 ? "comment" : "comments"}`}>
            <Icon name="message" size={11} />{talk}
            <span className="md-visually-hidden"> open comments</span>
          </span>
        )}
        {dot && (
          <span className="size-1.5 shrink-0 rounded-full bg-accent" title={dot}>
            <span className="md-visually-hidden">, {dot.toLowerCase()}</span>
          </span>
        )}
      </a>
      {canEdit && (
        <div className="shrink-0 pr-0.5 opacity-100 lg:pointer-fine:opacity-0 lg:group-focus-within/row:opacity-100 lg:group-hover/row:opacity-100">
          <RowMenu label={`More for ${p.title || "this page"}`} items={items} portal />
        </div>
      )}
    </div>
  );
}

export default PageTree;
