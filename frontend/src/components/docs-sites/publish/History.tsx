"use client";

import { useId, useState } from "react";
import { Anchor, Badge, Button, EmptyState, Skeleton, Spinner } from "@/components/ui";
import type { Build } from "@/lib/docsSites";
import { firstName, whenShort } from "../format";
import { useSite } from "../SiteContext";
import { compareHref } from "./CompareScreen";
import { seconds, wentLive } from "./shared";

const RUNNING = new Set(["queued", "building", "publishing"]);

/** The publish each one is compared against: the newest older one that went live ("none": the first). */
export function previousLive(builds: Build[], b: Build): string {
  const older = builds.filter((x) => x.number < b.number && wentLive(x)).sort((x, y) => y.number - x.number);
  return older[0]?.id ?? "none";
}

/**
 * Publish history (PublishLive board): #n, the note, when · who · build time, what it changed (+N
 * pages, N edited, N removed, Design) with "What changed", Live or Restore. Four at first, then all.
 */
export function History({ builds, restoring, onRestore, className }: {
  builds: Build[] | null;
  restoring: string | null;
  onRestore: (b: Build) => void;
  className?: string;
}) {
  const { base, isAdmin } = useSite();
  const uid = useId();
  const [all, setAll] = useState(false);
  const shown = builds ? (all ? builds : builds.slice(0, 4)) : [];
  const done = builds?.filter(wentLive) ?? [];
  const compareTwo = done.length >= 2 ? compareHref(base, done[1]!.id, done[0]!.id) : done.length === 1 ? compareHref(base, "none", done[0]!.id) : null;

  return (
    <section id="history" aria-labelledby={`${uid}-h`} className={`flex min-w-0 flex-col gap-2.5 rounded-xl border border-border bg-surface p-5 ${className ?? ""}`}>
      <h2 id={`${uid}-h`} className="text-[16px] font-semibold leading-6 text-text">Publish history</h2>
      {!builds && <div className="flex flex-col gap-2" aria-busy="true"><Skeleton width="70%" /><Skeleton width="55%" /><Skeleton width="62%" /></div>}
      {builds && builds.length === 0 && (
        <EmptyState icon="send" title="Not published yet" description="Your first publish shows up here. Every publish is kept, so you can go back to it." />
      )}
      {builds && builds.length > 0 && (
        <ol className="ph-no-capture flex flex-col">
          {shown.map((b) => {
            const running = RUNNING.has(b.status);
            const isLive = b.live ?? b.status === "live";
            const canRestore = isAdmin && !running && !isLive && wentLive(b);
            const c = b.changes;
            const meta = [
              whenShort(b.finished_at ?? b.created_at),
              b.requested_by_name ? firstName(b.requested_by_name) : null,
              b.stats?.ms ? seconds(b.stats.ms) : null,
            ].filter(Boolean).join(" · ");
            return (
              <li key={b.id} className="flex gap-3 border-b border-border py-2.5 last:border-b-0">
                <span className={`mt-1.5 size-2 shrink-0 rounded-full ${isLive ? "bg-success" : b.status === "failed" ? "bg-danger" : "bg-border-strong"}`} aria-hidden />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <strong className="shrink-0 font-semibold text-text">#{b.number}</strong>
                    {b.note && <span className="ph-sensitive ph-mask min-w-0 truncate text-text-secondary" dir="auto" title={b.note}>{b.note}</span>}
                  </span>
                  <span className="text-[12px] text-text-muted">
                    {running ? <span className="inline-flex items-center gap-1.5"><Spinner size={11} /> Publishing{b.progress ? ` · ${b.progress.percent}%` : "…"}</span> : meta}
                    {b.status === "failed" && " · didn't go live"}
                    {b.status === "superseded" && !b.manifest_hash && " · replaced before it was built"}
                  </span>
                  {b.status === "failed" && b.error && <span className="text-[12px] text-danger">{b.error}</span>}
                  {b.warnings?.map((w) => <span key={w} className="text-[12px] text-warning">{w}</span>)}
                  <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-text-secondary">
                    {c?.added ? <span className="text-success">+{c.added} {c.added === 1 ? "page" : "pages"}</span> : null}
                    {c?.edited ? <span className="text-accent-text">{c.edited} edited</span> : null}
                    {c?.removed ? <span className="text-danger">{c.removed} removed</span> : null}
                    {c?.design ? <span>Design</span> : null}
                    {c?.redirects ? <span>Redirects</span> : null}
                    {c?.api ? <span>API reference</span> : null}
                    {c && !c.added && !c.edited && !c.removed && !c.settings.length ? <span className="text-text-muted">No changes</span> : null}
                    {b.snapshot_id && (
                      <Anchor href={compareHref(base, previousLive(builds, b), b.id)} className="md-touch-hit ml-0.5 text-accent-text underline-offset-2 hover:underline">
                        What changed<span className="md-visually-hidden"> in publish #{b.number}</span>
                      </Anchor>
                    )}
                  </span>
                </span>
                <span className="flex shrink-0 items-start gap-1.5">
                  {isLive && <Badge tone="success" size="sm" dot>Live</Badge>}
                  {b.status === "failed" && <Badge tone="danger" size="sm">Failed</Badge>}
                  {restoring === b.id
                    ? <Badge size="sm"><Spinner size={11} /> Restoring…</Badge>
                    : canRestore && <Button variant="ghost" size="sm" disabled={!!restoring} onClick={() => onRestore(b)}>Restore<span className="md-visually-hidden"> publish #{b.number}</span></Button>}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {builds && builds.length > 0 && (
        <span className="flex flex-wrap gap-3 text-[13px] pointer-coarse:gap-x-5 pointer-coarse:pt-3">
          {builds.length > 4 && (
            <button type="button" className="md-focus md-touch-hit rounded text-accent-text underline-offset-2 hover:underline" onClick={() => setAll((v) => !v)} aria-expanded={all}>
              {all ? "Show fewer" : `See all ${builds.length} publishes`}
            </button>
          )}
          {compareTwo && <Anchor href={compareTwo} className="md-touch-hit text-accent-text underline-offset-2 hover:underline">Compare two publishes</Anchor>}
        </span>
      )}
    </section>
  );
}

export default History;
