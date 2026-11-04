"use client";

import { useEffect, useState } from "react";
import { Alert, Badge, Button, Progress, useToast } from "@/components/ui";
import { StatTile } from "@/components/kit/StatTile";
import { Card, CardError, CardTitle } from "../analytics/ui";
import { LoadingBlock, fmtDateTime, plural } from "../shared";
import { n0, usd, useAiFetch, useAiPost, useLoad } from "./common";

/**
 * Admin → AI → Covers: the one-time auto-cover backfill (backend services/page_covers.py). It starts
 * on its own after deploy (no approval) and gives the pages that existed then a cover, picked the way
 * new pages get theirs: batches of 20 pages every 15 s, AI while Pages AI has spent under half its caps
 * (people's Page AI keeps the rest), keyword matching after. Encrypted pages, templates, pages whose cover someone removed and workspaces with
 * Auto covers off are skipped. This tab shows its progress and counts, and pauses or resumes it.
 */

interface Scan {
  at: string;
  pages: number;
  eligible: number;
  skipped: Record<"encrypted" | "template" | "removed" | "creator_off" | "has_cover" | "workspace_off" | "other", number>;
  ai_enabled: boolean;
  ai_estimate: number;
  fallback_estimate: number;
  cost_estimate_usd: number;
  batch: number;
  minutes_estimate: number;
}
interface State {
  status: "not_started" | "running" | "paused" | "done";
  started_at?: string | null;
  finished_at?: string | null;
  last_tick?: string | null;
  paused_by?: string | null;
  planned?: number;
  done?: number;
  ai?: number;
  fallback?: number;
  skipped?: number;
  failed?: number;
  batches?: number;
  budget_short?: boolean;
}
interface View { state: State; scan: Scan | null }

const SKIPS: Array<[keyof Scan["skipped"], string]> = [
  ["has_cover", "Already had a cover"],
  ["removed", "Cover removed by someone"],
  ["creator_off", "Made without a cover"],
  ["encrypted", "End-to-end encrypted"],
  ["template", "Templates"],
  ["workspace_off", "Workspace has Auto covers off"],
  ["other", "Untitled and empty, or expired"],
];

const STATUS: Record<State["status"], { label: string; tone: "neutral" | "info" | "success" | "warning" }> = {
  not_started: { label: "Starts after deploy", tone: "neutral" },
  running: { label: "Running", tone: "info" },
  paused: { label: "Paused", tone: "warning" },
  done: { label: "Done", tone: "success" },
};

export function CoversTab({ token }: { token: string }) {
  const get = useAiFetch(token);
  const post = useAiPost(token);
  const toast = useToast();
  const [bump, setBump] = useState(0);
  const v = useLoad(() => get<View>("covers/backfill"), [get, bump]);
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (v.data) setView(v.data); }, [v.data]);

  const live = view?.state.status === "running" || view?.state.status === "not_started";
  // While it runs (or is about to): the counts every few seconds.
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setBump((n) => n + 1), 4000);
    return () => window.clearInterval(id);
  }, [live]);

  if (v.error && !view) return <CardError title="Covers" onRetry={v.reload} />;
  if (!view) return <LoadingBlock label="Loading covers" minHeight={320} />;
  const { state, scan } = view;
  const st = STATUS[state.status] ?? STATUS.not_started;
  const planned = Math.max(state.planned ?? 0, (state.done ?? 0) + (state.skipped ?? 0));
  const handled = (state.done ?? 0) + (state.skipped ?? 0) + (state.failed ?? 0);

  const toggle = async () => {
    const pausing = state.status === "running";
    setBusy(true);
    try {
      setView(await post<View>(pausing ? "covers/backfill/pause" : "covers/backfill/resume"));
      toast.success(pausing ? "Paused. Covers already added stay." : "Resumed where it left off.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Card aria-labelledby="cov-h">
        <CardTitle
          id="cov-h"
          title="Auto covers for existing pages"
          sub="New pages get a cover picked for what they're about. After the deploy that added this, the pages made before get one the same way, once, by themselves. Encrypted pages, templates and pages whose cover someone removed are left alone."
          right={
            <>
              <Badge size="sm" tone={st.tone} dot={state.status === "running"} live={state.status === "running"}>{st.label}</Badge>
              {(state.status === "running" || state.status === "paused") && (
                <Button size="sm" variant="secondary" iconLeft={state.status === "running" ? "pause" : "play"} loading={busy} onClick={() => void toggle()}>
                  {state.status === "running" ? "Pause" : "Resume"}
                </Button>
              )}
            </>
          }
        />
        {state.status === "not_started" ? (
          <p className="text-caption text-text-secondary">It starts within a minute of the server starting, and runs once. Nothing to do here.</p>
        ) : (
          <div className="flex flex-col gap-4">
            <Progress value={handled} max={Math.max(planned, handled, 1)}
              label={state.status === "done" ? `Finished ${state.finished_at ? fmtDateTime(state.finished_at) : ""}` : state.status === "paused" ? "Paused" : "Adding covers"}
              meta={<span className="tabular-nums">{n0(handled)} of {n0(Math.max(planned, handled))}</span>}
              valueText={`${handled} of ${planned} pages`} />
            <section aria-label="Progress" className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
              <StatTile size="md" icon="image" label="Covers added" value={n0(state.done)} caption={`of ${plural(planned, "page")} without one`} />
              <StatTile size="md" icon="sparkle" label="Picked by AI" value={n0(state.ai)}
                caption={scan?.ai_enabled === false ? "Pages AI is off" : "Up to half the Pages AI budget"} />
              <StatTile size="md" icon="hash" label="By keywords" value={n0(state.fallback)}
                caption={state.budget_short ? "The budget ran short" : "When AI can't answer"} />
              <StatTile size="md" icon="clock" label="Started" value={state.started_at ? fmtDateTime(state.started_at) : "—"}
                caption={`${plural(state.batches ?? 0, "batch", "batches")} of ${scan?.batch ?? 20}${(state.failed ?? 0) > 0 ? ` · ${n0(state.failed)} failed` : ""}`} />
            </section>
            {state.budget_short && (
              <Alert tone="info" title="Half the Pages AI budget is used">The backfill leaves the rest to people's Page AI, so the remaining pages are matched by keywords. Each still gets a cover that fits its title.</Alert>
            )}
            {scan && (
              <details className="text-caption text-text-secondary">
                <summary className="cursor-pointer select-none hover:text-text">
                  Left alone: {plural(Object.values(scan.skipped).reduce((a, b) => a + b, 0) + (state.skipped ?? 0), "page")}
                </summary>
                <ul className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                  {SKIPS.map(([k, label]) => (
                    <li key={k} className="flex justify-between gap-3 border-b border-border py-1"><span>{label}</span><span className="tabular-nums text-text">{n0(scan.skipped[k])}</span></li>
                  ))}
                  <li className="flex justify-between gap-3 border-b border-border py-1"><span>Changed while it ran, or nothing to go by</span><span className="tabular-nums text-text">{n0(state.skipped)}</span></li>
                </ul>
                <p className="mt-2 text-micro text-text-muted">Counted when it started{scan.at ? `, ${fmtDateTime(scan.at)}` : ""}: {plural(scan.pages, "page")} in all. Estimated cost {usd(scan.cost_estimate_usd)}.</p>
              </details>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
