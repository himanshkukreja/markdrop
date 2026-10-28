"use client";

/**
 * /dashboard/live (Live board): who is on your links right now, where they are in each
 * one, and the last 30 minutes. Polls every 10 s while the tab is visible.
 */
import { useEffect, useMemo, useState } from "react";
import { Anchor, Badge, EmptyState, FileIcon, Icon } from "@/components/ui";
import { getLive, type LiveAnalytics, type LivePos } from "@/lib/analytics";
import { clock, countryInSentence, deviceInSentence, docHref, num, prettyHeadingId } from "./format";
import { LoadError, Panel, PanelSkeleton, Quiet, useAnalyticsGate } from "./parts";

const POLL_MS = 10000;

function useLive(ready: boolean) {
  const [data, setData] = useState<LiveAnalytics | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!ready) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (document.visibilityState !== "visible") return;
      try {
        const d = await getLive();
        if (!live) return;
        setData(d);
        setError(null);
      } catch (e) {
        if (live) setError(e);
      }
      if (live && document.visibilityState === "visible") timer = setTimeout(tick, POLL_MS);
    };
    const onVis = () => { if (document.visibilityState === "visible") void tick(); else if (timer) { clearTimeout(timer); timer = null; } };
    void tick();
    document.addEventListener("visibilitychange", onVis);
    return () => { live = false; if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", onVis); };
  }, [ready, attempt]);
  return { data, error, retry: () => setAttempt((a) => a + 1) };
}

function who(e: { country: string | null; device: string | null }) {
  const place = e.country && e.country !== "Other" ? ` in ${countryInSentence(e.country)}` : "";
  const dev = deviceInSentence(e.device);
  return `someone${place}${dev ? `, ${dev}` : ""}`;
}

function where(pos: LivePos | null): string {
  if (!pos) return "";
  if (pos.p != null) return `on page ${pos.p}`;
  if (pos.h) return `at “${prettyHeadingId(pos.h)}”`;
  if (pos.s != null) return `at ${clock(pos.s)}`;
  return "";
}

function minsAgo(iso: string) {
  const m = Math.max(0, Math.round((Date.now() - new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`).getTime()) / 60000));
  return m < 1 ? "now" : `${m} min`;
}

export default function LiveNow() {
  const { ready } = useAnalyticsGate();
  const { data, error, retry } = useLive(ready);
  useEffect(() => { document.title = "Live now · Analytics · Markdrop"; }, []);

  const media = useMemo(() => (data?.docs ?? []).filter((d) => d.kind === "video" || d.kind === "audio"), [data]);
  const reading = useMemo(() => (data?.docs ?? []).filter((d) => d.kind !== "video" && d.kind !== "audio"), [data]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Anchor href="/dashboard/analytics" className="inline-flex items-center gap-1.5 self-start text-[13px] no-underline">
        <Icon name="chevronLeft" size={14} />Analytics
      </Anchor>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 flex-1 text-h2 text-text">Live now</h1>
        {data && (data.people > 0
          ? <Badge tone="success" live>{num(data.people)} {data.people === 1 ? "person" : "people"} across {num(data.links)} {data.links === 1 ? "link" : "links"}</Badge>
          : <Badge tone="neutral">Nobody right now</Badge>)}
      </div>

      {error && !data ? <LoadError error={error} retry={retry} what="live activity" /> : !data ? (
        <><PanelSkeleton height={80} /><PanelSkeleton height={120} /></>
      ) : (
        <div className="flex flex-col gap-4" aria-live="off">
          {data.docs.length === 0 && (
            <EmptyState icon="wave" title="Nobody is on your links right now" description="This page updates every 10 seconds." />
          )}

          {media.map((d) => {
            const dur = d.dur ?? null;
            const t = d.title || d.slug;
            return (
              <Panel key={d.slug} id={`lv-${d.slug}`} title={<Anchor href={docHref(d.slug)} className="text-text no-underline hover:text-accent-text" dir="auto">{t}</Anchor>}
                aside={`${num(d.n)} ${d.kind === "audio" ? "listening" : "watching"}`}>
                {dur ? (
                  <div className="relative h-8" role="img" aria-label={`${num(d.n)} on the timeline: ${d.entries.map((e) => (e.pos?.s != null ? clock(e.pos.s) : "")).filter(Boolean).join(", ")}`}>
                    <div className="absolute inset-x-0 top-3.5 h-1 rounded-full bg-(--chart-track)" />
                    {d.entries.filter((e) => e.pos?.s != null).map((e, i) => (
                      <span key={i} title={`${clock(e.pos!.s!)} · ${who(e)}`}
                        className="absolute top-2 size-4 -translate-x-1/2 rounded-full border-2 border-surface bg-(--chart-1)"
                        style={{ left: `${Math.max(0, Math.min(100, (e.pos!.s! / dur) * 100))}%` }} />
                    ))}
                  </div>
                ) : null}
                <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
                  {d.entries.map((e, i) => (
                    <li key={i} className="text-caption text-text-secondary">
                      {e.pos?.s != null && <><strong className="font-semibold text-text tabular-nums">{clock(e.pos.s)}</strong> · </>}{who(e)}
                    </li>
                  ))}
                </ul>
              </Panel>
            );
          })}

          {reading.length > 0 && (
            <Panel id="lv-reading" title="Reading now">
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {reading.map((d) => {
                  const counts = new Map<string, number>();
                  for (const e of d.entries) { const w = where(e.pos); counts.set(w, (counts.get(w) ?? 0) + 1); }
                  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
                  return (
                    <li key={d.slug} className="flex items-center gap-2.5 text-[13px]">
                      {d.kind === "doc" ? <Icon name="lines" size={14} className="shrink-0 text-cat-document" /> : <FileIcon name={d.title || d.slug} mime={d.kind === "pdf" ? "application/pdf" : ""} size={14} className="shrink-0" />}
                      <Anchor href={docHref(d.slug)} className="min-w-0 flex-1 truncate text-text no-underline hover:text-accent-text" dir="auto">{d.title || d.slug}</Anchor>
                      {top && <span className="hidden shrink-0 text-text-muted sm:inline">{counts.size > 1 ? `mostly ${top}` : top}</span>}
                      <strong className="w-6 shrink-0 text-right tabular-nums">{num(d.n)}</strong>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          )}

          <Panel id="lv-feed" title="Last 30 minutes">
            {data.feed.length ? (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {data.feed.map((f, i) => (
                  <li key={`${f.at}-${i}`} className="flex gap-2.5 text-[13px]">
                    <span className="w-13 shrink-0 text-caption text-text-muted tabular-nums">{minsAgo(f.at)}</span>
                    {f.slug
                      ? <Anchor href={docHref(f.slug)} className="min-w-0 flex-1 text-text no-underline hover:text-accent-text">{f.text}</Anchor>
                      : <span className="min-w-0 flex-1 text-text">{f.text}</span>}
                  </li>
                ))}
              </ul>
            ) : <Quiet>Nothing in the last 30 minutes.</Quiet>}
          </Panel>
          <Quiet>Updates every 10 seconds while this tab is open. Only countries and device types are shown, never who someone is.</Quiet>
        </div>
      )}
    </div>
  );
}
