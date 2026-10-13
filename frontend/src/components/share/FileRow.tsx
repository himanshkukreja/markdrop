"use client";

/**
 * A file in the sender's Files panel (REVAMP_PLAN 7.16): icon tile, name, "4.8 MB · Delivered to 2 ·
 * sending to 1", DeliveryDots, and a Remove IconButton. While someone has the file queued or in
 * flight, Remove is aria-disabled (focusable, inert) so its Tooltip "Someone is downloading this" is
 * reachable by keyboard.
 */
import { memo } from "react";
import { Badge, FileIcon, IconButton, Tooltip, cx } from "@/components/ui";
import { formatBytes } from "@/lib/webrtc";
import DeliveryDots, { deliverySummary, type Dot } from "./DeliveryDots";

export interface FileRowProps {
  id: string;
  name: string;
  mime: string;
  size: number;
  delivered: number;
  sending: number;
  unreadable: boolean;
  busy: boolean;
  dots: Dot[];
  /** False once the share is over: no Remove. */
  removable: boolean;
  onRemove: (id: string) => void;
}

function FileRowImpl(f: FileRowProps) {
  const label = `Remove ${f.name}`;
  return (
    <li className="grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 border-t border-border py-3 pl-4 pr-3 first:border-t-0 sm:grid-cols-[36px_minmax(0,1fr)_auto_auto]">
      <span className="grid size-9 place-items-center rounded-lg border border-border bg-surface-inset" aria-hidden>
        <FileIcon name={f.name} mime={f.mime} size={18} />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-body-strong text-text" title={f.name}>{f.name}</span>
        {f.unreadable ? (
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <Badge tone="warning" size="sm" icon="alert">Couldn&apos;t read</Badge>
            <span className="text-caption text-text-secondary">Moved or deleted. Remove it and add it again.</span>
          </span>
        ) : (
          <span className="flex min-w-0 items-center gap-2">
            {f.dots.length > 0 && <span className="inline-flex sm:hidden"><DeliveryDots dots={f.dots} /></span>}
            <span className="truncate text-caption tabular-nums text-text-muted">
              {formatBytes(f.size)} · {deliverySummary(f)}
            </span>
          </span>
        )}
      </div>
      <span className="hidden sm:inline-flex"><DeliveryDots dots={f.dots} /></span>
      {f.removable ? (
        f.busy ? (
          <Tooltip content="Someone is downloading this" side="left">
            <IconButton icon="trash" label={label} aria-disabled="true" title=""
              className={cx("size-11 sm:size-9 cursor-not-allowed opacity-50")}
              onClick={(e) => e.preventDefault()} />
          </Tooltip>
        ) : (
          <IconButton icon="trash" label={label} className="size-11 sm:size-9" onClick={() => f.onRemove(f.id)} />
        )
      ) : <span />}
    </li>
  );
}

export const FileRow = memo(FileRowImpl, (a, b) =>
  a.id === b.id && a.name === b.name && a.size === b.size && a.mime === b.mime && a.delivered === b.delivered &&
  a.sending === b.sending && a.unreadable === b.unreadable && a.busy === b.busy && a.removable === b.removable &&
  a.onRemove === b.onRemove && a.dots.length === b.dots.length &&
  a.dots.every((d, i) => d.state === b.dots[i].state && d.label === b.dots[i].label));
export default FileRow;
