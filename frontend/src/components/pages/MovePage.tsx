"use client";

/**
 * Moving a page: under another page, to the top level, or (a workspace's top page) into another
 * folder. Three pieces, used by the page tree's drag and drop, the page's "Move to" and the rail:
 *
 *   useMovePage()     PUT /documents/{slug}/parent, asking first when the API answers 409
 *                     `access_change` ("Moving “X” changes who can read it: now …; after the move,
 *                     …" — Cancel / Move anyway re-sends with confirm_access_change). Any other
 *                     refusal shows the API's sentence as a toast. Resolves null when nothing moved.
 *   MovePageDialog    "Move to": a search box over the places this page can go (a listbox).
 *   AccessChangeDialog the confirmation itself.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Alert, Button, Dialog, Icon, Spinner, Skeleton, cx, useToast } from "@/components/ui";
import { accessChangeOf, listChildren, movePage, searchMyPages, type PageDocument } from "@/lib/pages";
import { getWorkspaceTree, listWorkspaceItems, moveItems, type TreeFolder, type WorkspaceItem } from "@/lib/workspaces";
import { workspaceChanged } from "@/lib/workspaceStore";
import { readersText } from "@/lib/pageTree.mjs";
import "./pageTree.css";

/* ── the access confirmation ───────────────────────────────────────────── */

export function AccessChangeDialog({ open, title, before, after, busy, onCancel, onConfirm }: {
  open: boolean;
  title: string;
  before: string;
  after: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const name = title.trim() || "Untitled";
  return (
    <Dialog
      open={open}
      onClose={() => !busy && onCancel()}
      dismissible={!busy}
      size="sm"
      title="Change who can read it?"
      glyph={<Icon name="lock" />}
      description={
        <>
          Moving “<span className="ph-sensitive ph-mask">{name}</span>” changes who can read it: now {before}; after the move, {after}.
        </>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={onConfirm} loading={busy}>Move anyway</Button>
        </>
      }
    >
      <dl className="pt-access">
        <div className="pt-access__row">
          <dt>Now</dt>
          <dd>{before}</dd>
        </div>
        <div className="pt-access__row pt-access__row--after">
          <dt>After the move</dt>
          <dd>{after}</dd>
        </div>
      </dl>
      <p className="pt-access__note">Its sub-pages follow it, unless they have their own access.</p>
    </Dialog>
  );
}

/* ── the hook ──────────────────────────────────────────────────────────── */

export interface MoveRequest {
  slug: string;
  title: string | null;
  /** The new parent's slug; null = the top level (of its folder, or of your pages). */
  parent: string | null;
  /** The sibling it goes after (null: first; undefined: last). */
  after?: string | null;
}

/** A sentence for a refused move. */
export function moveErrorText(e: unknown): string {
  const m = e instanceof Error ? e.message : "";
  return m && !/^Request failed/.test(m) ? m : "Couldn't move the page. Try again.";
}

export function useMovePage() {
  const toast = useToast();
  const [ask, setAsk] = useState<{ title: string; before: string; after: string; resolve: (ok: boolean) => void } | null>(null);
  const [busy, setBusy] = useState(false);

  const move = useCallback(
    async (req: MoveRequest): Promise<PageDocument | null> => {
      try {
        return await movePage(req.slug, req.parent, false, req.after);
      } catch (e) {
        const change = accessChangeOf(e);
        if (!change) {
          toast.error(moveErrorText(e));
          return null;
        }
        const ok = await new Promise<boolean>((resolve) =>
          setAsk({ title: req.title ?? "", before: readersText(change.readers_before), after: readersText(change.readers_after), resolve }),
        );
        if (!ok) {
          setAsk(null);
          return null;
        }
        setBusy(true);
        try {
          return await movePage(req.slug, req.parent, true, req.after);
        } catch (e2) {
          toast.error(moveErrorText(e2));
          return null;
        } finally {
          setBusy(false);
          setAsk(null);
        }
      }
    },
    [toast],
  );

  const dialog = (
    <AccessChangeDialog
      open={!!ask}
      title={ask?.title ?? ""}
      before={ask?.before ?? ""}
      after={ask?.after ?? ""}
      busy={busy}
      onCancel={() => ask?.resolve(false)}
      onConfirm={() => ask?.resolve(true)}
    />
  );
  return { move, dialog, asking: !!ask };
}

/* ── "Move to" ─────────────────────────────────────────────────────────── */

export interface MovablePage {
  slug: string;
  title: string | null;
  workspaceId: string | null;
  /** The parent's slug (null: a top-level page). */
  parent: string | null;
  parentTitle?: string | null;
  childrenCount: number;
  /** The folders it's filed in, as slugs from the workspace's top ("guides", "q3"). */
  folderPath: string[];
}

export interface MovedTo {
  /** The page's new parent (null at the top level). */
  parent: string | null;
  /** Set when it changed folders (null: the workspace's top level). */
  folderId?: string | null;
  /** Where it went, in words ("“Handbook”", "the top of Guides"). */
  label: string;
  doc: PageDocument | null;
}

interface Option {
  key: string;
  group: "top" | "folders" | "pages";
  label: string;
  hint?: string;
  icon: string;
  depth?: number;
  disabled?: boolean;
  note?: string;
  go: () => Promise<MovedTo | null>;
}

const GROUP_LABEL = { top: "Top level", folders: "Folders", pages: "Pages" } as const;

/** Every page below `slug` (its sub-pages, all levels), to keep out of the list. */
async function belowOf(slug: string, count: number): Promise<Set<string>> {
  const out = new Set<string>();
  if (!count) return out;
  let level = [slug];
  for (let d = 0; d < 8 && level.length && out.size < 500; d++) {
    const next: string[] = [];
    for (const s of level) {
      const kids = await listChildren(s).catch(() => []);
      for (const k of kids) if (!out.has(k.slug)) { out.add(k.slug); if (k.has_children) next.push(k.slug); }
    }
    level = next;
  }
  return out;
}

export function MovePageDialog({ open, onClose, page, onMoved }: { open: boolean; onClose: () => void; page: MovablePage; onMoved: (to: MovedTo) => void }) {
  const toast = useToast();
  const mover = useMovePage();
  const moveFn = mover.move;
  const uid = useId();
  const listId = `${uid}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [tree, setTree] = useState<{ name: string; folders: TreeFolder[] } | null>(null);
  const [items, setItems] = useState<Array<{ slug: string; title: string | null; hint?: string; editor?: string | null }> | null>(null);
  const [below, setBelow] = useState<Set<string> | null>(null);
  const [error, setError] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const ws = page.workspaceId;
  const name = page.title?.trim() || "Untitled";

  // Debounce the search (pages are searched by the API; folders here).
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 180);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setQuery("");
    setActive(null);
    setPending(null);
    setError("");
    let live = true;
    belowOf(page.slug, page.childrenCount).then((b) => live && setBelow(b));
    if (ws) {
      getWorkspaceTree(ws)
        .then((t) => live && setTree({ name: t.workspace.name, folders: t.folders }))
        .catch(() => live && setTree({ name: "the workspace", folders: [] }));
    }
    return () => {
      live = false;
    };
  }, [open, page.slug, page.childrenCount, ws]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setItems(null);
    const load = ws
      ? listWorkspaceItems(ws, { folder: "all", kind: "markdown", q: query || undefined, limit: 100 }).then((r) =>
          r.items
            .filter((it) => {
              const x = it as WorkspaceItem & { editor?: string | null };
              return x.editor === "blocks" && x.can?.edit !== false;
            })
            .map((it) => ({ slug: it.slug, title: it.title, hint: it.folder?.name ?? undefined, editor: "blocks" })),
        )
      : searchMyPages(query).then((r) => r.map((d) => ({ slug: d.slug, title: d.title, editor: d.editor })));
    load
      .then((r) => live && setItems(r))
      .catch((e) => {
        if (!live) return;
        setItems([]);
        setError(e instanceof Error ? e.message : "Couldn't load the pages.");
      });
    return () => {
      live = false;
    };
  }, [open, ws, query]);

  const folderOf = useMemo(() => tree?.folders.find((f) => f.path === page.folderPath.join("/")) ?? null, [tree, page.folderPath]);
  const placeName = ws ? folderOf?.name ?? tree?.name ?? "the workspace" : "your pages";

  const options = useMemo<Option[]>(() => {
    const out: Option[] = [];
    const match = (s: string) => !query || s.toLowerCase().includes(query.toLowerCase());
    // The top level of where it is (only a sub-page can go there).
    if (page.parent && match(`top level ${placeName}`)) {
      out.push({
        key: "top",
        group: "top",
        label: `Top level of ${placeName}`,
        hint: page.parentTitle ? `Out of “${page.parentTitle}”` : undefined,
        icon: ws ? (folderOf ? "folder" : "home") : "home",
        go: async () => {
          const doc = await moveFn({ slug: page.slug, title: page.title, parent: null });
          return doc ? { parent: null, label: `the top of ${placeName}`, doc } : null;
        },
      });
    }
    // Folders (a workspace's): its top level, then each folder.
    if (ws && tree) {
      const here = folderOf?.id ?? null;
      const intoFolder = (folderId: string | null, label: string) => async (): Promise<MovedTo | null> => {
        let doc: PageDocument | null = null;
        if (page.parent) {
          // A sub-page goes to the top first (a sub-page lives in its parent's folder).
          doc = await moveFn({ slug: page.slug, title: page.title, parent: null });
          if (!doc) return null;
        }
        try {
          await moveItems(ws, [page.slug], folderId);
        } catch (e) {
          toast.error(e instanceof Error && e.message ? e.message : "Couldn't move it to that folder.");
          // A sub-page that already came out of its parent stays at the top of its folder.
          return doc ? { parent: null, label: `the top of ${placeName}`, doc } : null;
        }
        workspaceChanged(ws);
        return { parent: null, folderId, label, doc };
      };
      const all: Option[] = [
        {
          key: "folder:root",
          group: "folders",
          label: tree.name,
          hint: "Top level, in no folder",
          icon: "home",
          depth: 0,
          disabled: !page.parent && here === null,
          note: !page.parent && here === null ? "Here now" : undefined,
          go: intoFolder(null, `the top of ${tree.name}`),
        },
        ...[...tree.folders]
          .sort((a, b) => a.path.localeCompare(b.path))
          .map<Option>((f) => ({
            key: `folder:${f.id}`,
            group: "folders",
            label: f.name,
            hint: f.depth > 1 ? f.path.split("/").slice(0, -1).join(" / ") : undefined,
            icon: "folder",
            depth: Math.max(0, f.depth - 1) + 1,
            disabled: f.id === here,
            note: f.id === here ? (page.parent ? "Use Top level" : "Here now") : undefined,
            go: intoFolder(f.id, f.name),
          })),
      ];
      out.push(...all.filter((o) => match(o.label) || (o.hint ? match(o.hint) : false)));
    }
    // Pages it can go inside: not itself, not one of its own sub-pages.
    for (const it of items ?? []) {
      if (it.slug === page.slug || below?.has(it.slug)) continue;
      const current = it.slug === page.parent;
      out.push({
        key: `page:${it.slug}`,
        group: "pages",
        label: it.title?.trim() || "Untitled",
        hint: it.hint,
        icon: it.editor === "blocks" ? "layers" : "lines",
        disabled: current,
        note: current ? "Here now" : undefined,
        go: async () => {
          const doc = await moveFn({ slug: page.slug, title: page.title, parent: it.slug });
          return doc ? { parent: it.slug, label: `“${it.title?.trim() || "Untitled"}”`, doc } : null;
        },
      });
    }
    return out;
  }, [query, page, placeName, ws, tree, folderOf, items, below, moveFn, toast]);

  const enabled = options.filter((o) => !o.disabled);
  const activeKey = active && enabled.some((o) => o.key === active) ? active : enabled[0]?.key ?? null;
  const optId = (key: string) => `${uid}-opt-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  useEffect(() => {
    if (!activeKey) return;
    document.getElementById(optId(activeKey))?.scrollIntoView({ block: "nearest" });
  }, [activeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function choose(o: Option) {
    if (o.disabled || pending) return;
    setPending(o.key);
    try {
      const to = await o.go();
      if (to) {
        onMoved(to);
        onClose();
      }
    } finally {
      setPending(null);
    }
  }

  function onKey(e: React.KeyboardEvent) {
    const i = enabled.findIndex((o) => o.key === activeKey);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!enabled.length) return;
      const n = e.key === "ArrowDown" ? Math.min(enabled.length - 1, i + 1) : Math.max(0, i - 1);
      setActive(enabled[n]!.key);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = enabled[i];
      if (o) void choose(o);
    }
  }

  const loading = items === null || (ws ? tree === null : false) || below === null;
  let lastGroup: Option["group"] | null = null;

  return (
    <>
      <Dialog
        open={open}
        onClose={() => !pending && !mover.asking && onClose()}
        dismissible={!pending && !mover.asking}
        size="md"
        title={<>Move “<span className="ph-sensitive ph-mask">{name}</span>” to…</>}
        description={page.childrenCount > 0 ? "Its sub-pages move with it." : undefined}
        initialFocus={inputRef}
        bodyClassName="pt-move"
      >
        <label htmlFor={`${uid}-q`} className="md-visually-hidden">Search pages and folders</label>
        <div className="pt-move__search">
          <Icon name="search" size={16} aria-hidden />
          <input
            ref={inputRef}
            id={`${uid}-q`}
            type="search"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeKey ? optId(activeKey) : undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder={ws ? "Search pages and folders" : "Search your pages"}
            value={q}
            onChange={(e) => { setQ(e.target.value); setActive(null); }}
            onKeyDown={onKey}
            className="ph-no-capture"
          />
          {q && items === null && <Spinner size={14} />}
        </div>
        {error && <Alert tone="danger" className="mt-2">{error}</Alert>}
        <div className="pt-move__scroll">
          {loading && !options.length ? (
            <div className="flex flex-col gap-2 p-2" aria-busy="true">
              <Skeleton width="55%" />
              <Skeleton width="70%" />
              <Skeleton width="45%" />
            </div>
          ) : (
            <ul id={listId} role="listbox" aria-label="Places to move it" className="pt-move__list ph-no-capture">
              {options.map((o) => {
                const head = o.group !== lastGroup ? GROUP_LABEL[o.group] : null;
                lastGroup = o.group;
                const on = o.key === activeKey;
                return (
                  <li key={o.key} role="presentation">
                    {head && <div className="pt-move__group" role="presentation">{head}</div>}
                    <div
                      id={optId(o.key)}
                      role="option"
                      aria-selected={on}
                      aria-disabled={o.disabled || undefined}
                      className={cx("pt-move__opt", on && "pt-move__opt--on", o.disabled && "pt-move__opt--off")}
                      style={o.depth ? { paddingLeft: 10 + Math.min(o.depth, 5) * 14 } : undefined}
                      onMouseMove={() => !o.disabled && active !== o.key && setActive(o.key)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => void choose(o)}
                    >
                      <Icon name={o.icon} size={16} aria-hidden className="pt-move__icon" />
                      <span className="pt-move__label ph-sensitive ph-mask" dir="auto">{o.label}</span>
                      {o.hint && <span className="pt-move__hint ph-sensitive ph-mask">{o.hint}</span>}
                      {o.note && <span className="pt-move__note">{o.note}</span>}
                      {pending === o.key && <Spinner size={14} />}
                    </div>
                  </li>
                );
              })}
              {!loading && !options.length && (
                <li role="presentation" className="pt-move__empty">
                  {query ? <>Nothing matches “<span className="ph-no-capture">{query}</span>”.</> : "There's nowhere else to move it yet."}
                </li>
              )}
            </ul>
          )}
        </div>
        <p className="pt-move__foot" aria-hidden>
          <span><kbd className="md-kbd">↑</kbd><kbd className="md-kbd">↓</kbd> to choose</span>
          <span><kbd className="md-kbd">↵</kbd> to move</span>
        </p>
      </Dialog>
      {mover.dialog}
    </>
  );
}

export default MovePageDialog;
