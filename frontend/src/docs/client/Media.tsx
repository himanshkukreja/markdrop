"use client";

/**
 * Media islands for the docs: looping clips, the feature-video player and the image lightbox.
 * Figures themselves are server HTML (render/DocsMarkdown.tsx); light/dark variants are both in the
 * page and CSS shows the one matching <html data-theme> (`.dx-themed-light` / `.dx-themed-dark`),
 * so there is no flash and no script involved in picking one.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Icon } from "@/components/ui";
import { cx } from "../cx";

/* ── Clip ────────────────────────────────────────────────────────────────── */

export interface ClipFiles {
  webm?: string;
  mp4?: string;
  poster?: string;
}

const REDUCE = "(prefers-reduced-motion: reduce)";

/**
 * A short silent loop (`::clip`). It plays only while at least half of it is on screen and the
 * reader hasn't asked for reduced motion; with reduced motion it shows its poster and a Play
 * button. The pause/play button is always there (WCAG 2.2.2). With a dark variant both videos are
 * in the page; the hidden one never intersects, so only the visible one ever loads or plays.
 */
export function ClipPlayer({ light, dark, w, h, cssW, alt, caption }: { light: ClipFiles; dark?: ClipFiles; w?: number; h?: number; cssW?: number; alt: string; caption?: string }) {
  const refs = useRef<Array<HTMLVideoElement | null>>([]);
  const inView = useRef(new Map<HTMLVideoElement, boolean>());
  /** null until mounted (no reduced-motion answer on the server); then the reader's intent. */
  const [wanted, setWanted] = useState<boolean | null>(null);
  const chosen = useRef(false);

  const sync = useCallback((want: boolean | null) => {
    for (const v of refs.current) {
      if (!v) continue;
      if (want && inView.current.get(v)) {
        v.muted = true;
        v.play().catch(() => {});
      } else if (!v.paused) v.pause();
    }
  }, []);

  useEffect(() => {
    const mq = window.matchMedia?.(REDUCE);
    setWanted(!mq?.matches);
    const onChange = () => {
      if (!chosen.current) setWanted(!mq.matches);
    };
    mq?.addEventListener?.("change", onChange);
    return () => mq?.removeEventListener?.("change", onChange);
  }, []);

  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;
  useEffect(() => sync(wanted), [wanted, sync]);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) inView.current.set(e.target as HTMLVideoElement, e.isIntersecting && e.intersectionRatio >= 0.5);
        sync(wantedRef.current);
      },
      { threshold: [0, 0.5, 1] },
    );
    for (const v of refs.current) if (v) io.observe(v);
    return () => io.disconnect();
  }, [sync]);

  const toggle = () => {
    chosen.current = true;
    setWanted((w0) => !w0);
  };

  const variants: Array<[ClipFiles, string | undefined]> = dark ? [[light, "dx-themed-light"], [dark, "dx-themed-dark"]] : [[light, undefined]];
  const style = { "--dx-w": cssW ? `${cssW}px` : undefined, aspectRatio: w && h ? `${w} / ${h}` : undefined } as CSSProperties;
  return (
    <figure className="dx-clip not-prose">
      <div className="dx-clip__frame" style={style}>
        {variants.map(([f, cls], i) => (
          <video
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            className={cx("dx-clip__video", cls)}
            muted
            loop
            playsInline
            preload="none"
            poster={f.poster}
            width={w}
            height={h}
            aria-label={alt}
            disablePictureInPicture
          >
            {f.webm && <source src={f.webm} type="video/webm" />}
            {f.mp4 && <source src={f.mp4} type="video/mp4" />}
          </video>
        ))}
        {wanted === false && (
          <button type="button" className="dx-clip__big" onClick={toggle} aria-label={`Play: ${alt}`}>
            <Icon name="play" />
          </button>
        )}
        <button type="button" className="dx-clip__toggle" onClick={toggle} aria-label={wanted ? `Pause: ${alt}` : `Play: ${alt}`} title={wanted ? "Pause" : "Play"}>
          <Icon name={wanted ? "pause" : "play"} />
        </button>
      </div>
      {caption && <figcaption className="dx-fig__cap">{caption}</figcaption>}
    </figure>
  );
}

/* ── Feature video ───────────────────────────────────────────────────────── */

export interface Chapter {
  start: number;
  text: string;
}

function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * A `::video` slot filled from videos.json: the poster with a big Play button and the length, then
 * the native player (controls, chapters and captions tracks). Chapters are also listed under it.
 */
export function VideoPlayer({ src, poster, w, h, title, duration, chapters, chaptersSrc, captionsSrc }: { src: string; poster?: string; w?: number; h?: number; title: string; duration?: string; chapters: Chapter[]; chaptersSrc?: string; captionsSrc?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);
  const [current, setCurrent] = useState(-1);

  const start = (at?: number) => {
    const v = ref.current;
    if (!v) return;
    setStarted(true);
    if (at !== undefined) v.currentTime = at;
    v.play().catch(() => {});
    v.focus({ preventScroll: true });
  };

  useEffect(() => {
    const v = ref.current;
    if (!v || !chapters.length) return;
    const onTime = () => {
      let i = -1;
      chapters.forEach((c, k) => {
        if (v.currentTime >= c.start) i = k;
      });
      setCurrent(i);
    };
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [chapters]);

  return (
    <figure className="dx-video dx-player not-prose">
      <div className={cx("dx-video__frame dx-player__frame", started && "is-started")} style={w && h ? { aspectRatio: `${w} / ${h}` } : undefined}>
        <video ref={ref} controls={started} preload="none" playsInline poster={poster} width={w} height={h} aria-label={title} onPlay={() => setStarted(true)}>
          <source src={src} type="video/mp4" />
          {chaptersSrc && <track kind="chapters" src={chaptersSrc} srcLang="en" label="Chapters" default />}
          {captionsSrc && <track kind="captions" src={captionsSrc} srcLang="en" label="English" />}
        </video>
        {!started && (
          <button type="button" className="dx-player__start" onClick={() => start()} aria-label={`Play video: ${title}${duration ? ` (${duration})` : ""}`}>
            <span className="dx-video__play" aria-hidden>
              <Icon name="play" />
            </span>
          </button>
        )}
        {!started && duration && <span className="dx-video__chip">{duration}</span>}
      </div>
      <figcaption className="dx-video__cap">
        <span className="dx-video__title">{title}</span>
        {duration && <span className="dx-video__len">{duration}</span>}
      </figcaption>
      {chapters.length > 0 && (
        <ol className="dx-chapters" aria-label="Chapters">
          {chapters.map((c, i) => (
            <li key={i}>
              <button type="button" className="dx-chapters__item" aria-current={i === current ? "true" : undefined} onClick={() => start(c.start)}>
                <span className="dx-chapters__t">{clock(c.start)}</span>
                <span>{c.text}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </figure>
  );
}

/* ── Lightbox ────────────────────────────────────────────────────────────── */

interface Shot {
  src: string;
  dark?: string;
  alt: string;
  caption?: string;
  w?: number;
  h?: number;
}

/**
 * One modal for every figure on the page (mounted once by the docs layout): any
 * `[data-dx-zoom]` button opens it with that figure's image, both theme variants included. A
 * native <dialog>: Esc closes, the page behind is inert, focus goes back to the figure. The image
 * fits the screen; "Actual size" (or clicking the image) shows it at full resolution in a
 * scrollable stage, and pinch-zoom is left to the browser.
 */
export function MediaLightbox() {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const [shot, setShot] = useState<Shot | null>(null);
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    const onClick = (ev: MouseEvent) => {
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      const btn = (ev.target as Element | null)?.closest?.<HTMLElement>("[data-dx-zoom]");
      if (!btn) return;
      ev.preventDefault();
      const d = btn.dataset;
      opener.current = btn;
      setZoomed(false);
      setShot({ src: d.src ?? "", dark: d.dark || undefined, alt: d.alt ?? "", caption: d.caption || undefined, w: d.w ? +d.w : undefined, h: d.h ? +d.h : undefined });
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  useEffect(() => {
    const d = dialog.current;
    if (!shot || !d || d.open) return;
    d.showModal();
    closeBtn.current?.focus();
    document.documentElement.classList.add("dx-modal-open");
  }, [shot]);

  const close = () => dialog.current?.close();
  const onClose = () => {
    document.documentElement.classList.remove("dx-modal-open");
    setShot(null);
    const o = opener.current;
    opener.current = null;
    if (o?.isConnected) o.focus({ preventScroll: true });
  };

  const imgs = shot ? (shot.dark ? [[shot.src, "dx-themed-light"], [shot.dark, "dx-themed-dark"]] : [[shot.src, undefined]]) : [];
  return (
    <dialog
      ref={dialog}
      className={cx("dx-lightbox", zoomed && "is-zoomed")}
      aria-label={shot ? `Image: ${shot.alt}` : "Image"}
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop or the empty stage closes; on the image it zooms.
        const t = e.target as HTMLElement;
        if (t === e.currentTarget || t.classList.contains("dx-lightbox__stage")) close();
      }}
    >
      {shot && (
        <>
          <div className="dx-lightbox__bar">
            <span className="dx-lightbox__title">{shot.caption || shot.alt}</span>
            <button type="button" className="dx-lightbox__btn" onClick={() => setZoomed((z) => !z)} aria-pressed={zoomed} title={zoomed ? "Fit to screen" : "Actual size"}>
              <Icon name={zoomed ? "zoomOut" : "zoomIn"} />
              <span className="dx-lightbox__btnlabel">{zoomed ? "Fit" : "Actual size"}</span>
            </button>
            <button type="button" className="dx-lightbox__btn" onClick={close} aria-label="Close" title="Close (Esc)" ref={closeBtn}>
              <Icon name="x" />
            </button>
          </div>
          <div className="dx-lightbox__stage">
            {imgs.map(([src, cls]) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={src}
                src={src}
                alt={shot.alt}
                width={shot.w}
                height={shot.h}
                className={cx("dx-lightbox__img", cls)}
                style={zoomed && shot.w ? { width: shot.w, maxWidth: "none", maxHeight: "none" } : undefined}
                onClick={() => setZoomed((z) => !z)}
                decoding="async"
              />
            ))}
          </div>
        </>
      )}
    </dialog>
  );
}
