"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, ConfirmDialog, Field, Input, Tabs, useToast } from "@/components/ui";
import { LoadingBlock, PageHead, fmtDate, isUnauthorized, useOnUnauthorized } from "../shared";
import {
  draftFromTemplate, draftOf, emailApi, type Campaign, type CampaignSummary, type Draft, type Info,
  type RecipientPreview, type Rendered, type TemplatesResponse,
} from "./api";
import AudiencePicker from "./Audience";
import { CampaignBadge, Facts, Section, audienceLabel, exact, useDebounced, usePoll } from "./bits";
import Composer, { Problems, type Update } from "./Composer";
import type { Navigate } from "./EmailSection";
import { ConsoleBanner } from "./Home";
import { EmailPreview, RecipientPicker, ScaledFrame } from "./Preview";
import Report from "./Report";
import SendPanel from "./SendPanel";

const DRAFT_TABS = [
  { value: "compose", label: "1 · Compose" },
  { value: "audience", label: "2 · Audience" },
  { value: "preview", label: "3 · Preview & test" },
  { value: "send", label: "4 · Send" },
];
const SENT_TABS = [
  { value: "report", label: "Report" },
  { value: "send", label: "Send" },
  { value: "content", label: "Content" },
];

/** The server render of the current draft, debounced, keeping the last good result while updating. */
function useRender(token: string, draft: Draft | null, asEmail: string | null, ms: number) {
  const onUnauthorized = useOnUnauthorized();
  const key = draft ? JSON.stringify([draft, asEmail]) : "";
  const dkey = useDebounced(key, ms);
  const [data, setData] = useState<Rendered | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!dkey) return;
    let cancelled = false;
    const [d, as] = JSON.parse(dkey) as [Draft, string | null];
    setLoading(true);
    emailApi.render(token, d, as)
      .then((r) => { if (!cancelled) { setData(r); setError(null); } })
      .catch((e) => { if (isUnauthorized(e)) onUnauthorized(); else if (!cancelled) setError(e instanceof Error ? e.message : "Render failed"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, dkey, nonce, onUnauthorized]);
  return { data, error, loading: loading || dkey !== key, retry: useCallback(() => setNonce((n) => n + 1), []) };
}

function TestSend({ token, draft, problems, as, info }: {
  token: string; draft: Draft; problems: number; as: RecipientPreview | null; info: Info | null;
}) {
  const toast = useToast();
  const onUnauthorized = useOnUnauthorized();
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  const me = info?.setup.test_to ?? "you";
  const console_ = info?.setup.transport === "console";
  return (
    <Section id="email-test" label="Test send" title="Send a [test] copy" bodyClassName="flex flex-col gap-3">
      <p className="text-body text-text-secondary">
        Goes to {me} or the address below, with the subject prefixed “[test]”, merge tags filled with{" "}
        {as ? <strong className="text-text">{as.name || as.email}</strong> : "the address's own"} data. Nothing is logged; its tracking and
        unsubscribe links use the ignored “test” token.
      </p>
      <Field label="To (optional)">
        <Input type="email" value={to} placeholder={me} onChange={(e) => setTo(e.target.value)} autoComplete="off" />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button iconLeft="mail" variant="secondary" loading={busy} disabled={problems > 0} onClick={async () => {
          setBusy(true);
          try {
            const r = await emailApi.test(token, draft, to.trim() || undefined, as?.email ?? null);
            setLast(r.mode === "console"
              ? `Rendered to the server console (not emailed) · to ${r.to} as ${r.as}`
              : `Test sent to ${r.to} (as ${r.as}) · “${r.subject}”`);
            toast.success(r.mode === "console" ? "Test rendered (console transport)" : `Test sent to ${r.to}`);
          } catch (e) {
            if (isUnauthorized(e)) onUnauthorized();
            else toast.error(`Test failed: ${e instanceof Error ? e.message : "request failed"}`);
          } finally { setBusy(false); }
        }}>Send test{console_ ? " (console)" : ""}</Button>
        {problems > 0 && <span className="text-caption text-danger">Fix {problems} problem{problems === 1 ? "" : "s"} in compose first.</span>}
      </div>
      {last && <p className="break-words font-mono text-micro text-text-secondary" role="status">{last}</p>}
    </Section>
  );
}

function Checklist({ problems, draft, info, rendered }: { problems: number; draft: Draft; info: Info | null; rendered: Rendered | null }) {
  const sender = info?.senders.find((s) => s.id === draft.sender_id) ?? info?.senders.find((s) => s.is_default);
  const usesName = /\{\{\s*first_name\s*\}\}|\{\{\s*name\s*\}\}/.test(draft.subject);
  const items: { ok: boolean | null; text: string }[] = [
    { ok: problems === 0, text: problems === 0 ? "Merge tags and links are valid" : `${problems} problem${problems === 1 ? "" : "s"} to fix` },
    { ok: !usesName || !!draft.subject_fallback?.trim() ? true : null, text: usesName ? (draft.subject_fallback?.trim() ? "Subject fallback set for people without a name" : "No subject fallback: nameless people get the subject without the name") : "Subject doesn't depend on a name" },
    { ok: sender ? (sender.check.level === "ok" ? true : sender.check.level === "warn" ? null : false) : false, text: sender ? `Sender ${sender.check.level === "ok" ? "identity verified" : sender.check.message}` : "No sender" },
    { ok: !!rendered?.html.includes(rendered.unsubscribe_url), text: "Unsubscribe link and one-click List-Unsubscribe header" },
    { ok: !!rendered?.text.trim(), text: "Plain-text version" },
  ];
  return (
    <Alert tone={items.some((i) => i.ok === false) ? "warning" : "success"} title="Checklist">
      <ul className="flex flex-col gap-1">
        {items.map((i) => (
          <li key={i.text} className="break-words">
            <span aria-hidden className="mr-1.5 font-mono">{i.ok === true ? "✓" : i.ok === false ? "✗" : "!"}</span>
            <span className="md-visually-hidden">{i.ok === true ? "Done: " : i.ok === false ? "Problem: " : "Note: "}</span>
            {i.text}
          </li>
        ))}
      </ul>
    </Alert>
  );
}

export default function CampaignPage({
  token, id, templateId, tab, info, meta, metaError, reloadMeta, navigate, refreshInfo,
}: {
  token: string; id: string; templateId: string | null; tab: string | null; info: Info | null;
  meta: TemplatesResponse | null; metaError: string | null; reloadMeta: () => void; navigate: Navigate; refreshInfo: () => void;
}) {
  const toast = useToast();
  const onUnauthorized = useOnUnauthorized();
  const isNew = id === "new";
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [loadError, setLoadError] = useState<{ status: number; message: string } | null>(null);
  const [edits, setEdits] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [as, setAs] = useState<RecipientPreview | null>(null);
  const [del, setDel] = useState(false);
  const [dupBusy, setDupBusy] = useState(false);

  const load = useCallback(async () => {
    if (isNew) return;
    try {
      const r = await emailApi.get(token, id);
      setCampaign(r.campaign);
      setLoadError(null);
    } catch (e) {
      if (isUnauthorized(e)) onUnauthorized();
      else setLoadError({ status: (e as { status?: number }).status ?? 0, message: e instanceof Error ? e.message : "Request failed" });
    }
  }, [isNew, id, token, onUnauthorized]);
  useEffect(() => { void load(); }, [load]);

  const template = useMemo(() => {
    const tid = isNew ? (templateId || "newsletter") : campaign?.template;
    return meta?.templates.find((t) => t.id === tid) ?? null;
  }, [meta, isNew, templateId, campaign?.template]);

  const defaultSender = info?.senders.find((s) => s.is_default)?.id ?? null;
  const base: Draft | null = useMemo(() => {
    if (isNew) return template ? draftFromTemplate(template, defaultSender) : null;
    return campaign && !campaign.legacy ? draftOf(campaign) : null;
  }, [isNew, template, defaultSender, campaign]);
  const draft = edits ?? base;
  const status = isNew ? "draft" : campaign?.status ?? "draft";
  const isDraft = status === "draft";
  const legacy = !!campaign?.legacy;
  const dirty = isNew || edits !== null;

  const update: Update = useCallback((fn) => setEdits((e) => {
    const cur = e ?? base;
    return cur ? fn(cur) : e;
  }), [base]);

  const render = useRender(token, draft, as?.email ?? null, 300);
  const problems = render.data?.problems ?? [];

  // Unsaved edits: warn before leaving the page.
  useEffect(() => {
    if (!edits) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [edits]);

  // Non-drafts refresh every 15 s (the send panel and report poll faster while sending).
  usePoll(load, 15_000, !isNew && !isDraft && !legacy);

  const tabs = legacy ? [{ value: "content", label: "Content" }] : isDraft ? DRAFT_TABS : SENT_TABS;
  const current = tabs.some((t) => t.value === tab) ? tab! : tabs[0]!.value;

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      if (isNew) {
        const r = await emailApi.create(token, draft);
        toast.success("Draft saved");
        refreshInfo();
        navigate({ campaign: r.campaign.id, template: null, ct: current }, { replace: true });
        return;
      }
      const r = await emailApi.update(token, id, draft);
      setCampaign(r.campaign);
      setEdits(null);
      refreshInfo();
      toast.success("Draft saved");
    } catch (e) {
      if (isUnauthorized(e)) onUnauthorized();
      else toast.error(`Couldn't save: ${e instanceof Error ? e.message : "request failed"}`);
    } finally {
      setSaving(false);
    }
  };

  const onCampaign = useCallback((s: CampaignSummary) => {
    setCampaign((c) => (c ? { ...c, ...s } : c));
    if (s.status !== "draft") setEdits(null);
  }, []);

  const duplicate = async () => {
    setDupBusy(true);
    try {
      const r = await emailApi.duplicate(token, id);
      refreshInfo();
      toast.success("Duplicated as a new draft");
      navigate({ campaign: r.campaign.id, ct: "compose", template: null });
    } catch (e) {
      if (isUnauthorized(e)) onUnauthorized();
      else toast.error(`Couldn't duplicate: ${e instanceof Error ? e.message : "request failed"}`);
    } finally { setDupBusy(false); }
  };

  const back = (
    <Button variant="ghost" iconLeft="arrowLeft" href="/admin?tab=email" onClick={(e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate({ campaign: null, ct: null, template: null });
    }}>Campaigns</Button>
  );

  if (loadError) {
    return (
      <>
        <PageHead title={loadError.status === 404 ? "Campaign not found" : "Couldn't load this campaign"} actions={back} />
        <Alert tone="danger" actions={<Button size="sm" variant="secondary" iconLeft="refresh" onClick={() => void load()}>Retry</Button>}>{loadError.message}</Alert>
      </>
    );
  }
  if (metaError && !meta) {
    return (
      <>
        <PageHead title="Campaign" actions={back} />
        <Alert tone="danger" title="Couldn't load templates" actions={<Button size="sm" variant="secondary" iconLeft="refresh" onClick={reloadMeta}>Retry</Button>}>{metaError}</Alert>
      </>
    );
  }
  if ((!isNew && !campaign) || !meta || (!legacy && !draft)) {
    return (
      <LoadingBlock size="md" label="Loading the campaign" minHeight={520} />
    );
  }

  const name = (legacy ? campaign!.name : draft!.name) || "Untitled campaign";
  const caption = (
    <span className="flex flex-wrap items-center gap-2">
      <CampaignBadge status={status} legacy={legacy} />
      <span>
        {isNew
          ? `From template · ${template?.name ?? "—"}`
          : `Created ${fmtDate(campaign!.created_at)}${campaign!.created_by ? ` · ${campaign!.created_by}` : ""}`}
      </span>
    </span>
  );
  const canDelete = !isNew && !legacy && (status === "draft" || status === "cancelled");
  const site = info?.setup.site ?? "https://markdrop.in";

  const preview = (compact: boolean, label?: string, children?: React.ReactNode) => (
    <EmailPreview
      rendered={render.data}
      loading={render.loading}
      error={render.error}
      compact={compact}
      tags={meta.tags}
      layout={draft!.doc.layout}
      label={label}
      onRetry={render.retry}
    >
      {children}
    </EmailPreview>
  );

  return (
    <>
      <PageHead
        title={<span className="break-words">{name}</span>}
        caption={caption}
        actions={
          <>
            {back}
            {(!isDraft || legacy) && <Button variant="secondary" iconLeft="copy" loading={dupBusy} onClick={duplicate}>Duplicate</Button>}
            {canDelete && <Button variant="ghost" iconLeft="trash" onClick={() => setDel(true)}>Delete</Button>}
            {isDraft && !legacy && (
              <Button iconLeft="check" loading={saving} disabled={!dirty || saving} onClick={() => void save()}>
                {saving ? "Saving…" : dirty ? "Save draft" : "Saved"}
              </Button>
            )}
          </>
        }
      />
      <ConsoleBanner info={info} />
      <div className="-mx-1 mb-5 overflow-x-auto px-1">
        <Tabs
          aria-label="Campaign"
          idPrefix="email-ct"
          value={current}
          onChange={(v) => navigate({ ct: v }, { replace: true })}
          items={tabs}
        />
      </div>

      <div role="tabpanel" id={`email-ct-panel-${current}`} aria-labelledby={`email-ct-tab-${current}`} className="min-w-0">
        {legacy ? (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
            <Section id="email-legacy" label="Legacy campaign" title="Sent with the old emailer">
              <Facts items={[
                { label: "Subject", value: campaign!.subject },
                { label: "From", value: campaign!.sender?.from_email ?? "—" },
                { label: "Audience", value: audienceLabel(campaign!.audience) },
                { label: "Sent", value: `${campaign!.counts.sent} of ${campaign!.counts.total}${campaign!.counts.failed ? ` · ${campaign!.counts.failed} failed` : ""}` },
                { label: "Finished", value: exact(campaign!.finished_at) || "—" },
              ]} />
              <p className="mt-3 text-caption text-text-secondary">The old emailer kept no per-recipient tracking. Duplicate it to send the same HTML with the new tracking and merge tags.</p>
            </Section>
            <Section id="email-legacy-html" label="Content" title="What was sent">
              {campaign!.legacy_html ? <ScaledFrame html={campaign!.legacy_html} frameWidth={640} height={1100} title="Legacy campaign content" /> : <p className="text-body text-text-secondary">No content stored.</p>}
            </Section>
          </div>
        ) : current === "compose" ? (
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Composer draft={draft!} update={update} senders={info?.senders ?? []} problems={problems} template={template} meta={meta} site={site} />
            <div className="hidden min-w-0 xl:block">
              <div className="sticky top-4">{preview(true)}</div>
            </div>
          </div>
        ) : current === "audience" ? (
          <AudiencePicker token={token} spec={draft!.audience} campaignId={isNew ? null : id}
            onChange={(a) => update((d) => ({ ...d, audience: a }))} />
        ) : current === "preview" ? (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
            {preview(false, "3 · Preview", <RecipientPicker token={token} as={as} setAs={setAs} />)}
            <div className="flex min-w-0 flex-col gap-4">
              <Problems problems={problems} />
              <TestSend token={token} draft={draft!} problems={problems.length} as={as} info={info} />
              <Checklist problems={problems.length} draft={draft!} info={info} rendered={render.data} />
            </div>
          </div>
        ) : current === "send" ? (
          <SendPanel token={token} campaign={isNew ? null : campaign} draft={draft!} dirty={dirty} problems={problems} info={info}
            onSave={save} onCampaign={(s) => { onCampaign(s); if (s.status !== campaign?.status) refreshInfo(); }} />
        ) : current === "report" ? (
          <Report token={token} campaign={campaign!} />
        ) : (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <div className="flex min-w-0 flex-col gap-4">
              <Section id="email-what" label="Content" title="What was sent">
                <p className="mb-3 text-body text-text-secondary">Sent campaigns are read-only. Duplicate it to send a changed version to a new audience.</p>
                <Facts items={[
                  { label: "Subject", value: draft!.subject },
                  ...(draft!.subject_fallback ? [{ label: "No-name subject", value: draft!.subject_fallback }] : []),
                  { label: "From", value: campaign!.sender?.from_email ? `${campaign!.sender.from_name ?? ""} <${campaign!.sender.from_email}>` : "—" },
                  { label: "Audience", value: audienceLabel(campaign!.audience) },
                  { label: "Template", value: template?.name ?? campaign!.template ?? "—" },
                  { label: "Tracking", value: [draft!.track_opens && "opens", draft!.track_clicks && "clicks"].filter(Boolean).join(" + ") || "off" },
                  { label: "Queued", value: exact(campaign!.queued_at) || "—" },
                  { label: "Finished", value: exact(campaign!.finished_at) || "—" },
                ]} />
              </Section>
              <Section id="email-pick" label="Preview as" title="Pick a recipient">
                <RecipientPicker token={token} as={as} setAs={setAs} />
              </Section>
            </div>
            {preview(true, "Content")}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={del}
        onClose={() => setDel(false)}
        title="Delete this campaign?"
        body={<p className="text-body text-text-secondary">“{name}” and its recipient list are deleted. This can&apos;t be undone.</p>}
        confirmLabel="Delete campaign"
        onConfirm={async () => {
          await emailApi.remove(token, id);
          setDel(false);
          setEdits(null);
          refreshInfo();
          toast.success("Campaign deleted");
          navigate({ campaign: null, ct: null, template: null });
        }}
      />
    </>
  );
}
