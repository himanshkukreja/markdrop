"use client";

import { useId } from "react";
import { Badge, Button, copyText, useToast } from "@/components/ui";
import { guideEvents } from "@/lib/guidesEvents";
import { liveAddresses, primaryAddress, type Build, type SetupStatus, type SiteSummary } from "@/lib/docsSites";
import { firstName, timeAgo } from "../format";
import { GuidePreview } from "../home/GuidePreview";
import { liveUrl, usePublishState } from "../PublishState";
import { useSite } from "../SiteContext";
import { Checklist } from "./Checklist";
import { History } from "./History";
import { AddressRow, seconds } from "./shared";

/**
 * Your guide is live (PublishLive board): the guide's thumbnail, every address it answers at (Copy,
 * Open in a new tab), which publish readers see, Open / Keep writing / Share; "Finish setting up";
 * the publish history.
 */
export function LiveView({ live, builds, setup, restoring, onRestore }: {
  live: Build | null;
  builds: Build[] | null;
  setup: SetupStatus | null;
  restoring: string | null;
  onRestore: (b: Build) => void;
}) {
  const { site, base, canEdit } = useSite();
  const { publish, starting, mustReview } = usePublishState();
  const toast = useToast();
  const uid = useId();
  const isLive = site.status === "live";
  const host = primaryAddress(site);
  const addresses = liveAddresses(site);
  const theme = site.settings.theme;
  // The thumbnail draws the saved design (the listing's theme can lag a save).
  const summary: SiteSummary = {
    ...site,
    theme: { preset: theme.preset, mode: theme.mode ?? "both", corners: theme.corners ?? null, brand: { ...theme.brand, colors: theme.brand?.colors ?? [] } },
  };
  const meta = live ? [
    `Publish #${live.number}`,
    `went live ${timeAgo(live.finished_at ?? site.last_published_at ?? live.created_at)}`,
    live.requested_by_name ? `published by ${firstName(live.requested_by_name)}` : null,
    live.stats?.ms ? `built in ${seconds(live.stats.ms)}` : null,
  ].filter(Boolean).join(" · ") : "";

  const share = async () => {
    const ok = await copyText(liveUrl(host));
    if (ok) {
      guideEvents.shareCopied();
      toast.success(<>Link copied: <span className="ph-sensitive ph-mask">{host}</span></>);
    } else toast.error("Couldn't copy. Select the address and copy it instead.");
  };

  return (
    <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 px-4 pb-16 pt-6 outline-none sm:px-6 sm:pt-8">
      <section aria-labelledby={`${uid}-live`} className="flex flex-wrap gap-7 rounded-2xl border border-border bg-surface p-4 shadow-sm sm:p-6">
        {isLive ? (
          <a
            href={liveUrl(host)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open the live guide in a new tab"
            onClick={() => guideEvents.liveOpened("publish")}
            className="md-focus block min-w-0 flex-[0_1_360px] rounded-xl bg-surface-inset px-3 pt-3 max-sm:hidden"
          >
            <GuidePreview site={summary} height={196} />
          </a>
        ) : (
          <div className="min-w-0 flex-[0_1_360px] rounded-xl bg-surface-inset px-3 pt-3 opacity-70 max-sm:hidden"><GuidePreview site={summary} height={196} /></div>
        )}
        <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-3.5">
          {isLive ? <Badge tone="success" dot className="self-start">Live</Badge> : <Badge className="self-start">{site.status === "unpublished" ? "Unpublished" : "Not published"}</Badge>}
          <h1 id={`${uid}-live`} className="text-[26px] font-bold leading-8 tracking-[-0.02em] text-text">
            {isLive ? "Your guide is live" : "Your guide is offline"}
          </h1>
          {isLive ? (
            <div className="flex flex-col gap-2">
              {addresses.map((a) => <AddressRow key={a.host} host={a.host} own={a.own} note={a.own ? "Your domain" : "Free address"} />)}
            </div>
          ) : (
            <p className="text-text-secondary">Readers can&apos;t open it. Publish again to put it back at its address.</p>
          )}
          {isLive && meta && <p className="text-text-secondary">{meta}</p>}
          <div className="flex flex-wrap gap-2">
            {isLive ? (
              <>
                <Button variant="primary" iconRight="external" href={liveUrl(host)} target="_blank" rel="noopener noreferrer" onClick={() => guideEvents.liveOpened("publish")}>
                  Open the guide<span className="md-visually-hidden"> in a new tab</span>
                </Button>
                <Button variant="secondary" iconLeft="edit" href={base}>Keep writing</Button>
                <Button variant="ghost" iconLeft="link" onClick={() => void share()}>Share</Button>
              </>
            ) : (
              <>
                {canEdit && !mustReview && <Button variant="primary" iconLeft="upload" loading={starting} onClick={() => void publish({ from: "publish_screen" })}>Publish again</Button>}
                <Button variant="secondary" iconLeft="edit" href={base}>Keep writing</Button>
              </>
            )}
          </div>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
        <Checklist setup={setup} />
        <History builds={builds} restoring={restoring} onRestore={onRestore} />
      </div>
    </main>
  );
}

export default LiveView;
