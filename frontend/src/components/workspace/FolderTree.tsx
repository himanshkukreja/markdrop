"use client";

/**
 * A keyboard-operable tree (WAI-ARIA APG "Treeview"), used two ways:
 *
 * - "nav": the rail's workspace tree. Items are links (role="treeitem" on the <a>); Enter follows
 *   the link. Items can be drop targets and drag sources (WorkspaceDnd).
 * - "select": the "Move to…" picker. Items are options; Enter or Space selects, double-click or
 *   Enter on the selected item confirms.
 *
 * Keys: ↑/↓ move, → opens or steps into the first child, ← closes or steps out to the parent,
 * Home/End jump, and typing a letter jumps to the next item starting with it. One item is in the
 * tab order (roving tabindex): the current page, else the selection, else the first.
 *
 * The rendered list is flat (aria-level / aria-setsize / aria-posinset carry the structure), so
 * indentation is just padding and can be capped on phones without changing the semantics.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Anchor, Icon, Spinner, cx } from "@/components/ui";
import { useFolderDrop, useWorkspaceDraggable, type DragData, type DropData } from "./WorkspaceDnd";

export interface TreeNode {
  key: string;
  label: string;
  icon?: React.ReactNode;
  count?: number;
  href?: string;
  children?: TreeNode[];
  /** Children exist but haven't loaded yet (shows a spinner when opened). */
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
}

interface Visible {
  node: TreeNode;
  level: number;
  parent: string | null;
  pos: number;
  size: number;
  expandable: boolean;
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

function flatten(nodes: TreeNode[], expanded: Set<string>): Visible[] {
  const out: Visible[] = [];
  const walk = (list: TreeNode[], level: number, parent: string | null) => {
    list.forEach((node, i) => {
      const expandable = !node.leaf && (!!node.children?.length || !!node.lazy);
      out.push({ node, level, parent, pos: i + 1, size: list.length, expandable });
      if (expandable && expanded.has(node.key) && node.children) walk(node.children, level + 1, node.key);
    });
  };
  walk(nodes, 1, null);
  return out;
}

export function TreeView({
  label, nodes, expanded, onToggle, mode = "nav", current, selected, onSelect, onActivate, onNavigate,
  itemClassName, activeClassName, className, id,
}: TreeViewProps) {
  const visible = useMemo(() => flatten(nodes, expanded), [nodes, expanded]);
  const refs = useRef(new Map<string, HTMLElement>());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const typeahead = useRef({ text: "", at: 0 });

  // The tab stop: the focused item if it's still visible, else the current/selected one, else the first.
  const keys = useMemo(() => new Set(visible.map((v) => v.node.key)), [visible]);
  const anchorKey = (mode === "nav" ? current : selected) ?? null;
  const tabKey = focusKey && keys.has(focusKey) ? focusKey : anchorKey && keys.has(anchorKey) ? anchorKey : visible[0]?.node.key ?? null;

  const focus = useCallback((key: string | null | undefined) => {
    if (!key) return;
    setFocusKey(key);
    refs.current.get(key)?.focus();
  }, []);

  // A collapsed parent that held focus keeps it (its child vanished from the list).
  useEffect(() => {
    if (focusKey && !keys.has(focusKey)) setFocusKey(null);
  }, [focusKey, keys]);

  function onKeyDown(e: React.KeyboardEvent, v: Visible) {
    const i = visible.findIndex((x) => x.node.key === v.node.key);
    const open = expanded.has(v.node.key);
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focus(visible[i + 1]?.node.key);
        return;
      case "ArrowUp":
        e.preventDefault();
        focus(visible[i - 1]?.node.key);
        return;
      case "Home":
        e.preventDefault();
        focus(visible[0]?.node.key);
        return;
      case "End":
        e.preventDefault();
        focus(visible[visible.length - 1]?.node.key);
        return;
      case "ArrowRight":
        e.preventDefault();
        if (!v.expandable) return;
        if (!open) onToggle(v.node.key, true);
        else focus(visible[i + 1]?.parent === v.node.key ? visible[i + 1]!.node.key : null);
        return;
      case "ArrowLeft":
        e.preventDefault();
        if (v.expandable && open) onToggle(v.node.key, false);
        else focus(v.parent);
        return;
      case "Enter":
        if (mode === "select") {
          e.preventDefault();
          if (v.node.disabled) return;
          if (selected === v.node.key) onActivate?.(v.node.key);
          else onSelect?.(v.node.key);
        }
        return;
      case " ":
        if (mode === "select") {
          e.preventDefault();
          if (!v.node.disabled) onSelect?.(v.node.key);
        }
        return;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && /\S/.test(e.key)) {
          const t = typeahead.current;
          const now = Date.now();
          t.text = now - t.at > 700 ? e.key.toLowerCase() : t.text + e.key.toLowerCase();
          t.at = now;
          const order = [...visible.slice(i + 1), ...visible.slice(0, i + 1)];
          const hit = order.find((x) => x.node.label.toLowerCase().startsWith(t.text))
            ?? (t.text.length > 1 ? undefined : order.find((x) => x.node.label.toLowerCase().startsWith(e.key.toLowerCase())));
          if (hit) {
            e.preventDefault();
            focus(hit.node.key);
          }
        }
    }
  }

  return (
    <ul role="tree" aria-label={label} id={id} className={cx("m-0 flex list-none flex-col gap-0.5 p-0", className)}>
      {visible.map((v) => (
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
          setRef={(el) => { if (el) refs.current.set(v.node.key, el); else refs.current.delete(v.node.key); }}
          onFocus={() => setFocusKey(v.node.key)}
          onKeyDown={(e) => onKeyDown(e, v)}
          onToggle={() => onToggle(v.node.key, !expanded.has(v.node.key))}
          onSelect={() => { if (!v.node.disabled) onSelect?.(v.node.key); }}
          onActivate={() => { if (!v.node.disabled) onActivate?.(v.node.key); }}
          onNavigate={onNavigate}
        />
      ))}
    </ul>
  );
}

function TreeItem({
  v, mode, open, isCurrent, isSelected, tabbable, itemClassName, activeClassName, setRef, onFocus, onKeyDown, onToggle,
  onSelect, onActivate, onNavigate,
}: {
  v: Visible;
  mode: "nav" | "select";
  open: boolean;
  isCurrent: boolean;
  isSelected: boolean;
  tabbable: boolean;
  itemClassName?: string;
  activeClassName?: string;
  setRef: (el: HTMLElement | null) => void;
  onFocus: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onToggle: () => void;
  onSelect: () => void;
  onActivate: () => void;
  onNavigate?: () => void;
}) {
  const { node, level, pos, size, expandable } = v;
  const drop = useFolderDrop(node.key, mode === "nav" ? node.drop ?? null : null);
  const drag = useWorkspaceDraggable(`tree:${node.key}`, mode === "nav" ? node.drag ?? null : null);
  const loading = expandable && open && node.lazy && !node.children;
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

  const indent = Math.min(level - 1, 6);
  const style: React.CSSProperties = { paddingLeft: `calc(0.375rem + ${indent} * clamp(8px, 2.6vw, 12px))` };

  const chevron = expandable ? (
    <span
      aria-hidden
      className="-my-1 grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-text-muted hover:bg-surface-active hover:text-text"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(); }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {loading ? <Spinner size={12} /> : (
        <Icon name="chevronRight" size={14} className={cx("transition-transform duration-(--duration-fast) motion-reduce:transition-none", open && "rotate-90")} />
      )}
    </span>
  ) : (
    <span aria-hidden className="size-6 shrink-0" />
  );

  const body = (
    <>
      {chevron}
      {node.icon && <span className="inline-flex shrink-0" aria-hidden>{node.icon}</span>}
      <span className="min-w-0 flex-1 truncate" dir="auto">{node.label}</span>
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
    onFocus,
    onKeyDown,
    "data-rail-key": node.key,
    style,
    className: cx(
      itemClassName,
      node.className,
      (isCurrent || isSelected) && activeClassName,
      (drop.over || fileOver) && "!bg-accent-soft ring-2 ring-accent ring-inset",
      drag.isDragging && "opacity-50",
      node.disabled && "cursor-not-allowed opacity-50",
    ),
  };

  const ref = (el: HTMLElement | null) => {
    setRef(el);
    drop.setNodeRef(el);
    drag.setNodeRef(el);
  };

  return (
    <li role="none" className="min-w-0">
      {mode === "nav" && node.href ? (
        <Anchor
          {...shared}
          ref={ref as React.Ref<HTMLAnchorElement>}
          href={node.href}
          draggable={false}
          aria-current={isCurrent ? "page" : undefined}
          onClick={() => onNavigate?.()}
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
          onClick={mode === "select" ? onSelect : onToggle}
          onDoubleClick={mode === "select" ? onActivate : undefined}
        >
          {body}
        </div>
      )}
    </li>
  );
}

export default TreeView;
