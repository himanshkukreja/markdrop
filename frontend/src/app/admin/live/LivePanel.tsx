"use client";

import { useMemo, useState } from "react";
import { Alert, Badge, Button, EmptyState, SegmentedControl, cx } from "@/components/ui";
import StatTile from "@/components/kit/StatTile";
import { LoadingBlock, PageHead } from "../shared";
import { isPreview, type Kind, type LiveSession, type PageRef, type StreamEvent } from "../journeys/api";
import {
  DocLink, EYEBROW, KindMark, LiveDot, NavContext, NavLink, PageIcon, Panel, PhErrorState, StaleNotice, Who, clock, countryFlag, fmtNum,
  hrefFor, labelClass, pageName, pageSub, useNow, type JState, type Nav, type Patch,
} from "../journeys/bits";
import { ReplayPlayer } from "../journeys/ReplayPlayer";
import { SetupCard } from "../journeys/SetupCard";
import { LIVE_POLL_MS, useLiveFeed } from "./useLiveFeed";
import styles from "./live.module.css";

type StreamFilter = "all" | "key" | "clicks" | "errors";
const FILTERS: { value: StreamFilter; label: string; kinds: Kind[] | null }[] = [
  { value: "all", label: "Everything", kinds: null },
  { value: "key", label: "Key moments", kinds: ["pageview", "read", "publish", "share", "export", "connect", "signin", "cta", "play", "error", "rage"] },
  { value: "clicks", label: "Clicks", kinds: ["click", "form", "rage"] },
  { value: "errors", label: "Errors", kinds: ["error", "rage"] },
];

/** Stream rows shown at first, and added by "Show more". */
const STREAM_STEP = 30;

/** Journeys links from Live (a person, a page) open the Journeys section. */
const JOURNEYS_STATE: JState = { jt: "people", range: null, q: "", kind: "all", person: null, path: null, who: null };

/** "now", "12s ago", "4 min ago": live times are finer than Journeys' "just now". */
function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

/**
 * Admin → Live: what is happening on markdrop.in right now. Sessions active in the last 30
 * minutes (who, where, the page they're on, their last action, a replay that follows them
 * live), the pages people are on, and the event stream as it arrives. One poll every 10 s
 * (GET /api/v1/admin/journeys/live/feed, shared across admins), paused while the tab is hidden
 * or on demand, backing off when PostHog is rate-limiting or slow (the last good data stays up
 * with a notice).
 */
export default function LivePanel({ token, onOpenJourneys }: { token: string; onOpenJourneys: (patch: Patch) => void }) {
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState<StreamFilter>("all");
  const [watching, setWatching] = useState<string | null>(null);
  const [limit, setLimit] = useState(STREAM_STEP);
  const live = useLiveFeed(token, paused);
  const now = useNow(5_000);
  const nav = useMemo<Nav>(() => ({ state: JOURNEYS_STATE, go: (patch) => onOpenJourneys(patch), href: hrefFor }), [onOpenJourneys]);
  const { feed, error } = live;

  const kinds = FILTERS.find((f) => f.value === filter)?.kinds ?? null;
  const shown = useMemo(() => (kinds ? live.events.filter((e) => kinds.includes(e.kind)) : live.events), [live.events, kinds]);

  let body: React.ReactNode;
  if (live.setup) {
    body = <SetupCard status={live.setup.status} />;
  } else if (error && !feed) {
    body = <PhErrorState error={error} onRetry={live.refresh} title="Couldn't load live activity" />;
  } else if (!feed) {
    body = <LoadingBlock size="md" label="Loading live activity" minHeight={480} />;
  } else {
    const c = feed.counts;
    body = (
      <div className="flex flex-col gap-4">
        <StaleNotice stale={feed.stale} error={error} />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-live="polite">
          <StatTile size="md" label="Visitors now" value={fmtNum(c.visitors_now)} caption={`people · last ${feed.now_min} min`} />
          <StatTile size="md" label="Active sessions" value={`${fmtNum(c.sessions)}${c.capped ? "+" : ""}`} caption={`last ${feed.window_min} min`} />
          <StatTile size="md" label="Events" value={fmtNum(c.events_now)} caption={`last ${feed.now_min} min`} />
          <StatTile size="md" label="Page views" value={fmtNum(c.pageviews)} caption={`last ${feed.window_min} min`} />
        </div>

        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <Panel
            eyebrow={`Last ${feed.window_min} min · newest activity first`}
            title="Active sessions"
            titleId="live-sessions"
            pad={false}
            action={<span className="font-mono text-micro text-text-muted">{fmtNum(feed.sessions.length)} {feed.sessions.length === 1 ? "session" : "sessions"}</span>}
          >
            {feed.recordings_error && (
              <p className="border-b border-border px-4 py-2 font-mono text-micro text-text-muted">
                Replays unavailable: {feed.recordings_error.error}
              </p>
            )}
            {feed.sessions.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  icon="wave"
                  title="Nobody on markdrop.in right now"
                  description={`Sessions show up here within seconds of a visit (from people who accepted analytics), and stay for ${feed.window_min} minutes after their last action.`}
                />
              </div>
            ) : (
              <ul className="flex flex-col gap-2 p-2 sm:p-3" aria-labelledby="live-sessions">
                {feed.sessions.map((s) => (
                  <SessionCard
                    key={s.id}
                    s={s}
                    now={now}
                    token={token}
                    watching={watching === s.id}
                    onWatch={(on) => setWatching(on ? s.id : null)}
                  />
                ))}
              </ul>
            )}
          </Panel>

          <div className="flex min-w-0 flex-col gap-4">
            <Panel eyebrow={`Last ${feed.now_min} min`} title="On page now" titleId="live-pages">
              {feed.pages.length ? (
                <ul className="flex flex-col gap-1.5" aria-labelledby="live-pages">
                  {feed.pages.map(({ page, n }) => (
                    <li key={page.key}>
                      <NavLink to={{ jt: "pages", path: page.key, person: null }} className="flex min-w-0 items-center gap-3 rounded-md border-l-2 border-accent bg-surface-inset px-3 py-2 hover:bg-surface-hover">
                        <PageIcon page={page} />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-body text-text">{pageName(page)}</span>
                          <span className="truncate font-mono text-micro text-text-muted">{pageSub(page)}</span>
                        </span>
                        <span className="font-mono text-body-strong tabular-nums text-text" aria-label={`${n} ${n === 1 ? "person" : "people"}`}>{n}</span>
                      </NavLink>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="font-mono text-caption text-text-muted">nobody on a page right now</p>
              )}
            </Panel>

            <Panel eyebrow="Newest first" title="Event stream" titleId="live-stream" pad={false}>
              <div className="border-b border-border px-3 py-2">
                <SegmentedControl<StreamFilter>
                  size="sm"
                  block
                  aria-label="Show in the stream"
                  value={filter}
                  onChange={setFilter}
                  options={FILTERS.map((f) => ({ value: f.value, label: f.label }))}
                />
              </div>
              {shown.length === 0 ? (
                <p className="px-4 py-8 text-center font-mono text-caption text-text-muted">
                  {live.events.length ? "Nothing of this kind in the last 30 min" : "No events in the last 30 min"}
                </p>
              ) : (
                <ul
                  className="relative divide-y divide-border xl:max-h-160 xl:overflow-y-auto"
                  aria-labelledby="live-stream"
                  // Scrolls on wide screens: reachable by keyboard.
                  tabIndex={0}
                >
                  {shown.slice(0, limit).map((e) => <StreamRow key={e.id} e={e} now={now} fresh={live.fresh.has(e.id)} />)}
                </ul>
              )}
              {shown.length > limit && (
                <div className="border-t border-border px-3 py-2">
                  <Button size="sm" variant="ghost" block onClick={() => setLimit((n) => n + STREAM_STEP)}>
                    Show {Math.min(STREAM_STEP, shown.length - limit)} more
                  </Button>
                </div>
              )}
            </Panel>
          </div>
        </div>
      </div>
    );
  }

  return (
    <NavContext.Provider value={nav}>
      {isPreview() && (
        <Alert tone="warning" className="mb-4" title="Preview data" actions={<Button size="sm" variant="secondary" href="/admin?tab=live&preview=0">Exit preview</Button>}>
          Development fixtures, not PostHog.
        </Alert>
      )}
      <PageHead
        title={<span className="inline-flex items-center gap-3"><LiveDot on={!paused && !live.setup} />Live</span>}
        caption="What is happening on markdrop.in right now, from PostHog. Refreshes every 10 seconds while this tab is open."
        actions={
          <>
            <Updated at={live.updatedAt} paused={paused} loading={live.loading} />
            <Button size="sm" variant="secondary" iconLeft={paused ? "play" : "pause"} onClick={() => setPaused((p) => !p)}>
              {paused ? "Resume" : "Pause"}
            </Button>
          </>
        }
      />
      {body}
    </NavContext.Provider>
  );
}

/** "updated 4s ago", ticking every second (its own clock, so the panel doesn't re-render). */
function Updated({ at, paused, loading }: { at: number | null; paused: boolean; loading: boolean }) {
  const now = useNow(1_000);
  const text = !at ? (loading ? "connecting…" : "—") : paused ? `paused · updated ${ago(new Date(at).toISOString(), now)}` : `updated ${ago(new Date(at).toISOString(), now)}`;
  return (
    <span className="font-mono text-micro tabular-nums text-text-muted" title={`Polls every ${LIVE_POLL_MS / 1000} s while visible; slower when PostHog is busy`}>
      {text.replace("updated now", "updated just now")}
    </span>
  );
}

function SessionCard({ s, now, token, watching, onWatch }: {
  s: LiveSession; now: number; token: string; watching: boolean; onWatch: (on: boolean) => void;
}) {
  const lastAge = (now - new Date(s.last_seen).getTime()) / 1000;
  const isNow = lastAge < 60;
  const tail = (s.distinct_id || s.person_id || s.id).slice(-6);
  const who = s.identified ? s.who : s.name || `Anonymous · #${tail}`;
  const lengthS = s.started ? (new Date(s.last_seen).getTime() - new Date(s.started).getTime()) / 1000 : 0;
  const where = [countryFlag(s.country), s.city || s.country].filter(Boolean).join(" ") || "Unknown place";
  const kit = [s.device, s.browser].filter(Boolean).join(" · ");
  const rec = s.recording;
  return (
    <li className={cx("min-w-0 rounded-xl border bg-bg transition-colors", watching ? "border-accent" : "border-border")}>
      <div className="flex min-w-0 flex-col gap-2 p-3">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <div className="min-w-0 flex-1">
            <Who who={who} identified={s.identified} personId={s.person_id} className="max-w-full text-body" />
            <p className="mt-0.5 truncate font-mono text-micro text-text-muted">
              {where}{kit ? ` · ${kit.toLowerCase()}` : ""}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isNow && <Badge size="sm" tone="success" live>now</Badge>}
            <time dateTime={s.last_seen} title={new Date(s.last_seen).toLocaleString("en-GB")} className="font-mono text-micro tabular-nums text-text-muted">
              {ago(s.last_seen, now)}
            </time>
          </div>
        </div>

        <CurrentPage page={s.page} />

        <div className="flex min-w-0 items-start gap-2">
          <KindMark kind={s.last.kind} />
          <div className="min-w-0 flex-1">
            <p className={cx("flex min-w-0 items-center gap-1 text-body leading-snug", labelClass(s.last.kind))}>
              <span className="min-w-0 truncate">{s.last.label}</span>
            </p>
            {s.last.detail && <p className="truncate font-mono text-micro text-text-muted" title={s.last.detail}>{s.last.detail}</p>}
          </div>
        </div>

        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
          <p className="min-w-0 font-mono text-micro text-text-secondary">
            {s.started_before_window ? "30+ min" : clock(lengthS)} · {fmtNum(s.events)} {s.events === 1 ? "event" : "events"}
            {s.pageviews ? ` · ${fmtNum(s.pageviews)} ${s.pageviews === 1 ? "page" : "pages"}` : ""}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {s.person_id && (
              <NavLink
                to={{ person: s.person_id }}
                className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 font-mono text-caption text-text-secondary hover:bg-surface-hover hover:text-accent-text"
                aria-label={`Journey of ${who}`}
              >
                Journey <span aria-hidden>↗</span>
              </NavLink>
            )}
            {rec && (
              <Button
                size="sm"
                variant={watching ? "secondary" : rec.ongoing ? "primary" : "secondary"}
                iconLeft={watching ? "stop" : "play"}
                aria-expanded={watching}
                onClick={() => onWatch(!watching)}
              >
                {watching ? "Close" : rec.ongoing ? "Watch live" : `Watch · ${clock(rec.duration)}`}
              </Button>
            )}
          </div>
        </div>
      </div>
      {watching && rec && (
        <div className="border-t border-border p-2">
          <ReplayPlayer
            token={token}
            id={rec.id}
            title={s.page ? pageName(s.page) : who}
            appUrl={rec.app_url}
            live={rec.ongoing}
            onClose={() => onWatch(false)}
          />
        </div>
      )}
    </li>
  );
}

function CurrentPage({ page }: { page: PageRef | null }) {
  if (!page) return <p className="font-mono text-micro text-text-muted">no page view in this window</p>;
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md bg-surface-inset px-2.5 py-1.5">
      <span className={cx(EYEBROW, "shrink-0")}>on</span>
      <PageIcon page={page} />
      <span className="min-w-0 truncate text-body text-text" title={pageSub(page)}>{pageName(page)}</span>
      {page.doc ? <DocLink doc={page.doc} className="-my-1" /> : <span className="truncate font-mono text-micro text-text-muted max-sm:hidden">{page.path}</span>}
    </div>
  );
}

function StreamRow({ e, now, fresh }: { e: StreamEvent; now: number; fresh: boolean }) {
  return (
    <li className={cx("flex min-h-12 items-start gap-3 px-3 py-2 sm:px-4", fresh && styles.fresh)}>
      <KindMark kind={e.kind} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className={cx("flex min-w-0 items-center gap-1 text-body", labelClass(e.kind))}>
          <span className="min-w-0 truncate">{e.label}</span>
          {e.page?.doc && <DocLink doc={e.page.doc} className="-my-1" />}
        </p>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-micro text-text-muted">
          <Who who={e.who} identified={e.identified} personId={e.person_id} className="min-h-6 max-w-48 text-micro" />
          {e.country && <span>{countryFlag(e.country)} {e.city || e.country}</span>}
          {e.kind !== "pageview" && e.page && (
            <NavLink to={{ jt: "pages", path: e.page.key, person: null }} className="inline-flex min-h-6 max-w-48 items-center hover:text-accent-text hover:underline" title={pageSub(e.page)}>
              <span className="truncate">{pageName(e.page)}</span>
            </NavLink>
          )}
        </div>
      </div>
      <time dateTime={e.t} title={new Date(e.t).toLocaleString("en-GB")} className="w-16 shrink-0 whitespace-nowrap pt-0.5 text-right font-mono text-micro tabular-nums text-text-muted">
        {ago(e.t, now)}
      </time>
    </li>
  );
}

