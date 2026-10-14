"use client";

/**
 * A file on the receive page (REVAMP_PLAN 7.17): a 48px tile (the thumbnail crossfades over the
 * FileIcon when an image lands), name and size, a small Progress while receiving, and one 44px
 * action: Download <name>, "Queued", the %, Save, or Saved. The thumbnail's object URL is revoked
 * when the blob changes or the row unmounts.
 */
import { memo, useEffect, useMemo } from "react";
import { Badge, Button, FileIcon, Icon, IconButton, Progress, cx, isImage } from "@/components/ui";
import { formatBytes } from "@/lib/webrtc";
import type { ReceivedFileStatus } from "@/lib/p2p/receiver";
import ui from "./share.module.css";

export interface ReceivedFileRowProps {
  id: string;
  name: string;
  mime: string;
  size: number;
  status: ReceivedFileStatus;
  received: number;
  blob: Blob | null;
  saved: boolean;
  /** The sender is gone: nothing more can be fetched. */
  ended: boolean;
  /** Where a saved file went, for the caption ("saved to Downloads" / "saved"). */
  savedWhere: string;
  onFetch: (id: string) => void;
  onSave: (id: string) => void;
}

function ReceivedFileRowImpl(f: ReceivedFileRowProps) {
  const thumb = useMemo(
    () => (f.blob && isImage(f.name, f.mime) ? URL.createObjectURL(f.blob) : null),
    [f.blob, f.name, f.mime],
  );
  useEffect(() => () => { if (thumb) URL.revokeObjectURL(thumb); }, [thumb]);
  const pct = f.size ? Math.min(100, Math.round((f.received / f.size) * 100)) : 100;
  const missing = f.ended && f.status !== "done";

  let meta: string;
  if (f.status === "receiving") meta = `${formatBytes(f.received)} of ${formatBytes(f.size)}`;
  else if (f.status === "done") meta = `${formatBytes(f.size)} · ${f.saved ? f.savedWhere : "received"}`;
  else if (missing) meta = `${formatBytes(f.size)} · Not received`;
  else if (f.status === "failed") meta = `${formatBytes(f.size)} · Interrupted`;
  else meta = formatBytes(f.size);

  return (
    <li className="grid grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-3 border-t border-border py-3 pl-3.5 pr-3 first:border-t-0">
      <span className="relative grid size-12 place-items-center overflow-hidden rounded-lg border border-border bg-surface-inset" aria-hidden>
        <FileIcon name={f.name} mime={f.mime} size={20} />
        {thumb && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" className={cx("absolute inset-0 size-full object-cover", ui.thumb)} />
        )}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-body-strong text-text" title={f.name}>{f.name}</span>
        <span className={cx("truncate text-caption tabular-nums", missing || f.status === "failed" ? "text-warning" : "text-text-muted")}>{meta}</span>
        {f.status === "receiving" && (
          <Progress size="sm" value={pct} aria-label={`Receiving ${f.name}`}
            valueText={`${formatBytes(f.received)} of ${formatBytes(f.size)}`} />
        )}
      </div>
      <div className="flex min-h-11 min-w-11 items-center justify-end">
        {f.status === "receiving" && <span className="text-body-strong tabular-nums text-accent-text">{pct}%</span>}
        {f.status === "requested" && <Badge tone="neutral" size="sm">Queued</Badge>}
        {(f.status === "available" || f.status === "failed") && !f.ended && (
          <IconButton icon="download" label={`Download ${f.name}`} className="size-11" onClick={() => f.onFetch(f.id)} />
        )}
        {f.status === "done" && (
          f.saved ? (
            <Button variant="ghost" size="sm" className="h-11 text-success" iconLeft="check" onClick={() => f.onSave(f.id)}
              aria-label={`Saved. Save ${f.name} again`}>
              Saved
            </Button>
          ) : (
            <Button variant="secondary" size="sm" className="h-11" iconLeft="download" onClick={() => f.onSave(f.id)}
              aria-label={`Save ${f.name}`}>
              Save
            </Button>
          )
        )}
        {missing && f.status !== "available" && f.status !== "failed" && (
          <Icon name="alert" size={16} className="text-warning" aria-hidden />
        )}
      </div>
    </li>
  );
}

export const ReceivedFileRow = memo(ReceivedFileRowImpl);
export default ReceivedFileRow;
