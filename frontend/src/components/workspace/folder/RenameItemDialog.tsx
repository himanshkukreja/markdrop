"use client";

/**
 * Rename an item (its title; the link stays the same). Files rename through the artifact settings
 * call, which members may use on files they can edit. A markdown document's title is saved with its
 * current text, exactly as the editor does; an encrypted one is renamed in the editor, where its key is.
 */
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Dialog, Field, Input } from "@/components/ui";
import { getDocument, updateArtifactSettings, updateDocument } from "@/lib/api";
import { purgeDocument as purgeDocumentCache } from "@/lib/workspaces";

export interface RenameTarget {
  slug: string;
  kind: string;
  title: string;
}

export default function RenameItemDialog({
  target, onClose, onRenamed,
}: {
  target: RenameTarget | null;
  onClose: () => void;
  onRenamed: (title: string) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (target) { setName(target.title); setBusy(false); setError(""); }
  }, [target]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    const t = name.trim();
    if (!t || t === target.title) { onClose(); return; }
    setBusy(true);
    setError("");
    try {
      if (target.kind === "artifact") {
        await updateArtifactSettings(target.slug, { title: t });
      } else {
        const doc = await getDocument(target.slug);
        if (doc.encrypted) throw new Error("This document is encrypted. Rename it in the editor.");
        await updateDocument(target.slug, t, doc.content, "");
      }
      purgeDocumentCache(target.slug);
      onRenamed(t);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Couldn't rename it. Try again.");
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      dismissible={!busy}
      size="sm"
      title="Rename"
      description="Its link stays the same."
      initialFocus={inputRef}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" form="md-rename-item" loading={busy} disabled={!name.trim()}>Save</Button>
        </>
      }
    >
      <form id="md-rename-item" onSubmit={save} className="flex flex-col gap-3">
        <Field label="Title">
          <Input ref={inputRef} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </Dialog>
  );
}
