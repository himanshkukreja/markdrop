"use client";

/**
 * The folder view's dialogs: Rename folder, Delete folder, the "Move to…" tree picker (the
 * keyboard and phone alternative to drag and drop, for items and for folders), and "Add existing"
 * (file documents you already published into this folder).
 *
 * Each one says what will happen to addresses and access before it happens: folders never change
 * who can open something (D2), but they are part of its address on the workspace's own domain.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, Button, Checkbox, ConfirmDialog, Dialog, EmptyState, Field, Icon, Input, RadioGroup, Skeleton, cx,
} from "@/components/ui";
import { TreeView, type TreeNode } from "@/components/workspace/FolderTree";
import { WorkspaceTile } from "@/components/shell/SideNav";
import { RowTile } from "@/components/dashboard/DocRow";
import { displayTitle, plural } from "@/components/dashboard/format";
import { listMyDocuments, type MyDocListItem } from "@/lib/api";
import {
  addItems, deleteFolder, moveItems, updateFolder, type TreeFolder, type Workspace, type WorkspaceTree,
} from "@/lib/workspaces";
import { childrenMap, descendants, subtreeHeight } from "@/lib/workspaceStore";

/** Mirrors MAX_DEPTH in services/folder.py. */
export const MAX_FOLDER_DEPTH = 8;

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** URL-safe folder segment, close to the server's slugify (the server may add a suffix on a clash). */
export function folderSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "folder";
}

/* ── Rename ───────────────────────────────────────────────────────────── */

export function RenameFolderDialog({
  workspaceId, folder, host, onClose, onRenamed,
}: {
  workspaceId: string;
  folder: TreeFolder | null;
  host: string | null;
  onClose: () => void;
  onRenamed: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (folder) { setName(folder.name); setError(""); setBusy(false); }
  }, [folder]);

  const parentPath = folder ? folder.path.split("/").slice(0, -1) : [];
  const nextPath = [...parentPath, folderSlug(name || folder?.name || "")].join("/");
  const changed = !!folder && name.trim() !== folder.name;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!folder || busy) return;
    if (!n) { setError("Give the folder a name."); return; }
    if (!changed) { onClose(); return; }
    setBusy(true);
    setError("");
    try {
      await updateFolder(workspaceId, folder.id, { name: n });
      onRenamed(n);
    } catch (err) {
      setError(errText(err, "Couldn't rename the folder. Try again."));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={!!folder}
      onClose={onClose}
      size="sm"
      title="Rename folder"
      initialFocus={inputRef}
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" form="md-rename-folder" loading={busy} disabled={!name.trim()}>Rename</Button>
        </>
      }
    >
      <form id="md-rename-folder" onSubmit={submit} className="flex min-w-0 flex-col gap-4" noValidate>
        <Field label="Name" error={error || undefined}>
          <Input ref={inputRef} value={name} maxLength={80} autoComplete="off" onChange={(e) => { setName(e.target.value); setError(""); }} />
        </Field>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="md-field__label">Address</span>
          <p className="rounded-md border border-border bg-surface-inset px-3 py-2 font-mono text-code text-text [overflow-wrap:anywhere]" aria-live="polite">
            {host ?? "your-domain"}/{nextPath}/…
          </p>
          <p className="md-field__hint">
            Links that use the old name redirect to the new address. markdrop.in links never change.
          </p>
        </div>
      </form>
    </Dialog>
  );
}

/* ── Delete ───────────────────────────────────────────────────────────── */

export function DeleteFolderDialog({
  workspaceId, folder, tree, onClose, onDeleted,
}: {
  workspaceId: string;
  folder: TreeFolder | null;
  tree: WorkspaceTree | null;
  onClose: () => void;
  onDeleted: (f: TreeFolder) => void;
}) {
  const last = useRef<TreeFolder | null>(folder);
  if (folder) last.current = folder;
  const f = folder ?? last.current;
  const [mode, setMode] = useState<"move_up" | "unfile">("move_up");
  useEffect(() => { if (folder) setMode("move_up"); }, [folder]);

  const parent = f?.parent_id ? tree?.folders.find((x) => x.id === f.parent_id) ?? null : null;
  const subs = f && tree ? tree.folders.filter((x) => x.parent_id === f.id).length : 0;
  const wsName = tree?.workspace.name ?? "the workspace";
  const upLabel = parent ? `“${parent.name}”` : `the top of ${wsName}`;

  return (
    <ConfirmDialog
      open={!!folder}
      onClose={onClose}
      title={f ? `Delete “${f.name}”?` : "Delete folder?"}
      size="md"
      body={
        f ? (
          <div className="flex flex-col gap-4">
            <p className="text-body text-text-secondary">
              Only the folder goes. {f.item_count > 0 || subs > 0
                ? `Its ${[f.item_count ? plural(f.item_count, "item") : null, subs ? plural(subs, "subfolder") : null].filter(Boolean).join(" and ")} stay in ${wsName}${parent ? "" : ", at the top level"}, and nobody loses access.`
                : "It's empty."}
            </p>
            {parent && (f.item_count > 0 || subs > 0) && (
              <RadioGroup
                name="md-delete-folder-mode"
                aria-label="What happens to what's inside"
                value={mode}
                onChange={(v) => setMode(v as "move_up" | "unfile")}
                options={[
                  { value: "move_up", label: `Move everything into ${upLabel}`, description: "Items and subfolders keep their place one level up." },
                  { value: "unfile", label: `Move items to the top of ${wsName}`, description: subs ? "Subfolders move up one level, with what's in them." : "They stay in the workspace, in no folder." },
                ]}
              />
            )}
            <p className="text-caption text-text-muted">
              markdrop.in links never change. Links on the workspace's domain that include this folder redirect to the new address.
            </p>
          </div>
        ) : null
      }
      confirmLabel="Delete folder"
      onConfirm={async () => {
        if (!folder) return;
        try {
          await deleteFolder(workspaceId, folder.id, mode);
        } catch (e) {
          throw new Error(errText(e, "Couldn't delete the folder. Try again."));
        }
        onDeleted(folder);
      }}
    />
  );
}

/* ── Move to… ─────────────────────────────────────────────────────────── */

export type MoveTarget =
  | { kind: "items"; slugs: string[]; label: string; fromFolderId: string | null | undefined }
  | { kind: "folder"; folder: TreeFolder };

const ROOT = "root";

/**
 * "Move to…": the workspace as a tree, the current place and impossible places disabled with the
 * reason, arrow keys to walk it. Folders can't move into themselves or below their depth limit.
 */
export function MoveToDialog({
  workspace, tree, target, onClose, onMoved,
}: {
  workspace: Pick<Workspace, "id" | "name" | "branding">;
  tree: WorkspaceTree | null;
  target: MoveTarget | null;
  onClose: () => void;
  onMoved: (destination: { folderId: string | null; label: string }) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set([ROOT]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const folders = useMemo(() => tree?.folders ?? [], [tree]);
  const current = target?.kind === "items" ? target.fromFolderId : target?.folder.parent_id ?? null;

  useEffect(() => {
    if (!target) return;
    setSelected(null);
    setError("");
    setBusy(false);
    // Open the path down to where it is now, so "here" is visible at once.
    const open = new Set([ROOT]);
    let cur = current ? folders.find((f) => f.id === current) : undefined;
    let guard = 0;
    while (cur && guard++ < 32) {
      open.add(cur.id);
      cur = cur.parent_id ? folders.find((f) => f.id === cur!.parent_id) : undefined;
    }
    setExpanded(open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const nodes = useMemo<TreeNode[]>(() => {
    if (!target) return [];
    const kids = childrenMap(folders);
    const blocked = target.kind === "folder" ? descendants(folders, target.folder.id) : new Set<string>();
    const height = target.kind === "folder" ? subtreeHeight(folders, target.folder.id) : 0;
    const reason = (f: TreeFolder | null): string | undefined => {
      const id = f?.id ?? null;
      if (id === (current ?? null) && current !== undefined) return "It's already here";
      if (target.kind === "folder") {
        if (id === target.folder.id || (id && blocked.has(id))) return "A folder can't go inside itself";
        const depth = f ? f.depth + 1 : 0;
        if (depth + height > MAX_FOLDER_DEPTH) return `Folders nest at most ${MAX_FOLDER_DEPTH} deep`;
      }
      return undefined;
    };
    const build = (f: TreeFolder): TreeNode => {
      const r = reason(f);
      const sub = kids.get(f.id) ?? [];
      return {
        key: f.id,
        label: f.name,
        icon: <Icon name="folder" size={16} className="text-text-muted" />,
        children: sub.length ? sub.map(build) : undefined,
        disabled: !!r,
        disabledReason: r,
        marker: r ? <span className="shrink-0 text-caption text-text-muted">{r === "It's already here" ? "Current" : ""}</span> : undefined,
      };
    };
    const rootReason = reason(null);
    return [{
      key: ROOT,
      label: workspace.name,
      icon: <WorkspaceTile ws={workspace} />,
      children: (kids.get(null) ?? []).map(build),
      disabled: !!rootReason,
      disabledReason: rootReason,
      marker: rootReason ? <span className="shrink-0 text-caption text-text-muted">Current</span> : <span className="shrink-0 text-caption text-text-muted">Top level</span>,
    }];
  }, [target, folders, current, workspace]);

  const destLabel = selected === ROOT ? `the top of ${workspace.name}` : folders.find((f) => f.id === selected)?.name ?? "";

  async function move(key = selected) {
    if (!target || !key || busy) return;
    const folderId = key === ROOT ? null : key;
    setBusy(true);
    setError("");
    try {
      if (target.kind === "items") await moveItems(workspace.id, target.slugs, folderId);
      else await updateFolder(workspace.id, target.folder.id, { parent_id: folderId });
      onMoved({ folderId, label: key === ROOT ? `the top of ${workspace.name}` : folders.find((f) => f.id === key)?.name ?? "the folder" });
    } catch (e) {
      setError(errText(e, "Couldn't move it. Try again."));
      setBusy(false);
    }
  }

  const what = target?.kind === "folder" ? `“${target.folder.name}”` : target?.kind === "items" ? (target.slugs.length === 1 ? `“${target.label}”` : target.label) : "";

  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      size="md"
      title={`Move ${what}`}
      description="Choose a folder. Who can open it doesn't change; on the workspace's domain its address follows the folder."
      dismissible={!busy}
      footer={
        <>
          <span className="mr-auto hidden min-w-0 truncate text-caption text-text-muted sm:block" aria-live="polite">
            {selected ? <>To <span className="text-text-secondary">{destLabel}</span></> : "Nothing chosen yet"}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void move()} loading={busy} disabled={!selected}>Move here</Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-3">
        {!tree ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <span className="md-visually-hidden">Loading folders</span>
            {[0, 1, 2].map((i) => <Skeleton key={i} height={36} />)}
          </div>
        ) : (
          <div className="max-h-[50dvh] min-w-0 overflow-y-auto rounded-lg border border-border bg-surface-inset p-1.5">
            <TreeView
              label="Folders"
              mode="select"
              nodes={nodes}
              expanded={expanded}
              onToggle={(k, open) => setExpanded((s) => { const n = new Set(s); if (open) n.add(k); else n.delete(k); return n; })}
              selected={selected}
              onSelect={setSelected}
              onActivate={(k) => void move(k)}
              itemClassName="md-focus relative flex min-h-10 min-w-0 cursor-pointer items-center gap-1.5 rounded-md pr-2 text-body text-text-secondary hover:bg-surface-hover hover:text-text max-sm:min-h-11"
              activeClassName="!bg-accent-soft font-medium !text-accent-text"
            />
          </div>
        )}
        <p className="text-caption text-text-muted">
          Arrow keys move through the folders, → opens one, Enter chooses it.
        </p>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}

/* ── Add existing ─────────────────────────────────────────────────────── */

/**
 * File documents you already published (your personal list) into this folder. They are the same
 * documents, not copies (D1); who can open them stays as it is unless you choose the workspace.
 */
export function AddExistingDialog({
  open, workspace, folder, onClose, onAdded,
}: {
  open: boolean;
  workspace: Pick<Workspace, "id" | "name">;
  folder: TreeFolder | null;
  onClose: () => void;
  onAdded: (n: number) => void;
}) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [docs, setDocs] = useState<MyDocListItem[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [access, setAccess] = useState<"keep" | "workspace">("keep");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ(""); setDebounced(""); setPicked(new Set()); setAccess("keep"); setError(""); setBusy(false);
  }, [open]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setDocs(null);
    setLoadError("");
    listMyDocuments(1, debounced || undefined)
      .then((r) => { if (live) setDocs(r.documents); })
      .catch(() => { if (live) { setDocs([]); setLoadError("Couldn't load your documents. Close this and try again."); } });
    return () => { live = false; };
  }, [open, debounced]);

  const where = folder ? `“${folder.name}”` : `the top of ${workspace.name}`;

  async function submit() {
    if (!picked.size || busy) return;
    setBusy(true);
    setError("");
    try {
      await addItems(workspace.id, [...picked], folder?.id ?? null, access === "workspace" ? "workspace" : undefined);
      onAdded(picked.size);
    } catch (e) {
      setError(errText(e, "Couldn't add them. Try again."));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={`Add to ${folder ? folder.name : workspace.name}`}
      description="Choose documents and files you've published. They move into this folder as they are: the same link, not a copy."
      initialFocus={searchRef}
      dismissible={!busy}
      footer={
        <>
          <span className="mr-auto hidden text-caption text-text-muted sm:block" aria-live="polite">
            {picked.size ? `${plural(picked.size, "item")} chosen` : "Nothing chosen yet"}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!picked.size}>
            {picked.size ? `Add ${picked.size}` : "Add"}
          </Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-4">
        <Input
          ref={searchRef}
          type="search"
          iconPrefix="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search your documents"
          aria-label="Search your documents"
          wrapClassName="w-full"
          className="w-full"
        />
        {loadError && <Alert tone="danger">{loadError}</Alert>}
        {docs === null ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <span className="md-visually-hidden">Loading your documents</span>
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={52} />)}
          </div>
        ) : docs.length === 0 && !loadError ? (
          <EmptyState
            icon={debounced ? "search" : "lines"}
            title={debounced ? `Nothing matches “${debounced}”` : "You haven't published anything yet"}
            description={debounced ? "Search looks at titles and links." : "Use New document or Upload here instead."}
          />
        ) : (
          <ul className="flex max-h-[44dvh] min-w-0 flex-col gap-1 overflow-y-auto rounded-lg border border-border bg-surface-inset p-1.5" aria-label="Your documents">
            {docs.map((d) => {
              const inThis = d.workspace_id === workspace.id;
              const elsewhere = !!d.workspace_id && !inThis;
              const off = inThis || elsewhere;
              const t = displayTitle(d);
              return (
                <li key={d.id} className="min-w-0">
                  <label className={cx(
                    "flex min-h-12 min-w-0 items-center gap-3 rounded-md px-2 py-1.5",
                    off ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-surface-hover",
                  )}>
                    <Checkbox
                      checked={picked.has(d.slug)}
                      disabled={off}
                      aria-label={`Add ${t}`}
                      onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(d.slug); else n.delete(d.slug); return n; })}
                    />
                    <RowTile d={d} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-body-strong text-text" dir="auto">{t}</span>
                      <span className="truncate font-mono text-caption text-text-muted">
                        {inThis ? `Already in ${workspace.name}` : elsewhere ? "In another workspace" : `markdrop.in/${d.slug}`}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex flex-col gap-2">
          <span id="md-add-access" className="md-field__label">Who can open them</span>
          <RadioGroup
            name="md-add-access"
            aria-labelledby="md-add-access"
            value={access}
            onChange={(v) => setAccess(v as "keep" | "workspace")}
            options={[
              { value: "keep", label: "Keep as they are", description: "Each keeps its own setting. Private ones stay private, even here." },
              { value: "workspace", label: `Everyone in ${workspace.name}`, description: "Members can open them; nobody outside the workspace can, link or not." },
            ]}
          />
        </div>
        <p className="text-caption text-text-muted">Adding to {where}. You can take them out again any time.</p>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}
