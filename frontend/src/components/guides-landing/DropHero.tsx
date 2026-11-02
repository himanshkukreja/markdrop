import type { ReactNode } from "react";
import { SnapSection } from "@/components/marketing/snap/Snap";
import DropStage from "./DropStage";
import HeroFixList from "./HeroFixList";
import h from "./DropHero.module.css";

/**
 * The Guides landing hero ("See where readers drop off."): the copy and CTAs on top, and the stage
 * under them: the drop visual (DropStage, its own component) on the left and middle, the Fix list
 * card (HeroFixList, interactive) and a small AI agent log on the right. Every number is the
 * fictional Acme sample, and the stage says so.
 *
 * From 1024px the hero is one 1200 × 690 artboard, scaled as a whole to the viewport under the header
 * (the smaller of width / 1200 and height / 690), so it always fits one screen and nothing inside
 * reflows: 1 ≈ 1280 × 720 (0.96), 1.2 at 1440 × 900, 1.48 at 1920 × 1080; 0.83 at 1024 × 640, where
 * the stage's smallest text (13px) is still 11px. Under 1024px it stacks and scrolls.
 */
export default function DropHero({ ctas }: { ctas: ReactNode }) {
  return (
    <SnapSection id="hero" labelledBy="hero-title" bare className={h.hero}>
      <div className={h.canvas}>
        <div className={h.top}>
          <p className={h.eyebrow}>Markdrop Guides · free in beta</p>
          <h1 id="hero-title" className={h.h1}>
            See where readers <span className={h.drop}>drop</span> off.
          </h1>
          <p className={h.sub}>
            Docs that show you what to fix next: where readers and AI agents give up, why, and a drafted fix.
          </p>
          <div className={h.ctas}>{ctas}</div>
        </div>

        <div className={h.stage}>
          <p className={h.sample}>Example · Acme, a fictional company</p>
          <div className={h.slot}>
            <DropStage />
          </div>
          <div className={h.side}>
            <HeroFixList />
            <div className={h.agents} role="group" aria-label="Example AI agent requests">
              <div>
                <b>claude · GET /llms.txt</b> <span className={h.okLog}>200</span>
              </div>
              <div>
                <b>mcp · search_docs(&quot;terraform&quot;)</b>
              </div>
              <div>
                <em>0 results → Fix list</em>
              </div>
            </div>
          </div>
        </div>
      </div>
    </SnapSection>
  );
}
