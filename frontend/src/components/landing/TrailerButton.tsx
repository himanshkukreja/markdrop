"use client";

import dynamic from "next/dynamic";
import { useState, type ReactNode } from "react";

/**
 * A button that opens a video in the docs player: "Watch the overview" in the landing hero, "Watch
 * the 2-minute tour" on the Markdrop Guides section and /guides. The button is all the page ships: the
 * docs player (and its CSS) is a separate chunk loaded when the reader clicks (warmed on hover or
 * focus), and the video itself is fetched only once the dialog is open. Counted by the page's
 * CtaTracker (or /guides' LandingTracker) through data-cta.
 */
const VideoDialog = dynamic(() => import("@/docs/client/Player").then((m) => m.VideoDialog), { ssr: false });
const warm = () => void import("@/docs/client/Player").catch(() => {});

export interface Trailer {
  src: string;
  poster: string;
  title: string;
  duration: string;
  chaptersSrc?: string;
  captionsSrc?: string;
  w?: number;
  h?: number;
}

export default function TrailerButton({ trailer, className, label, cta = "guides_tour" }: { trailer: Trailer; className?: string; label: ReactNode; cta?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} onPointerEnter={warm} onFocus={warm} data-cta={cta} aria-haspopup="dialog">
        <svg viewBox="0 0 24 24" aria-hidden width="16" height="16" fill="currentColor">
          <path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l10.9-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14z" />
        </svg>
        {label}
        <span className="sr-only"> ({trailer.duration} video)</span>
      </button>
      {open && <VideoDialog {...trailer} autoPlay onClose={() => setOpen(false)} />}
    </>
  );
}
