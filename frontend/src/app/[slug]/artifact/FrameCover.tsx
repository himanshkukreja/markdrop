"use client";

import { useEffect, useState } from "react";
import { FileIcon, MarkdropLoader, Spinner, cx, type FileRenderer } from "@/components/ui";

/**
 * Covers the frame until the artifact origin has painted something (REVAMP_PLAN 7.7).
 *
 * An unloaded iframe paints nothing, which in immersive mode is the whole viewport, so this sits
 * on top and crossfades out (220ms, `--duration-panel`) on `load`. It stays mounted through the
 * fade so the artifact is never revealed by a hard cut. The 15s floor lives in the view.
 *
 * On a workspace's own domain (`tenant`) the brand loader would put Markdrop's mark on the
 * customer's site, so it is a neutral spinner instead.
 */
export function FrameCover({
  show,
  label,
  renderer,
  name,
  mime,
  tenant,
}: {
  show: boolean;
  label: string;
  renderer?: FileRenderer;
  name?: string;
  mime?: string;
  tenant?: boolean;
}) {
  // Same 300ms grace as the loader, so a fast load never flashes the label row.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShown(true), 300);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      aria-hidden={!show}
      className={cx(
        "absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-bg",
        "transition-opacity duration-(--duration-panel) ease-(--ease-out) motion-reduce:transition-none",
        show ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      {tenant ? (
        shown && (
          <div role="status" className="flex items-center gap-3 text-body text-text-secondary">
            <Spinner size={20} />
            <span>{label}</span>
          </div>
        )
      ) : (
        <>
          <MarkdropLoader label="" hideWordmark size="md" />
          {shown && (
            <p className="m-0 flex items-center gap-2 text-caption text-text-secondary">
              <FileIcon renderer={renderer} name={name} mime={mime} size={16} />
              <span>{label}</span>
            </p>
          )}
        </>
      )}
    </div>
  );
}

export default FrameCover;
