"use client";

/**
 * /deals/<workspace>?space=team:<id>: the HubSpot team's Deals (backend GET /hubspot/deals/board). Every open deal of
 * the connected HubSpot account, as a BOARD by pipeline stage (a pipeline picker when there are several; closed
 * deals behind "Show closed") or a LIST. Cards: deal, company, amount, owner, last call, calls, a "quiet" badge (no
 * call in 14 days). Filters (owner, company, no call in 14 days), the view and "Group by company" are this viewer's,
 * remembered on this device. The header says when the deals were last synced; workspace admins get Sync now (it
 * runs in the background: the board is asked again every few seconds until it is done) and the missing-scopes note.
 * Only the HubSpot team's members and workspace admins can open it: anyone else (403 / 404) gets a calm note.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Alert, Badge, Button, EmptyState, Icon, Select, SegmentedControl, Skeleton, Spinner, Switch, Table, useToast, type Column,
} from "@/components/ui";
import { relativeTime } from "@/components/dashboard/format";
import { dealsBoard, dealsSync, type DealBoard, type DealCard } from "@/lib/hubspot";
import { dealHref, teamHref } from "@/lib/teams";
import { errorStatus, getWorkspace } from "@/lib/workspaces";
import { useAssistantHere } from "@/components/assistant/store";
import { amountOf, quietLabel, relDay, shortDay, totalOf } from "./format";
import "./deals.css";

type View = "board" | "list";
interface Prefs { view: View; owner: string; company: string; quiet: boolean; group: boolean; pipeline: string; closed: boolean }
const DEFAULTS: Prefs = { view: "board", owner: "", company: "", quiet: false, group: false, pipeline: "", closed: false };
const prefsKey = (ws: string) => `md_deals_view:${ws}`;

function readPrefs(ws: string): Prefs {
  try {
    const raw = window.localStorage.getItem(prefsKey(ws));
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<Prefs>;
    return { ...DEFAULTS, ...p, view: p.view === "list" ? "list" : "board" };
  } catch { return DEFAULTS; }
}
function writePrefs(ws: string, p: Prefs) {
  try { window.localStorage.setItem(prefsKey(ws), JSON.stringify(p)); } catch { /* private window: not remembered */ }
}

const NO_COMPANY = "No company";
const byAmount = (a: DealCard, b: DealCard) => (b.amount ?? -1) - (a.amount ?? -1) || a.name.localeCompare(b.name);

export default function DealsSection({ workspaceId }: { workspaceId: string }) {
  const toast = useToast();
  const [board, setBoard] = useState<DealBoard | null>(null);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wsName, setWsName] = useState<string | null>(null);
  const [prefs, setPrefsState] = useState<Prefs>(DEFAULTS);
  const [syncing, setSyncing] = useState(false);
  useAssistantHere({ workspace: workspaceId });

  useEffect(() => { setPrefsState(readPrefs(workspaceId)); }, [workspaceId]);
  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefsState((p) => { const next = { ...p, ...patch }; writePrefs(workspaceId, next); return next; });
  }, [workspaceId]);

  const load = useCallback(async () => {
    try { setBoard(await dealsBoard(workspaceId)); setError(null); setLocked(false); }
    catch (e) {
      const s = errorStatus(e);
      if (s === 403 || s === 404) setLocked(true);
      else setError(e instanceof Error ? e.message : "Couldn't load the deals.");
    }
  }, [workspaceId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { getWorkspace(workspaceId).then((w) => setWsName(w.name), () => setWsName(null)); }, [workspaceId]);

  // A sync is running: ask again every few seconds (not while the tab is hidden) until it is done.
  const running = board?.sync.state === "running";
  const wasRunning = useRef(false);
  useEffect(() => {
    if (!running) {
      if (wasRunning.current) {
        if (board?.sync.state === "error") toast.error(board.sync.last_error || "The sync didn't finish. Try again.");
        else toast.success("Deals are up to date.");
      }
      wasRunning.current = false;
      return;
    }
    wasRunning.current = true;
    const t = window.setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, 3000);
    return () => window.clearInterval(t);
  }, [running, load, board?.sync.state, board?.sync.last_error, toast]);

  const syncNow = async () => {
    setSyncing(true);
    try {
      const sync = await dealsSync(workspaceId);
      setBoard((b) => (b ? { ...b, sync } : b));
      if (sync.state !== "running") void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't start the sync. Try again.");
    } finally { setSyncing(false); }
  };

  const crumbs = (
    <nav className="dl-crumbs" aria-label="Breadcrumb">
      <Link href={`/w/${encodeURIComponent(workspaceId)}`}>{wsName ?? "Workspace"}</Link>
      <Icon name="chevronRight" />
      {board?.team && <><Link href={teamHref(workspaceId, board.team)}>{board.team.name}</Link><Icon name="chevronRight" /></>}
      <span aria-current="page">Deals</span>
    </nav>
  );

  if (locked) {
    return (
      <div className="dl-page" data-testid="deals-locked">
        {crumbs}
        <EmptyState icon="briefcase" title="Deals are available to the HubSpot team"
          description="They show the team's HubSpot deals with their calls and files. Ask a workspace admin if you need them." />
      </div>
    );
  }
  if (error && !board) return <div className="dl-page">{crumbs}<Alert tone="danger">{error}</Alert></div>;
  if (!board) {
    return (
      <div className="dl-page" aria-busy>
        <Skeleton variant="text" width={180} height={32} />
        <div className="dl-board" style={{ marginTop: 24 }}>{[0, 1, 2].map((i) => <Skeleton key={i} variant="rect" width={272} height={280} />)}</div>
      </div>
    );
  }
  return <Loaded board={board} workspaceId={workspaceId} crumbs={crumbs} prefs={prefs} setPrefs={setPrefs} syncing={syncing || running} onSync={syncNow} />;
}

function Loaded({ board, workspaceId, crumbs, prefs, setPrefs, syncing, onSync }: {
  board: DealBoard; workspaceId: string; crumbs: React.ReactNode; prefs: Prefs; setPrefs: (p: Partial<Prefs>) => void;
  syncing: boolean; onSync: () => void;
}) {
  const pipelines = board.pipelines;
  const pipeline = pipelines.length > 1 ? (pipelines.some((p) => p.id === prefs.pipeline) ? prefs.pipeline : pipelines[0]!.id) : "";
  const inPipeline = useMemo(() => board.deals.filter((d) => !pipeline || d.pipeline_id === pipeline), [board.deals, pipeline]);
  const owners = useMemo(() => [...new Set(inPipeline.map((d) => d.owner).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b)), [inPipeline]);
  const companies = useMemo(() => [...new Set(inPipeline.map((d) => d.company?.name).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b)), [inPipeline]);
  const owner = owners.includes(prefs.owner) ? prefs.owner : "";
  const company = companies.includes(prefs.company) ? prefs.company : "";
  const deals = useMemo(() => inPipeline.filter((d) => (prefs.closed || !d.closed)
    && (!owner || d.owner === owner) && (!company || d.company?.name === company) && (!prefs.quiet || d.quiet)).sort(byAmount),
  [inPipeline, prefs.closed, prefs.quiet, owner, company]);
  const closedCount = inPipeline.filter((d) => d.closed).length;
  const filtered = !!(owner || company || prefs.quiet);
  const sync = board.sync;

  return (
    <div className="dl-page" data-testid="deals-section">
      {crumbs}
      <header className="dl-head">
        <div className="dl-head__titles">
          <h1 className="dl-title">Deals</h1>
          <p className="dl-sub">Every open HubSpot deal, with its calls and files.</p>
        </div>
        <div className="dl-head__actions">
          <span className="dl-synced" data-testid="deals-synced">
            {syncing ? <><Spinner size={14} /> Syncing…</> : sync.at ? `Synced ${relativeTime(sync.at)}` : "Not synced yet"}
          </span>
          {board.can_sync && (
            <Button variant="secondary" iconLeft="refresh" loading={syncing} disabled={syncing} onClick={onSync} data-testid="deals-sync">Sync now</Button>
          )}
        </div>
      </header>

      {board.can_sync && sync.state === "error" && (
        <Alert tone="warning" className="dl-alert" title="The last sync didn't finish">{sync.last_error || "Try Sync now again."}</Alert>
      )}
      {board.can_sync && board.missing_scopes.length > 0 && (
        <Alert tone="info" className="dl-alert" title="Add these scopes to the HubSpot key to show more" >
          <ul className="dl-scopes" data-testid="deals-missing-scopes">
            {board.missing_scopes.map((s) => <li key={s.scope}><code>{s.scope}</code>{s.why ? ` · ${s.why}` : s.what ? ` · ${s.what}` : ""}</li>)}
          </ul>
        </Alert>
      )}

      <div className="dl-filters" role="group" aria-label="Filter deals">
        <SegmentedControl<View> size="sm" aria-label="View" value={prefs.view} onChange={(v) => setPrefs({ view: v })}
          options={[{ value: "board", label: "Board", icon: "columns" }, { value: "list", label: "List", icon: "list" }]} />
        {pipelines.length > 1 && (
          <Select aria-label="Pipeline" value={pipeline} onChange={(e) => setPrefs({ pipeline: e.target.value })} className="dl-select"
            options={pipelines.map((p) => ({ value: p.id, label: p.label }))} />
        )}
        <Select aria-label="Owner" value={owner} onChange={(e) => setPrefs({ owner: e.target.value })} className="dl-select" data-testid="deals-owner"
          options={[{ value: "", label: "Any owner" }, ...owners.map((o) => ({ value: o, label: o }))]} />
        <Select aria-label="Company" value={company} onChange={(e) => setPrefs({ company: e.target.value })} className="dl-select" data-testid="deals-company"
          options={[{ value: "", label: "Any company" }, ...companies.map((c) => ({ value: c, label: c }))]} />
        <Switch label="No call in 14 days" checked={prefs.quiet} onChange={(e) => setPrefs({ quiet: e.currentTarget.checked })} data-testid="deals-quiet" />
        <Switch label="Group by company" checked={prefs.group} onChange={(e) => setPrefs({ group: e.currentTarget.checked })} data-testid="deals-group" />
        {closedCount > 0 && (
          <Switch label={`Show closed (${closedCount})`} checked={prefs.closed} onChange={(e) => setPrefs({ closed: e.currentTarget.checked })} data-testid="deals-closed" />
        )}
        {filtered && <Button size="sm" variant="ghost" onClick={() => setPrefs({ owner: "", company: "", quiet: false })}>Clear filters</Button>}
      </div>

      {board.deals.length === 0 ? (
        <EmptyState icon="briefcase" title="No open deals yet"
          description={sync.at ? "Open deals in HubSpot show here after the next sync." : "The first sync is on its way. Deals show here when it's done."} />
      ) : deals.length === 0 ? (
        <EmptyState icon="filter" title="No deals match" description="Try another owner or company."
          actions={<Button variant="secondary" onClick={() => setPrefs({ owner: "", company: "", quiet: false })}>Clear filters</Button>} />
      ) : prefs.view === "list" ? (
        prefs.group ? <Grouped deals={deals} render={(ds) => <DealTable deals={ds} ws={workspaceId} />} /> : <DealTable deals={deals} ws={workspaceId} />
      ) : prefs.group ? (
        <Grouped deals={deals} render={(ds) => <div className="dl-grid">{ds.map((d) => <DealTile key={d.id} d={d} ws={workspaceId} showStage />)}</div>} />
      ) : (
        <Board board={board} deals={deals} pipeline={pipeline} ws={workspaceId} showClosed={prefs.closed} />
      )}
    </div>
  );
}

/** The board: a column per open stage of the pipeline (in order), then Closed (when shown). */
function Board({ board, deals, pipeline, ws, showClosed }: { board: DealBoard; deals: DealCard[]; pipeline: string; ws: string; showClosed: boolean }) {
  const stages = board.stages.filter((s) => !s.closed && (!pipeline || s.pipeline_id === pipeline));
  const known = new Set(stages.map((s) => s.id));
  const cols: Array<{ id: string; label: string; deals: DealCard[] }> = stages.map((s) => ({ id: s.id, label: s.label, deals: deals.filter((d) => !d.closed && d.stage_id === s.id) }));
  const other = deals.filter((d) => !d.closed && (!d.stage_id || !known.has(d.stage_id)));
  if (other.length) cols.push({ id: "_other", label: "Other stages", deals: other });
  if (showClosed) cols.push({ id: "_closed", label: "Closed", deals: deals.filter((d) => d.closed) });
  return (
    <div className="dl-board" data-testid="deals-board">
      {cols.map((c) => {
        const total = totalOf(c.deals);
        return (
          <section key={c.id} className="dl-col" aria-label={`${c.label}: ${c.deals.length} ${c.deals.length === 1 ? "deal" : "deals"}`}>
            <header className="dl-col__head">
              <span className="dl-col__name">{c.label}</span>
              <span className="dl-col__count">{c.deals.length}</span>
              {total && <span className="dl-col__total">{total}</span>}
            </header>
            <div className="dl-col__cards">
              {c.deals.map((d) => <DealTile key={d.id} d={d} ws={ws} showStage={c.id === "_other"} />)}
              {!c.deals.length && <p className="dl-col__empty">No deals</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function DealTile({ d, ws, showStage }: { d: DealCard; ws: string; showStage?: boolean }) {
  const amount = amountOf(d);
  return (
    <Link href={dealHref(ws, d.id)} className="dl-card" data-testid="deal-card">
      <span className="dl-card__name">{d.name}</span>
      {d.company && <span className="dl-card__co">{d.company.name}</span>}
      {(amount || d.owner) && (
        <span className="dl-card__line">
          {amount && <b className="dl-card__amount">{amount}</b>}
          {d.owner && <span className="dl-card__owner"><Icon name="user" size={12} />{d.owner}</span>}
        </span>
      )}
      <span className="dl-card__meta">
        <Icon name="mic" size={12} />
        {d.calls ? `${d.calls} ${d.calls === 1 ? "call" : "calls"}` : "No calls"}
        {d.last_call?.date ? ` · last ${relDay(d.last_call.date)}` : ""}
      </span>
      {(showStage || d.closed || (d.quiet && !d.closed) || d.pick > 0) && (
        <span className="dl-card__badges">
          {showStage && !d.closed && d.stage && <Badge size="sm" tone="info">{d.stage}</Badge>}
          {d.closed && <Badge size="sm" tone={d.closed_label === "Closed won" ? "success" : "neutral"}>{d.closed_label || "Closed"}</Badge>}
          {d.quiet && !d.closed && <Badge size="sm" tone="warning" data-testid="deal-quiet">{quietLabel(d)}</Badge>}
          {d.pick > 0 && <Badge size="sm" tone="neutral">{d.pick} to file</Badge>}
        </span>
      )}
    </Link>
  );
}

function DealTable({ deals, ws }: { deals: DealCard[]; ws: string }) {
  const cols: Column<DealCard>[] = [
    { key: "name", header: "Deal", primary: true, render: (d) => (
      <span className="dl-cell-deal">
        <Link href={dealHref(ws, d.id)} className="dl-link">{d.name}</Link>
        {d.quiet && !d.closed && <Badge size="sm" tone="warning">{quietLabel(d)}</Badge>}
      </span>
    ) },
    { key: "company", header: "Company", render: (d) => d.company?.name ?? "—" },
    { key: "stage", header: "Stage", render: (d) => (d.closed ? d.closed_label || "Closed" : d.stage || "—") },
    { key: "amount", header: "Amount", align: "right", render: (d) => amountOf(d) ?? "—" },
    { key: "owner", header: "Owner", render: (d) => d.owner ?? "—" },
    { key: "close", header: "Close date", render: (d) => shortDay(d.close_date) || "—" },
    { key: "last", header: "Last call", render: (d) => (d.last_call ? <Link href={`/${d.last_call.slug}`} className="dl-link">{relDay(d.last_call.date) || d.last_call.title}</Link> : "—") },
    { key: "calls", header: "Calls", align: "right", render: (d) => d.calls },
  ];
  return <Table columns={cols} rows={deals} rowKey={(d) => d.id} compact caption="Deals" className="dl-table" />;
}

/** Group by company: a heading per company (A–Z, then deals without one), its deals under it. */
function Grouped({ deals, render }: { deals: DealCard[]; render: (deals: DealCard[]) => React.ReactNode }) {
  const groups = useMemo(() => {
    const m = new Map<string, DealCard[]>();
    for (const d of deals) {
      const k = d.company?.name || NO_COMPANY;
      m.set(k, [...(m.get(k) ?? []), d]);
    }
    return [...m.entries()].sort(([a], [b]) => (a === NO_COMPANY ? 1 : b === NO_COMPANY ? -1 : a.localeCompare(b)));
  }, [deals]);
  return (
    <div className="dl-groups" data-testid="deals-grouped">
      {groups.map(([name, ds]) => {
        const total = totalOf(ds);
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
