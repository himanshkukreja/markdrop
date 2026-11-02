"use client";

import { useId, useRef } from "react";
import { Anchor, Button, Icon, Progress, Spinner } from "@/components/ui";
import { primaryAddress, siteHost, type Build } from "@/lib/docsSites";
import { SECURING_TITLE } from "../AddressSecuring";
import { num, plural } from "../format";
import { useSite } from "../SiteContext";
import { summaryCount, summarySentence } from "./shared";

type StepState = "done" | "running" | "waiting";
const ORDER = ["waiting", "pages", "extras", "live"] as const;

function eta(s: number): string {
  if (s < 10) return "a few seconds left";
  if (s < 60) return `about ${Math.round(s / 5) * 5} s left`;
  const m = Math.round(s / 60);
  return m === 1 ? "about a minute left" : `about ${m} min left`;
}

/**
 * The Publishing board: what the running publish is doing (snapshot saved → building the pages, n
 * of m → search, Ask AI and link previews → going live at the address), a progress bar and how
 * long is left, from GET /publish-status (polled every 2 s by PublishState).
 */
export function ProgressView({ build, queuedAfter, compareHref }: { build: Build; queuedAfter: number; compareHref: string }) {
  const { site, base } = useSite();
  const uid = useId();
  const p = build.progress;
  const stage = p?.stage ?? "waiting";
  const at = ORDER.indexOf(stage);
  const pct = p?.percent ?? 2;
  const host = primaryAddress(site);
  const state = (i: number): StepState => (i < at ? "done" : i === at ? "running" : "waiting");
  // Before Next renders (writing, fetching files, compiling) there's no page count to show yet.
  const preparing = stage === "pages" && !!p?.step && p.step !== "build";
  const pagesDetail = !p || !p.pages_total
    ? stage === "waiting" ? "waiting to start" : preparing ? "preparing" : "rendering"
    : stage === "pages" ? preparing ? "preparing" : `${num(p.pages_done)} of ${plural(p.pages_total, "page")}` : plural(p.pages_total, "page");
  const steps: Array<{ label: React.ReactNode; detail: string; state: StepState; parallel?: boolean }> = [
    { label: "Saved a snapshot of your pages", detail: build.changes ? plural(summaryCount(build.changes) || 1, "change") : "done", state: "done" },
    { label: "Building the pages", detail: pagesDetail, state: stage === "waiting" ? "running" : state(1) },
    { label: "Search, Ask AI and link previews", detail: state(2) === "done" ? "done" : state(2) === "running" ? "indexing" : "next", state: state(2) },
    { label: <>Going live at <span className="ph-sensitive ph-mask">{host}</span></>, detail: state(3) === "running" ? "switching readers over" : "next", state: state(3) },
  ];
  // A new guide's address gets its certificate alongside the build (a minute or three from the
  // publish, AddressSecuring.tsx): the timeline says so while that's still on its way, and keeps the
  // step, ticked, once it's done.
  const addr = primaryAddress(site) === siteHost(site) ? site.address_state ?? "ready" : "ready";
  const secures = useRef(addr !== "ready");
  if (addr !== "ready") secures.current = true;
  if (secures.current) {
    steps.push({
      label: SECURING_TITLE,
      detail: addr === "securing" ? "usually 1–3 min" : addr === "pending" ? "next · usually 1–3 min" : "done",
      state: addr === "securing" ? "running" : addr === "pending" ? "waiting" : "done",
      parallel: true,
    });
  }
  const sentence = summarySentence(build.changes);

  return (
    <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-[880px] flex-col gap-6 px-4 pb-16 pt-6 outline-none sm:px-6 sm:pt-10">
      <section aria-labelledby={`${uid}-t`} className="flex flex-col gap-5 rounded-2xl border border-border bg-surface p-5 shadow-sm sm:p-7">
        <div className="flex flex-wrap items-start gap-4">
          <span className="grid size-12 shrink-0 place-items-center rounded-[14px] bg-accent-soft text-accent-text" aria-hidden><Icon name="upload" size={22} /></span>
          <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-1">
            <h1 id={`${uid}-t`} className="text-[24px] font-bold leading-8 text-text">Publishing your guide</h1>
            <p className="text-body text-text-secondary">Usually about a minute. Readers keep seeing the current version until the new one is complete, then it switches in one step.</p>
          </div>
          <span className="whitespace-nowrap text-[13px] text-text-muted" aria-live="off">{p ? eta(p.eta_seconds) : "starting"}</span>
        </div>
        <Progress value={pct} max={100} aria-label={`Publish #${build.number}: ${pct}%`} valueText={`${pct}%`} />
        <ol className="flex flex-col gap-0.5" aria-label="Steps">
          {steps.map((s, i) => (
            <li key={i} className={`flex items-center gap-3 rounded-lg px-3 py-2.5 ${s.state === "running" && !s.parallel ? "bg-accent-soft" : ""}`} aria-current={s.state === "running" && !s.parallel ? "step" : undefined}>
              <span
                className={`grid size-6 shrink-0 place-items-center rounded-full ${s.state === "done" ? "bg-success-soft text-success" : s.state === "running" ? (s.parallel ? "bg-accent-soft text-accent-text" : "bg-surface text-accent-text") : "bg-surface-inset"}`}
                aria-hidden
              >
                {s.state === "done" && <Icon name="check" size={14} />}
                {s.state === "running" && <Spinner size={14} />}
              </span>
              <strong className={`min-w-0 flex-1 ${s.state === "running" ? "font-bold text-text" : s.state === "waiting" ? "font-medium text-text-muted" : "font-medium text-text"}`}>
                {s.label}
                <span className="md-visually-hidden">{s.state === "done" ? ", done" : s.state === "running" ? ", in progress" : ", next"}</span>
              </strong>
              <span className="text-[12px] text-text-muted">{s.detail}</span>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap items-center gap-2.5 border-t border-border pt-4">
          <Icon name="info" size={14} className="shrink-0 text-text-muted" />
          <span className="min-w-0 flex-[1_1_280px] text-text-secondary">
            You can keep editing or close this page. Changes you make now go in the next publish, and you&apos;ll see a notice here when it&apos;s live.
            {queuedAfter > 0 && ` ${plural(queuedAfter, "more publish", "more publishes")} ${queuedAfter === 1 ? "is" : "are"} waiting after this one.`}
          </span>
          <Button variant="secondary" size="sm" iconLeft="edit" href={base}>Back to the editor</Button>
        </div>
      </section>

      <section aria-labelledby={`${uid}-in`} className="flex flex-col gap-2.5">
        <h2 id={`${uid}-in`} className="text-[16px] font-semibold leading-6 text-text">In this publish</h2>
        <p className="text-body text-text-secondary">
          {sentence || `Publish #${build.number}.`}{" "}
          <Anchor href={compareHref} className="text-accent-text underline-offset-2 hover:underline">See the changes</Anchor>
        </p>
        {build.note && <p className="ph-sensitive ph-mask text-[13px] text-text-muted">&ldquo;{build.note}&rdquo;</p>}
      </section>
    </main>
  );
}

export default ProgressView;
