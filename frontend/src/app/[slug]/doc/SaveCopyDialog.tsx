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

/**
 * Save a copy of an encrypted document. The server can't copy what it can't read, so this browser
 * does it: the text it already decrypted is sealed again under a brand-new key (or, by choice,
 * published as plain text), created as a new document, and opened with its new link.
 */
export function EncryptedCopyDialog({
  open, onClose, busy, error, onCopy, signedIn,
}: {
  open: boolean;
  onClose: () => void;
  busy: null | "encrypted" | "plain";
  error: string;
  onCopy: (plain: boolean) => void;
  signedIn: boolean;
}) {
  const option = (kind: "encrypted" | "plain", icon: string, title: string, hint: string) => (
    <Card
      interactive={!busy}
      aria-disabled={!!busy || undefined}
      role="button"
      aria-label={title}
      tabIndex={busy ? -1 : 0}
      onClick={() => { if (!busy) onCopy(kind === "plain"); }}
      onKeyDown={(e) => { if (!busy && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onCopy(kind === "plain"); } }}
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
      title="Save a copy"
      description={`Your browser makes the copy from the text it already decrypted, with a new link${signedIn ? " in your account" : ""}. The copy has no password and no expiry.`}
      dismissible={!busy}
      footer={<Button variant="ghost" onClick={onClose} disabled={!!busy}>Cancel</Button>}
    >
      <div className="flex flex-col gap-3" aria-busy={!!busy || undefined}>
        {option("encrypted", "key", busy === "encrypted" ? "Encrypting the copy…" : "Encrypted copy", "A new key, made in this browser. The original's link doesn't open the copy.")}
        {option("plain", "doc", busy === "plain" ? "Creating copy…" : "Unencrypted copy", "Markdrop can read it. Link previews, search and Google Docs work.")}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}
