"use client";

/**
 * The pages and databases a person shared with Markdrop in Notion, as Notion nests them, with checkboxes
 * (Connect Notion's "choose what to import"). Ticking a page or database ticks everything under it; any
 * item under it can then be unticked (the parent shows "some"). A database's rows load when it's opened,
 * 50 at a time. The model is lib/notionPickerCore.mjs; `onChange` gets the selection and what the import
 * sends (`pages` + `exclude`) with a one-line summary ("12 pages, 1 database · 3 left out").
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Icon, Input, Skeleton, cx } from "@/components/ui";
import { notionDatabaseRows, type NotionSharedItem } from "@/lib/notionConnect";
import { buildTree, emptySelection, importBody, isMixed, isOn, leavesOutRows, summary, toggle, type PickerNode, type Selection } from "@/lib/notionPickerCore.mjs";

export interface PickedRoot { id: string; kind: "page" | "database"; title: string }
export interface NotionPick { roots: PickedRoot[]; exclude: string[]; summary: string; leavesOutRows: boolean; count: number }

type Rows = { items: NotionSharedItem[]; cursor: string | null; loading: boolean; error: string | null };

export function NotionPicker({ connectionId, items, rowParents, loading, error, onRetry, value, onChange }: {
  connectionId: string;
  items: NotionSharedItem[] | null;
  rowParents?: Record<string, string>;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  value: Selection;
  onChange: (next: Selection, pick: NotionPick) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Map<string, Rows>>(new Map());
  useEffect(() => { setRows(new Map()); setOpen(new Set()); }, [connectionId, items]);

  const tree = useMemo(() => {
    const loaded = new Map<string, NotionSharedItem[]>();
    for (const [db, r] of rows) if (r.items.length || !r.loading) loaded.set(db, r.items);
    return buildTree(items ?? [], loaded, rowParents ?? {});
  }, [items, rows, rowParents]);

  // Top-level items start open when there are few of them.
  useEffect(() => {
    if (tree.roots.length && tree.roots.length <= 3) setOpen((s) => (s.size ? s : new Set(tree.roots.filter((t) => t.kind !== "database").map((t) => t.id))));
  }, [tree.roots]);

  const loadRows = useCallback((db: string, cursor: string | null) => {
    setRows((m) => { const x = new Map(m); const cur = x.get(db); x.set(db, { items: cur?.items ?? [], cursor: cur?.cursor ?? null, loading: true, error: null }); return x; });
    notionDatabaseRows(connectionId, db, cursor).then(
      (r) => setRows((m) => { const x = new Map(m); const prev = cursor ? (x.get(db)?.items ?? []) : []; x.set(db, { items: [...prev, ...r.items], cursor: r.next_cursor, loading: false, error: null }); return x; }),
      () => setRows((m) => { const x = new Map(m); const cur = x.get(db); x.set(db, { items: cur?.items ?? [], cursor: cur?.cursor ?? null, loading: false, error: "Couldn't load its rows." }); return x; }),
    );
  }, [connectionId]);

  const flip = (n: PickerNode) => {
    setOpen((s) => {
      const x = new Set(s);
      if (x.has(n.id)) x.delete(n.id);
      else {
        x.add(n.id);
        if (n.kind === "database" && !rows.has(n.id) && (n.row_count ?? 0) > 0) loadRows(n.id, null);
      }
      return x;
    });
  };

  // A "some" box ticks everything under it (like a select-all); a ticked one unticks it all.
  const pick = (id: string) => {
    let next = toggle(id, value, tree.parentOf);
    if (isOn(id, value, tree.parentOf) && isMixed(id, value, tree.parentOf)) next = toggle(id, next, tree.parentOf);
    const body = importBody(next, tree.byId);
    const s = summary(next, tree);
    onChange(next, { roots: body.pages, exclude: body.exclude, summary: s.text, leavesOutRows: leavesOutRows(next, tree.byId), count: s.pages + s.databases });
  };

  const needle = q.trim().toLowerCase();
  const matches = (n: PickerNode): boolean => !needle || n.title.toLowerCase().includes(needle) || n.children.some(matches);

  const row = (n: PickerNode, depth: number): React.ReactNode => {
    if (!matches(n)) return null;
    const checked = isOn(n.id, value, tree.parentOf);
    const mixed = isMixed(n.id, value, tree.parentOf);
    const r = n.kind === "database" ? rows.get(n.id) : undefined;
    const count = n.kind === "database" ? (n.row_count ?? 0) : n.children.length;
    const expandable = n.children.length > 0 || (n.kind === "database" && count > 0);
    const isOpen = open.has(n.id) || (!!needle && n.children.length > 0);
    return (
      <li key={n.id} role="treeitem" aria-expanded={expandable ? isOpen : undefined} aria-selected={checked}>
        <div className={cx("np-row", (checked || mixed) && "np-row--on")} style={{ paddingLeft: 6 + depth * 20 }}>
          {expandable ? (
            <button type="button" className="np-twist" aria-label={isOpen ? `Collapse ${n.title}` : `Expand ${n.title}`} onClick={() => flip(n)}
              data-testid={`notion-expand-${n.id}`}>
              <Icon name={isOpen ? "chevronDown" : "chevronRight"} />
            </button>
          ) : <span className="np-twist np-twist--none" />}
          <Checkbox checked={checked && !mixed} indeterminate={mixed} onChange={() => pick(n.id)}
            aria-label={`${checked ? "Leave out" : "Import"} ${n.title}`} data-testid={`notion-pick-${n.id}`} />
          <span className="np-icon" aria-hidden>{n.icon || <Icon name={n.kind === "database" ? "table" : "doc"} />}</span>
          <span className="np-title">{n.title}</span>
          {n.kind === "database" && <span className="np-kind">Database</span>}
          {expandable && !isOpen && count > 0 && <span className="np-kids" aria-label={`${count} ${n.kind === "database" ? "rows" : "inside"}`}>{count}</span>}
        </div>
        {expandable && isOpen && (
          <ul role="group">
            {r?.loading && !r.items.length && <li className="np-more" aria-busy="true"><Skeleton height={18} className="np-skel" /></li>}
            {n.children.map((c) => row(c, depth + 1))}
            {r?.error && (
              <li className="np-more" style={{ paddingLeft: 32 + depth * 20 }}>
                <span>{r.error}</span>
                <Button size="sm" variant="ghost" onClick={() => loadRows(n.id, r.items.length ? r.cursor : null)}>Try again</Button>
              </li>
            )}
            {r && r.cursor && !r.error && (
              <li className="np-more" style={{ paddingLeft: 32 + depth * 20 }}>
                <Button size="sm" variant="ghost" iconLeft="chevronDown" loading={r.loading} onClick={() => loadRows(n.id, r.cursor)} data-testid={`notion-more-${n.id}`}>
                  Show more rows
                </Button>
              </li>
            )}
          </ul>
        )}
      </li>
    );
  };

  if (loading && !items) {
    return <div className="np-box np-box--pad" aria-busy="true">{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={22} className="np-skel" />)}</div>;
  }
  if (error) {
    return (
      <div className="np-box np-box--pad np-empty">
        <p>{error}</p>
        <Button size="sm" variant="secondary" iconLeft="refresh" onClick={onRetry}>Try again</Button>
      </div>
    );
  }
  if (!items?.length) {
    return (
      <div className="np-box np-box--pad np-empty" data-testid="notion-picker-empty">
        <p><b>No pages shared with Markdrop yet.</b> In Notion, open a page, choose <b>•••</b> › <b>Connections</b> and add Markdrop. Its sub-pages come with it.</p>
        <Button size="sm" variant="secondary" iconLeft="refresh" onClick={onRetry} loading={loading}>Check again</Button>
      </div>
    );
  }
  return (
    <div className="np" data-testid="notion-picker">
      {items.length > 8 && (
        <Input aria-label="Find a Notion page" placeholder="Find a page" value={q} onChange={(e) => setQ(e.target.value)} prefix="search" wrapClassName="np-find" />
      )}
      <ul className="np-box" role="tree" aria-label="Notion pages shared with Markdrop" aria-multiselectable="true">
        {tree.roots.map((n) => row(n, 0))}
      </ul>
    </div>
  );
}

export { emptySelection };
