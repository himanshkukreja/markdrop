"use client";

import { EmptyState, Skeleton } from "@/components/ui";
import { notConfigured, useJourneys, type LiveRes, type NotConfigured, type StreamEvent } from "./api";
import {
  DocLink, EYEBROW, KindMark, LiveDot, NavLink, Panel, PhErrorState, SkeletonRows, Who, countryFlag, fmtNum, labelClass, pageName, pageSub,
  timeAgo, useNow,
} from "./bits";
import { SetupCard } from "./SetupCard";

/**
 * Live: who is on the site right now (anyone with an event in the last 5 minutes), which pages
 * they're on, and the latest 60 things anyone did in the last 24 hours. Polls every 15 s while the
 * tab is visible.
 */
export function LiveTab({ token }: { token: string }) {
  const now = useNow(15_000);
  const { data, error, refresh } = useJourneys<LiveRes | NotConfigured>(token, "/live", undefined, { refreshMs: 15_000 });
  if (notConfigured(data)) return <SetupCard status={data.status} compact />;
  const live = data as LiveRes | undefined;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
      <Panel
        eyebrow="Right now"
        title={<span className="inline-flex items-center gap-2"><LiveDot on={!!live?.live} />Visitors</span>}
        action={<span className="font-mono text-micro text-text-muted" title="Refreshes every 15 seconds while this tab is visible">↻ 15s</span>}
        className="self-start"
      >
        {error && !live ? (
          <PhErrorState error={error} onRetry={refresh} />
        ) : !live ? (
          <div aria-busy="true"><span className="md-visually-hidden">Loading</span><Skeleton variant="rect" height={112} /></div>
        ) : (
          <>
            <p className="flex flex-wrap items-baseline gap-x-2" aria-live="polite">
              <span className="text-display tabular-nums text-text">{fmtNum(live.live)}</span>
              <span className="font-mono text-caption text-text-secondary">{live.live === 1 ? "person" : "people"} · last 5 min</span>
            </p>
            <h3 className={`${EYEBROW} mb-2 mt-5`}>On page now</h3>
            {live.pages.length ? (
              <ul className="flex flex-col gap-1.5">
                {live.pages.map(({ page, n }) => (
                  <li key={page.key}>
                    <NavLink to={{ jt: "pages", path: page.key, person: null }} className="flex min-w-0 items-center gap-3 rounded-md border-l-2 border-accent bg-surface-inset px-3 py-2 hover:bg-surface-hover">
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-body text-text">{pageName(page)}</span>
                        <span className="truncate font-mono text-micro text-text-muted">{pageSub(page)}</span>
                      </span>
                      <span className="font-mono text-body-strong tabular-nums text-text">{n}</span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="font-mono text-caption text-text-muted">nobody on the site right now</p>
            )}
          </>
        )}
      </Panel>

      <Panel eyebrow="Last 24 h" title="Event stream" pad={false} action={<span className="font-mono text-micro text-text-muted">60 latest</span>}>
        {error && !live ? (
          <div className="p-4"><PhErrorState error={error} onRetry={refresh} /></div>
        ) : !live ? (
          <div className="p-3"><SkeletonRows n={8} height={40} label="Loading the event stream" /></div>
        ) : live.events.length === 0 ? (
          <div className="p-4">
            <EmptyState icon="wave" title="No events in the last 24 h" description="Once visitors accept analytics on markdrop.in, what they do streams in here." />
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {live.events.map((e) => <StreamRow key={e.id} e={e} now={now} />)}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function StreamRow({ e, now }: { e: StreamEvent; now: number }) {
  const where = [countryFlag(e.country), e.city || e.country].filter(Boolean).join(" ");
  return (
    <li className="flex min-h-12 items-start gap-3 px-3 py-2 sm:px-4">
      <KindMark kind={e.kind} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className={`flex min-w-0 items-center gap-1 text-body ${labelClass(e.kind)}`}>
          <span className="min-w-0 truncate">{e.label}</span>
          {e.page?.doc && <DocLink doc={e.page.doc} className="-my-1" />}
        </p>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-micro text-text-muted">
          <Who who={e.who} identified={e.identified} personId={e.person_id} className="min-h-6 max-w-56 text-micro" />
          {where && <span>{where}</span>}
          {e.device && <span>{e.device.toLowerCase()}</span>}
          {e.kind !== "pageview" && e.page && (
            <NavLink to={{ jt: "pages", path: e.page.key, person: null }} className="inline-flex min-h-6 max-w-56 items-center hover:text-accent-text hover:underline" title={pageSub(e.page)}>
              <span className="truncate">{pageName(e.page)}</span>
            </NavLink>
          )}
        </div>
      </div>
      <time dateTime={e.t} title={new Date(e.t).toLocaleString("en-GB")} className="w-16 shrink-0 pt-0.5 text-right font-mono text-micro tabular-nums text-text-muted">
        {timeAgo(e.t, now)}
      </time>
    </li>
  );
}
