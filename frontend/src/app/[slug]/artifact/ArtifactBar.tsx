"use client";

import { Button, CopyButton } from "@/components/ui";

// The framed file's top bar is ArtifactTopBar (one bar, a page's: components/pages/PageChrome).

export interface ArtifactDockProps {
  /** What Copy link copies (the public URL). */
  url: string;
  canOpen: boolean;
  downloading: boolean;
  onDownload: () => void;
}

/**
 * Phones (<640): the sticky bottom dock (MobileReading frame 10): Copy link · Download, above the
 * home indicator. Share, Settings and the rest are in the top bar's ⋯ sheet.
 */
export function ArtifactDock(p: ArtifactDockProps) {
  return (
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
    </div>
  );
}
