import type { ReactNode } from "react";
import { SnapSection } from "@/components/marketing/snap/Snap";
import HeroDemo from "./HeroDemo";
import h from "./DropHero.module.css";

/**
 * The Guides landing hero (canvas hero F3, "Live demo"): "See where readers drop off." with the CTAs on
 * the left, and on the right the live demo (HeroDemo): a browser window on a sample Acme page that
 * plays Watch, Rank, Draft and Fix, with its four steps under it. Labelled as example data.
 *
 * From 1024px the hero is one artboard drawn in its own pixels and scaled as a whole (--k, the smaller
 * of (width less a side gutter) / artboard width and height under the header / 664): 1200 wide from 1240px (copy 400 ·
 * 32 · window 752), 1120 below (copy 330 · 24 · 752). k is 1 at 1280 × 720, about 1.14 at 1440 × 900,
 * 1.5 at 1920 × 1080 and 0.88 at 1024 × 640, where the demo’s 12.5px text is still 11px. Nothing
 * inside reflows. Under 1024px it stacks and scrolls.
 */
export default function DropHero({ ctas, tour }: { ctas: ReactNode; tour: ReactNode }) {
  return (
    <SnapSection id="hero" labelledBy="hero-title" bare className={h.hero}>
      <div className={h.canvas}>
        <div className={h.copy}>
          <p className={h.eyebrow}>Markdrop Guides · free in beta</p>
          <h1 id="hero-title" className={h.h1}>
            See where readers <span className={h.accent}>drop off.</span>
          </h1>
          <p className={h.sub}>
            Docs that show you what to fix next. Guides measures how far people and AI agents get on every page, finds where they stop,
            and drafts the fix.
          </p>
          <div className={h.ctas}>{ctas}</div>
          <div className={h.tour}>{tour}</div>
        </div>
        <div className={h.stage}>
          <p className={h.sample}>Example · Acme, a fictional company</p>
          <HeroDemo />
        </div>
      </div>
    </SnapSection>
  );
}
