"use client";

import { useMemo, useState } from "react";
import {
  Button, ConfirmDialog, Dialog, EmptyState, Field, Icon, Input, RowMenu, Select, Skeleton, Tag,
  useToast, type MenuItem,
} from "@/components/ui";
import { createFolder, deleteFolder, renameFolder, type Folder } from "@/lib/workspaces";
import { plural } from "../../../settings-shared";
import { Locked, MAX_FOLDER_DEPTH, SectionHead, folderSlug, lockProps, type WsTabProps } from "../ws-shared";

/**
 * Folders (REVAMP_PLAN 7.12): the tree with a RowMenu per folder (New subfolder, Rename, Delete),
 * a New folder dialog with the depth-8 limit and a live address preview. Filing is member work;
 * deleting a folder is admin work (the API enforces both).
 *
 * Delete copy follows what services/folder.py does (D26, confirmed by the backend): documents
 * directly inside are unfiled but stay in the workspace, subfolders move up one level with their
 * documents, nothing is deleted and nobody's access changes. markdrop.in links never change; on the
 * workspace's own domain the address loses the folder segment, and old folder URLs 307-redirect to
 * the new address (the tenant page looks a document up by its last segment).
 */
export default function FoldersTab({ id, isAdmin, isMember, host, folders, folderCounts, refresh }: WsTabProps) {
  const toast = useToast();
  const [dialog, setDialog] = useState<{ mode: "new" | "rename"; folder?: Folder } | null>(null);
  const [name, setName] = useState("");
  // "" is the root. Kept between creates: making several folders in one place is the common case.
  const [parent, setParent] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Folder | null>(null);

  // Depth-first order, so a child always follows its parent and the indentation means what it
  // looks like it means. `path` is the folder's slugs from the root, so sorting on it is the walk.
  const sorted = useMemo(
    () => [...(folders ?? [])].sort((a, b) => a.path.join("/").localeCompare(b.path.join("/"))),
    [folders],
  );
  const byId = useMemo(() => new Map(sorted.map((f) => [f.id, f])), [sorted]);
  const childCount = (f: Folder) => sorted.filter((x) => x.parent_id === f.id).length;

  function openNew(parentId = parent) {
    setDialog({ mode: "new" });
    setParent(parentId);
    setName("");
    setError("");
  }

  function openRename(f: Folder) {
    setDialog({ mode: "rename", folder: f });
    setName(f.name);
    setError("");
  }

  const parentPath = dialog?.mode === "rename"
    ? (dialog.folder?.path.slice(0, -1) ?? [])
    : parent ? (byId.get(parent)?.path ?? []) : [];
  const previewSegs = [...parentPath, folderSlug(name || "new-folder")];
  const previewAddress = `${host ?? "your-domain"}/${previewSegs.join("/")}/…`;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) { setError("Give the folder a name."); return; }
    setBusy(true);
    setError("");
    try {
      if (dialog?.mode === "rename" && dialog.folder) {
        await renameFolder(id, dialog.folder.id, n);
        toast.success("Folder renamed.");
      } else {
        await createFolder(id, n, parent || null);
        toast.success(parent ? "Subfolder created." : "Folder created.");
      }
      await refresh("folders", "folderCounts");
      setDialog(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the folder. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function menu(f: Folder): MenuItem[] {
    const items: MenuItem[] = [];
    if (isMember) {
      items.push({
        label: "New subfolder", icon: "plus",
        disabled: f.path.length >= MAX_FOLDER_DEPTH,
        caption: f.path.length >= MAX_FOLDER_DEPTH ? `Folders nest at most ${MAX_FOLDER_DEPTH} deep` : undefined,
        onClick: () => openNew(f.id),
      });
      items.push({ label: "Rename", icon: "edit", onClick: () => openRename(f) });
    }
    if (isAdmin) items.push({ label: "Delete folder", icon: "trash", danger: true, separated: true, onClick: () => setDeleting(f) });
    return items;
  }

  const newButton = (
    <Locked locked={!isMember} reason="Members and admins only">
      <Button variant="primary" iconLeft="plus" {...lockProps(!isMember)} onClick={isMember ? () => openNew("") : lockProps(true).onClick}>
        New folder
      </Button>
    </Locked>
  );

  const delCount = deleting ? folderCounts?.[deleting.id] : undefined;
  const delSubs = deleting ? childCount(deleting) : 0;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <SectionHead
        title="Folders"
        description="Filing only. Folders never change who can read a document, but they are part of its address."
        actions={newButton}
      />

      {folders === null ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading folders">
          {[0, 1, 2].map((i) => <Skeleton key={i} variant="rect" height={44} />)}
        </div>
      ) : folders.length === 0 ? (
        <EmptyState
          icon="folder"
          title="No folders yet"
          description={host ? `A document filed under Guides lives at ${host}/guides/… on your domain.` : "Folders group the workspace's documents and become part of their address on your domain."}
          actions={isMember ? newButton : undefined}
        />
      ) : (
        <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-surface">
          <ul role="list" aria-label="Folders" className="flex flex-col divide-y divide-border">
            {sorted.map((f) => {
              const depth = f.path.length - 1;
              const count = folderCounts?.[f.id] ?? 0;
              const items = menu(f);
              return (
                <li
                  key={f.id}
                  className="flex min-h-12 min-w-0 items-center gap-3 py-2 pr-2"
                  // Indented by real depth (capped on phones by the clamp), so the tree's shape shows.
                  style={{ paddingLeft: `calc(16px + ${Math.min(depth, 7)} * clamp(10px, 3vw, 20px))` }}
                >
                  <Icon name="folder" className="shrink-0 text-text-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body-strong text-text" dir="auto">{f.name}</p>
                    <p className="truncate font-mono text-micro text-text-muted">/{f.path.join("/")}</p>
                  </div>
                  {folderCounts && (
                    <Tag className="shrink-0">
                      <span className="md-visually-hidden">{plural(count, "document")}</span>
                      <span aria-hidden>{count}</span>
                    </Tag>
                  )}
                  {items.length > 0 ? <RowMenu portal align="right" label={`More actions for ${f.name}`} items={items} /> : <span className="w-8" />}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <Dialog
        open={!!dialog}
        onClose={() => !busy && setDialog(null)}
        dismissible={!busy}
        title={dialog?.mode === "rename" ? `Rename "${dialog.folder?.name}"` : "New folder"}
        description={dialog?.mode === "rename"
          ? "The name is also its part of the address on your domain. Links that use the old name redirect to the new address."
          : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)} disabled={busy}>Cancel</Button>
            <Button variant="primary" type="submit" form="folder-form" loading={busy}>
              {dialog?.mode === "rename" ? "Rename folder" : "Create folder"}
            </Button>
          </>
        }
      >
        <form id="folder-form" onSubmit={submit} className="flex min-w-0 flex-col gap-5" noValidate>
          <Field label="Name" error={error || undefined}>
            <Input value={name} onChange={(e) => { setName(e.target.value); if (error) setError(""); }} maxLength={80} placeholder="Guides" autoComplete="off" />
          </Field>
          {dialog?.mode === "new" && sorted.length > 0 && (
            <Field label="Inside" hint={`Folders nest at most ${MAX_FOLDER_DEPTH} deep.`}>
              <Select value={parent} onChange={(e) => setParent(e.target.value)}>
                <option value="">Top level</option>
                {sorted.map((f) => (
                  // A folder at the limit can't hold another one, so it is offered greyed rather
                  // than accepted and then refused by the server.
                  <option key={f.id} value={f.id} disabled={f.path.length >= MAX_FOLDER_DEPTH}>
                    {"  ".repeat(Math.max(0, f.path.length - 1))}
                    {f.name}
                    {f.path.length >= MAX_FOLDER_DEPTH ? " (full)" : ""}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <div className="flex min-w-0 flex-col gap-1">
            <span className="md-field__label">Address</span>
            <p className="rounded-md border border-border bg-surface-inset px-3 py-2 font-mono text-code text-text [overflow-wrap:anywhere]" aria-live="polite">
              {previewAddress}
            </p>
            <p className="md-field__hint">
              {host ? "Where documents filed here live on your domain. markdrop.in links don't change." : "Where documents filed here will live once the workspace has a domain. markdrop.in links don't change."}
            </p>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={deleting ? `Delete "${deleting.name}"?` : "Delete folder?"}
        body={
          <>
            {delCount === undefined
              ? "Documents in it stay in the workspace, unfiled."
              : delCount === 0
                ? "It has no documents of its own."
                : delCount === 1 ? "The document in it stays in the workspace, unfiled." : `The ${delCount} documents in it stay in the workspace, unfiled.`}
            {delSubs === 1 ? " Its subfolder moves up one level, with its documents." : delSubs > 1 ? ` Its ${delSubs} subfolders move up one level, with their documents.` : ""}
            {" "}Nothing is deleted and nobody loses access. Links on markdrop.in stay the same; links on {host ?? "your domain"} that include this folder redirect to the new address.
          </>
        }
        confirmLabel="Delete folder"
        onConfirm={async () => {
          const f = deleting!;
          const r = await deleteFolder(id, f.id);
          setDeleting(null);
          await refresh("folders", "folderCounts");
          toast.success(r?.unfiled_documents ? `Folder deleted. ${plural(r.unfiled_documents, "document")} moved to Unfiled.` : "Folder deleted.");
        }}
      />
    </div>
  );
}
