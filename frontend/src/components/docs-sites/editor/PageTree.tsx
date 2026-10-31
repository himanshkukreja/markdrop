"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

/**
 * The editor's page tree (left): a page search and New page, then the groups (collapsible) and
 * their pages in nav order with their icons; a lock and the editor's first name on a page someone
 * else is editing; one accent dot on pages new or changed since the last publish (the legend
 * under the tree says so). Pages are links (`?page=<id>`); each has a menu to move or delete it.
 */
export function PageTree({
  siteId, groups, currentId, myId, hrefFor, onOpen, canEdit, onNewPage, onMove, onMoveToGroup, onDelete, loading, comments,
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
  onDelete: (p: PageSummary) => void;
  loading?: boolean;
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

  const visible = groups?.filter((g) => !g.hidden) ?? [];
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

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex items-center gap-1.5 px-1 pb-2">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md bg-surface-inset px-2.5 text-text-muted focus-within:ring-2 focus-within:ring-border-focus">
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
      <nav ref={navRef} aria-label="Pages" className="flex flex-1 flex-col gap-2.5 pb-3">
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
            // ph-no-capture: group names and page titles (in text, labels and menus) are the customer's words.
            <div key={g.group} role="group" aria-label={g.group} className="ph-no-capture flex flex-col gap-px">
              <button
                type="button"
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => setGroupOpen(g.group, !open)}
                disabled={!!q}
                className={cx(
                  "md-focus flex h-7 items-center gap-1 rounded-md px-1.5 text-left text-[12px] font-semibold disabled:cursor-default",
                  g.hidden ? "text-text-subtle" : "text-text-muted",
                  !q && "hover:text-text",
                )}
              >
                <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
                <span className="min-w-0 flex-1 truncate">{g.group}</span>
                {!open && g.pages.some((p) => p.has_changes) && <span aria-hidden className="mr-1.5 size-1.5 shrink-0 rounded-full bg-accent" />}
              </button>
              <div id={listId} hidden={!open} className="flex flex-col gap-px">
                {g.pages.map((p, i) => {
                  const on = p.id === currentId;
                  const lockedByOther = !!p.lock && p.lock.user_id !== myId;
                  const dot = dotLabel(p);
                  const talk = comments?.[p.id] ?? 0;
                  const items: MenuItem[] = [];
                  if (!g.hidden && !q) {
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
                          "md-focus flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-md pl-[22px] pr-2 text-[13px] no-underline max-lg:h-11",
                          on ? "font-semibold text-text" : "font-medium text-text-secondary",
                          g.hidden && !on && "text-text-muted",
                        )}
                      >
                        <span className={cx("inline-flex shrink-0", on ? "text-text" : "text-text-muted")}><Icon name={pageIcon(p.icon)} size={14} /></span>
                        <span className="min-w-0 flex-1 truncate" dir="auto" title={p.title || undefined}>{p.title || "Untitled"}</span>
                        {lockedByOther && (
                          <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-warning" title={`${p.lock!.name} is editing`}>
                            <Icon name="lock" size={11} />
                            {firstName(p.lock!.name)}
                            <span className="md-visually-hidden"> is editing</span>
                          </span>
                        )}
                        {talk > 0 && (
                          <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-text-muted" title={`${talk} open ${talk === 1 ? "comment" : "comments"}`}>
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
                })}
              </div>
            </div>
          );
        })}
      </nav>
      {anyDot && (
        <p className="sticky bottom-0 -mx-2.5 mt-auto flex items-center gap-2 border-t border-border bg-surface px-4 py-2.5 text-[11px] text-text-muted">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-accent" />
          New or changed since the last publish
        </p>
      )}
    </div>
  );
}

export default PageTree;
