"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { guideEvents } from "@/lib/guidesEvents";
import h from "./HeroDemo.module.css";

/**
 * The hero's live demo (canvas hero F3, "Live demo"): a browser window on Acme's Quickstart (fictional
 * data) that plays the Fix list loop on a 100 ms timeline (END = 12.5 s, then it starts again):
 *
 *   Watch  0–2.6 s   read depth fills in, section by section (95, 92, 49, 46, 43%); "Install the CLI" turns hot
 *   Rank   2.6–4.6 s the Fix list slides in, its top item and evidence; the cursor clicks Draft a fix
 *   Draft  4.6–7.2 s the section opens as an inline diff; the cursor clicks Accept
 *   Fix    7.2–12.5 s Publish, and the section is stamped "Fixed on publish"
 *
 * The window is one image to assistive tech (role="img" with a summary); nothing inside it is
 * focusable. The four steps under it are real buttons that jump the timeline (counted as
 * guide_landing_demo). The timer runs only while the hero is on screen and the tab is visible;
 * prefers-reduced-motion shows the finished state with no timer. The cursor's targets are measured
 * from the window itself, so it lands on the buttons at any size and on phones.
 */

const END = 125;
const STILL = 100;

const SECTIONS = [
  { title: "Before you start", pct: "95%", g: 95, l1: 82, l2: 58 },
  { title: "Install the CLI", pct: "92%", g: 92, l1: 90, l2: 66, hot: true },
  { title: "Create a project", pct: "49%", g: 49, l1: 78, l2: 52 },
  { title: "Send your first alert", pct: "46%", g: 46, l1: 86, l2: 60 },
  { title: "Next steps", pct: "43%", g: 43, l1: 70, l2: 40 },
];

const STEPS = [
  { title: "Watch", body: "how far readers get", a: 0, b: 26, jump: 18, event: null },
  { title: "Rank", body: "what to fix first", a: 26, b: 46, jump: 32, event: "item" },
  { title: "Draft", body: "the fix, from evidence", a: 46, b: 72, jump: 58, event: "drafted" },
  { title: "Fix", body: "accept and publish", a: 72, b: END, jump: 90, event: "published" },
] as const;

type Pt = { x: number; y: number; o: number };

/** The centre of `el` in the window's own (unscaled) pixels. */
function centre(win: HTMLElement, el: HTMLElement | null): { x: number; y: number } | null {
  if (!el) return null;
  const w = win.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const k = w.width / win.offsetWidth || 1;
  return { x: (r.left - w.left + r.width / 2) / k, y: (r.top - w.top + r.height / 2) / k };
}

export default function HeroDemo() {
  const [t, setT] = useState(0);
  const [still, setStill] = useState(false);
  const [onScreen, setOnScreen] = useState(false);
  const [tabVisible, setTabVisible] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const win = useRef<HTMLDivElement>(null);
  const draftEl = useRef<HTMLSpanElement>(null);
  const acceptEl = useRef<HTMLSpanElement>(null);
  const pubEl = useRef<HTMLSpanElement>(null);
  const [cur, setCur] = useState<Pt>({ x: 640, y: 520, o: 0 });
  const [ring, setRing] = useState<{ x: number; y: number } | null>(null);

  // Reduced motion: the finished state, no timer.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      setStill(mq.matches);
      if (mq.matches) setT(STILL);
    };
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);

  // Only while the hero is on screen and the tab is visible.
  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setOnScreen(e.isIntersecting), { threshold: 0.15 });
    io.observe(el);
    const vis = () => setTabVisible(document.visibilityState !== "hidden");
    vis();
    document.addEventListener("visibilitychange", vis);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", vis);
    };
  }, []);

  const running = onScreen && tabVisible && !still;
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setT((v) => (v >= END ? 0 : v + 1)), 100);
    return () => window.clearInterval(id);
  }, [running]);

  const panel = t >= 26;
  const hot = t >= 17;
  const diff = t >= 47;
  const accepted = t >= 72;
  const fixed = t >= 86;

  // The cursor: where it is in each part of the timeline (measured from the window).
  const seg = t >= 92 ? 5 : t >= 76 ? 4 : t >= 52 ? 3 : t >= 36 ? 2 : t >= 30 ? 1 : 0;
  const ringAt = t >= 44 && t < 48 ? "draft" : t >= 68 && t < 72 ? "accept" : t >= 83 && t < 87 ? "pub" : null;
  const measure = useCallback(() => {
    const w = win.current;
    if (!w) return;
    const W = w.offsetWidth;
    const H = w.offsetHeight;
    const at = (el: HTMLElement | null, o = 1): Pt | null => {
      const c = centre(w, el);
      return c ? { x: c.x - 5, y: c.y - 5, o } : null;
    };
    const start = { x: W * 0.85, y: H * 0.94, o: 0 };
    let next: Pt = start;
    if (seg === 1) next = { x: W * 0.85, y: H * 0.85, o: 1 };
    if (seg === 2) next = at(draftEl.current) ?? start;
    if (seg === 3) next = at(acceptEl.current) ?? start;
    if (seg === 4) next = at(pubEl.current) ?? start;
    if (seg === 5) {
      const p = centre(w, pubEl.current);
      next = p ? { x: p.x + 26, y: p.y + 90, o: 0 } : start;
    }
    setCur(next);
    const el = ringAt === "draft" ? draftEl.current : ringAt === "accept" ? acceptEl.current : ringAt === "pub" ? pubEl.current : null;
    setRing(el ? centre(w, el) : null);
  }, [seg, ringAt]);
  useLayoutEffect(measure, [measure]);

  const go = (i: number) => {
    const s = STEPS[i];
    setT(s.jump);
    if (s.event) guideEvents.landingDemo(s.event);
  };

  return (
    <div ref={root} className={h.demo}>
      <div
        ref={win}
        className={h.win}
        role="img"
        aria-label="Demo with example data: Guides shows that 42% of readers stop at Install the CLI on Acme's Quickstart, drafts a rewrite of that section, the editor accepts it and publishes, and the section is marked fixed."
        data-panel={panel || undefined}
        data-diff={diff || undefined}
      >
        <div className={h.bar} aria-hidden="true">
          <span className={h.dots}>
            <i />
            <i />
            <i />
          </span>
          <span className={h.url}>guides.markdrop.in/acme/quickstart</span>
          <span className={h.barEnd} />
        </div>
        <div className={h.app} aria-hidden="true">
          <span className={h.logo}>A</span>
          <b>Acme Docs</b>
          <small>/ Quickstart</small>
          <span className={h.grow} />
          <span className={h.ins}>
            <i />
            Insights · 7 days
          </span>
          <span ref={pubEl} className={h.pub} data-press={(t >= 83 && t < 85) || undefined}>
            Publish
          </span>
        </div>
        <div className={h.body} aria-hidden="true">
          <div className={h.page}>
            <div className={h.crumb}>Get started</div>
            <div className={h.title}>Quickstart</div>
            {SECTIONS.map((x, i) => {
              const on = t >= 3 + i * 3;
              const isHot = !!x.hot && hot && !fixed;
              const isFixed = !!x.hot && fixed;
              const open = !!x.hot && diff;
              return (
                <div key={x.title} className={h.s} data-hot={isHot || undefined} data-fixed={isFixed || undefined} data-open={open || undefined}>
                  <span className={h.gut} data-on={on || undefined} style={{ "--g": `${x.g}%` } as CSSProperties}>
                    <i />
                  </span>
                  <b>{x.title}</b>
                  {x.hot && hot && !diff && (
                    <span className={h.call}>
                      42% stop here · <b>131 readers</b>
                    </span>
                  )}
                  {open ? (
                    <>
                      <div className={h.diff}>
                        <div className={h.del}>- Install the CLI with your package manager.</div>
                        <div className={h.add}>+ npm install -g @acme/cli</div>
                        <div className={h.add}>+ acme login   # opens your browser</div>
                      </div>
                      <div className={h.acts}>
                        {!accepted && (
                          <>
                            <span ref={acceptEl} className={`${h.btn} ${h.primary}`} data-press={(t >= 68 && t < 70) || undefined}>
                              Accept
                            </span>
                            <span className={h.btn}>Discard</span>
                          </>
                        )}
                        {accepted && !fixed && <span className={h.note}>Accepted · fixed when you publish</span>}
                      </div>
                    </>
                  ) : (
                    <>
                      <em style={{ width: `${x.l1}%` }} />
                      <em style={{ width: `${x.l2}%` }} />
                    </>
                  )}
                  {isFixed && <span className={h.stamp}>Fixed on publish</span>}
                  <span className={h.pct} data-on={on || undefined}>
                    {x.pct}
                  </span>
                </div>
              );
            })}
          </div>
          <div className={h.panel}>
            <div className={h.ph}>
              Fix list<span>15 to fix</span>
            </div>
            <div className={h.it} data-on="" style={{ "--ic": "var(--danger-fill)", "--tag-fg": "var(--danger)" } as CSSProperties}>
              <i />
              <span>
                <b>Readers leave at “Install the CLI”</b>
                <small>Quickstart · Confident</small>
              </span>
              <u>High</u>
            </div>
            <div className={h.it} style={{ "--ic": "var(--accent)", "--tag-fg": "var(--accent-text)" } as CSSProperties}>
              <i />
              <span>
                <b>Agents find nothing: “terraform”</b>
                <small>23 searches via MCP</small>
              </span>
              <u>Agents</u>
            </div>
            <div className={h.it} style={{ "--ic": "var(--warning-fill)", "--tag-fg": "var(--warning)" } as CSSProperties}>
              <i />
              <span>
                <b>“sso” finds nothing</b>
                <small>18 searches</small>
              </span>
              <u>Med</u>
            </div>
            <div className={h.ev}>
              <p>42% of 310 measured readers stop here. Elsewhere about 4% stop per section.</p>
              <div className={h.bars}>
                {[100, 95, 92, 49, 46].map((v, i) => (
                  <i key={i} data-hot={i === 2 || undefined} style={{ height: `${v}%` }} />
                ))}
              </div>
              <span ref={draftEl} className={h.draft} data-press={(t >= 44 && t < 46) || undefined}>
                Draft a fix
              </span>
            </div>
          </div>
        </div>
        <svg className={h.cur} viewBox="0 0 24 24" aria-hidden="true" style={{ left: cur.x, top: cur.y, opacity: cur.o }}>
          <path d="M4 2l15 9-6.5 1.6L10 19z" fill="#111A2C" stroke="#ffffff" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
        {ring && !still && <span key={ringAt} className={h.ring} style={{ left: ring.x, top: ring.y }} aria-hidden="true" />}
      </div>

      <div className={h.steps} role="group" aria-label="What the demo shows">
        {STEPS.map((s, i) => {
          const on = t >= s.a && t < s.b;
          const p = Math.max(0, Math.min(100, Math.round(((t - s.a) / (s.b - s.a)) * 100)));
          return (
            <button key={s.title} type="button" className={h.step} data-on={on || undefined} aria-pressed={on} onClick={() => go(i)} style={{ "--p": `${p}%` } as CSSProperties}>
              <i aria-hidden="true" />
              <b>{s.title}</b>
              <small>{s.body}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}
