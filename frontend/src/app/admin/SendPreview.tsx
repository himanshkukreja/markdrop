"use client";

import { useEffect, useState } from "react";
import { Alert, Badge, Button, Dialog, Skeleton, Tabs, Tooltip } from "@/components/ui";
import { renderCampaignSamples, type Audience, type RenderedSample } from "@/lib/api";

/**
 * Final look at what recipients actually receive, before anything is sent.
 *
 * The compose pane previews the raw template, which still contains {{name}} and
 * {{unsubscribe_url}}. Those are exactly the things that go wrong — a stray
 * placeholder, a missing opt-out link — and they're invisible until the mail has
 * already gone out. This renders the real thing for real people and blocks the
 * send behind seeing it: an unresolved placeholder or a missing unsubscribe link
 * keeps the send button disabled (aria-disabled, so its reason stays reachable).
 */
export default function SendPreview({
  token,
  subject,
  html,
  audience,
  recentDays,
  emails,
  previewEmail,
  mode,
  onClose,
  onConfirm,
}: {
  token: string;
  subject: string;
  html: string;
  audience: Audience;
  recentDays: number;
  emails: string[];
  /** Set for a test send: renders this exact address, registered or not. */
  previewEmail?: string;
  /** "send" previews the audience; "test" previews the single test address. */
  mode: "send" | "test";
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [samples, setSamples] = useState<RenderedSample[] | null>(null);
  const [total, setTotal] = useState(0);
  const [idx, setIdx] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    renderCampaignSamples(token, {
      subject, html, audience, recentDays, emails,
      previewEmail: mode === "test" ? previewEmail : undefined,
      limit: mode === "test" ? 1 : 3,
    })
      .then((r) => {
        if (cancelled) return;
        setSamples(r.samples);
        setTotal(r.total);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Could not render"));
    return () => { cancelled = true; };
  }, [token, subject, html, audience, recentDays, emails, mode, previewEmail]);

  const current = samples?.[idx];
  // A placeholder that survived rendering would ship literally in the email.
  const leftover = current ? /\{\{\s*\w+\s*\}\}/.exec(current.html)?.[0] : null;
  const hasUnsub = current ? current.html.includes(current.unsubscribe_url) : false;
  const blocked = !current || !!leftover || !hasUnsub;
  const reason = !current
    ? "Nothing to send yet"
    : leftover
      ? `Fill in ${leftover} before sending`
      : !hasUnsub ? "Add the {{unsubscribe_url}} link before sending" : null;
  const confirmLabel = mode === "test" ? "Send test" : `Send to ${total.toLocaleString("en")} recipient${total === 1 ? "" : "s"}`;

  const confirm = (
    <Button variant="primary" iconLeft="send" aria-disabled={blocked || undefined} onClick={() => { if (!blocked) onConfirm(); }}>
      {confirmLabel}
    </Button>
  );

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={mode === "test" ? "Preview the test email" : `Preview before sending to ${total.toLocaleString("en")}`}
      description="Rendered for real recipients, exactly as they'll receive it."
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Back to editing</Button>
          {reason ? <Tooltip content={reason}>{confirm}</Tooltip> : confirm}
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <Alert tone="danger" title="Couldn't render the email">{error}</Alert>}

        {!samples && !error && (
          <div className="flex flex-col gap-2" aria-busy="true">
            <span className="md-visually-hidden" role="status">Rendering…</span>
            <Skeleton variant="rect" height={64} />
            <Skeleton variant="rect" height={320} />
          </div>
        )}

        {samples && samples.length === 0 && (
          <Alert tone="warning">This audience has no recipients, so there is nothing to preview.</Alert>
        )}

        {current && (
          <>
            {samples && samples.length > 1 && (
              <Tabs variant="pill" size="sm" aria-label="Sample recipient" value={String(idx)} onChange={(v) => setIdx(Number(v))}
                items={samples.map((s, i) => ({ value: String(i), label: s.name || s.email.split("@")[0] }))} />
            )}

            <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-inset p-3 text-caption">
              <p className="min-w-0 break-all"><span className="text-text-secondary">To</span> <span className="font-medium text-text">{current.email}</span></p>
              <p className="min-w-0 break-words"><span className="text-text-secondary">Subject</span> <span className="font-medium text-text">{subject}</span></p>
              <ul className="flex flex-wrap gap-2 pt-1" aria-label="Checks">
                <li>
                  {leftover
                    ? <Badge size="sm" tone="danger" icon="alertCircle">Unresolved <span className="font-mono">{leftover}</span></Badge>
                    : <Badge size="sm" tone="success" icon="check">Placeholders filled in</Badge>}
                </li>
                <li>
                  {hasUnsub
                    ? <Badge size="sm" tone="success" icon="check">Unsubscribe link present</Badge>
                    : <Badge size="sm" tone="danger" icon="alertCircle">No unsubscribe link</Badge>}
                </li>
              </ul>
            </div>

            <div className="h-[26rem] overflow-hidden rounded-lg border border-border">
              <iframe
                // No allow-scripts: this is pasted markup and the admin session
                // lives on this origin.
                sandbox=""
                srcDoc={current.html}
                title={`Email to ${current.email}`}
                className="h-full w-full border-0"
              />
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
