"use client";

/**
 * Comment analytics for one item (Track C): open / resolved threads, time to a first reply (and how many still
 * wait for one), time to resolve, the most-discussed sections, threads per day and who comments most. Used by the
 * item's analytics page (Comments tab) and by the comments panel's "Insights" (a dialog, `compact`).
 */
import { useEffect, useId, useState } from "react";
import { Alert, Avatar, Button, EmptyState, Skeleton, cx } from "@/components/ui";
import { InsightsError, duration, getCommentInsights, type CommentInsights, type InsightsRange } from "@/lib/commentsInsights";

function Tile({ label, value, note }: { label: string; value: string; note?: string | null }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-surface p-3 sm:px-4 sm:py-3.5">
      <span className="text-caption text-text-muted">{label}</span>
      <strong className="text-[22px] leading-7 font-bold text-text tabular-nums">{value}</strong>
      {note && <span className="text-caption text-text-secondary">{note}</span>}
    </div>
  );
}

function Series({ rows }: { rows: CommentInsights["series"] }) {
  const id = useId();
  const max = Math.max(1, ...rows.map((r) => r.threads + r.messages));
  const total = rows.reduce((a, r) => a + r.threads, 0);
  return (
    <figure className="m-0 flex flex-col gap-2" aria-labelledby={id}>
      <figcaption id={id} className="text-caption text-text-muted">New threads and messages per day · {total} new {total === 1 ? "thread" : "threads"}</figcaption>
      <div className="flex h-24 items-end gap-[2px]" aria-hidden>
        {rows.map((r) => (
          <span key={r.date} className="flex min-w-[2px] flex-1 flex-col justify-end" title={`${r.date}: ${r.threads} new, ${r.messages} messages`}>
            <span className="block rounded-t-sm bg-(--chart-2,#93c5fd)" style={{ height: `${(r.messages / max) * 96}px` }} />
            <span className="block bg-(--chart-1,#2563eb)" style={{ height: `${(r.threads / max) * 96}px` }} />
          </span>
        ))}
      </div>
      <div className="md-visually-hidden">
        <table>
          <caption>Comment activity per day</caption>
          <thead><tr><th scope="col">Day</th><th scope="col">New threads</th><th scope="col">Messages</th></tr></thead>
          <tbody>{rows.filter((r) => r.threads || r.messages).map((r) => <tr key={r.date}><th scope="row">{r.date}</th><td>{r.threads}</td><td>{r.messages}</td></tr>)}</tbody>
        </table>
      </div>
    </figure>
  );
}

export function CommentsInsights({ slug, range = "30d", compact = false, onOpenSection }: {
  slug: string;
  range?: InsightsRange;
  compact?: boolean;
  onOpenSection?: (id: string | null) => void;
}) {
  const [data, setData] = useState<CommentInsights | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [off, setOff] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    setOff(null);
    getCommentInsights(slug, range)
      .then((d) => { if (live) setData(d); })
      .catch((e) => {
        if (!live) return;
        if (e instanceof InsightsError && (e.code === "comments_unavailable" || e.code === "comments_off")) {
          setOff(e.code === "comments_off" ? "Comments are turned off here, so there's nothing to count." :
            "This item can't have comments (encrypted documents and files don't).");
          return;
        }
        setError(e instanceof Error ? e.message : "Couldn't load the comment insights.");
      });
    return () => { live = false; };
  }, [slug, range, tick]);

  if (off) return <EmptyState icon="message" title="No comments here" description={off} />;
  if (error) {
    return (
      <Alert tone="danger" title="Couldn't load comment insights">
        {error} <Button variant="ghost" size="sm" onClick={() => setTick((n) => n + 1)}>Try again</Button>
      </Alert>
    );
  }
  if (!data) {
    return (
      <div className="flex flex-col gap-3" aria-busy>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} variant="rect" height={84} />)}</div>
        <Skeleton variant="rect" height={120} />
        <span className="md-visually-hidden">Loading comment insights</span>
      </div>
    );
  }
  const c = data.counts;
  if (!c.total) {
    return <EmptyState icon="message" title="No comments yet" description="Open threads, reply times and the most-discussed sections appear here once people comment." />;
  }
  const fr = data.first_reply;
  const maxSec = Math.max(1, ...data.sections.map((s) => s.threads));
  return (
    <div className={cx("flex flex-col", compact ? "gap-3" : "gap-4 sm:gap-5")} data-testid="comment-insights">
      <p className="m-0 text-[14px] leading-5 text-text-secondary">{data.summary}</p>
      <div className={cx("grid gap-2.5", compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-[repeat(auto-fit,minmax(170px,1fr))] sm:gap-3")}>
        <Tile label="Open threads" value={String(c.open)} note={`${c.resolved} resolved · ${c.messages} messages`} />
        <Tile label="First reply" value={duration(fr.median_s)} note={fr.waiting ? `${fr.waiting} still waiting` : "typical time, everyone answered"} />
        <Tile label="Time to resolve" value={duration(data.resolve.median_s)} note={data.resolve.resolved ? `typical, ${data.resolve.resolved} resolved` : "none resolved yet"} />
        <Tile label="People commenting" value={String(c.participants)} note={c.changed ? `${c.changed} on text that changed` : null} />
      </div>

      <section aria-labelledby="ci-sections" className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-4 py-3">
        <h3 id="ci-sections" className="m-0 text-h4 text-text">Most discussed</h3>
        <ul className="ph-no-capture m-0 flex list-none flex-col p-0">
          {data.sections.map((s) => (
            <li key={`${s.id}|${s.title}`} className="grid grid-cols-[minmax(0,1fr)_96px_72px] items-center gap-2 border-t border-border py-2 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_160px_96px]">
              {onOpenSection && s.id ? (
                <button type="button" className="min-w-0 truncate text-left font-semibold text-text hover:underline" dir="auto" onClick={() => onOpenSection(s.id)}>{s.title}</button>
              ) : <span className="min-w-0 truncate font-semibold text-text" dir="auto">{s.title}</span>}
              <span className="h-2 rounded-full bg-(--chart-track)" aria-hidden>
                <span className="block h-2 rounded-full bg-(--chart-1)" style={{ width: `${(s.threads / maxSec) * 100}%` }} />
              </span>
              <span className="text-right text-caption text-text-secondary tabular-nums">
                {s.threads} {s.threads === 1 ? "thread" : "threads"}{s.open ? <span className="md-visually-hidden">, {s.open} open</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {!compact && (
        <div className="flex flex-wrap items-start gap-4">
          <section className="flex min-w-0 flex-[999_1_420px] flex-col gap-2 rounded-xl border border-border bg-surface px-4 py-3">
            <Series rows={data.series} />
          </section>
          <section aria-labelledby="ci-people" className="flex min-w-0 flex-[1_1_240px] flex-col gap-2 rounded-xl border border-border bg-surface px-4 py-3">
            <h3 id="ci-people" className="m-0 text-h4 text-text">Most active</h3>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {data.people.map((p) => (
                <li key={p.id} className="flex items-center gap-2 text-[13px]">
                  <Avatar name={p.name} src={p.picture ?? undefined} size="sm" />
                  <span className="ph-sensitive ph-mask min-w-0 flex-1 truncate text-text">{p.name}</span>
                  <strong className="tabular-nums text-text">{p.messages}</strong>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}

export default CommentsInsights;
