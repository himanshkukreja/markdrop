"use client";

import { useEffect, useRef, useState } from "react";
import s from "./LoopVideo.module.css";

/**
 * A short, silent, looping product clip (the landing page's "GIFs"), recorded from the real studio.
 *
 * The server HTML is the poster (a plain <img>, light and dark twins switched by the site theme) in a
 * box with a fixed aspect ratio, so nothing shifts when the video arrives. The <video> gets its
 * sources only when it is near the viewport (and, for the hero, after the page has loaded), plays
 * muted and inline, pauses when it scrolls away, and fades in over the poster once it is playing.
 *
 * prefers-reduced-motion: nothing plays on its own; the poster shows with a play button. Every clip
 * has a pause/play button (keyboard reachable), and a text alternative in `label`.
 *
 * Files: `${src}.mp4` (H.264) + `${src}.webm` (VP9) + `${src}.webp` (poster), and with `dark` the
 * same with `.dark` before the extension.
 */
export interface LoopProps {
  /** Path without extension, e.g. "/guides-landing/hero-fix". */
  src: string;
  /** Intrinsic size of the files (for the aspect ratio and the poster's width/height). */
  w: number;
  h: number;
  /** What the clip shows, for screen readers (the poster's alt text too). */
  label: string;
  /** Has dark-theme twins (`.dark.mp4`…). */
  dark?: boolean;
  /** The hero's clip: the poster is the page's LCP image (eager, high priority). */
  priority?: boolean;
  className?: string;
}

const PLAY = "M8 5.14v13.72a1 1 0 0 0 1.52.85l10.9-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14z";
const PAUSE = "M7 4h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm8 0h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z";

function isDark(): boolean {
  return document.documentElement.getAttribute("data-theme") === "dark";
}

/** The page has finished loading (the hero waits for it, so its clip never competes with the LCP). */
function afterLoad(fn: () => void): () => void {
  if (document.readyState === "complete") {
    const t = window.setTimeout(fn, 150);
    return () => window.clearTimeout(t);
  }
  const on = () => window.setTimeout(fn, 150);
  window.addEventListener("load", on, { once: true });
  return () => window.removeEventListener("load", on);
}

export default function LoopVideo({ src, w, h, label, dark, priority, className }: LoopProps) {
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  // "auto": plays while on screen; "paused": the visitor paused it (or reduced motion and not started).
  const [mode, setMode] = useState<"auto" | "paused">("auto");
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(!priority);
  const [visible, setVisible] = useState(false);
  const [variant, setVariant] = useState<"" | ".dark">("");
  const [loaded, setLoaded] = useState(false);

  // Reduced motion: start paused (poster + play button).
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches) setMode("paused");
    const on = (e: MediaQueryListEvent) => e.matches && setMode("paused");
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);

  // The hero's clip waits for the page's load event.
  useEffect(() => (priority ? afterLoad(() => setReady(true)) : undefined), [priority]);

  // Near the viewport?
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: "200px 0px", threshold: 0.01 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Which theme's file (and follow theme switches).
  useEffect(() => {
    if (!dark) return;
    const pick = () => setVariant(isDark() ? ".dark" : "");
    pick();
    const mo = new MutationObserver(pick);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, [dark]);

  // Load once it's wanted: visible, ready, and either playing on its own or asked to.
  const want = ready && visible && mode === "auto";
  useEffect(() => {
    if (want) setLoaded(true);
  }, [want]);

  // A theme switch remounts the <video> (key): it starts again from the new files.
  useEffect(() => setPlaying(false), [variant]);

  // Play while visible; pause otherwise. (Inserting the <source>s starts the load by itself.)
  useEffect(() => {
    const v = video.current;
    if (!v || !loaded) return;
    if (want) void v.play().catch(() => setPlaying(false));
    else v.pause();
  }, [want, loaded, variant]);

  const toggle = () => {
    const v = video.current;
    if (mode === "auto") {
      setMode("paused");
      v?.pause();
    } else {
      setMode("auto");
      setReady(true);
      setLoaded(true);
    }
  };

  const base = `${src}${variant}`;
  return (
    <div ref={box} className={`${s.loop} ${className ?? ""}`} style={{ aspectRatio: `${w} / ${h}` }} data-playing={playing || undefined}>
      <img
        className={`${s.poster} ${dark ? s.light : ""}`}
        src={`${src}.webp`}
        alt={label}
        width={w}
        height={h}
        decoding="async"
        loading={priority ? "eager" : "lazy"}
        {...(priority ? { fetchPriority: "high" as const } : {})}
      />
      {dark && <img className={`${s.poster} ${s.dark}`} src={`${src}.dark.webp`} alt={label} width={w} height={h} decoding="async" loading="lazy" />}
      <video
        key={variant}
        ref={video}
        className={s.video}
        muted
        loop
        playsInline
        preload="none"
        aria-hidden="true"
        tabIndex={-1}
        width={w}
        height={h}
        onPlaying={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      >
        {loaded && <source src={`${base}.webm`} type="video/webm" />}
        {loaded && <source src={`${base}.mp4`} type="video/mp4" />}
      </video>
      <button
        type="button"
        className={s.btn}
        data-paused={mode === "paused" || undefined}
        onClick={toggle}
        aria-label={mode === "auto" ? "Pause the animation" : "Play the animation"}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" width="14" height="14" fill="currentColor"><path d={mode === "auto" ? PAUSE : PLAY} /></svg>
      </button>
    </div>
  );
}
