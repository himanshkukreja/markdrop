"use client";

/**
 * The top of a card in the listing's Cards view: a preview of the item (feat/card-previews).
 *
 *   Pages        the cover, the icon, the title and the first blocks, on a sheet
 *   Markdown     the start of the document, rendered small
 *   HTML files   their opening text on white paper; on hover (a mouse, a few at a time) the real
 *                page, live, in a sandboxed frame on the artifact origin, scaled down
 *   PDFs         the first page;  images: the image;  videos: the poster frame
 *   Sheets       the first cells;  text files: the first lines;  Word files: the first paragraphs
 *
 * Everything shown is text from the API rendered by React (escaped), or a WebP data: URI; nothing
 * the item contains is ever rendered as HTML in this origin. End-to-end encrypted items show a lock
 * without asking the server; anything the server answers "locked" shows a lock too. Until a preview
 * arrives (or when there is none: audio, a zip) the card keeps its icon band, at the same height,
 * so nothing moves. Previews are asked for only while the card is on screen (lib/cardPreviews.ts).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, cx } from "@/components/ui";
import type { WorkspaceItem } from "@/lib/workspaces";
import {
  dropLive, isDataImage, isFresh, liveAllowed, promoteLive, refreshPreview, safeLiveUrl, useCardPreview, useInView, useLive,
  type CardPreview, type PreviewBlock,
} from "@/lib/cardPreviews";

const LIVE_WIDTH = 1280;
const HOVER_MS = 320;
const GALLERY = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const liveKey = (workspaceId: string, slug: string) => `${workspaceId}:${slug}`;

/** Hover (or keyboard focus) on a card for a moment makes its HTML preview live. For the card's <li>. */
export function useLiveHover(workspaceId: string, it: WorkspaceItem) {
  const timer = useRef<number | null>(null);
  const key = liveKey(workspaceId, it.slug);
  const eligible = it.kind === "artifact" && (it.renderer === "html" || it.renderer === "bundle") && !it.encrypted;
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
    dropLive(key);
  }, [key]);
  if (!eligible) return {};
  const start = () => {
    if (timer.current || !liveAllowed()) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (!isFresh(workspaceId, it.slug)) refreshPreview(workspaceId, it.slug);
      promoteLive(key);
    }, HOVER_MS);
  };
  const stop = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };
  return { onPointerEnter: start, onPointerLeave: stop, onFocus: start, onBlur: stop };
}

function Blocks({ blocks }: { blocks: PreviewBlock[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case "h1":
          case "h2":
          case "h3":
            return <span key={i} className={`wl-pv__${b.t}`} dir="auto">{b.x}</span>;
          case "p":
            return <span key={i} className="wl-pv__p" dir="auto">{b.x}</span>;
          case "quote":
            return <span key={i} className="wl-pv__quote" dir="auto">{b.x}</span>;
          case "li":
            return (
              <span key={i} className="wl-pv__li" style={b.d ? { paddingInlineStart: `${b.d * 10}px` } : undefined} dir="auto">
                <span aria-hidden className="wl-pv__bullet">{b.n != null ? `${b.n}.` : "•"}</span>
                <span className="min-w-0">{b.x}</span>
              </span>
            );
          case "todo":
            return (
              <span key={i} className={cx("wl-pv__li", b.done && "wl-pv__done")} style={b.d ? { paddingInlineStart: `${b.d * 10}px` } : undefined} dir="auto">
                <span aria-hidden className={cx("wl-pv__box", b.done && "wl-pv__box--on")}>{b.done && <Icon name="check" size={7} />}</span>
                <span className="min-w-0">{b.x}</span>
              </span>
            );
          case "code":
            return <span key={i} className="wl-pv__code" dir="ltr">{b.x}</span>;
          case "hr":
            return <span key={i} className="wl-pv__hr" aria-hidden />;
          case "img":
            return (
              <span key={i} className="wl-pv__media" aria-hidden>
                <Icon name={b.kind === "diagram" ? "listTree" : b.kind === "math" ? "sigma" : "image"} size={12} />
              </span>
            );
          case "table":
            return (
              <span key={i} className="wl-pv__table" style={{ gridTemplateColumns: `repeat(${Math.max(1, b.rows[0]?.length ?? 1)}, minmax(0, 1fr))` }}>
                {b.rows.flatMap((r, ri) => r.map((c, ci) => <span key={`${ri}-${ci}`} className={cx(ri === 0 && "wl-pv__th")} dir="auto">{c}</span>))}
              </span>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

function Sheet({ rows }: { rows: string[][] }) {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  return (
    <span className="wl-pv__paper wl-pv__paper--sheet">
      <span className="wl-pv__sheet" style={{ gridTemplateColumns: `18px repeat(${cols}, minmax(0, 1fr))` }}>
        <span className="wl-pv__sh" />
        {Array.from({ length: cols }, (_, c) => <span key={`h${c}`} className="wl-pv__sh">{String.fromCharCode(65 + c)}</span>)}
        {rows.map((r, ri) => [
          <span key={`n${ri}`} className="wl-pv__sh">{ri + 1}</span>,
          ...Array.from({ length: cols }, (_, c) => (
            <span key={`${ri}-${c}`} className={cx("wl-pv__cell", ri === 0 && "wl-pv__th", /^-?[\d.,%$€£]+$/.test(r[c] ?? "") && "wl-pv__num")} dir="auto">{r[c] ?? ""}</span>
          )),
        ])}
      </span>
    </span>
  );
}

function Lines({ lines }: { lines: string[] }) {
  return (
    <span className="wl-pv__paper wl-pv__paper--text">
      {lines.map((l, i) => (
        <span key={i} className="wl-pv__line"><span aria-hidden className="wl-pv__ln">{i + 1}</span><span dir="ltr">{l || " "}</span></span>
      ))}
    </span>
  );
}

function Cover({ cover }: { cover: NonNullable<CardPreview["cover"]> }) {
  const y = Math.min(100, Math.max(0, Number(cover.y ?? 50)));
  let src: string | null = null;
  if (isDataImage(cover.src)) src = cover.src;
  else if (cover.gallery && GALLERY.test(cover.gallery)) src = `/page-covers/${cover.gallery}.webp`;
  else if (cover.url && /^https:\/\//.test(cover.url)) src = cover.url;
  if (!src) return <span className="wl-pv__cover wl-pv__cover--empty" aria-hidden />;
  // A built-in cover, a thumbnail or the page's own https cover (as its page shows it).
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="wl-pv__cover" src={src} alt="" aria-hidden loading="lazy" decoding="async" referrerPolicy="no-referrer" style={{ objectPosition: `50% ${y}%` }} />;
}

/** The live render: the HTML file's own URL in a sandboxed frame on the artifact origin, laid out
 *  at desktop width and scaled to the card. No pointer events, out of the tab order. */
function LiveFrame({ url, onReady }: { url: string; onReady: () => void }) {
  const box = useRef<HTMLSpanElement>(null);
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(el.clientWidth / LIVE_WIDTH);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <span ref={box} className="wl-pv__live" aria-hidden>
      {scale > 0 && (
        <iframe
          src={url}
          title=""
          tabIndex={-1}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          loading="lazy"
          onLoad={onReady}
          style={{ width: LIVE_WIDTH, height: Math.ceil((box.current?.clientHeight ?? 150) / scale), transform: `scale(${scale})` }}
        />
      )}
    </span>
  );
}

function Lock({ words }: { words: string }) {
  return (
    <span className="wl-pv wl-pv--lock">
      <span className="wl-pv__lockdisc" aria-hidden><Icon name="lock" size={16} /></span>
      <span className="wl-pv__lockwords">{words}</span>
    </span>
  );
}

function duration(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

function Body({ p, title }: { p: CardPreview; title: string }) {
  const blocks = p.blocks ?? [];
  switch (p.type) {
    case "image":
      return isDataImage(p.src) ? (
        // eslint-disable-next-line @next/next/no-img-element
        <span className="wl-pv wl-pv--image"><img src={p.src} alt="" aria-hidden decoding="async" /></span>
      ) : null;
    case "video":
      return isDataImage(p.src) ? (
        <span className="wl-pv wl-pv--video">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={p.src} alt="" aria-hidden decoding="async" />
          <span className="wl-pv__chip"><Icon name="play" size={10} />{p.duration ? duration(p.duration) : "Video"}</span>
        </span>
      ) : null;
    case "pdf":
      if (isDataImage(p.src)) {
        return (
          <span className="wl-pv">
            <span className="wl-pv__paper wl-pv__paper--light wl-pv__paper--page">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.src} alt="" aria-hidden decoding="async" />
            </span>
            {p.pages && p.pages > 1 ? <span className="wl-pv__chip">{p.pages} pages</span> : null}
          </span>
        );
      }
      return blocks.length ? <span className="wl-pv"><span className="wl-pv__paper wl-pv__paper--light"><Blocks blocks={blocks} /></span></span> : null;
    case "sheet":
      return p.rows?.length ? <span className="wl-pv"><Sheet rows={p.rows} /></span> : null;
    case "text":
      return p.lines?.length ? <span className="wl-pv"><Lines lines={p.lines} /></span> : null;
    case "html":
    case "bundle":
    case "docx":
      return blocks.length ? (
        <span className="wl-pv"><span className={cx("wl-pv__paper wl-pv__paper--light", p.type === "docx" && "wl-pv__paper--word")}><Blocks blocks={blocks} /></span></span>
      ) : null;
    case "page":
      if (!blocks.length && !p.cover && !p.icon) return null;
      return (
        <span className="wl-pv">
          <span className={cx("wl-pv__paper", p.cover && "wl-pv__paper--cover")}>
            {p.cover && <Cover cover={p.cover} />}
            {p.icon && <span className="wl-pv__icon" aria-hidden>{p.icon}</span>}
            <span className="wl-pv__h1 wl-pv__title" dir="auto">{title}</span>
            <Blocks blocks={blocks} />
          </span>
        </span>
      );
    case "markdown":
      return blocks.length ? <span className="wl-pv"><span className="wl-pv__paper"><Blocks blocks={blocks} /></span></span> : null;
    default:
      return null;
  }
}

/**
 * The card's band: its preview, or (until one arrives, or when there is none) the item's icon on
 * its kind's tint. `fallback` is that icon; `kind` the kind label shown on the band either way.
 */
export function PreviewBand({ workspaceId, it, title, tint, fallback, kind }: {
  workspaceId: string; it: WorkspaceItem; title: string; tint: string; fallback: ReactNode; kind: string;
}) {
  const [ref, onScreen] = useInView<HTMLSpanElement>();
  const p = useCardPreview(workspaceId, it.slug, it.updated_at, onScreen && !it.encrypted);
  const live = useLive(liveKey(workspaceId, it.slug));
  const liveUrl = live ? safeLiveUrl(p?.live) : null;
  const [ready, setReady] = useState<string | null>(null);

  let body: ReactNode = null;
  let variant = "icon";
  if (it.encrypted || p?.state === "encrypted") {
    body = <Lock words="End-to-end encrypted" />;
    variant = "lock";
  } else if (p?.state === "locked") {
    body = <Lock words="No preview" />;
    variant = "lock";
  } else if (p && (p.state === "ok" || p.state === "pending")) {
    body = <Body p={p} title={title} />;
    if (body) variant = p.type || "doc";
  }
  return (
    <span
      ref={ref}
      className="wl-card__band"
      data-pv={variant}
      data-live={liveUrl && ready === liveUrl ? "true" : undefined}
      style={{ "--tint": tint } as React.CSSProperties}
    >
      {/* The preview repeats the item's own content: hidden from screen readers (the card's link names it). */}
      {body ? <span aria-hidden className="contents">{body}</span> : fallback}
      {liveUrl && <LiveFrame key={liveUrl} url={liveUrl} onReady={() => setReady(liveUrl)} />}
      {liveUrl && ready === liveUrl && <span className="wl-pv__livechip" aria-hidden><span className="wl-pv__dot" />Live</span>}
      <span className="wl-card__kind">{kind}</span>
    </span>
  );
}
