"use client";

import { useEffect, useState } from "react";
import { Button, EmptyState, cx } from "@/components/ui";
import { LoadingBlock } from "../shared";
import { notConfigured, useJourneys, type NotConfigured, type PageDetailRes, type PathsRes } from "./api";
import {
  BarList, DaysPicker, ExtLink, NavLink, PageIcon, Panel, PhErrorState, StaleNotice, docUrl, fmtNum, fmtPct, pageName, pageSub, useDays, useNav,
} from "./bits";
import { SetupCard } from "./SetupCard";

/**
 * Pages & heatmaps: the top pages by views; pick one for its most clicked elements, reading depth
 * (documents) and the heatmap overlay in PostHog (app pages: PostHog has no embeddable heatmaps,
 * and document URLs never reach it).
 */
export function PagesTab({ token }: { token: string }) {
  const { state, go } = useNav();
  const { days } = useDays("30d");
  const { data, error, refresh, stale } = useJourneys<PathsRes | NotConfigured>(token, "/paths", { days });
  if (notConfigured(data)) return <SetupCard status={data.status} compact />;
  const res = data as PathsRes | undefined;
  const pages = res?.pages ?? [];
  const selected = state.path || pages[0]?.page.key || null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-caption text-text-muted">pick a page → most clicked elements, reading depth, heatmap overlay in PostHog</p>
        <DaysPicker fallback="30d" />
      </div>
      <StaleNotice stale={stale} error={res ? error : null} />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <Panel eyebrow="Top pages" title="By views" pad={false}>
          {error && !res ? (
            <div className="p-4"><PhErrorState error={error} onRetry={refresh} /></div>
          ) : !res ? (
            <LoadingBlock label="Loading pages" minHeight={360} />
          ) : pages.length === 0 ? (
            <div className="p-4"><EmptyState icon="eye" title="No page views yet" /></div>
          ) : (
            <ul className="max-h-140 divide-y divide-border overflow-y-auto">
              {pages.map(({ page, views, visitors }) => {
                const on = page.key === selected;
                return (
                  <li key={page.key}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => go({ path: page.key }, false)}
                      className={cx(
                        "md-focus relative flex w-full min-w-0 items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-hover",
                        on && "bg-surface-hover",
                      )}
                    >
                      {on && <span aria-hidden className="absolute inset-y-0 left-0 w-0.75 bg-accent" />}
                      <PageIcon page={page} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-body text-text">{pageName(page)}</span>
                        <span className="truncate font-mono text-micro text-text-muted">{pageSub(page)}</span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block font-mono text-body-strong tabular-nums text-text">{fmtNum(views)}</span>
                        <span className="block font-mono text-micro tabular-nums text-text-muted">{fmtNum(visitors)} ppl</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
        {selected ? <PageDetail key={`${selected}:${days}`} token={token} path={selected} days={days} /> : res && <div />}
      </div>
    </div>
  );
}

function PageDetail({ token, path, days }: { token: string; path: string; days: number }) {
  const { data, error, refresh, stale } = useJourneys<PageDetailRes | NotConfigured>(token, "/page", { path, days });
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);
  if (notConfigured(data)) return <SetupCard status={data.status} compact />;
  const res = data as PageDetailRes | undefined;
  if (error && !res) return <PhErrorState error={error} onRetry={refresh} title="Couldn't load this page" />;
  if (!res) {
    return (
      <div className="rounded-xl border border-border bg-surface">
        <LoadingBlock label="Loading clicks and reading depth" minHeight={420} />
      </div>
    );
  }
  const p = res.page;
  const doc = p.doc;
  const range = days === 1 ? "Last 24 h" : `Last ${days} days`;
  const top = res.depth?.[0]?.readers ?? 0;
  const maxReaders = Math.max(1, ...(res.depth ?? []).map((d) => d.readers));

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Panel
        eyebrow={doc ? (doc.kind === "artifact" ? "file" : "document") : <span className="font-mono normal-case tracking-normal">{p.path}</span>}
        title={<span className="inline-flex min-w-0 items-center gap-2 break-words" dir="auto">{pageName(p)}</span>}
        action={
          <NavLink to={{ jt: "recordings", path: p.key, who: null }} className="font-mono text-caption text-accent-text hover:underline">
            ▶ {doc ? "replays of sessions that opened it" : "replays on this page"}
          </NavLink>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          {res.heatmap_url && <ExtLink href={res.heatmap_url}>Heatmap in PostHog</ExtLink>}
          {!doc && <ExtLink href={res.toolbar_url}>Launch toolbar</ExtLink>}
          {res.site_url && (
            <Button
              size="sm"
              variant="ghost"
              iconLeft={copied ? "check" : "copy"}
              onClick={() => {
                void navigator.clipboard?.writeText(res.site_url!).then(() => setCopied(true)).catch(() => {});
              }}
            >
              {copied ? "Copied" : "Copy page URL"}
            </Button>
          )}
          {doc?.slug && (
            <Button size="sm" variant="secondary" iconRight="external" href={docUrl(doc.slug)} target="_blank" rel="noopener noreferrer">
              Open document<span className="md-visually-hidden"> (opens in a new tab)</span>
            </Button>
          )}
          <span role="status" className="md-visually-hidden">{copied ? "Page URL copied" : ""}</span>
        </div>
        <p className="mt-3 max-w-prose text-body text-text-secondary">
          {doc
            ? "Documents are never recorded and their addresses never reach PostHog, so there is no heatmap overlay for them. The clicks and reading depth below are counted from events tagged with the document's private reference."
            : "PostHog doesn't offer embeddable heatmaps, so the click and scroll overlay opens in PostHog (Heatmaps, then paste the page URL, or the toolbar on the live page). Below is the same click data, counted here."}
        </p>
        {doc && <p className="mt-2 font-mono text-micro text-text-muted">{pageSub(p)} · ref {doc.ref}</p>}
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel eyebrow={range} title="Most clicked">
          <BarList
            label="Most clicked elements"
            limit={12}
            empty={doc ? "No clicks recorded on this document (clicks inside a document's text aren't captured)" : "No clicks recorded on this page"}
            items={res.clicks.map((c, i) => ({
              key: `${c.text}:${i}`,
              label: c.text,
              hint: [c.tag, c.rage ? `${c.rage} rage` : null, c.dead ? `${c.dead} dead` : null].filter(Boolean).join(" · ") || undefined,
              value: c.n + c.rage,
            }))}
          />
        </Panel>
        <Panel eyebrow={<span className="font-mono normal-case tracking-normal">read_progress</span>} title="Reading depth">
          {!res.depth ? (
            <p className="py-6 text-center text-caption text-text-muted">Reading depth is tracked on documents only.</p>
          ) : (
            <>
              <ul className="flex flex-col gap-2.5">
                {res.depth.map((d) => (
                  <li key={d.pct} className="grid grid-cols-[44px_minmax(0,1fr)_72px] items-center gap-3">
                    <span className="font-mono text-caption tabular-nums text-text-secondary">{d.pct}%</span>
                    <div className="relative h-6 overflow-hidden rounded-md border border-border bg-surface-inset" role="img" aria-label={`${d.readers} ${d.readers === 1 ? "reader" : "readers"} reached ${d.pct}%`}>
                      <div className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${(d.readers / maxReaders) * 100}%` }} />
                    </div>
                    <span className="text-right">
                      <span className="block font-mono text-caption tabular-nums text-text">{fmtNum(d.readers)}</span>
                      {d.pct > 25 && top > 0 && <span className="block font-mono text-micro tabular-nums text-text-muted">{fmtPct(d.readers / top, 0)} of 25%</span>}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 font-mono text-micro text-text-muted">people who read at least this far (engaged, not just scrolled)</p>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}
