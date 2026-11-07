"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Dialog, Field, Switch, Textarea, useToast } from "@/components/ui";
import { LoadingBlock, fmtDateTime } from "../shared";
import { useAiFetch, useAiSend } from "./common";

/** Admin → AI → Requests → Log settings: content capture, and which accounts and addresses count
 *  as test & internal (PUT /admin/ai/log/settings). */

interface LogSettingsData {
  content: boolean; internal_emails: string[]; internal_emails_default: boolean; default_internal_emails: string[];
  internal_ips: string[]; config_ips: string[]; retention_days: number; test_domains: string[];
  updated_at: string | null; updated_by: string | null;
}

const lines = (s: string) => s.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);

export function LogSettingsDialog({ token, open, onClose, onSaved }: { token: string; open: boolean; onClose: () => void; onSaved: () => void }) {
  const get = useAiFetch(token);
  const send = useAiSend(token);
  const toast = useToast();
  const [data, setData] = useState<LogSettingsData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [content, setContent] = useState(true);
  const [emails, setEmails] = useState("");
  const [ips, setIps] = useState("");
  const [saving, setSaving] = useState<"save" | "reset" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fill = (d: LogSettingsData) => {
    setData(d);
    setContent(d.content);
    setEmails(d.internal_emails.join("\n"));
    setIps(d.internal_ips.join("\n"));
  };

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoadError(false);
    setError(null);
    get<LogSettingsData>("log/settings").then((d) => live && fill(d)).catch(() => live && setLoadError(true));
    return () => { live = false; };
  }, [get, open]);

  const emailsChanged = data ? lines(emails).join("\n") !== data.internal_emails.join("\n") : false;
  const ipsChanged = data ? lines(ips).join("\n") !== data.internal_ips.join("\n") : false;
  const dirty = !!data && (content !== data.content || emailsChanged || ipsChanged);

  async function save() {
    if (!data) return;
    setSaving("save");
    setError(null);
    try {
      const body: { content?: boolean; internal_emails?: string[]; internal_ips?: string[] } = {};
      if (content !== data.content) body.content = content;
      if (emailsChanged) body.internal_emails = lines(emails);
      if (ipsChanged) body.internal_ips = lines(ips);
      fill(await send<LogSettingsData>("log/settings", body));
      toast.success("Log settings saved");
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save. Try again.");
    } finally {
      setSaving(null);
    }
  }

  async function reset() {
    setSaving("reset");
    setError(null);
    try {
      fill(await send<LogSettingsData>("log/settings", { reset_internal: true }));
      toast.success("Internal accounts back to the default");
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reset. Try again.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} size="lg" title="Log settings" dismissible={!saving}
      description="What the request log keeps, and which traffic counts as test & internal."
      footer={data ? (
        <>
          <Button variant="secondary" onClick={onClose} disabled={!!saving}>Close</Button>
          <Button onClick={save} loading={saving === "save"} disabled={!dirty || !!saving}>Save</Button>
        </>
      ) : undefined}
      bodyClassName="flex flex-col gap-4">
      {loadError ? <Alert tone="danger">Couldn&apos;t load the log settings.</Alert> : !data ? <LoadingBlock label="Loading settings" minHeight={200} /> : (
        <>
          {error && <Alert tone="danger">{error}</Alert>}
          <section className="flex flex-col gap-1.5 rounded-lg border border-border p-3.5">
            <Switch checked={content} onChange={(e) => setContent(e.target.checked)}
              label={<span className="text-body-strong text-text">Keep what was asked and answered</span>} />
            <p className="text-caption text-text-secondary">
              Off: new requests keep only who, when, the feature and the cost. Secrets, emails and phone numbers are masked either way.
              Content is kept for {data.retention_days} days; metadata follows the ledger.
            </p>
          </section>

          <Field label="Internal accounts" htmlFor="ai-log-emails"
            hint={data.internal_emails_default ? "The default list (the admin accounts). One email per line." : "One email per line. Their requests count as test & internal."}>
            <Textarea id="ai-log-emails" mono rows={4} value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="name@example.com" />
          </Field>
          {!data.internal_emails_default && (
            <div className="-mt-2 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" iconLeft="undo" loading={saving === "reset"} disabled={!!saving} onClick={reset}>Reset to default</Button>
              <span className="text-micro text-text-muted">Default: {data.default_internal_emails.join(", ") || "none"}</span>
            </div>
          )}

          <Field label="Internal addresses" htmlFor="ai-log-ips" hint="IP addresses or ranges (CIDR), one per line. Requests from them count as test & internal.">
            <Textarea id="ai-log-ips" mono rows={3} value={ips} onChange={(e) => setIps(e.target.value)} placeholder="203.0.113.7" />
          </Field>

          <dl className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-surface-inset p-3.5 text-caption sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-micro text-text-muted">Content kept for</dt>
              <dd className="text-text">{data.retention_days} days</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-micro text-text-muted">Addresses set on the server</dt>
              <dd className="break-words font-mono text-text">{data.config_ips.join(", ") || "None"}</dd>
            </div>
            <div className="min-w-0 sm:col-span-2">
              <dt className="text-micro text-text-muted">Test email domains (always test)</dt>
              <dd className="break-words font-mono text-text">{data.test_domains.join(", ") || "None"}</dd>
            </div>
            {data.updated_at && (
              <div className="min-w-0 sm:col-span-2">
                <dt className="text-micro text-text-muted">Last changed</dt>
                <dd className="text-text">{fmtDateTime(data.updated_at)}{data.updated_by ? ` by ${data.updated_by}` : ""}</dd>
              </div>
            )}
          </dl>
        </>
      )}
    </Dialog>
  );
}
