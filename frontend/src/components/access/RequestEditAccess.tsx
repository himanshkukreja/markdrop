"use client";

/**
 * "Request edit access" (2026-11-04): someone who can read a page but not edit it asks its owner
 * (or, when the page has no reachable owner, its workspace's admins) to let them edit it. Works on
 * markdrop.in and on a workspace's own domain (`role: "editor"` is the one request a domain's
 * session may make). Approving gives edit on that page only.
 *
 * `useEditRequest` says whether to offer it (asked once the page is known to be read-only for this
 * signed-in reader); `RequestEditDialog` sends it with an optional message.
 */
import { useEffect, useId, useState } from "react";
import { Alert, Button, Dialog, Textarea } from "@/components/ui";

export interface EditRequestState {
  /** Offer "Request edit access". */
  canRequest: boolean;
  /** Asked already; waiting for an answer. */
  pending: boolean;
}

/** Whether this signed-in reader may ask to edit `slug` (null: not asked / not applicable). */
export function useEditRequest(slug: string, ask: boolean): [EditRequestState | null, (s: EditRequestState) => void] {
  const [state, setState] = useState<EditRequestState | null>(null);
  useEffect(() => {
    if (!ask) { setState(null); return; }
    let live = true;
    import("@/lib/me")
      .then((m) => m.myAccessRequest(slug, "editor"))
      .then((r) => { if (live) setState({ canRequest: r.can_request_access, pending: r.request_pending }); })
      .catch(() => { if (live) setState(null); });
    return () => { live = false; };
  }, [slug, ask]);
  return [state, setState];
}

export function RequestEditDialog({ slug, open, onClose, onSent }: {
  slug: string;
  open: boolean;
  onClose: () => void;
  onSent: (pending: boolean) => void;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const msgId = useId();

  useEffect(() => {
    if (open) { setError(""); setBusy(false); }
  }, [open]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const { requestAccess } = await import("@/lib/me");
      await requestAccess(slug, message, "editor");
      setMessage("");
      onSent(true);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0;
      if (status === 409 && /already asked/i.test(err instanceof Error ? err.message : "")) { onSent(true); return; }
      setError(
        status === 429 ? (err instanceof Error && err.message ? err.message : "You've asked for a lot in the last hour. Try again later.")
          : status === 409 ? (err instanceof Error && err.message ? err.message : "Nothing to ask for here.")
            : err instanceof Error && err.message ? err.message : "Couldn't send the request. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Request edit access"
      description="The page's owner gets an email and decides. You'll get an email when they let you edit."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="md-edit-request" variant="primary" iconLeft="send" loading={busy}>Send request</Button>
        </>
      }
    >
      <form id="md-edit-request" className="flex flex-col gap-3" onSubmit={send}>
        <label htmlFor={msgId} className="text-body-strong text-text">
          Message <span className="font-normal text-text-muted">(optional)</span>
        </label>
        <Textarea
          id={msgId}
          rows={3}
          maxLength={500}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Hi, I'd like to fix a few things in this page."
          className="resize-none"
        />
        <p className="text-caption text-text-muted">If they say yes, you can edit this page. Pages inside it aren&apos;t included.</p>
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </Dialog>
  );
}
