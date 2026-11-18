"use client";

/**
 * /deals/<workspace>/<deal id>: one HubSpot deal (backend GET /hubspot/deals/{id}). The header: "<Company> — <Deal>",
 * stage, amount, owner, close date, Closed won / lost, Open in HubSpot and the Deal overview page (the team's own
 * notes). Tabs:
 *   - Overview: the deal's facts, its contacts, suggested deal updates (Apply / Dismiss, the meeting endpoints) and
 *     the roll-up across its calls (decisions, objections and risks, open questions, next steps, last call), each
 *     line linking to its call.
 *   - Calls: the calls filed in the deal, newest first, each with Log to HubSpot and Create tasks; then the calls
 *     waiting for someone to pick their deal (the company has several open deals): File here.
 *   - Assets: the deal folder's files (the workspace items API; uploads go into the folder), each with its views and
 *     analytics, and the deal's HubSpot attachments as links (never imported).
 *   - HubSpot activity: notes, emails, meetings and tasks, newest first.
 * A scope the HubSpot key lacks: admins are told what to add, everyone else that it isn't shown. Only the HubSpot
 * team's members and workspace admins can open it (403 / 404: a calm note).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Alert, Badge, Button, EmptyState, FileIcon, Icon, IconButton, Skeleton, Spinner, Tabs, useToast,
} from "@/components/ui";
import { relativeTime } from "@/components/dashboard/format";
import { docHref } from "@/components/analytics/format";
import { useAssistantHere } from "@/components/assistant/store";
import { hasFiles, useUploads } from "@/components/workspace/uploads/UploadProvider";
import {
  dealDetail, hubspotApply, hubspotCreateTasks, hubspotDismiss, hubspotLog, hubspotMeeting, hubspotSetMatch,
  type DealCallRow, type DealDetail, type DealLine, type HubSpotSuggestion, type HubSpotTask,
} from "@/lib/hubspot";
import { teamDealsHref, teamHref } from "@/lib/teams";
import { teamsSlot, useTeamsSidebar } from "@/lib/teamsStore";
import { errorStatus, listWorkspaceItems, openHref, type WorkspaceItem } from "@/lib/workspaces";
import { useWorkspaceChanged } from "@/lib/workspaceStore";
import { HOW, MissingScopeHint, SuggestionItems, TaskChecklist, failMessage, logOk, shortWhen, tasksOk } from "../parts";
import { amountOf, fmtSize, relDay, shortDay } from "./format";
import "./deals.css";

type Tab = "overview" | "calls" | "assets" | "activity";
const TABS: Tab[] = ["overview", "calls", "assets", "activity"];

export default function DealView({ workspaceId, dealId }: { workspaceId: string; dealId: string }) {
  const toast = useToast();
  const [data, setData] = useState<DealDetail | null>(null);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTabState] = useState<Tab>("overview");
  useAssistantHere({ workspace: workspaceId });
  useTeamsSidebar([workspaceId]);
  const td = teamsSlot(workspaceId);
  const team = td ? td.teams.find((t) => t.hubspot) ?? null : null;
  const sectionHref = team ? teamDealsHref(workspaceId, team) : `/deals/${encodeURIComponent(workspaceId)}`;

  // ?tab= keeps the tab across reloads and links.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab") as Tab | null;
    if (t && TABS.includes(t)) setTabState(t);
  }, []);
  const setTab = useCallback((t: Tab) => {
    setTabState(t);
    try {
      const u = new URL(window.location.href);
      if (t === "overview") u.searchParams.delete("tab"); else u.searchParams.set("tab", t);
      window.history.replaceState(window.history.state, "", `${u.pathname}${u.search}${u.hash}`);
    } catch { /* keep the tab in memory only */ }
  }, []);

  const load = useCallback(async (fresh = false) => {
    try { setData(await dealDetail(workspaceId, dealId, fresh)); setError(null); setLocked(false); }
    catch (e) {
      const s = errorStatus(e);
      if (s === 403 || s === 404) setLocked(true);
      else setError(e instanceof Error ? e.message : "Couldn't load this deal.");
    }
  }, [workspaceId, dealId]);
  useEffect(() => { void load(); }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
    toast.success("Up to date with HubSpot.");
  };

  const crumbs = (
    <nav className="dl-crumbs" aria-label="Breadcrumb">
      {team && <><Link href={teamHref(workspaceId, team)}>{team.name}</Link><Icon name="chevronRight" /></>}
      <Link href={sectionHref}>Deals</Link>
      {data && <><Icon name="chevronRight" /><span aria-current="page">{data.deal.title}</span></>}
    </nav>
  );

  if (locked) {
    return (
      <div className="dl-page dl-page--deal" data-testid="deal-locked">
        <EmptyState icon="briefcase" title="Deals are available to the HubSpot team"
          description="This deal is shown to the team's members and workspace admins." />
      </div>
    );
  }
  if (error && !data) return <div className="dl-page dl-page--deal">{crumbs}<Alert tone="danger">{error}</Alert></div>;
  if (!data) {
    return (
      <div className="dl-page dl-page--deal" aria-busy>
        <Skeleton variant="text" width={320} height={32} />
        <Skeleton variant="rect" height={240} className="mt-6" />
      </div>
    );
  }

  const d = data.deal;
  const amount = amountOf(d);
  const facts = [
    amount,
    d.owner ? `Owner ${d.owner}` : null,
    d.close_date ? `Closes ${shortDay(d.close_date)}` : null,
  ].filter(Boolean).join(" · ");
  const openSuggestions = data.suggestions.reduce((a, g) => a + g.items.filter((i) => i.state === "open" || i.state === "failed").length, 0);

  return (
    <div className="dl-page dl-page--deal" data-testid="deal-page">
      {crumbs}
      <header className="dl-head">
        <div className="dl-head__titles">
          <h1 className="dl-title">{d.title}</h1>
          <p className="dl-deal-facts">
            {d.closed
              ? <Badge tone={d.closed_label === "Closed won" ? "success" : "neutral"}>{d.closed_label || "Closed"}</Badge>
              : d.stage && <Badge tone="info">{d.stage}</Badge>}
            {facts && <span>{facts}</span>}
          </p>
        </div>
        <div className="dl-head__actions">
          {data.overview && <Button variant="secondary" iconLeft="doc" href={data.overview.href} data-testid="deal-overview-link">Deal overview</Button>}
          {d.url && <Button variant="secondary" iconLeft="external" href={d.url} target="_blank" rel="noopener noreferrer" data-testid="deal-hubspot-link">Open in HubSpot</Button>}
          <IconButton icon="refresh" label="Refresh from HubSpot" variant="secondary" loading={refreshing} disabled={refreshing} onClick={() => void refresh()} />
        </div>
      </header>

      <Tabs value={tab} onChange={(v) => setTab(v as Tab)} aria-label="Deal" idPrefix="deal" className="dl-tabs"
        items={[
          { value: "overview", label: "Overview", count: openSuggestions || undefined },
          { value: "calls", label: "Calls", count: data.calls.length + data.pick.length || undefined },
          { value: "assets", label: "Assets" },
          { value: "activity", label: "HubSpot activity" },
        ]} />
      <div role="tabpanel" id={`deal-panel-${tab}`} aria-labelledby={`deal-tab-${tab}`} className="dl-panel">
        {tab === "overview" && <Overview data={data} setData={setData} onCalls={() => setTab("calls")} />}
        {tab === "calls" && <Calls data={data} setData={setData} reload={() => load()} />}
        {tab === "assets" && <Assets ws={workspaceId} data={data} />}
        {tab === "activity" && <Activity data={data} />}
      </div>
    </div>
  );
}

/* ── Overview ─────────────────────────────────────────────────────────── */

function Overview({ data, setData, onCalls }: { data: DealDetail; setData: React.Dispatch<React.SetStateAction<DealDetail | null>>; onCalls: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState("");
  const d = data.deal;
  const r = data.rollup;
  const act = async (mid: string, it: HubSpotSuggestion, kind: "apply" | "dismiss") => {
    setBusy(`${kind}:${it.id}`);
    try {
      const p = kind === "apply" ? await hubspotApply(mid, it.id) : await hubspotDismiss(mid, it.id);
      setData((cur) => cur && {
        ...cur,
        deals_write: p.deals_write ?? cur.deals_write,
        suggestions: cur.suggestions.map((g) => (g.meeting_id === mid ? { ...g, items: p.suggestions?.items ?? g.items } : g)),
      });
      toast.success(kind === "apply" ? `${it.label} updated in HubSpot.` : "Dismissed.");
    } catch (e) {
      toast.error(failMessage(e));
    } finally { setBusy(""); }
  };
  const rows: Array<[string, string | null]> = [
    ["Stage", d.closed ? d.closed_label || "Closed" : d.stage],
    ["Amount", amountOf(d)],
    ["Owner", d.owner],
    ["Close date", shortDay(d.close_date) || null],
    ["Pipeline", d.pipeline],
    ["Company", d.company?.name ?? null],
  ];
  const groups: Array<[string, DealLine[]]> = [
    ["Decisions", r.decisions], ["Objections and risks", r.risks], ["Open questions", r.questions], ["Next steps", r.next_steps],
  ];
  const anyRollup = groups.some(([, ls]) => ls.length > 0) || !!r.last_call;
  return (
    <div className="dl-overview">
      <div className="dl-overview__side">
        <section className="dl-card-box" aria-labelledby="dl-facts">
          <h2 className="dl-h2" id="dl-facts">Deal</h2>
          <dl className="dl-facts">
            {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v || "—"}</dd></div>)}
          </dl>
        </section>
        <section className="dl-card-box" aria-labelledby="dl-contacts">
          <h2 className="dl-h2" id="dl-contacts">Contacts</h2>
          {d.contacts.length === 0 ? <p className="dl-muted">No contacts on the deal.</p> : (
            <ul className="dl-contacts">
              {d.contacts.map((c) => (
                <li key={c.id}>
                  {c.url ? <a href={c.url} target="_blank" rel="noopener noreferrer" className="dl-link">{c.name || c.email || "Contact"}</a> : <b>{c.name || c.email}</b>}
                  {c.title && <span className="dl-muted">{c.title}</span>}
                  {c.email && <a href={`mailto:${c.email}`} className="dl-muted dl-email">{c.email}</a>}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="dl-card-box" aria-labelledby="dl-notes">
          <h2 className="dl-h2" id="dl-notes">Team notes</h2>
          <p className="dl-muted">Your own notes live on the deal&apos;s overview page. Markdrop keeps its deal section up to date and leaves the rest alone.</p>
          {data.overview
            ? <Button size="sm" variant="secondary" iconLeft="doc" href={data.overview.href}>Open Deal overview</Button>
            : <p className="dl-muted">The overview page is made on the next sync.</p>}
        </section>
      </div>

      <div className="dl-overview__main">
        {data.suggestions.length > 0 && (
          <section className="dl-card-box" aria-labelledby="dl-sugg" data-testid="deal-suggestions">
            <h2 className="dl-h2" id="dl-sugg">Suggested deal updates</h2>
            <p className="dl-muted">From the calls. Nothing changes in HubSpot until you apply it.</p>
            {data.suggestions.map((g) => (
              <div key={g.meeting_id} className="dl-sugg">
                <p className="dl-sugg__from">From <Link href={`/${g.slug}`} className="dl-link">{g.title}</Link>{g.date ? ` · ${shortDay(g.date)}` : ""}</p>
                <SuggestionItems items={g.items} dealsWrite={data.deals_write} busy={busy}
                  onApply={(it) => void act(g.meeting_id, it, "apply")} onDismiss={(it) => void act(g.meeting_id, it, "dismiss")} />
              </div>
            ))}
          </section>
        )}
        <section className="dl-card-box" aria-labelledby="dl-rollup" data-testid="deal-rollup">
          <h2 className="dl-h2" id="dl-rollup">From the calls</h2>
          {!anyRollup ? (
            <p className="dl-muted">Nothing yet. Decisions, risks, questions and next steps show here once calls are filed in this deal.
              {data.pick.length > 0 && <> <button type="button" className="dl-linkbtn" onClick={onCalls}>{data.pick.length} {data.pick.length === 1 ? "call is" : "calls are"} waiting to be filed.</button></>}
            </p>
          ) : (
            <>
              {r.last_call && (
                <p className="dl-lastcall">Last call: <Link href={`/${r.last_call.slug}`} className="dl-link">{r.last_call.title}</Link>{r.last_call.date ? ` · ${relDay(r.last_call.date)}` : ""}</p>
              )}
              {groups.filter(([, ls]) => ls.length > 0).map(([label, ls]) => (
                <div key={label} className="dl-rollup">
                  <h3 className="dl-h3">{label}</h3>
                  <ul className="dl-lines">
                    {ls.map((l, i) => (
                      <li key={`${l.slug}:${i}`}>
                        <span>{l.text}</span>
                        <Link href={`/${l.slug}`} className="dl-line__src">{l.date ? shortDay(l.date) : "The call"}</Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/* ── Calls ────────────────────────────────────────────────────────────── */

function Calls({ data, setData, reload }: { data: DealDetail; setData: React.Dispatch<React.SetStateAction<DealDetail | null>>; reload: () => Promise<void> }) {
  const toast = useToast();
  const [filing, setFiling] = useState("");
  const patchCall = (mid: string, p: Partial<DealCallRow>) =>
    setData((cur) => cur && { ...cur, calls: cur.calls.map((c) => (c.meeting_id === mid ? { ...c, ...p } : c)) });
  const fileHere = async (c: DealCallRow) => {
    setFiling(c.meeting_id);
    try {
      await hubspotSetMatch(c.meeting_id, data.deal.id);
      toast.success("Filed in this deal.");
      await reload();
    } catch (e) {
      toast.error(failMessage(e));
    } finally { setFiling(""); }
  };
  return (
    <div className="dl-calls">
      {data.pick.length > 0 && (
        <section className="dl-card-box" aria-labelledby="dl-pick" data-testid="deal-pick">
          <h2 className="dl-h2" id="dl-pick">Waiting for you to pick the deal</h2>
          <p className="dl-muted">These calls match the company, which has several open deals. File the ones that belong here.</p>
          <ul className="dl-rows">
            {data.pick.map((c) => (
              <li key={c.meeting_id} className="dl-row">
                <span className="dl-row__main">
                  <Link href={c.href} className="dl-link">{c.title}</Link>
                  <span className="dl-muted">{[shortDay(c.date), c.how ? `matched by ${HOW[c.how] ?? c.how}` : null].filter(Boolean).join(" · ")}</span>
                </span>
                <Button size="sm" variant="secondary" loading={filing === c.meeting_id} disabled={!!filing} onClick={() => void fileHere(c)} data-testid="deal-file-here">File here</Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="dl-card-box" aria-labelledby="dl-calls-h" data-testid="deal-calls">
        <h2 className="dl-h2" id="dl-calls-h">Calls</h2>
        {data.calls.length === 0 ? <p className="dl-muted">No calls filed in this deal yet.</p> : (
          <ul className="dl-rows">
            {data.calls.map((c) => <CallItem key={c.meeting_id} c={c} onChange={(p) => patchCall(c.meeting_id, p)} />)}
          </ul>
        )}
      </section>
    </div>
  );
}

function CallItem({ c, onChange }: { c: DealCallRow; onChange: (p: Partial<DealCallRow>) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState("");
  const [tasks, setTasks] = useState<HubSpotTask[] | null>(null);
  const [showTasks, setShowTasks] = useState(false);
  const log = async () => {
    setBusy("log");
    try {
      const p = await hubspotLog(c.meeting_id);
      onChange({ logged: { at: p.logged?.at ?? new Date().toISOString() } });
      toast.success(logOk(p));
    } catch (e) { toast.error(failMessage(e)); } finally { setBusy(""); }
  };
  const openTasks = async () => {
    if (showTasks) { setShowTasks(false); return; }
    setShowTasks(true);
    if (tasks) return;
    setBusy("load");
    try { setTasks((await hubspotMeeting(c.meeting_id)).tasks); }
    catch (e) { toast.error(failMessage(e)); setShowTasks(false); }
    finally { setBusy(""); }
  };
  const create = async (keys: string[]) => {
    setBusy("tasks");
    try {
      const p = await hubspotCreateTasks(c.meeting_id, keys);
      setTasks(p.tasks);
      onChange({ tasks_created: p.tasks.filter((t) => t.created).length });
      toast.success(tasksOk(p));
      return true;
    } catch (e) { toast.error(failMessage(e)); return false; } finally { setBusy(""); }
  };
  const meta = [
    shortDay(c.date),
    c.actions ? `${c.actions} action ${c.actions === 1 ? "item" : "items"}` : null,
    c.tasks_created ? `${c.tasks_created} in HubSpot` : null,
  ].filter(Boolean).join(" · ");
  return (
    <li className="dl-row dl-row--call" data-testid="deal-call">
      <span className="dl-row__main">
        <Link href={c.href} className="dl-link">{c.title}</Link>
        <span className="dl-muted">{meta}</span>
        <span className="dl-row__badges">
          {c.logged ? <Badge size="sm" tone="success">Logged {shortWhen(c.logged.at)}</Badge> : null}
          {c.suggestions_open > 0 && <Badge size="sm" tone="info">{c.suggestions_open} suggested {c.suggestions_open === 1 ? "update" : "updates"}</Badge>}
        </span>
      </span>
      <span className="dl-row__actions">
        <Button size="sm" variant={c.logged ? "ghost" : "secondary"} iconLeft="send" loading={busy === "log"} disabled={!!busy} onClick={() => void log()} data-testid="deal-call-log">
          {c.logged ? "Update in HubSpot" : "Log to HubSpot"}
        </Button>
        {c.actions > 0 && (
          <Button size="sm" variant="ghost" iconLeft="checkSquare" aria-expanded={showTasks} loading={busy === "load"} disabled={busy === "log"}
            onClick={() => void openTasks()} data-testid="deal-call-tasks">Create tasks</Button>
        )}
      </span>
      {showTasks && (
        <div className="dl-row__tasks">
          {tasks ? <TaskChecklist tasks={tasks} busy={busy === "tasks"} onCreate={create} /> : <Spinner size={14} />}
        </div>
      )}
    </li>
  );
}

/* ── Assets ───────────────────────────────────────────────────────────── */

function Assets({ ws, data }: { ws: string; data: DealDetail }) {
  const uploads = useUploads();
  const folder = data.folder;
  const [items, setItems] = useState<WorkspaceItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const load = useCallback(async () => {
    if (!folder) return;
    try { setItems((await listWorkspaceItems(ws, { folder: folder.id, limit: 100 })).items); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't load the files."); }
  }, [ws, folder]);
  useEffect(() => { void load(); }, [load]);
  useWorkspaceChanged(ws, load);
  const target = useMemo(() => (uploads && folder ? uploads.resolve(ws, folder.id, folder.name) : null), [uploads, ws, folder]);
  // Calls (meeting pages and transcripts) and the overview are on the other tabs: here, the files.
  const callSlugs = useMemo(() => new Set([...data.calls.map((c) => c.slug), ...(data.overview ? [data.overview.slug] : [])]), [data.calls, data.overview]);
  const files = (items ?? []).filter((it) => !callSlugs.has(it.slug));
  const att = data.attachments;
  return (
    <div className="dl-assets">
      <section
        className={`dl-card-box dl-drop${over ? " dl-drop--over" : ""}`} aria-labelledby="dl-files" data-testid="deal-assets"
        onDragOver={target ? (e) => { if (hasFiles(e)) { e.preventDefault(); setOver(true); } } : undefined}
        onDragLeave={target ? () => setOver(false) : undefined}
        onDrop={target ? (e) => { if (!hasFiles(e)) return; e.preventDefault(); setOver(false); uploads!.upload(Array.from(e.dataTransfer.files), target); } : undefined}
      >
        <div className="dl-box-head">
          <h2 className="dl-h2" id="dl-files">Files</h2>
          {target && <Button size="sm" iconLeft="upload" onClick={() => uploads!.pick(target)} data-testid="deal-upload">Upload</Button>}
        </div>
        {!folder ? <p className="dl-muted">This deal&apos;s folder is made on the next sync.</p>
          : error ? <Alert tone="danger">{error}</Alert>
          : !items ? <Skeleton variant="rect" height={96} />
          : files.length === 0 ? <p className="dl-muted">No files yet. Upload decks, proposals and one-pagers here{target ? ", or drop them on this box" : ""}: you see who viewed them.</p>
          : (
            <ul className="dl-rows">
              {files.map((it) => (
                <li key={it.slug} className="dl-row">
                  <FileIcon name={it.original_filename || it.title || ""} mime={it.mime || ""} size={20} />
                  <span className="dl-row__main">
                    <Link href={openHref(it.slug, it.url, it.encrypted)} className="dl-link">{it.title || it.original_filename || "Untitled"}</Link>
                    <span className="dl-muted">
                      {[it.type_label || (it.kind === "markdown" ? "Document" : null), it.owner?.name, relativeTime(it.updated_at),
                        it.views != null ? `${it.views} ${it.views === 1 ? "view" : "views"}` : null].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  {it.can.edit && <Button size="sm" variant="ghost" iconLeft="chart" href={docHref(it.slug)}>Analytics</Button>}
                </li>
              ))}
            </ul>
          )}
      </section>
      <section className="dl-card-box" aria-labelledby="dl-att" data-testid="deal-attachments">
        <h2 className="dl-h2" id="dl-att">HubSpot attachments</h2>
        {att.items.length === 0 && !att.missing.length && <p className="dl-muted">No attachments on the deal in HubSpot.</p>}
        {att.items.length > 0 && (
          <ul className="dl-rows">
            {att.items.map((a) => (
              <li key={a.id} className="dl-row">
                <FileIcon name={a.name} size={20} />
                <span className="dl-row__main">
                  <span className="dl-row__title">{a.name}</span>
                  <span className="dl-muted">{[a.ext?.toUpperCase(), fmtSize(a.size), relativeTime(a.at)].filter(Boolean).join(" · ")}</span>
                </span>
                <Button size="sm" variant="ghost" iconLeft="external" href={a.url} target="_blank" rel="noopener noreferrer">Open in HubSpot</Button>
              </li>
            ))}
          </ul>
        )}
        <MissingScopeHint missing={att.missing} admin={data.can_sync} />
      </section>
    </div>
  );
}

/* ── HubSpot activity ─────────────────────────────────────────────────── */

const KIND: Record<string, { icon: string; label: string }> = {
  note: { icon: "edit", label: "Note" },
  email: { icon: "mail", label: "Email" },
  meeting: { icon: "calendar", label: "Meeting" },
  task: { icon: "checkSquare", label: "Task" },
  call: { icon: "phone", label: "Call" },
};

function Activity({ data }: { data: DealDetail }) {
  const a = data.activity;
  return (
    <section className="dl-card-box" aria-labelledby="dl-act" data-testid="deal-activity">
      <div className="dl-box-head">
        <h2 className="dl-h2" id="dl-act">HubSpot activity</h2>
        {a.at && <span className="dl-muted">As of {relativeTime(a.at)}</span>}
      </div>
      <MissingScopeHint missing={a.missing} admin={data.can_sync} />
      {a.items.length === 0 ? <p className="dl-muted">No notes, emails, meetings or tasks on the deal yet.</p> : (
        <ol className="dl-timeline">
          {a.items.map((x) => {
            const k = KIND[x.kind] ?? { icon: "info", label: x.kind };
            const meta = [
              k.label,
              x.kind === "email" && x.direction ? (x.direction === "in" ? "Received" : "Sent") : null,
              x.status, x.owner, relativeTime(x.at),
            ].filter(Boolean).join(" · ");
            return (
              <li key={`${x.kind}:${x.id}`} className="dl-tl">
                <span className="dl-tl__icon" aria-hidden><Icon name={k.icon} size={14} /></span>
                <span className="dl-tl__body">
                  <span className="dl-tl__title">
                    {x.url ? <a href={x.url} target="_blank" rel="noopener noreferrer" className="dl-link">{x.title || k.label}</a> : (x.title || k.label)}
                  </span>
                  {x.preview && <span className="dl-tl__preview">{x.preview}</span>}
                  <span className="dl-muted">{meta}</span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
