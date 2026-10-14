"use client";

import { useState } from "react";
import { Alert, Button, Dialog, Field, Textarea } from "@/components/ui";
import { reportDocument } from "@/lib/api";

/** Report phishing, malware or abuse. Reachable by anyone from the framed view (never hidden). */
export function ReportDialog({ open, onClose, slug }: { open: boolean; onClose: () => void; slug: string }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  function close() {
    if (busy) return;
    onClose();
    // Reset after the exit so the closing dialog doesn't flash the empty form.
    setTimeout(() => {
      setReason("");
      setDone(false);
      setError("");
    }, 200);
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await reportDocument(slug, reason.trim() || undefined);
      setDone(true);
    } catch {
      setError("Couldn't send the report. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      size="sm"
      dismissible={!busy}
      title={done ? "Report sent" : "Report this artifact"}
      description={done ? undefined : "Report phishing, malware or abusive content. Telling us why is optional."}
      footer={
        done ? (
          <Button variant="secondary" onClick={close}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" onClick={submit} loading={busy}>
              {busy ? "Sending…" : "Send report"}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <p className="m-0 text-body text-text-secondary">Thanks. Our team will review this artifact.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <Field label="Reason (optional)">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} disabled={busy} />
          </Field>
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      )}
    </Dialog>
  );
}

export default ReportDialog;
