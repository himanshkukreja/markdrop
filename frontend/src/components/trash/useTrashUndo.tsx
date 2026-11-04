"use client";

/**
 * The toast after every delete: "Moved to Trash", with Undo for about 8 seconds. The ToastProvider
 * sits in the root layout, so the toast survives the navigation a page view makes after its delete
 * (to the dashboard, the parent page or /new) and Undo still works from there.
 */
import { useCallback, type ReactNode } from "react";
import { useToast, type ToastApi } from "@/components/ui";
import { purgeCached, restoreFromTrash, type RestoreResult } from "@/lib/trash";
import { documentsChanged, workspaceChanged } from "@/lib/workspaceStore";

export interface MovedToTrash {
  /** What restore takes: the document's slug, or the folder's id. */
  key: string;
  /** Its name for the toast ("“Product Docs”"); masked like every toast. */
  label?: ReactNode;
  /** An anonymous document's edit secret: Undo needs it to restore. */
  secret?: string | null;
  /** The workspace it was in, so its tree and lists reload after Undo. */
  workspaceId?: string | null;
  /** After Undo put it back (refresh a list, or go back to the item). */
  onRestored?: (r: RestoreResult) => void;
}

/** Restore `key` and say so: "Restored" plus where it went when its old place is gone. */
export async function restoreWithToast(
  toast: ToastApi,
  opts: { key: string; secret?: string | null; workspaceId?: string | null; open?: (r: RestoreResult) => string | null },
): Promise<RestoreResult | null> {
  try {
    const r = await restoreFromTrash(opts.key, opts.secret);
    await Promise.all([r.slug, ...r.items.map((i) => i.slug)].filter((s, i, a): s is string => !!s && a.indexOf(s) === i).slice(0, 20).map((s) => purgeCached(s)));
    documentsChanged();
    if (opts.workspaceId) workspaceChanged(opts.workspaceId);
    const note = r.notes[0];
    const href = opts.open?.(r) ?? null;
    toast.toast({
      kind: "success",
      message: <>Restored{r.title ? <> “{r.title}”</> : null}.{note ? <> {note}</> : null}</>,
      duration: note ? 8000 : 4000,
      action: href ? { label: "Open", onClick: () => window.location.assign(href) } : undefined,
    });
    return r;
  } catch (e) {
    toast.error(e instanceof Error && e.message ? e.message : "Couldn't restore it. Try again from Trash.");
    return null;
  }
}

/** `const moved = useTrashUndo(); moved({ key, label, secret, onRestored })` after a delete. */
export function useTrashUndo() {
  const toast = useToast();
  return useCallback((m: MovedToTrash) => {
    toast.toast({
      kind: "success",
      message: <>Moved{m.label ? <> {m.label}</> : null} to Trash</>,
      duration: 8000,
      action: {
        label: "Undo",
        onClick: () => {
          void restoreWithToast(toast, { key: m.key, secret: m.secret, workspaceId: m.workspaceId }).then((r) => {
            if (r) m.onRestored?.(r);
          });
        },
      },
    });
  }, [toast]);
}
