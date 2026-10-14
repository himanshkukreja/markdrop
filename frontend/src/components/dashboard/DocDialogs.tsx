"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, ConfirmDialog, Dialog, Field, Input, Select } from "@/components/ui";
import { changeSlug, deleteDocument, type MyDocListItem } from "@/lib/api";
import { createFolder, fileDocument, listFolders, purgeDocument, type Folder } from "@/lib/workspaces";
import { SLUG_RE } from "./format";

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** Folder options labelled by path, depth-first: two folders can both be called "Drafts". */
export function folderOptions(folders: Folder[]) {
  return [...folders]
    .sort((a, b) => a.path.join("/").localeCompare(b.path.join("/")))
    .map((f) => ({ value: f.id, label: f.path.length > 1 ? `${f.path.slice(0, -1).join(" / ")} / ${f.name}` : f.name }));
}

/* ── Change URL ───────────────────────────────────────────────────────── */

/**
 * Dialog sm: "New link" with a markdrop.in/ prefix and live validation. On success the cached
 * renders of both the old and the new slug are purged (the old one would otherwise keep serving
 * for up to a minute, the new one may hold a stale 404).
 */
export function ChangeUrlDialog({
  doc, onClose, onChanged,
}: {
  doc: MyDocListItem | null;
  onClose: () => void;
  onChanged: (oldSlug: string, newSlug: string) => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (doc) { setValue(doc.slug); setError(""); setBusy(false); }
  }, [doc]);

  const trimmed = value.trim();
  const invalid = trimmed.length > 0 && !SLUG_RE.test(trimmed);
  const unchanged = !!doc && trimmed === doc.slug;
  const hint = invalid
    ? undefined
    : "Existing links to the old URL will stop working. Analytics are preserved.";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!doc || busy || invalid || !trimmed || unchanged) return;
    setBusy(true);
    setError("");
    try {
      await changeSlug(doc.slug, trimmed);
      purgeDocument(doc.slug);
      purgeDocument(trimmed);
      onChanged(doc.slug, trimmed);
    } catch (err) {
      setError(errText(err, "Couldn't change the URL. Check your connection and try again."));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={!!doc}
      onClose={onClose}
      size="sm"
      title="Change URL"
      initialFocus={inputRef}
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" form="md-change-url" loading={busy} disabled={!trimmed || invalid || unchanged}>
            Change URL
          </Button>
        </>
      }
    >
      <form id="md-change-url" onSubmit={submit} className="flex flex-col gap-3">
        <Field
          label="New link"
          hint={hint}
          error={invalid ? "Use 3 to 50 letters, numbers, hyphens or underscores." : undefined}
        >
          <Input
            ref={inputRef}
            mono
            textPrefix="markdrop.in/"
            value={value}
            maxLength={50}
            invalid={invalid}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => { setValue(e.target.value.replace(/\s/g, "")); setError(""); }}
          />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </Dialog>
  );
}

/* ── Delete ───────────────────────────────────────────────────────────── */

/** "Delete this document?" with the consequence named; errors stay inline in the dialog. */
export function DeleteDocDialog({
  doc, onClose, onDeleted,
}: {
  doc: MyDocListItem | null;
  onClose: () => void;
  onDeleted: (slug: string) => void;
}) {
  // Keep the last document while the dialog animates out, so the copy doesn't flash empty.
  const last = useRef<MyDocListItem | null>(doc);
  if (doc) last.current = doc;
  const shown = doc ?? last.current;
  const isArtifact = shown?.kind === "artifact";
  return (
    <ConfirmDialog
      open={!!doc}
      onClose={onClose}
      title={isArtifact ? "Delete this artifact?" : "Delete this document?"}
      body={
        shown ? (
          <p className="text-body text-text-secondary">
            <span className="font-mono text-text">markdrop.in/{shown.slug}</span> will stop working for everyone. This cannot be undone.
          </p>
        ) : null
      }
      confirmLabel="Delete"
      onConfirm={async () => {
        if (!doc) return;
        try {
          await deleteDocument(doc.slug);
        } catch (e) {
          throw new Error(errText(e, "Couldn't delete it. Check your connection and try again."));
        }
        purgeDocument(doc.slug);
        onDeleted(doc.slug);
      }}
    />
  );
}

/* ── Move to folder ───────────────────────────────────────────────────── */

/** Files a workspace document into one of its folders (or Unfiled). Access doesn't change. */
export function MoveFolderDialog({
  doc, workspaceId, workspaceName, folders: given, onClose, onMoved,
}: {
  doc: MyDocListItem | null;
  workspaceId: string | null;
  workspaceName?: string | null;
  folders?: Folder[] | null;
  onClose: () => void;
  onMoved: (doc: MyDocListItem, folderLabel: string) => void;
}) {
  const [folders, setFolders] = useState<Folder[] | null>(given ?? null);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (!doc || !workspaceId) return;
    setValue(doc.folder_id || "");
    setError("");
    setBusy(false);
    if (given) { setFolders(given); return; }
    let live = true;
    setFolders(null);
    listFolders(workspaceId)
      .then((f) => live && setFolders(f))
      .catch(() => { if (live) { setFolders([]); setError("Couldn't load the folders. Close this and try again."); } });
    return () => { live = false; };
  }, [doc, workspaceId, given]);

  const options = useMemo(() => [{ value: "", label: "Unfiled" }, ...folderOptions(folders ?? [])], [folders]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!doc || !workspaceId || busy) return;
    if ((doc.folder_id || "") === value) { onClose(); return; }
    setBusy(true);
    setError("");
    try {
      await fileDocument(workspaceId, doc.id, value || null, doc.slug);
      onMoved(doc, options.find((o) => o.value === value)?.label ?? "Unfiled");
    } catch (err) {
      setError(errText(err, "Couldn't move it. Check your connection and try again."));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={!!doc && !!workspaceId}
      onClose={onClose}
      size="sm"
      title="Move to folder"
      description={workspaceName ? `Folders in ${workspaceName}. Who can open it doesn't change.` : "Who can open it doesn't change."}
      initialFocus={selectRef}
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" form="md-move-folder" loading={busy} disabled={folders === null}>Move</Button>
        </>
      }
    >
      <form id="md-move-folder" onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Folder" hint="On the workspace's own domain, the address follows the folder.">
          <Select ref={selectRef} value={value} onChange={(e) => setValue(e.target.value)} options={options} disabled={folders === null} />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </Dialog>
  );
}

/* ── New folder ───────────────────────────────────────────────────────── */

export function NewFolderDialog({
  open, workspaceId, parent, onClose, onCreated,
}: {
  open: boolean;
  workspaceId: string;
  /** Create inside this folder (the folder in view), else at the top level. */
  parent?: Folder | null;
  onClose: () => void;
  onCreated: (f: Folder) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) { setName(""); setError(""); setBusy(false); }
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setError("");
    try {
      const f = await createFolder(workspaceId, n, parent?.id ?? null);
      onCreated(f);
    } catch (err) {
      setError(errText(err, "Couldn't create the folder. Check your connection and try again."));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title="New folder"
      description={parent ? `Inside /${parent.path.join("/")}` : "At the top of the library"}
      initialFocus={inputRef}
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" form="md-new-folder" loading={busy} disabled={!name.trim()}>Create folder</Button>
        </>
      }
    >
      <form id="md-new-folder" onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Folder name" hint="Becomes part of the address on the workspace's own domain.">
          <Input ref={inputRef} value={name} maxLength={80} onChange={(e) => { setName(e.target.value); setError(""); }} placeholder="Reports" />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </Dialog>
  );
}
