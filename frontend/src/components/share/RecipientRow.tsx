"use client";

/**
 * One person in the sender's People list (REVAMP_PLAN 7.16). Progress comes from the recipient's own
 * reports (bytesDone), not from what we've queued. The ETA appears only after 3 s of stable rate
 * (`etaReady`, from useActivity). People who left stay listed in `text-muted` with a "Left" Badge.
 * Primitive props only, so React.memo skips rows whose numbers didn't change.
 */
import { memo } from "react";
import { Badge, Progress, RouteBadge, cx } from "@/components/ui";
import { DeviceGlyph } from "@/components/kit/DeviceGlyph";
import { formatBytes, formatRate } from "@/lib/webrtc";
import { FAILURE_COPY, type FailureReason } from "@/lib/p2p/protocol";
import type { RecipientState } from "@/lib/p2p/sender";
import { deviceKindOf, etaText } from "./live";

export interface RecipientRowProps {
  label: string;
  state: RecipientState;
  route: "direct" | "relay" | null;
  filesDone: number;
  filesWanted: number;
  bytesDone: number;
  bytesWanted: number;
  rate: number;
  failure: FailureReason | null;
  totalFiles: number;
  etaReady: boolean;
}

function RecipientRowImpl(r: RecipientRowProps) {
  const gone = r.state === "left" || r.state === "failed";
  const pct = r.bytesWanted ? Math.min(100, (r.bytesDone / r.bytesWanted) * 100) : 0;
  const everything = r.filesWanted === r.totalFiles && r.totalFiles > 0;

  let line: string;
  switch (r.state) {
    case "connecting":
      line = "Connecting…";
      break;
    case "browsing":
      line = r.filesDone > 0 ? `Has ${r.filesDone} of ${r.totalFiles} · browsing the rest` : "Browsing the files";
      break;
    case "downloading": {
      const parts = [`${r.filesDone} of ${r.filesWanted} saved`];
      if (r.rate > 0) parts.push(formatRate(r.rate));
      if (r.etaReady && r.rate > 0) {
        const eta = etaText((r.bytesWanted - r.bytesDone) / r.rate);
        if (eta) parts.push(eta);
      }
      line = parts.join(" · ");
      break;
    }
    case "done":
      line = everything
        ? `${r.filesDone} of ${r.totalFiles} saved · ${formatBytes(r.bytesWanted)}`
        : `${r.filesDone} of ${r.totalFiles} saved`;
      break;
    case "left":
      line = r.filesDone ? `Got ${r.filesDone} of ${r.totalFiles}` : "Left without downloading";
      break;
    default:
      line = r.failure ? FAILURE_COPY[r.failure].title : "Disconnected";
  }

  return (
    <li className="grid grid-cols-[36px_minmax(0,1fr)] items-center gap-3 border-t border-border px-4 py-3 first:border-t-0">
      <DeviceGlyph kind={deviceKindOf(r.label)} framed={36} size={18} className={gone ? "text-text-muted" : undefined} />
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cx("min-w-0 truncate text-body-strong", gone ? "text-text-muted" : "text-text")}>{r.label}</span>
          {!gone && <RouteBadge route={r.route} />}
          <span className="ml-auto inline-flex shrink-0 items-center">
            {r.state === "done" && <Badge tone="success" icon="check">Delivered</Badge>}
            {r.state === "downloading" && <span className="text-body-strong tabular-nums text-text">{Math.floor(pct)}%</span>}
            {r.state === "left" && <Badge tone="neutral">Left</Badge>}
            {r.state === "failed" && <Badge tone="warning" icon="alert">Lost connection</Badge>}
          </span>
        </div>
        {(r.state === "downloading" || r.state === "done") && (
          <Progress size="sm" value={r.state === "done" ? 100 : pct} tone={r.state === "done" ? "success" : "accent"}
            aria-label={`${r.label}: ${r.state === "done" ? "delivered" : "downloading"}`}
            valueText={`${formatBytes(r.bytesDone)} of ${formatBytes(r.bytesWanted)}`} />
        )}
        <span className={cx("truncate text-caption tabular-nums", gone ? "text-text-muted" : "text-text-secondary")}>{line}</span>
      </div>
    </li>
  );
}

export const RecipientRow = memo(RecipientRowImpl);
export default RecipientRow;
