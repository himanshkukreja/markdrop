"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { track } from "@/lib/track";
import { sampleHref } from "@/lib/marketingFlags";
import { Icon, MarkdropMark } from "../ds";
import FrameRender from "./FrameRender";
import { fileById, type DeskFile, type FileId } from "./samples";
import s from "./Hero.module.css";
import t from "./theme.module.css";

/** The document renderer (react-markdown, KaTeX, Mermaid on demand): its own chunk, loaded on drop. */
const MarkdownRender = dynamic(() => import("./MarkdownRender"), { ssr: false });

type Pos = CSSProperties & Record<`--${string}`, string>;

const HINT = "Drop it on the Markdrop mark to see it on the laptop";

/**
 * The hero desk (design canvas round 4, Hero C): a laptop whose screen shows whatever you drop, the
 * phone with deck.pdf, a paper note with notes.md, the tray with demo.mp4 and budget.xlsx, and the
 * Markdrop mark. Drag a file onto the mark (mouse or pen), or click / tap it, or press Enter or Space
 * on it: the mark squashes and splashes, and the laptop shows that file at markdrop.in/<slug>, as a
 * poster (a capture of the same render) until the real renderer is ready: MarkdownPreview for the
 * Markdown, Markdrop's own PDF / spreadsheet / video viewers and the HTML page in sandboxed frames.
 * One aria-live region says what happened. Touch never drags (the phone's row scrolls sideways).
 *
 * Server-rendered at rest (launch.html on the screen, as its poster: the hero's LCP image), so
 * nothing shifts when it hydrates.
 */
export default function HeroDesk() {
  const [current, setCurrent] = useState<FileId>("html");
  const [dropped, setDropped] = useState(false);
  const [n, setN] = useState(0);
  const [eating, setEating] = useState(false);
  const [over, setOver] = useState(false);
  const [say, setSay] = useState("");
  const [focusScreen, setFocusScreen] = useState(0);

  const mat = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const els = useRef<Map<string, HTMLElement>>(new Map());
  const drag = useRef<{ id: FileId; el: HTMLElement; x: number; y: number; dx: number; dy: number; k: number; on: boolean; pointer: number; base: string } | null>(null);
  const swallowClick = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (focusScreen) screenRef.current?.focus();
  }, [focusScreen]);

  const overMark = (cx: number, cy: number) => {
    const r = markRef.current?.getBoundingClientRect();
    if (!r) return false;
    const pad = 24;
    return cx >= r.left - pad && cx <= r.right + pad && cy >= r.top - pad && cy <= r.bottom + pad;
  };

  /** The file goes into the mark: squash, splash, and the laptop shows it. */
  const drop = useCallback((id: FileId, via: "drag" | "click" | "key") => {
    const f = fileById(id);
    window.clearTimeout(timer.current);
    setOver(false);
    setCurrent(id);
    setDropped(true);
    setN((k) => k + 1);
    setEating(true);
    setSay(`${f.name} dropped. It opens at markdrop.in/${f.slug}, rendered on the laptop.`);
    track("landing_drop", { file: id, via });
    if (via === "key") setFocusScreen((k) => k + 1);
    timer.current = window.setTimeout(() => setEating(false), 900);
  }, []);

  /** On-screen scale of the desk (from 1024px the hero is drawn at 1280 and zoomed; 1 on phones). */
  const scale = () => {
    const m = mat.current;
    if (!m || !m.offsetWidth) return 1;
    return m.getBoundingClientRect().width / m.offsetWidth || 1;
  };

  /** A click or key drop: a paper ghost flies from the file into the mark. */
  const fly = (from: HTMLElement) => {
    const g = ghost.current;
    const m = markRef.current;
    const root = mat.current;
    if (!g || !m || !root || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const k = scale();
    const R = root.getBoundingClientRect();
    const a = from.getBoundingClientRect();
    const b = m.getBoundingClientRect();
    const p = [(a.left + a.width / 2 - R.left) / k, (a.top + a.height / 2 - R.top) / k];
    const q = [(b.left + b.width / 2 - R.left) / k, (b.top + b.height / 2 - R.top) / k];
    g.animate(
      [
        { transform: `translate(${p[0]}px, ${p[1]}px) rotate(-14deg) scale(1)`, opacity: 1 },
        { transform: `translate(${(p[0] + q[0]) / 2}px, ${Math.min(p[1], q[1]) - 50}px) rotate(-4deg) scale(0.9)`, opacity: 1, offset: 0.55 },
        { transform: `translate(${q[0]}px, ${q[1] - 6}px) rotate(8deg) scale(0.18)`, opacity: 0 },
      ],
      { duration: 460, easing: "cubic-bezier(.45,0,.55,1)", fill: "forwards" },
    );
  };

  /** Pointer, click and key handling for one draggable file (an object, the laptop's tag, a chip). */
  const handlers = (id: FileId, key: string) => ({
    ref: (el: HTMLElement | null) => {
      if (el) els.current.set(key, el);
      else els.current.delete(key);
    },
    "data-file": id,
    "data-on": dropped && current === id ? "" : undefined,
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.pointerType === "touch" || e.button !== 0) return;
      const el = e.currentTarget;
      drag.current = { id, el, x: e.clientX, y: e.clientY, dx: 0, dy: 0, k: scale(), on: false, pointer: e.pointerId, base: getComputedStyle(el).transform };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointer) return;
      if (!d.on) {
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
        d.on = true;
        d.el.setPointerCapture?.(e.pointerId);
        d.el.setAttribute("data-dragging", "");
      }
      d.dx = (e.clientX - d.x) / d.k;
      d.dy = (e.clientY - d.y) / d.k;
      d.el.style.translate = `${d.dx}px ${d.dy}px`;
      const isOver = overMark(e.clientX, e.clientY);
      setOver((o) => (o === isOver ? o : isOver));
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => endDrag(e),
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => endDrag(e, true),
    onClick: (e: React.MouseEvent<HTMLElement>) => {
      if (swallowClick.current) {
        swallowClick.current = false;
        return;
      }
      fly(e.currentTarget);
      // detail 0: Enter / Space on the button (keyboard), so the screen takes focus.
      drop(id, e.detail === 0 ? "key" : "click");
    },
    onDragStart: (e: React.DragEvent) => e.preventDefault(),
  });

  const endDrag = (e: ReactPointerEvent<HTMLElement>, cancelled = false) => {
    const d = drag.current;
    drag.current = null;
    if (!d || !d.on) return;
    swallowClick.current = true;
    d.el.removeAttribute("data-dragging");
    const hit = !cancelled && overMark(e.clientX, e.clientY);
    const from = `${d.dx}px ${d.dy}px`;
    d.el.style.translate = "";
    if (hit) drop(d.id, "drag");
    else setOver(false);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (hit) {
      // Into the mark, then back where it was.
      const m = markRef.current!.getBoundingClientRect();
      const r = d.el.getBoundingClientRect();
      const tx = (m.left + m.width / 2 - (r.left + r.width / 2)) / d.k;
      const ty = (m.top + m.height / 2 - (r.top + r.height / 2)) / d.k;
      d.el.animate(
        [
          { translate: from, scale: "1", opacity: 1 },
          { translate: `${tx}px ${ty}px`, scale: "0.12", opacity: 0, offset: 0.55 },
          { translate: "0px 0px", scale: "0.96", opacity: 0, offset: 0.56 },
          { translate: "0px 0px", scale: "1", opacity: 1 },
        ],
        { duration: 900, easing: "cubic-bezier(.45,0,.55,1)" },
      );
    } else {
      d.el.animate([{ translate: from }, { translate: "0px 0px" }], { duration: 420, easing: "cubic-bezier(.16,1,.3,1)" });
    }
  };

  // A real file dragged in from the computer: not uploaded here; say where.
  const onNativeOver = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!over) setOver(true);
  };
  const onNativeDrop = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    setOver(false);
    setSay("That's a file from your computer. Upload it at markdrop.in/upload to get its link.");
    track("landing_drop", { file: "own", via: "drag" });
  };

  const file = fileById(current);
  const k = n % 2 ? "A" : "B";
  const hop = (id: FileId) => (dropped && current === id && n ? s.hop : "");
  const hintId = "hero-desk-hint";

  return (
    <div ref={mat} className={s.mat} onDragOver={onNativeOver} onDragLeave={() => setOver(false)} onDrop={onNativeDrop}>
      <span className="md-visually-hidden" id={hintId}>
        {HINT}.
      </span>

      {/* The laptop: its tag is launch.html; its screen shows the file you dropped. */}
      <div className={s.laptop}>
        <button
          type="button"
          className={`${s.tag} ${s.laptopTag} ${hop("html")}`}
          aria-describedby={hintId}
          {...handlers("html", "laptop")}
        >
          launch.html
        </button>
        <div className={s.lid}>
          <div className={s.screen}>
            <UrlBar file={file} />
            <div ref={screenRef} className={s.view} data-screen="" tabIndex={-1} aria-label={`On the laptop: ${file.name}, rendered at markdrop.in/${file.slug}`} role="region">
              <Screen key={`${current}-${n}`} file={file} live={dropped} rest={!dropped} />
            </div>
          </div>
        </div>
        <span className={s.base} aria-hidden="true" />
      </div>

      {/* The phone (deck.pdf) and the paper note (notes.md), from 1024px. */}
      <button
        type="button"
        className={`${s.obj} ${s.phoneObj} ${hop("pdf")}`}
        style={{ "--x": "526px", "--y": "28px", "--w": "158px", "--h": "320px", "--r": "6deg" } as Pos}
        aria-labelledby="hero-pdf-name"
        aria-describedby={hintId}
        {...handlers("pdf", "phone")}
      >
        <span className={s.tag} id="hero-pdf-name">
          deck.pdf
        </span>
        <span className={s.phone} aria-hidden="true">
          <span className={s.phoneScreen}>
            <img className={t.light} src="/landing-desk/hero/pdf.phone.webp" alt="" width={918} height={900} decoding="async" />
            <img className={t.dark} src="/landing-desk/hero/pdf.phone.dark.webp" alt="" width={918} height={900} decoding="async" loading="lazy" />
          </span>
        </span>
      </button>
      <button
        type="button"
        className={`${s.obj} ${s.paperObj} ${hop("md")}`}
        style={{ "--x": "462px", "--y": "calc(384px + var(--extra))", "--w": "222px", "--h": "176px", "--r": "-4deg" } as Pos}
        aria-labelledby="hero-md-name"
        aria-describedby={hintId}
        {...handlers("md", "paper")}
      >
        <span className={s.tag} id="hero-md-name">
          notes.md
        </span>
        <span className={s.paper} aria-hidden="true">
          <img className={t.light} src="/landing-desk/hero/md.webp" alt="" width={912} height={840} decoding="async" />
          <img className={t.dark} src="/landing-desk/hero/md.dark.webp" alt="" width={912} height={840} decoding="async" loading="lazy" />
        </span>
      </button>

      {/* The mark */}
      <div ref={markRef} className={s.dock} data-drop-target="" data-over={over ? "" : undefined}>
        <span className={s.ring} aria-hidden="true" />
        <span className={`${s.splash} ${n ? s[`sp${k}`] : ""}`} key={`sp-${n}`} aria-hidden="true" />
        <span className={`${s.mark} ${eating ? s[`sq${k}`] : ""}`} aria-hidden="true">
          <MarkdropMark size={62} />
        </span>
      </div>

      {/* The tray. Phones get every file here, as a row that scrolls sideways. */}
      <div className={s.tray}>
        <span className={s.trayLabel} aria-hidden="true">
          Also on the desk
        </span>
        <div className={s.trayRow} role="group" aria-label="Files on the desk">
          {(["md", "html", "pdf"] as const).map((id) => (
            <button key={id} type="button" className={`${s.chip} ${s.phoneOnly}`} aria-describedby={hintId} {...handlers(id, `chip-${id}`)}>
              {fileById(id).name}
            </button>
          ))}
          {(["video", "sheet"] as const).map((id) => (
            <button key={id} type="button" className={`${s.chip} ${hop(id)}`} aria-describedby={hintId} {...handlers(id, `chip-${id}`)}>
              {fileById(id).name}
            </button>
          ))}
        </div>
      </div>

      <span className={s.note} aria-hidden="true">
        drop anything here
        <svg width="60" height="34" viewBox="0 0 60 34" style={{ overflow: "visible" }}>
          <path d="M2 26 C 20 30, 40 22, 54 6" style={{ fill: "none", stroke: "currentColor", strokeWidth: 3, strokeLinecap: "round" }} />
          <path d="M42 6 L55 4 L54 17" style={{ fill: "none", stroke: "currentColor", strokeWidth: 3, strokeLinecap: "round", strokeLinejoin: "round" }} />
        </svg>
      </span>

      <div ref={ghost} className={s.ghost} aria-hidden="true" style={{ opacity: 0 }}>
        <svg width="44" height="54" viewBox="0 0 38 46">
          <path d="M3 1h22l10 10v32a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2z" />
        </svg>
      </div>

      <p className="md-visually-hidden" aria-live="polite" role="status">
        {say}
      </p>
    </div>
  );
}

/** The laptop's address bar: markdrop.in/<slug>, and Copy and Open once the sample is published. */
function UrlBar({ file }: { file: DeskFile }) {
  const [copied, setCopied] = useState(false);
  const href = sampleHref(file.slug);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`https://markdrop.in/${file.slug}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard refused: the address is on the screen */
    }
  };
  return (
    <div className={s.url}>
      <span className={s.urlIcon} aria-hidden="true">
        <Icon name="link" />
      </span>
      <span className={s.urlText}>
        {href ? (
          <a href={href} target="_blank" rel="noopener" data-cta={`hero_open_${file.id}`}>
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
          <button type="button" className={s.urlBtn} onClick={copy} data-cta={`hero_copy_${file.id}`}>
            <Icon name={copied ? "check" : "copy"} />
            {copied ? "Copied" : "Copy"}
          </button>
          <a className={s.urlBtn} data-icon="" href={href} target="_blank" rel="noopener" aria-label={`Open markdrop.in/${file.slug} in a new tab`} data-cta={`hero_open_${file.id}`}>
            <Icon name="external" />
          </a>
        </>
      )}
    </div>
  );
}

/**
 * What the laptop shows for one file: its poster (public/landing-desk/hero, a capture of this same
 * render at this screen's size, light and dark, desktop and phone), then the real render once the
 * visitor dropped something; the poster fades out when the render is ready.
 */
function Screen({ file, live, rest }: { file: DeskFile; live: boolean; rest: boolean }) {
  const [ready, setReady] = useState(false);
  const base = `/landing-desk/hero/${file.id}`;
  const first = rest && file.id === "html";
  return (
    <div className={s.show} data-rest={rest ? "" : undefined}>
      <div className={s.poster} data-hidden={ready ? "" : undefined} aria-hidden={ready || undefined}>
        <picture className={t.light}>
          <source media="(max-width: 1023px)" srcSet={`${base}.phone.webp`} />
          <img src={`${base}.webp`} alt={`${file.name}, rendered by Markdrop`} width={912} height={840} decoding="async" fetchPriority={first ? "high" : undefined} />
        </picture>
        <picture className={t.dark}>
          <source media="(max-width: 1023px)" srcSet={`${base}.phone.dark.webp`} />
          <img src={`${base}.dark.webp`} alt={`${file.name}, rendered by Markdrop`} width={912} height={840} decoding="async" loading="lazy" />
        </picture>
      </div>
      {live && (
        <div className={s.live} data-ready={ready ? "" : undefined}>
          {file.render === "markdown" ? <MarkdownRender onReady={() => setReady(true)} /> : <FrameRender file={file} onReady={() => setReady(true)} />}
        </div>
      )}
      {live && !ready && (
        <span className={s.loading} role="status">
          Loading the live render…
        </span>
      )}
    </div>
  );
}
