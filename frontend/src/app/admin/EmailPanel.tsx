"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge, Button, ConfirmDialog, Dropdown, Field, Input, Progress, RadioGroup, Table, Tabs, Textarea, useToast,
  type Column,
} from "@/components/ui";
import {
  createCampaign, listCampaigns, previewAudience, sendCampaignTest,
  type Audience, type CampaignItem,
} from "@/lib/api";
import { ARTIFACTS_ANNOUNCEMENT, TEMPLATES, type EmailTemplate } from "./emailTemplates";
import RecipientPicker from "./RecipientPicker";
import SendPreview from "./SendPreview";
import { PageHead, fmtDate, plural } from "./shared";

const AUDIENCES: { id: Audience; label: string; hint: string }[] = [
  { id: "all", label: "Everyone", hint: "All accounts that haven't opted out" },
  { id: "with_documents", label: "Has documents", hint: "Published at least one document" },
  { id: "with_artifacts", label: "Uses artifacts", hint: "Published at least one artifact" },
  { id: "recent", label: "Recent sign-ups", hint: "Joined in the last N days" },
  { id: "custom", label: "Specific people", hint: "Pick accounts or type addresses" },
];
const AUDIENCE_LABEL: Record<string, string> = Object.fromEntries(AUDIENCES.map((a) => [a.id, a.label]));

const STATUS: Record<string, { tone: "success" | "info" | "neutral" | "warning" | "danger"; label: string; icon: string }> = {
  sent: { tone: "success", label: "Sent", icon: "check" },
  sending: { tone: "info", label: "Sending", icon: "send" },
  queued: { tone: "neutral", label: "Queued", icon: "clock" },
  partial: { tone: "warning", label: "Partly sent", icon: "alert" },
  failed: { tone: "danger", label: "Failed", icon: "alertCircle" },
};

const PLACEHOLDERS = ["{{name}}", "{{email}}", "{{unsubscribe_url}}"];

/** The compose preview fills placeholders with sample values; SendPreview renders the real thing per recipient. */
function sampleHtml(html: string, email: string) {
  return html
    .replace(/\{\{\s*name\s*\}\}/g, "Priya")
    .replace(/\{\{\s*email\s*\}\}/g, email)
    .replace(/\{\{\s*unsubscribe_url\s*\}\}/g, "#unsubscribe");
}

export default function EmailPanel({ token }: { token: string }) {
  const toast = useToast();
  const [subject, setSubject] = useState(ARTIFACTS_ANNOUNCEMENT.subject);
  const [html, setHtml] = useState(ARTIFACTS_ANNOUNCEMENT.html);
  const [sender, setSender] = useState("");
  const [audience, setAudience] = useState<Audience>("all");
  const [recentDays, setRecentDays] = useState(30);
  const [picked, setPicked] = useState<string[]>([]);

  const [count, setCount] = useState<number | null>(null);
  const [sample, setSample] = useState<string[]>([]);
  const [testTo, setTestTo] = useState("");
  const [testError, setTestError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "test" | "send">(null);
  const [preview, setPreview] = useState<null | "send" | "test">(null);
  const [campaigns, setCampaigns] = useState<CampaignItem[] | null>(null);
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  const [pane, setPane] = useState<"compose" | "preview" | "audience">("compose");
  const [pending, setPending] = useState<EmailTemplate | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  const emails = picked;

  const refreshCount = useCallback(async () => {
    try {
      const r = await previewAudience(token, audience, { recentDays, emails });
      setCount(r.count);
      setSample(r.sample);
    } catch {
      setCount(null);
    }
  }, [token, audience, recentDays, picked]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = setTimeout(refreshCount, 300);
    return () => clearTimeout(t);
  }, [refreshCount]);

  const loadCampaigns = useCallback(async () => {
    try {
      setCampaigns(await listCampaigns(token));
    } catch {
      setCampaigns((c) => c ?? []);
    }
  }, [token]);

  useEffect(() => {
    loadCampaigns();
  }, [loadCampaigns]);

  // While anything is mid-flight, poll so progress moves without a manual refresh.
  const sendingRef = useRef(false);
  sendingRef.current = (campaigns ?? []).some((c) => c.status === "sending" || c.status === "queued");
  useEffect(() => {
    if (!sendingRef.current) return;
    const iv = setInterval(loadCampaigns, 3000);
    return () => clearInterval(iv);
  }, [campaigns, loadCampaigns]);

  async function handleTest() {
    setPreview(null);
    if (!testTo.trim()) return setTestError("Enter an address to send the test to.");
    setBusy("test");
    try {
      await sendCampaignTest(token, { subject, html, sender, toEmail: testTo.trim() });
      toast.success(`Test sent to ${testTo.trim()}.`);
    } catch (e) {
      toast.error(e instanceof Error ? `Couldn't send the test: ${e.message}` : "Couldn't send the test. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function handleSend() {
    setPreview(null);
    setBusy("send");
    try {
      const r = await createCampaign(token, { subject, html, sender, audience, recentDays, emails });
      toast.success(`Sending to ${plural(r.total, "recipient")}. Progress shows in the history below.`);
      loadCampaigns();
    } catch (e) {
      toast.error(e instanceof Error ? `Couldn't start the campaign: ${e.message}` : "Couldn't start the campaign. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const reviewTest = () => {
    if (!testTo.trim()) { setTestError("Enter an address to send the test to."); return; }
    setTestError(null);
    setPreview("test");
  };

  const insert = (token_: string) => {
    const el = area.current;
    if (!el) { setHtml((h) => h + token_); return; }
    const { selectionStart: s, selectionEnd: e } = el;
    const next = html.slice(0, s) + token_ + html.slice(e);
    setHtml(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + token_.length, s + token_.length); });
  };

  const isTemplate = useMemo(() => TEMPLATES.some((t) => t.html === html), [html]);
  const load = (t: EmailTemplate) => {
    if (isTemplate || !html.trim()) { setSubject(t.subject); setHtml(t.html); }
    else setPending(t);
  };

  const sampleEmail = sample[0] ?? "priya@example.com";
  const n = count ?? 0;

  const testField = (
    <Field label="Send a test to" error={testError ?? undefined} className="min-w-0 flex-[1_1_14rem]">
      <Input type="email" value={testTo} onChange={(e) => { setTestTo(e.target.value); setTestError(null); }} placeholder="you@example.com" />
    </Field>
  );
  const testButton = (
    <Button variant="secondary" iconLeft="mail" loading={busy === "test"} className="min-h-11 sm:min-h-9"
      onClick={() => { if (!testTo.trim()) setPane("compose"); reviewTest(); }}>Send test</Button>
  );
  const sendButton = (
    <Button variant="primary" iconLeft="send" loading={busy === "send"} className="min-h-11 max-lg:flex-1 sm:min-h-9 lg:ml-auto"
      aria-disabled={!n || !!busy || undefined}
      onClick={() => { if (n && !busy) setPreview("send"); }}>
      Review and send to {n.toLocaleString("en")}
    </Button>
  );

  const compose = (
    <div className="flex min-w-0 flex-col gap-4">
      <Field label="Subject">
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
      </Field>
      <Field label="From" hint="Leave blank to send from updates@ — kept separate from sign-in mail">
        <Input value={sender} onChange={(e) => setSender(e.target.value)} placeholder="Markdrop <updates@markdrop.in>" />
      </Field>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor="campaign-html" className="md-field__label">HTML</label>
          <Dropdown
            align="right"
            aria-label="Load template"
            trigger={<Button size="sm" variant="secondary" iconRight="chevronDown">Load template</Button>}
            items={TEMPLATES.map((t) => ({ label: t.label, description: t.description, onClick: () => load(t) }))}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Insert a placeholder at the cursor">
          <span className="text-caption text-text-secondary">Insert</span>
          {PLACEHOLDERS.map((ph) => (
            <Button key={ph} size="sm" variant="ghost" className="font-mono" onClick={() => insert(ph)}>{ph}</Button>
          ))}
        </div>
        <Textarea
          id="campaign-html"
          ref={area}
          mono
          value={html}
          onChange={(e) => setHtml(e.target.value)}
          spellCheck={false}
          aria-describedby="campaign-html-hint"
          className="h-80 min-w-0 resize-y text-caption"
        />
        <p id="campaign-html-hint" className="text-caption text-text-secondary">
          Name and email are filled in per recipient. An unsubscribe footer is added automatically if you don&apos;t place {"{{unsubscribe_url}}"} yourself.
        </p>
      </div>
      <div className="lg:hidden">{testField}</div>
    </div>
  );

  const previewCard = (
    <section aria-labelledby="preview-h" className="min-w-0 overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 p-4 pb-3">
        <div className="min-w-0">
          <h2 id="preview-h" className="text-h4 text-text">Preview</h2>
          <p className="text-caption text-text-secondary">With sample values for {sampleEmail}</p>
        </div>
        <Tabs variant="pill" size="sm" aria-label="Preview width" value={device} onChange={(v) => setDevice(v as "desktop" | "phone")}
          items={[{ value: "desktop", label: "Desktop" }, { value: "phone", label: "Phone" }]} />
      </div>
      <div className="flex justify-center border-t border-border bg-surface-inset p-3">
        <div className="h-[34rem] w-full overflow-hidden rounded-lg border border-border" style={{ maxWidth: device === "phone" ? 375 : undefined }}>
          <iframe
            // Sandboxed with no allow-scripts: this is pasted markup and the admin session lives
            // on this origin.
            sandbox=""
            srcDoc={sampleHtml(html, sampleEmail)}
            title={`Email preview, ${device === "phone" ? "phone width" : "desktop width"}`}
            className="h-full w-full border-0"
          />
        </div>
      </div>
    </section>
  );

  const audienceCard = (
    <section aria-labelledby="audience-h" className="min-w-0 rounded-xl border border-border bg-surface">
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="audience-h" className="text-h4 text-text">Audience</h2>
          <p className="text-body text-text-secondary" aria-live="polite">
            {count === null ? "Counting…" : <><span className="font-semibold tabular-nums text-text">{count.toLocaleString("en")}</span> {count === 1 ? "recipient" : "recipients"}</>}
          </p>
        </div>
        <RadioGroup name="campaign-audience" aria-labelledby="audience-h" value={audience} onChange={(v) => setAudience(v as Audience)}
          options={AUDIENCES.map((a) => ({ value: a.id, label: a.label, description: a.hint }))} />
        {audience === "recent" && (
          <Field label="Joined in the last (days)">
            <Input type="number" min={1} max={3650} value={recentDays} className="max-w-32"
              onChange={(e) => setRecentDays(Math.max(1, Number(e.target.value) || 1))} />
          </Field>
        )}
        {audience === "custom" && <RecipientPicker token={token} value={picked} onChange={setPicked} />}
        {sample.length > 0 && (
          <p className="break-words text-caption text-text-secondary">
            For example {sample.join(", ")}
            {count && count > sample.length ? ` and ${(count - sample.length).toLocaleString("en")} more` : ""}
          </p>
        )}
      </div>
    </section>
  );

  const historyCols: Column<CampaignItem>[] = [
    { key: "subject", header: "Subject", primary: true, render: (c) => <span className="block max-w-72 truncate" title={c.subject}>{c.subject}</span> },
    { key: "audience", header: "Audience", render: (c) => AUDIENCE_LABEL[c.audience] ?? c.audience },
    { key: "status", header: "Status", render: (c) => {
      const s = STATUS[c.status] ?? { tone: "neutral" as const, label: c.status, icon: "info" };
      return (
        <span className="flex min-w-36 flex-col gap-1.5">
          <Badge size="sm" tone={s.tone} icon={s.icon} className="self-start">{s.label}</Badge>
          {(c.status === "sending" || c.status === "queued") && (
            <Progress size="sm" value={c.sent} max={Math.max(1, c.total)} aria-label={`Progress of ${c.subject}`}
              valueText={`${c.sent} of ${c.total} sent`} />
          )}
        </span>
      );
    } },
    { key: "sent", header: "Sent", render: (c) => <span className="whitespace-nowrap tabular-nums">{c.sent.toLocaleString("en")} of {c.total.toLocaleString("en")} · {fmtDate(c.finished_at ?? c.created_at)}</span> },
    { key: "failed", header: "Failed", align: "right", render: (c) => (c.failed ? <span className="text-danger">{c.failed}</span> : "0") },
  ];

  return (
    <div className="flex flex-col gap-6 pb-24 lg:pb-0">
      <PageHead title="Email" caption="Campaigns to Markdrop accounts. Every send shows the rendered email for real recipients first." />

      <div className="lg:hidden">
        <Tabs aria-label="Campaign" value={pane} onChange={(v) => setPane(v as typeof pane)}
          items={[{ value: "compose", label: "Compose" }, { value: "preview", label: "Preview" }, { value: "audience", label: "Audience" }]} />
      </div>

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,560px)_minmax(0,1fr)]">
        <div className={`min-w-0 ${pane === "compose" ? "" : "max-lg:hidden"}`}>{compose}</div>
        <div className={`min-w-0 ${pane === "preview" ? "" : "max-lg:hidden"}`}>{previewCard}</div>
      </div>
      <div className={`min-w-0 ${pane === "audience" ? "" : "max-lg:hidden"}`}>{audienceCard}</div>

      {/* Desktop: inline. Phone: a sticky bottom bar above the safe area. */}
      <div className="hidden flex-wrap items-end gap-2 lg:flex">{testField}{testButton}{sendButton}</div>
      <div className="fixed inset-x-0 bottom-0 z-(--z-sticky) flex gap-2 border-t border-border bg-surface px-4 pt-3 lg:hidden"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 12px)" }}>
        {testButton}{sendButton}
      </div>

      <section aria-labelledby="history-h" className="flex flex-col gap-3">
        <h2 id="history-h" className="text-h3 text-text">History</h2>
        {campaigns === null ? (
          <div className="md-skeleton h-24 rounded-xl" aria-busy="true"><span className="md-visually-hidden">Loading</span></div>
        ) : (
          <Table hover={false} columns={historyCols} rows={campaigns} rowKey={(c) => c.id} caption="Campaign history" empty="No campaigns sent yet." />
        )}
      </section>

      {preview && (
        <SendPreview
          token={token}
          subject={subject}
          html={html}
          audience={audience}
          recentDays={recentDays}
          emails={emails}
          previewEmail={preview === "test" ? testTo.trim() : undefined}
          mode={preview}
          onClose={() => setPreview(null)}
          onConfirm={preview === "test" ? handleTest : handleSend}
        />
      )}

      <ConfirmDialog
        open={!!pending}
        onClose={() => setPending(null)}
        tone="default"
        title="Replace your draft?"
        body={<p className="text-body text-text-secondary">Loading “{pending?.label}” replaces the subject and HTML you&apos;ve edited.</p>}
        confirmLabel="Replace draft"
        onConfirm={() => { if (pending) { setSubject(pending.subject); setHtml(pending.html); } setPending(null); }}
      />
    </div>
  );
}
