"use client";

/**
 * People (REVAMP_PLAN 7.16): who has the link open and how far each of them has got. Progress comes
 * from the recipient's own reports, so "Delivered" means it landed on their device.
 */
import { Tag } from "@/components/ui";
import type { RecipientView } from "@/lib/p2p/sender";
import RecipientRow from "./RecipientRow";
import ui from "./share.module.css";

export default function Recipients({ recipients, totalFiles, etaReady }: {
  recipients: RecipientView[];
  totalFiles: number;
  etaReady: (gid: string) => boolean;
}) {
  const here = recipients.filter((r) => r.state !== "left" && r.state !== "failed");
  const done = here.filter((r) => r.state === "done").length;
  const downloading = here.filter((r) => r.state === "downloading").length;
  const summary = [done && `${done} done`, downloading && `${downloading} downloading`].filter(Boolean).join(" · ")
    || (here.length ? "Browsing" : recipients.length ? "Nobody right now" : "Nobody yet");

  return (
    <section aria-labelledby="share-people" className={`min-w-0 overflow-hidden rounded-xl border border-border bg-surface ${ui.card}`}>
      <div className="flex h-12 items-center justify-between gap-3 border-b border-border px-4">
        <div className="flex items-center gap-2">
          <h2 id="share-people" className="text-h4 text-text">People</h2>
          <Tag>{here.length} of 10</Tag>
        </div>
        <span className="truncate text-caption tabular-nums text-text-muted">{summary}</span>
      </div>
      {recipients.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
          <p className="text-h4 text-text">Nobody has opened the link yet</p>
          <p className="max-w-[300px] text-body text-text-secondary">
            Each person who opens it shows up here with their device, their route and their own progress.
          </p>
        </div>
      ) : (
        <ul>
          {recipients.map((r) => (
            <RecipientRow key={r.gid} label={r.label} state={r.state} route={r.route} filesDone={r.filesDone}
              filesWanted={r.filesWanted} bytesDone={r.bytesDone} bytesWanted={r.bytesWanted} rate={r.rate}
              failure={r.failure} totalFiles={totalFiles} etaReady={etaReady(r.gid)} />
          ))}
        </ul>
      )}
    </section>
  );
}
