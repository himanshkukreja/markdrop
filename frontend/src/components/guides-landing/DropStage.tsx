import type { CSSProperties } from "react";
import d from "./DropStage.module.css";

/**
 * The hero's drop visual (the stage's left and middle): Acme's Quickstart page with how far readers
 * got, section by section, a lane of drops (readers) flowing down beside it, the red ones dropping
 * off at "Install the CLI", and the puddle they collect in, "131 readers dropped off here".
 *
 * Self-contained on purpose: it fills the slot DropHero gives it (`.slot` there: the stage left of the
 * Fix list) and owns its own layout, motion and reduced-motion frame, so it can be replaced without
 * touching the hero. Server HTML, CSS-only motion. The numbers are the fictional Acme sample (docs:
 * guides/fix-list: 42% of 310 measured readers stopped at Install the CLI, 131 readers).
 */

const SECTIONS: Array<{ t: string; d: string; pct: string; hot?: boolean }> = [
  { t: "Before you start", d: "An account and Node 20", pct: "95%" },
  { t: "Install the CLI", d: "42% of 310 readers left here", pct: "92%", hot: true },
  { t: "Create a project", d: "Run init in an empty folder", pct: "49%" },
  { t: "Send your first alert", d: "Pick a rule and a channel", pct: "46%" },
  { t: "Next steps", d: "Sources and the API", pct: "43%" },
];

/** Readers as drops: every fifth-ish one leaves at the hot section. Deterministic (server HTML). */
const DROPS = Array.from({ length: 16 }, (_, i) => {
  const leave = i % 5 === 1 || i % 5 === 3;
  return {
    leave,
    style: {
      "--delay": `${(i * 0.34).toFixed(2)}s`,
      "--x": `${((i * 7) % 11) - 5}px`,
      // The still frame (reduced motion): stayers parked along the lane, leavers in the puddle.
      "--rest": `${leave ? 0 : 16 + ((i * 53) % 340)}px`,
      "--px": `${((i * 29) % 90) - 45}px`,
    } as CSSProperties,
  };
});

export default function DropStage() {
  return (
    <div
      className={d.stage}
      role="img"
      aria-label="Example with fictional data: readers flow down Acme's Quickstart page. 95% reach Before you start and 92% reach Install the CLI, where 42% of 310 measured readers leave; 49% reach Create a project. 131 readers dropped off at Install the CLI."
    >
      <div className={d.pageWrap}>
        <div className={d.lane} aria-hidden="true">
          {DROPS.map((x, i) => (
            <span key={i} className={x.leave ? `${d.drop} ${d.leave}` : d.drop} style={x.style} />
          ))}
        </div>
        <div className={d.page} aria-hidden="true">
          <div className={d.crumb}>Acme Docs · Get started</div>
          <div className={d.h}>Quickstart</div>
          {SECTIONS.map((s) => (
            <div key={s.t} className={s.hot ? `${d.sec} ${d.hot}` : d.sec}>
              <span>
                <b>{s.t}</b>
                <small>{s.d}</small>
              </span>
              <span className={d.pct}>{s.pct}</span>
            </div>
          ))}
        </div>
      </div>
      <div className={d.pool} aria-hidden="true">
        <span className={d.puddle} />
        <span className={d.poolLabel}>
          131 readers dropped off here
          <small>at &ldquo;Install the CLI&rdquo;</small>
        </span>
      </div>
    </div>
  );
}
