"use client";

import { useEffect, useState } from "react";
import Modal from "@/components/Modal";
import Spinner from "@/components/Spinner";
import { renderCampaignSamples, type Audience, type RenderedSample } from "@/lib/api";

/**
 * Final look at what recipients actually receive, before anything is sent.
 *
 * The compose pane previews the raw template, which still contains {{name}} and
 * {{unsubscribe_url}}. Those are exactly the things that go wrong — a stray
 * placeholder, a missing opt-out link — and they're invisible until the mail has
 * already gone out. This renders the real thing for real people and blocks the
 * send behind seeing it.
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

  return (
    <Modal
      title={mode === "test" ? "Preview the test email" : `Preview before sending to ${total}`}
      onClose={onClose}
    >
      <div className="space-y-3">
        {error && <p className="text-sm text-red-500">{error}</p>}

        {!samples && !error && (
          <div className="flex items-center gap-2 text-sm text-gray-500 py-8 justify-center">
            <Spinner className="w-4 h-4" /> Rendering…
          </div>
        )}

        {samples && samples.length === 0 && (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            This audience has no recipients, so there is nothing to preview.
          </p>
        )}

        {current && (
          <>
            {samples.length > 1 && (
              <div className="flex items-center gap-1">
                {samples.map((s, i) => (
                  <button
                    key={s.email}
                    onClick={() => setIdx(i)}
                    className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                      i === idx
                        ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                        : "text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
                    }`}
                  >
                    {s.name || s.email.split("@")[0]}
                  </button>
                ))}
              </div>
            )}

            <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-3 text-xs space-y-1 bg-gray-50 dark:bg-gray-900/50">
              <div><span className="text-gray-400">To</span> <span className="font-medium">{current.email}</span></div>
              <div><span className="text-gray-400">Subject</span> <span className="font-medium">{subject}</span></div>
              <div className="flex flex-wrap gap-3 pt-1">
                <span className={leftover ? "text-red-500" : "text-emerald-600 dark:text-emerald-400"}>
                  {leftover ? `⚠ unresolved ${leftover}` : "✓ placeholders substituted"}
                </span>
                <span className={hasUnsub ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"}>
                  {hasUnsub ? "✓ unsubscribe link present" : "⚠ no unsubscribe link"}
                </span>
              </div>
            </div>

            <div className="rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden bg-white h-[26rem]">
              <iframe
                // No allow-scripts: this is pasted markup and the admin session
                // lives on this origin.
                sandbox=""
                srcDoc={current.html}
                title={`Email to ${current.email}`}
                className="w-full h-full border-0"
              />
            </div>
          </>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
            Back to editing
          </button>
          <button
            onClick={onConfirm}
            disabled={!current || !!leftover}
            title={leftover ? "Resolve the placeholder before sending" : undefined}
            className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium transition-colors"
          >
            {mode === "test" ? "Send test" : `Send to ${total} recipient${total === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
