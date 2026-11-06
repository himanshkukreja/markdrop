"use client";

/**
 * The progress of an "Import past meetings" on the hub: "12 of 40", oldest first, Pause / Resume,
 * the wait for the AI budget, failed meetings with Retry, Stop, and Dismiss once it's done. The
 * import runs on the server; this only watches it (every 2.5 s while it runs), so closing the page
 * changes nothing. Watching also wakes a stopped server's import (the API picks it up).
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button, ConfirmDialog, Icon, Progress, Spinner, useToast } from "@/components/ui";
import {
  backfillAction, discardBackfill, fmtMeetingDate, getBackfill, retryBackfillRow,
  type BackfillJob, type BackfillRow,
} from "@/lib/meetings";
import "./backfill.css";

export interface BackfillProgressProps {
  job: BackfillJob;
  onChange: (job: BackfillJob | null) => void;
  /** More meetings landed (the hub reloads its list). */
  onProgress?: () => void;
}

const STATE_ICON: Record<string, string> = { imported: "checkCircle", attached: "layers", duplicate: "checkCircle", skipped: "minus", failed: "alertCircle", pending: "clock", importing: "refresh" };

export function BackfillProgress({ job, onChange, onProgress }: BackfillProgressProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const lastDone = useRef(job.counts.done);

  const live = job.state === "running" || job.state === "waiting";
  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => {
      getBackfill(job.id).then((j) => {
        onChange(j);
        if (j.counts.done !== lastDone.current) { lastDone.current = j.counts.done; onProgress?.(); }
        if (j.state === "done") toast.success(`${j.counts.imported + j.counts.attached} past meeting${j.counts.imported + j.counts.attached === 1 ? "" : "s"} imported.`);
      }).catch(() => {});
    }, job.state === "waiting" ? 20_000 : 2500);
    return () => window.clearInterval(t);
  }, [job.id, job.state, live, onChange, onProgress, toast]);

  const act = async (fn: () => Promise<BackfillJob>) => {
    setBusy(true);
    try { onChange(await fn()); } catch (e) { toast.error(e instanceof Error ? e.message : "That didn't work. Try again."); } finally { setBusy(false); }
  };

  const c = job.counts;
  const failed = job.rows.filter((r) => r.state === "failed");
  const current = job.rows.find((r) => r.state === "importing");
  const title = {
    running: "Importing past meetings",
    waiting: "Waiting for the AI budget",
    paused: "Import paused",
    done: c.failed ? "Past meetings imported, with problems" : "Past meetings imported",
    cancelled: "Import stopped",
    draft: "Import past meetings",
  }[job.state];
  const until = job.wait?.until ? new Date(job.wait.until).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) : null;
  const ordered = [...job.rows].filter((r) => r.include || r.state === "failed").sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  return (
    <section className="mt-bfp" aria-labelledby="mt-bfp-title" data-testid="backfill-progress" data-state={job.state}>
      <div className="mt-bfp__head">
        <span className="mt-bfp__glyph" aria-hidden>{job.state === "running" ? <Spinner size={18} /> : <Icon name={job.state === "done" ? "checkCircle" : job.state === "waiting" ? "clock" : "history"} />}</span>
        <div className="mt-bfp__titles">
          <h2 id="mt-bfp-title">{title}</h2>
          <p>
            {job.state === "waiting" && job.wait
              ? <>{job.wait.message} It carries on by itself{until ? ` around ${until}` : ""}.</>
              : job.state === "running" && current
                ? <>Now: <b>{current.title}</b> · {fmtMeetingDate(current.date)}</>
                : "Oldest first. Nobody is notified about their action items."}
          </p>
        </div>
        <div className="mt-bfp__actions">
          {job.state === "running" && <Button size="sm" variant="secondary" iconLeft="pause" onClick={() => void act(() => backfillAction(job.id, "pause"))} disabled={busy}>Pause</Button>}
          {(job.state === "paused" || job.state === "waiting") && (
            <Button size="sm" variant="secondary" iconLeft="play" onClick={() => void act(() => backfillAction(job.id, "resume"))} disabled={busy} data-testid="backfill-resume">
              {job.state === "waiting" ? "Try now" : "Resume"}
            </Button>
          )}
          {(job.state === "running" || job.state === "paused" || job.state === "waiting") && <Button size="sm" variant="ghost" onClick={() => setStopping(true)} disabled={busy}>Stop</Button>}
          {(job.state === "done" || job.state === "cancelled") && (
            <Button size="sm" variant="ghost" iconLeft="x" onClick={() => void discardBackfill(job.id).then(() => onChange(null)).catch(() => onChange(null))} data-testid="backfill-dismiss">Dismiss</Button>
          )}
        </div>
      </div>
      <Progress value={c.done} max={Math.max(1, c.included)} size="sm" label={`${c.done} of ${c.included}`} valueText={`${c.done} of ${c.included} meetings`}
        meta={[c.imported ? `${c.imported} imported` : null, c.attached ? `${c.attached} paired` : null, c.duplicate ? `${c.duplicate} already here` : null, c.failed ? `${c.failed} failed` : null].filter(Boolean).join(" · ")} />
      {failed.length > 0 && (
        <ul className="mt-bfp__failed">
          {failed.map((r) => (
            <li key={r.id}>
              <Icon name="alertCircle" />
              <span><b>{r.title}</b> · {fmtMeetingDate(r.date)} — {r.error}</span>
              {job.state !== "cancelled" && <Button size="sm" variant="secondary" iconLeft="refresh" onClick={() => void act(() => retryBackfillRow(job.id, r.id))} disabled={busy}>Retry</Button>}
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="mt-linkbtn mt-bfp__toggle" aria-expanded={showAll} onClick={() => setShowAll((x) => !x)}>
        {showAll ? "Hide the meetings" : `Show the ${ordered.length} meeting${ordered.length === 1 ? "" : "s"}`}
      </button>
      {showAll && (
        <ol className="mt-bfp__rows">
          {ordered.map((r) => <RowState key={r.id} row={r} />)}
        </ol>
      )}
      <ConfirmDialog open={stopping} onClose={() => setStopping(false)} tone="danger" title="Stop this import?"
        description="Meetings already imported stay. The rest are left out (you can import them again later)."
        confirmLabel="Stop importing"
        onConfirm={async () => { await discardBackfill(job.id); setStopping(false); const j = await getBackfill(job.id).catch(() => null); onChange(j); }} />
    </section>
  );
}

function RowState({ row }: { row: BackfillRow }) {
  const label = { pending: "Waiting", importing: "Importing…", imported: "Imported", attached: "Added to the meeting already here", duplicate: "Already here", skipped: "Left out", failed: "Failed" }[row.state];
  return (
    <li className="mt-bfp__row" data-state={row.state}>
      <Icon name={STATE_ICON[row.state] ?? "clock"} />
      <span className="mt-bfp__date">{fmtMeetingDate(row.date)}</span>
      {row.slug ? <Link href={`/${row.slug}`}>{row.title}</Link> : <span>{row.title}</span>}
      {row.series && <span className="mt-bfp__series">{row.series}</span>}
      <span className="mt-bfp__state">{label}</span>
    </li>
  );
}

export default BackfillProgress;
