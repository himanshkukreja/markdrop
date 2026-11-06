"use client";

/**
 * Home (/dashboard; the installed app's start screen). A work hub, one purpose per section
 * (.work/home/SPEC.md):
 *
 *   Greeting + Ask bar     ask anything (opens the one assistant, components/assistant), ⌘J anywhere
 *   (Turn on notifications) one tap to get mentions / sign-offs on this device (components/push), until "Not now"
 *   Continue               what you opened last, with real previews (lib/cardPreviews, ANYWHERE)
 *   Today | Action items   what needs you now  |  open to-dos that mention you (tick them here)
 *   Meetings               the latest calls across your workspaces; import, connect, ask, open the hub
 *   Workspaces             your teams, with people and counts; + New workspace
 *
 * A new account (nothing anywhere yet) gets "Get started" instead: four first steps.
 * Two requests in parallel (GET /me/recent, GET /home); every section has a skeleton of its own shape,
 * previews load only on screen. Every list is the server's, decided for this person.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Anchor, Avatar, AvatarGroup, Button, ConfirmDialog, Dialog, Dropdown, Icon, IconButton, Kbd, Skeleton, cx, useToast, type MenuEntry } from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { useLocationSearch, useMounted } from "@/components/shell/useLocation";
import { openNotifications } from "@/components/shell/NotificationBell";
import { WorkspaceTile } from "@/components/shell/SideNav";
import NameCard from "@/components/dashboard/NameCard";
import { PushPromptCard } from "@/components/push/PushPromptCard";
import { relativeTime } from "@/components/dashboard/format";
import { PERSIST_KEY, openAssistant, setAssistantThread, useAssistantHere } from "@/components/assistant/store";
import { forgetChat } from "@/components/chat/useChat";
import { askHome, clearAskThreads, deleteAskThread, getAskSuggestions, type AskHomeData, type AskSuggestions, type AskThreadCard } from "@/lib/ask";
import { askHref, homeChips } from "@/lib/askCore.mjs";
import { askPlaceholder, askTitle } from "@/components/assistant/assistantCore.mjs";
import { shortAgo } from "@/lib/searchCore.mjs";
import { PreviewBand } from "@/components/workspace/folder/CardPreview";
import { ItemIcon, tintOf } from "@/components/workspace/folder/Listing";
import "@/components/workspace/folder/listing.css";
import { ANYWHERE } from "@/lib/cardPreviews";
import { getHome, tickAction, type HomeAction, type HomeData, type HomeMeeting, type HomeWorkspace } from "@/lib/home";
import { listRecent, type PersonalItem } from "@/lib/me";
import { openNotification, type AppNotification } from "@/lib/notifications";
import { kindLabel } from "@/lib/itemKind";
import { openHref, type WorkspaceItem } from "@/lib/workspaces";
import { meetingsHref } from "@/lib/meetings";
import { track } from "@/lib/track";
import "./home.css";

const CONTINUE_MAX = 10;
const TODAY_SHOWN = 4;
const ACTIONS_SHOWN = 5;
const COVER = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Old /dashboard links that meant the files list (?kind=, ?q=, ?page=, ?gdocs=…) or a workspace. */
const FILES_PARAMS = ["kind", "q", "page", "gdocs", "ws", "folder"];

const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function greeting(h: number) {
  if (h < 5) return "Good evening";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function meetingDay(date: string | null, today: string): string {
  if (!date) return "";
  if (date === today) return "Today";
  const d = new Date(`${date}T12:00:00`);
  const t = new Date(`${today}T12:00:00`);
  const days = Math.round((t.getTime() - d.getTime()) / 86_400_000);
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(d.getFullYear() !== t.getFullYear() ? { year: "numeric" } : {}) });
}

const meetingTitle = (m: HomeMeeting) => m.title || m.page_title || "Meeting";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ── The page ──────────────────────────────────────────────────────────── */

export default function Home() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const mounted = useMounted();
  const search = useLocationSearch();
  const toast = useToast();

  // Old links: /dashboard?kind=… etc. were the files list; they go on to My files (or the workspace).
  const forwarding = useMemo(() => {
    if (!mounted) return false;
    const p = new URLSearchParams(search);
    return FILES_PARAMS.some((k) => p.has(k));
  }, [mounted, search]);
  useEffect(() => {
    if (forwarding) router.replace(`/dashboard/files${window.location.search}`);
  }, [forwarding, router]);

  useEffect(() => {
    if (authLoading || !mounted || user) return;
    router.replace(`/login?next=${encodeURIComponent(`/dashboard${window.location.search}`)}`);
  }, [authLoading, mounted, user, router]);

  // The assistant knows it's on the home; "Ask meetings" narrows it to a workspace's meetings.
  const [askWs, setAskWs] = useState<string | null>(null);
  useAssistantHere(askWs ? { home: true, workspace: askWs, scope: "meetings" } : { home: true });

  // ?ask=<thread> opens that conversation (links from Slack, the old home's URL).
  useEffect(() => {
    if (!mounted) return;
    const p = new URLSearchParams(window.location.search);
    const id = p.get("ask");
    if (!id || !/^[0-9a-f]{24}$/.test(id)) return;
    forgetChat(PERSIST_KEY);
    setAssistantThread(id);
    openAssistant();
    p.delete("ask");
    const qs = p.toString();
    window.history.replaceState(window.history.state, "", `/dashboard${qs ? `?${qs}` : ""}`);
  }, [mounted]);

  const [recent, setRecent] = useState<PersonalItem[] | null>(null);
  const [data, setData] = useState<HomeData | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    setFailed(false);
    listRecent().then((r) => setRecent(r.slice(0, CONTINUE_MAX))).catch(() => setRecent([]));
    getHome().then(setData).catch(() => setFailed(true));
  }, []);
  useEffect(() => {
    if (user && !forwarding) load();
  }, [user, forwarding, load]);
  // Coming back to the app (another tab, the phone's home screen) refreshes quietly.
  useEffect(() => {
    if (!user) return;
    let last = Date.now();
    const back = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < 60_000) return;
      last = Date.now();
      getHome().then(setData).catch(() => {});
      listRecent().then((r) => setRecent(r.slice(0, CONTINUE_MAX))).catch(() => {});
    };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
    };
  }, [user]);

  const askMeetings = useCallback((wsId: string) => {
    setAskWs(wsId);
    track("home_action", { what: "ask_meetings" });
    // After the assistant learns where it is (the next render), open it on Meetings.
    window.setTimeout(() => openAssistant({ scope: "meetings" }), 0);
  }, []);
  const ask = useCallback((question?: string) => {
    track("home_action", { what: question ? "ask" : "ask_open" });
    if (askWs) {
      setAskWs(null);
      window.setTimeout(() => openAssistant({ question, scope: "everything" }), 0);
    } else openAssistant(question ? { question } : {});
  }, [askWs]);

  const today = mounted ? localDay() : "";
  const [hour, setHour] = useState<number | null>(null);
  useEffect(() => setHour(new Date().getHours()), []);

  if (authLoading || !user || forwarding) {
    return <div className="hm" aria-busy="true"><HomeSkeleton /></div>;
  }

  const firstName = (user.name || "").trim().split(/\s+/)[0] || null;
  const loaded = !!data && recent !== null;
  const meetingsToday = data?.meetings.items.filter((m) => m.date === today) ?? [];
  // An empty Today or action items shrinks to a one-line strip above the other, full width, so a tall list
  // beside an empty card doesn't leave a hole under it.
  const todayEmpty = !!data && meetingsToday.length + data.attention.requests.length + data.attention.notifications.length === 0;
  const actionsEmpty = !!data && data.actions.items.length === 0;
  const newcomer = loaded && !recent!.length && !data!.workspaces.length && !data!.meetings.items.length && !data!.actions.items.length;
  const facts: string[] = [];
  if (data) {
    if (meetingsToday.length) facts.push(plural(meetingsToday.length, "meeting") + " today");
    if (data.actions.items.length) facts.push(plural(data.actions.items.length, "open action item"));
    if (data.attention.unread) facts.push(plural(data.attention.unread, "unread notification"));
    if (data.attention.requests_count) facts.push(plural(data.attention.requests_count, "access request"));
  }
  const dateLine = mounted ? new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) : "";

  return (
    <div className="hm" data-testid="home">
      <header className="hm-hello">
        <h1 className="hm-hello__title">
          {hour === null ? "Welcome" : greeting(hour)}{firstName ? <>, <span className="ph-sensitive ph-mask">{firstName}</span></> : ""}
        </h1>
        <p className="hm-hello__sub" data-testid="home-facts">
          {dateLine}
          {facts.length > 0 && <> · {facts.join(" · ")}</>}
          {data && !facts.length && !newcomer && <> · Nothing needs you right now</>}
        </p>
        {newcomer && (
          <p className="hm-hello__pitch">Publish pages, documents and files as links anyone can open, and keep your team&apos;s meetings, decisions and to-dos in one place.</p>
        )}
      </header>

      <AskBar onAsk={ask} onAskMeetings={data?.meetings.items[0] ? () => askMeetings(data.meetings.items[0]!.workspace_id) : null}
        workspaces={data?.workspaces ?? []} liveWs={data ? data.meetings.items[0]?.workspace_id ?? data.workspaces[0]?.id ?? null : null} />

      <NameCard />
      <PushPromptCard />

      {failed && !data && (
        <div className="hm-error" role="alert">
          <Icon name="alert" size={16} />
          <span>Couldn&apos;t load your home. Check your connection.</span>
          <Button size="sm" variant="secondary" iconLeft="refresh" onClick={load}>Try again</Button>
        </div>
      )}

      {newcomer ? (
        <GetStarted />
      ) : (
        <>
          <ContinueSection items={recent} />
          <div className={cx("hm-pair", todayEmpty !== actionsEmpty && "hm-pair--one")}>
            <TodaySection data={data} meetings={meetingsToday} today={today} compact={todayEmpty && !actionsEmpty} />
            <ActionsSection data={data} toast={toast} compact={actionsEmpty && !todayEmpty}
              onTicked={(a) => setData((d) => d && { ...d, actions: { ...d.actions, items: d.actions.items.filter((x) => x !== a) } })}
              onUndone={() => { getHome().then(setData).catch(() => {}); }} />
          </div>
          <MeetingsSection data={data} today={today} onAsk={askMeetings} />
          <WorkspacesSection data={data} />
        </>
      )}
    </div>
  );
}

/* ── Ask bar ───────────────────────────────────────────────────────────── */

type BarScope = { kind: "everything" | "workspace" | "mine"; workspace?: string; name?: string };

/**
 * The home's Ask bar: "Ask" with a scope chip (Everything · a workspace · My files). Everything asks in the
 * ✦ Ask panel; a workspace or My files opens the Ask page on that scope. Under it, live chips: the
 * workspace's team questions (GET /ask/suggestions, the one of your newest meeting by default) and your own,
 * each asking at once on the Ask page; the static ones when there are none yet.
 */
function AskBar({ onAsk, onAskMeetings, workspaces, liveWs }: {
  onAsk: (q?: string) => void; onAskMeetings: (() => void) | null; workspaces: HomeWorkspace[]; liveWs: string | null;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<BarScope>({ kind: "everything" });
  const [askData, setAskData] = useState<AskHomeData | null>(null);
  const [sug, setSug] = useState<AskSuggestions | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const refreshAsk = useCallback(() => { askHome().then(setAskData).catch(() => {}); }, []);
  useEffect(() => { refreshAsk(); }, [refreshAsk]);
  const sugWs = scope.kind === "workspace" ? scope.workspace ?? null : scope.kind === "mine" ? null : liveWs;
  useEffect(() => {
    setSug(null);
    if (!sugWs) return;
    let on = true;
    getAskSuggestions(sugWs).then((x) => { if (on) setSug(x); }).catch(() => {});
    return () => { on = false; };
  }, [sugWs]);
  const recent = askData?.recent ?? [];
  const off = askData && askData.status.enabled === false ? askData.status.message || "AI isn't available right now." : null;
  const input = useRef<HTMLInputElement>(null);
  const mounted = useMounted();
  const mac = mounted && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
  const live = homeChips(sug, 2);
  const goAsk = (question: string | null, to: BarScope = scope) => {
    track("home_action", { what: "ask_page", scope: to.kind });
    router.push(askHref({ workspace: to.kind === "workspace" ? to.workspace : null, mine: to.kind === "mine", q: question }));
  };
  // Live: two of the team's questions (each asks on the Ask page, in that workspace), then your action items.
  const chips: Array<{ label: string; icon: string; run: () => void; testId?: string }> = live.length ? [
    ...live.map((c) => ({ label: c.label, icon: c.team ? "sparkle" : "mic", testId: "home-ask-live",
      run: () => goAsk(c.question, { kind: "workspace", workspace: sugWs ?? undefined }) })),
    { label: "My action items", icon: "check", run: () => onAsk("What are my open action items?") },
    ...(recent.length ? [{ label: "Recent questions", icon: "history", run: () => setHistoryOpen(true) }] : []),
  ] : [
    { label: "Catch me up", icon: "calendar", run: () => onAsk("Catch me up on this week") },
    { label: "My action items", icon: "check", run: () => onAsk("What are my open action items?") },
    ...(onAskMeetings ? [{ label: "Ask my meetings", icon: "mic", run: onAskMeetings }] : []),
    ...(recent.length ? [{ label: "Recent questions", icon: "history", run: () => setHistoryOpen(true) }] : []),
  ];
  const scopeLabel = scope.kind === "workspace" ? scope.name || "Workspace" : scope.kind === "mine" ? "My files" : "Everything";
  const scopeItems: MenuEntry[] = [
    { label: "Everything", icon: scope.kind === "everything" ? "check" : "sparkle", onClick: () => setScope({ kind: "everything" }) },
    ...workspaces.map((w) => ({ label: w.name, icon: scope.kind === "workspace" && scope.workspace === w.id ? "check" : "users",
      onClick: () => setScope({ kind: "workspace", workspace: w.id, name: w.name }) })),
    { label: "My files", icon: scope.kind === "mine" ? "check" : "user", onClick: () => setScope({ kind: "mine" }) },
  ];
  const title = askTitle(scope.kind, scope.name);
  return (
    <section className="hm-ask" aria-label="Ask" data-testid="home-ask">
      <form
        className="hm-ask__bar"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const v = q.trim();
          if (scope.kind === "everything") onAsk(v || undefined);
          else goAsk(v || null);
          setQ("");
        }}
        onClick={(e) => { if (e.target === e.currentTarget) input.current?.focus(); }}
      >
        <span className="hm-ask__spark" aria-hidden><Icon name="sparkle" size={16} /></span>
        {workspaces.length > 0 && (
          <Dropdown align="left" minWidth={220} aria-label="Ask about" items={scopeItems} className="hm-ask__scope-wrap"
            trigger={(
              <button type="button" className="hm-ask__scope md-focus" data-testid="home-ask-scope" title={`${title}: change what to ask about`}>
                <span className="hm-ask__scope-label">{scopeLabel}</span>
                <Icon name="chevronDown" size={14} />
              </button>
            )} />
        )}
        <input
          ref={input}
          className="hm-ask__input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={scope.kind === "everything" ? "Ask about your work…" : askPlaceholder(scope.kind, scope.name)}
          aria-label={title}
          maxLength={500}
          enterKeyHint="send"
          data-testid="home-ask-input"
        />
        {!q && <span className="hm-ask__kbd" aria-hidden><Kbd>{mac ? "⌘" : "Ctrl"}</Kbd><Kbd>J</Kbd></span>}
        <button type="submit" className="hm-ask__send md-focus" aria-label={q.trim() ? "Ask" : scope.kind === "everything" ? "Open Ask" : `Open ${title}`}>
          <Icon name={q.trim() ? "arrowUp" : "sparkle"} size={16} />
        </button>
      </form>
      <div className="hm-ask__chips">
        {chips.map((c) => (
          <button key={c.label} type="button" className="hm-chip md-focus" onClick={c.run}
            data-testid={c.icon === "history" ? "home-ask-history" : c.testId} aria-haspopup={c.icon === "history" ? "dialog" : undefined}>
            <Icon name={c.icon} size={14} /> <span className="hm-chip__text">{c.label}</span>
          </button>
        ))}
      </div>
      {off && <p className="hm-ask__off" role="status"><Icon name="clock" size={14} /> {off}</p>}
      <AskHistory open={historyOpen} onClose={() => setHistoryOpen(false)} recent={recent} onChanged={refreshAsk} />
    </section>
  );
}

/** Recent questions (the conversations with Ask): open one in the assistant, forget one, clear all. */
function AskHistory({ open, onClose, recent, onChanged }: { open: boolean; onClose: () => void; recent: AskThreadCard[]; onChanged: () => void }) {
  const toast = useToast();
  const [clearing, setClearing] = useState(false);
  const openThread = (id: string) => {
    onClose();
    forgetChat(PERSIST_KEY);
    setAssistantThread(id);
    openAssistant();
  };
  return (
    <>
      <Dialog open={open && !clearing} onClose={onClose} title="Recent questions" size="md"
        footer={recent.length ? <Button variant="ghost" onClick={() => setClearing(true)}>Clear all</Button> : undefined}>
        {recent.length === 0 ? <p className="text-body text-text-secondary">No questions yet.</p> : (
          <ul className="hm-list hm-history" data-testid="home-ask-history-list">
            {recent.map((r) => (
              <li key={r.id} className="hm-history__row">
                <button type="button" className="hm-row md-focus" onClick={() => openThread(r.id)}>
                  <span className="hm-row__lead" aria-hidden><Icon name="message" size={16} /></span>
                  <span className="hm-row__main">
                    <span className="hm-row__title ph-sensitive" dir="auto">{r.title}</span>
                    <span className="hm-row__meta">{r.turns > 1 ? `${r.turns} questions · ` : ""}{shortAgo(r.updated_at)}</span>
                  </span>
                </button>
                <IconButton icon="x" label={`Forget “${r.title}”`} className="size-11 shrink-0"
                  onClick={async () => {
                    try { await deleteAskThread(r.id); onChanged(); } catch { toast.error("Couldn't remove it. Try again."); }
                  }} />
              </li>
            ))}
          </ul>
        )}
      </Dialog>
      <ConfirmDialog
        open={clearing}
        onClose={() => setClearing(false)}
        title="Clear recent questions?"
        body={<p className="text-body text-text-secondary">Every conversation you had with Ask is deleted. Your documents aren&apos;t touched.</p>}
        confirmLabel="Clear"
        onConfirm={async () => { await clearAskThreads(); setAssistantThread(null); forgetChat(PERSIST_KEY); setClearing(false); onClose(); onChanged(); toast.success("Recent questions cleared"); }}
      />
    </>
  );
}

/* ── Section frame ─────────────────────────────────────────────────────── */

function Section({ id, title, count, action, children, className }: {
  id: string; title: string; count?: number | null; action?: React.ReactNode; children: React.ReactNode; className?: string;
}) {
  return (
    <section className={cx("hm-sec", className)} aria-labelledby={`hm-${id}`} data-testid={`home-${id}`}>
      <div className="hm-sec__head">
        <h2 id={`hm-${id}`} className="hm-sec__title">
          {title}
          {count ? <span className="hm-sec__count">{count}</span> : null}
        </h2>
        {action && <div className="hm-sec__action">{action}</div>}
      </div>
      {children}
    </section>
  );
}

function SeeAll({ href, onClick, children = "See all" }: { href?: string; onClick?: () => void; children?: React.ReactNode }) {
  const cls = "hm-link md-focus";
  if (href) return <Anchor href={href} className={cls}>{children}<Icon name="chevronRight" size={14} /></Anchor>;
  return <button type="button" className={cls} onClick={onClick}>{children}<Icon name="chevronRight" size={14} /></button>;
}

/** A row of cards that scrolls sideways (snap), with arrow buttons where there's a mouse. */
function Rail({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  const box = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const measure = useCallback(() => {
    const el = box.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft <= 2, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2 });
  }, []);
  useEffect(() => {
    measure();
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, children]);
  const by = (dir: 1 | -1) => box.current?.scrollBy({ left: dir * Math.max(240, (box.current?.clientWidth ?? 600) * 0.8), behavior: "smooth" });
  return (
    <div className="hm-rail">
      <ul ref={box} className="hm-rail__track" aria-label={label} onScroll={measure} data-testid={testId}>{children}</ul>
      {!edges.start && <button type="button" className="hm-rail__arrow hm-rail__arrow--prev md-focus" aria-label="Scroll back" onClick={() => by(-1)}><Icon name="chevronLeft" size={16} /></button>}
      {!edges.end && <button type="button" className="hm-rail__arrow hm-rail__arrow--next md-focus" aria-label="Scroll on" onClick={() => by(1)}><Icon name="chevronRight" size={16} /></button>}
    </div>
  );
}

/* ── Continue ──────────────────────────────────────────────────────────── */

function ContinueSection({ items }: { items: PersonalItem[] | null }) {
  if (items && !items.length) return null;
  return (
    <Section id="continue" title="Continue where you left off" action={items && items.length > 3 ? <SeeAll href="/recent">All recent</SeeAll> : null}>
      <Rail label="Recently opened" testId="home-continue-list">
        {items === null
          ? [0, 1, 2, 3].map((i) => <li key={i} className="hm-card hm-card--item" aria-hidden><Skeleton height={124} variant="rect" /><span className="hm-card__body"><Skeleton width="70%" /><Skeleton width="40%" height={10} /></span></li>)
          : items.map((it) => <ContinueCard key={it.slug} it={it} />)}
      </Rail>
    </Section>
  );
}

function ContinueCard({ it }: { it: PersonalItem }) {
  const w = it as unknown as WorkspaceItem;
  const title = (it.title || "").trim() || it.original_filename || it.slug;
  const where = it.workspace ? [it.workspace.name, ...(it.folder ? [it.folder.name] : [])].join(" › ") : "My files";
  return (
    <li className="hm-card hm-card--item">
      <PreviewBand workspaceId={ANYWHERE} it={w} title={title} tint={tintOf(w)} kind={kindLabel(it)} fallback={<ItemIcon it={w} />} />
      <span className="hm-card__body">
        <Anchor href={openHref(it.slug, it.url, it.encrypted)} className="hm-card__link md-focus" data-testid="home-continue-card">
          <span className="hm-card__title ph-sensitive" dir="auto">{title}</span>
        </Anchor>
        <span className="hm-card__meta">
          <span className="truncate ph-sensitive ph-mask" dir="auto">{where}</span>
          {it.viewed_at && <><span aria-hidden>·</span><span className="shrink-0">{relativeTime(it.viewed_at)}</span></>}
        </span>
      </span>
    </li>
  );
}

/* ── Today ─────────────────────────────────────────────────────────────── */

type TodayRow =
  | { k: "meeting"; m: HomeMeeting }
  | { k: "note"; n: AppNotification }
  | { k: "request"; r: HomeData["attention"]["requests"][number] };

function TodaySection({ data, meetings, today, compact }: { data: HomeData | null; meetings: HomeMeeting[]; today: string; compact?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [all, setAll] = useState(false);
  const rows: TodayRow[] = data ? [
    ...meetings.map((m) => ({ k: "meeting" as const, m })),
    ...data.attention.requests.map((r) => ({ k: "request" as const, r })),
    ...data.attention.notifications.map((n) => ({ k: "note" as const, n })),
  ] : [];
  const shown = all ? rows : rows.slice(0, TODAY_SHOWN);
  const more = rows.length - shown.length;
  const unread = data ? data.attention.unread : 0;

  const open = async (n: AppNotification) => {
    try {
      const r = await openNotification(n.id);
      router.push(r.href);
    } catch {
      toast.error("You can't open that page any more.");
    }
  };

  return (
    <Section
      id="today"
      title="Today"
      className={compact ? "hm-sec--compact" : undefined}
      count={rows.length || null}
      action={unread > 0 ? <SeeAll onClick={openNotifications}>All notifications</SeeAll> : null}
    >
      {!data ? <RowsSkeleton n={3} /> : rows.length === 0 ? (
        <Quiet icon="checkCircle" title="You're all caught up" text="Today's meetings, mentions, sign-off requests and access requests show up here." />
      ) : (
        <>
          <ul className="hm-list">
            {shown.map((row) => {
              if (row.k === "meeting") {
                const m = row.m;
                return (
                  <li key={`m${m.id}`}>
                    <Anchor href={`/${encodeURIComponent(m.slug)}`} className="hm-row md-focus" data-testid="home-today-meeting">
                      <span className="hm-row__lead hm-row__lead--meeting" aria-hidden><Icon name="mic" size={16} /></span>
                      <span className="hm-row__main">
                        <span className="hm-row__title ph-sensitive" dir="auto">{meetingTitle(m)}</span>
                        <span className="hm-row__meta">{[m.time ? `Today ${m.time}` : "Today", m.series, m.workspace_name].filter(Boolean).join(" · ")}</span>
                      </span>
                    </Anchor>
                  </li>
                );
              }
              if (row.k === "request") {
                const r = row.r;
                const who = r.requester.name || r.requester.email;
                return (
                  <li key={`r${r.id}`}>
                    <Anchor href={`/requests/${encodeURIComponent(r.id)}`} className="hm-row md-focus">
                      <span className="hm-row__lead" aria-hidden><Icon name="key" size={16} /></span>
                      <span className="hm-row__main">
                        <span className="hm-row__title"><span className="ph-sensitive ph-mask">{who}</span> asked to {r.role_requested === "editor" ? "edit" : "open"} <span className="ph-sensitive">“{r.document.title || r.document.slug}”</span></span>
                        <span className="hm-row__meta">Access request · {relativeTime(r.created_at)}</span>
                      </span>
                    </Anchor>
                  </li>
                );
              }
              const n = row.n;
              return (
                <li key={`n${n.id}`}>
                  <button type="button" className="hm-row md-focus" onClick={() => void open(n)}>
                    <Avatar name={n.actor.name} src={n.actor.picture ?? undefined} size="sm" className="hm-row__avatar" />
                    <span className="hm-row__main">
                      <span className="hm-row__title ph-sensitive" dir="auto">{n.text}</span>
                      <span className="hm-row__meta">{n.kind === "signoff_requested" ? "Sign-off request" : n.kind === "shared" ? "Shared with you" : "Mention"} · {relativeTime(n.created_at)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {more > 0 && <button type="button" className="hm-more md-focus" onClick={() => setAll(true)}>Show {more} more</button>}
        </>
      )}
    </Section>
  );
}

/* ── Action items ──────────────────────────────────────────────────────── */

function ActionsSection({ data, onTicked, onUndone, toast, compact }: {
  data: HomeData | null; onTicked: (a: HomeAction) => void; onUndone: () => void; toast: ReturnType<typeof useToast>; compact?: boolean;
}) {
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(() => new Set());
  const items = data?.actions.items ?? [];
  const shown = all ? items : items.slice(0, ACTIONS_SHOWN);
  const more = items.length - shown.length;
  const key = (a: HomeAction) => `${a.slug}#${a.block ?? a.text}`;

  const tick = async (a: HomeAction) => {
    if (!a.block) return;
    const k = key(a);
    setBusy(k);
    try {
      await tickAction(a.slug, a.block);
      setDone((s) => new Set(s).add(k));
      track("home_action", { what: "tick" });
      toast.toast({
        message: "Marked done", kind: "success",
        action: {
          label: "Undo",
          onClick: () => {
            void tickAction(a.slug, a.block!, false)
              .then(() => { setDone((s) => { const n = new Set(s); n.delete(k); return n; }); onUndone(); })
              .catch((e) => toast.error(e instanceof Error ? e.message : "Couldn't undo that."));
          },
        },
      });
      window.setTimeout(() => onTicked(a), 700);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't mark it done. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section id="actions" title="Your action items" count={items.length + (data?.actions.hidden ?? 0) || null} className={compact ? "hm-sec--compact" : undefined}>
      {!data ? <RowsSkeleton n={3} /> : items.length === 0 ? (
        <Quiet icon="check" title="No open action items" text="To-dos that @mention you, in meeting notes or any page, show up here." />
      ) : (
        <>
          <ul className="hm-list">
            {shown.map((a) => {
              const k = key(a);
              const isDone = done.has(k);
              return (
                <li key={k} className={cx("hm-todo", isDone && "hm-todo--done")} data-testid="home-action">
                  {a.can_tick ? (
                    <button type="button" role="checkbox" aria-checked={isDone} disabled={busy === k || isDone}
                      className="hm-todo__box md-focus" aria-label={`Mark “${a.text}” done`} onClick={() => void tick(a)} data-testid="home-action-tick">
                      <span className="hm-todo__check" aria-hidden>{isDone && <Icon name="check" size={12} />}</span>
                    </button>
                  ) : (
                    <span className="hm-todo__box hm-todo__box--off" title="You can't edit that page" aria-hidden><span className="hm-todo__check" /></span>
                  )}
                  <Anchor href={a.url} className="hm-todo__main md-focus">
                    <span className="hm-row__title ph-sensitive" dir="auto">{a.text}</span>
                    <span className="hm-row__meta">
                      <span className="hm-todo__src">
                        {a.meeting && <Icon name="mic" size={12} className="hm-todo__mic" />}
                        <span className="truncate ph-sensitive" dir="auto">{a.title}</span>
                      </span>
                      {a.workspace?.name && <><span aria-hidden>·</span><span className="truncate ph-sensitive ph-mask">{a.workspace.name}</span></>}
                    </span>
                  </Anchor>
                </li>
              );
            })}
          </ul>
          {(more > 0 || data.actions.more) && (
            <button type="button" className="hm-more md-focus" onClick={() => (more > 0 ? setAll(true) : openAssistant({ question: "What are my open action items?" }))}>
              {more > 0 ? `Show ${more} more` : "Ask about all of them"}
            </button>
          )}
        </>
      )}
    </Section>
  );
}

/* ── Meetings ──────────────────────────────────────────────────────────── */

function MeetingsSection({ data, today, onAsk }: { data: HomeData | null; today: string; onAsk: (wsId: string) => void }) {
  const items = data?.meetings.items ?? [];
  const wss = data?.workspaces ?? [];
  const withMeetings = wss.filter((w) => w.meetings > 0);
  const importable = wss.filter((w) => w.can_import);
  if (data && !wss.length) return null;

  const pick = (list: HomeWorkspace[], make: (w: HomeWorkspace) => MenuEntry): MenuEntry[] => list.map(make);
  const importBtn = importable.length === 1 ? (
    <Button size="sm" variant="secondary" iconLeft="plus" href={`${meetingsHref(importable[0]!.id)}?import=1`} data-testid="home-import-meeting">Import meeting</Button>
  ) : importable.length > 1 ? (
    <Dropdown portal aria-label="Import into"
      trigger={<Button size="sm" variant="secondary" iconLeft="plus" iconRight="chevronDown" data-testid="home-import-meeting">Import meeting</Button>}
      items={[{ header: "Import into" }, ...pick(importable, (w) => ({ label: w.name, icon: "folder", href: `${meetingsHref(w.id)}?import=1` }))]} />
  ) : null;
  const askable = withMeetings.length ? withMeetings : [];
  const askBtn = askable.length === 1 ? (
    <Button size="sm" variant="ghost" iconLeft="sparkle" onClick={() => onAsk(askable[0]!.id)} data-testid="home-ask-meetings">Ask</Button>
  ) : askable.length > 1 ? (
    <Dropdown portal aria-label="Ask the meetings of"
      trigger={<Button size="sm" variant="ghost" iconLeft="sparkle" data-testid="home-ask-meetings">Ask</Button>}
      items={[{ header: "Ask the meetings of" }, ...pick(askable, (w) => ({ label: w.name, icon: "mic", onClick: () => onAsk(w.id) }))]} />
  ) : null;
  const connectWs = importable[0];
  const connect = data && !data.meet.connected && connectWs;

  return (
    <Section id="meetings" title="Meetings" action={data ? <>{askBtn}{importBtn}</> : null}>
      {!data ? (
        <Rail label="Meetings">{[0, 1, 2].map((i) => <li key={i} className="hm-card hm-card--meeting" aria-hidden><Skeleton height={64} variant="rect" /><span className="hm-card__body"><Skeleton width="80%" /><Skeleton width="50%" height={10} /><Skeleton width="90%" height={10} /></span></li>)}</Rail>
      ) : items.length ? (
        <Rail label="Recent meetings" testId="home-meetings-list">
          {items.map((m) => <MeetingCard key={m.id} m={m} today={today} />)}
        </Rail>
      ) : (
        <Quiet icon="mic" title="Bring your meetings in"
          text="Import a transcript or Google Meet notes. Markdrop writes the summary, the decisions and everyone's action items."
          action={importable[0] ? <Button size="sm" variant="secondary" iconLeft="plus" href={`${meetingsHref(importable[0].id)}?import=1`}>Import a meeting</Button> : null} />
      )}
      {data && (withMeetings.length > 0 || connect || data.meet.connected) && (
        <div className="hm-meet-foot">
          {withMeetings.map((w) => (
            <Anchor key={w.id} href={meetingsHref(w.id)} className="hm-link md-focus" data-testid="home-open-meetings">
              {withMeetings.length > 1 ? <><span className="ph-sensitive ph-mask">{w.name}</span>&nbsp;meetings</> : "Open Meetings"}<Icon name="chevronRight" size={14} />
            </Anchor>
          ))}
          {data.meet.connected && data.meet.workspace_id && (
            <Anchor href={`${meetingsHref(data.meet.workspace_id)}?check=1`} className="hm-link hm-link--quiet md-focus" data-testid="home-check-meetings">
              <Icon name="refresh" size={14} /> Check for new meetings
            </Anchor>
          )}
          {connect && (
            <Anchor href={`${meetingsHref(connectWs.id)}?connect=1`} className="hm-link hm-link--quiet md-focus" data-testid="home-connect-meet">
              <Icon name="refresh" size={14} /> Connect Google Meet to bring calls in automatically
            </Anchor>
          )}
        </div>
      )}
    </Section>
  );
}

function MeetingCard({ m, today }: { m: HomeMeeting; today: string }) {
  const cover = m.cover && COVER.test(m.cover) ? `/page-covers/thumbs/${m.cover}.webp` : null;
  const day = meetingDay(m.date, today);
  return (
    <li className={cx("hm-card hm-card--meeting", m.date === today && "hm-card--today")}>
      <span className="hm-card__cover" aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {cover ? <img src={cover} alt="" loading="lazy" decoding="async" /> : <Icon name="mic" size={20} />}
        {m.series && <span className="hm-card__series ph-sensitive">{m.series}</span>}
      </span>
      <span className="hm-card__body">
        <Anchor href={`/${encodeURIComponent(m.slug)}`} className="hm-card__link md-focus" data-testid="home-meeting-card">
          <span className="hm-card__title ph-sensitive" dir="auto">{meetingTitle(m)}</span>
        </Anchor>
        <span className="hm-card__meta">
          <span className={cx("shrink-0", m.date === today && "hm-today")}>{day}{m.time ? ` · ${m.time}` : ""}</span>
          <span aria-hidden>·</span>
          <span className="truncate ph-sensitive ph-mask">{m.workspace_name}</span>
        </span>
        {m.summary ? <span className="hm-card__summary ph-sensitive" dir="auto">{m.summary}</span>
          : <span className="hm-card__summary hm-card__summary--quiet">{m.ai.state === "pending" ? "Writing the summary…" : "No summary yet"}</span>}
        <span className="hm-card__foot">
          {m.attendees.length > 0 && (
            <AvatarGroup className="hm-card__people">
              {m.attendees.slice(0, 3).map((a, i) => <Avatar key={i} name={a.name} size="sm" />)}
            </AvatarGroup>
          )}
          {m.attendee_count > 3 && <span className="hm-card__more">+{m.attendee_count - 3}</span>}
          {m.action_items > 0 && <span className="hm-card__tag"><Icon name="check" size={12} />{plural(m.action_items, "action")}</span>}
          {m.restricted && <span className="hm-card__tag" title="Only the people who were there"><Icon name="lock" size={12} />Attendees</span>}
        </span>
      </span>
    </li>
  );
}

/* ── Workspaces ────────────────────────────────────────────────────────── */

function WorkspacesSection({ data }: { data: HomeData | null }) {
  const wss = data?.workspaces ?? [];
  return (
    <Section id="workspaces" title="Workspaces" action={data ? <Button size="sm" variant="ghost" iconLeft="plus" href="/settings/workspaces?new=1">New workspace</Button> : null}>
      {!data ? (
        <ul className="hm-ws">{[0, 1].map((i) => <li key={i} className="hm-wscard" aria-hidden><Skeleton width={40} height={40} variant="rect" /><span className="hm-wscard__main"><Skeleton width="50%" /><Skeleton width="70%" height={10} /></span></li>)}</ul>
      ) : wss.length ? (
        <ul className="hm-ws" aria-label="Your workspaces">
          {wss.map((w) => (
            <li key={w.id} className="hm-wscard">
              <WorkspaceTile ws={{ name: w.name, branding: w.branding as never }} size={40} />
              <span className="hm-wscard__main">
                <Anchor href={`/w/${encodeURIComponent(w.id)}`} className="hm-card__link md-focus" data-testid="home-workspace">
                  <span className="hm-wscard__name ph-sensitive ph-mask">{w.name}</span>
                </Anchor>
                <span className="hm-row__meta">
                  {[plural(w.item_count, "item"), plural(w.member_count, "person", "people"), w.meetings ? plural(w.meetings, "meeting") : null].filter(Boolean).join(" · ")}
                </span>
              </span>
              {w.people.length > 0 && (
                <AvatarGroup className="hm-wscard__people">
                  {w.people.slice(0, 3).map((p, i) => <Avatar key={i} name={p.is_you ? `${p.name || "You"} (you)` : p.name || "Someone"} src={p.picture ?? undefined} size="sm" />)}
                </AvatarGroup>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <Quiet icon="users" title="Work together in a workspace"
          text="Folders, pages and meetings your team shares, on your own domain if you like."
          action={<Button size="sm" variant="secondary" iconLeft="plus" href="/settings/workspaces?new=1">Create a workspace</Button>} />
      )}
    </Section>
  );
}

/* ── First run ─────────────────────────────────────────────────────────── */

function GetStarted() {
  const steps = [
    { href: "/pages/new", icon: "doc", tint: "var(--cat-document)", title: "Write a page", desc: "Notes, specs, plans. Share it as a link.", id: "page" },
    { href: "/upload", icon: "upload", tint: "var(--cat-artifact)", title: "Upload a file", desc: "PDF, HTML, sheet, video: it opens in any browser.", id: "upload" },
    { href: "/settings/workspaces?new=1", icon: "users", tint: "var(--cat-share)", title: "Create a workspace", desc: "Your team's folders, pages and meetings.", id: "workspace" },
    { href: "/settings/connections", icon: "link", tint: "var(--cat-sync)", title: "Connect your tools", desc: "AI assistants like Claude, VS Code and the CLI.", id: "connect" },
  ];
  return (
    <section className="hm-sec" aria-labelledby="hm-start" data-testid="home-get-started">
      <div className="hm-sec__head"><h2 id="hm-start" className="hm-sec__title">Get started</h2></div>
      <ul className="hm-start">
        {steps.map((s) => (
          <li key={s.id}>
            <Anchor href={s.href} className="hm-start__step md-focus" data-testid={`home-start-${s.id}`}>
              <span className="hm-start__icon" style={{ color: s.tint }} aria-hidden><Icon name={s.icon} size={20} /></span>
              <span className="hm-start__text">
                <span className="hm-start__title">{s.title}</span>
                <span className="hm-row__meta hm-start__desc">{s.desc}</span>
              </span>
              <Icon name="chevronRight" size={16} className="hm-start__go" />
            </Anchor>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ── Bits ──────────────────────────────────────────────────────────────── */

function Quiet({ icon, title, text, action }: { icon: string; title: string; text: string; action?: React.ReactNode }) {
  return (
    <div className="hm-quiet">
      <span className="hm-quiet__icon" aria-hidden><Icon name={icon} size={18} /></span>
      <span className="hm-quiet__text">
        <span className="hm-quiet__title">{title}</span>
        <span className="hm-row__meta hm-quiet__desc">{text}</span>
        {action && <span className="hm-quiet__action">{action}</span>}
      </span>
    </div>
  );
}

function RowsSkeleton({ n }: { n: number }) {
  return (
    <ul className="hm-list" aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <li key={i} className="hm-row hm-row--skel"><Skeleton width={32} height={32} variant="rect" /><span className="hm-row__main"><Skeleton width="75%" /><Skeleton width="40%" height={10} /></span></li>
      ))}
    </ul>
  );
}

function HomeSkeleton() {
  return (
    <>
      <span className="md-visually-hidden">Loading your home</span>
      <div className="hm-hello"><Skeleton width={280} height={30} /><Skeleton width={220} height={12} /></div>
      <Skeleton height={52} variant="rect" className="hm-skel-ask" />
    </>
  );
}
