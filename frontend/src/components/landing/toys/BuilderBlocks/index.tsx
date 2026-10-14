import Link from "next/link";
import { ICONS } from "@/components/ui/icons";
import LazyIsland from "../../LazyIsland";
import View from "./View";
import { initialState } from "./model";
import s from "./BuilderBlocks.module.css";

/**
 * Landing section 7: Builder Blocks (board: design/revamp-canvas/PlayBuilderBlocks.dc.html).
 * Server component. The head copy, the keyboard tip and the CTA are real server HTML outside the
 * island; the toy's static first frame is View(initialState), swapped for the Game near the viewport.
 */

function Icon({ name, size }: { name: keyof typeof ICONS; size: number }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="md-icon" style={{ fontSize: size }}>
      <path d={ICONS[name]} />
    </svg>
  );
}

/* Board glyph positions mapped onto the 1232px content box (shown at >= 1280 only). */
const GLYPHS: Array<[string, number, number]> = [
  ["#", 789, 6],
  ["```mermaid", 895, 48],
  ["$$", 1059, 0],
  ["| --- |", 1117, 64],
  ["## Install", 751, 86],
];

export default function BuilderBlocks() {
  return (
    <section id="builder-blocks" aria-labelledby="bb-h2" className={s.section}>
      <div className="mx-auto max-w-marketing px-4 py-16 sm:px-6 sm:py-24">
        <div className={s.wrap}>
          {GLYPHS.map(([t, x, y]) => (
            <span key={t} className={s.gl} aria-hidden="true" style={{ left: x, top: y }}>{t}</span>
          ))}

          <header className={s.head}>
            <p className={s.eye}>
              <Icon name="builder" size={16} />
              <span className={`${s.eyebrow} text-eyebrow uppercase`}>README builder</span>
            </p>
            <h2 id="bb-h2" className={s.h2}>Build a README in blocks<span className={s.dot}>.</span></h2>
            <p className={s.lead}>
              Pick the sections your project needs, put them in order, and watch the README render as you go. Diagrams and math come out drawn, not as code.
            </p>
            <p className={s.pdf}>
              <Icon name="printer" size={14} />
              Every document also prints to a clean PDF.
            </p>
          </header>

          <LazyIsland name="builder-blocks">
            <View state={initialState} />
          </LazyIsland>

          <div className={s.foot}>
            <p className={`${s.tip} ${s.tipWide}`}>
              <kbd className="md-kbd">Enter</kbd> adds or removes a block. On a handle, <kbd className="md-kbd"><span aria-hidden="true">&#8593;</span><span className={s.sr}>Arrow up</span></kbd>{" "}
              <kbd className="md-kbd"><span aria-hidden="true">&#8595;</span><span className={s.sr}>Arrow down</span></kbd> move it. Or drag the handle.
            </p>
            <p className={`${s.tip} ${s.tipNarrow}`}>Tap a block to add or remove it. Use the arrows on a row to move it.</p>
            <div className={s.cta}>
              <span className={s.ctaCap}>Publish to markdrop.in with no account, export to PDF, or download README.md.</span>
              <Link href="/builder" data-cta="toy_builder_blocks_builder" className={`md-btn md-btn--primary md-btn--lg ${s.ctaBtn}`}>
                Open the builder
                <Icon name="arrowRight" size={16} />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
