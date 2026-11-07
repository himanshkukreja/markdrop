"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Alert, Badge, Button, EmptyState, Input, Pagination, Progress, SegmentedControl, Select, Table, Tag, type Column,
} from "@/components/ui";
import { Card, CardError, CardTitle } from "../analytics/ui";
import { LoadingBlock, plural } from "../shared";
import { FEATURE_LABEL, ago, featureColor, featureLabel, n0, tokensShort, usd, useAiFetch, useLoad } from "./common";
import { LogSettingsDialog } from "./LogSettings";
import {
  ActorBadge, LOG_AUDIENCES, OUTCOMES, ScopeChip, WhoMark, personFilterOf, type ConvCard, type Counts, type LogAudience,
  type OutcomeKind, type PersonFilter, type Who,
} from "./requestsShared";
import { TranscriptDrawer } from "./Transcript";

/**
 * Admin → AI → Requests: every AI call as a readable conversation (services/ai_log.py). Real users
 * by default; system jobs, public visitors and test & internal traffic are each a filter away.
 * A row opens the transcript: who asked what, and how Markdrop replied.
 */

type Preset = "24h" | "7d" | "30d" | "all" | "custom";
const PRESETS: { value: Preset; label: string }[] = [
  { value: "24h", label: "24 h" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }, { value: "all", label: "All" }, { value: "custom", label: "Custom" },
];
const FEATURES = Object.entries(FEATURE_LABEL).map(([value, label]) => ({ value, label }));

interface ListRes { audience: string; page: number; pages: number; total: number; truncated: boolean; counts: Counts; items: ConvCard[] }
interface Totals { calls: number; errors: number; cost_usd: number; tokens_in: number; tokens_out: number; conversations: number }
interface SummaryRes {
  audience: string; truncated: boolean; total: Totals;
  by_feature: (Totals & { key: string; label: string })[];
  by_who: (Totals & Who & { key: string })[];
}
interface Labeled { value: string; label: string }

const day = (d: Date) => d.toISOString().slice(0, 10);

/** since/until for the API: presets are exact (an ISO time), custom dates are whole UTC days. */
function rangeOf(preset: Preset, from: string, to: string): { since?: string; until?: string } {
  const now = Date.now();
  if (preset === "24h") return { since: new Date(now - 86_400_000).toISOString() };
  if (preset === "7d") return { since: day(new Date(now - 6 * 86_400_000)) };
  if (preset === "30d") return { since: day(new Date(now - 29 * 86_400_000)) };
  if (preset === "custom") return { since: from || undefined, until: to || undefined };
  return {};
}

/** Filters to open with (Admin → AI → Workspaces links a workspace's conversations). */
export interface RequestsFilter { workspace: Labeled; preset?: string | null; audience?: string | null }
const isPreset = (v: string | null | undefined): v is Preset => PRESETS.some((p) => p.value === v);
const isLogAudience = (v: string | null | undefined): v is LogAudience => LOG_AUDIENCES.some((a) => a.value === v);

export function RequestsTab({ token, openId, onOpen, initial }: {
  token: string; openId: string | null; onOpen: (id: string | null) => void; initial?: RequestsFilter | null;
}) {
  const get = useAiFetch(token);
  const [audience, setAudience] = useState<LogAudience>(isLogAudience(initial?.audience) ? initial.audience : "real");
  const [feature, setFeature] = useState("");
  const [outcome, setOutcome] = useState<OutcomeKind | "">("");
  const [preset, setPreset] = useState<Preset>(isPreset(initial?.preset) ? initial.preset : "30d");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [personText, setPersonText] = useState("");
  const [person, setPerson] = useState<PersonFilter | null>(null);
  const [workspace, setWorkspace] = useState<Labeled | null>(initial?.workspace ?? null);
  const [page, setPage] = useState(1);
  const [bump, setBump] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Text search and the person box apply a beat after the last key.
  useEffect(() => {
    const t = setTimeout(() => { setPage(1); setQuery(q.trim()); }, 300);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const t = setTimeout(() => {
      const v = personText.trim();
      setPerson((p) => (v ? (p && p.label === v ? p : { value: v, label: v }) : null));
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [personText]);

  // Refresh (bump) moves a rolling window forward too.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const range = useMemo(() => rangeOf(preset, from, to), [preset, from, to, bump]);
  const filters = useMemo(() => ({
    audience, feature, outcome, workspace: workspace?.value, user: person?.value, q: query, ...range,
  }), [audience, feature, outcome, workspace, person, query, range]);

  const list = useLoad(() => get<ListRes>("log/conversations", { ...filters, page, limit: 25 }), [get, filters, page, bump]);
  const summary = useLoad(() => get<SummaryRes>("log/summary", filters), [get, filters, bump]);
  const d = list.data;
  const counts = d?.counts;

  const pickPerson = (p: PersonFilter) => { setPerson(p); setPersonText(p.label); setPage(1); };
  const pickWorkspace = (w: Labeled) => { setWorkspace(w); setPage(1); };
  const pickWho = (w: Who) => {
    const p = personFilterOf(w);
    if (p) pickPerson(p);
    else if (w.kind === "public") { setAudience("public"); setPage(1); }
  };
  const reset = <T,>(set: (v: T) => void, v: T) => () => { set(v); setPage(1); };

  const chips: { key: string; label: string; clear: () => void }[] = [
    ...(feature ? [{ key: "f", label: `Feature: ${featureLabel(feature)}`, clear: reset(setFeature, "") }] : []),
    ...(outcome ? [{ key: "o", label: `Outcome: ${OUTCOMES.find((o) => o.value === outcome)?.label ?? outcome}`, clear: reset<OutcomeKind | "">(setOutcome, "") }] : []),
    ...(person ? [{ key: "p", label: `Person: ${person.label}`, clear: () => { setPerson(null); setPersonText(""); setPage(1); } }] : []),
    ...(workspace ? [{ key: "w", label: `Workspace: ${workspace.label}`, clear: reset<Labeled | null>(setWorkspace, null) }] : []),
    ...(query ? [{ key: "q", label: `Text: “${query}”`, clear: () => { setQ(""); setQuery(""); setPage(1); } }] : []),
    ...(preset === "custom" && (from || to) ? [{ key: "d", label: `Dates: ${from || "…"} to ${to || "…"}`, clear: () => { setFrom(""); setTo(""); setPage(1); } }] : []),
  ];
  const clearAll = () => {
    setFeature(""); setOutcome(""); setPerson(null); setPersonText(""); setWorkspace(null); setQ(""); setQuery(""); setFrom(""); setTo(""); setPage(1);
  };

  const countOf = (a: LogAudience) => (counts ? counts[a] : undefined);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-body text-text-secondary">Every AI call, as the conversation it was part of: who asked what, and how Markdrop replied.</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" iconLeft="settings" onClick={() => setSettingsOpen(true)}>Log settings</Button>
          <Button size="sm" variant="secondary" iconLeft="refresh" onClick={() => setBump((b) => b + 1)}>Refresh</Button>
        </div>
      </div>

      <section aria-label="Filters" className="flex flex-col gap-3">
        <div className="-mx-1 overflow-x-auto px-1 pb-0.5">
          <SegmentedControl<LogAudience> size="sm" aria-label="Whose requests" value={audience} onChange={(v) => { setAudience(v); setPage(1); }}
            options={LOG_AUDIENCES.map((a) => ({
              value: a.value,
              label: <span className="whitespace-nowrap">{a.label}{countOf(a.value) !== undefined && <span className="ml-1 tabular-nums opacity-70">{n0(countOf(a.value))}</span>}</span>,
              "aria-label": countOf(a.value) !== undefined ? `${a.label}, ${countOf(a.value)} calls` : a.label,
            }))} />
        </div>
        <form role="search" className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-center"
          onSubmit={(e) => { e.preventDefault(); setPage(1); setQuery(q.trim()); }}>
          <Input aria-label="Search questions and answers" placeholder="Search questions, answers, labels" iconPrefix="search" value={q}
            onChange={(e) => setQ(e.target.value)} wrapClassName="lg:w-72" />
          <Input aria-label="Person (email, name or job)" placeholder="Person: email, name or job" iconPrefix="user" value={personText}
            onChange={(e) => setPersonText(e.target.value)} wrapClassName="lg:w-56" />
          <Select aria-label="Feature" value={feature} onChange={(e) => { setFeature(e.target.value); setPage(1); }}
            options={[{ value: "", label: "All features" }, ...FEATURES]} />
          <Select aria-label="Outcome" value={outcome} onChange={(e) => { setOutcome(e.target.value as OutcomeKind | ""); setPage(1); }}
            options={[{ value: "", label: "Any outcome" }, ...OUTCOMES]} />
        </form>
        <div className="flex flex-wrap items-center gap-2">
          <div className="-mx-1 max-w-full overflow-x-auto px-1">
            <SegmentedControl<Preset> size="sm" aria-label="Date range" value={preset} onChange={(v) => { setPreset(v); setPage(1); }} options={PRESETS} />
          </div>
          {preset === "custom" && (
            <span className="flex flex-wrap items-center gap-2">
              <Input size="sm" type="date" aria-label="From (UTC)" value={from} max={to || undefined} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />
              <span className="text-caption text-text-muted">to</span>
              <Input size="sm" type="date" aria-label="To (UTC, inclusive)" value={to} min={from || undefined} onChange={(e) => { setTo(e.target.value); setPage(1); }} />
            </span>
          )}
        </div>
        {chips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
            {chips.map((c) => <Tag key={c.key} onRemove={c.clear} removeLabel={`Remove filter ${c.label}`}>{c.label}</Tag>)}
            {chips.length > 1 && <Button size="sm" variant="link" onClick={clearAll}>Clear all</Button>}
          </div>
        )}
      </section>

      {list.loading && d && <Progress indeterminate size="sm" aria-label="Updating" valueText="Loading" />}
      {d?.truncated && <Alert tone="info">More calls match than the log reads at once. Narrow the dates or filters for a complete list.</Alert>}

      {list.error && !d ? <CardError title="Conversations" onRetry={list.reload} /> : (
        <Card aria-labelledby="ai-req-h">
          <CardTitle id="ai-req-h" title="Conversations"
            sub={d ? `${plural(d.total, "conversation")}${summary.data ? ` · ${plural(summary.data.total.calls, "call")} · ${usd(summary.data.total.cost_usd)}` : ""}` : undefined} />
          {!d ? <LoadingBlock label="Loading conversations" minHeight={280} /> : d.items.length === 0 ? (
            <EmptyState icon="message" title="No conversations match"
              description={chips.length ? "Try removing a filter." : audience === "real" ? "No real user has used AI in this range. Test & internal calls are under their own filter." : "Nothing in this range."} />
          ) : (
            <>
              <ul className="-mx-1 flex flex-col divide-y divide-border" data-testid="ai-conversations">
                {d.items.map((c) => (
                  <ConvRow key={c.conversation_id} c={c} active={c.conversation_id === openId} onOpen={() => onOpen(c.conversation_id)}
                    onWho={() => pickWho(c.who)} onWorkspace={() => c.workspace_id && pickWorkspace({ value: c.workspace_id, label: c.workspace_name || "Workspace" })} />
                ))}
              </ul>
              {d.pages > 1 && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-caption text-text-secondary">Page {page} of {d.pages}</p>
                  <Pagination page={page} pageCount={d.pages} onChange={setPage} />
                </div>
              )}
            </>
          )}
        </Card>
      )}

      <Totals data={summary.data} error={summary.error} onRetry={summary.reload} onWho={pickWho} onFeature={(k) => { setFeature(k); setPage(1); }} />

      <TranscriptDrawer token={token} id={openId} onClose={() => onOpen(null)} onPerson={pickPerson} onWorkspace={pickWorkspace} />
      <LogSettingsDialog token={token} open={settingsOpen} onClose={() => setSettingsOpen(false)} onSaved={() => setBump((b) => b + 1)} />
    </div>
  );
}

function ConvRow({ c, active, onOpen, onWho, onWorkspace }: { c: ConvCard; active: boolean; onOpen: () => void; onWho: () => void; onWorkspace: () => void }) {
  const canFilterWho = !!personFilterOf(c.who) || c.who.kind === "public";
  const errors = c.outcomes.error ?? 0;
  const limited = (c.outcomes.limit ?? 0) + (c.outcomes.refused ?? 0);
  return (
    <li className={`group relative flex cursor-pointer gap-3 rounded-md px-1 py-3 hover:bg-surface-hover ${active ? "bg-surface-hover" : ""}`}
      onClick={(e) => { if (!(e.target as HTMLElement).closest("button,a")) onOpen(); }}>
      <WhoMark who={c.who} size={32} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <button type="button" onClick={onOpen} aria-current={active || undefined}
            className="md-focus min-w-0 rounded-sm text-left text-body-strong text-text">
            <span className="line-clamp-2 break-words">{c.title}</span>
          </button>
          <span className="shrink-0 text-body-strong tabular-nums text-text" title={`${tokensShort(c.tokens_in)} in / ${tokensShort(c.tokens_out)} out`}>{usd(c.cost_usd)}</span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption text-text-secondary">
          {canFilterWho ? (
            <button type="button" onClick={onWho} className="md-focus min-w-0 max-w-full truncate rounded-sm text-left hover:text-text hover:underline"
              title={c.who.sub ? `${c.who.name} · ${c.who.sub}` : c.who.name} aria-label={`Show only ${c.who.name}`}>
              <span className="font-medium text-text">{c.who.name}</span>{c.who.sub && <span className="text-text-muted"> · {c.who.sub}</span>}
            </button>
          ) : (
            <span className="min-w-0 truncate"><span className="font-medium text-text">{c.who.name}</span>{c.who.sub && <span className="text-text-muted"> · {c.who.sub}</span>}</span>
          )}
          <ActorBadge who={c.who} />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-micro text-text-muted">
          {c.scope_label ? <ScopeChip>{c.scope_label}</ScopeChip> : c.label ? <span className="truncate">{c.label}</span> : null}
          {c.features.length > 0 && (
            <span className="inline-flex items-center gap-1" title={c.features.map(featureLabel).join(", ")}>
              {c.features.map((f) => <span key={f} aria-hidden className="size-2 rounded-xs" style={{ background: featureColor(f) }} />)}
              <span>{c.features.length === 1 ? featureLabel(c.features[0]) : plural(c.features.length, "feature")}</span>
            </span>
          )}
          {c.workspace_id && c.workspace_name && (
            <button type="button" onClick={onWorkspace} className="md-focus inline-flex max-w-[12rem] items-center gap-1 truncate rounded-sm hover:text-text hover:underline"
              aria-label={`Show only workspace ${c.workspace_name}`}>
              · <span className="truncate">{c.workspace_name}</span>
            </button>
          )}
          <span>· {plural(c.turns, "turn")}</span>
          <span title={c.last_ts ?? undefined}>· {ago(c.last_ts)}</span>
          {errors > 0 && <Badge size="sm" tone="danger">{errors === 1 ? "Error" : `${errors} errors`}</Badge>}
          {limited > 0 && <Badge size="sm" tone="info">{limited === 1 ? "Limited" : `${limited} limited`}</Badge>}
          {!c.content && <span title="Content capture was off">· no content</span>}
        </div>
      </div>
    </li>
  );
}

// ── Totals ───────────────────────────────────────────────────────────────────

function Totals({ data, error, onRetry, onWho, onFeature }: {
  data: SummaryRes | undefined; error?: boolean; onRetry: () => void; onWho: (w: Who) => void; onFeature: (k: string) => void;
}) {
  const [open, setOpen] = useState(true);
  // Open beside a wide screen, folded on phones (the list comes first).
  useEffect(() => { setOpen(window.matchMedia("(min-width: 768px)").matches); }, []);
  const num = (r: Totals) => ({
    calls: n0(r.calls), conv: n0(r.conversations), tok: `${tokensShort(r.tokens_in)} / ${tokensShort(r.tokens_out)}`,
    err: r.errors ? <span className="text-danger-text">{n0(r.errors)}</span> : "0", cost: usd(r.cost_usd),
  });
  const tail = <T extends Totals>(): Column<T>[] => [
    { key: "calls", header: "Calls", align: "right", render: (r) => num(r).calls },
    { key: "conv", header: "Conv.", align: "right", render: (r) => num(r).conv },
    { key: "tok", header: "Tokens in / out", align: "right", render: (r) => <span className="whitespace-nowrap">{num(r).tok}</span> },
    { key: "err", header: "Errors", align: "right", render: (r) => num(r).err },
    { key: "cost", header: "Cost", align: "right", render: (r) => <span className="font-medium">{num(r).cost}</span> },
  ];
  const featureCols: Column<SummaryRes["by_feature"][number]>[] = [
    { key: "f", header: "Feature", primary: true, render: (f) => (
      <button type="button" className="md-focus inline-flex items-center gap-2 whitespace-nowrap rounded-sm hover:underline" onClick={() => onFeature(f.key)} aria-label={`Show only ${f.label}`}>
        <span aria-hidden className="size-2.5 rounded-xs" style={{ background: featureColor(f.key) }} />{f.label}
      </button>
    ) },
    ...tail<SummaryRes["by_feature"][number]>(),
  ];
  const whoCols: Column<SummaryRes["by_who"][number]>[] = [
    { key: "w", header: "Who", primary: true, render: (w) => (
      <button type="button" className="md-focus flex min-w-0 max-w-[16rem] flex-col rounded-sm text-left hover:underline" onClick={() => onWho(w)} aria-label={`Show only ${w.name}`}>
        <span className="flex items-center gap-1.5"><span className="truncate text-text">{w.name}</span>{(w.test || w.kind !== "user") && <ActorBadge who={w} />}</span>
        {w.sub && <span className="truncate text-micro text-text-muted">{w.sub}</span>}
      </button>
    ) },
    ...tail<SummaryRes["by_who"][number]>(),
  ];
  return (
    <Card aria-labelledby="ai-req-totals-h">
      <CardTitle id="ai-req-totals-h" title="Totals" sub={data ? `For these filters: ${plural(data.total.calls, "call")}, ${usd(data.total.cost_usd)}` : undefined}
        right={<Button size="sm" variant="ghost" iconRight={open ? "chevronUp" : "chevronDown"} aria-expanded={open} aria-controls="ai-req-totals" onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Show"}</Button>} />
      <div id="ai-req-totals" hidden={!open}>
        {error && !data ? <CardError title="Totals" onRetry={onRetry} /> : !data ? <LoadingBlock label="Loading totals" minHeight={160} /> : (
          <>
            {data.truncated && <p className="mb-2 text-caption text-text-muted">More calls match than the summary reads at once; totals are for the newest.</p>}
            <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
              <section aria-label="By feature" className="min-w-0">
                <p className="mb-1.5 text-micro font-medium uppercase tracking-wide text-text-muted">By feature</p>
                <Table compact hover={false} columns={featureCols} rows={data.by_feature} rowKey={(f) => f.key} caption="AI calls by feature" empty="Nothing in this range." />
              </section>
              <section aria-label="By person" className="min-w-0">
                <p className="mb-1.5 text-micro font-medium uppercase tracking-wide text-text-muted">By person</p>
                <Table compact hover={false} columns={whoCols} rows={data.by_who} rowKey={(w) => w.key} caption="AI calls by person" empty="Nothing in this range." />
              </section>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
