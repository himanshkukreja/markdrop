"use client";

import { useEffect, useId, useState } from "react";
import { Anchor, Icon, Progress, Skeleton } from "@/components/ui";
import { guideEvents } from "@/lib/guidesEvents";
import { presetName, type SetupStatus } from "@/lib/docsSites";
import { isEmptyCustom } from "@/lib/guideThemes";
import { plural, timeAgo } from "../format";
import { insightsSeenKey } from "../SiteBar";
import { useSite } from "../SiteContext";

type Step = "pages" | "look" | "publish" | "domain" | "team" | "insights";
interface Item { step: Step; title: string; note: string; done: boolean; cta: string; href: string }

/**
 * "Finish setting up" (PublishLive board), from the guide's real state (GET /setup): pages written,
 * a look chosen (the design saved once), published, an own domain, a team (more than one person
 * with a Guides role; not on a personal guide), and Insights (data, or opened on this device).
 */
export function Checklist({ setup, className }: { setup: SetupStatus | null; className?: string }) {
  const { site, base, isAdmin } = useSite();
  const uid = useId();
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    try { setSeen(localStorage.getItem(insightsSeenKey(site.id)) === "1"); } catch { /* a convenience only */ }
  }, [site.id]);

  if (!setup) {
    return (
      <section aria-busy="true" aria-label="Finish setting up" className={`flex flex-col gap-3 rounded-xl border border-border bg-surface p-5 ${className ?? ""}`}>
        <Skeleton width="40%" /><Skeleton width="80%" /><Skeleton width="70%" /><Skeleton width="75%" />
      </section>
    );
  }
  const theme = site.settings.theme;
  const ownLive = site.domains?.find((d) => d.status === "live" || d.status === "verified")?.host;
  const items: Item[] = [
    { step: "pages", title: "Write your first pages", note: setup.pages ? plural(setup.pages, "page") : "Start with what readers ask most", done: setup.pages > 0, cta: "Write", href: base },
    {
      step: "look", title: "Choose a look",
      note: setup.look_chosen ? `${presetName(theme.preset)}${isEmptyCustom(theme.custom) ? "" : ", customised"}${theme.brand?.enabled ? ", matched to your logo" : ""}` : "A theme, your colours and logo",
      done: setup.look_chosen, cta: "Design", href: `${base}/design`,
    },
    { step: "publish", title: "Publish", note: setup.published ? (setup.live_since ? `Live since ${timeAgo(setup.live_since)}` : "Published") : "Readers see it at its address", done: setup.published, cta: "Publish", href: `${base}/publish` },
    {
      step: "domain", title: "Use your own domain",
      note: setup.own_domain ? (ownLive ? `Live at ${ownLive}` : "Waiting for its DNS record") : "help.yourcompany.com with one DNS record",
      done: setup.own_domain, cta: "Add domain", href: `${base}/settings/domains`,
    },
    ...(setup.team === null ? [] : [{
      step: "team" as const, title: "Invite your team", note: setup.team > 1 ? `${plural(setup.team, "person", "people")} work on it` : "Editors write, reviewers approve",
      done: setup.team > 1, cta: "Invite", href: `${base}/settings/people`,
    }]),
    { step: "insights", title: "Check what readers look for", note: "Insights: searches with no results, feedback", done: setup.insights_data || seen, cta: "Insights", href: `${base}/insights` },
  ];
  // Only admins add a domain or people: for anyone else those steps are informational.
  const actionable = (i: Item) => !i.done && ((i.step !== "domain" && i.step !== "team" && i.step !== "look") || isAdmin);
  const doneCount = items.filter((i) => i.done).length;

  return (
    <section aria-labelledby={`${uid}-h`} className={`flex flex-col gap-3 rounded-xl border border-border bg-surface p-5 ${className ?? ""}`}>
      <div className="flex items-center gap-2.5">
        <h2 id={`${uid}-h`} className="min-w-0 flex-1 text-[16px] font-semibold leading-6 text-text">Finish setting up</h2>
        <span className="text-[12px] text-text-muted">{doneCount} of {items.length} done</span>
      </div>
      <Progress value={doneCount} max={items.length} size="sm" aria-label={`Setup: ${doneCount} of ${items.length}`} valueText={`${doneCount} of ${items.length} done`} />
      <ul className="flex flex-col">
        {items.map((i) => {
          const body = (
            <>
              <span
                className={`grid size-6 shrink-0 place-items-center rounded-full text-success ${i.done ? "bg-success-soft" : "border-[1.5px] border-dashed border-border-strong"}`}
                aria-hidden
              >
                {i.done && <Icon name="check" size={13} />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <strong className={`font-semibold ${i.done ? "text-text-secondary" : "text-text"}`}>
                  {i.title}<span className="md-visually-hidden">{i.done ? ", done" : ", to do"}</span>
                </strong>
                <span className="ph-sensitive ph-mask truncate text-[12px] text-text-muted">{i.note}</span>
              </span>
              {actionable(i) && (
                <span className="md-btn md-btn--secondary md-btn--sm shrink-0" aria-hidden>
                  {i.cta}<Icon name="arrowRight" />
                </span>
              )}
            </>
          );
          return (
            <li key={i.step}>
              {actionable(i) ? (
                <Anchor
                  href={i.href}
                  onClick={() => guideEvents.setupStep(i.step)}
                  className="md-focus -mx-3 flex items-center gap-3 rounded-lg px-3 py-2.5 text-text no-underline hover:bg-surface-hover"
                >
                  {body}
                </Anchor>
              ) : (
                <div className="-mx-3 flex items-center gap-3 px-3 py-2.5">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default Checklist;
