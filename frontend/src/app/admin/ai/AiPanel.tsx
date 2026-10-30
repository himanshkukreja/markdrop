"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { StatTile } from "@/components/kit/StatTile";
import {
  Alert, Badge, Button, Drawer, EmptyState, Input, Meter, Pagination, Progress, SegmentedControl, Select, Table,
  type Column,
} from "@/components/ui";
import { BarList } from "../analytics/sections";
import { TrendChart } from "../analytics/charts";
import { Card, CardError, CardSkeleton, CardTitle, Eyebrow } from "../analytics/ui";
import { LoadingBlock, PageHead, fmtDateTime, plural, useOnUnauthorized } from "../shared";

/**
 * Admin → AI (docs Ask AI on Claude, and any later AI feature through the same ledger).
 * Every number comes from the backend's usage ledger (`ai_requests`) and its exact spend counters;
 * nothing is estimated here. Signed-out askers appear as a short hash, never an IP.
 */

const API = process.env.NEXT_PUBLIC_API_URL || "https://api.markdrop.in";
type RangeKey = "24h" | "7d" | "30d" | "90d";
const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: "24h", label: "24 h" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }, { value: "90d", label: "90 days" },
];

// ── Types (backend/app/routers/admin_ai.py) ──────────────────────────────────

interface Tokens { input: number; output: number; thinking?: number; cache_read: number; cache_write_5m: number; cache_write_1h: number }
interface Overview {
  range: RangeKey; feature: string; truncated: boolean;
  status: { enabled: boolean; configured: boolean; model: string; effort: string; per_visitor_hour: number; max_concurrent: number; max_tool_rounds: number };
  budget: { today_usd: number; month_usd: number; all_features_today_usd: number; all_features_month_usd: number; daily_cap_usd: number; monthly_cap_usd: number };
  kpis: {
    questions: number; served: number; limited: number; people: number; signed_in_people: number; conversations: number;
    answered_pct: number | null; helpful_pct: number | null; rated: number; cost_usd: number; cost_per_answer_usd: number | null;
    tokens: Tokens; cache_hit_pct: number | null;
    ttft_ms: { p50: number | null; p95: number | null }; latency_ms: { p50: number | null; p95: number | null };
    avg_tools_per_answer: number | null; long_context_calls: number; links_removed: number;
  };
  series: { t: string; questions: number; answered: number; cost_usd: number; tokens: number }[];
  outcomes: { key: string; n: number }[];
  limit_reasons: { key: string; n: number }[];
  tools: { name: string; calls: number; errors: number; questions: number; avg_ms: number }[];
  by_model: { feature: string; model: string; requests: number; cost_usd: number; input: number; output: number; cache_read: number; cache_write: number }[];
}
interface QuestionRow { question: string; count: number; last_ts: string; outcomes: Record<string, number>; helpful: number; unhelpful: number; conversation_id: string }
interface GapRow { summary: string; question: string; count: number; reasons: Record<string, number>; thumbs_down: number; comments: string[]; details: string[]; pages: string[]; last_ts: string; conversation_id: string }
interface ConvItem {
  request_id: string; conversation_id: string; turn: number; ts: string; question: string; outcome: string; page_path: string | null;
  who: string; signed_in: boolean; cost_usd: number; tokens: { input: number; output: number; cache_read: number; cache_write: number };
  latency_ms: number | null; ttft_ms: number | null; tools: number; feedback: { helpful: boolean; comment: string | null } | null; model: string;
}
interface Turn extends ConvItem {
  answer: string; citations: { n: number; id: string; title: string; page: string; url: string }[];
  tool_calls: { name: string; args_summary: string; ms: number; result_count: number | null; error?: string | null }[];
  usage: Tokens; calls: number; effort: string; stop_reason: string | null; stop_details: { category?: string } | null;
  gaps: { summary: string; reason: string; detail?: string | null }[]; links_removed: number; error_code: string | null;
  limit_reason: string | null; long_context_calls: number; max_prompt_tokens: number | null;
}
interface PageFeedback { votes: number; up: number; down: number; helpful_pct: number | null; pages: { path: string; up: number; down: number; helpful_pct: number | null; known_page: boolean; comments: { text: string; helpful: boolean; ts: string }[] }[] }

// ── Formatting ───────────────────────────────────────────────────────────────

const n0 = (n: number | null | undefined) => (n ?? 0).toLocaleString("en");
const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n}%`);
export function usd(n: number | null | undefined) {
  if (n === null || n === undefined) return "—";
  if (n === 0) return "$0";
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
const secs = (ms: number | null | undefined) => (ms === null || ms === undefined ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
const tokensShort = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

const OUTCOME: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" | "info" }> = {
  answered: { label: "Answered", tone: "success" },
  no_answer: { label: "No answer", tone: "warning" },
  off_topic: { label: "Off topic", tone: "neutral" },
  refused: { label: "Refused", tone: "danger" },
  limit: { label: "Limited", tone: "info" },
  error: { label: "Error", tone: "danger" },
};
const REASON: Record<string, string> = {
  not_in_docs: "Not in the docs", needs_support: "Needs support", account_specific: "Account specific", no_answer: "No answer",
  budget_daily: "Daily budget", budget_monthly: "Monthly budget", rate_limited: "Hourly limit", busy: "Busy",
};
const TOOL_LABEL: Record<string, string> = {
  search_docs: "Search docs", read_section: "Read section", read_page: "Read page", get_limits: "Limits",
  get_changelog: "Changelog", get_my_account: "My account", explain_access: "Explain access", flag_unanswered: "Flag gap",
};

function OutcomeBadge({ outcome }: { outcome: string }) {
  const o = OUTCOME[outcome] ?? { label: outcome, tone: "neutral" as const };
  return <Badge size="sm" tone={o.tone}>{o.label}</Badge>;
}

// ── Data ─────────────────────────────────────────────────────────────────────

function useAiFetch(token: string) {
  const onUnauthorized = useOnUnauthorized();
  return useCallback(async <T,>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
    const qs = q.toString();
    const res = await fetch(`${API}/api/v1/admin/ai/${path}${qs ? `?${qs}` : ""}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) { onUnauthorized(); throw new Error("UNAUTHORIZED"); }
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }, [token, onUnauthorized]);
}

function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: boolean; loading: boolean }>({ loading: true });
  const run = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: false }));
    load().then((data) => setState({ data, loading: false })).catch(() => setState((s) => ({ ...s, loading: false, error: true })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run };
}

// ── Panel ────────────────────────────────────────────────────────────────────

export default function AiPanel({ token }: { token: string }) {
  const get = useAiFetch(token);
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
  const [range, setRange] = useState<RangeKey>("30d");
  const [openConv, setOpenConv] = useState<string | null>(null);
  const [bump, setBump] = useState(0);

  const ov = useLoad(() => get<Overview>("overview", { range, tz }), [get, range, tz, bump]);
  const qs = useLoad(() => get<{ questions: QuestionRow[]; distinct: number }>("questions", { range }), [get, range, bump]);
  const gaps = useLoad(() => get<{ gaps: GapRow[]; off_topic: number }>("gaps", { range }), [get, range, bump]);
  const pf = useLoad(() => get<PageFeedback>("page-feedback", { range }), [get, range, bump]);

  const o = ov.data;
  return (
    <div className="flex flex-col gap-5">
      <PageHead
        title="AI"
        caption="Ask AI on the docs site: what people ask, how it answers, and exactly what it costs."
        actions={<>
          <SegmentedControl<RangeKey> size="sm" aria-label="Date range" value={range} onChange={setRange} options={RANGE_OPTIONS} />
          <Button size="sm" variant="secondary" iconLeft="refresh" onClick={() => setBump((b) => b + 1)}>Refresh</Button>
        </>}
      />

      {o && !o.status.configured && (
        <Alert tone="warning" title="Ask AI isn't configured">
          Set <code>MARKDROP_ANTHROPIC_API_KEY</code> on the API server. Until then the docs show Open in Claude, ChatGPT and Perplexity instead.
        </Alert>
      )}
      {o && o.status.configured && !o.status.enabled && (
        <Alert tone="warning" title="Ask AI is turned off">The kill switch <code>MARKDROP_DOCS_AI_ENABLED</code> is off. Questions get the Open-in links.</Alert>
      )}
      {o?.truncated && <Alert tone="info">This range has more requests than the summary reads at once. Pick a shorter range for exact totals.</Alert>}
      {ov.loading && o && <Progress indeterminate size="sm" aria-label="Updating" valueText="Loading" />}

      {ov.error && !o ? <CardError title="AI usage" onRetry={ov.reload} /> : (
        <>
          <BudgetCard data={o} />
          <section aria-label="Key numbers" className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
            <StatTile size="md" icon="message" loading={!o} label="Questions" value={o ? n0(o.kpis.questions) : ""}
              caption={o ? `${plural(o.kpis.people, "person", "people")} · ${plural(o.kpis.conversations, "conversation")}${o.kpis.limited ? ` · ${o.kpis.limited} limited` : ""}` : undefined} />
            <StatTile size="md" icon="checkCircle" loading={!o} label="Answered" value={o ? pct(o.kpis.answered_pct) : ""}
              caption={o ? `Helpful ${pct(o.kpis.helpful_pct)} of ${plural(o.kpis.rated, "rating")}` : undefined} />
            <StatTile size="md" icon="chart" loading={!o} label="Cost" value={o ? usd(o.kpis.cost_usd) : ""}
              caption={o ? `${usd(o.kpis.cost_per_answer_usd)} per answer${o.kpis.long_context_calls ? ` · ${o.kpis.long_context_calls} calls over 100K tokens` : ""}` : undefined} />
            <StatTile size="md" icon="layers" loading={!o} label="Cache hit rate" value={o ? pct(o.kpis.cache_hit_pct) : ""}
              caption={o ? `${tokensShort(o.kpis.tokens.cache_read)} read · ${tokensShort(o.kpis.tokens.cache_write_5m + o.kpis.tokens.cache_write_1h)} written` : undefined} />
            <StatTile size="md" icon="zap" loading={!o} label="First words" value={o ? secs(o.kpis.ttft_ms.p50) : ""}
              caption={o ? `Median · p95 ${secs(o.kpis.ttft_ms.p95)}` : undefined} />
            <StatTile size="md" icon="clock" loading={!o} label="Full answer" value={o ? secs(o.kpis.latency_ms.p50) : ""}
              caption={o ? `Median · p95 ${secs(o.kpis.latency_ms.p95)}` : undefined} />
            <StatTile size="md" icon="hash" loading={!o} label="Tokens" value={o ? `${tokensShort(o.kpis.tokens.input)} in · ${tokensShort(o.kpis.tokens.output)} out` : ""}
              caption={o ? `Uncached input · output incl. ${tokensShort(o.kpis.tokens.thinking ?? 0)} thinking` : undefined} />
            <StatTile size="md" icon="search" loading={!o} label="Tools per answer" value={o ? (o.kpis.avg_tools_per_answer ?? "—").toString() : ""}
              caption={o ? `${o.status.model} · effort ${o.status.effort}${o.kpis.links_removed ? ` · ${o.kpis.links_removed} links removed` : ""}` : undefined} />
          </section>
          {o ? <DailyCard data={o} /> : <CardSkeleton title="Daily" height={260} />}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {o ? <OutcomesCard data={o} /> : <CardSkeleton title="Outcomes" />}
            {o ? <ToolsCard data={o} /> : <CardSkeleton title="Tools" />}
          </div>
          {o && o.by_model.length > 0 && <ModelsCard data={o} />}
        </>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        {qs.data ? <QuestionsCard rows={qs.data.questions} distinct={qs.data.distinct} onOpen={setOpenConv} />
          : qs.error ? <CardError title="Top questions" onRetry={qs.reload} /> : <CardSkeleton title="Top questions" height={260} />}
        {gaps.data ? <GapsCard rows={gaps.data.gaps} offTopic={gaps.data.off_topic} onOpen={setOpenConv} />
          : gaps.error ? <CardError title="Content gaps" onRetry={gaps.reload} /> : <CardSkeleton title="Content gaps" height={260} />}
      </div>

      <ConversationsCard key={`${range}-${bump}`} get={get} range={range} onOpen={setOpenConv} />

      {pf.data ? <PageFeedbackCard data={pf.data} /> : pf.error ? <CardError title="Page feedback" onRetry={pf.reload} /> : <CardSkeleton title="Page feedback" />}

      <ConversationDrawer get={get} id={openConv} onClose={() => setOpenConv(null)} />
    </div>
  );
}

// ── Cards ────────────────────────────────────────────────────────────────────

function BudgetCard({ data }: { data?: Overview }) {
  if (!data) return <CardSkeleton title="Budget" height={96} />;
  const b = data.budget;
  return (
    <Card aria-labelledby="ai-budget-h">
      <CardTitle id="ai-budget-h" title="Budget" sub={`Spend from real usage, cache and long-context pricing included. Days and months are UTC. All AI features: ${usd(b.all_features_today_usd)} today, ${usd(b.all_features_month_usd)} this month.`}
        right={<Badge size="sm" tone={data.status.enabled && data.status.configured ? "success" : "warning"} dot>
          {data.status.enabled && data.status.configured ? "On" : "Off"}
        </Badge>} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Meter label="Today" value={b.today_usd} max={b.daily_cap_usd || 1} threshold={0.8}
          meta={`${usd(b.today_usd)} of ${usd(b.daily_cap_usd)}`} valueText={`${usd(b.today_usd)} of ${usd(b.daily_cap_usd)} daily cap`} />
        <Meter label="This month" value={b.month_usd} max={b.monthly_cap_usd || 1} threshold={0.8}
          meta={`${usd(b.month_usd)} of ${usd(b.monthly_cap_usd)}`} valueText={`${usd(b.month_usd)} of ${usd(b.monthly_cap_usd)} monthly cap`} />
      </div>
      <p className="mt-3 text-caption text-text-secondary">
        {data.status.per_visitor_hour} questions per person per hour · {data.status.max_concurrent} at once · up to {data.status.max_tool_rounds} tool rounds per answer.
        {data.limit_reasons.length > 0 && <> Limited: {data.limit_reasons.map((r) => `${REASON[r.key] ?? r.key} ${r.n}`).join(", ")}.</>}
      </p>
    </Card>
  );
}

function DailyCard({ data }: { data: Overview }) {
  const [metric, setMetric] = useState<"questions" | "cost">("questions");
  const points = data.series.map((d) => ({ t: d.t, v: metric === "questions" ? d.questions : d.cost_usd }));
  return (
    <Card aria-labelledby="ai-daily-h">
      <CardTitle id="ai-daily-h" title="Daily" sub={metric === "questions" ? "Questions asked each day" : "Spend each day, in US dollars"}
        right={<SegmentedControl<"questions" | "cost"> size="sm" aria-label="Metric" value={metric} onChange={setMetric}
          options={[{ value: "questions", label: "Questions" }, { value: "cost", label: "Cost" }]} />} />
      {/* Days are already the admin's local dates, so the chart reads them as UTC. */}
      <TrendChart points={points} unit="day" tz="UTC" label={metric === "questions" ? "Questions" : "Cost"}
        format={metric === "cost" ? (n) => usd(n) : undefined} />
    </Card>
  );
}

function OutcomesCard({ data }: { data: Overview }) {
  return (
    <Card aria-labelledby="ai-outcomes-h">
      <CardTitle id="ai-outcomes-h" title="Outcomes" sub="How each question ended" />
      <BarList label="Outcomes" empty="No questions yet." rows={data.outcomes.map((x) => ({ key: OUTCOME[x.key]?.label ?? x.key, n: x.n }))} />
    </Card>
  );
}

function ToolsCard({ data }: { data: Overview }) {
  const cols: Column<Overview["tools"][number]>[] = [
    { key: "name", header: "Tool", primary: true, render: (t) => TOOL_LABEL[t.name] ?? t.name },
    { key: "calls", header: "Calls", align: "right", render: (t) => n0(t.calls) },
    { key: "questions", header: "Questions", align: "right", render: (t) => n0(t.questions) },
    { key: "errors", header: "Errors", align: "right", render: (t) => (t.errors ? <span className="text-danger-text">{n0(t.errors)}</span> : "0") },
    { key: "ms", header: "Avg time", align: "right", render: (t) => secs(t.avg_ms) },
  ];
  return (
    <Card aria-labelledby="ai-tools-h">
      <CardTitle id="ai-tools-h" title="Tools" sub="What the agent reached for. Errors include bad input it then corrected." />
      <Table compact hover={false} columns={cols} rows={data.tools} rowKey={(t) => t.name} caption="Tool usage" empty="No tool calls yet." />
    </Card>
  );
}

function ModelsCard({ data }: { data: Overview }) {
  const cols: Column<Overview["by_model"][number]>[] = [
    { key: "feature", header: "Feature", primary: true, render: (r) => r.feature },
    { key: "model", header: "Model", render: (r) => <code className="text-caption">{r.model}</code> },
    { key: "requests", header: "Requests", align: "right", render: (r) => n0(r.requests) },
    { key: "in", header: "Input", align: "right", render: (r) => tokensShort(r.input) },
    { key: "out", header: "Output", align: "right", render: (r) => tokensShort(r.output) },
    { key: "cr", header: "Cache read", align: "right", render: (r) => tokensShort(r.cache_read) },
    { key: "cw", header: "Cache write", align: "right", render: (r) => tokensShort(r.cache_write) },
    { key: "cost", header: "Cost", align: "right", render: (r) => usd(r.cost_usd) },
  ];
  return (
    <Card aria-labelledby="ai-models-h">
      <CardTitle id="ai-models-h" title="By feature and model" sub="Every AI feature that records through the usage ledger" />
      <Table compact hover={false} columns={cols} rows={data.by_model} rowKey={(r) => `${r.feature}:${r.model}`} caption="Usage by feature and model" />
    </Card>
  );
}

function QuestionsCard({ rows, distinct, onOpen }: { rows: QuestionRow[]; distinct: number; onOpen: (id: string) => void }) {
  return (
    <Card aria-labelledby="ai-q-h">
      <CardTitle id="ai-q-h" title="Top questions" sub={`${plural(distinct, "distinct question")}, grouped ignoring case and punctuation`} />
      {rows.length === 0 ? <p className="py-4 text-caption text-text-secondary">No questions yet.</p> : (
        <ul className="flex flex-col divide-y divide-border">
          {rows.slice(0, 15).map((q) => (
            <li key={q.question + q.last_ts} className="flex min-w-0 items-start justify-between gap-3 py-2.5">
              <button type="button" className="md-focus min-w-0 flex-1 rounded-sm text-left" onClick={() => onOpen(q.conversation_id)}>
                <span className="block truncate text-body text-text" title={q.question}>{q.question}</span>
                <span className="mt-0.5 flex flex-wrap gap-x-3 text-micro text-text-secondary">
                  {Object.entries(q.outcomes).map(([k, n]) => <span key={k}>{OUTCOME[k]?.label ?? k} {n}</span>)}
                  {(q.helpful > 0 || q.unhelpful > 0) && <span>Helpful {q.helpful} · Not {q.unhelpful}</span>}
                  <span>Last {fmtDateTime(q.last_ts)}</span>
                </span>
              </button>
              <span className="shrink-0 text-body-strong tabular-nums text-text">{q.count}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function GapsCard({ rows, offTopic, onOpen }: { rows: GapRow[]; offTopic: number; onOpen: (id: string) => void }) {
  return (
    <Card aria-labelledby="ai-gaps-h">
      <CardTitle id="ai-gaps-h" title="Content gaps" sub={`Questions the docs didn't answer, or answers marked unhelpful.${offTopic ? ` ${plural(offTopic, "off-topic question")} left out.` : ""}`} />
      {rows.length === 0 ? <EmptyState icon="checkCircle" title="No gaps in this range" description="Unanswered questions and thumbs-down answers show up here." /> : (
        <ul className="flex flex-col divide-y divide-border">
          {rows.slice(0, 15).map((g) => (
            <li key={g.summary + g.last_ts} className="flex min-w-0 flex-col gap-1 py-2.5">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <button type="button" className="md-focus min-w-0 flex-1 rounded-sm text-left text-body text-text" onClick={() => onOpen(g.conversation_id)} title={g.question}>
                  {g.summary}
                </button>
                <span className="shrink-0 text-body-strong tabular-nums text-text">{g.count}</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {Object.entries(g.reasons).map(([k, n]) => <Badge key={k} size="sm" tone="warning">{REASON[k] ?? k}{n > 1 ? ` ${n}` : ""}</Badge>)}
                {g.thumbs_down > 0 && <Badge size="sm" tone="danger">Unhelpful {g.thumbs_down}</Badge>}
                {g.pages.map((p) => <Badge key={p} size="sm" variant="outline">{p}</Badge>)}
              </div>
              {[...g.details, ...g.comments].slice(0, 2).map((c, i) => (
                <p key={i} className="text-caption text-text-secondary">“{c}”</p>
              ))}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ConversationsCard({ get, range, onOpen }: { get: ReturnType<typeof useAiFetch>; range: RangeKey; onOpen: (id: string) => void }) {
  const [page, setPage] = useState(1);
  const [outcome, setOutcome] = useState("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const list = useLoad(() => get<{ items: ConvItem[]; pages: number; total: number }>("conversations", { range, page, outcome, q: query }),
    [get, range, page, outcome, query]);
  const cols: Column<ConvItem>[] = [
    { key: "q", header: "Question", primary: true, render: (r) => (
      <span className="flex min-w-0 flex-col">
        <span className="max-w-[28rem] truncate text-text" title={r.question}>{r.question || <span className="italic text-text-muted">Empty</span>}</span>
        <span className="truncate text-micro text-text-muted">{r.who}{r.turn > 1 ? ` · follow-up ${r.turn}` : ""}{r.page_path ? ` · ${r.page_path}` : ""}</span>
      </span>
    ) },
    { key: "outcome", header: "Outcome", render: (r) => (
      <span className="flex items-center gap-1.5">
        <OutcomeBadge outcome={r.outcome} />
        {r.feedback && <Badge size="sm" tone={r.feedback.helpful ? "success" : "danger"} variant="outline">{r.feedback.helpful ? "Helpful" : "Unhelpful"}</Badge>}
      </span>
    ) },
    { key: "tok", header: "Tokens", align: "right", render: (r) => `${tokensShort(r.tokens.input + r.tokens.cache_read + r.tokens.cache_write)} / ${tokensShort(r.tokens.output)}` },
    { key: "cost", header: "Cost", align: "right", render: (r) => usd(r.cost_usd) },
    { key: "time", header: "Time", align: "right", render: (r) => secs(r.latency_ms) },
    { key: "when", header: "When", render: (r) => <span className="whitespace-nowrap">{fmtDateTime(r.ts)}</span> },
  ];
  return (
    <Card aria-labelledby="ai-conv-h">
      <CardTitle id="ai-conv-h" title="Recent conversations" sub={list.data ? `${plural(list.data.total, "question")} in this range. Open one for the full answer, sources, tools and cost.` : undefined}
        right={<>
          <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setQuery(q.trim()); }}>
            <Input aria-label="Search questions" placeholder="Search questions" value={q} onChange={(e) => setQ(e.target.value)} className="w-48" />
          </form>
          <Select aria-label="Outcome" value={outcome} onChange={(e) => { setOutcome(e.target.value); setPage(1); }}
            options={[{ value: "", label: "All outcomes" }, ...Object.entries(OUTCOME).map(([value, o]) => ({ value, label: o.label }))]} />
        </>} />
      {list.error ? (
        <Alert tone="danger" actions={<Button size="sm" variant="secondary" iconLeft="refresh" onClick={list.reload}>Retry</Button>}>Couldn&apos;t load conversations.</Alert>
      ) : !list.data ? <LoadingBlock label="Loading conversations" minHeight={240} /> : (
        <>
          <Table compact columns={cols} rows={list.data.items} rowKey={(r) => r.request_id} caption="Recent conversations"
            onRowClick={(r) => onOpen(r.conversation_id)} empty="No questions in this range." />
          {list.data.pages > 1 && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-caption text-text-secondary">Page {page} of {list.data.pages}</p>
              <Pagination page={page} pageCount={list.data.pages} onChange={setPage} />
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function PageFeedbackCard({ data }: { data: PageFeedback }) {
  const cols: Column<PageFeedback["pages"][number]>[] = [
    { key: "path", header: "Page", primary: true, render: (p) => (
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-text">{p.path}{!p.known_page && <span className="ml-1.5 text-micro text-text-muted">(not a page)</span>}</span>
        {p.comments.slice(0, 2).map((c, i) => <span key={i} className="truncate text-micro text-text-secondary" title={c.text}>{c.helpful ? "Helpful: " : "Missing: "}“{c.text}”</span>)}
      </span>
    ) },
    { key: "up", header: "Helpful", align: "right", render: (p) => n0(p.up) },
    { key: "down", header: "Not helpful", align: "right", render: (p) => n0(p.down) },
    { key: "pct", header: "Helpful %", align: "right", render: (p) => pct(p.helpful_pct) },
  ];
  return (
    <Card aria-labelledby="ai-pf-h">
      <CardTitle id="ai-pf-h" title="Page feedback" sub={`"Did this page help?" on the docs: ${plural(data.votes, "vote")}, ${pct(data.helpful_pct)} helpful. Pages with the most "no" first.`} />
      <Table compact hover={false} columns={cols} rows={data.pages.slice(0, 30)} rowKey={(p) => p.path} caption="Page feedback" empty="No page votes in this range." />
    </Card>
  );
}

// ── Drill-down ───────────────────────────────────────────────────────────────

function ConversationDrawer({ get, id, onClose }: { get: ReturnType<typeof useAiFetch>; id: string | null; onClose: () => void }) {
  const [state, setState] = useState<{ data?: { who: string; turns: Turn[]; cost_usd: number }; error?: boolean }>({});
  useEffect(() => {
    if (!id) return;
    setState({});
    get<{ who: string; turns: Turn[]; cost_usd: number }>(`conversations/${encodeURIComponent(id)}`)
      .then((data) => setState({ data })).catch(() => setState({ error: true }));
  }, [get, id]);
  const d = state.data;
  return (
    <Drawer open={!!id} onClose={onClose} width={640} title="Conversation"
      description={d ? `${d.who} · ${plural(d.turns.length, "question")} · ${usd(d.cost_usd)}` : undefined} bodyClassName="flex flex-col gap-5">
      {state.error ? <Alert tone="danger">Couldn&apos;t load this conversation.</Alert> : !d ? <LoadingBlock label="Loading the conversation" minHeight={240} /> : (
        d.turns.map((t) => <TurnView key={t.request_id} t={t} />)
      )}
    </Drawer>
  );
}

function TurnView({ t }: { t: Turn }) {
  const u = t.usage ?? ({} as Tokens);
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-border bg-surface-inset p-3.5">
      <header className="flex flex-wrap items-center gap-2">
        <OutcomeBadge outcome={t.outcome} />
        <span className="text-micro text-text-secondary">{fmtDateTime(t.ts)}{t.page_path ? ` · on ${t.page_path}` : ""}</span>
        {t.feedback && <Badge size="sm" tone={t.feedback.helpful ? "success" : "danger"} variant="outline">{t.feedback.helpful ? "Helpful" : "Unhelpful"}</Badge>}
      </header>
      <div>
        <Eyebrow>Question</Eyebrow>
        <p className="whitespace-pre-wrap break-words text-body text-text">{t.question}</p>
      </div>
      <div>
        <Eyebrow>Answer</Eyebrow>
        {t.answer ? <div className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface p-3 text-caption text-text">{t.answer}</div>
          : <p className="text-caption text-text-muted">{t.limit_reason ? `Not answered: ${REASON[t.limit_reason] ?? t.limit_reason}.` : "No answer text."}</p>}
        {t.feedback?.comment && <p className="mt-1.5 text-caption text-text-secondary">Reader: “{t.feedback.comment}”</p>}
      </div>
      {t.citations.length > 0 && (
        <div>
          <Eyebrow>Sources</Eyebrow>
          <ol className="flex flex-col gap-1 text-caption">
            {t.citations.map((c) => (
              <li key={c.id} className="min-w-0 truncate">
                <span className="tabular-nums text-text-muted">[{c.n}]</span>{" "}
                <a className="md-link" href={c.url} target="_blank" rel="noreferrer">{c.title}</a>
                <span className="text-text-muted"> · {c.page}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {t.tool_calls.length > 0 && (
        <div>
          <Eyebrow>Tools</Eyebrow>
          <ul className="flex flex-col gap-1 text-caption">
            {t.tool_calls.map((c, i) => (
              <li key={i} className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 font-medium text-text">{TOOL_LABEL[c.name] ?? c.name}</span>
                <code className="min-w-0 flex-1 truncate text-micro text-text-secondary" title={c.args_summary}>{c.args_summary}</code>
                <span className="shrink-0 tabular-nums text-text-muted">{c.result_count ?? "—"} · {secs(c.ms)}</span>
                {c.error && <Badge size="sm" tone="danger" title={c.error}>Error</Badge>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {t.gaps.length > 0 && (
        <p className="text-caption text-text-secondary">Flagged: {t.gaps.map((g) => `${REASON[g.reason] ?? g.reason}: ${g.summary}`).join("; ")}</p>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-micro text-text-secondary sm:grid-cols-3">
        <div><dt className="inline">Cost </dt><dd className="inline font-medium text-text">{usd(t.cost_usd)}</dd></div>
        <div><dt className="inline">Calls </dt><dd className="inline font-medium text-text">{t.calls ?? "—"}</dd></div>
        <div><dt className="inline">First words </dt><dd className="inline font-medium text-text">{secs(t.ttft_ms)}</dd></div>
        <div><dt className="inline">Total </dt><dd className="inline font-medium text-text">{secs(t.latency_ms)}</dd></div>
        <div><dt className="inline">Input </dt><dd className="inline font-medium text-text">{n0(u.input)}</dd></div>
        <div><dt className="inline">Output </dt><dd className="inline font-medium text-text">{n0(u.output)}{u.thinking ? ` (${n0(u.thinking)} thinking)` : ""}</dd></div>
        <div><dt className="inline">Cache read </dt><dd className="inline font-medium text-text">{n0(u.cache_read)}</dd></div>
        <div><dt className="inline">Cache write </dt><dd className="inline font-medium text-text">{n0((u.cache_write_5m ?? 0) + (u.cache_write_1h ?? 0))}</dd></div>
        <div><dt className="inline">Model </dt><dd className="inline font-medium text-text">{t.model} · {t.effort}</dd></div>
        <div><dt className="inline">Stop </dt><dd className="inline font-medium text-text">{t.stop_reason ?? "—"}{t.stop_details?.category ? ` (${t.stop_details.category})` : ""}</dd></div>
        {t.error_code && <div><dt className="inline">Error </dt><dd className="inline font-medium text-danger-text">{t.error_code}</dd></div>}
        {t.links_removed > 0 && <div><dt className="inline">Links removed </dt><dd className="inline font-medium text-text">{t.links_removed}</dd></div>}
      </dl>
    </article>
  );
}
