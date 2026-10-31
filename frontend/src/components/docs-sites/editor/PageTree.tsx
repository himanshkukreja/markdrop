"use client";

import { useEffect, useRef } from "react";
import { ICONS, Icon, IconButton, RowMenu, Skeleton, cx, type MenuItem } from "@/components/ui";
import type { NavGroup, PageSummary } from "@/lib/docsSites";
import { firstName } from "../format";

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

const iconName = (icon: string | null | undefined) => (icon && icon in ICONS ? icon : "doc");

/** Scrolls the tree's own scroll box (the side panel, the drawer) so `el` shows; never the page. */
function revealIn(el: HTMLElement) {
  let box = el.parentElement;
  while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
  if (!box || box === document.scrollingElement || box === document.body) return;
  const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
  if (r.top < b.top + 8) box.scrollTop -= b.top + 8 - r.top + b.height / 3;
  else if (r.bottom > b.bottom - 8) box.scrollTop += r.bottom - b.bottom + 8 + b.height / 3;
}

/**
 * The editor's page tree (Editor board, left): groups and pages in nav order; a lock and the
 * editor's first name on a page someone else is editing; a dot on pages with unpublished changes.
 * Pages are links (`?page=<id>`); each has a menu to move it or delete it (editors).
 */
export function PageTree({
  groups, currentId, myId, hrefFor, onOpen, canEdit, onNewPage, onMove, onMoveToGroup, onDelete, loading,
}: {
  groups: TreeGroup[] | null;
  currentId: string | null;
  myId: string | null;
  hrefFor: (id: string) => string;
  onOpen: (id: string) => void;
  canEdit: boolean;
  onNewPage: () => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onMoveToGroup: (id: string, group: string) => void;
  onDelete: (p: PageSummary) => void;
  loading?: boolean;
}) {
  const visible = groups?.filter((g) => !g.hidden) ?? [];
  // The open page in a long tree (a deep link, the drawer opening): bring it into view.
  const navRef = useRef<HTMLElement>(null);
  const loaded = !!groups;
  useEffect(() => {
    const el = navRef.current?.querySelector<HTMLElement>('a[aria-current="page"]');
    if (el) revealIn(el);
  }, [currentId, loaded]);
  return (
    <nav ref={navRef} aria-label="Pages" className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2 px-1.5 pb-2.5">
        <strong className="flex-1 text-[13px] text-text">Pages</strong>
        {canEdit && <IconButton icon="plus" label="New page" size="sm" onClick={onNewPage} />}
      </div>
      {loading && !groups && (
        <div className="flex flex-col gap-2 px-2" aria-busy="true">
          {[70, 55, 62, 48, 66].map((w, i) => <Skeleton key={i} width={`${w}%`} />)}
        </div>
      )}
      {groups?.map((g) => (
        <div key={g.group} role="group" aria-label={g.group} className="flex flex-col gap-0.5">
          <p className={cx("mx-2 mb-1 mt-3 text-[11px] font-bold uppercase tracking-[.08em]", g.hidden ? "text-text-subtle" : "text-text-muted")}>{g.group}</p>
          {g.pages.map((p, i) => {
            const on = p.id === currentId;
            const lockedByOther = !!p.lock && p.lock.user_id !== myId;
            const items: MenuItem[] = [];
            if (!g.hidden) {
              items.push({ label: "Move up", icon: "arrowUp", disabled: i === 0, onClick: () => onMove(p.id, -1) });
              items.push({ label: "Move down", icon: "arrowDown", disabled: i === g.pages.length - 1, onClick: () => onMove(p.id, 1) });
            }
            for (const other of visible) if (other.group !== g.group) items.push({ label: `Move to ${other.group}`, icon: "folder", onClick: () => onMoveToGroup(p.id, other.group), separated: other === visible.find((x) => x.group !== g.group) });
            items.push({ label: "Delete page", icon: "trash", danger: true, separated: true, disabled: lockedByOther || p.path === "/", onClick: () => onDelete(p) });
            return (
              <div key={p.id} className={cx("group/row relative flex min-w-0 items-center rounded-md", on ? "bg-surface-active" : "hover:bg-surface-hover")}>
                <a
                  href={hrefFor(p.id)}
                  aria-current={on ? "page" : undefined}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    onOpen(p.id);
                  }}
                  className={cx(
                    "md-focus flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-body text-text no-underline max-lg:min-h-11",
                    on && "font-semibold",
                    g.hidden && "text-text-secondary",
                  )}
                >
                  <span className="inline-flex shrink-0 text-text-muted"><Icon name={iconName(p.icon)} size={14} /></span>
                  <span className="min-w-0 flex-1 truncate" dir="auto">{p.title || "Untitled"}</span>
                  {lockedByOther && (
                    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-warning" title={`${p.lock!.name} is editing`}>
                      <Icon name="lock" size={12} />
                      {firstName(p.lock!.name)}
                      <span className="md-visually-hidden"> is editing</span>
                    </span>
                  )}
                  {p.has_changes && (
                    <span className="size-[7px] shrink-0 rounded-full bg-accent" title="Unpublished changes">
                      <span className="md-visually-hidden">, unpublished changes</span>
                    </span>
                  )}
                </a>
                {canEdit && (
                  <div className="shrink-0 opacity-100 lg:opacity-0 lg:group-focus-within/row:opacity-100 lg:group-hover/row:opacity-100">
                    <RowMenu label={`More for ${p.title || "this page"}`} items={items} portal />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export default PageTree;
