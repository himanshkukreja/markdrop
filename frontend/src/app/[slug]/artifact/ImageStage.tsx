"use client";

import { useState } from "react";
import { cx } from "@/components/ui";

/**
 * An image file's body. The raw file in an iframe showed at its natural size on phones and tablets
 * (a 1600 px photo in a 393 px frame: one corner of it); here it fits the stage, whole, at any
 * width and in either orientation, and a tap shows it at full size (scrollable), another fits it
 * again. Still the artifact origin's URL (`/r/<key>`, a signed `?t=` included), as an <img>: an
 * image can't run anything, an SVG in an <img> included.
 */
export function ImageStage({ src, alt, onDone }: { src: string; alt: string; onDone: () => void }) {
  const [full, setFull] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="grid h-full w-full place-items-center p-6 text-center text-body text-text-muted" role="status">
        This file isn&apos;t available. It may have expired or been deleted.
      </div>
    );
  }
  return (
    <div className={cx("ph-no-capture h-full w-full overflow-auto overscroll-contain", full ? "block" : "grid place-items-center p-2 sm:p-4")}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a user's file on the artifact origin, not a static asset */}
      <img
        src={src}
        alt={alt}
        draggable={false}
        onLoad={onDone}
        onError={() => {
          setFailed(true);
          onDone();
        }}
        onClick={() => setFull((f) => !f)}
        className={cx("block select-none", full ? "max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain")}
        title={full ? "Fit to the screen" : "Show at full size"}
      />
    </div>
  );
}

export default ImageStage;
