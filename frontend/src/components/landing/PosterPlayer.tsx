"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { Play } from "lucide-react";
import type { Trailer } from "./TrailerButton";
import p from "./PosterPlayer.module.css";

/**
 * A video that is a picture until it's clicked: the poster (an <img>, lazy) with a Play button and
 * the length. A click swaps in the docs player, which starts at once (with sound: the click allows
 * it; never under reduced motion). Until then the page ships only the poster and this button: the
 * player (and its CSS) is a separate chunk, warmed on hover or focus, and the video file is fetched
 * only after the click. Counted by the page's CtaTracker through data-cta.
 */
const VideoPlayer = dynamic(() => import("@/docs/client/Player").then((m) => m.VideoPlayer), { ssr: false, loading: () => null });
const warm = () => void import("@/docs/client/Player").catch(() => {});

export default function PosterPlayer({ video, alt, cta, className }: { video: Trailer; alt: string; cta: string; className?: string }) {
  const [playing, setPlaying] = useState(false);
  return (
    <div className={`${p.box} ${className ?? ""}`} data-playing={playing ? "" : undefined}>
      {playing ? (
        <VideoPlayer {...video} autoPlay chapterList={false} caption={false} />
      ) : (
        <button type="button" className={p.poster} onClick={() => setPlaying(true)} onPointerEnter={warm} onFocus={warm} data-cta={cta}>
          <img src={video.poster} alt={alt} width={video.w ?? 1600} height={video.h ?? 900} loading="lazy" decoding="async" />
          <span className={p.play} aria-hidden="true">
            <Play aria-hidden size={30} strokeWidth={0} fill="currentColor" />
          </span>
          <span className={p.chip}>
            <span className="sr-only">Play the video: {video.title}, </span>
            {video.duration}
          </span>
        </button>
      )}
    </div>
  );
}
