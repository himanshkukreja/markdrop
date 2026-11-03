"use client";

import { useState } from "react";
import { Alert, Button, Dialog, Radio } from "@/components/ui";

/**
 * Delete a page. With sub-pages, say what happens to them: deleted too, or moved up a level
 * (`?children=delete|lift`).
 */
export function DeletePageDialog({ open, onClose, count, onDelete }: { open: boolean; onClose: () => void; count: number; onDelete: (children?: "delete" | "lift") => Promise<void> }) {
  const [mode, setMode] = useState<"lift" | "delete">("lift");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function go() {
    setBusy(true);
    setError("");
    try {
      await onDelete(count ? mode : undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete the page. Try again.");
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      tone="danger"
      title="Delete this page?"
      description="Its link stops working for everyone. This can't be undone."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={() => void go()} loading={busy}>Delete page</Button>
        </>
      }
    >
      {count > 0 && (
        <fieldset className="flex flex-col gap-2 border-0 p-0 m-0">
          <legend className="mb-2 text-body-strong text-text">It has {count === 1 ? "1 sub-page" : `${count} sub-pages`}</legend>
          <Radio name="pb-del" checked={mode === "lift"} onChange={() => setMode("lift")} label="Keep them: move them up a level" />
          <Radio name="pb-del" checked={mode === "delete"} onChange={() => setMode("delete")} label={count === 1 ? "Delete the sub-page too" : `Delete all ${count} sub-pages too`} />
        </fieldset>
      )}
      {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
    </Dialog>
  );
}

export default DeletePageDialog;
