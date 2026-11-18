"use client";

/**
 * Deals (backend GET /hubspot/deals/board), two ways in:
 *   - /deals/<workspace>?space=team:<id>   the HubSpot team's Deals (one workspace has one HubSpot team)
 *   - /deals[?team=<workspace>]            Deals across all your HubSpot teams (the sidebar's top "Deals"), with a
 *                                          Team filter (?team= picks one); same board and list.
 * A BOARD by pipeline stage (owner approved 2026-11-18, .work/briefs/nav-redesign.md): ~280px columns that hug their
 * cards, 5 cards then "Show N more", an empty stage a 44px strip "Stage · 0", a column header with count and total;
 * a card: deal, company, owner · amount · close date · N calls, and at most one signal line ("No calls yet" or
 * "Quiet N days"). The board scrolls sideways inside itself, never the page. Or a LIST: a dense sortable table.
 * One toolbar row: Board / List, Team (all teams), Pipeline (several), Owner, Company, No call in 14 days, Group by
 * company, Show closed. Filters, view and sort are this viewer's, remembered on this device. Workspace admins get
 * Sync now (polled until done) and the missing-scopes note. Only the HubSpot team's members and workspace admins can
 * open a team's Deals (403 / 404: a calm note). The pure model is model.mjs (tests: model.test.mjs).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Alert, Avatar, Badge, Button, EmptyState, Icon, Select, SegmentedControl, Skeleton, Spinner, Table, useToast, type Column,
} from "@/components/ui";
import { relativeTime } from "@/components/dashboard/format";
import { dealsBoard, dealsSync, hubspotMe, type DealBoard } from "@/lib/hubspot";
import { dealHref, teamHref } from "@/lib/teams";
import { errorStatus, getWorkspace } from "@/lib/workspaces";
import { useAssistantHere } from "@/components/assistant/store";
import { amountOf, compactAmount, compactTotal, quietLabel, relDay, shortDay } from "./format";
import {
  callsLabel, columnsOf, companiesOf, filterRows, groupByCompany, ownersOf, pipelinesOf, rowsOf, signalOf, sortRows, stagesOf,
  summaryOf, visibleCount, type DealEntry, type DealRow, type SortKey,
} from "./model.mjs";
import "./deals.css";

type View = "board" | "list";
interface Prefs {
  view: View; owner: string; company: string; quiet: boolean; group: boolean; pipeline: string; closed: boolean;
  team: string; sort: SortKey; dir: "asc" | "desc";
}
const DEFAULTS: Prefs = { view: "board", owner: "", company: "", quiet: false, group: false, pipeline: "", closed: false, team: "", sort: "amount", dir: "desc" };
const prefsKey = (ws: string | null) => `md_deals_view:${ws ?? "all"}`;

function readPrefs(ws: string | null): Prefs {
  try {
    const raw = window.localStorage.getItem(prefsKey(ws));
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<Prefs>;
    return { ...DEFAULTS, ...p, view: p.view === "list" ? "list" : "board", dir: p.dir === "asc" ? "asc" : "desc" };
  } catch { return DEFAULTS; }
}
function writePrefs(ws: string | null, p: Prefs) {
  try { window.localStorage.setItem(prefsKey(ws), JSON.stringify(p)); } catch { /* private window: not remembered */ }
}

export default function DealsSection({ workspaceId }: { workspaceId?: string }) {
  const ws = workspaceId ?? null;
  const toast = useToast();
  const [entries, setEntries] = useState<DealEntry[] | null>(null);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wsName, setWsName] = useState<string | null>(null);
  const [prefs, setPrefsState] = useState<Prefs>(DEFAULTS);
  const [syncing, setSyncing] = useState(false);
  useAssistantHere(ws ? { workspace: ws } : null);

  useEffect(() => {
    const p = readPrefs(ws);
    if (!ws) {
      const t = new URLSearchParams(window.location.search).get("team");
      if (t !== null) p.team = t;
    }
    setPrefsState(p);
  }, [ws]);
  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefsState((p) => { const next = { ...p, ...patch }; writePrefs(ws, next); return next; });
    if (!ws && patch.team !== undefined) {
      try {
        const u = new URL(window.location.href);
        if (patch.team) u.searchParams.set("team", patch.team); else u.searchParams.delete("team");
        window.history.replaceState(window.history.state, "", `${u.pathname}${u.search}${u.hash}`);
      } catch { /* the filter still applies */ }
    }
  }, [ws]);

  const load = useCallback(async () => {
    try {
      if (ws) {
        const board = await dealsBoard(ws);
        setEntries([{ ws, wsName: null, board }]);
      } else {
        const me = await hubspotMe();
        const got = await Promise.allSettled(me.teams.map(async (t) => ({ ws: t.workspace_id, wsName: t.workspace, team: t.team, board: await dealsBoard(t.workspace_id) })));
        setEntries(got.flatMap((g) => (g.status === "fulfilled" ? [g.value] : [])));
      }
      setError(null); setLocked(false);
    } catch (e) {
      const s = errorStatus(e);
      if (s === 403 || s === 404) setLocked(true);
      else setError(e instanceof Error ? e.message : "Couldn't load the deals.");
    }
  }, [ws]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (ws) getWorkspace(ws).then((w) => setWsName(w.name), () => setWsName(null)); }, [ws]);

  // Sync now acts on one team: the team's Deals, or the one the all-teams view is filtered to.
  const target = entries ? (ws ? entries[0] : entries.length === 1 ? entries[0] : entries.find((e) => e.ws === prefs.team)) ?? null : null;
  const running = target?.board.sync.state === "running";
  const wasRunning = useRef(false);
  useEffect(() => {
    if (!running) {
      if (wasRunning.current) {
        if (target?.board.sync.state === "error") toast.error(target.board.sync.last_error || "The sync didn't finish. Try again.");
        else toast.success("Deals are up to date.");
      }
      wasRunning.current = false;
      return;
    }
    wasRunning.current = true;
    const t = window.setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, 3000);
    return () => window.clearInterval(t);
  }, [running, load, target?.board.sync.state, target?.board.sync.last_error, toast]);

  const syncNow = async () => {
    if (!target) return;
    setSyncing(true);
    try {
      const sync = await dealsSync(target.ws);
      setEntries((es) => es && es.map((e) => (e.ws === target.ws ? { ...e, board: { ...e.board, sync } } : e)));
      if (sync.state !== "running") void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't start the sync. Try again.");
    } finally { setSyncing(false); }
  };

  const team = ws ? entries?.[0]?.board.team ?? null : null;
  const crumbs = ws ? (
    <nav className="dl-crumbs" aria-label="Breadcrumb">
      <Link href={`/w/${encodeURIComponent(ws)}`}>{wsName ?? "Workspace"}</Link>
      <Icon name="chevronRight" />
      {team && <><Link href={teamHref(ws, team)}>{team.name}</Link><Icon name="chevronRight" /></>}
      <span aria-current="page">Deals</span>
    </nav>
  ) : null;

  if (locked) {
    return (
      <div className="dl-page" data-testid="deals-locked">
        {crumbs}
        <EmptyState icon="briefcase" title="Deals are available to the HubSpot team"
          description="They show the team's HubSpot deals with their calls and files. Ask a workspace admin if you need them." />
      </div>
    );
  }
  if (error && !entries) return <div className="dl-page">{crumbs}<Alert tone="danger">{error}</Alert></div>;
  if (!entries) {
    return (
      <div className="dl-page" aria-busy>
        <Skeleton variant="text" width={220} height={32} />
        <div className="dl-board dl-board--skeleton">{[0, 1, 2, 3].map((i) => <Skeleton key={i} variant="rect" width={280} height={180 - i * 30} />)}</div>
      </div>
    );
  }
  if (!ws && entries.length === 0) {
    return (
      <div className="dl-page" data-testid="deals-section">
        <h1 className="dl-title">Deals</h1>
        <EmptyState icon="briefcase" title="No HubSpot team yet"
          description="Deals show here when one of your teams is connected to HubSpot. A workspace admin connects it in Integrations." />
      </div>
    );
  }
  return (
    <Loaded entries={entries} ws={ws} crumbs={crumbs} prefs={prefs} setPrefs={setPrefs} target={target}
      syncing={syncing || running} onSync={syncNow} />
  );
}

function Loaded({ entries, ws, crumbs, prefs, setPrefs, target, syncing, onSync }: {
  entries: DealEntry[]; ws: string | null; crumbs: React.ReactNode; prefs: Prefs; setPrefs: (p: Partial<Prefs>) => void;
  target: DealEntry | null; syncing: boolean; onSync: () => void;
}) {
  const all = !ws;
  const teamFilter = all && entries.some((e) => e.ws === prefs.team) ? prefs.team : "";
  const scoped = useMemo(() => (teamFilter ? entries.filter((e) => e.ws === teamFilter) : entries), [entries, teamFilter]);
  const pipelines = useMemo(() => pipelinesOf(scoped), [scoped]);
  const pipeline = pipelines.length > 1 ? (pipelines.includes(prefs.pipeline) ? prefs.pipeline : pipelines[0]!) : "";
  const rows = useMemo(() => rowsOf(scoped), [scoped]);
  const inPipeline = useMemo(() => filterRows(rows, { pipeline, closed: true }), [rows, pipeline]);
  const owners = useMemo(() => ownersOf(inPipeline), [inPipeline]);
  const companies = useMemo(() => companiesOf(inPipeline), [inPipeline]);
  const owner = owners.includes(prefs.owner) ? prefs.owner : "";
  const company = companies.includes(prefs.company) ? prefs.company : "";
  const deals = useMemo(() => filterRows(inPipeline, { owner, company, quiet: prefs.quiet, closed: prefs.closed }), [inPipeline, owner, company, prefs.quiet, prefs.closed]);
  const closedCount = inPipeline.filter((d) => d.closed).length;
  const filtered = !!(owner || company || prefs.quiet);
  const clear = () => setPrefs({ owner: "", company: "", quiet: false });
  const sum = summaryOf(inPipeline);
  const pipelineAmount = compactAmount(sum.amount, sum.currency);
  const portal = (target ?? (scoped.length === 1 ? scoped[0] : null))?.board.portal_url ?? null;
  const sync = target?.board.sync ?? null;
  const canSync = !!target?.board.can_sync;
  const stages = useMemo(() => stagesOf(scoped, pipeline), [scoped, pipeline]);
  const showTeam = all && entries.length > 1 && !teamFilter;
  const empty = rows.length === 0;

  return (
    <div className="dl-page" data-testid="deals-section" data-mode={all ? "all" : "team"}>
      {crumbs}
      <header className="dl-head">
        <div className="dl-head__titles">
          <h1 className="dl-title">Deals</h1>
          {!empty && (
            <p className="dl-summary" data-testid="deals-summary">
              <span>{sum.open} open</span>
              {pipelineAmount && <><span aria-hidden className="dl-sep">·</span><span>{pipelineAmount} in pipeline</span></>}
              {all && entries.length > 1 && <><span aria-hidden className="dl-sep">·</span><span>{teamFilter ? scoped[0]?.board.team?.name ?? scoped[0]?.team : `${entries.length} teams`}</span></>}
              {sync && (
                <><span aria-hidden className="dl-sep">·</span>
                  <span className="dl-synced" data-testid="deals-synced">
                    {syncing ? <><Spinner size={12} /> Syncing…</> : sync.at ? `Synced ${relativeTime(sync.at)}` : "Not synced yet"}
                  </span></>
              )}
            </p>
          )}
        </div>
        <div className="dl-head__actions">
          {all && entries.length > 1 && (
            <Select aria-label="Team" value={teamFilter} onChange={(e) => setPrefs({ team: e.target.value })} className="dl-teamselect" data-testid="deals-team"
              options={[{ value: "", label: "All teams" }, ...entries.map((e) => ({ value: e.ws, label: `${e.board.team?.name ?? e.team ?? "HubSpot team"}${e.wsName ? ` · ${e.wsName}` : ""}` }))]} />
          )}
          {canSync && (
            <Button variant="ghost" iconLeft="refresh" loading={syncing} disabled={syncing} onClick={onSync} data-testid="deals-sync">Sync now</Button>
          )}
          {portal && <Button variant="secondary" iconLeft="external" href={portal} target="_blank" rel="noopener noreferrer" data-testid="deals-open-hubspot">Open HubSpot</Button>}
        </div>
      </header>

      {canSync && sync?.state === "error" && (
        <Alert tone="warning" className="dl-alert" title="The last sync didn't finish">{sync.last_error || "Try Sync now again."}</Alert>
      )}
      {canSync && target && target.board.missing_scopes.length > 0 && (
        <Alert tone="info" className="dl-alert" title="Add these scopes to the HubSpot key to show more">
          <ul className="dl-scopes" data-testid="deals-missing-scopes">
            {target.board.missing_scopes.map((s) => <li key={s.scope}><code>{s.scope}</code>{s.why ? ` · ${s.why}` : s.what ? ` · ${s.what}` : ""}</li>)}
          </ul>
        </Alert>
      )}

      {!empty && (
        <div className="dl-toolbar" role="toolbar" aria-label="View and filters">
          <SegmentedControl<View> size="sm" aria-label="View" value={prefs.view} onChange={(v) => setPrefs({ view: v })}
            options={[{ value: "board", label: "Board", icon: "columns" }, { value: "list", label: "List", icon: "list" }]} />
          {pipelines.length > 1 && (
            <Select aria-label="Pipeline" value={pipeline} onChange={(e) => setPrefs({ pipeline: e.target.value })} className="dl-select"
              options={pipelines.map((p) => ({ value: p, label: p }))} />
          )}
          <Select aria-label="Owner" value={owner} onChange={(e) => setPrefs({ owner: e.target.value })} className="dl-select" data-testid="deals-owner"
            options={[{ value: "", label: "Any owner" }, ...owners.map((o) => ({ value: o, label: o }))]} />
          <Select aria-label="Company" value={company} onChange={(e) => setPrefs({ company: e.target.value })} className="dl-select" data-testid="deals-company"
            options={[{ value: "", label: "Any company" }, ...companies.map((c) => ({ value: c, label: c }))]} />
          <Toggle on={prefs.quiet} icon="clock" onClick={() => setPrefs({ quiet: !prefs.quiet })} testid="deals-quiet">No call in 14 days</Toggle>
          <span className="dl-toolbar__end">
            {filtered && <Button size="sm" variant="ghost" onClick={clear}>Clear</Button>}
            <Toggle on={prefs.group} onClick={() => setPrefs({ group: !prefs.group })} testid="deals-group">Group by company</Toggle>
            {closedCount > 0 && (
              <Toggle on={prefs.closed} onClick={() => setPrefs({ closed: !prefs.closed })} testid="deals-closed">
                Show closed <span className="dl-toggle__n">{closedCount}</span>
              </Toggle>
            )}
          </span>
        </div>
      )}

      {empty ? (
        <EmptyState icon="briefcase" title="No deals yet"
          description={sync?.at || all ? "HubSpot deals show here after the next sync." : "The first sync is on its way. Deals show here when it's done."} />
      ) : deals.length === 0 ? (
        <EmptyState icon="filter" title="No deals match" description="Try another owner or company."
          actions={<Button variant="secondary" onClick={clear}>Clear filters</Button>} />
      ) : prefs.view === "list" ? (
        prefs.group
          ? <Grouped deals={deals} render={(ds) => <DealTable deals={ds} showTeam={showTeam} sort={prefs.sort} dir={prefs.dir} onSort={(sort, dir) => setPrefs({ sort, dir })} />} />
          : <DealTable deals={deals} showTeam={showTeam} sort={prefs.sort} dir={prefs.dir} onSort={(sort, dir) => setPrefs({ sort, dir })} />
      ) : prefs.group ? (
        <Grouped deals={deals} render={(ds) => <div className="dl-grid">{ds.map((d) => <DealTile key={`${d.ws}:${d.id}`} d={d} showStage showTeam={showTeam} />)}</div>} />
      ) : (
        <Board stages={stages} deals={deals} showClosed={prefs.closed} showTeam={showTeam} />
      )}
    </div>
  );
}

function Toggle({ on, icon, onClick, testid, children }: { on: boolean; icon?: string; onClick: () => void; testid: string; children: React.ReactNode }) {
  return (
    <Button size="sm" variant="secondary" iconLeft={icon} aria-pressed={on} onClick={onClick} className="dl-toggle" data-testid={testid}>{children}</Button>
  );
}

/** The board: a column per open stage (in pipeline order; empty ones a thin strip), then Closed won / lost when shown. */
function Board({ stages, deals, showClosed, showTeam }: { stages: ReturnType<typeof stagesOf>; deals: DealRow[]; showClosed: boolean; showTeam: boolean }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const cols = columnsOf(stages, deals, showClosed);
  return (
    <div className="dl-board" data-testid="deals-board" tabIndex={0} aria-label="Deals by stage (scrolls sideways)">
      {cols.map((c) => {
        const n = c.deals.length;
        if (!n) {
          return (
            <div key={c.key} className="dl-strip" role="group" aria-label={`${c.label}: no deals`} data-testid="deals-empty-stage" title={`${c.label} · 0`}>
              <span className="dl-strip__label" aria-hidden>{c.label} · 0</span>
            </div>
          );
        }
        const total = compactTotal(c.deals);
        const open = expanded.has(c.key);
        const shown = visibleCount(n, open);
        return (
          <section key={c.key} className={`dl-col${c.closed ? " dl-col--closed" : ""}`} aria-label={`${c.label}: ${n} ${n === 1 ? "deal" : "deals"}`} data-testid="deals-column">
            <header className="dl-col__head">
              <h2 className="dl-col__name">{c.label}</h2>
              <span className="dl-col__count">{n}</span>
              {total && <span className="dl-col__total">{total}</span>}
            </header>
            <div className="dl-col__cards">
              {c.deals.slice(0, shown).map((d) => <DealTile key={`${d.ws}:${d.id}`} d={d} showStage={!!c.other} showTeam={showTeam} />)}
            </div>
            {shown < n && (
              <Button variant="ghost" size="sm" block className="dl-col__more" data-testid="deals-show-more"
                onClick={() => setExpanded((s) => new Set(s).add(c.key))}>Show {n - shown} more</Button>
            )}
          </section>
        );
      })}
    </div>
  );
}

function DealTile({ d, showStage, showTeam }: { d: DealRow; showStage?: boolean; showTeam?: boolean }) {
  const amount = amountOf(d);
  const close = shortDay(d.close_date);
  const calls = callsLabel(d.calls);
  const signal = signalOf(d);
  const facts = [
    amount && <b key="a" className="dl-card__amount">{amount}</b>,
    close && <span key="c">{close}</span>,
    calls && <span key="n">{calls}</span>,
  ].filter(Boolean);
  const stageBadge = showStage ? (d.closed ? d.closed_label || "Closed" : d.stage) : null;
  return (
    <Link href={dealHref(d.ws, d.id)} className="dl-card" data-testid="deal-card">
      <span className="dl-card__name">{d.name}</span>
      {(d.company || showTeam) && (
        <span className="dl-card__co">{[d.company?.name, showTeam ? d.team : null].filter(Boolean).join(" · ")}</span>
      )}
      {(d.owner || facts.length > 0) && (
        <span className="dl-card__meta">
          {d.owner && <Avatar name={d.owner} size="sm" neutral className="dl-card__avatar" />}
          {facts.map((f, i) => <span key={i} className="dl-card__fact">{i > 0 && <span aria-hidden className="dl-sep">·</span>}{f}</span>)}
        </span>
      )}
      {(signal || stageBadge || d.pick > 0) && (
        <span className="dl-card__badges">
          {stageBadge && <Badge size="sm" tone={d.closed_label === "Closed won" ? "success" : d.closed ? "neutral" : "info"}>{stageBadge}</Badge>}
          {signal && <Badge size="sm" tone={signal.kind === "quiet" ? "warning" : "neutral"} data-testid={signal.kind === "quiet" ? "deal-quiet" : "deal-nocalls"}>{signal.label}</Badge>}
          {d.pick > 0 && <Badge size="sm" tone="info">{d.pick} to file</Badge>}
        </span>
      )}
    </Link>
  );
}

const HEADERS: Array<[SortKey, string, "left" | "right"]> = [
  ["name", "Deal", "left"], ["stage", "Stage", "left"], ["amount", "Amount", "right"], ["owner", "Owner", "left"],
  ["close", "Close date", "left"], ["last", "Calls", "left"],
];

function DealTable({ deals, showTeam, sort, dir, onSort }: {
  deals: DealRow[]; showTeam: boolean; sort: SortKey; dir: "asc" | "desc"; onSort: (k: SortKey, d: "asc" | "desc") => void;
}) {
  const rows = useMemo(() => sortRows(deals, sort, dir), [deals, sort, dir]);
  const head = (k: SortKey, label: string) => {
    const on = sort === k;
    const next = on ? (dir === "asc" ? "desc" : "asc") : k === "amount" || k === "calls" || k === "last" ? "desc" : "asc";
    return (
      <button type="button" className="dl-sort" data-on={on || undefined} onClick={() => onSort(k, next)}
        aria-label={`${label}${on ? `, sorted ${dir === "asc" ? "ascending" : "descending"}` : ""}. Sort ${next === "asc" ? "ascending" : "descending"}`}>
        {label}<Icon name={on && dir === "asc" ? "arrowUp" : "arrowDown"} size={12} aria-hidden />
      </button>
    );
  };
  const render: Record<string, (d: DealRow) => React.ReactNode> = {
    name: (d) => (
      <span className="dl-cell-deal">
        <Link href={dealHref(d.ws, d.id)} className="dl-link">{d.name}</Link>
        {d.company && <span className="dl-cell-sub">{d.company.name}</span>}
      </span>
    ),
    stage: (d) => (d.closed
      ? <Badge size="sm" tone={d.closed_label === "Closed won" ? "success" : "neutral"}>{d.closed_label || "Closed"}</Badge>
      : <span className="dl-nowrap">{d.stage || "—"}</span>),
    amount: (d) => <span className="dl-num">{amountOf(d) ?? "—"}</span>,
    owner: (d) => (d.owner ? <span className="dl-owner"><Avatar name={d.owner} size="sm" neutral /><span className="dl-owner__name">{d.owner}</span></span> : "—"),
    close: (d) => <span className="dl-nowrap">{shortDay(d.close_date) || "—"}</span>,
    // Calls: how many, the last one (a link), and "Quiet N days" / "No calls yet" when it applies.
    last: (d) => {
      const s = signalOf(d);
      if (d.last_call) {
        return (
          <span className="dl-cell-last">
            <span className="dl-num">{d.calls}</span><span aria-hidden className="dl-sep">·</span>
            <Link href={`/${d.last_call.slug}`} className="dl-link dl-nowrap" aria-label={`Last call ${relDay(d.last_call.date) || d.last_call.title}`}>{relDay(d.last_call.date) || d.last_call.title}</Link>
            {s?.kind === "quiet" && <Badge size="sm" tone="warning">{quietLabel(d)}</Badge>}
          </span>
        );
      }
      return s ? <span className="dl-muted dl-nowrap">{s.label}</span> : "—";
    },
  };
  const cols: Column<DealRow>[] = HEADERS.map(([k, label, align]) => ({ key: k, header: head(k, label), align, primary: k === "name", render: render[k] }));
  if (showTeam) cols.splice(1, 0, { key: "team", header: head("team", "Team"), render: (d) => <span className="dl-nowrap">{d.team ?? "—"}</span> });
  return <Table columns={cols} rows={rows} rowKey={(d) => `${d.ws}:${d.id}`} compact caption="Deals" className="dl-table" />;
}

/** Group by company: a heading per company (A–Z, then deals without one), its deals under it. */
function Grouped({ deals, render }: { deals: DealRow[]; render: (deals: DealRow[]) => React.ReactNode }) {
  const groups = useMemo(() => groupByCompany(deals), [deals]);
  return (
    <div className="dl-groups" data-testid="deals-grouped">
      {groups.map(([name, ds]) => {
        const total = compactTotal(ds);
        return (
          <section key={name} className="dl-group" aria-label={name}>
            <h2 className="dl-group__head">
              <Icon name="building" size={16} />
              <span>{name}</span>
              <span className="dl-group__meta">{ds.length} {ds.length === 1 ? "deal" : "deals"}{total ? ` · ${total}` : ""}</span>
            </h2>
            {render(ds)}
          </section>
        );
      })}
    </div>
  );
}
