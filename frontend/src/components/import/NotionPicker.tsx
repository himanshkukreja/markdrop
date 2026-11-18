"use client";

/**
 * The pages and databases a person shared with Markdrop in Notion, as a tree with checkboxes (Connect Notion's
 * "choose what to import"). Ticking a page takes its sub-pages and databases with it: they show ticked and
 * locked. `onChange` gets the top-most ticked items only (what the server imports as roots).
 */
import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Icon, Input, Skeleton, cx } from "@/components/ui";
import { notionTree, type NotionSharedItem, type NotionTreeNode } from "@/lib/notionConnect";

export interface PickedRoot { id: string; kind: "page" | "database"; title: string }

export function NotionPicker({ items, loading, error, onRetry, value, onChange }: {
  items: NotionSharedItem[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  value: Set<string>;
  onChange: (next: Set<string>, roots: PickedRoot[]) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const tree = useMemo(() => notionTree(items ?? []), [items]);
  const parentOf = useMemo(() => new Map((items ?? []).map((i) => [i.id, i.parent_id])), [items]);
  const byId = useMemo(() => new Map((items ?? []).map((i) => [i.id, i])), [items]);

  // Top-level items start open when there are few of them.
  useEffect(() => {
    if (tree.length && tree.length <= 3) setOpen(new Set(tree.map((t) => t.id)));
  }, [tree]);

  const underTicked = (id: string) => {
    let p = parentOf.get(id);
    for (let i = 0; p && i < 64; i++) {
      if (value.has(p)) return true;
      p = parentOf.get(p);
    }
    return false;
  };

  const toggle = (id: string) => {
    const next = new Set(value);
    if (next.has(id)) next.delete(id); else next.add(id);
    const roots: PickedRoot[] = [];
    for (const x of next) {
      let p = parentOf.get(x), covered = false;
      for (let i = 0; p && i < 64; i++) { if (next.has(p)) { covered = true; break; } p = parentOf.get(p); }
      const it = byId.get(x);
      if (!covered && it) roots.push({ id: it.id, kind: it.kind, title: it.title });
    }
    onChange(next, roots);
  };

  const needle = q.trim().toLowerCase();
  const matches = (n: NotionTreeNode): boolean => !needle || n.title.toLowerCase().includes(needle) || n.children.some(matches);

  const row = (n: NotionTreeNode, depth: number): React.ReactNode => {
    if (!matches(n)) return null;
    const locked = underTicked(n.id);
    const checked = locked || value.has(n.id);
    const isOpen = open.has(n.id) || !!needle;
    return (
      <li key={n.id} role="treeitem" aria-expanded={n.children.length ? isOpen : undefined} aria-selected={checked}>
        <div className={cx("np-row", checked && "np-row--on")} style={{ paddingLeft: 6 + depth * 20 }}>
          {n.children.length ? (
            <button type="button" className="np-twist" aria-label={isOpen ? `Collapse ${n.title}` : `Expand ${n.title}`}
              onClick={() => setOpen((s) => { const x = new Set(s); if (x.has(n.id)) x.delete(n.id); else x.add(n.id); return x; })}>
              <Icon name={isOpen ? "chevronDown" : "chevronRight"} />
            </button>
          ) : <span className="np-twist np-twist--none" />}
          <Checkbox checked={checked} disabled={locked} onChange={() => toggle(n.id)} aria-label={`Import ${n.title}`}
            data-testid={`notion-pick-${n.id}`} />
          <span className="np-icon" aria-hidden>{n.icon || <Icon name={n.kind === "database" ? "table" : "doc"} />}</span>
          <span className="np-title">{n.title}</span>
          {n.kind === "database" && <span className="np-kind">Database</span>}
          {n.children.length > 0 && !isOpen && <span className="np-kids">{n.children.length}</span>}
        </div>
        {n.children.length > 0 && isOpen && <ul role="group">{n.children.map((c) => row(c, depth + 1))}</ul>}
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
        {tree.map((n) => row(n, 0))}
      </ul>
    </div>
  );
}
