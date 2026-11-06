"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, EmptyState, IconButton, Input, Meter, Select, type Tone } from "@/components/ui";
import { StatTile } from "@/components/kit/StatTile";
import { DailyByFeature, type DayRow } from "../ai/charts";
import { LoadingBlock, isUnauthorized, useOnUnauthorized } from "../shared";
import { emailApi, type LogFilters, type LogRow, type LogStatus, type Tier, type Usage } from "./api";
import { Section, TimeAgo, exact, num, pct, useDebounced } from "./bits";

/**
 * Email → Usage and Email → Sent: every email Markdrop sends (sign-in codes, mentions, shares,
 * digests, campaigns…) goes through one send path (backend services/email_delivery.py) that
 * routes it to Resend or Brevo under each provider's daily limit and logs one row per recipient.
 */

export const KIND_LABEL: Record<string, string> = {
  login: "Sign-in code",
  guide_signin: "Guide sign-in link",
  welcome: "Welcome",
  invite: "Workspace invite",
  share: "Shared with you",
  access_request: "Access request",
  edit_request: "Edit request",
  access_decision: "Access decision",
  guide_access_request: "Guide access request",
  guide_access_decision: "Guide access decision",
  guide_domain: "Guide domain",
  mention: "Mention",
  signoff: "Sign-off request",
  campaign_test: "Campaign test",
  digest: "Weekly digest",
  campaign: "Campaign",
};
export const kindLabel = (k: string) => KIND_LABEL[k] ?? k;

const PROVIDER_LABEL: Record<string, string> = { resend: "Resend", brevo: "Brevo" };
const providerLabel = (p: string | null) => (p ? PROVIDER_LABEL[p] ?? p : "—");

const TIER: Record<Tier, { tone: Tone; label: string; hint: string }> = {
  auth: { tone: "info", label: "Sign-in", hint: "May use the whole daily room, and is still tried past it" },
  transactional: { tone: "neutral", label: "Transactional", hint: "Stops at 95% of the daily room; then waits for tomorrow" },
  bulk: { tone: "neutral", label: "Bulk", hint: "Stops at 80% of the daily room; then waits for tomorrow" },
};

const STATUS: Record<LogStatus, { tone: Tone; label: string; outline?: boolean }> = {
  sent: { tone: "success", label: "Sent" },
  failed: { tone: "danger", label: "Failed" },
  deferred: { tone: "warning", label: "Waiting · tomorrow" },
  over_limit: { tone: "danger", label: "Over limit", outline: true },
  skipped: { tone: "neutral", label: "Skipped", outline: true },
};

export function TierBadge({ tier }: { tier: Tier }) {
  const t = TIER[tier] ?? TIER.transactional;
  return <Badge size="sm" tone={t.tone} variant="outline" title={t.hint} className="whitespace-nowrap">{t.label}</Badge>;
}

export function LogStatusBadge({ status }: { status: LogStatus }) {
  const s = STATUS[status] ?? { tone: "neutral" as Tone, label: status };
  return <Badge size="sm" tone={s.tone} variant={s.outline ? "outline" : "soft"} className="whitespace-nowrap">{s.label}</Badge>;
}

const CHART_COLOR: Record<string, string> = { resend: "var(--chart-1)", brevo: "var(--chart-2)", failed: "var(--danger)" };
const chartColor = (k: string) => CHART_COLOR[k] ?? "var(--chart-other)";

const dayLong = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });

// ── Data ──────────────────────────────────────────────────────────────────────

export function useUsage(token: string) {
  const onUnauthorized = useOnUnauthorized();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setUsage(await emailApi.usage(token, 14));
      setError(null);
    } catch (e) {
      if (isUnauthorized(e)) onUnauthorized();
      else setError(e instanceof Error ? e.message : "Couldn't load email usage");
    }
  }, [token, onUnauthorized]);
  useEffect(() => { void reload(); }, [reload]);
  return { usage, error, reload };
}

/** Shown on every Email tab once today's sends reach 80% of the combined daily limit. */
export function LimitBanner({ usage, onOpen }: { usage: Usage | null; onOpen?: () => void }) {
  if (!usage || !usage.warn) return null;
  const { used, limit, pct: p } = usage.total;
  const hard = p >= 0.95;
  return (
    <Alert tone={hard ? "danger" : "warning"} className="mb-4"
      title={`Today's email is at ${Math.round(p * 100)}% of the daily limit (${num(used)} of ${num(limit)})`}
      actions={onOpen ? <Button size="sm" variant="secondary" onClick={onOpen}>Open usage</Button> : undefined}>
      {hard
        ? "Only sign-in codes still go out today. Everything else waits in a queue and goes after 00:00 UTC."
        : "Campaigns and digests have stopped for today (bulk mail stops at 80%); mentions, shares and requests stop at 95%. Sign-in codes always go."}
    </Alert>
  );
}

// ── Usage ─────────────────────────────────────────────────────────────────────

export function UsagePanel({ usage, error, reload, onKind }: {
  usage: Usage | null; error: string | null; reload: () => void; onKind: (kind: string) => void;
}) {
  if (error && !usage) {
    return <Alert tone="danger" title="Couldn't load email usage" actions={<Button size="sm" variant="secondary" iconLeft="refresh" onClick={reload}>Retry</Button>}>{error}</Alert>;
  }
  if (!usage) return <LoadingBlock label="Loading email usage" minHeight={320} />;

  const sent14 = usage.days.reduce((a, d) => a + Object.values(d.sent).reduce((x, y) => x + y, 0), 0);
  const failed14 = usage.days.reduce((a, d) => a + d.failed, 0);
  const providers = usage.days.reduce<string[]>((acc, d) => {
    for (const k of Object.keys(d.sent)) if (!acc.includes(k)) acc.push(k);
    return acc;
  }, usage.order.filter((p) => usage.days.some((d) => d.sent[p])));
  const features = [...providers.map((p) => ({ key: p, label: providerLabel(p) })), ...(failed14 ? [{ key: "failed", label: "Failed" }] : [])];
  const series: DayRow[] = usage.days.map((d) => {
    const counts = { ...d.sent, ...(failed14 ? { failed: d.failed } : {}) };
    return { t: d.day, by_feature: counts, requests_by_feature: counts };
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile size="md" label="Today" value={`${num(usage.total.used)} / ${num(usage.total.limit)}`} caption={`${pct(usage.total.used, usage.total.limit)} of the daily limit`} />
        <StatTile size="md" label="Sent · 14 days" value={num(sent14)} caption={`${num(failed14)} failed`} />
        <StatTile size="md" label="Waiting for tomorrow" value={num(usage.retry_waiting)} caption="queued over the limit" />
        <StatTile size="md" label="Resets" value="00:00 UTC" caption={<TimeAgo iso={usage.resets_at} />} />
      </div>

      <Section id="email-usage-today" label={`Today · ${dayLong(usage.day)} (UTC)`} title="Provider usage"
        actions={<Button size="sm" variant="ghost" iconLeft="refresh" onClick={reload}>Refresh</Button>}
        bodyClassName="flex flex-col gap-4">
        <ul className="grid gap-4 md:grid-cols-2">
          {usage.providers.map((p) => {
            const i = usage.order.indexOf(p.name);
            return (
              <li key={p.name} className="min-w-0 rounded-lg border border-border bg-surface-inset p-3">
                {p.configured ? (
                  <Meter label={<span className="inline-flex flex-wrap items-center gap-1.5">{providerLabel(p.name)}
                    {i >= 0 && <Badge size="sm" tone="neutral" variant="outline">{i === 0 ? "First" : `Fallback ${i}`}</Badge>}
                    {p.full && <Badge size="sm" tone="danger">Full</Badge>}</span>}
                    value={p.used} max={Math.max(1, p.limit)} threshold={0.8}
                    meta={<span className="tabular-nums">{num(p.used)} of {num(p.limit)}</span>}
                    valueText={`${p.used} of ${p.limit} emails today`} />
                ) : (
                  <div className="flex flex-col gap-1">
                    <span className="text-body-strong text-text">{providerLabel(p.name)} <Badge size="sm" tone="neutral" variant="outline">Off</Badge></span>
                    <span className="text-caption text-text-secondary">
                      Not configured: set <code className="font-mono">MARKDROP_{p.name.toUpperCase()}_API_KEY</code> to add its {num(p.limit)} a day.
                    </span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <Meter label="All providers" value={usage.total.used} max={Math.max(1, usage.total.limit)} threshold={0.8}
          meta={<span className="tabular-nums">{num(usage.total.used)} of {num(usage.total.limit)}</span>}
          valueText={`${usage.total.used} of ${usage.total.limit} emails today`} />
        <p className="text-caption text-text-secondary">
          Bulk mail (campaigns, digests) stops at {num(usage.caps.bulk.limit)}, transactional mail (mentions, shares,
          requests) at {num(usage.caps.transactional.limit)}; sign-in codes may use all {num(usage.total.limit)} and are
          still tried past it. A provider error falls back to the next provider in order.
        </p>
      </Section>

      <Section id="email-usage-days" label="Last 14 days (UTC)" title="Sent per provider" bodyClassName="flex flex-col gap-3">
        {sent14 + failed14 === 0 ? (
          <EmptyState icon="mail" title="Nothing sent in 14 days" className="py-6" />
        ) : (
          <DailyByFeature series={series} features={features} metric="requests" colorOf={chartColor} label="Emails" />
        )}
      </Section>

      <Section id="email-usage-kinds" label="Last 14 days" title="By kind">
        {usage.by_kind.length === 0 ? (
          <EmptyState icon="mail" title="Nothing sent in 14 days" className="py-6" />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[520px] text-caption">
              <caption className="md-visually-hidden">Emails by kind</caption>
              <thead className="bg-surface-inset text-text-secondary">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-medium">Kind</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">Priority</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Sent</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Failed</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Waiting / over</th>
                </tr>
              </thead>
              <tbody>
                {usage.by_kind.map((k) => (
                  <tr key={k.kind} className="border-t border-border">
                    <td className="px-3 py-2">
                      <button type="button" className="md-focus rounded-sm text-left text-text hover:underline" onClick={() => onKind(k.kind)}>
                        {kindLabel(k.kind)}
                      </button>
                    </td>
                    <td className="px-3 py-2"><TierBadge tier={k.priority} /></td>
                    <td className="px-3 py-2 text-right tabular-nums text-text">{num(k.sent)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${k.failed ? "text-danger" : "text-text-secondary"}`}>{num(k.failed)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-text-secondary">{num(k.deferred)} / {num(k.over_limit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

// ── Sent (the log) ────────────────────────────────────────────────────────────

const PAGE = 50;

function Details({ r }: { r: LogRow }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-micro sm:grid-cols-[max-content_minmax(0,1fr)]">
      <dt className="text-text-muted">Subject</dt><dd className="min-w-0 break-words text-text">{r.subject || "—"}</dd>
      <dt className="text-text-muted">When</dt><dd className="text-text">{exact(r.at)}{r.attempts > 1 ? ` · attempt ${r.attempts}` : ""}</dd>
      <dt className="text-text-muted">Provider</dt><dd className="min-w-0 break-all text-text">{providerLabel(r.provider)}{r.provider_message_id ? <span className="ml-1 font-mono text-text-secondary">{r.provider_message_id}</span> : null}</dd>
      {r.ref && <><dt className="text-text-muted">Ref</dt><dd className="min-w-0 break-all font-mono text-text">{r.ref}</dd></>}
      {r.error && <><dt className="text-text-muted">Error</dt><dd className="min-w-0 whitespace-pre-wrap break-words font-mono text-danger">{r.error}</dd></>}
    </dl>
  );
}

export function SentLog({ token, usage, kind, setKind }: {
  token: string; usage: Usage | null; kind: string; setKind: (k: string) => void;
}) {
  const onUnauthorized = useOnUnauthorized();
  const [status, setStatus] = useState("");
  const [provider, setProvider] = useState("");
  const [q, setQ] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const dq = useDebounced(q.trim(), 300);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ rows: LogRow[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const filters: LogFilters = { kind, status, provider, q: dq, since, until, offset, limit: PAGE };
  const key = JSON.stringify(filters);
  const load = useCallback(async () => {
    try {
      const r = await emailApi.log(token, JSON.parse(key) as LogFilters);
      setData({ rows: r.rows, total: r.total });
      setError(null);
    } catch (e) {
      if (isUnauthorized(e)) onUnauthorized();
      else setError(e instanceof Error ? e.message : "Couldn't load the send log");
    }
  }, [token, key, onUnauthorized]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setOffset(0); }, [kind, status, provider, dq, since, until]);

  const kinds = usage?.kinds ?? Object.keys(KIND_LABEL);
  const filtered = !!(kind || status || provider || dq || since || until);
  const total = data?.total ?? 0;
  return (
    <Section id="email-sent" label="Every email, one row per recipient (kept 90 days)"
      title={data ? `${num(total)} ${filtered ? "matching" : "emails"}` : "Sent mail"}
      actions={<>
        {filtered && <Button size="sm" variant="ghost" iconLeft="x" onClick={() => { setKind(""); setStatus(""); setProvider(""); setQ(""); setSince(""); setUntil(""); }}>Clear filters</Button>}
        <Button size="sm" variant="ghost" iconLeft="refresh" onClick={() => void load()}>Refresh</Button>
      </>}
      bodyClassName="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))]">
        <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Recipient address" aria-label="Search by recipient" prefix="search" />
        <Select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}
          options={[{ value: "", label: "All kinds" }, ...kinds.map((k) => ({ value: k, label: kindLabel(k) }))]} />
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}
          options={[{ value: "", label: "Any status" }, ...(Object.keys(STATUS) as LogStatus[]).map((s) => ({ value: s, label: STATUS[s].label }))]} />
        <Select aria-label="Provider" value={provider} onChange={(e) => setProvider(e.target.value)}
          options={[{ value: "", label: "Any provider" }, { value: "resend", label: "Resend" }, { value: "brevo", label: "Brevo" }, { value: "none", label: "None (not sent)" }]} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-caption text-text-secondary">
        <label className="inline-flex items-center gap-2">From <Input type="date" size="sm" value={since} max={until || undefined} onChange={(e) => setSince(e.target.value)} aria-label="From date (UTC)" className="w-40" /></label>
        <label className="inline-flex items-center gap-2">to <Input type="date" size="sm" value={until} min={since || undefined} onChange={(e) => setUntil(e.target.value)} aria-label="To date (UTC)" className="w-40" /></label>
        <span>UTC</span>
      </div>

      {error ? <Alert tone="danger" title="Couldn't load the send log">{error}</Alert> : !data ? <LoadingBlock label="Loading sent mail" minHeight={200} /> : data.rows.length === 0 ? (
        <EmptyState icon="mail" title={filtered ? "No email matches these filters" : "No email sent yet"} className="py-6" />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
            <table className="w-full min-w-[720px] text-caption">
              <caption className="md-visually-hidden">Sent mail</caption>
              <thead className="bg-surface-inset text-text-secondary">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-medium">When</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">Recipient · subject</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">Kind</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">Provider</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">Status</th>
                  <th scope="col" className="px-3 py-2"><span className="md-visually-hidden">Details</span></th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <LogTableRow key={r.id} r={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />
                ))}
              </tbody>
            </table>
          </div>
          {/* Phone list */}
          <ul className="flex flex-col gap-2 md:hidden" aria-label="Sent mail">
            {data.rows.map((r) => (
              <li key={r.id} className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-border bg-surface p-3">
                <div className="flex min-w-0 items-start justify-between gap-2">
                  <span className="min-w-0 truncate text-body-strong text-text">{r.to}</span>
                  <LogStatusBadge status={r.status} />
                </div>
                <span className="truncate text-caption text-text-secondary">{r.subject || "(no subject)"}</span>
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-text-secondary">
                  <span>{kindLabel(r.kind)}</span><span>{providerLabel(r.provider)}</span><TimeAgo iso={r.at} />
                </p>
                <Button size="sm" variant="ghost" className="self-start" aria-expanded={open === r.id}
                  iconRight={open === r.id ? "chevronUp" : "chevronDown"} onClick={() => setOpen(open === r.id ? null : r.id)}>
                  {r.error ? "Error details" : "Details"}
                </Button>
                {open === r.id && <Details r={r} />}
              </li>
            ))}
          </ul>
        </>
      )}
      {data && total > PAGE && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-caption tabular-nums text-text-secondary">{num(offset + 1)}–{num(Math.min(offset + PAGE, total))} of {num(total)}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" iconLeft="chevronLeft" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - PAGE))}>Previous</Button>
            <Button size="sm" variant="secondary" iconRight="chevronRight" disabled={offset + PAGE >= total} onClick={() => setOffset((o) => o + PAGE)}>Next</Button>
          </div>
        </div>
      )}
    </Section>
  );
}

function LogTableRow({ r, open, onToggle }: { r: LogRow; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="cursor-pointer border-t border-border align-top hover:bg-surface-hover"
        onClick={(e) => { if (!(e.target as HTMLElement).closest("a,button")) onToggle(); }}>
        <td className="whitespace-nowrap px-3 py-2 text-text-secondary"><TimeAgo iso={r.at} /></td>
        <td className="max-w-[20rem] px-3 py-2">
          <span className="block truncate text-text">{r.to}</span>
          <span className="block truncate text-micro text-text-secondary">{r.subject || "(no subject)"}</span>
        </td>
        <td className="px-3 py-2"><span className="flex flex-col items-start gap-1"><span className="text-text">{kindLabel(r.kind)}</span><TierBadge tier={r.priority} /></span></td>
        <td className="whitespace-nowrap px-3 py-2 text-text">{providerLabel(r.provider)}</td>
        <td className="px-3 py-2">
          <span className="flex flex-col items-start gap-1">
            <LogStatusBadge status={r.status} />
            {r.error && <span className="block max-w-[14rem] truncate font-mono text-micro text-text-secondary">{r.error}</span>}
          </span>
        </td>
        <td className="px-3 py-2 text-right">
          <IconButton size="sm" label={open ? "Hide details" : "Show details"} aria-expanded={open}
            icon={open ? "chevronUp" : "chevronDown"} onClick={onToggle} />
        </td>
      </tr>
      {open && (
        <tr className="bg-surface-inset">
          <td colSpan={6} className="px-3 py-3"><Details r={r} /></td>
        </tr>
      )}
    </>
  );
}
