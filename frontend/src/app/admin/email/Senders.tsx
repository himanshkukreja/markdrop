"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert, Badge, Button, ConfirmDialog, Drawer, EmptyState, Field, IconButton, Input, Skeleton, Switch, Textarea, useToast,
} from "@/components/ui";
import { CopyButton } from "@/components/ui";
import { isUnauthorized, plural, useOnUnauthorized } from "../shared";
import { emailApi, type DomainsInfo, type Info, type Sender, type Suppression } from "./api";
import { CheckBadge, Facts, Section, TimeAgo, num } from "./bits";

const EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+$/;

interface Form { id: string | null; label: string; from_name: string; from_email: string; reply_to: string; is_default: boolean }
const EMPTY: Form = { id: null, label: "", from_name: "Markdrop", from_email: "", reply_to: "", is_default: false };

function DomainNote({ email, domains }: { email: string; domains: DomainsInfo | null }) {
  if (!EMAIL_RE.test(email) || !domains) return null;
  const d = email.split("@")[1]!.toLowerCase();
  if (domains.state === "console") return <Alert tone="neutral">Console transport: {d} isn&apos;t checked, and nothing is emailed.</Alert>;
  if (domains.state !== "ok") return <Alert tone="warning" title="Can't verify this domain from here">{domains.message}</Alert>;
  const status = domains.names[d];
  if (status === "verified") return <Alert tone="success" title="Domain verified">{d} is verified in Resend, so mail from it is delivered with SPF and DKIM.</Alert>;
  return (
    <Alert tone="danger" title={status ? `${d} is “${status.replace(/_/g, " ")}” in Resend` : `${d} isn't in Resend`}>
      Resend refuses mail from unverified domains. Add {d} in the Resend dashboard (Domains), publish its DNS records, and wait for it to verify.
    </Alert>
  );
}

function SenderDrawer({ open, form, setForm, onClose, onSave, saving, error, domains }: {
  open: boolean; form: Form; setForm: (f: Form) => void; onClose: () => void; onSave: () => void; saving: boolean; error: string | null; domains: DomainsInfo | null;
}) {
  const emailOk = EMAIL_RE.test(form.from_email.trim());
  const replyOk = !form.reply_to.trim() || EMAIL_RE.test(form.reply_to.trim());
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={form.id ? "Edit sender" : "Add a from address"}
      description={form.id ? form.from_email : "Campaigns can send from any address on a domain verified in Resend."}
      footer={
        <div className="flex w-full flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={onSave} loading={saving} disabled={!emailOk || !replyOk}>Save sender</Button>
        </div>
      }
      bodyClassName="flex flex-col gap-4"
    >
      <Field label="From name" hint="Shown as the sender in inboxes.">
        <Input value={form.from_name} maxLength={80} onChange={(e) => setForm({ ...form, from_name: e.target.value })} />
      </Field>
      <Field label="From address" error={form.from_email.trim() && !emailOk ? "Not a valid address yet." : undefined}>
        <Input type="email" value={form.from_email} placeholder="updates@markdrop.in" autoComplete="off" onChange={(e) => setForm({ ...form, from_email: e.target.value })} />
      </Field>
      <Field label="Reply-to (optional)" hint="Where replies land. Blank uses MARKDROP_EMAIL_REPLY_TO." error={!replyOk ? "Not a valid address." : undefined}>
        <Input type="email" value={form.reply_to} placeholder="himanshu@markdrop.in" autoComplete="off" onChange={(e) => setForm({ ...form, reply_to: e.target.value })} />
      </Field>
      <Field label="Label (optional)">
        <Input value={form.label} maxLength={60} placeholder="Product updates" onChange={(e) => setForm({ ...form, label: e.target.value })} />
      </Field>
      <Switch checked={form.is_default} onChange={(e) => setForm({ ...form, is_default: e.target.checked })} label="Default sender for new campaigns" />
      <DomainNote email={form.from_email.trim()} domains={domains} />
      {error && <Alert tone="danger">{error}</Alert>}
    </Drawer>
  );
}

function Suppressions({ token }: { token: string }) {
  const toast = useToast();
  const onUnauthorized = useOnUnauthorized();
  const [data, setData] = useState<{ rows: Suppression[]; by_reason: Record<string, number>; unsubscribed_accounts: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [add, setAdd] = useState("");
  const [busy, setBusy] = useState(false);
  const [lift, setLift] = useState<Suppression | null>(null);

  const load = useCallback(async (query = "") => {
    try {
      setData(await emailApi.suppressions(token, query));
      setError(null);
    } catch (e) {
      if (isUnauthorized(e)) onUnauthorized();
      else setError(e instanceof Error ? e.message : "Couldn't load");
    }
  }, [token, onUnauthorized]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const t = setTimeout(() => void load(q), 300);
    return () => clearTimeout(t);
  }, [q, load]);

  const reasons = data?.by_reason ?? {};
  return (
    <Section id="email-suppressions" label="Never email" title="Suppression list">
      <p className="mb-3 text-body text-text-secondary">
        Every audience skips these addresses, and each batch re-checks them right before sending. Unsubscribes and spam complaints
        land here automatically; hard bounces do when Resend webhooks are on.
      </p>
      <div className="mb-3 flex flex-wrap gap-2" aria-label="Suppressions by reason">
        {["unsubscribed", "bounced", "complained", "manual"].map((r) => (
          <Badge key={r} tone={r === "unsubscribed" ? "neutral" : r === "manual" ? "info" : "danger"} size="sm" className="tabular-nums">
            {r} · {num(reasons[r] ?? 0)}
          </Badge>
        ))}
        {data && <Badge tone="neutral" variant="outline" size="sm" className="tabular-nums">{plural(data.unsubscribed_accounts, "account")} opted out</Badge>}
      </div>
      <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search an address" aria-label="Search suppressions" prefix="search" wrapClassName="mb-3 max-w-md" />
      {error ? <Alert tone="danger">{error}</Alert> : !data ? <Skeleton variant="rect" height={80} /> : data.rows.length === 0 ? (
        <EmptyState icon="inbox" title={q ? "No match" : "Nobody suppressed"} className="py-6" />
      ) : (
        <ul className="md-focus flex max-h-80 flex-col overflow-y-auto rounded-lg border border-border" tabIndex={0} aria-label="Suppressed addresses">
          {data.rows.map((r) => (
            <li key={r.email} className="flex min-w-0 items-center gap-3 border-b border-border px-3 py-2 last:border-0">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-caption text-text">{r.email}</span>
                <span className="block truncate text-micro text-text-secondary">{r.reason}{r.detail ? ` · ${r.detail}` : ""} · <TimeAgo iso={r.updated_at || r.created_at} /></span>
              </span>
              {(r.reason === "bounced" || r.reason === "manual") && (
                <IconButton icon="x" label={`Remove ${r.email} from the suppression list`} size="sm" onClick={() => setLift(r)} />
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex flex-col gap-2">
        <Field label="Suppress addresses by hand" hint="Comma, space or one per line. People who unsubscribed can only opt back in themselves.">
          <Textarea mono rows={2} value={add} onChange={(e) => setAdd(e.target.value)} placeholder="someone@example.com" />
        </Field>
        <div>
          <Button size="sm" variant="secondary" loading={busy} disabled={!add.trim()} onClick={async () => {
            setBusy(true);
            try {
              const r = await emailApi.addSuppressions(token, add);
              toast.success(`Suppressed ${plural(r.added, "address", "addresses")}${r.invalid ? ` (${r.invalid} invalid skipped)` : ""}`);
              setAdd("");
              void load(q);
            } catch (e) {
              if (isUnauthorized(e)) onUnauthorized();
              else toast.error(e instanceof Error ? e.message : "Couldn't add");
            } finally { setBusy(false); }
          }}>Add to the list</Button>
        </div>
      </div>
      <ConfirmDialog
        open={!!lift}
        onClose={() => setLift(null)}
        tone="default"
        title="Email this address again?"
        body={<p className="text-body text-text-secondary">{lift?.email} comes off the suppression list ({lift?.reason}). If it bounced before, it may bounce again and hurt deliverability.</p>}
        confirmLabel="Remove from list"
        onConfirm={async () => {
          if (!lift) return;
          await emailApi.removeSuppression(token, lift.email);
          setLift(null);
          toast.success("Removed from the suppression list");
          void load(q);
        }}
      />
    </Section>
  );
}

export default function Senders({ token, info, onChanged }: { token: string; info: Info | null; onChanged: () => void }) {
  const toast = useToast();
  const onUnauthorized = useOnUnauthorized();
  const [senders, setSenders] = useState<Sender[] | null>(info?.senders ?? null);
  const [domains, setDomains] = useState<DomainsInfo | null>(info?.setup.domains ?? null);
  const [checking, setChecking] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [del, setDel] = useState<Sender | null>(null);

  useEffect(() => {
    if (info) { setSenders(info.senders); setDomains(info.setup.domains); }
  }, [info]);

  const recheck = async () => {
    setChecking(true);
    try {
      const r = await emailApi.senders(token, true);
      setSenders(r.senders);
      setDomains(r.domains);
    } catch (e) {
      if (isUnauthorized(e)) onUnauthorized();
      else toast.error(e instanceof Error ? e.message : "Check failed");
    } finally { setChecking(false); }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await emailApi.saveSender(token, form.id, {
        label: form.label.trim(), from_name: form.from_name.trim(), from_email: form.from_email.trim(),
        reply_to: form.reply_to.trim(), is_default: form.is_default,
      });
      setSenders(r.senders);
      setOpen(false);
      toast.success(form.id ? "Sender updated" : "Sender added");
      onChanged();
    } catch (e) {
      if (isUnauthorized(e)) onUnauthorized();
      else setError(e instanceof Error ? e.message : "Couldn't save");
    } finally { setSaving(false); }
  };

  const setup = info?.setup;
  const verified = useMemo(() => Object.entries(domains?.names ?? {}), [domains]);
  const issues = (senders ?? []).filter((s) => s.check.level !== "ok");

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 lg:grid-cols-2">
        <Section id="email-transport" label="Transport" title="Resend"
          actions={setup ? (setup.transport === "resend"
            ? <Badge tone="success" icon="check">Configured</Badge>
            : <Badge tone="warning" icon="alert">Console · not sending</Badge>) : undefined}>
          {!setup ? <Skeleton variant="rect" height={96} /> : (
            <div className="flex flex-col gap-3">
              <Facts items={[
                { label: "API", value: setup.transport === "resend" ? "api.resend.com · batch API" : "MARKDROP_RESEND_API_KEY isn't set" },
                { label: "Pace", value: `${setup.batch.size} per batch, one batch every ${(setup.batch.gap_ms / 1000).toFixed(1)} s` },
                { label: "Domains", value: domains?.state === "ok"
                  ? (verified.length ? (
                    <span className="flex flex-wrap gap-1.5">{verified.map(([d, s]) => (
                      <Badge key={d} size="sm" tone={s === "verified" ? "success" : "warning"} className="font-mono">{d} · {s.replace(/_/g, " ")}</Badge>
                    ))}</span>
                  ) : "No domains in this Resend account")
                  : <span className="text-text-secondary">{domains?.message ?? "—"}</span> },
              ]} />
              <div><Button size="sm" variant="secondary" iconLeft="refresh" loading={checking} onClick={recheck}>Check domains again</Button></div>
            </div>
          )}
        </Section>
        <Section id="email-webhooks" label="Delivery events" title="Resend webhook"
          actions={setup ? (setup.webhooks ? <Badge tone="success" icon="check">On</Badge> : <Badge tone="neutral">Off</Badge>) : undefined}>
          {!setup ? <Skeleton variant="rect" height={96} /> : (
            <div className="flex flex-col gap-3 text-body text-text-secondary">
              <p>
                Deliveries, bounces and complaints come from Resend webhooks. Hard bounces and complaints are suppressed automatically.
                {setup.webhooks ? "" : " Set MARKDROP_RESEND_WEBHOOK_SECRET to turn it on; until then the endpoint answers 503."}
              </p>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <code className="min-w-0 max-w-full break-all rounded-md bg-surface-inset px-2 py-1 font-mono text-caption text-text">{setup.webhook_url}</code>
                <CopyButton text={setup.webhook_url} label="Copy URL" />
              </div>
              <p className="text-caption">Events: email.delivered, email.bounced, email.complained (optionally email.opened, email.clicked).</p>
            </div>
          )}
        </Section>
      </div>

      <Alert tone="info" title="Resend only delivers from verified domains">
        Add the From domain in Resend (Domains), publish its SPF and DKIM records, and wait for it to show as verified. Replies go to the
        reply-to address, never to the From mailbox.
      </Alert>

      <Section id="email-senders" label="Senders" title="From addresses"
        actions={<Button size="sm" iconLeft="plus" onClick={() => { setForm(EMPTY); setError(null); setOpen(true); }}>Add sender</Button>}>
        {!senders ? <Skeleton variant="rect" height={96} /> : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {senders.map((s) => (
              <li key={s.id} className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 px-3 py-3">
                <span className="min-w-0 flex-[1_1_16rem]">
                  <span className="block break-words text-body-strong text-text">{s.from_name ? `${s.from_name} ` : ""}<span className="font-normal text-text-secondary">&lt;{s.from_email}&gt;</span></span>
                  <span className="block break-words font-mono text-micro text-text-muted">{s.label}{s.reply_to ? ` · reply-to ${s.reply_to}` : ""}</span>
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <CheckBadge check={s.check} />
                  {s.is_default && <Badge size="sm" tone="info">Default</Badge>}
                  {s.source === "env" && <Badge size="sm" tone="neutral" variant="outline">Env</Badge>}
                </span>
                <span className="ml-auto flex items-center gap-1">
                  {s.source === "env" ? (
                    <span className="text-caption text-text-muted">Set in env</span>
                  ) : (
                    <>
                      <Button size="sm" variant="ghost" iconLeft="edit" onClick={() => {
                        setForm({ id: s.id, label: s.label, from_name: s.from_name, from_email: s.from_email, reply_to: s.reply_to ?? "", is_default: s.is_default });
                        setError(null);
                        setOpen(true);
                      }}>Edit</Button>
                      <IconButton icon="trash" label={`Delete ${s.from_email}`} size="sm" onClick={() => setDel(s)} />
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {issues.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1 text-caption text-text-secondary">
            {issues.map((s) => <li key={s.id} className="break-words"><span className="font-mono text-text">{s.from_email}</span> · {s.check.message}</li>)}
          </ul>
        )}
      </Section>

      <Suppressions token={token} />

      <SenderDrawer open={open} form={form} setForm={setForm} onClose={() => setOpen(false)} onSave={save} saving={saving} error={error} domains={domains} />
      <ConfirmDialog
        open={!!del}
        onClose={() => setDel(null)}
        title="Delete this sender?"
        body={<p className="text-body text-text-secondary">{del?.from_email} disappears from the sender list. Campaigns already sent keep their record of who they came from.</p>}
        confirmLabel="Delete sender"
        onConfirm={async () => {
          if (!del) return;
          await emailApi.deleteSender(token, del.id);
          setDel(null);
          toast.success("Sender removed");
          onChanged();
          setSenders((l) => l?.filter((x) => x.id !== del.id) ?? null);
        }}
      />
    </div>
  );
}
