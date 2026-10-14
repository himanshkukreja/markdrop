"use client";

import { Button, CopyButton, Dropdown, FileIcon, IconButton, Tooltip, cx, type MenuEntry, type FileRenderer } from "@/components/ui";
import ArtifactBadge, { formatBytes } from "@/components/ArtifactBadge";
import { useIsClient } from "@/components/kit/publish-utils";
import type { ArtifactRenderer } from "@/lib/api";
import { shortDate } from "./frame";

export interface ArtifactBarProps {
  slug: string;
  title: string | null;
  originalFilename: string | null;
  mime: string;
  renderer: ArtifactRenderer;
  fileRenderer?: FileRenderer;
  typeLabel: string;
  sizeBytes: number;
  views?: number;
  createdAt: string;
  /** What Copy link copies (the public URL). */
  url: string;
  canOpen: boolean;
  downloading: boolean;
  onDownload: () => void;
  onExpand: () => void;
  menu: MenuEntry[];
}

/**
 * The framed artifact's DocumentBar (REVAMP_PLAN 7.7): FileIcon tile, title (one line, ellipsis +
 * Tooltip, `dir="auto"`, the slug in mono when untitled), the type Badge once, and the caption
 * "2.4 MB · 12 views · Oct 12". Desktop actions: Copy link (the one primary) · Download · expand ·
 * More. Phones get the same actions in a sticky bottom dock (MobileReading frame 10).
 */
export function ArtifactBar(p: ArtifactBarProps) {
  const isClient = useIsClient();
  const shown = (p.title || "").trim();
  const name = shown || p.originalFilename || "";
  const caption = [
    formatBytes(p.sizeBytes),
    typeof p.views === "number" ? `${p.views.toLocaleString()} view${p.views === 1 ? "" : "s"}` : null,
    isClient ? shortDate(p.createdAt) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const heading = (
    <h1
      dir="auto"
      className={cx(
        "m-0 min-w-0 truncate text-h4 text-text",
        !name && "font-mono",
      )}
    >
      {name || p.slug}
    </h1>
  );

  const more = (
    <Dropdown
      align="right"
      aria-label="More artifact actions"
      trigger={<IconButton icon="more" label="More artifact actions" variant="secondary" />}
      items={p.menu}
    />
  );

  return (
    <>
      <div className="no-print flex min-w-0 items-center gap-3">
        <span
          aria-hidden
          className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-surface-inset"
        >
          <FileIcon renderer={p.fileRenderer} name={p.originalFilename ?? ""} mime={p.mime} size={20} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            {name.length > 40 ? <Tooltip className="flex min-w-0" content={name}>{heading}</Tooltip> : heading}
            <ArtifactBadge renderer={p.renderer} label={p.typeLabel} />
          </div>
          <span className="truncate text-caption tabular-nums text-text-muted">{caption}</span>
        </div>

        <div className="hidden shrink-0 items-center gap-2 sm:flex">
          <CopyButton text={p.url} label="Copy link" variant="primary" size="md" />
          {p.canOpen && (
            <>
              <Button variant="secondary" iconLeft="download" onClick={p.onDownload} loading={p.downloading}>
                {p.downloading ? "Preparing…" : "Download"}
              </Button>
              <IconButton icon="expand" label="Read full screen" variant="ghost" onClick={p.onExpand} />
            </>
          )}
          {p.menu.length > 0 && more}
        </div>
        {p.canOpen && (
          <IconButton icon="expand" label="Read full screen" size="lg" className="sm:hidden" onClick={p.onExpand} />
        )}
      </div>

      {/* Phone dock: Copy link · Download · More, above the home indicator. */}
      <div
        role="toolbar"
        aria-label="Artifact actions"
        className="no-print fixed inset-x-0 bottom-0 z-(--z-sticky) flex items-start gap-2 border-t border-border bg-surface px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] sm:hidden"
      >
        <div className="min-w-0 flex-1">
          <CopyButton text={p.url} label="Copy link" variant="primary" size="md" block className="min-h-11" />
        </div>
        {p.canOpen && (
          <Button variant="secondary" size="lg" iconLeft="download" onClick={p.onDownload} loading={p.downloading}>
            {p.downloading ? "Preparing…" : "Download"}
          </Button>
        )}
        {p.menu.length > 0 && (
          <Dropdown
            align="right"
            placement="top"
            aria-label="More artifact actions"
            trigger={<IconButton icon="more" label="More artifact actions" variant="secondary" size="lg" />}
            items={p.menu}
          />
        )}
      </div>
    </>
  );
}

export default ArtifactBar;
