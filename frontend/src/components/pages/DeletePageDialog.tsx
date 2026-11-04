"use client";

import { DeleteItemDialog, type DeletedInfo } from "@/components/trash/DeleteItemDialog";
import type { RestoreResult } from "@/lib/trash";

/**
 * Delete a page (the page's ⋯ menu): the shared trash dialog. It names the page and its link, asks
 * what happens to its sub-pages (moved up a level, or to Trash with it: `?children=lift|delete`),
 * moves it to Trash for 30 days and toasts Undo.
 */
export function DeletePageDialog({
  open, onClose, slug, title, count, secret, workspaceId, onDeleted, onRestored,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  title: string | null;
  /** Direct sub-pages, when known (the dialog asks the API otherwise). */
  count?: number | null;
  /** The edit secret, for an anonymous page (the delete and its Undo both need it). */
  secret?: string | null;
  workspaceId?: string | null;
  onDeleted: (info: DeletedInfo) => void;
  /** After Undo put it back (go back to the page). */
  onRestored?: (r: RestoreResult) => void;
}) {
  return (
    <DeleteItemDialog
      item={open ? { slug, title, kind: "page", subPages: count ?? null, workspaceId } : null}
      onClose={onClose}
      secret={secret}
      onDeleted={onDeleted}
      onRestored={onRestored}
    />
  );
}

export default DeletePageDialog;
