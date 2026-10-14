"use client";

import { Alert, Button, Card, Dialog, Icon, Spinner } from "@/components/ui";

/** Save a copy (REVAMP_PLAN 7.6): two interactive cards over the existing copy logic. */
export function SaveCopyDialog({
  open, onClose, busy, error, gConnected, onCopy,
}: {
  open: boolean;
  onClose: () => void;
  busy: null | "plain" | "google";
  error: string;
  gConnected: boolean;
  onCopy: (withGoogle: boolean) => void;
}) {
  const option = (kind: "plain" | "google", icon: string, title: string, hint: string) => (
    <Card
      interactive={!busy}
      aria-disabled={!!busy || undefined}
      role="button"
      aria-label={title}
      onClick={() => { if (!busy) onCopy(kind === "google"); }}
      className={busy && busy !== kind ? "opacity-60" : undefined}
    >
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text" aria-hidden>
          {busy === kind ? <Spinner /> : <Icon name={icon} />}
        </span>
        <span className="min-w-0">
          <span className="block text-body-strong text-text">{title}</span>
          <span className="block text-caption text-text-secondary">{hint}</span>
        </span>
      </div>
    </Card>
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Save a copy to your account"
      description="This creates your own editable copy on Markdrop with a new link. The copy has no password and no expiry."
      dismissible={!busy}
      footer={<Button variant="ghost" onClick={onClose} disabled={!!busy}>Cancel</Button>}
    >
      <div className="flex flex-col gap-3" aria-busy={!!busy || undefined}>
        {option("plain", "copy", busy === "plain" ? "Creating copy…" : "Copy to Markdrop", "A new document in your dashboard.")}
        {option(
          "google",
          "google",
          busy === "google" ? "Working…" : gConnected ? "Copy & sync to Google Docs" : "Copy & connect Google Docs",
          gConnected ? "Also export the copy to a new Google Doc." : "You'll be asked to connect Google Docs first.",
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}
