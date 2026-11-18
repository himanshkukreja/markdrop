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
import { useRouter } from "next/navigation";
import { teamsSlot, useTeamsSidebar } from "@/lib/teamsStore";
import { teamHref, teamsChanged, type TeamCard } from "@/lib/teams";
import { TeamChip } from "@/components/teams/parts";
import {
  Alert, Badge, Button, ConfirmDialog, Dropdown, Icon, IconButton, Input, Progress, Select, Skeleton, Spinner, Switch, Tabs,
  copyText, useToast, type MenuEntry,
} from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { getWorkspace, type Workspace } from "@/lib/workspaces";
import {
  deleteMeeting, fmtDuration, getMeetConnection, getMeetingsStatus, getOrganize, getOrganizeRun, listBackfills, listSeries,
  monthLabel, meetingsHref, MEETING_SORTS,
  type BackfillJob, type MeetingAudience, type MeetingsTab, type OrganizeJob, type MeetConnection, type MeetingCard, type MeetingSeries, type MeetingSort, type MeetingsStatus,
} from "@/lib/meetings";
import { ZoomReviewList } from "@/components/zoom/ZoomReviewList";
import { lastQuery, useMeetingsList } from "./useMeetingsList";
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

export default function MeetingsHub({ workspaceId, space: spaceParam, team: teamFilter = null, tab: tabParam = "all" }: {
  workspaceId: string;
  /** Teams: "team:<id>" | "project:<id>" — that space's meetings (a team's Meetings section); "company": company-wide only;
   *  "all" or none: every team's you can open (the sidebar's top-level Meetings), with a Team filter (`team`). */
  space?: string; team?: string | null; tab?: MeetingsTab;
}) {
  const router = useRouter();
  const allView = !spaceParam || spaceParam === "all";
  const space = allView ? (teamFilter ? `team:${teamFilter}` : undefined) : spaceParam;
  const companyView = spaceParam === "company";
  const [tab, setTabState] = useState<MeetingsTab>(tabParam);
  const audience: MeetingAudience | null = tab === "customers" || tab === "internal" ? tab : null;
  // The tab and the Team filter live in the URL (a link to "To review", back navigation).
  const setUrl = (next: { tab?: MeetingsTab; team?: string | null }) => {
    const q = new URLSearchParams(window.location.search);
    const t = next.tab ?? tab;
    if (t === "all") q.delete("tab"); else q.set("tab", t);
    if (next.team !== undefined) { if (next.team) q.set("team", next.team); else q.delete("team"); }
    router.replace(`/meetings/${encodeURIComponent(workspaceId)}?${q.toString()}`, { scroll: false });
  };
  const setTab = (t: MeetingsTab) => { setTabState(t); setUrl({ tab: t }); };
  const { user, loading: authLoading } = useAuth();
  const toast = useToast();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [status, setStatus] = useState<MeetingsStatus | null>(null);
  // Ask Markdrop here (✦ Ask, ⌘J, the Ask box below): the Meetings scope of this workspace.
  useAssistantHere({ workspace: workspaceId, scope: "meetings" });
  const [error, setError] = useState<string | null>(null);
  // ?import=1 (the team home's "Import meeting") opens the importer at once.
  const [importing, setImporting] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("import") === "1");
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
  const query = useMemo(() => ({ q, series: seriesFilter, sort, audience, ...(space ? { space } : {}) }), [q, seriesFilter, sort, space, audience]);
  // Teams: a team's meetings (?space=team:<id>) — its name in the title, and the importer starts on it.
  useTeamsSidebar([workspaceId]);
  const teamsData = teamsSlot(workspaceId);
  const spaceTeam = !allView && space?.startsWith("team:") && teamsData ? teamsData.teams.find((t) => t.id === space.slice(5)) ?? null : null;
  // All teams: the Team filter's choices (General first), and your Zoom meetings waiting across them.
  const myTeams: TeamCard[] = teamsData ? teamsData.teams.filter((t) => t.general || t.my_role || t.can_admin) : [];
  const filterTeam = allView && teamFilter ? myTeams.find((t) => t.id === teamFilter) ?? null : null;
  const reviewTeams = spaceTeam ? [spaceTeam] : filterTeam ? [filterTeam] : myTeams;
  const reviewCount = reviewTeams.reduce((n, t) => n + (t.to_review ?? 0), 0);
  const zoomHere = reviewTeams.some((t) => (t.linked ?? []).includes("Zoom"));
  const showReview = reviewCount > 0 || zoomHere || tab === "review";
  const signedIn = !!user;
  const list = useMeetingsList(workspaceId, signedIn, query);
  const { items, hidden, refreshHead, reload: reloadFirst, drop } = list;

  const loadConn = useCallback(() => getMeetConnection(workspaceId)
    .then((c) => setConn({ mine: c.connection, others: c.others })).catch(() => {}), [workspaceId]);

  const loadFacets = useCallback(() => listSeries(workspaceId, space).then((r) => {
    setSeries(r.series);
    if (r.total != null) setFacets({ total: r.total, one_offs: r.one_offs ?? 0 });
  }).catch(() => {}), [workspaceId, space]);
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
      if (document.visibilityState === "hidden") return; // the next tick after it's shown catches up
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
    else if (q.get("check") === "1") autoCheck.current = true;
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
  const filtered = !!filter || seriesFilter !== null || !!audience;
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

  return (
    <div className="mt-hub">
      <nav className="mt-hub__crumbs" aria-label="Breadcrumb">
        <Link href={`/w/${encodeURIComponent(workspaceId)}`}>{ws?.name ?? "Workspace"}</Link>
        <Icon name="chevronRight" />
        {spaceTeam && <><Link href={teamHref(workspaceId, spaceTeam)}>{spaceTeam.name}</Link><Icon name="chevronRight" /></>}
        {allView && <><span>All teams</span><Icon name="chevronRight" /></>}
        <span aria-current="page">Meetings</span>
      </nav>
      <header className="mt-hub__head">
        <div className="mt-hub__titles">
          <h1 className="mt-hub__title">{spaceTeam ? `${spaceTeam.name} meetings` : companyView ? "General meetings" : "Meetings"}</h1>
          <p className="mt-hub__sub">{allView ? "Every team's meetings you can open. Each call is a page: summary, decisions, action items and the transcript."
            : spaceTeam?.general || companyView ? "Calls for everyone in the workspace. A team's meetings live in that team."
              : "Every call as a page — summary, decisions, action items and the transcript."}</p>
          {companyView && (
            <Switch label="Show all I can open" checked={false} data-testid="meetings-show-all"
              onChange={(e) => { if (e.currentTarget.checked) router.replace(`/meetings/${encodeURIComponent(workspaceId)}?space=all`); }} />
          )}
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
      ) : !any && hidden.length === 0 && !showReview ? (
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
          <div className="mt-tabsrow">
            <Tabs aria-label="Which meetings" size="sm" value={tab} onChange={(v) => setTab(v as MeetingsTab)} idPrefix="mt" data-testid="meetings-tabs"
              items={[
                { value: "all", label: "All", count: allCount ?? undefined },
                ...(showReview ? [{ value: "review", label: "To review", count: reviewCount || undefined }] : []),
                { value: "customers", label: "With customers" },
                { value: "internal", label: "Internal" },
              ]} />
            {allView && myTeams.length > 1 && (
              <Select aria-label="Team" value={teamFilter ?? ""} className="mt-teamfilter" data-testid="meetings-team-filter"
                onChange={(e) => setUrl({ team: e.target.value || null })}
                options={[{ value: "", label: "All teams" }, ...myTeams.map((t) => ({ value: t.id, label: t.name }))]} />
            )}
          </div>
          {tab === "review" ? (
            <div role="tabpanel" id="mt-panel-review" aria-labelledby="mt-tab-review" className="mt-review">
              <p className="mt-review__intro">Your recorded Zoom meetings wait for you: everyone on them was from the company, or you asked to decide first. Only you see them until you share one.</p>
              <ZoomReviewList workspace={workspaceId} teamId={spaceTeam?.id ?? filterTeam?.id ?? null}
                emptyText="No Zoom meetings wait for your decision." onDecided={() => { void refreshHead(); teamsChanged(workspaceId); }} />
            </div>
          ) : (
          <div role="tabpanel" id={`mt-panel-${tab}`} aria-labelledby={`mt-tab-${tab}`}>
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
              <li><button type="button" className="mt-series__chip" aria-pressed={seriesFilter === null} onClick={() => setSeriesFilter(null)}>All series</button></li>
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
                <Button size="sm" variant="secondary" onClick={() => { setFilter(""); setSeriesFilter(null); if (audience) setTab("all"); }}>Clear the filters</Button>
              </div>
            )}
            {shown.length === 0 && !filtered && !list.stale && (
              <div className="mt-nomatch">
                <Icon name="mic" />
                <p>No meetings here yet.</p>
              </div>
            )}
            {months.map((g, gi) => (
              <section key={g.key} className="mt-monthgroup" aria-label={g.key === "all" ? undefined : g.key === "none" ? "No date" : monthLabel(g.key)}>
                {g.key !== "all" && <h3 className="mt-month" data-testid="month-header">{g.key === "none" ? "No date" : monthLabel(g.key)}{/* the last month may go on in the next page */}{(gi < months.length - 1 || !list.next) && <small> {g.items.length}</small>}</h3>}
                <ul className="mt-rows">
                  {g.items.map((m) => <MeetingRow key={m.id} m={m} showTeams={allView && !filterTeam} onDelete={m.can_delete ? () => setDeleting(m.id) : undefined} />)}
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
          </div>
          )}
        </section>
      )}

      <ImportMeeting open={importing} onClose={() => setImporting(false)} workspaceId={workspaceId} status={status} team={spaceTeam?.id ?? null}
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

/**
 * One meeting in the list (nav redesign 2026-11-18, "combined"): the date, the title with its series, teams and a line
 * of the summary, the HubSpot deal it's filed in (or "Pick the deal"), the time and length, and marks for a kept
 * recording and the transcript. The whole row opens the meeting; Transcript, Ask and ⋯ sit on the right.
 */
function MeetingRow({ m, onDelete, showTeams }: { m: MeetingCard; onDelete?: () => void; showTeams?: boolean }) {
  const toast = useToast();
  const [y, mo, d] = (m.date || "").split("-").map(Number);
  const dt = y ? new Date(y, (mo || 1) - 1, d || 1) : null;
  const title = m.title || "Meeting";
  const when = [m.time, m.duration_s ? fmtDuration(m.duration_s) : null].filter(Boolean).join(" · ");
  const menu: MenuEntry[] = [
    { label: "Open", icon: "arrowRight", href: `/${m.slug}` },
    ...(m.transcript_slug ? [{ label: "Transcript", icon: "lines", href: `/${m.transcript_slug}` }] : []),
    { label: "Ask this meeting", icon: "sparkle", href: `/${m.slug}?ask=1` },
    ...(m.deal ? [{ label: `Open ${m.deal.company || m.deal.name || "the deal"}`, icon: "briefcase", href: m.deal.href }] : []),
    { label: "Copy link", icon: "link", onClick: () => void copyText(new URL(`/${m.slug}`, window.location.origin).toString()).then((ok) => (ok ? toast.success("Link copied") : toast.error("Couldn't copy"))) },
    ...(onDelete ? [{ label: "Delete meeting", icon: "trash", danger: true, separated: true, onClick: onDelete }] : []),
  ];
  const dealLabel = m.deal ? [m.deal.company, m.deal.name].filter(Boolean).join(" — ") || "Deal" : null;
  return (
    <li className="mt-row" data-testid="meeting-card" data-id={m.id} data-series={m.series ? "" : undefined}>
      <Link className="mt-row__link" href={`/${m.slug}`} aria-label={`${title}${m.date ? `, ${fmtDay(m.date)}` : ""}`} />
      <span className="mt-row__date" aria-hidden>
        <small>{dt ? dt.toLocaleDateString(undefined, { month: "short" }) : "—"}</small>
        {dt ? dt.getDate() : ""}
      </span>
      <div className="mt-row__main">
        <p className="mt-card__title">{title}</p>
        <p className="mt-row__sub">
          {m.ai.state === "pending" && <span className="mt-state"><Spinner size={12} /> Summarizing</span>}
          {m.series && m.series !== m.title && (
            <span className="mt-card__series" data-testid="card-series"><span style={{ background: seriesTint(m.series) }} aria-hidden />{m.series}</span>
          )}
          {showTeams && (m.teams ?? []).slice(0, 2).map((t) => <span key={t.id} data-testid="card-team"><TeamChip team={t as { name: string; icon: string | null; color: string }} /></span>)}
          {m.restricted && <Badge size="sm" tone="neutral" icon="lock">Attendees only</Badge>}
          {m.summary
            ? <span className="mt-row__summary" data-testid="card-summary">{m.summary}</span>
            : m.ai.state !== "pending" && m.ai.state !== "done" && m.has_notes
              ? <span className="mt-row__summary mt-row__summary--muted" data-testid="card-summary">Google&apos;s notes are on the page.</span>
              : null}
        </p>
      </div>
      <span className="mt-row__deal">
        {m.deal ? (
          <Link className="mt-row__chip" href={m.deal.href} title={dealLabel ?? undefined} data-testid="card-deal">
            <Icon name="briefcase" /><span>{dealLabel}</span>
          </Link>
        ) : m.deal_pick ? (
          <Link className="mt-row__chip mt-row__chip--pick" href={`/${m.slug}`} data-testid="card-deal-pick">
            <Icon name="briefcase" /><span>Pick the deal</span>
          </Link>
        ) : null}
      </span>
      <span className="mt-row__meta">
        <span className="mt-row__when" data-testid="card-when">{when || (m.date ? fmtDay(m.date) : "")}</span>
        <span className="mt-row__marks">
          {m.has_recording && <span title="Recording kept in Markdrop"><Icon name="film" /><span className="mt-sr">Recording</span></span>}
          {m.has_transcript && <span title="Transcript"><Icon name="lines" /><span className="mt-sr">Transcript</span></span>}
        </span>
      </span>
      <div className="mt-card__actions">
        <Link className="mt-card__act" href={`/${m.slug}?ask=1`} title="Ask this meeting" aria-label={`Ask ${title}`}><Icon name="sparkle" /></Link>
        <Dropdown align="right" portal aria-label={`More for ${title}`} items={menu}
          trigger={<button type="button" className="mt-card__act" aria-label={`More for ${title}`}><Icon name="more" /></button>} />
      </div>
    </li>
  );
}
