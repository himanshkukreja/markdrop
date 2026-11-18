"use client";

/**
 * /deals/<workspace>/<deal id>: one HubSpot deal (backend GET /hubspot/deals/{id}; owner-approved layout 2026-11-18,
 * .work/briefs/nav-redesign.md). Breadcrumb Deals › Company. The header: "<Company> — <Deal>" with its stage pill
 * (Closed won / lost when closed); amount · owner · close date · N calls · last call; Open in HubSpot and Upload asset
 * (into the deal's folder). Tabs, with counts:
 *   - Overview: left, the deal's facts (and the team's own notes page) and its contacts; right, suggested deal updates
 *     (Apply / Dismiss), "Across all calls" (decisions, risks, open questions, next steps, each linking to its call)
 *     and the recent calls with their length and a play chip. One column on phones. No calls: one calm card.
 *   - Calls: the calls filed in the deal, newest first (Log to HubSpot, Create tasks), and the calls waiting for
 *     someone to pick their deal (File here).
 *   - Assets: the deal folder's files (uploads and drops go into the folder; views and analytics) and the deal's
 *     HubSpot attachments as links (never imported).
 *   - HubSpot activity: notes, emails, meetings and tasks, newest first.
 * A scope the HubSpot key lacks: admins are told what to add, everyone else that it isn't shown. Only the HubSpot
 * team's members and workspace admins can open it (403 / 404: a calm note).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Alert, Avatar, Badge, Button, EmptyState, FileIcon, Icon, IconButton, Skeleton, Spinner, Tabs, useToast,
} from "@/components/ui";
import { relativeTime } from "@/components/dashboard/format";
import { docHref } from "@/components/analytics/format";
import { useAssistantHere } from "@/components/assistant/store";
import { hasFiles, useUploads } from "@/components/workspace/uploads/UploadProvider";
import {
  dealDetail, hubspotApply, hubspotCreateTasks, hubspotDismiss, hubspotLog, hubspotMeeting, hubspotSetMatch,
  type DealCallRow, type DealDetail, type DealLine, type HubSpotSuggestion, type HubSpotTask,
} from "@/lib/hubspot";
import { teamDealsHref, teamMeetingsHref } from "@/lib/teams";
import { teamsSlot, useTeamsSidebar } from "@/lib/teamsStore";
import { errorStatus, listWorkspaceItems, openHref, type WorkspaceItem } from "@/lib/workspaces";
import { useWorkspaceChanged } from "@/lib/workspaceStore";
import { HOW, MissingScopeHint, SuggestionItems, TaskChecklist, failMessage, logOk, shortWhen, tasksOk } from "../parts";
import { amountOf, fmtSize, relDay, shortDay } from "./format";
import { callsLabel, minutes } from "./model.mjs";
import "./deals.css";

type Tab = "overview" | "calls" | "assets" | "activity";
const TABS: Tab[] = ["overview", "calls", "assets", "activity"];
const RECENT = 3;

export default function DealView({ workspaceId, dealId }: { workspaceId: string; dealId: string }) {
  const toast = useToast();
  const uploads = useUploads();
  const [data, setData] = useState<DealDetail | null>(null);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTabState] = useState<Tab>("overview");
  const [items, setItems] = useState<WorkspaceItem[] | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);
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

  // The deal folder's files: the Assets tab and its count (calls and the overview page are on the other tabs).
  const folder = data?.folder ?? null;
  const loadItems = useCallback(async () => {
    if (!folder) return;
    try { setItems((await listWorkspaceItems(workspaceId, { folder: folder.id, limit: 100 })).items); setItemsError(null); }
    catch (e) { setItemsError(e instanceof Error ? e.message : "Couldn't load the files."); }
  }, [workspaceId, folder]);
  useEffect(() => { void loadItems(); }, [loadItems]);
  useWorkspaceChanged(workspaceId, loadItems);
  const target = useMemo(() => (uploads && folder ? uploads.resolve(workspaceId, folder.id, folder.name) : null), [uploads, workspaceId, folder]);
  const files = useMemo(() => {
    if (!items || !data) return null;
    const skip = new Set([...data.calls.map((c) => c.slug), ...data.pick.map((c) => c.slug), ...(data.overview ? [data.overview.slug] : [])]);
    return items.filter((it) => !skip.has(it.slug));
  }, [items, data]);

  const refresh = async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
    toast.success("Up to date with HubSpot.");
  };
  const upload = () => { if (!target || !uploads) return; setTab("assets"); uploads.pick(target); };

  const crumbs = (
    <nav className="dl-crumbs" aria-label="Breadcrumb">
      <Link href={sectionHref}>Deals</Link>
      {data && <><Icon name="chevronRight" /><span aria-current="page">{data.deal.company?.name ?? data.deal.name}</span></>}
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
        <Skeleton variant="text" width={120} height={16} />
        <Skeleton variant="text" width={420} height={32} className="dl-gap-8" />
        <Skeleton variant="rect" height={240} className="dl-gap-24" />
      </div>
    );
  }

  const d = data.deal;
  const amount = amountOf(d);
  const close = shortDay(d.close_date);
  const last = data.calls[0] ?? null;
  const openSuggestions = data.suggestions.reduce((a, g) => a + g.items.filter((i) => i.state === "open" || i.state === "failed").length, 0);
  const callCount = data.calls.length;

  return (
    <div className="dl-page dl-page--deal" data-testid="deal-page">
      {crumbs}
      <header className="dl-dealhead">
        <div className="dl-dealhead__main">
          <div className="dl-dealhead__title">
            <h1 className="dl-title">
              {d.company && <span className="dl-title__co">{d.company.name} — </span>}{d.name}
            </h1>
            {d.closed
              ? <Badge tone={d.closed_label === "Closed won" ? "success" : "neutral"} data-testid="deal-stage">{d.closed_label || "Closed"}</Badge>
              : d.stage && <Badge tone="info" data-testid="deal-stage">{d.stage}</Badge>}
          </div>
          <p className="dl-dealhead__facts" data-testid="deal-facts">
            {amount && <b className="dl-dealhead__amount">{amount}</b>}
            {d.owner && <span className="dl-owner"><Avatar name={d.owner} size="sm" neutral />{d.owner}</span>}
            {close && <span>{d.closed ? `Closed ${close}` : `Closes ${close}`}</span>}
            <span>{callsLabel(callCount) ?? "No calls yet"}{last?.date ? ` · last ${relDay(last.date)}` : ""}</span>
          </p>
        </div>
        <div className="dl-head__actions">
          <IconButton icon="refresh" label="Refresh from HubSpot" variant="ghost" loading={refreshing} disabled={refreshing} onClick={() => void refresh()} />
          {d.url && <Button variant="secondary" iconLeft="external" href={d.url} target="_blank" rel="noopener noreferrer" data-testid="deal-hubspot-link">Open in HubSpot</Button>}
          {target && <Button iconLeft="upload" onClick={upload} data-testid="deal-upload-asset">Upload asset</Button>}
        </div>
      </header>

      <Tabs value={tab} onChange={(v) => setTab(v as Tab)} aria-label="Deal" idPrefix="deal" className="dl-tabs"
        items={[
          { value: "overview", label: "Overview", count: openSuggestions || undefined },
          { value: "calls", label: "Calls", count: callCount + data.pick.length || undefined },
          { value: "assets", label: "Assets", count: files ? files.length + data.attachments.items.length || undefined : undefined },
          { value: "activity", label: "HubSpot activity", count: data.activity.items.length || undefined },
        ]} />
      <div role="tabpanel" id={`deal-panel-${tab}`} aria-labelledby={`deal-tab-${tab}`} className="dl-panel">
        {tab === "overview" && <Overview data={data} setData={setData} onCalls={() => setTab("calls")}
          meetingsHref={team ? teamMeetingsHref(workspaceId, team) : null} />}
        {tab === "calls" && <Calls data={data} setData={setData} reload={() => load()} meetingsHref={team ? teamMeetingsHref(workspaceId, team) : null} />}
        {tab === "assets" && <Assets data={data} files={files} error={itemsError} target={!!target} onUpload={upload}
          onDrop={target && uploads ? (fs) => uploads.upload(fs, target) : null} />}
        {tab === "activity" && <Activity data={data} />}
      </div>
    </div>
  );
}

/* ── Overview ─────────────────────────────────────────────────────────── */

const ROLLUP: Array<[keyof Pick<DealDetail["rollup"], "decisions" | "risks" | "questions" | "next_steps">, string, string]> = [
  ["decisions", "Decisions", "checkCircle"], ["risks", "Objections and risks", "alert"],
  ["questions", "Open questions", "help"], ["next_steps", "Next steps", "arrowRight"],
];

function Overview({ data, setData, onCalls, meetingsHref }: {
  data: DealDetail; setData: React.Dispatch<React.SetStateAction<DealDetail | null>>; onCalls: () => void; meetingsHref: string | null;
}) {
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
  const rows: Array<[string, React.ReactNode]> = [
    ["Stage", d.closed ? d.closed_label || "Closed" : d.stage],
    ["Pipeline", d.pipeline],
    ["Company", d.company?.name ?? null],
    ["Amount", amountOf(d)],
    ["Close date", shortDay(d.close_date) || null],
    ["In HubSpot", d.updated_at ? `Updated ${relativeTime(d.updated_at)}` : null],
  ];
  const groups = ROLLUP.map(([k, label, icon]) => [label, icon, r[k]] as const).filter(([, , ls]) => ls.length > 0);
  const calls = data.calls;
  const noCalls = calls.length === 0 && groups.length === 0;
  return (
    <div className="dl-overview">
      <div className="dl-overview__side">
        <section className="dl-card-box" aria-labelledby="dl-facts">
          <h2 className="dl-h2" id="dl-facts">Deal</h2>
          <dl className="dl-facts">
            {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v || "—"}</dd></div>)}
          </dl>
          {data.overview && (
            <Link href={data.overview.href} className="dl-boxlink" data-testid="deal-overview-link">
              <Icon name="doc" size={16} /><span className="dl-boxlink__label">Team notes</span><Icon name="chevronRight" size={14} />
            </Link>
          )}
        </section>
        <section className="dl-card-box" aria-labelledby="dl-contacts">
          <div className="dl-box-head">
            <h2 className="dl-h2" id="dl-contacts">Contacts</h2>
            {d.contacts.length > 0 && <span className="dl-count">{d.contacts.length}</span>}
          </div>
          {d.contacts.length === 0 ? <p className="dl-muted">No contacts on the deal in HubSpot.</p> : (
            <ul className="dl-contacts">
              {d.contacts.map((c) => (
                <li key={c.id}>
                  <Avatar name={c.name || c.email || "Contact"} size="md" neutral />
                  <span className="dl-contact__body">
                    {c.url ? <a href={c.url} target="_blank" rel="noopener noreferrer" className="dl-contact__name">{c.name || c.email || "Contact"}</a>
                      : <span className="dl-contact__name">{c.name || c.email}</span>}
                    {c.title && <span className="dl-muted">{c.title}</span>}
                    {c.email && <a href={`mailto:${c.email}`} className="dl-muted dl-email">{c.email}</a>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="dl-overview__main">
        {data.suggestions.length > 0 && (
          <section className="dl-card-box" aria-labelledby="dl-sugg" data-testid="deal-suggestions">
            <div className="dl-box-head dl-box-head--start">
              <h2 className="dl-h2" id="dl-sugg">Suggested deal updates</h2>
              <span className="dl-muted">Nothing changes in HubSpot until you apply it.</span>
            </div>
            {data.suggestions.map((g) => (
              <div key={g.meeting_id} className="dl-sugg">
                <p className="dl-sugg__from"><Icon name="mic" size={14} />From <Link href={`/${g.slug}`} className="dl-link">{g.title}</Link>{g.date ? ` · ${shortDay(g.date)}` : ""}</p>
                <SuggestionItems items={g.items} dealsWrite={data.deals_write} busy={busy}
                  onApply={(it) => void act(g.meeting_id, it, "apply")} onDismiss={(it) => void act(g.meeting_id, it, "dismiss")} />
              </div>
            ))}
          </section>
        )}

        {noCalls ? (
          <section className="dl-card-box dl-nocalls" aria-labelledby="dl-nocalls" data-testid="deal-nocalls">
            <span className="dl-nocalls__icon" aria-hidden><Icon name="mic" size={18} /></span>
            <div className="dl-nocalls__body">
              <h2 className="dl-h2" id="dl-nocalls">No calls yet</h2>
              <p className="dl-muted">
                {data.pick.length > 0
                  ? `${data.pick.length} ${data.pick.length === 1 ? "call matches" : "calls match"} this company and ${data.pick.length === 1 ? "waits" : "wait"} for you to pick the deal.`
                  : "Calls with this deal's contacts show here once they're recorded; decisions, risks and next steps follow."}
              </p>
            </div>
            {data.pick.length > 0
              ? <Button size="sm" variant="secondary" onClick={onCalls} data-testid="deal-review-pick">Review {data.pick.length === 1 ? "the call" : `${data.pick.length} calls`}</Button>
              : meetingsHref && <Button size="sm" variant="secondary" href={meetingsHref}>Open Meetings</Button>}
          </section>
        ) : (
          <>
            <section className="dl-card-box" aria-labelledby="dl-rollup" data-testid="deal-rollup">
              <div className="dl-box-head">
                <h2 className="dl-h2" id="dl-rollup">Across all calls</h2>
                {r.last_call?.date && <span className="dl-muted">Updated after the {shortDay(r.last_call.date)} call</span>}
              </div>
              {groups.length === 0 ? (
                <p className="dl-muted">No decisions, risks or next steps in the calls yet.</p>
              ) : (
                <div className="dl-rollup">
                  {groups.map(([label, icon, ls]) => (
                    <div key={label} className="dl-rollup__group">
                      <h3 className="dl-h3"><Icon name={icon} size={14} />{label}<span className="dl-count">{ls.length}</span></h3>
                      <ul className="dl-lines">
                        {ls.map((l: DealLine, i: number) => (
                          <li key={`${l.slug}:${i}`}>
                            <span>{l.text}</span>
                            <Link href={`/${l.slug}`} className="dl-line__src">{l.date ? shortDay(l.date) : "The call"}</Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </section>
            {calls.length > 0 && (
              <section className="dl-card-box" aria-labelledby="dl-recent" data-testid="deal-recent">
                <div className="dl-box-head">
                  <h2 className="dl-h2" id="dl-recent">Recent calls</h2>
                  {calls.length > RECENT && <button type="button" className="dl-linkbtn" onClick={onCalls}>All {calls.length} calls</button>}
                </div>
                <ul className="dl-callrows">
                  {calls.slice(0, RECENT).map((c) => (
                    <li key={c.meeting_id} className="dl-callrow">
                      <span className="dl-callrow__date">{shortDay(c.date) || "—"}</span>
                      <span className="dl-callrow__main">
                        <Link href={c.href} className="dl-callrow__title">{c.title}</Link>
                        {c.summary && <span className="dl-callrow__sum">{c.summary}</span>}
                      </span>
                      <PlayChip c={c} />
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** "54 min ▶": the call's length; a play chip (to the meeting page's recording) when Markdrop kept the recording. */
function PlayChip({ c }: { c: DealCallRow }) {
  const len = minutes(c.duration_s);
  if (c.recording) {
    return (
      <Link href={`${c.href}#recording`} className="dl-play" aria-label={`Play the recording of ${c.title}${len ? ` (${len})` : ""}`}>
        <Icon name="play" size={12} />{len ?? "Play"}
      </Link>
    );
  }
  return len ? <span className="dl-play dl-play--static">{len}</span> : null;
}

/* ── Calls ────────────────────────────────────────────────────────────── */

function Calls({ data, setData, reload, meetingsHref }: {
  data: DealDetail; setData: React.Dispatch<React.SetStateAction<DealDetail | null>>; reload: () => Promise<void>; meetingsHref: string | null;
}) {
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
  if (!data.calls.length && !data.pick.length) {
    return (
      <EmptyState icon="mic" title="No calls in this deal yet" className="dl-empty"
        description="Recorded calls with the deal's contacts are filed here on their own."
        actions={meetingsHref ? <Button size="sm" variant="secondary" href={meetingsHref}>Open Meetings</Button> : undefined} />
    );
  }
  return (
    <div className="dl-stack">
      {data.pick.length > 0 && (
        <section className="dl-card-box" aria-labelledby="dl-pick" data-testid="deal-pick">
          <div className="dl-box-head dl-box-head--start">
            <h2 className="dl-h2" id="dl-pick">Waiting for you to pick the deal</h2>
            <span className="dl-muted">The company has several open deals. File the ones that belong here.</span>
          </div>
          <ul className="dl-callrows">
            {data.pick.map((c) => (
              <li key={c.meeting_id} className="dl-callrow">
                <span className="dl-callrow__date">{shortDay(c.date) || "—"}</span>
                <span className="dl-callrow__main">
                  <Link href={c.href} className="dl-callrow__title">{c.title}</Link>
                  {c.how && <span className="dl-muted">Matched by {HOW[c.how] ?? c.how}</span>}
                </span>
                <Button size="sm" variant="secondary" loading={filing === c.meeting_id} disabled={!!filing} onClick={() => void fileHere(c)} data-testid="deal-file-here">File here</Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {data.calls.length > 0 && (
        <section className="dl-card-box" aria-labelledby="dl-calls-h" data-testid="deal-calls">
          <div className="dl-box-head">
            <h2 className="dl-h2" id="dl-calls-h">Calls</h2>
            <span className="dl-count">{data.calls.length}</span>
          </div>
          <ul className="dl-callrows">
            {data.calls.map((c) => <CallItem key={c.meeting_id} c={c} onChange={(p) => patchCall(c.meeting_id, p)} />)}
          </ul>
        </section>
      )}
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
    c.actions ? `${c.actions} action ${c.actions === 1 ? "item" : "items"}` : null,
    c.tasks_created ? `${c.tasks_created} in HubSpot` : null,
  ].filter(Boolean).join(" · ");
  return (
    <li className="dl-callrow dl-callrow--full" data-testid="deal-call">
      <span className="dl-callrow__date">{shortDay(c.date) || "—"}</span>
      <span className="dl-callrow__main">
        <Link href={c.href} className="dl-callrow__title">{c.title}</Link>
        {c.summary && <span className="dl-callrow__sum">{c.summary}</span>}
        {(meta || c.logged || c.suggestions_open > 0 || c.recording || c.duration_s) && (
          <span className="dl-callrow__meta">
            <PlayChip c={c} />
            {meta && <span className="dl-muted">{meta}</span>}
            {c.logged ? <Badge size="sm" tone="success">Logged {shortWhen(c.logged.at)}</Badge> : null}
            {c.suggestions_open > 0 && <Badge size="sm" tone="info">{c.suggestions_open} suggested {c.suggestions_open === 1 ? "update" : "updates"}</Badge>}
          </span>
        )}
      </span>
      <span className="dl-callrow__side">
        <span className="dl-callrow__actions">
          <Button size="sm" variant={c.logged ? "ghost" : "secondary"} iconLeft="send" loading={busy === "log"} disabled={!!busy} onClick={() => void log()} data-testid="deal-call-log">
            {c.logged ? "Update in HubSpot" : "Log to HubSpot"}
          </Button>
          {c.actions > 0 && (
            <Button size="sm" variant="ghost" iconLeft="checkSquare" aria-expanded={showTasks} loading={busy === "load"} disabled={busy === "log"}
              onClick={() => void openTasks()} data-testid="deal-call-tasks">Create tasks</Button>
          )}
        </span>
      </span>
      {showTasks && (
        <div className="dl-callrow__tasks">
          {tasks ? <TaskChecklist tasks={tasks} busy={busy === "tasks"} onCreate={create} /> : <Spinner size={14} />}
        </div>
      )}
    </li>
  );
}

/* ── Assets ───────────────────────────────────────────────────────────── */

function Assets({ data, files, error, target, onUpload, onDrop }: {
  data: DealDetail; files: WorkspaceItem[] | null; error: string | null; target: boolean; onUpload: () => void; onDrop: ((files: File[]) => void) | null;
}) {
  const [over, setOver] = useState(false);
  const att = data.attachments;
  const showAtt = att.items.length > 0 || att.missing.length > 0;
  return (
    <div className="dl-stack">
      <section
        className={`dl-card-box dl-drop${over ? " dl-drop--over" : ""}`} aria-labelledby="dl-files" data-testid="deal-assets"
        onDragOver={onDrop ? (e) => { if (hasFiles(e)) { e.preventDefault(); setOver(true); } } : undefined}
        onDragLeave={onDrop ? () => setOver(false) : undefined}
        onDrop={onDrop ? (e) => { if (!hasFiles(e)) return; e.preventDefault(); setOver(false); onDrop(Array.from(e.dataTransfer.files)); } : undefined}
      >
        <div className="dl-box-head">
          <h2 className="dl-h2" id="dl-files">Files</h2>
          {files && files.length > 0 && <span className="dl-count">{files.length}</span>}
        </div>
        {!data.folder ? <p className="dl-muted">This deal&apos;s folder is made on the next sync.</p>
          : error ? <Alert tone="danger">{error}</Alert>
          : !files ? <Skeleton variant="rect" height={96} />
          : files.length === 0 ? (
            <div className="dl-inline-empty" data-testid="deal-assets-empty">
              <p className="dl-muted">No files yet. Share decks, proposals and one-pagers from here and see who viewed them{target ? "; or drop files on this box" : ""}.</p>
              {target && <Button size="sm" variant="secondary" iconLeft="upload" onClick={onUpload} data-testid="deal-upload">Upload</Button>}
            </div>
          ) : (
            <ul className="dl-rows">
              {files.map((it) => (
                <li key={it.slug} className="dl-row">
                  <FileIcon name={it.original_filename || it.title || ""} mime={it.mime || ""} size={20} />
                  <span className="dl-row__main">
                    <Link href={openHref(it.slug, it.url, it.encrypted)} className="dl-row__title">{it.title || it.original_filename || "Untitled"}</Link>
                    <span className="dl-muted">
                      {[it.type_label || (it.kind === "markdown" ? "Document" : null), it.owner?.name, relativeTime(it.updated_at)].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  {it.views != null && <span className="dl-views"><Icon name="eye" size={14} />{it.views}</span>}
                  {it.can.edit && <Button size="sm" variant="ghost" iconLeft="chart" href={docHref(it.slug)}>Analytics</Button>}
                </li>
              ))}
            </ul>
          )}
      </section>
      {showAtt && (
        <section className="dl-card-box" aria-labelledby="dl-att" data-testid="deal-attachments">
          <h2 className="dl-h2" id="dl-att">HubSpot attachments</h2>
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
      )}
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
