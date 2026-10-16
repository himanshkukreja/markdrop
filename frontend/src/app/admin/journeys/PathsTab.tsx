"use client";

import { Fragment } from "react";
import { Progress } from "@/components/ui";
import StatTile from "@/components/kit/StatTile";
import { notConfigured, useJourneys, type FunnelStep, type NotConfigured, type PageRef, type PathsRes } from "./api";
import { LoadingBlock } from "../shared";
import { BarList, DaysPicker, NavLink, PageIcon, Panel, PhErrorState, StaleNotice, fmtNum, fmtPct, pageName, pageSub, useDays } from "./bits";
import { SetupCard } from "./SetupCard";

/**
 * Paths & funnel: where sessions start and end, the most common first four pages, and an ordered
 * funnel from landing to signing in, computed per person from page views and product events.
 * Documents count one by one (by their private reference), never as one "/[slug]".
 */
export function PathsTab({ token }: { token: string }) {
  const { days } = useDays("7d");
  const { data, error, loading, refresh, stale } = useJourneys<PathsRes | NotConfigured>(token, "/paths", { days });
  if (notConfigured(data)) return <SetupCard status={data.status} compact />;
  const res = data as PathsRes | undefined;
  const top = res?.funnel[0]?.n ?? 0;
  const published = res?.funnel.find((f) => f.key === "publish")?.n ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-caption text-text-muted">from page views and product events · computed per person, in order</p>
        <DaysPicker fallback="7d" />
      </div>
      {loading && res && <Progress indeterminate size="sm" aria-label="Updating paths" valueText="Loading" />}
      <StaleNotice stale={stale} error={res ? error : null} />

      {error && !res ? (
        <PhErrorState error={error} onRetry={refresh} />
      ) : !res ? (
        <LoadingBlock size="md" label="Loading paths and the funnel" minHeight={480} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile size="md" label="Sessions" value={fmtNum(res.sessions)} caption="with a page view" />
            <StatTile size="md" label="People" value={fmtNum(res.people)} caption="landed at least once" />
            <StatTile size="md" label="Published" value={fmtNum(published)} caption="a document, file or README" />
            <StatTile size="md" label="Land → publish" value={top ? fmtPct(published / top) : "—"} caption="of people who landed" />
          </div>

          <Panel eyebrow="Funnel" title="Landing → signed in" titleId="journeys-funnel">
            <Funnel steps={res.funnel} />
            <p className="mt-3 font-mono text-micro text-text-muted">
              each step counts people who reached it after the one before · a creator is /new, /upload or /builder
            </p>
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel eyebrow="Where sessions start" title="Entry pages">
              <BarList
                label="Entry pages"
                limit={10}
                items={res.entries.map(({ page, n }) => ({
                  key: page.key, label: pageName(page), hint: pageSub(page), value: n, icon: <PageIcon page={page} />,
                  to: { jt: "pages", path: page.key },
                }))}
              />
            </Panel>
            <Panel eyebrow="Where sessions end" title="Exit pages">
              <BarList
                label="Exit pages"
                limit={8}
                items={res.exits.map(({ page, n }) => ({ key: page.key, label: pageName(page), hint: pageSub(page), value: n, icon: <PageIcon page={page} /> }))}
              />
            </Panel>
          </div>

          <Panel eyebrow="First 4 pages of a session" title="Top paths" pad={false}>
            {res.paths.length === 0 ? (
              <p className="px-4 py-8 text-center font-mono text-caption text-text-muted">No multi-page sessions yet.</p>
            ) : (
              <ol className="divide-y divide-border">
                {res.paths.map((p, i) => (
                  <li key={p.steps.map((s) => s.key).join(">") + i} className="flex min-w-0 items-center gap-3 px-4 py-2.5">
                    <span className="w-6 shrink-0 font-mono text-caption tabular-nums text-text-muted">{String(i + 1).padStart(2, "0")}</span>
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                      {p.steps.map((s, j) => (
                        <Fragment key={`${s.key}:${j}`}>
                          {j > 0 && <span aria-hidden className="font-mono text-caption text-accent-text">→</span>}
                          <StepChip page={s} />
                        </Fragment>
                      ))}
                    </div>
                    <span className="shrink-0 font-mono text-body-strong tabular-nums text-text">{fmtNum(p.n)}</span>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
          {res.truncated && <p className="font-mono text-micro text-text-muted">computed from the first 50,000 events of this window · pick a shorter range for exact numbers</p>}
        </>
      )}
    </div>
  );
}

/** A step of a path: links to the recordings of sessions that visited it. */
function StepChip({ page }: { page: PageRef }) {
  return (
    <NavLink
      to={{ jt: "recordings", path: page.key, who: null }}
      title={`Recordings of sessions that visited ${pageName(page)}`}
      className="inline-flex max-w-56 items-center gap-1 rounded-md border border-border bg-surface-inset px-2 py-1 font-mono text-micro text-text-secondary hover:border-accent hover:text-text"
    >
      <PageIcon page={page} className="size-3" />
      <span className="truncate">{pageName(page)}</span>
    </NavLink>
  );
}

function Funnel({ steps }: { steps: FunnelStep[] }) {
  const top = steps[0]?.n ?? 0;
  return (
    <ol className="flex flex-col gap-3">
      {steps.map((s, i) => {
        const share = top ? s.n / top : 0;
        const prev = i > 0 ? steps[i - 1]!.n : 0;
        return (
          <li key={s.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 sm:grid-cols-[200px_minmax(0,1fr)_128px]">
            <span className="flex min-w-0 items-center gap-2">
              <span className="font-mono text-caption tabular-nums text-text-muted">{i + 1}</span>
              <span className="truncate text-body text-text">{s.label}</span>
            </span>
            <div
              className="relative order-3 col-span-2 h-7 overflow-hidden rounded-md border border-border bg-surface-inset sm:order-0 sm:col-span-1"
              role="img"
              aria-label={`${s.label}: ${fmtNum(s.n)} people, ${fmtPct(share, 0)} of those who landed`}
            >
              <div className="absolute inset-y-0 left-0 rounded-sm bg-accent" style={{ width: `${Math.max(share * 100, s.n ? 1.5 : 0)}%`, opacity: 1 - i * 0.12 }} />
            </div>
            <span className="text-right font-mono text-caption tabular-nums">
              <span className="text-text">{fmtNum(s.n)}</span>{" "}
              <span className="text-text-secondary">{fmtPct(share, 0)}</span>
              {i > 0 && <span className="text-text-muted" title="of the previous step"> ({prev ? fmtPct(s.n / prev, 0) : "—"})</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
