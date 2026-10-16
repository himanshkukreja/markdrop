"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, ConfirmDialog, Field, Input, Progress, SegmentedControl, useToast } from "@/components/ui";
import { DateTimePicker } from "@/components/kit/DateTimePicker";
import { isUnauthorized, plural, useOnUnauthorized } from "../shared";
import { emailApi, EmailApiError, type Campaign, type CampaignSummary, type Draft, type Info, type Problem } from "./api";
import { useAudienceCount } from "./Audience";
import { Facts, Section, audienceLabel, exact, num, pct, usePoll } from "./bits";

type Busy = null | "queue" | "pause" | "resume" | "retry" | "requeue" | "cancel" | "unschedule" | "send_now" | "tick" | "save";

export default function SendPanel({
  token, campaign, draft, dirty, problems, info, onSave, onCampaign,
}: {
  token: string; campaign: Campaign | null; draft: Draft; dirty: boolean; problems: Problem[]; info: Info | null;
  onSave: () => Promise<void>; onCampaign: (c: CampaignSummary) => void;
}) {
  const toast = useToast();
  const onUnauthorized = useOnUnauthorized();
  const [busy, setBusy] = useState<Busy>(null);
  const [typed, setTyped] = useState("");
  const [when, setWhen] = useState<"now" | "later">("now");
  const [at, setAt] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "cancel" | "requeue">(null);
  const [failed, setFailed] = useState<{ email: string; error: string | null }[]>([]);
  const [lease, setLease] = useState<{ held: boolean; worker: boolean } | null>(null);

  const status = campaign?.status ?? "draft";
  const live = status === "sending" || status === "scheduled";
  const counts = campaign?.counts;
  const isDraft = status === "draft";
  const audience = useAudienceCount(token, campaign?.audience ?? draft.audience, campaign?.id ?? null);
  const n = audience.data?.count.eligible ?? 0;
  const phrase = `send to ${n}`;

  const fail = useCallback((e: unknown, prefix: string) => {
    if (isUnauthorized(e)) onUnauthorized();
    else toast.error(`${prefix}: ${e instanceof Error ? e.message : "request failed"}`);
  }, [onUnauthorized, toast]);

  const poll = useCallback(async () => {
    if (!campaign) return;
    try {
      const p = await emailApi.progress(token, campaign.id);
      setLease({ held: p.lease_held, worker: p.worker });
      onCampaign(p.campaign);
    } catch (e) {
      if (isUnauthorized(e)) onUnauthorized();
    }
  }, [campaign, token, onCampaign, onUnauthorized]);
  usePoll(poll, 2000, live);
  useEffect(() => { if (live) void poll(); }, [live]); // eslint-disable-line react-hooks/exhaustive-deps

  const failedCount = counts?.failed ?? 0;
  useEffect(() => {
    if (!campaign || !failedCount) { setFailed([]); return; }
    emailApi.messages(token, campaign.id, { filter: "failed", limit: 50 })
      .then((r) => setFailed(r.rows.map((m) => ({ email: m.email, error: m.error }))))
      .catch(() => {});
  }, [campaign?.id, failedCount, token]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!campaign) {
    return (
      <Section id="email-send" label="4 · Send" title="Save the campaign to send it">
        <p className="mb-3 text-body text-text-secondary">Sending works from a saved campaign, so progress and tracking survive reloads and restarts.</p>
        <Button iconLeft="check" loading={busy === "save"} onClick={async () => { setBusy("save"); try { await onSave(); } finally { setBusy(null); } }}>Save draft</Button>
      </Section>
    );
  }

  const act = async (b: Busy, fn: () => Promise<{ campaign: CampaignSummary }>, ok: (r: { campaign: CampaignSummary } & Record<string, unknown>) => string) => {
    setBusy(b);
    try {
      const r = await fn();
      onCampaign(r.campaign);
      toast.success(ok(r as { campaign: CampaignSummary } & Record<string, unknown>));
      audience.refresh();
    } catch (e) {
      fail(e, "Couldn't do that");
    } finally {
      setBusy(null);
    }
  };

  const queue = async () => {
    setBusy("queue");
    try {
      const iso = isDraft && when === "later" ? at : null;
      const r = await emailApi.queue(token, campaign.id, typed, iso);
      onCampaign(r.campaign);
      setTyped("");
      toast.success(iso ? `Scheduled ${plural(r.added, "recipient")} for ${exact(iso)}` : `Queued ${plural(r.added, "recipient")}`);
      audience.refresh();
    } catch (e) {
      if (e instanceof EmailApiError && e.expected) {
        audience.refresh();
        toast.error(`The audience changed: type “${e.expected}” to confirm.`);
      } else fail(e, "Couldn't queue");
    } finally {
      setBusy(null);
    }
  };

  const sender = campaign.sender?.from_email
    ? campaign.sender
    : info?.senders.find((s) => s.id === draft.sender_id) ?? info?.senders.find((s) => s.is_default);
  const done = counts ? counts.sent + counts.failed + counts.skipped : 0;
  const transport = info?.setup.transport;
  const canQueue = status !== "cancelled" && status !== "scheduled" && (isDraft || n > 0);
  const typedOk = typed.trim().toLowerCase() === phrase;
  const laterOk = when === "now" || !isDraft || (!!at && new Date(at).getTime() > Date.now() + 60_000);
  const block = dirty ? "Save the draft first" : problems.length ? "Fix the problems in compose first" : n === 0 ? "Nobody new to send to" : !typedOk ? `Type “${phrase}” to unlock` : !laterOk ? "Pick a time at least a minute from now" : null;

  let stateText = "";
  if (status === "sending") stateText = lease?.held ? "Sending…" : lease && !lease.worker ? "Waiting · the background sender is off" : "Sending…";
  else if (status === "scheduled") stateText = `Scheduled for ${exact(campaign.scheduled_at)}`;
  else stateText = status.charAt(0).toUpperCase() + status.slice(1);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Section
        id="email-send"
        label={isDraft ? "4 · Send for real" : "Send · progress"}
        title={campaign.name}
        actions={transport === "console" ? <Badge tone="warning" icon="alert">Console · nothing is emailed</Badge> : transport === "resend" ? <Badge tone="success">Live · Resend</Badge> : undefined}
        bodyClassName="flex flex-col gap-4"
      >
        <Facts items={[
          { label: "From", value: sender ? `${sender.from_name ? `${sender.from_name} ` : ""}<${sender.from_email}>` : "—" },
          { label: "Reply-to", value: sender?.reply_to || info?.setup.test_to || "—" },
          { label: "Pace", value: info ? `${info.setup.batch.size} per Resend batch, one batch every ${(info.setup.batch.gap_ms / 1000).toFixed(1)} s, sent by the server` : "—" },
          { label: "Audience", value: `${audienceLabel(campaign.audience)} · ${audience.loading && !audience.data ? "counting…" : `${num(n)} ${isDraft ? "eligible" : "new"}`}` },
          ...(campaign.scheduled_at && status === "scheduled" ? [{ label: "Sends at", value: exact(campaign.scheduled_at) }] : []),
        ]} />

        {counts && counts.total > 0 && (
          <div aria-live="polite" className="flex flex-col gap-2">
            <Progress
              label={stateText}
              meta={<span className="tabular-nums">{num(done)}/{num(counts.total)}</span>}
              value={done}
              max={Math.max(1, counts.total)}
              tone={status === "paused" && campaign.last_error ? "danger" : status === "sent" ? "success" : "accent"}
              valueText={`${done} of ${counts.total} processed`}
            />
            <p className="flex flex-wrap gap-x-3 gap-y-1 text-caption text-text-secondary">
              <span><strong className="text-text tabular-nums">{num(counts.sent)}</strong> sent</span>
              <span className={counts.failed ? "text-danger" : undefined}><strong className="tabular-nums">{num(counts.failed)}</strong> failed</span>
              <span className="tabular-nums">{num(counts.skipped)} skipped</span>
              {counts.sending > 0 && <span className="tabular-nums">{num(counts.sending)} in flight</span>}
              <span className="tabular-nums">{num(counts.queued)} queued</span>
              <span className="tabular-nums">{pct(counts.opened, counts.sent)} opened</span>
            </p>
          </div>
        )}

        {status === "paused" && campaign.last_error && (
          <Alert tone="danger" title="Paused by the server">
            {campaign.last_error} Fix the sender or the provider, then resume. Rows that weren&apos;t sent stay queued.
          </Alert>
        )}
        {status === "sending" && campaign.last_error && (
          <Alert tone="warning" title="Retrying">{campaign.last_error} The server backs off and retries; five failures in a row pause the campaign.</Alert>
        )}
        {status === "sending" && lease && !lease.worker && !lease.held && (
          <Alert tone="info" title="The background sender is off on this server" actions={
            <Button size="sm" variant="secondary" iconLeft="play" loading={busy === "tick"} onClick={async () => {
              setBusy("tick");
              try {
                const r = await emailApi.tick(token, campaign.id);
                if (r.campaign) onCampaign(r.campaign);
                toast.info(r.busy ? "Another sender is working on this campaign" : `Sent ${num(r.sent_now)} in this round`);
              } catch (e) { fail(e, "Round failed"); } finally { setBusy(null); }
            }}>Send a round now</Button>
          }>MARKDROP_EMAIL_WORKER_ENABLED is false, so rounds only run when you ask.</Alert>
        )}

        {(status !== "draft" && status !== "cancelled") && (
          <div className="flex flex-wrap gap-2">
            {status === "sending" && (
              <Button variant="secondary" iconLeft="pause" loading={busy === "pause"} onClick={() => act("pause", () => emailApi.action(token, campaign.id, "pause"), () => "Paused after the batch in flight")}>Pause after this batch</Button>
            )}
            {status === "paused" && (
              <Button iconLeft="play" loading={busy === "resume"} onClick={() => act("resume", () => emailApi.action(token, campaign.id, "resume"), () => "Resumed")}>Resume</Button>
            )}
            {status === "scheduled" && (
              <>
                <Button iconLeft="send" loading={busy === "send_now"} onClick={() => act("send_now", () => emailApi.action(token, campaign.id, "send_now"), () => "Sending now")}>Send now instead</Button>
                <Button variant="secondary" iconLeft="calendar" loading={busy === "unschedule"} onClick={() => act("unschedule", () => emailApi.action(token, campaign.id, "unschedule"), () => "Unscheduled: back to a draft")}>Unschedule and edit</Button>
              </>
            )}
            {failedCount > 0 && status !== "scheduled" && (
              <Button variant="secondary" iconLeft="refresh" loading={busy === "retry"} onClick={() => act("retry", () => emailApi.action(token, campaign.id, "retry", { failed: true }), (r) => `Re-queued ${plural(Number(r.requeued ?? 0), "failed recipient")}`)}>
                Retry {num(failedCount)} failed
              </Button>
            )}
            {(counts?.stuck ?? 0) > 0 && (
              <Button variant="secondary" iconLeft="rotate" onClick={() => setConfirm("requeue")}>Re-queue {num(counts!.stuck)} interrupted</Button>
            )}
            {(status === "sending" || status === "paused" || status === "scheduled") && (
              <Button variant="danger" iconLeft="x" onClick={() => setConfirm("cancel")}>Cancel campaign</Button>
            )}
          </div>
        )}
      </Section>

      {canQueue && (
        <Section
          id="email-confirm"
          label={isDraft ? "Confirm" : "Top up"}
          title={isDraft ? "Typed confirmation" : `${plural(n, "new person", "new people")} match this audience`}
          bodyClassName="flex flex-col gap-4"
        >
          {!isDraft && <p className="text-body text-text-secondary">Sends only to people who aren&apos;t in this campaign yet. Everyone already sent stays untouched.</p>}
          {dirty && <Alert tone="warning" title="Unsaved changes">Save the draft before sending, so the queued email matches what you see.</Alert>}
          {problems.length > 0 && <Alert tone="danger" title="Fix the problems in compose first">{plural(problems.length, "problem")} would block the send.</Alert>}
          {transport === "resend" && (
            <Alert tone="warning" title="This is real">
              Every address gets a real email from {sender?.from_email ?? "the sender"}. Unsubscribes and suppressions are re-checked before each batch.
            </Alert>
          )}
          {isDraft && (
            <div className="flex flex-col gap-3">
              <SegmentedControl<"now" | "later">
                aria-label="When to send"
                value={when}
                onChange={setWhen}
                options={[{ value: "now", label: "Send now", icon: "send" }, { value: "later", label: "Schedule", icon: "calendar" }]}
              />
              {when === "later" && (
                <DateTimePicker
                  value={at}
                  onChange={setAt}
                  min={new Date(Date.now() + 5 * 60_000)}
                  max={new Date(Date.now() + 365 * 86_400_000)}
                  presets={[{ label: "Tomorrow", days: 1 }, { label: "In 3 days", days: 3 }, { label: "Next week", days: 7 }]}
                  label="Send date and time"
                  hint="Recipients are fixed now; anyone who unsubscribes before then is still skipped."
                />
              )}
            </div>
          )}
          <Field label={<>Type <strong className="font-mono">{phrase}</strong> to unlock</>}>
            <Input mono value={typed} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder={phrase}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !block) { e.preventDefault(); void queue(); } }} />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button iconLeft={when === "later" && isDraft ? "calendar" : "send"} loading={busy === "queue"} disabled={!!block} onClick={() => void queue()}>
              {when === "later" && isDraft ? `Schedule for ${num(n)}` : `Send to ${num(n)}`}
            </Button>
            {block && <span className="text-caption text-text-secondary">{block}</span>}
          </div>
        </Section>
      )}

      {failed.length > 0 && (
        <Section id="email-failed" label="Failures" title={`${plural(failedCount, "address", "addresses")} failed`}>
          <ul className="md-focus flex max-h-56 flex-col overflow-y-auto rounded-lg border border-border" tabIndex={0} aria-label="Failed addresses">
            {failed.map((f) => (
              <li key={f.email} className="border-b border-border px-3 py-1.5 font-mono text-micro last:border-0">
                <span className="break-all text-text">{f.email}</span> <span className="text-text-secondary">· {f.error}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <ConfirmDialog
        open={confirm === "cancel"}
        onClose={() => setConfirm(null)}
        title="Cancel this campaign?"
        body={<p className="text-body text-text-secondary">Nothing else will be sent: {plural(counts?.queued ?? 0, "queued recipient")} will be skipped. People who already got it keep it, and its report stays.</p>}
        confirmLabel="Cancel campaign"
        cancelLabel="Keep it"
        onConfirm={async () => {
          const r = await emailApi.action(token, campaign.id, "cancel");
          onCampaign(r.campaign);
          setConfirm(null);
          toast.success("Campaign cancelled; nothing else will be sent");
        }}
      />
      <ConfirmDialog
        open={confirm === "requeue"}
        onClose={() => setConfirm(null)}
        tone="default"
        title={`Re-queue ${plural(counts?.stuck ?? 0, "interrupted recipient")}?`}
        body={<p className="text-body text-text-secondary">These were mid-send more than five minutes ago and never confirmed. Some may already have the email, so re-queueing may send them a duplicate.</p>}
        confirmLabel="May duplicate · re-queue"
        onConfirm={async () => {
          const r = await emailApi.action(token, campaign.id, "retry", { failed: false, stuck: true });
          onCampaign(r.campaign);
          setConfirm(null);
          toast.success(`Re-queued ${plural(r.requeued ?? 0, "recipient")}`);
        }}
      />
    </div>
  );
}
