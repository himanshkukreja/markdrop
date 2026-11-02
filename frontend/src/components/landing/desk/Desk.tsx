"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { track } from "@/lib/track";
import { MarkdropMark } from "../ds";
import LinkCard from "./LinkCard";
import { DESK_FILES, fileById, type FileId } from "./samples";
import s from "./Desk.module.css";
import t from "./theme.module.css";

/**
 * The hero desk (design canvas: E's desk, H's drop). Five files lie on the mat; the Markdrop mark is
 * the drop target. Drag a file onto the mark (mouse or pen), or click / tap it, or press Enter or
 * Space on it: the mark squashes, splashes, and the file comes back as a link card with its live
 * render (LinkCard). One aria-live region says what happened. Touch never drags (the phone strip
 * scrolls sideways); a tap drops.
 *
 * Server-rendered in its resting state (no card on the desktop desk; the first card, notes.md, in the
 * phone layout, as a poster until it scrolls into view), so nothing shifts when it hydrates.
 */

type Pos = CSSProperties & Record<`--${string}`, string>;

/** Desktop placement on the 1280 × 690 mat (E's composition), and the phone strip's sizes. */
const PLACE: Record<FileId, Pos> = {
  md: { "--x": "3.5%", "--y": "6%", "--w": "25.5%", "--h": "440px", "--r": "-4deg", "--mw": "216px", "--mh": "300px" },
  html: { "--x": "33%", "--y": "8.5%", "--w": "39%", "--h": "330px", "--r": "2deg", "--mw": "290px", "--mh": "210px" },
  pdf: { "--x": "77%", "--y": "5.5%", "--w": "15.5%", "--h": "380px", "--r": "7deg", "--mw": "150px", "--mh": "300px" },
  video: { "--x": "36.5%", "--y": "65%", "--w": "19%", "--h": "196px", "--r": "-6deg", "--mw": "220px", "--mh": "200px" },
  sheet: { "--x": "81.5%", "--y": "64%", "--w": "14.5%", "--h": "206px", "--r": "5deg", "--mw": "180px", "--mh": "200px" },
};

const ARIA_HINT = "Drop it on the Markdrop mark to get its link";

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function Desk() {
  // The card's file; `dropped` = the visitor dropped something (until then the card is the phone
  // layout's resting card only).
  const [current, setCurrent] = useState<FileId>("md");
  const [dropped, setDropped] = useState(false);
  const [phase, setPhase] = useState<"idle" | "eat" | "done">("idle");
  const [n, setN] = useState(0);
  const [over, setOver] = useState(false);
  const [say, setSay] = useState("");
  const [cardOpen, setCardOpen] = useState(true);
  const [focusCard, setFocusCard] = useState(0);

  const mat = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const objs = useRef<Partial<Record<FileId, HTMLButtonElement | null>>>({});
  const drag = useRef<{ id: FileId; x: number; y: number; dx: number; dy: number; on: boolean; pointer: number } | null>(null);
  const swallowClick = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const overMark = (cx: number, cy: number) => {
    const r = markRef.current?.getBoundingClientRect();
    if (!r) return false;
    const pad = 24;
    return cx >= r.left - pad && cx <= r.right + pad && cy >= r.top - pad && cy <= r.bottom + pad;
  };

  /** The file goes into the mark: squash, splash, then the card. */
  const drop = useCallback((id: FileId, via: "drag" | "click" | "key") => {
    const f = fileById(id);
    window.clearTimeout(timer.current);
    setOver(false);
    setCurrent(id);
    setDropped(true);
    setCardOpen(true);
    setN((k) => k + 1);
    setPhase("eat");
    setSay(`${f.name} dropped. Rendering…`);
    track("landing_drop", { file: id, via });
    timer.current = window.setTimeout(
      () => {
        setPhase("done");
        setSay(`${f.name} dropped — link ready: markdrop.in/${f.slug}`);
        if (via === "key") setFocusCard((k) => k + 1);
      },
      reducedMotion() ? 0 : 640,
    );
  }, []);

  /** A click or key drop: a paper ghost flies from the object into the mark. */
  const fly = (id: FileId) => {
    const el = objs.current[id];
    const g = ghost.current;
    const m = markRef.current;
    const root = mat.current;
    if (!el || !g || !m || !root || reducedMotion()) return;
    const R = root.getBoundingClientRect();
    const a = el.getBoundingClientRect();
    const b = m.getBoundingClientRect();
    const from = [a.left + a.width / 2 - R.left, a.top + a.height / 2 - R.top];
    const to = [b.left + b.width / 2 - R.left, b.top + b.height / 2 - R.top];
    g.animate(
      [
        { transform: `translate(${from[0]}px, ${from[1]}px) rotate(-14deg) scale(1)`, opacity: 1 },
        { transform: `translate(${(from[0] + to[0]) / 2}px, ${Math.min(from[1], to[1]) - 60}px) rotate(-4deg) scale(0.9)`, opacity: 1, offset: 0.55 },
        { transform: `translate(${to[0]}px, ${to[1] - 6}px) rotate(8deg) scale(0.18)`, opacity: 0 },
      ],
      { duration: 480, easing: "cubic-bezier(.45,0,.55,1)", fill: "forwards" },
    );
  };

  const onPointerDown = (id: FileId) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === "touch" || e.button !== 0) return;
    drag.current = { id, x: e.clientX, y: e.clientY, dx: 0, dy: 0, on: false, pointer: e.pointerId };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    d.dx = e.clientX - d.x;
    d.dy = e.clientY - d.y;
    const el = objs.current[d.id];
    if (!el) return;
    if (!d.on) {
      if (Math.hypot(d.dx, d.dy) < 6) return;
      d.on = true;
      el.setPointerCapture?.(e.pointerId);
      el.setAttribute("data-dragging", "");
    }
    el.style.transform = `translate(${d.dx}px, ${d.dy}px) rotate(calc(var(--r) * .3)) scale(1.04)`;
    const isOver = overMark(e.clientX, e.clientY);
    setOver((o) => (o === isOver ? o : isOver));
  };
  const endDrag = (e: ReactPointerEvent<HTMLButtonElement>, cancelled = false) => {
    const d = drag.current;
    drag.current = null;
    if (!d || !d.on) return;
    swallowClick.current = true;
    const el = objs.current[d.id];
    if (!el) return;
    el.removeAttribute("data-dragging");
    const hit = !cancelled && overMark(e.clientX, e.clientY);
    const from = `translate(${d.dx}px, ${d.dy}px) rotate(calc(var(--r) * .3)) scale(1.04)`;
    el.style.transform = "";
    if (reducedMotion()) {
      if (hit) drop(d.id, "drag");
      else setOver(false);
      return;
    }
    if (hit) {
      // Into the mark, then back on the desk where it was.
      const m = markRef.current!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const tx = d.dx + (m.left + m.width / 2 - (r.left + r.width / 2));
      const ty = d.dy + (m.top + m.height / 2 - (r.top + r.height / 2));
      el.animate(
        [
          { transform: from, opacity: 1 },
          { transform: `translate(${tx}px, ${ty}px) rotate(8deg) scale(0.12)`, opacity: 0, offset: 0.55 },
          { transform: "rotate(var(--r)) scale(0.96)", opacity: 0, offset: 0.56 },
          { transform: "rotate(var(--r))", opacity: 1 },
        ],
        { duration: 900, easing: "cubic-bezier(.45,0,.55,1)" },
      );
      drop(d.id, "drag");
    } else {
      setOver(false);
      el.animate([{ transform: from }, { transform: "rotate(var(--r))" }], { duration: 420, easing: "cubic-bezier(.16,1,.3,1)" });
    }
  };

  const onClick = (id: FileId) => (e: React.MouseEvent<HTMLButtonElement>) => {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    fly(id);
    // detail 0: Enter / Space on the button (keyboard), so the card takes focus when it is ready.
    drop(id, e.detail === 0 ? "key" : "click");
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

  const k = n % 2 ? "A" : "B";
  const eating = phase === "eat";
  const showCard = dropped ? cardOpen && phase === "done" : true;

  return (
    <>
      <div ref={mat} className={s.mat} onDragOver={onNativeOver} onDrop={onNativeDrop}>
        {/* Coffee ring and pencil (decoration). */}
        <span className={s.deco} aria-hidden="true" style={{ left: "60%", top: "43%", width: 128, height: 128, borderRadius: "50%", border: "7px solid color-mix(in srgb, var(--text) 7%, transparent)", borderRightColor: "transparent", transform: "rotate(30deg)" }} />
        <svg className={s.deco} aria-hidden="true" width="210" height="22" viewBox="0 0 210 22" style={{ left: "4%", top: "93.5%", transform: "rotate(-5deg)" }}>
          <rect x="18" y="4" width="160" height="14" rx="2" style={{ fill: "var(--text-secondary)" }} />
          <rect x="178" y="4" width="16" height="14" style={{ fill: "var(--border-strong)" }} />
          <path d="M194 4 L208 11 L194 18 Z" style={{ fill: "var(--surface-raised)", stroke: "var(--border-strong)" }} />
          <path d="M204 9 L208 11 L204 13Z" style={{ fill: "var(--text)" }} />
          <rect x="4" y="4" width="16" height="14" rx="3" style={{ fill: "var(--accent)" }} />
        </svg>

        <div className={s.files} role="list" aria-label="Files on the desk">
          {DESK_FILES.map((f) => (
            <div role="listitem" key={f.id} style={{ display: "contents" }}>
              <button
                type="button"
                ref={(el) => {
                  objs.current[f.id] = el;
                }}
                className={s.obj}
                style={PLACE[f.id]}
                data-current={dropped && current === f.id && phase === "done" ? "" : undefined}
                aria-label={`${f.name}, ${f.kind.toLowerCase()}. ${ARIA_HINT}.`}
                onPointerDown={onPointerDown(f.id)}
                onPointerMove={onPointerMove}
                onPointerUp={(e) => endDrag(e)}
                onPointerCancel={(e) => endDrag(e, true)}
                onClick={onClick(f.id)}
                onDragStart={(e) => e.preventDefault()}
              >
                <span className={s.face}>
                  <Face id={f.id} />
                  <span className={s.tag}>{f.name}</span>
                </span>
              </button>
            </div>
          ))}
        </div>

        <span className={s.sticky} aria-hidden="true" style={{ "--x": "24%", "--y": "70%", "--w": "148px", "--r": "5deg" } as Pos}>
          replace the file.
          <br />
          keep the link.
        </span>

        <span className={s.note} aria-hidden="true" style={{ "--x": "55.5%", "--y": "1.2%", "--r": "-3deg" } as Pos}>
          this link opens anywhere
          <svg width="70" height="58" viewBox="0 0 70 58" style={{ marginTop: 6 }}>
            <path d="M4 6 C 34 0, 58 14, 52 46" style={{ fill: "none", stroke: "currentColor", strokeWidth: 3, strokeLinecap: "round" }} />
            <path d="M42 38 L52 48 L60 36" style={{ fill: "none", stroke: "currentColor", strokeWidth: 3, strokeLinecap: "round", strokeLinejoin: "round" }} />
          </svg>
        </span>
        <span className={s.note} aria-hidden="true" style={{ "--x": "3.5%", "--y": "79%", "--r": "-3deg", flexDirection: "column-reverse" } as Pos}>
          only Dana can read this
          <svg width="60" height="46" viewBox="0 0 60 46">
            <path d="M8 44 C 0 22, 14 8, 34 4" style={{ fill: "none", stroke: "currentColor", strokeWidth: 3, strokeLinecap: "round" }} />
            <path d="M24 0 L35 4 L27 13" style={{ fill: "none", stroke: "currentColor", strokeWidth: 3, strokeLinecap: "round", strokeLinejoin: "round" }} />
          </svg>
        </span>
        <span className={s.note} aria-hidden="true" style={{ "--x": "58.5%", "--y": "56.5%", "--r": "-2deg" } as Pos}>
          drop anything here
          <svg width="40" height="40" viewBox="0 0 40 40" style={{ marginTop: 10 }}>
            <path d="M4 4 C 26 4, 34 14, 30 34" style={{ fill: "none", stroke: "currentColor", strokeWidth: 3, strokeLinecap: "round" }} />
            <path d="M22 28 L30 36 L37 27" style={{ fill: "none", stroke: "currentColor", strokeWidth: 3, strokeLinecap: "round", strokeLinejoin: "round" }} />
          </svg>
        </span>

        <div
          ref={markRef}
          className={s.drop}
          data-over={over ? "" : undefined}
          style={{ "--x": "58.5%", "--y": "63%" } as Pos}
        >
          <div className={s.ring} aria-hidden="true" />
          <div className={`${s.splash} ${eating ? s[`splash${k}`] : ""}`} aria-hidden="true" />
          <span className={`${s.mark} ${eating ? s[`squash${k}`] : ""}`} aria-hidden="true">
            <MarkdropMark size={84} />
          </span>
          <span className={s.dropLabel} aria-hidden="true">
            {over ? "Let go" : eating ? "Mm." : ""}
          </span>
        </div>

        <div ref={ghost} className={s.ghost} aria-hidden="true" style={{ opacity: 0 }}>
          <svg width="44" height="54" viewBox="0 0 38 46">
            <path d="M3 1h22l10 10v32a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2z" />
          </svg>
        </div>

        {showCard && (
          <LinkCard
            key={`${current}-${n}`}
            file={fileById(current)}
            initial={!dropped}
            eager={dropped}
            focusKey={focusCard}
            onClose={() => {
              setCardOpen(false);
              setSay("Link card closed.");
              objs.current[current]?.focus();
            }}
          />
        )}
      </div>
      <p className={s.hint}>Drag a file onto the mark, or click it. Every link here opens on any screen.</p>
      <p className="md-visually-hidden" aria-live="polite" role="status">
        {say}
      </p>
    </>
  );
}

/** What each file looks like on the desk. Screens are real screenshots of the sample's render. */
function Face({ id }: { id: FileId }) {
  switch (id) {
    case "md":
      return (
        <span className={s.paper}>
          <span className={s.paperUrl}>markdrop.in/launch-notes</span>
          <span className={s.paperTitle}>Launch notes</span>
          <span className={s.paperText}>Review closes Thursday. We ship Workflows to every Acme workspace on Friday.</span>
          <span className={s.flow} aria-hidden="true">
            <span>Write</span>→<span>Review</span>→<span>Ship</span>
          </span>
          <table className={s.paperTable} aria-hidden="true">
            <tbody>
              <tr><td>Final copy · Riya</td><td>Wed</td></tr>
              <tr><td>Review · Alex, Sam</td><td>Thu</td></tr>
              <tr><td>Release · Maya</td><td>Fri</td></tr>
            </tbody>
          </table>
          <span className={s.circled}>
            Shared with Dana
            <svg aria-hidden="true" width="150" height="40" viewBox="0 0 150 40">
              <path d="M8 22 C 6 6, 70 2, 128 8 C 150 12, 146 32, 100 36 C 60 40, 10 36, 12 18" style={{ fill: "none", stroke: "var(--accent-text)", strokeWidth: 2.5, strokeLinecap: "round" }} />
            </svg>
          </span>
        </span>
      );
    case "html":
      return (
        <span className={s.laptop}>
          <span className={s.lid}>
            <span className={s.screen}>
              {/* The hero's LCP image: the sample page, rendered (scripts/landing-samples/screens.mjs). */}
              <img src="/landing-desk/screens/calculator.webp" alt="" width={960} height={600} fetchPriority="high" decoding="async" />
            </span>
          </span>
          <span className={s.base} aria-hidden="true" />
        </span>
      );
    case "pdf":
      return (
        <span className={s.phone}>
          <span className={s.phoneScreen}>
            <img className={t.light} src="/landing-desk/screens/deck-phone.webp" alt="" width={360} height={720} decoding="async" />
            <img className={t.dark} src="/landing-desk/screens/deck-phone.dark.webp" alt="" width={360} height={720} decoding="async" loading="lazy" />
          </span>
        </span>
      );
    case "video":
      return (
        <span className={s.photo}>
          <span className={s.photoImg}>
            <img src="/landing-desk/screens/demo-photo.webp" alt="" width={480} height={270} decoding="async" />
            <span className={s.play} aria-hidden="true" />
          </span>
          <span className={s.photoCap}>Acme Cloud · product tour</span>
        </span>
      );
    case "sheet":
      return (
        <span className={s.printout} aria-hidden="true">
          <span><span>Budget 2026</span><span>$k</span></span>
          <span><span>Hosting</span><span>178</span></span>
          <span><span>Design</span><span>389</span></span>
          <span><span>Support</span><span>135</span></span>
          <span><span>Events</span><span>100</span></span>
          <span><span>Tools</span><span>90</span></span>
          <span><span>Total</span><span>892</span></span>
        </span>
      );
  }
}
