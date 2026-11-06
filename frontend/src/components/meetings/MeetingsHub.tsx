"use client";

/**
 * /meetings/<workspace>: the team's meetings. Import one (paste, upload, Google Docs), import many past
 * ones at once (BulkImport, with its progress while it runs: BackfillProgress), or connect Google Meet to
 * import them automatically (side by side); ask across all of them — or one series / period — and open
 * any meeting page. Meetings are listed by date under month headers, with a chip per series to filter.
 * Only meetings the caller can open are listed (the server decides); a workspace admin also sees that
 * restricted meetings exist (no title) so they can delete them. Phones get one column, full-width
 * buttons and the imports as bottom sheets.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Alert, Avatar, AvatarGroup, Badge, Button, ConfirmDialog, Dropdown, Icon, IconButton, Input, Progress, Select, Skeleton, Spinner,
  copyText, useToast, type MenuEntry,
} from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { getWorkspace, type Workspace } from "@/lib/workspaces";
import {
  deleteMeeting, fmtDuration, getMeetConnection, getMeetingsStatus, getOrganize, getOrganizeRun, listBackfills, listMeetings, listSeries,
  monthLabel, meetingsHref,
  type BackfillJob, type OrganizeJob, type HiddenMeeting, type MeetConnection, type Meeting, type MeetingSeries, type MeetingsStatus,
} from "@/lib/meetings";
import { ImportMeeting } from "./ImportMeeting";
import { BulkImport } from "./BulkImport";
import { BackfillProgress } from "./BackfillProgress";
import { OrganizeMeetings } from "./OrganizeMeetings";
import { PHONE_QUERY, useMediaQuery } from "@/components/kit/publish-utils";
import { ConnectGoogleMeet, MeetConnectionStatus } from "./ConnectGoogleMeet";
import { CheckNowSetup, useCheckNow } from "./CheckNow";
import { relativeTime } from "@/components/dashboard/format";
import { AskMeetingsDock } from "./AskMeetingsDock";
import { useAssistantHere } from "@/components/assistant/store";
import "./meetings.css";
import "./backfill.css";

export default function MeetingsHub({ workspaceId }: { workspaceId: string }) {
  const { user, loading: authLoading } = useAuth();
  const toast = useToast();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [status, setStatus] = useState<MeetingsStatus | null>(null);
  // Ask Markdrop here (✦ Ask, ⌘J, the Ask box below): the Meetings scope of this workspace.
  useAssistantHere({ workspace: workspaceId, scope: "meetings" });
  const [items, setItems] = useState<Meeting[] | null>(null);
  const [hidden, setHidden] = useState<HiddenMeeting[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [filter, setFilter] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [conn, setConn] = useState<{ mine: MeetConnection | null; others: MeetConnection[] }>({ mine: null, others: [] });
  const [bulk, setBulk] = useState(false);
  const [job, setJob] = useState<BackfillJob | null>(null);
  const [series, setSeries] = useState<MeetingSeries[]>([]);
  const [seriesFilter, setSeriesFilter] = useState<string | null>(null);
  const [organizing, setOrganizing] = useState(false);
  // The "Organize meetings" run this page follows (a background job on the server; polled while it runs).
  const [orgJob, setOrgJob] = useState<OrganizeJob | null>(null);
  const phone = useMediaQuery(PHONE_QUERY);
  // The list's order, remembered on this device (like a folder's listing view).
  const [sort, setSortState] = useState<MeetingSort>("date_desc");
  useEffect(() => {
    try { const v = window.localStorage.getItem(SORT_KEY); if (v && v in SORTS) setSortState(v as MeetingSort); } catch { /* storage off */ }
  }, []);
  const setSort = (v: MeetingSort) => {
    setSortState(v);
    try { window.localStorage.setItem(SORT_KEY, v); } catch { /* storage off */ }
  };

  const loadConn = useCallback(() => getMeetConnection(workspaceId)
    .then((c) => setConn({ mine: c.connection, others: c.others })).catch(() => {}), [workspaceId]);

  const load = useCallback(async () => {
    try {
      const [w, s, l] = await Promise.all([getWorkspace(workspaceId), getMeetingsStatus(workspaceId), listMeetings(workspaceId)]);
      setWs(w); setStatus(s); setItems(l.meetings); setHidden(l.hidden); setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the meetings.");
      setItems([]);
    }
    listSeries(workspaceId).then((r) => setSeries(r.series)).catch(() => {});
  }, [workspaceId]);
  const reloadList = useCallback(() => {
    listMeetings(workspaceId).then((l) => { setItems(l.meetings); setHidden(l.hidden); }).catch(() => {});
    listSeries(workspaceId).then((r) => setSeries(r.series)).catch(() => {});
  }, [workspaceId]);
  // An import of past meetings started earlier (on this or another device): its progress.
  const loadJob = useCallback(() => listBackfills(workspaceId)
    .then((r) => setJob(r.jobs.find((j) => j.state !== "draft") ?? null)).catch(() => {}), [workspaceId]);

  useEffect(() => { if (user) { void load(); void loadConn(); void loadJob(); } }, [user, load, loadConn, loadJob]);
  // "Check for new meetings": the connected scripts run now; the list and the connection line refresh.
  const afterCheck = useCallback(() => { void load(); void loadConn(); }, [load, loadConn]);
  const checkNow = useCheckNow({ workspaceId, mine: conn.mine, others: conn.others, onChecked: afterCheck });
  // ?check=1 (Home's "Check for new meetings"): once the connections are known.
  const autoCheck = useRef(false);
  const { available: checkAvailable, ready: checkReady, run: runCheck } = checkNow;
  useEffect(() => {
    if (!autoCheck.current || !checkAvailable) return;
    autoCheck.current = false;
    if (checkReady || conn.mine?.workspace_id === workspaceId) runCheck();
  }, [checkAvailable, checkReady, runCheck, conn.mine, workspaceId]);
  // Admins: a run already going (started in another tab, or by another admin) shows its progress here too.
  const canOrganize = !!status?.can_organize;
  useEffect(() => {
    if (!canOrganize) return;
    getOrganize(workspaceId).then((r) => { if (r.job?.state === "running") setOrgJob(r.job); }).catch(() => {});
  }, [canOrganize, workspaceId]);
  const orgRunning = orgJob?.state === "running";
  const orgId = orgJob?.id;
  useEffect(() => {
    if (!orgRunning || !orgId) return;
    let lastFiled = -1;
    const t = window.setInterval(() => {
      getOrganizeRun(orgId).then((r) => {
        setOrgJob(r.job);
        if (r.job.state !== "running") {
          void load();
          return;
        }
        if (r.job.filed !== lastFiled) { lastFiled = r.job.filed; reloadList(); }
      }).catch(() => {});
    }, 1200);
    return () => window.clearInterval(t);
  }, [orgRunning, orgId, load, reloadList]);
  // Finished while the dialog was closed: say so.
  const orgOpen = useRef(false);
  orgOpen.current = organizing;
  const orgState = orgJob?.state;
  useEffect(() => {
    if (!orgJob || orgState === "running" || orgOpen.current) return;
    if (orgState === "done") toast.success(`${orgJob.total} meeting${orgJob.total === 1 ? "" : "s"} organized: ${orgJob.filed} moved into ${orgJob.folders} folder${orgJob.folders === 1 ? "" : "s"}.`);
    else toast.error(orgJob.message || "Organizing the meetings stopped. Try again.");
    setOrgJob(null);
    // Only on the transition out of "running".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgState]);
  // A summary is being written: refresh the list now and then.
  const pending = items?.some((m) => m.ai.state === "pending");
  useEffect(() => {
    if (!pending) return;
    const t = window.setInterval(() => void listMeetings(workspaceId).then((l) => { setItems(l.meetings); setHidden(l.hidden); }).catch(() => {}), 4000);
    return () => window.clearInterval(t);
  }, [pending, workspaceId]);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("import") === "past") setBulk(true);
    else if (q.get("import") === "1") setImporting(true);
    else if (q.get("connect") === "1") setConnecting(true);
    else if (q.get("check") === "1") autoCheck.current = true;
  }, []);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (items ?? []).filter((m) => (!f || (m.title || "").toLowerCase().includes(f) || (m.series || "").toLowerCase().includes(f)
      || m.attendees.some((a) => a.name.toLowerCase().includes(f)))
      && (seriesFilter === null || (seriesFilter === "" ? !m.series : m.series === seriesFilter)))
      .sort(SORTS[sort].cmp);
  }, [items, filter, seriesFilter, sort]);
  // By month for the date orders; one flat list for the others.
  const months = useMemo(() => {
    const out: Array<{ key: string; items: Meeting[] }> = [];
    const byMonth = sort === "date_desc" || sort === "date_asc";
    for (const m of shown) {
      const key = byMonth ? (m.date || "").slice(0, 7) || "none" : "all";
      const last = out[out.length - 1];
      if (last && last.key === key) last.items.push(m);
      else out.push({ key, items: [m] });
    }
    return out;
  }, [shown, sort]);
  const oneOffs = (items ?? []).filter((m) => !m.series).length;

  if (authLoading) return <div className="mt-hub"><Skeleton height={32} width={240} /></div>;
  if (!user) return <div className="mt-hub"><Alert tone="info">Sign in to see your team's meetings.</Alert></div>;

  const canImport = !!status?.can_import;
  const folderHref = status?.folder_id ? `/w/${encodeURIComponent(workspaceId)}/f/${encodeURIComponent(status.folder_id)}` : null;
  const any = (items?.length ?? 0) > 0;
  const connectedHere = !!conn.mine && conn.mine.workspace_id === workspaceId;
  const connectButton = canImport && !connectedHere && (
    <Button variant="secondary" iconLeft="refresh" onClick={() => setConnecting(true)} data-testid="connect-meet">Connect Google Meet</Button>
  );
  const lastChecked = [conn.mine, ...conn.others].map((c) => c?.check_now?.last_at).filter(Boolean).sort().pop() ?? null;
  const checkLabel = checkNow.ready || !connectedHere ? "Check for new meetings" : "Turn on Check now";
  const checkHint = checkNow.reason ?? (checkNow.ready
    ? (lastChecked ? `Last checked ${relativeTime(lastChecked)}. The script also checks every 5 minutes.` : "Don't wait for the script's next run (every 5 minutes).")
    : "One time: lets this button run your script right away.");
  const checkButton = canImport && checkNow.available && (
    <Button variant="secondary" iconLeft="refresh" onClick={checkNow.run} loading={checkNow.busy} disabled={!!checkNow.reason}
      title={checkHint} data-testid="check-now">{checkNow.busy ? "Checking…" : checkLabel}</Button>
  );
  const pastButton = canImport && (
    <Button variant="ghost" iconLeft="history" onClick={() => setBulk(true)} data-testid="import-past">Import past meetings</Button>
  );
  // The ⋯ menu: what isn't a button already (on phones the header's secondary buttons fold into it).
  const folded = phone || !any;
  const more: MenuEntry[] = [
    ...(canImport && checkNow.available ? [{ label: checkNow.busy ? "Checking…" : checkLabel, icon: "refresh", onClick: checkNow.run,
      disabled: !!checkNow.reason || checkNow.busy, description: checkHint }] : []),
    ...(canImport && !connectedHere && phone ? [{ label: "Connect Google Meet", icon: "refresh", onClick: () => setConnecting(true),
      description: "Every call arrives by itself" }] : []),
    ...(canImport && folded ? [{ label: "Import past meetings", icon: "history", onClick: () => setBulk(true),
      description: "Bring in a backlog at once" }] : []),
    ...(folderHref ? [{ label: "Open the Meetings folder", icon: "folder", href: folderHref, separated: canImport && folded,
      description: "Browse them as pages, a table or a board" }] : []),
    ...(canOrganize && any ? [{ label: "Organize meetings", icon: "listTree", onClick: () => setOrganizing(true),
      description: orgRunning ? `Running: ${orgJob?.done ?? 0} of ${orgJob?.total ?? 0}` : "A folder per series, the rest in Other meetings" }] : []),
  ];
  const filtered = !!filter || seriesFilter !== null;

  return (
    <div className="mt-hub">
      <nav className="mt-hub__crumbs" aria-label="Breadcrumb">
        <Link href={`/w/${encodeURIComponent(workspaceId)}`}>{ws?.name ?? "Workspace"}</Link>
        <Icon name="chevronRight" />
        <span aria-current="page">Meetings</span>
      </nav>
      <header className="mt-hub__head">
        <div className="mt-hub__titles">
          <h1 className="mt-hub__title">Meetings</h1>
          <p className="mt-hub__sub">Every call as a page — summary, decisions, action items and the transcript.</p>
        </div>
        <div className="mt-hub__actions">
          <span className="mt-hub__secondary">{checkButton}{connectButton}{any && pastButton}</span>
          {canImport && <Button iconLeft="plus" onClick={() => setImporting(true)} data-testid="import-meeting">Import meeting</Button>}
          {more.length > 0 && (
            <Dropdown align="right" aria-label="More meeting actions" items={more} portal minWidth={300}
              trigger={<IconButton icon="more" label="More meeting actions" variant="secondary" data-testid="meetings-more" />} />
          )}
        </div>
      </header>
      <MeetConnectionStatus mine={conn.mine} others={conn.others} workspaceId={workspaceId}
        onChanged={() => void loadConn()} onReconnect={() => setConnecting(true)} />

      {error && <Alert tone="danger" className="mb-4">{error}</Alert>}
      {job && <BackfillProgress job={job} onChange={setJob} onProgress={reloadList} />}
      {orgJob?.state === "running" && !organizing && (
        <div className="mt-orgbar" data-testid="organize-bar">
          <Icon name="listTree" />
          <Progress size="sm" value={orgJob.done} max={Math.max(1, orgJob.total)}
            label={orgJob.done ? `Organizing ${orgJob.done} of ${orgJob.total} meetings…` : "Organizing meetings…"}
            indeterminate={!orgJob.done} valueText={`${orgJob.done} of ${orgJob.total} meetings`} />
          <Button size="sm" variant="secondary" onClick={() => setOrganizing(true)}>Details</Button>
        </div>
      )}

      {any && <AskMeetingsDock count={items?.length ?? 0}
        aiMessage={status?.ai.enabled === false ? status.ai.message : null} />}

      {items === null ? (
        <div className="mt-list" aria-busy>
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} variant="rect" height={104} />)}
        </div>
      ) : !any && hidden.length === 0 ? (
        <div className="mt-empty-hub">
          <span className="mt-empty-hub__glyph" aria-hidden><Icon name="mic" /></span>
          <h3>Turn your calls into team memory</h3>
          <p>Bring in a Google Meet transcript or Gemini's notes, or connect Google Meet once and every call arrives by itself. Markdrop writes the summary, decisions and action items, keeps the transcript, and answers questions about it.</p>
          {canImport ? (
            <div className="mt-empty-hub__actions">
              <Button iconLeft="plus" onClick={() => setImporting(true)}>Import a meeting</Button>
              {connectButton}
            </div>
          ) : <p style={{ margin: 0 }}>Members of this workspace can import meetings.</p>}
          {canImport && <p className="mt-empty-hub__more">Have a backlog? <button type="button" className="mt-linkbtn" onClick={() => setBulk(true)} data-testid="import-past">Import past meetings</button></p>}
          <ol className="mt-steps">
            <li className="mt-step"><span className="mt-step__n">1</span><b>Import</b>Paste, upload .txt/.vtt/.srt/.docx, pick Google Docs, or connect Google Meet.</li>
            <li className="mt-step"><span className="mt-step__n">2</span><b>Review</b>A page with the summary, decisions, action items with owners and open questions.</li>
            <li className="mt-step"><span className="mt-step__n">3</span><b>Ask</b>“What did we decide about pricing?” — answers link to the moment it was said.</li>
          </ol>
        </div>
      ) : (
        <section aria-labelledby="mt-list-title" className="mt-listsec">
          <h2 id="mt-list-title" className="mt-sr">Meetings</h2>
          <div className="mt-tools">
            <div className="mt-search">
              <Icon name="search" className="mt-search__icon" />
              <Input className="mt-filter" type="search" value={filter} onChange={(e) => setFilter(e.target.value)}
                placeholder="Search titles, series, people" aria-label="Filter meetings" />
            </div>
            <span className="mt-tools__right">
              <span className="mt-count" aria-live="polite">{shown.length} {shown.length === 1 ? "meeting" : "meetings"}{filtered && items ? ` of ${items.length}` : ""}</span>
              <Select aria-label="Sort meetings" value={sort} onChange={(e) => setSort(e.target.value as MeetingSort)} data-testid="meetings-sort" className="mt-sort"
                options={(Object.keys(SORTS) as MeetingSort[]).map((k) => ({ value: k, label: SORTS[k].label }))} />
            </span>
          </div>
          {series.length > 0 && (
            <ul className="mt-series" aria-label="Series" data-testid="series-chips">
              <li><button type="button" className="mt-series__chip" aria-pressed={seriesFilter === null} onClick={() => setSeriesFilter(null)}>All <span className="mt-series__n">{items?.length ?? 0}</span></button></li>
              {series.map((x) => (
                <li key={x.name}>
                  <button type="button" className="mt-series__chip" aria-pressed={seriesFilter === x.name} onClick={() => setSeriesFilter(seriesFilter === x.name ? null : x.name)}>
                    <span className="mt-series__dot" style={{ background: seriesTint(x.name) }} aria-hidden />{x.name} <span className="mt-series__n">{x.count}</span>
                  </button>
                </li>
              ))}
              {oneOffs > 0 && <li><button type="button" className="mt-series__chip" aria-pressed={seriesFilter === ""} onClick={() => setSeriesFilter(seriesFilter === "" ? null : "")}>One-offs <span className="mt-series__n">{oneOffs}</span></button></li>}
            </ul>
          )}
          <div className="mt-months" data-testid="meetings-list">
            {shown.length === 0 && filtered && (
              <div className="mt-nomatch">
                <Icon name="search" />
                <p>No meetings match{filter ? <> “{filter}”</> : null}.</p>
                <Button size="sm" variant="secondary" onClick={() => { setFilter(""); setSeriesFilter(null); }}>Clear the filters</Button>
              </div>
            )}
            {months.map((g) => (
              <section key={g.key} className="mt-monthgroup" aria-label={g.key === "all" ? undefined : g.key === "none" ? "No date" : monthLabel(g.key)}>
                {g.key !== "all" && <h3 className="mt-month" data-testid="month-header">{g.key === "none" ? "No date" : monthLabel(g.key)} <small>{g.items.length}</small></h3>}
                <ul className="mt-list">
                  {g.items.map((m) => <MeetingCard key={m.id} m={m} onDelete={m.can_delete ? () => setDeleting(m.id) : undefined} />)}
                </ul>
              </section>
            ))}
            {!filtered && hidden.length > 0 && (
              <ul className="mt-list mt-list--hidden">
                {hidden.map((h) => (
                  <li key={h.id} className="mt-card mt-card--hidden">
                    <span className="mt-card__thumb mt-card__thumb--hidden" aria-hidden><Icon name="lock" /></span>
                    <div className="mt-card__main">
                      <p className="mt-card__title">A meeting restricted to its attendees</p>
                      <p className="mt-card__summary">{h.date ? `${fmtDay(h.date)} · ` : ""}You weren't there, so you can't open it. As an admin you can delete it.</p>
                    </div>
                    <div className="mt-card__side">
                      <Button size="sm" variant="ghost" iconLeft="trash" onClick={() => setDeleting(h.id)}>Delete</Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      <ImportMeeting open={importing} onClose={() => setImporting(false)} workspaceId={workspaceId} status={status}
        onImported={() => void load()} />
      <BulkImport open={bulk} onClose={() => setBulk(false)} workspaceId={workspaceId} status={status}
        seriesNames={series.map((x) => x.name)} onStarted={(j) => setJob(j)} />
      <ConnectGoogleMeet open={connecting} onClose={() => { setConnecting(false); void load(); }} workspaceId={workspaceId}
        workspaceName={ws?.name ?? null} current={conn.mine} onConnected={(c) => setConn((x) => ({ ...x, mine: c }))} />
      <CheckNowSetup open={checkNow.setup} onClose={checkNow.closeSetup} conn={conn.mine}
        onSaved={(c) => setConn((x) => ({ ...x, mine: c }))} />
      <OrganizeMeetings open={organizing} workspaceId={workspaceId} job={orgJob} onJob={setOrgJob} folderHref={folderHref}
        onClose={() => { setOrganizing(false); if (orgJob && orgJob.state !== "running") setOrgJob(null); }} />
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} tone="danger" title="Delete this meeting?"
        description="Its pages go to the Trash for 30 days and its stored transcript is deleted now."
        confirmLabel="Delete meeting"
        onConfirm={async () => {
          if (!deleting) return;
          await deleteMeeting(deleting);
          toast.success("Meeting deleted.");
          setDeleting(null);
          void load();
        }} />
    </div>
  );
}

type MeetingSort = "date_desc" | "date_asc" | "title" | "imported";
const SORT_KEY = "md:meetings-sort";
/** "2026-11-04 10:00" for ordering by when the meeting happened (no date: last). */
const when = (m: Meeting) => (m.date ? `${m.date} ${m.time || ""}` : "");
const SORTS: Record<MeetingSort, { label: string; cmp: (a: Meeting, b: Meeting) => number }> = {
  date_desc: { label: "Meeting date, newest", cmp: (a, b) => (!a.date ? 1 : !b.date ? -1 : when(b).localeCompare(when(a))) },
  date_asc: { label: "Meeting date, oldest", cmp: (a, b) => (!a.date ? 1 : !b.date ? -1 : when(a).localeCompare(when(b))) },
  title: { label: "Title", cmp: (a, b) => (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" }) || when(b).localeCompare(when(a)) },
  imported: { label: "Recently imported", cmp: (a, b) => (b.created_at || "").localeCompare(a.created_at || "") },
};

/** "Today", "Yesterday", "Wed, Nov 4" (this year) or "Wed, Nov 4, 2025". */
function fmtDay(date: string | null): string {
  const [y, mo, d] = (date || "").split("-").map(Number);
  if (!y || !mo || !d) return "";
  const dt = new Date(y, mo - 1, d);
  const today = new Date();
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - dt.getTime()) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", ...(y !== today.getFullYear() ? { year: "numeric" } : {}) });
}

function hue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}
/** A series' colour (its chip's dot, the thumbnail when there's no cover). */
const seriesTint = (name: string) => `hsl(${hue(name.toLowerCase())} 62% 52%)`;

function Faces({ people }: { people: Meeting["attendees"] }) {
  const shown = people.slice(0, 4);
  const more = people.length - shown.length;
  return (
    <span className="mt-faces" title={people.map((a) => a.name).join(", ")} aria-label={`${people.length} ${people.length === 1 ? "person" : "people"}: ${people.map((a) => a.name).join(", ")}`} role="img">
      {shown.map((a) => (
        <span key={a.name} className="mt-face" style={{ background: `hsl(${hue(a.name)} 45% 46%)` }} aria-hidden>
          {a.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("")}
        </span>
      ))}
      {more > 0 && <span className="mt-face mt-face--more" aria-hidden>+{more}</span>}
    </span>
  );
}

function MeetingCard({ m, onDelete }: { m: Meeting; onDelete?: () => void }) {
  const toast = useToast();
  const [y, mo, d] = (m.date || "").split("-").map(Number);
  const dt = y ? new Date(y, (mo || 1) - 1, d || 1) : null;
  const title = m.title || "Meeting";
  const thumb = m.cover ? `/page-covers/thumbs/${m.cover}.webp` : null;
  const when = [fmtDay(m.date), m.time, m.duration_s ? fmtDuration(m.duration_s) : null].filter(Boolean).join(" · ");
  const counts = [
    { n: m.decisions ?? 0, icon: "checkCircle", one: "decision", many: "decisions" },
    { n: m.action_items, icon: "checkSquare", one: "action item", many: "action items" },
    { n: m.open_questions ?? 0, icon: "flag", one: "open question", many: "open questions" },
  ].filter((c) => c.n > 0);
  const menu: MenuEntry[] = [
    { label: "Open", icon: "arrowRight", href: `/${m.slug}` },
    ...(m.transcript_slug ? [{ label: "Transcript", icon: "lines", href: `/${m.transcript_slug}` }] : []),
    { label: "Ask this meeting", icon: "sparkle", href: `/${m.slug}?ask=1` },
    { label: "Copy link", icon: "link", onClick: () => void copyText(new URL(`/${m.slug}`, window.location.origin).toString()).then((ok) => (ok ? toast.success("Link copied") : toast.error("Couldn't copy"))) },
    ...(onDelete ? [{ label: "Delete meeting", icon: "trash", danger: true, separated: true, onClick: onDelete }] : []),
  ];
  return (
    <li className="mt-card" data-testid="meeting-card" data-series={m.series ? "" : undefined}>
      <Link className="mt-card__link" href={`/${m.slug}`} aria-label={`${title}${m.date ? `, ${fmtDay(m.date)}` : ""}`} />
      <span className="mt-card__thumb" aria-hidden
        style={{ backgroundColor: m.series ? seriesTint(m.series) : "var(--surface-inset)", ...(thumb ? { backgroundImage: `url(${thumb})` } : {}) }}>
        <span className="mt-card__day">
          <small>{dt ? dt.toLocaleDateString(undefined, { month: "short" }) : "—"}</small>
          {dt ? dt.getDate() : ""}
        </span>
      </span>
      <div className="mt-card__main">
        <div className="mt-card__top">
          <p className="mt-card__title">{title}</p>
          <span className="mt-card__badges">
            {m.ai.state === "pending" && <span className="mt-state"><Spinner size={12} /> Summarizing</span>}
            {m.restricted && <Badge size="sm" tone="neutral" icon="lock">Attendees only</Badge>}
            {m.source === "auto" && <Badge size="sm" tone="info" icon="refresh">Auto</Badge>}
          </span>
        </div>
        <p className="mt-card__when" data-testid="card-when">
          {when}
          {m.series && m.series !== m.title && (
            <span className="mt-card__series" data-testid="card-series"><span style={{ background: seriesTint(m.series) }} aria-hidden />{m.series}</span>
          )}
        </p>
        {m.summary
          ? <p className="mt-card__summary" data-testid="card-summary">{m.summary}</p>
          : m.ai.state !== "pending" && m.ai.state !== "done" && m.has_notes
            ? <p className="mt-card__summary mt-card__summary--muted" data-testid="card-summary">Google's notes are on the page.</p>
            : null}
        <div className="mt-card__foot">
          {m.attendees.length > 0 && <Faces people={m.attendees} />}
          {counts.map((c) => (
            <span key={c.icon} className="mt-card__count"><Icon name={c.icon} />{c.n} {c.n === 1 ? c.one : c.many}</span>
          ))}
        </div>
      </div>
      <div className="mt-card__actions">
        {m.transcript_slug && (
          <Link className="mt-card__act" href={`/${m.transcript_slug}`} title="Transcript" aria-label={`Transcript of ${title}`}><Icon name="lines" /></Link>
        )}
        <Link className="mt-card__act" href={`/${m.slug}?ask=1`} title="Ask this meeting" aria-label={`Ask ${title}`}><Icon name="sparkle" /></Link>
        <Dropdown align="right" portal aria-label={`More for ${title}`} items={menu}
          trigger={<button type="button" className="mt-card__act" aria-label={`More for ${title}`}><Icon name="more" /></button>} />
      </div>
    </li>
  );
}
