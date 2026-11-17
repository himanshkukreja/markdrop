"use client";

import { useState } from "react";
import { IconButton, Spinner, cx } from "@/components/ui";
import type { PdfPreviewState } from "@/lib/api";

/**
 * A PowerPoint deck's exact preview (backend services/pptx_preview.py), said over the slide viewer:
 * "Preparing an exact preview…" while the server converts the deck to a PDF (the page swaps to the
 * PDF on its own when it's ready: the live socket re-reads it), and "Preview may differ from
 * PowerPoint" when it couldn't be made. Nothing once the PDF shows, or for any other file.
 */
export function previewNoteText(state: PdfPreviewState | null | undefined): string | null {
  if (state === "converting") return "Preparing an exact preview…";
  if (state === "failed") return "Preview may differ from PowerPoint";
  return null;
}

export function PreviewNote({ state, className }: { state: PdfPreviewState | null | undefined; className?: string }) {
  const [hidden, setHidden] = useState<string | null>(null);
  const text = previewNoteText(state);
  if (!text || hidden === state) return null;
  return (
    <div
      role="status"
      className={cx(
        "pointer-events-auto absolute bottom-3 left-1/2 z-20 flex max-w-[calc(100%-7rem)] -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-surface-raised py-1 pr-1 pl-3 text-caption text-text-secondary shadow-sm",
        className,
      )}
    >
      {state === "converting" && <Spinner size={14} />}
      <span className="truncate">{text}</span>
      <IconButton icon="x" size="sm" label="Dismiss" onClick={() => setHidden(state ?? null)} />
    </div>
  );
}
