"use client";

/**
 * ⌘K quick search (CommandK board). ⌘K / Ctrl+K (or the header's search field) opens it; it searches
 * titles of the caller's files, the workspaces they're in and what's shared with them
 * (`GET /search/quick`, debounced), and offers actions for the folder in view (Upload to…, Share…,
 * Invite people to…, New folder). Results come from the server already filtered to what the caller
 * can open.
 *
 * ARIA: a combobox input that owns a listbox (aria-activedescendant); groups are labelled; ↑ ↓ move,
 * ↵ opens, Esc closes (the DS Dialog's layer), focus returns to whatever opened it.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog, FileIcon, Icon, Kbd, Spinner } from "@/components/ui";
import { listRecent, quickSearch, type PersonalItem, type QuickResults } from "@/lib/me";
import { ancestry, peekTree } from "@/lib/workspaceStore";
import s from "./CommandPalette.module.css";

export interface PaletteAction {
  id: string;
  label: string;
  icon: string;
  where: string;
  run: () => void;
}

interface Row {
  id: string;
  label: string;
  where: string;
  icon: React.ReactNode;
  run: () => void;
}

interface Group {
  name: string;
  rows: Row[];
}

const MIN = 2;

function fileIcon(f: { kind?: string; mime?: string | null; title?: string | null; slug: string }) {
  return f.kind === "artifact"
    ? <FileIcon name={f.title || f.slug} mime={f.mime || ""} size={18} />
    : <Icon name="doc" size={18} />;
}

function folderWhere(wsId: string, wsName: string, folderId: string): string {
  const tree = peekTree(wsId);
  const parents = tree ? ancestry(tree.folders, folderId).slice(0, -1).map((f) => f.name) : [];
  return [wsName, ...parents].join(" › ");
}

export default function CommandPalette({
  open, onClose, actions,
}: {
  open: boolean;
  onClose: () => void;
  /** Local actions for the folder in view ("Upload to Guides", …). */
  actions: PaletteAction[];
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<QuickResults | null>(null);
  const [recent, setRecent] = useState<PersonalItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const uid = useId();

  // Fresh each time it opens.
  useEffect(() => {
    if (!open) return;
    setQ("");
    setResults(null);
    setFailed(false);
    setActive(0);
    let live = true;
    listRecent().then((r) => live && setRecent(r.slice(0, 5))).catch(() => live && setRecent([]));
    return () => { live = false; };
  }, [open]);

  // Debounced search.
  useEffect(() => {
    const term = q.trim();
    if (!open || term.length < MIN) { setResults(null); setLoading(false); return; }
    const ctl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      quickSearch(term, 8, ctl.signal)
        .then((r) => { setResults(r); setFailed(false); })
        .catch((e) => { if (!ctl.signal.aborted) { setFailed(true); setResults(null); void e; } })
        .finally(() => { if (!ctl.signal.aborted) setLoading(false); });
    }, 160);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q, open]);

  const go = useCallback((href: string) => { onClose(); router.push(href); }, [onClose, router]);

  const groups = useMemo<Group[]>(() => {
    const out: Group[] = [];
    const term = q.trim();
    if (term.length >= MIN && results) {
      if (results.files.length) {
        out.push({
          name: "Files",
          rows: results.files.map((f) => ({
            id: `file:${f.slug}`,
            label: (f.encrypted ? f.slug : f.title?.trim()) || f.slug,
            where: f.workspace ? [f.workspace.name, ...(f.folder ? [f.folder.name] : [])].join(" › ") : f.source === "shared" ? "Shared with me" : "My files",
            icon: fileIcon(f),
            run: () => go(`/${f.slug}`),
          })),
        });
      }
      if (results.folders.length) {
        out.push({
          name: "Folders",
          rows: results.folders.map((f) => ({
            id: `folder:${f.id}`,
            label: f.name,
            where: folderWhere(f.workspace.id, f.workspace.name, f.id),
            icon: <Icon name="folder" size={18} />,
            run: () => go(`/w/${encodeURIComponent(f.workspace.id)}/f/${encodeURIComponent(f.id)}`),
          })),
        });
      }
      if (results.workspaces.length) {
        out.push({
          name: "Workspaces",
          rows: results.workspaces.map((w) => ({
            id: `ws:${w.id}`,
            label: w.name,
            where: "Workspace",
            icon: <Icon name="users" size={18} />,
            run: () => go(`/w/${encodeURIComponent(w.id)}`),
          })),
        });
      }
    } else if (term.length < MIN && recent && recent.length) {
      out.push({
        name: "Recent",
        rows: recent.map((f) => ({
          id: `recent:${f.slug}`,
          label: (f.encrypted ? f.slug : f.title?.trim()) || f.slug,
          where: f.workspace ? [f.workspace.name, ...(f.folder ? [f.folder.name] : [])].join(" › ") : "My files",
          icon: fileIcon(f),
          run: () => go(`/${f.slug}`),
        })),
      });
    }
    // The folder's actions stay on offer whatever is typed (CommandK board): they're about where you are.
    const acts = actions;
    if (acts.length) {
      out.push({
        name: "Actions",
        rows: acts.map((a) => ({
          id: `act:${a.id}`,
          label: a.label,
          where: a.where,
          icon: <Icon name={a.icon} size={18} />,
          run: () => { onClose(); a.run(); },
        })),
      });
    }
    return out;
  }, [q, results, recent, actions, go, onClose]);

  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  useEffect(() => { setActive(0); }, [flat.length, q]);
  const current = flat[Math.min(active, flat.length - 1)];
  const optId = (r: Row) => `${uid}-opt-${r.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  // Keep the active option in view.
  useEffect(() => {
    if (!current) return;
    document.getElementById(optId(current))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (flat.length ? (i + 1) % flat.length : 0)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0)); }
    else if (e.key === "Home" && flat.length) { e.preventDefault(); setActive(0); }
    else if (e.key === "End" && flat.length) { e.preventDefault(); setActive(flat.length - 1); }
    else if (e.key === "Enter") { if (current) { e.preventDefault(); current.run(); } }
  }

  const term = q.trim();
  const listId = `${uid}-list`;
  const statusText = term.length < MIN
    ? ""
    : loading ? "Searching…" : failed ? "Search isn't available right now." : flat.length ? `${flat.length} results` : `No matches for “${term}”`;

  return (
    <Dialog open={open} onClose={onClose} title="Quick search" className={s.palette} initialFocus={inputRef}>
      <label className={s.field}>
        {loading ? <Spinner size={18} /> : <Icon name="search" size={18} />}
        <input
          ref={inputRef}
          className={s.input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search or jump to"
          aria-label="Search or jump to"
          role="combobox"
          aria-expanded={flat.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={current ? optId(current) : undefined}
          autoComplete="off"
          spellCheck={false}
          maxLength={120}
        />
        <Kbd>Esc</Kbd>
      </label>
      <span className="md-visually-hidden" role="status" aria-live="polite">{statusText}</span>

      <ul ref={listRef} id={listId} role="listbox" aria-label="Results" className={s.list}>
        {groups.map((g) => (
          <li key={g.name} role="presentation">
            <p className={s.group} aria-hidden>{g.name}</p>
            <ul role="group" aria-label={g.name} className="m-0 flex list-none flex-col gap-0.5 p-0">
              {g.rows.map((r) => {
                const on = current?.id === r.id;
                return (
                  <li
                    key={r.id}
                    id={optId(r)}
                    role="option"
                    aria-selected={on}
                    className={s.option}
                    onMouseMove={() => { const i = flat.indexOf(r); if (i !== active) setActive(i); }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => r.run()}
                  >
                    <span className={s.icon} aria-hidden>{r.icon}</span>
                    <span className="min-w-0 flex-1 truncate" dir="auto">{r.label}</span>
                    <span className={s.where}>{r.where}</span>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
        {term.length >= MIN && !loading && !flat.length && (
          <li role="presentation" className="px-3 py-6 text-center text-body text-text-muted">
            {failed ? "Search isn't available right now. Try again in a moment." : <>Nothing matches “{term}”.</>}
          </li>
        )}
        {term.length < MIN && !flat.length && (
          <li role="presentation" className="px-3 py-6 text-center text-body text-text-muted">Type at least two letters to search.</li>
        )}
      </ul>

      <div className={s.foot}>
        <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> to move</span>
        <span className="flex items-center gap-1"><Kbd>↵</Kbd> to open</span>
        <span className={`ml-auto ${s.hideSm}`}>Searches your files, workspaces and folders</span>
      </div>
    </Dialog>
  );
}
