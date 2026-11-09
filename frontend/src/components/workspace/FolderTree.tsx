"use client";

/**
 * A keyboard-operable tree (WAI-ARIA APG "Treeview"), used two ways:
 *
 * - "nav": the rail's workspace tree. Items are links (role="treeitem" on the <a>); Enter follows
 *   the link. Items can be drop targets and drag sources (WorkspaceDnd), and carry hover actions
 *   (+ and ⋯) beside the link.
 * - "select": the "Move to…" picker. Items are options; Enter or Space selects, double-click or
 *   Enter on the selected item confirms.
 *
 * Keys: ↑/↓ move, → opens or steps into the first child, ← closes or steps out to the parent,
 * Home/End jump, and typing a letter jumps to the next item starting with it. One item is in the
 * tab order (roving tabindex): the current page, else the selection, else the first.
 *
 * The rendered list is flat (aria-level / aria-setsize / aria-posinset carry the structure), so
 * indentation is just padding (12 px a level, with a faint guide line per level drawn by
 * tree.css) and can be capped on phones without changing the semantics. Rows are memoised: the
 * handlers they get never change identity, so a parent re-render (a URL change, typing in a
 * search) re-renders no row whose node didn't change. The current item scrolls into view in its
 * scroll container when it changes (or first appears after its branch loads).
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Anchor, Dropdown, Icon, IconButton, Skeleton, Spinner, cx, type MenuEntry } from "@/components/ui";
import { useFolderDrop, useWorkspaceDraggable, type DragData, type DropData } from "./WorkspaceDnd";
import "./tree.css";

export interface TreeNode {
  key: string;
  label: string;
  icon?: React.ReactNode;
  count?: number;
  href?: string;
  children?: TreeNode[];
  /** Children exist but haven't loaded yet (placeholder rows show while it's open). */
  lazy?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  drop?: DropData | null;
  drag?: DragData | null;
  /** A quiet marker after the label (e.g. "shared"). */
  marker?: React.ReactNode;
  /** Extra classes for this item (e.g. the workspace row is stronger). */
  className?: string;
  /** Not part of the tree semantics' expandability: always a leaf. */
  leaf?: boolean;
  /** nav: files dropped from the desktop onto this item (uploads into that folder). */
  onFiles?: (files: File[]) => void;
  /** nav: a quiet, non-interactive row (an empty-state line); not a tree item. */
  note?: boolean;
  /** nav: shown on hover / keyboard focus beside the row: "+" (a link) and a ⋯ menu. */
  actions?: { add?: { href: string; label: string } | null; menu?: MenuEntry[] | null } | null;
  /** Everything the row shows or does, as a string: `shareNodes` keeps the previous build's node
   *  (and so skips re-rendering its row) when it is unchanged. Without it the node is always new. */
  sig?: string;
}

const sameList = (a?: TreeNode[], b?: TreeNode[]) => a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]));

/**
 * Structural sharing for a rebuilt tree: a node whose `sig` and children match the previous
 * build's node of the same key IS that node, so memoised rows whose data didn't change skip
 * rendering however often the caller rebuilds (a navigation, a cache refresh, a rename elsewhere).
 * Pass the returned map back in next time.
 */
export function shareNodes(next: TreeNode[], prev: Map<string, TreeNode>): { nodes: TreeNode[]; byKey: Map<string, TreeNode> } {
  const byKey = new Map<string, TreeNode>();
  const share = (list: TreeNode[]): TreeNode[] =>
    list.map((n) => {
      const kids = n.children ? share(n.children) : undefined;
      const old = prev.get(n.key);
      const out = old && n.sig !== undefined && old.sig === n.sig && sameList(old.children, kids) ? old : kids ? { ...n, children: kids } : n;
      byKey.set(n.key, out);
      return out;
    });
  return { nodes: share(next), byKey };
}

interface Visible {
  node: TreeNode;
  level: number;
  parent: string | null;
  pos: number;
  size: number;
  expandable: boolean;
  /** A loading placeholder under an open branch (not a tree item). */
  skeleton?: boolean;
}

export interface TreeViewProps {
  label: string;
  nodes: TreeNode[];
  expanded: Set<string>;
  onToggle: (key: string, open: boolean) => void;
  mode?: "nav" | "select";
  /** nav: the item for the current page. */
  current?: string | null;
  /** select: the chosen item. */
  selected?: string | null;
  onSelect?: (key: string) => void;
  /** select: confirm (double-click, or Enter on the already selected item). */
  onActivate?: (key: string) => void;
  /** nav: a link was followed (closes the phone drawer). */
  onNavigate?: () => void;
  /** Base classes for every item. */
  itemClassName?: string;
  /** Classes for the current (nav) or selected (select) item. */
  activeClassName?: string;
  className?: string;
  id?: string;
}

const SKELETON_WIDTHS = ["62%", "48%"];

function flatten(nodes: TreeNode[], expanded: Set<string>): Visible[] {
  const out: Visible[] = [];
  const walk = (list: TreeNode[], level: number, parent: string | null) => {
    const items = list.filter((n) => !n.note);
    list.forEach((node) => {
      const expandable = !node.note && !node.leaf && (!!node.children?.length || !!node.lazy);
      const pos = items.indexOf(node) + 1;
      out.push({ node, level, parent, pos, size: items.length, expandable });
      if (!expandable || !expanded.has(node.key)) return;
      if (node.children) walk(node.children, level + 1, node.key);
      else if (node.lazy) {
        SKELETON_WIDTHS.forEach((w, i) =>
          out.push({ node: { key: `${node.key}::loading:${i}`, label: w }, level: level + 1, parent: node.key, pos: 0, size: 0, expandable: false, skeleton: true }),
        );
      }
    });
  };
  walk(nodes, 1, null);
  return out;
}

/** Scroll `el` into view inside its nearest scrolling ancestor only (never the page). */
function revealInScroller(el: HTMLElement) {
  let box = el.parentElement;
  while (box && box !== document.body) {
    const oy = getComputedStyle(box).overflowY;
    if ((oy === "auto" || oy === "scroll") && box.scrollHeight > box.clientHeight) break;
    box = box.parentElement;
  }
  if (!box || box === document.body) return;
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const pad = 48;
  if (r.top < b.top + pad) box.scrollTop -= b.top + pad - r.top;
  else if (r.bottom > b.bottom - pad) box.scrollTop += r.bottom - (b.bottom - pad);
}

interface Handlers {
  setRef: (key: string, el: HTMLElement | null) => void;
  focus: (key: string) => void;
  keyDown: (e: React.KeyboardEvent, key: string) => void;
  toggle: (key: string) => void;
  select: (key: string) => void;
  activate: (key: string) => void;
  navigate: () => void;
}

export function TreeView({
  label, nodes, expanded, onToggle, mode = "nav", current, selected, onSelect, onActivate, onNavigate,
  itemClassName, activeClassName, className, id,
}: TreeViewProps) {
  const rows = useMemo(() => flatten(nodes, expanded), [nodes, expanded]);
  const visible = useMemo(() => rows.filter((v) => !v.skeleton && !v.node.note), [rows]);
  const refs = useRef(new Map<string, HTMLElement>());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const typeahead = useRef({ text: "", at: 0 });

  // The tab stop: the focused item if it's still visible, else the current/selected one, else the first.
  const keys = useMemo(() => new Set(visible.map((v) => v.node.key)), [visible]);
  const anchorKey = (mode === "nav" ? current : selected) ?? null;
  const tabKey = focusKey && keys.has(focusKey) ? focusKey : anchorKey && keys.has(anchorKey) ? anchorKey : visible[0]?.node.key ?? null;

  // A collapsed parent that held focus keeps it (its child vanished from the list).
  useEffect(() => {
    if (focusKey && !keys.has(focusKey)) setFocusKey(null);
  }, [focusKey, keys]);

  // The current item scrolls into view when it changes, and keeps doing so for a moment while the
  // tree around it is still loading (a deep folder appears, then branches above it fill in).
  const revealed = useRef<{ key: string | null; at: number }>({ key: null, at: 0 });
  useEffect(() => {
    if (mode !== "nav" || !current) return;
    if (revealed.current.key !== current) revealed.current = { key: current, at: 0 };
    const r = revealed.current;
    if (r.at && Date.now() - r.at > 3000) return;
    const el = refs.current.get(current);
    if (!el || el.offsetParent === null) return;
    r.at ||= Date.now();
    revealInScroller(el);
  }, [mode, current, visible]);

  // Rows get handlers that never change identity; they read the latest state from here.
  const latest = useRef({ visible, expanded, onToggle, onSelect, onActivate, onNavigate, selected, mode });
  latest.current = { visible, expanded, onToggle, onSelect, onActivate, onNavigate, selected, mode };

  const focus = useCallback((key: string | null | undefined) => {
    if (!key) return;
    setFocusKey(key);
    refs.current.get(key)?.focus();
  }, []);

  const handlers = useMemo<Handlers>(() => ({
    setRef: (key, el) => { if (el) refs.current.set(key, el); else refs.current.delete(key); },
    focus: (key) => setFocusKey(key),
    toggle: (key) => { const l = latest.current; l.onToggle(key, !l.expanded.has(key)); },
    select: (key) => latest.current.onSelect?.(key),
    activate: (key) => latest.current.onActivate?.(key),
    navigate: () => latest.current.onNavigate?.(),
    keyDown: (e, key) => {
      const { visible: list, expanded: open, onToggle: toggle, onSelect: sel, onActivate: act, selected: chosen, mode: m } = latest.current;
      const i = list.findIndex((x) => x.node.key === key);
      const v = list[i];
      if (!v) return;
      const isOpen = open.has(key);
      switch (e.key) {
        case "ArrowDown": e.preventDefault(); focus(list[i + 1]?.node.key); return;
        case "ArrowUp": e.preventDefault(); focus(list[i - 1]?.node.key); return;
        case "Home": e.preventDefault(); focus(list[0]?.node.key); return;
        case "End": e.preventDefault(); focus(list[list.length - 1]?.node.key); return;
        case "ArrowRight":
          e.preventDefault();
          if (!v.expandable) return;
          if (!isOpen) toggle(key, true);
          else focus(list[i + 1]?.parent === key ? list[i + 1]!.node.key : null);
          return;
        case "ArrowLeft":
          e.preventDefault();
          if (v.expandable && isOpen) toggle(key, false);
          else focus(v.parent);
          return;
        case "Enter":
          if (m === "select") {
            e.preventDefault();
            if (v.node.disabled) return;
            if (chosen === key) act?.(key);
            else sel?.(key);
          }
          return;
        case " ":
          if (m === "select") {
            e.preventDefault();
            if (!v.node.disabled) sel?.(key);
          }
          return;
        default:
          if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && /\S/.test(e.key)) {
            const t = typeahead.current;
            const now = Date.now();
            t.text = now - t.at > 700 ? e.key.toLowerCase() : t.text + e.key.toLowerCase();
            t.at = now;
            const order = [...list.slice(i + 1), ...list.slice(0, i + 1)];
            const hit = order.find((x) => x.node.label.toLowerCase().startsWith(t.text))
              ?? (t.text.length > 1 ? undefined : order.find((x) => x.node.label.toLowerCase().startsWith(e.key.toLowerCase())));
            if (hit) {
              e.preventDefault();
              focus(hit.node.key);
            }
          }
      }
    },
  }), [focus]);

  return (
    <ul role="tree" aria-label={label} id={id} className={cx("md-tree m-0 flex list-none flex-col p-0", mode === "select" ? "md-tree--select gap-0.5" : "md-tree--nav", className)}>
      {rows.map((v) =>
        v.skeleton ? (
          <SkeletonRow key={v.node.key} level={v.level} width={v.node.label} />
        ) : v.node.note ? (
          <li key={v.node.key} role="none" className={cx("md-tree__row md-tree__note", v.node.className)} style={rowVars(v.level)}>
            <span className="md-tree__note-text">{v.node.label}</span>
          </li>
        ) : (
          <TreeItem
            key={v.node.key}
            v={v}
            mode={mode}
            open={expanded.has(v.node.key)}
            isCurrent={mode === "nav" && current === v.node.key}
            isSelected={mode === "select" && selected === v.node.key}
            tabbable={tabKey === v.node.key}
            itemClassName={itemClassName}
            activeClassName={activeClassName}
            h={handlers}
          />
        ),
      )}
    </ul>
  );
}

/** The row's level as CSS variables: tree.css indents the row and draws one guide per level. */
const rowVars = (level: number): React.CSSProperties => ({ "--tree-level": Math.min(level - 1, 8) } as React.CSSProperties);

function SkeletonRow({ level, width }: { level: number; width: string }) {
  return (
    <li role="none" aria-hidden className="md-tree__row md-tree__skeleton" style={rowVars(level)}>
      <Skeleton width={14} height={14} variant="rect" className="shrink-0" />
      <Skeleton width={width} height={10} />
    </li>
  );
}

const sameRow = (a: RowProps, b: RowProps) =>
  a.v.node === b.v.node && a.v.level === b.v.level && a.v.pos === b.v.pos && a.v.size === b.v.size &&
  a.v.expandable === b.v.expandable && a.v.parent === b.v.parent && a.open === b.open && a.isCurrent === b.isCurrent &&
  a.isSelected === b.isSelected && a.tabbable === b.tabbable && a.mode === b.mode && a.h === b.h &&
  a.itemClassName === b.itemClassName && a.activeClassName === b.activeClassName;

interface RowProps {
  v: Visible;
  mode: "nav" | "select";
  open: boolean;
  isCurrent: boolean;
  isSelected: boolean;
  tabbable: boolean;
  itemClassName?: string;
  activeClassName?: string;
  h: Handlers;
}

const TreeItem = memo(function TreeItem({ v, mode, open, isCurrent, isSelected, tabbable, itemClassName, activeClassName, h }: RowProps) {
  const { node, level, pos, size, expandable } = v;
  const key = node.key;
  const drop = useFolderDrop(key, mode === "nav" ? node.drop ?? null : null);
  const drag = useWorkspaceDraggable(`tree:${key}`, mode === "nav" ? node.drag ?? null : null);
  const loading = expandable && open && node.lazy && !node.children;
  // Hover actions mount while the row is hovered or holds focus (or its menu is open), so a long
  // tree doesn't carry a menu per row.
  const [hover, setHover] = useState(false);
  const [focusIn, setFocusIn] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const acts = mode === "nav" && node.actions && (node.actions.add || node.actions.menu?.length) ? node.actions : null;
  const armed = !!acts && (hover || focusIn || menuOpen);
  // Files from the desktop (native drag and drop, separate from dnd-kit's row moves).
  const [fileOver, setFileOver] = useState(false);
  const fileDrop = mode === "nav" && node.onFiles
    ? {
        onDragOver: (e: React.DragEvent) => {
          if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "copy";
          if (!fileOver) setFileOver(true);
        },
        onDragLeave: () => setFileOver(false),
        onDrop: (e: React.DragEvent) => {
          if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
          e.preventDefault();
          e.stopPropagation();
          setFileOver(false);
          const files = Array.from(e.dataTransfer.files ?? []);
          if (files.length) node.onFiles!(files);
        },
      }
    : {};

  const chevron = expandable ? (
    <span
      aria-hidden
      className="md-tree__chevron"
      data-open={open ? "" : undefined}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); h.toggle(key); }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {loading ? <Spinner size={12} /> : <Icon name="chevronRight" size={14} />}
    </span>
  ) : (
    <span aria-hidden className="md-tree__chevron md-tree__chevron--none" />
  );

  // A long name shows in full on hover (only when it's cut off).
  const labelRef = useRef<HTMLSpanElement>(null);
  const tip = (e: React.PointerEvent<HTMLElement>) => {
    const l = labelRef.current;
    if (!l) return;
    if (l.scrollWidth > l.clientWidth + 1) e.currentTarget.title = node.label;
    else e.currentTarget.removeAttribute("title");
  };

  const body = (
    <>
      {chevron}
      {node.icon && <span className="md-tree__icon" aria-hidden>{node.icon}</span>}
      {/* Workspace and folder names are masked in replays. */}
      <span ref={labelRef} className="ph-sensitive ph-mask min-w-0 flex-1 truncate" dir="auto">{node.label}</span>
      {node.marker}
      {node.count !== undefined && (
        <span className="ml-auto shrink-0 rounded-full bg-surface-active px-1.5 text-micro tabular-nums text-text-secondary" aria-label={`${node.count} ${node.count === 1 ? "item" : "items"}`}>
          {node.count}
        </span>
      )}
    </>
  );

  const shared = {
    role: "treeitem" as const,
    "aria-level": level,
    "aria-setsize": size,
    "aria-posinset": pos,
    "aria-expanded": expandable ? open : undefined,
    tabIndex: tabbable ? 0 : -1,
    onFocus: () => h.focus(key),
    onKeyDown: (e: React.KeyboardEvent) => h.keyDown(e, key),
    "data-rail-key": key,
    className: cx(
      "md-tree__item",
      itemClassName,
      node.className,
      (isCurrent || isSelected) && activeClassName,
      armed && "md-tree__item--armed",
      (drop.over || fileOver) && "!bg-accent-soft ring-2 ring-accent ring-inset",
      drag.isDragging && "opacity-50",
      node.disabled && "cursor-not-allowed opacity-50",
    ),
  };

  const ref = (el: HTMLElement | null) => {
    h.setRef(key, el);
    drop.setNodeRef(el);
    drag.setNodeRef(el);
  };

  return (
    <li
      role="none"
      className="md-tree__row"
      style={rowVars(level)}
      onPointerEnter={acts ? () => setHover(true) : undefined}
      onPointerLeave={acts ? () => setHover(false) : undefined}
      onFocus={acts ? () => setFocusIn(true) : undefined}
      onBlur={acts ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusIn(false); } : undefined}
    >
      {mode === "nav" && node.href ? (
        <Anchor
          {...shared}
          ref={ref as React.Ref<HTMLAnchorElement>}
          href={node.href}
          // No viewport prefetch: a rail can hold hundreds of rows, and prefetching each page (and
          // the viewer's code with it) used to fill slow connections ahead of the click
          // (fix/ws-listing). Folder links warm their rows on hover instead (lib/folderNav).
          prefetch={false}
          draggable={false}
          aria-current={isCurrent ? "page" : undefined}
          onClick={() => h.navigate()}
          onPointerEnter={tip}
          {...(drag.listeners ?? {})}
          {...fileDrop}
        >
          {body}
        </Anchor>
      ) : (
        <div
          {...shared}
          ref={ref as React.Ref<HTMLDivElement>}
          aria-selected={mode === "select" ? isSelected : undefined}
          aria-disabled={node.disabled || undefined}
          title={node.disabled ? node.disabledReason : undefined}
          onClick={mode === "select" ? () => { if (!node.disabled) h.select(key); } : () => h.toggle(key)}
          onDoubleClick={mode === "select" ? () => { if (!node.disabled) h.activate(key); } : undefined}
        >
          {body}
        </div>
      )}
      {armed && acts && (
        <span className="md-tree__actions">
          {acts.add && (
            <Anchor href={acts.add.href} className="md-tree__act md-focus" aria-label={acts.add.label} title={acts.add.label} onClick={() => h.navigate()}>
              <Icon name="plus" size={14} />
            </Anchor>
          )}
          {!!acts.menu?.length && (
            <Dropdown
              portal
              align="left"
              minWidth={200}
              open={menuOpen}
              onOpenChange={setMenuOpen}
              aria-label={`Actions for ${node.label}`}
              trigger={<IconButton icon="more" label={`More actions for ${node.label}`} size="sm" variant="ghost" className="md-tree__act" />}
              items={acts.menu}
            />
          )}
        </span>
      )}
    </li>
  );
}, sameRow);

export default TreeView;
