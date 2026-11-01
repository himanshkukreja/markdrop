"use client";

/**
 * `::markdrop{src=…}`: a Markdrop file as a live block on a docs page (docs.markdrop.in, every
 * Markdrop Guides site, the studio's editor and preview). The rules are docs/embed.mjs; this is
 * the drawing and the behaviour.
 *
 * - Nothing loads until the block is near the screen: until then (and without JavaScript) it is a
 *   cover the size of the file's frame, with its title and an "Open on Markdrop" link.
 * - Then the API says what the file is now (GET /api/v1/embeds/{slug}), so a file replaced on
 *   Markdrop shows its new version here without a rebuild, and a file made private stops showing.
 * - Interactive HTML (a page or a zipped site) renders on the isolated artifact origin in an opaque
 *   sandbox (no same-origin, no storage, no top navigation; embed.mjs SANDBOX); a PDF in Markdrop's
 *   own viewer there; a video plays in the docs' own player (client/Player.tsx). Anything else (a
 *   spreadsheet, a Word file, an image, a Markdrop document) is a card that opens it on Markdrop.
 * - The text version (the author's summary, a PDF's text, a video's chapters and transcript) is
 *   under the block, server-rendered: what readers without JavaScript and screen readers get.
 * - Chrome: the kind, the title, size or length, a pinned version; Full screen (the element's
 *   fullscreen, or an expanded overlay where that isn't available, like iPhone Safari) and Open on
 *   Markdrop. The frame's height can be dragged (or set with the arrow keys on its handle), and a
 *   "Skip past" link lets a keyboard reader jump over a frame with many stops.
 * - Interactive pages wait for a click under prefers-reduced-motion (they may animate), and with
 *   `mode=preview` for everyone. Viewer frames follow the page's light/dark theme.
 * - Analytics (client/embedTrack.ts), only on published pages (`config.track`).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "@/components/ui";
import { cx } from "../cx";
import { FRAME_ALLOW, MAX_HEIGHT, MIN_HEIGHT, STATES, embedAttrs, embedView, frameHeight, kindOf, parseAspect, type EmbedResolve, type EmbedView } from "../embed.mjs";
import { VideoPlayer } from "./Player";
import { useEmbedAnalytics } from "./embedTrack";

export interface MarkdropEmbedConfig {
  /** The Markdrop API (no trailing slash). */
  api: string;
  /** The Markdrop app, for "Open on Markdrop" (https://markdrop.in). */
  app: string;
  /** The artifact origin frames must come from (null: whatever the API names, https only). */
  files: string | null;
  /** The docs site's id (version pins are per site) and name (the creator's "seen in"). */
  site: string;
  guide: string;
  /** Report views and plays (published pages only, never the studio). */
  track: boolean;
  /** The guide's Insights endpoint (site.json `insights`), when Insights is on. */
  insights?: string | null;
  /** App hosts a `src` may name besides markdrop.in (a local stack). */
  extraHosts?: string[];
}

export interface MarkdropEmbedProps {
  /** The directive's attributes as written (strings). */
  raw: Record<string, string | undefined>;
  label?: string;
  config: MarkdropEmbedConfig;
  /** Pin the theme (the studio's preview has its own); default: the page's. */
  theme?: "dark" | "light";
  className?: string;
  /** The block's stable id on its page (embed.mjs embedIds), for the guide's Insights. */
  eid?: string;
  /**
   * The text version's lines (embed.mjs embedTextLines, built on the server: the summary, a PDF's
   * text, a video's chapters and transcript). The first line (the link) is the chrome's own.
   */
  text?: string[];
}

/** The text version under the block: lists for "- " lines, a bold label for "Label: …" paragraphs. */
function TextVersion({ lines, open }: { lines: string[]; open?: boolean }) {
  const body = lines.slice(1).filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim()));
  if (!body.some((l) => l.trim())) return null;
  const blocks: Array<{ kind: "p" | "ul"; items: string[] }> = [];
  for (const l of body) {
    if (!l.trim()) continue;
    if (l.startsWith("- ")) {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "ul") last.items.push(l.slice(2));
      else blocks.push({ kind: "ul", items: [l.slice(2)] });
    } else blocks.push({ kind: "p", items: [l] });
  }
  return (
    <details className="dx-mde__text" open={open}>
      <summary>
        <Icon name="lines" />
        Text version
      </summary>
      <div className="dx-mde__textbody">
        {blocks.map((b, i) =>
          b.kind === "ul" ? (
            <ul key={i}>
              {b.items.map((t, j) => (
                <li key={j}>{t}</li>
              ))}
            </ul>
          ) : (
            <p key={i}>
              {(() => {
                const m = /^(Chapters|Contents|Transcript|Text):\s?(.*)$/.exec(b.items[0]);
                return m ? (
                  <>
                    <strong>{m[1]}</strong> {m[2]}
                  </>
                ) : (
                  b.items[0]
                );
              })()}
            </p>
          ),
        )}
      </div>
    </details>
  );
}

/* ── resolving ───────────────────────────────────────────────────────────── */

const cache = new Map<string, Promise<EmbedResolve>>();

function resolveKey(cfg: MarkdropEmbedConfig, slug: string, version: number | null) {
  return `${cfg.api}|${slug}|${cfg.site}|${version ?? ""}`;
}

async function fetchResolve(cfg: MarkdropEmbedConfig, slug: string, version: number | null): Promise<EmbedResolve> {
  const qs = new URLSearchParams();
  if (cfg.site) qs.set("site", cfg.site);
  if (version) qs.set("v", String(version));
  const ctl = new AbortController();
  const t = window.setTimeout(() => ctl.abort(), 12_000);
  try {
    const res = await fetch(`${cfg.api.replace(/\/+$/, "")}/api/v1/embeds/${encodeURIComponent(slug)}${qs.size ? `?${qs}` : ""}`, {
      credentials: "omit",
      signal: ctl.signal,
      headers: { Accept: "application/json" },
    });
    if (res.status === 404) return { state: "unavailable", slug };
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as EmbedResolve;
  } finally {
    window.clearTimeout(t);
  }
}

function resolveOnce(cfg: MarkdropEmbedConfig, slug: string, version: number | null): Promise<EmbedResolve> {
  const key = resolveKey(cfg, slug, version);
  let p = cache.get(key);
  if (!p) {
    p = fetchResolve(cfg, slug, version);
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}

/* ── the page's theme ────────────────────────────────────────────────────── */

function readTheme(el: Element | null): "dark" | "light" {
  const scoped = el?.closest("[data-theme]")?.getAttribute("data-theme");
  const t = scoped || document.documentElement.getAttribute("data-theme");
  if (t === "dark" || t === "light") return t;
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function usePageTheme(el: React.RefObject<HTMLElement | null>, pinned?: "dark" | "light"): "dark" | "light" | null {
  const [theme, setTheme] = useState<"dark" | "light" | null>(pinned ?? null);
  useEffect(() => {
    if (pinned) {
      setTheme(pinned);
      return;
    }
    const update = () => setTheme(readTheme(el.current));
    update();
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => mo.disconnect();
  }, [el, pinned]);
  return theme;
}

const REDUCE = "(prefers-reduced-motion: reduce)";

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
const fsElement = () => (document as FsDoc).fullscreenElement ?? (document as FsDoc).webkitFullscreenElement ?? null;

/* ── component ───────────────────────────────────────────────────────────── */

export function MarkdropEmbed({ raw, label, config, theme: pinnedTheme, className, eid, text }: MarkdropEmbedProps) {
  const attrs = useMemo(() => embedAttrs(raw, { label, extraHosts: config.extraHosts }), [raw, label, config.extraHosts]);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const figRef = useRef<HTMLElement>(null);
  const frameBoxRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const theme = usePageTheme(figRef, pinnedTheme);

  const [near, setNear] = useState(false);
  const [seen, setSeen] = useState(false);
  const onScreen = useRef(false);
  const [res, setRes] = useState<EmbedResolve | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [reduced, setReduced] = useState(false);
  const [started, setStarted] = useState(false);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [width, setWidth] = useState(0);
  const [userH, setUserH] = useState<number | null>(null);
  const [fs, setFs] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const isOnScreen = useCallback(() => onScreen.current, []);

  /* near the screen → resolve; on screen → "seen" (the view beacon) */
  useEffect(() => {
    const el = figRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      setSeen(true);
      onScreen.current = true;
      return;
    }
    const nearIo = new IntersectionObserver((e) => {
      if (e.some((x) => x.isIntersecting)) {
        setNear(true);
        nearIo.disconnect();
      }
    }, { rootMargin: "600px 0px" });
    const seenIo = new IntersectionObserver((e) => {
      const vis = e.some((x) => x.isIntersecting && x.intersectionRatio >= 0.25);
      onScreen.current = vis;
      if (vis) setSeen(true);
    }, { threshold: [0, 0.25, 0.5] });
    nearIo.observe(el);
    seenIo.observe(el);
    return () => {
      nearIo.disconnect();
      seenIo.disconnect();
    };
  }, []);

  useEffect(() => {
    const mq = window.matchMedia?.(REDUCE);
    if (!mq) return;
    const up = () => setReduced(mq.matches);
    up();
    mq.addEventListener?.("change", up);
    return () => mq.removeEventListener?.("change", up);
  }, []);

  useEffect(() => {
    if (!near || !attrs.slug) return;
    let live = true;
    setFailed(false);
    resolveOnce(config, attrs.slug, attrs.version)
      .then((r) => live && setRes(r))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [near, attrs.slug, attrs.version, config, attempt]);

  /* width, for an aspect-ratio frame */
  useEffect(() => {
    const el = frameBoxRef.current ?? figRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const view: EmbedView = useMemo(() => {
    if (failed) return { ...embedView(null, attrs), type: "state", state: "error" } as EmbedView;
    return embedView(res, attrs, { theme, artifactOrigin: config.files });
  }, [res, attrs, theme, config.files, failed]);

  const interactive = view.type === "frame" && (view.renderer === "html" || view.renderer === "bundle");
  const waitForClick = view.type === "frame" && (attrs.mode === "preview" || (interactive && reduced)) && !started;

  /* full screen: the element's, or an expanded overlay */
  useEffect(() => {
    const on = () => setFs(fsElement() === figRef.current);
    document.addEventListener("fullscreenchange", on);
    document.addEventListener("webkitfullscreenchange", on);
    return () => {
      document.removeEventListener("fullscreenchange", on);
      document.removeEventListener("webkitfullscreenchange", on);
    };
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [expanded]);

  /* ── analytics (published pages only; client/embedTrack.ts) ── */
  const trackCfg = useMemo(() => ({ api: config.api, site: config.site, guide: config.guide, insights: config.insights ?? null }), [config.api, config.site, config.guide, config.insights]);
  const slug = attrs.slug;
  const kind = view.type === "video" ? "video" : view.type === "frame" ? (view.renderer === "pdf" ? "pdf" : "other") : view.type === "card" ? "card" : null;
  const frameOrigin = view.type === "frame" ? new URL(view.src).origin : null;
  const analytics = useEmbedAnalytics({
    cfg: trackCfg,
    track: config.track,
    slug,
    eid: eid ?? slug,
    kind,
    version: res?.version ?? null,
    pinned: !!res?.pinned,
    seen,
    onScreen: isOnScreen,
    video,
    frame: iframeRef,
    frameOrigin,
    root: figRef,
    title: view.title || attrs.title || null,
  });

  const toggleFullscreen = useCallback(() => {
    const el = figRef.current as FsEl | null;
    if (!el) return;
    if (fsElement() === el) {
      const d = document as FsDoc;
      void (d.exitFullscreen ? d.exitFullscreen() : d.webkitExitFullscreen?.());
      return;
    }
    if (expanded) {
      setExpanded(false);
      return;
    }
    analytics.onFullscreen();
    const req = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
    if (!req) {
      setExpanded(true);
      return;
    }
    try {
      const p = req();
      if (p && typeof (p as Promise<void>).catch === "function") (p as Promise<void>).catch(() => setExpanded(true));
    } catch {
      setExpanded(true);
    }
  }, [expanded, analytics]);

  const onOpen = analytics.onOpen;

  /* ── frame height ── */
  const renderer = view.renderer ?? "html";
  const autoH = frameHeight(attrs, renderer, width);
  const h = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, userH ?? autoH));
  const big = fs || expanded;

  const drag = useRef<{ y: number; h: number } | null>(null);
  const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, h };
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setUserH(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(drag.current.h + e.clientY - drag.current.y))));
  };
  const onHandleUp = () => {
    drag.current = null;
  };
  const onHandleKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 160 : 40;
    let next: number | null = null;
    if (e.key === "ArrowDown") next = h + step;
    else if (e.key === "ArrowUp") next = h - step;
    else if (e.key === "Home") next = MIN_HEIGHT;
    else if (e.key === "End") next = MAX_HEIGHT;
    if (next === null) return;
    e.preventDefault();
    setUserH(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, next)));
  };

  /* ── drawing ── */
  const k = kindOf(view.renderer ?? "file");
  const title = view.title || attrs.title || (view.type === "state" ? STATES[view.state].title : "Markdrop file");
  const openUrl = view.open;
  const canExpand = view.type === "frame";
  const placeholderH = attrs.aspect && width ? frameHeight(attrs, "html", width) : attrs.height ?? (view.type === "loading" ? 420 : autoH);

  const chrome = (
    <figcaption className="dx-mde__bar">
      <span className="dx-mde__kind" aria-hidden>
        <Icon name={view.type === "state" ? (view.state === "private" || view.state === "password" || view.state === "signin" ? "lock" : "alert") : view.icon ?? k.icon} />
      </span>
      <span className="dx-mde__name">
        <span className="dx-mde__title">{view.type === "state" ? attrs.title || "Markdrop file" : title}</span>
        {(view.typeLabel || view.meta.length > 0) && (
          <span className="dx-mde__meta">
            {[view.typeLabel, ...view.meta].filter(Boolean).join(" · ")}
          </span>
        )}
      </span>
      <span className="dx-mde__actions">
        {canExpand && (
          <button type="button" className="dx-mde__btn" onClick={toggleFullscreen} aria-label={big ? "Exit full screen" : `Open ${title} full screen`} title={big ? "Exit full screen" : "Full screen"}>
            <Icon name={big ? "minimize" : "expand"} />
            <span className="dx-mde__btnlabel">{big ? "Exit full screen" : "Full screen"}</span>
          </button>
        )}
        {openUrl && (
          <a className="dx-mde__btn" href={openUrl} target="_blank" rel="noopener" onClick={onOpen} title="Open on Markdrop">
            <Icon name="external" />
            <span className="dx-mde__btnlabel">Open on Markdrop</span>
            <span className="dx-sr"> (opens in a new tab)</span>
          </a>
        )}
      </span>
    </figcaption>
  );

  let body: React.ReactNode;
  if (view.type === "loading") {
    body = (
      <div className="dx-mde__cover" style={{ height: placeholderH }} aria-busy={near || undefined}>
        <span className="dx-mde__coverkind" aria-hidden>
          <Icon name="layers" />
        </span>
        <span className="dx-mde__covertitle">{attrs.title || "Markdrop file"}</span>
        <span className="dx-mde__coverhint">{near ? "Loading…" : "Loads when you scroll here"}</span>
      </div>
    );
  } else if (view.type === "state") {
    const s = STATES[view.state];
    body = (
      <div className="dx-mde__state" role="status">
        <strong>{s.title}</strong>
        <span>{s.body}</span>
        {s.retry && (
          <button
            type="button"
            className="dx-mde__cta"
            onClick={() => {
              if (attrs.slug) cache.delete(resolveKey(config, attrs.slug, attrs.version));
              setFailed(false);
              setRes(null);
              setAttempt((n) => n + 1);
            }}
          >
            <Icon name="refresh" />
            Try again
          </button>
        )}
      </div>
    );
  } else if (view.type === "card") {
    body = (
      <div className="dx-mde__card">
        {view.excerpt && <p className="dx-mde__excerpt">{view.excerpt}</p>}
        {openUrl && (
          <a className="dx-mde__cta" href={openUrl} target="_blank" rel="noopener" onClick={onOpen}>
            {view.renderer === "doc" ? "Read on Markdrop" : view.typeLabel ? `Open the ${view.typeLabel} on Markdrop` : "Open on Markdrop"}
            <Icon name="arrowRight" />
          </a>
        )}
      </div>
    );
  } else if (view.type === "video") {
    body = (
      <div className="dx-mde__video">
        <VideoPlayer
          src={view.src}
          poster={view.poster ?? undefined}
          w={view.w ?? undefined}
          h={view.h ?? undefined}
          title={title}
          duration={view.duration ?? undefined}
          captionsSrc={attrs.captions ?? undefined}
          chaptersSrc={attrs.chapters ?? undefined}
          chapterList={!!attrs.chapters}
          onVideo={setVideo}
          videoId={config.track ? eid ?? slug ?? undefined : undefined}
        />
      </div>
    );
  } else {
    const aspectStyle: CSSProperties = big ? {} : { height: h };
    body = (
      <div ref={frameBoxRef} className={cx("dx-mde__frame", view.paper && "dx-mde__frame--paper")} style={aspectStyle}>
        {waitForClick ? (
          <div className="dx-mde__cover dx-mde__cover--start">
            <span className="dx-mde__coverkind" aria-hidden>
              <Icon name={k.icon} />
            </span>
            <span className="dx-mde__covertitle">{title}</span>
            <button type="button" className="dx-mde__cta" onClick={() => setStarted(true)}>
              <Icon name="play" />
              {interactive ? "Start interactive demo" : `Show ${(view.typeLabel || "file").toLowerCase()}`}
            </button>
            {reduced && interactive && attrs.mode !== "preview" && <span className="dx-mde__coverhint">Reduced motion is on, so it waits for you.</span>}
          </div>
        ) : (
          <>
            <a className="dx-mde__skip" href={`#mde-after-${uid}`}>
              Skip past {title}
            </a>
            <iframe
              ref={iframeRef}
              key={view.src}
              src={view.src}
              title={title}
              sandbox={view.sandbox}
              // No referrer: the artifact origin never needs to know which page framed it.
              referrerPolicy="no-referrer"
              allow={FRAME_ALLOW}
              loading="lazy"
              onLoad={() => setFrameLoaded(true)}
              style={{ colorScheme: view.paper ? "light" : theme ?? undefined }}
            />
            {!frameLoaded && (
              <div className="dx-mde__loading" aria-hidden>
                <span>Loading {(view.typeLabel || "file").toLowerCase()}…</span>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  const resizable = view.type === "frame" && !waitForClick && !big;
  const ratio = attrs.aspect ? parseAspect(attrs.aspect) : null;

  return (
    <>
      <figure
        ref={figRef}
        className={cx("dx-mde not-prose", `dx-mde--${view.type}`, big && "dx-mde--big", expanded && "dx-mde--expanded", className)}
        data-renderer={view.renderer}
        data-embed={eid ?? slug ?? undefined}
        data-state={view.type === "state" ? view.state : undefined}
        data-ratio={ratio ? ratio.toFixed(3) : undefined}
        role={expanded ? "dialog" : undefined}
        aria-modal={expanded || undefined}
        aria-label={expanded ? title : undefined}
      >
        {chrome}
        {body}
        {text && text.length > 1 && view.type !== "state" && <TextVersion lines={text} />}
        {resizable && (
          <div
            className="dx-mde__handle"
            role="separator"
            aria-orientation="horizontal"
            aria-label={`Resize ${title}`}
            aria-valuemin={MIN_HEIGHT}
            aria-valuemax={MAX_HEIGHT}
            aria-valuenow={h}
            aria-valuetext={`${h} pixels tall`}
            tabIndex={0}
            onPointerDown={onHandleDown}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onPointerCancel={onHandleUp}
            onKeyDown={onHandleKey}
            onDoubleClick={() => setUserH(null)}
            title="Drag to resize (double-click to reset)"
          >
            <span aria-hidden />
          </div>
        )}
      </figure>
      {view.type === "frame" && !waitForClick && <span id={`mde-after-${uid}`} tabIndex={-1} className="dx-mde__after" />}
    </>
  );
}
