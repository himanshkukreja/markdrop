"use client";

/**
 * The one delete dialog for documents, pages and files, wherever they're deleted (the dashboard,
 * a folder, a page's ⋯ menu, a file's view and settings, the classic editor). It names exactly what
 * goes: the kind, the title and the link, so a page can't be mistaken for the HTML file of the same
 * name next to it. It asks the API what the delete would take when it opens (the kind and the
 * sub-pages, when the caller doesn't know them), offers the sub-page choice, deletes, and shows the
 * "Moved to Trash" toast with Undo. Nothing is destroyed: it goes to Trash for 30 days.
 */
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Dialog, Icon, Radio } from "@/components/ui";
import { plural } from "@/components/dashboard/format";
import { docKindOf, kindNoun, type DocKindWord } from "@/lib/itemKind";
import { TRASH_DAYS, deletePreview, moveToTrash, purgeCached, type DeletePreview, type RestoreResult } from "@/lib/trash";
import { useTrashUndo } from "./useTrashUndo";

/** What the caller knows about the item; the preview fills in the rest. */
export interface DeleteTarget {
  slug: string;
  title?: string | null;
  kind?: DocKindWord | null;
  /** A file's type ("HTML file", "PDF"). */
  typeLabel?: string | null;
  encrypted?: boolean;
  /** Direct sub-pages, when known (else the preview says). */
  subPages?: number | null;
  /** "https://markdrop.in/<slug>"; else markdrop.in/<slug>. */
  url?: string | null;
  /** The workspace it's in, so its tree reloads after Undo. */
  workspaceId?: string | null;
}

/** A dashboard / library row (MyDocListItem-shaped) as a delete target. */
export function deleteTargetOf(d: {
  slug: string; title?: string | null; kind?: string | null; editor?: string | null; type_label?: string | null;
  encrypted?: boolean; original_filename?: string | null; workspace_id?: string | null;
}): DeleteTarget {
  return {
    slug: d.slug,
    title: d.encrypted ? null : d.title?.trim() || d.original_filename || null,
    kind: d.kind ? docKindOf(d) : null,
    typeLabel: d.type_label ?? null,
    encrypted: !!d.encrypted,
    workspaceId: d.workspace_id ?? null,
  };
}

export interface DeletedInfo {
  slug: string;
  title: string | null;
  kind: DocKindWord;
  /** What happened to its sub-pages, when it had some. */
  children?: "delete" | "lift";
}

export interface DeleteItemDialogProps {
  /** Open while set. */
  item: DeleteTarget | null;
  onClose: () => void;
  /** An anonymous document's edit secret (the delete and its Undo both need it). */
  secret?: string | null;
  /** After the delete (close the dialog, refresh, navigate). */
  onDeleted: (info: DeletedInfo) => void;
  /** After Undo put it back (refresh a list, or go back to the item). */
  onRestored?: (r: RestoreResult) => void;
  /** false: no "Moved to Trash" toast (the caller shows its own). Default true. */
  undoToast?: boolean;
}

function addressOf(slug: string, url?: string | null): string {
  if (url) {
    try {
      const u = new URL(url);
      return `${u.host}${u.pathname}`.replace(/\/$/, "");
    } catch {
      /* fall through */
    }
  }
  return `markdrop.in/${slug}`;
}

export function DeleteItemDialog({ item, onClose, secret, onDeleted, onRestored, undoToast = true }: DeleteItemDialogProps) {
  // Keep the last item while the dialog animates out, so the copy doesn't flash empty.
  const last = useRef<DeleteTarget | null>(item);
  if (item) last.current = item;
  const shown = item ?? last.current;

  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [mode, setMode] = useState<"lift" | "delete">("lift");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const moved = useTrashUndo();

  const slug = item?.slug ?? null;
  useEffect(() => {
    if (!slug) return;
    setPreview(null);
    setMode("lift");
    setBusy(false);
    setError("");
    setChecking(true);
    let live = true;
    deletePreview(slug, secret)
      .then((p) => { if (live) setPreview(p); })
      // The preview only adds detail: without it the dialog says what the caller knows, and the
      // delete itself reports a refusal.
      .catch(() => {})
      .finally(() => { if (live) setChecking(false); });
    return () => { live = false; };
  }, [slug, secret]);

  if (!shown) return null;

  const kind: DocKindWord = preview?.kind ?? shown.kind ?? "document";
  const typeLabel = preview?.type_label ?? shown.typeLabel ?? null;
  const noun = kindNoun(kind, typeLabel);
  const title = shown.encrypted ? null : preview?.title ?? shown.title ?? null;
  const address = addressOf(shown.slug, preview?.url ?? shown.url);
  const children = preview?.children ?? shown.subPages ?? 0;
  const below = Math.max(children, preview?.descendants ?? children);
  // A page whose sub-pages we don't know yet: wait for the preview before offering the delete.
  const waiting = checking && !preview && kind === "page" && shown.subPages == null;

  async function go() {
    if (!item || busy) return;
    setBusy(true);
    setError("");
    const how = children > 0 ? mode : undefined;
    try {
      await moveToTrash(item.slug, { children: how, secret });
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Couldn't move it to Trash. Check your connection and try again.");
      setBusy(false);
      return;
    }
    void purgeCached(item.slug);
    if (undoToast) {
      moved({
        key: item.slug,
        label: <>the {noun}{title ? <> “{title}”</> : null}{how === "delete" && below > 0 ? <> and {plural(below, "sub-page")}</> : null}</>,
        secret,
        workspaceId: item.workspaceId,
        onRestored,
      });
    }
    setBusy(false);
    onDeleted({ slug: item.slug, title, kind, children: how });
  }

  return (
    <Dialog
      open={!!item}
      onClose={() => { if (!busy) onClose(); }}
      dismissible={!busy}
      size="sm"
      glyph={<Icon name="trash" />}
      title={
        title
          ? <>Delete the {noun} “<span className="ph-sensitive ph-mask">{title}</span>”?</>
          : <>Delete this {noun}?</>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" iconLeft="trash" onClick={() => void go()} loading={busy} disabled={waiting}>Move to Trash</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-1.5 text-body text-text-secondary">
          <span className="shrink-0">{noun.charAt(0).toUpperCase() + noun.slice(1)}</span>
          <span aria-hidden>·</span>
          <span className="ph-sensitive ph-mask min-w-0 font-mono text-text [overflow-wrap:anywhere]">{address}</span>
        </p>

        {children > 0 && (
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-2 text-body-strong text-text">
              It has {plural(children, "sub-page")}{below > children ? <>, with {plural(below - children, "more page")} under them</> : null}
            </legend>
            <Radio name="md-trash-children" checked={mode === "lift"} onChange={() => setMode("lift")} label="Keep them: move them up a level" />
            <Radio
              name="md-trash-children"
              checked={mode === "delete"}
              onChange={() => setMode("delete")}
              label={below === 1 ? "Delete the sub-page too" : `Delete all ${below.toLocaleString("en-US")} sub-pages too`}
              description={mode === "delete" ? "They go to Trash with it, and come back with it if you restore it." : undefined}
            />
          </fieldset>
        )}

        <p className="m-0 text-body text-text-secondary">
          It goes to Trash for {preview?.days ?? TRASH_DAYS} days; you can restore it from there. The link stops working right away.
        </p>

        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}

export default DeleteItemDialog;
