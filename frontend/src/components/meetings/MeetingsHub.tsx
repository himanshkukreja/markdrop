"use client";

/**
 * /meetings/<workspace>: the team's meetings. Import one (paste, upload, Google Docs), import many past
 * ones at once (BulkImport, with its progress while it runs: BackfillProgress), or connect Google Meet to
 * import them automatically (side by side); ask across all of them — or one series / period — and open
 * any meeting page. Meetings are listed by date under month headers, with a chip per series to filter.
 * Only meetings the caller can open are listed (the server decides); a workspace admin also sees that
 * restricted meetings exist (no title) so they can delete them. Phones get one column, full-width
 * buttons and the imports as bottom sheets.
 *
 * The list comes a page at a time (useMeetingsList: 30 cards, the next page prefetched while idle and
 * shown when the reader scrolls near the end); search, the series chips and the order are the server's.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Alert, Avatar, AvatarGroup, Badge, Button, ConfirmDialog, Dropdown, Icon, IconButton, Input, Progress, Select, Skeleton, Spinner,
  copyText, useToast, type MenuEntry,
} from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { getWorkspace, type Workspace } from "@/lib/workspaces";
import {
  deleteMeeting, fmtDuration, getMeetConnection, getMeetingsStatus, getOrganize, getOrganizeRun, listBackfills, listSeries,
  monthLabel, meetingsHref, MEETING_SORTS,
  type BackfillJob, type OrganizeJob, type MeetConnection, type MeetingCard, type MeetingSeries, type MeetingSort, type MeetingsStatus,
} from "@/lib/meetings";
import { lastQuery, useMeetingsList } from "./useMeetingsList";
import { ImportMeeting } from "./ImportMeeting";
import { BulkImport } from "./BulkImport";
import { BackfillProgress } from "./BackfillProgress";
import { OrganizeMeetings } from "./OrganizeMeetings";
import { PHONE_QUERY, useMediaQuery } from "@/components/kit/publish-utils";
import { ConnectGoogleMeet, MeetConnectionStatus } from "./ConnectGoogleMeet";
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
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  // The filters (this tab's last ones on this workspace, for back navigation); the order is remembered on
  // this device (like a folder's listing view).
  const restoredQuery = useMemo(() => lastQuery(workspaceId), [workspaceId]);
  const [filter, setFilter] = useState(restoredQuery?.q ?? "");
  const [q, setQ] = useState(restoredQuery?.q ?? "");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [conn, setConn] = useState<{ mine: MeetConnection | null; others: MeetConnection[] }>({ mine: null, others: [] });
  const [bulk, setBulk] = useState(false);
  const [job, setJob] = useState<BackfillJob | null>(null);
  const [series, setSeries] = useState<MeetingSeries[]>([]);
  const [facets, setFacets] = useState<{ total: number; one_offs: number } | null>(null);
  const [seriesFilter, setSeriesFilter] = useState<string | null>(restoredQuery?.series ?? null);
  const [organizing, setOrganizing] = useState(false);
  // The "Organize meetings" run this page follows (a background job on the server; polled while it runs).
  const [orgJob, setOrgJob] = useState<OrganizeJob | null>(null);
  const phone = useMediaQuery(PHONE_QUERY);
  const [sort, setSortState] = useState<MeetingSort>(() => restoredQuery?.sort ?? storedSort());
  const setSort = (v: MeetingSort) => {
    setSortState(v);
    try { window.localStorage.setItem(SORT_KEY, v); } catch { /* storage off */ }
  };
  // Search as you type, asked of the server a beat after the last key.
  useEffect(() => {
    const t = window.setTimeout(() => setQ(filter.trim()), filter.trim() ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [filter]);
  const query = useMemo(() => ({ q, series: seriesFilter, sort }), [q, seriesFilter, sort]);
  const signedIn = !!user;
  const list = useMeetingsList(workspaceId, signedIn, query);
  const { items, hidden, refreshHead, reload: reloadFirst, drop } = list;

  const loadConn = useCallback(() => getMeetConnection(workspaceId)
    .then((c) => setConn({ mine: c.connection, others: c.others })).catch(() => {}), [workspaceId]);

  const loadFacets = useCallback(() => listSeries(workspaceId).then((r) => {
    setSeries(r.series);
    if (r.total != null) setFacets({ total: r.total, one_offs: r.one_offs ?? 0 });
  }).catch(() => {}), [workspaceId]);
  // The page around the list (the list itself: useMeetingsList).
  const loadShell = useCallback(async () => {
    try {
      const [w, s] = await Promise.all([getWorkspace(workspaceId), getMeetingsStatus(workspaceId)]);
      setWs(w); setStatus(s); setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the meetings.");
    }
    void loadFacets();
  }, [workspaceId, loadFacets]);
  // After an import, a delete or Organize finishing: the first page again, and the chips.
  const load = useCallback(async () => {
    await Promise.all([loadShell(), reloadFirst()]);
  }, [loadShell, reloadFirst]);
  const reloadList = useCallback(() => {
    void refreshHead();
    void loadFacets();
  }, [refreshHead, loadFacets]);
  // An import of past meetings started earlier (on this or another device): its progress.
  const loadJob = useCallback(() => listBackfills(workspaceId)
    .then((r) => setJob(r.jobs.find((j) => j.state !== "draft") ?? null)).catch(() => {}), [workspaceId]);

  // Once per sign-in (not on every refresh of the user object: focus storms).
  useEffect(() => { if (signedIn) { void loadShell(); void loadConn(); void loadJob(); } }, [signedIn, loadShell, loadConn, loadJob]);
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
  // A summary is being written: refresh the loaded meetings now and then (a 304 while nothing changed),
  // not while the tab is in the background.
  const pending = items?.some((m) => m.ai.state === "pending");
  useEffect(() => {
    if (!pending) return;
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void refreshHead(); }, 4000);
    return () => window.clearInterval(t);
  }, [pending, refreshHead]);
  // Back from a meeting: the same place in the list (it rendered from memory, at full height).
  const restoredScroll = useRef(false);
  const restoreY = list.restoredScrollY;
  useLayoutEffect(() => {
    if (restoredScroll.current || !items || items.length === 0) return;
    restoredScroll.current = true;
    if (restoreY > 0) window.scrollTo(0, restoreY);
  }, [items, restoreY]);
  // More when the reader nears the end of what's loaded.
  const sentinel = useRef<HTMLDivElement | null>(null);
  const { loadMore, next: nextCursor } = list;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !nextCursor || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) loadMore(); }, { rootMargin: "900px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [nextCursor, loadMore, items?.length]);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("import") === "past") setBulk(true);
    else if (q.get("import") === "1") setImporting(true);
    else if (q.get("connect") === "1") setConnecting(true);
  }, []);

  // In the server's order: by month for the date orders; one flat list for the others.
  const shown = useMemo(() => items ?? [], [items]);
  const months = useMemo(() => {
    const out: Array<{ key: string; items: MeetingCard[] }> = [];
    const byMonth = sort === "date_desc" || sort === "date_asc";
    for (const m of shown) {
      const key = byMonth ? (m.date || "").slice(0, 7) || "none" : "all";
      const last = out[out.length - 1];
      if (last && last.key === key) last.items.push(m);
      else out.push({ key, items: [m] });
    }
    return out;
  }, [shown, sort]);
  const filtered = !!filter || seriesFilter !== null;
  // Every meeting the caller can open (the chips' answer), and how many match now.
  const allCount = facets?.total ?? (filtered ? null : list.total);
  const matchCount = list.total ?? shown.length;
  const oneOffs = facets?.one_offs ?? 0;

  if (authLoading) return <div className="mt-hub"><Skeleton height={32} width={240} /></div>;
  if (!user) return <div className="mt-hub"><Alert tone="info">Sign in to see your team's meetings.</Alert></div>;

  const canImport = !!status?.can_import;
  const folderHref = status?.folder_id ? `/w/${encodeURIComponent(workspaceId)}/f/${encodeURIComponent(status.folder_id)}` : null;
  const any = (items?.length ?? 0) > 0 || (allCount ?? 0) > 0 || filtered;
  const connectedHere = !!conn.mine && conn.mine.workspace_id === workspaceId;
  const connectButton = canImport && !connectedHere && (
    <Button variant="secondary" iconLeft="refresh" onClick={() => setConnecting(true)} data-testid="connect-meet">Connect Google Meet</Button>
  );
  const pastButton = canImport && (
    <Button variant="ghost" iconLeft="history" onClick={() => setBulk(true)} data-testid="import-past">Import past meetings</Button>
  );
  // The ⋯ menu: what isn't a button already (on phones the header's secondary buttons fold into it).
  const folded = phone || !any;
  const more: MenuEntry[] = [
    ...(canImport && !connectedHere && phone ? [{ label: "Connect Google Meet", icon: "refresh", onClick: () => setConnecting(true),
      description: "Every call arrives by itself" }] : []),
    ...(canImport && folded ? [{ label: "Import past meetings", icon: "history", onClick: () => setBulk(true),
      description: "Bring in a backlog at once" }] : []),
    ...(folderHref ? [{ label: "Open the Meetings folder", icon: "folder", href: folderHref, separated: canImport && folded,
      description: "Browse them as pages, a table or a board" }] : []),
    ...(canOrganize && any ? [{ label: "Organize meetings", icon: "listTree", onClick: () => setOrganizing(true),
      description: orgRunning ? `Running: ${orgJob?.done ?? 0} of ${orgJob?.total ?? 0}` : "A folder per series, the rest in Other meetings" }] : []),
  ];

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
          <span className="mt-hub__secondary">{connectButton}{any && pastButton}</span>
          {canImport && <Button iconLeft="plus" onClick={() => setImporting(true)} data-testid="import-meeting">Import meeting</Button>}
          {more.length > 0 && (
            <Dropdown align="right" aria-label="More meeting actions" items={more} portal minWidth={300}
              trigger={<IconButton icon="more" label="More meeting actions" variant="secondary" data-testid="meetings-more" />} />
          )}
        </div>
      </header>
      <MeetConnectionStatus mine={conn.mine} others={conn.others} workspaceId={workspaceId}
        onChanged={() => void loadConn()} onReconnect={() => setConnecting(true)} />

      {(error || list.error) && <Alert tone="danger" className="mb-4">{error || list.error}</Alert>}
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

      {any && <AskMeetingsDock count={allCount ?? items?.length ?? 0}
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
              <span className="mt-count" aria-live="polite" data-testid="meetings-count">{matchCount} {matchCount === 1 ? "meeting" : "meetings"}{filtered && allCount != null ? ` of ${allCount}` : ""}</span>
              <Select aria-label="Sort meetings" value={sort} onChange={(e) => setSort(e.target.value as MeetingSort)} data-testid="meetings-sort" className="mt-sort"
                options={(Object.keys(MEETING_SORTS) as MeetingSort[]).map((k) => ({ value: k, label: MEETING_SORTS[k] }))} />
            </span>
          </div>
          {series.length > 0 && (
            <ul className="mt-series" aria-label="Series" data-testid="series-chips">
              <li><button type="button" className="mt-series__chip" aria-pressed={seriesFilter === null} onClick={() => setSeriesFilter(null)}>All <span className="mt-series__n">{allCount ?? "…"}</span></button></li>
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
          <div className="mt-months" data-testid="meetings-list" aria-busy={list.stale || undefined} data-stale={list.stale ? "" : undefined}>
            {shown.length === 0 && filtered && !list.stale && (
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
                  {g.items.map((m) => <MeetingCardItem key={m.id} m={m} onDelete={m.can_delete ? () => setDeleting(m.id) : undefined} />)}
                </ul>
              </section>
            ))}
            {list.next && (
              <div ref={sentinel} className="mt-more" data-testid="meetings-more-zone">
                {list.loadingMore ? (
                  <>
                    <Skeleton variant="rect" height={104} />
                    <Skeleton variant="rect" height={104} />
                  </>
                ) : (
                  <Button variant="secondary" onClick={loadMore} data-testid="meetings-load-more">
                    {list.moreError ? "Couldn't load more. Try again" : "Load more meetings"}
                    {!list.moreError && list.total != null && list.total > shown.length ? ` (${list.total - shown.length})` : ""}
                  </Button>
                )}
              </div>
            )}
            {!filtered && !list.next && hidden.length > 0 && (
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
      <OrganizeMeetings open={organizing} workspaceId={workspaceId} job={orgJob} onJob={setOrgJob} folderHref={folderHref}
        onClose={() => { setOrganizing(false); if (orgJob && orgJob.state !== "running") setOrgJob(null); }} />
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} tone="danger" title="Delete this meeting?"
        description="Its pages go to the Trash for 30 days and its stored transcript is deleted now."
        confirmLabel="Delete meeting"
        onConfirm={async () => {
          if (!deleting) return;
          await deleteMeeting(deleting);
          toast.success("Meeting deleted.");
          drop(deleting);
          setDeleting(null);
          reloadList();
        }} />
    </div>
  );
}

const SORT_KEY = "md:meetings-sort";
/** The order this device last chose (the server sorts). */
function storedSort(): MeetingSort {
  try {
    const v = typeof window === "undefined" ? null : window.localStorage.getItem(SORT_KEY);
    if (v && v in MEETING_SORTS) return v as MeetingSort;
  } catch { /* storage off */ }
  return "date_desc";
}

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

function Faces({ people, count }: { people: MeetingCard["attendees"]; count: number }) {
  const shown = people.slice(0, 4);
  const more = Math.max(count, people.length) - shown.length;
  const others = Math.max(count, people.length) - people.length;
  const names = people.map((a) => a.name).join(", ") + (others > 0 ? ` and ${others} more` : "");
  return (
    <span className="mt-faces" title={names} aria-label={`${Math.max(count, people.length)} ${Math.max(count, people.length) === 1 ? "person" : "people"}: ${names}`} role="img">
      {shown.map((a) => (
        <span key={a.name} className="mt-face" style={{ background: `hsl(${hue(a.name)} 45% 46%)` }} aria-hidden>
          {a.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("")}
        </span>
      ))}
      {more > 0 && <span className="mt-face mt-face--more" aria-hidden>+{more}</span>}
    </span>
  );
}

function MeetingCardItem({ m, onDelete }: { m: MeetingCard; onDelete?: () => void }) {
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
    <li className="mt-card" data-testid="meeting-card" data-id={m.id} data-series={m.series ? "" : undefined}>
      <Link className="mt-card__link" href={`/${m.slug}`} aria-label={`${title}${m.date ? `, ${fmtDay(m.date)}` : ""}`} />
      <span className="mt-card__thumb" aria-hidden
        style={{ backgroundColor: m.series ? seriesTint(m.series) : "var(--surface-inset)" }}>
        {/* Lazy: only the covers near the screen load (a long list asks for a few, not all). */}
        {thumb && <img className="mt-card__img" src={thumb} alt="" loading="lazy" decoding="async" width={76} height={76} />}
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
          {m.attendees.length > 0 && <Faces people={m.attendees} count={m.attendee_count ?? m.attendees.length} />}
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
