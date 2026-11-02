"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/lib/theme";
import { sampleHref } from "@/lib/marketingFlags";
import { Icon } from "../ds";
import type { DeskFile } from "./samples";
import s from "./Desk.module.css";
import t from "./theme.module.css";

/** The document renderer (react-markdown, KaTeX, Mermaid on demand): its own chunk, loaded on drop. */
const MarkdownRender = dynamic(() => import("./MarkdownRender"), { ssr: false });

/**
 * A dropped file's link card: markdrop.in/<slug>, Copy and Open (once the sample is published from
 * Markdrop's account, marketingFlags), and the file's LIVE render.
 *
 * The body first shows a poster, a screenshot of that same render (public/landing-desk/posters), so
 * the card is never empty. The real renderer mounts when the visitor dropped something (`eager`), or,
 * for the phone layout's resting card, when the card scrolls into view; the poster fades out once
 * the render is ready. Frames are sandboxed like Markdrop's own embeds: sandbox="allow-scripts", no
 * allow-same-origin (the pages repeat it as a CSP header, next.config.ts).
 */
export default function LinkCard({
  file,
  initial,
  eager,
  focusKey,
  onClose,
}: {
  file: DeskFile;
  /** The phone layout's resting card (hidden on the desktop desk until a drop). */
  initial: boolean;
  eager: boolean;
  focusKey: number;
  onClose: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const [seen, setSeen] = useState(false);
  const [ready, setReady] = useState(false);
  const [copied, setCopied] = useState(false);
  const live = eager || seen;
  const href = sampleHref(file.slug);
  const url = `https://markdrop.in/${file.slug}`;

  useEffect(() => {
    if (eager || seen) return;
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setSeen(true), { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, [eager, seen]);

  // A keyboard drop moves focus to the card, so the next Tab reaches Copy and the render.
  useEffect(() => {
    if (focusKey) root.current?.focus();
  }, [focusKey]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard refused: the address is on the card */
    }
  };

  const posterBase = `/landing-desk/posters/${file.id}`;
  return (
    <section
      ref={root}
      className={`${s.card} ${initial ? "" : s.pop}`}
      data-slot={file.slot}
      data-initial={initial ? "" : undefined}
      tabIndex={-1}
      aria-label={`Link card: ${file.name} at markdrop.in/${file.slug}`}
    >
      <div className={s.cardBar}>
        <span className={s.cardIcon} aria-hidden="true">
          <Icon name="link" />
        </span>
        <span className={s.cardUrl}>
          {href ? (
            <a href={href} target="_blank" rel="noopener" data-cta={`card_open_${file.id}`}>
              markdrop.in/<b>{file.slug}</b>
            </a>
          ) : (
            <>
              markdrop.in/<b>{file.slug}</b>
            </>
          )}
        </span>
        {href && (
          <>
            <button type="button" className="md-btn md-btn--primary md-btn--sm" onClick={copy} data-cta={`card_copy_${file.id}`}>
              {copied ? "Copied" : "Copy"}
            </button>
            <a className={s.iconBtn} href={href} target="_blank" rel="noopener" aria-label={`Open markdrop.in/${file.slug} in a new tab`} data-cta={`card_open_${file.id}`}>
              <Icon name="external" />
            </a>
          </>
        )}
        {!initial && (
          <button type="button" className={s.iconBtn} onClick={onClose} aria-label="Put the card away">
            <Icon name="x" />
          </button>
        )}
      </div>
      <div className={s.cardBody}>
        <div className={s.poster} data-hidden={ready ? "" : undefined} aria-hidden={ready || undefined}>
          <img className={`${s.posterImg} ${file.posterDark ? t.light : ""}`} src={`${posterBase}.webp`} alt={`${file.name}, rendered by Markdrop`} width={838} height={662} decoding="async" loading={initial ? "lazy" : "eager"} />
          {file.posterDark && <img className={`${s.posterImg} ${t.dark}`} src={`${posterBase}.dark.webp`} alt={`${file.name}, rendered by Markdrop`} width={838} height={662} decoding="async" loading="lazy" />}
        </div>
        {live && (
          <div className={s.live} data-ready={ready ? "" : undefined}>
            {file.render === "markdown" ? <MarkdownRender onReady={() => setReady(true)} /> : <FrameRender file={file} onReady={() => setReady(true)} />}
          </div>
        )}
      </div>
      <div className={s.cardFoot}>
        <span>{file.note}</span>
        {live && !ready && (
          <span className={s.loading} role="status">
            Loading the live render…
          </span>
        )}
      </div>
    </section>
  );
}

/** A real viewer page in a sandboxed frame, scaled down when it is laid out wider than the card. */
function FrameRender({ file, onReady }: { file: DeskFile; onReady: () => void }) {
  const { resolved } = useTheme();
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const theme = resolved === "dark" ? "dark" : "light";
  const src = (file.frame ?? "").replace("{theme}", theme);
  const doneRef = useRef(false);
  const done = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onReady();
  };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The PDF viewer says when the document is laid out (its analytics bridge: {md:1, ev:"pdf"}).
  useEffect(() => {
    if (file.id !== "pdf") return;
    const on = (e: MessageEvent) => {
      if (e.source === frame.current?.contentWindow && e.data && e.data.md === 1 && e.data.ev === "pdf") window.setTimeout(done, 400);
    };
    window.addEventListener("message", on);
    const t = window.setTimeout(done, 6000);
    return () => {
      window.removeEventListener("message", on);
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  // A desktop page in the desktop card is laid out at its desktop width and scaled to fit; on a
  // phone it gets the phone's width and its own small-screen layout, as it would on markdrop.in.
  const fit = !!file.frameWidth && !!size && size.w >= 480;
  const scale = fit ? size.w / file.frameWidth! : 1;
  const style = fit ? { width: file.frameWidth, height: size.h / scale, transform: `scale(${scale})` } : undefined;
  return (
    <div ref={box} style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {size && (
        <iframe
          ref={frame}
          key={src}
          src={src}
          title={`${file.name}, rendered by Markdrop`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className={`${s.frame} ${fit ? s.scaled : ""}`}
          style={style}
          onLoad={() => {
            if (file.id !== "pdf") window.setTimeout(done, file.id === "sheet" ? 700 : 150);
          }}
        />
      )}
    </div>
  );
}
