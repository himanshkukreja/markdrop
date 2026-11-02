import type { ReactNode } from "react";
import { preload } from "react-dom";
import { Icon, StudioGlyph } from "@/components/landing/ds";
import LoopVideo from "./LoopVideo";
import { LOOPS } from "./loops";
import { SnapSection } from "@/components/marketing/snap/Snap";
import s from "./GuidesHero.module.css";

/**
 * The Markdrop Guides landing page's hero: the headline, the CTAs (passed in, so the page owns where
 * they point), and the product itself: a laptop playing the studio's Fix list loop (the top item, its
 * evidence, Draft a fix, the suggestion accepted in the editor, the publish that closes it), with
 * two smaller loops beside it (a live demo running in a docs page, a private section opening for a
 * Northwind reader) and a GitHub sync note. Server HTML; the loops are LoopVideo islands.
 *
 * LCP is the laptop's poster (preloaded, high priority); the clips start after the page's load event.
 * Every box has a fixed aspect ratio, so nothing moves as images or videos arrive.
 */
export default function GuidesHero({ primary, secondary }: { primary: ReactNode; secondary: ReactNode }) {
  const hero = LOOPS.heroFix;
  preload(`${hero.src}.webp`, { as: "image", fetchPriority: "high" });
  return (
    <SnapSection id="hero" labelledBy="hero-title" bare className={s.hero}>
      <div className={s.bg} aria-hidden="true" />
      <div className={s.wrap}>
        <div className={s.intro}>
          <p className={s.badge}>
            <StudioGlyph size={14} />Markdrop Guides<span className={s.beta}>Free in beta</span>
          </p>
          <h1 id="hero-title" className={s.h1}>
            Docs that show you <span className={s.em}>what to fix next.</span>
          </h1>
          <p className={s.sub}>
            Host your help center, product guides and API docs, free while in beta. Guides watches how people and AI agents read
            them, ranks what to fix, and drafts each fix for you to review.
          </p>
          <div className={s.ctas}>
            {primary}
            {secondary}
          </div>
          <ul className={s.proof} aria-label="Also in Markdrop Guides">
            <li><Icon name="lock" size={14} /><a href="#private-pages">Private pages, free</a></li>
            <li><Icon name="play" size={14} /><a href="#live-demos">Live demos, video and PDFs in your docs</a></li>
            <li><Icon name="github" size={14} /><a href="#import">GitHub sync and imports</a></li>
            <li><Icon name="sparkle" size={14} /><a href="#features">Ready for AI</a></li>
          </ul>
        </div>

        <div className={s.stage}>
          <figure className={s.laptop} aria-labelledby="hero-loop-cap">
            <div className={s.lid}>
              <span className={s.cam} aria-hidden="true" />
              <div className={s.screen}>
                <LoopVideo {...hero} priority dark />
              </div>
            </div>
            <div className={s.base} aria-hidden="true"><span className={s.notch} /></div>
            <figcaption id="hero-loop-cap" className="sr-only">{hero.caption}</figcaption>
          </figure>

          <figure className={`${s.card} ${s.cardDemo}`}>
            <div className={s.cardBar} aria-hidden="true">
              <span className={s.dots}><i /><i /><i /></span>
              <span className={s.addr}>help.acme.com/billing/pricing</span>
            </div>
            <LoopVideo {...LOOPS.calc} dark className={s.cardLoop} />
            <figcaption className={s.cardCap}>
              <span className={s.cardIco} aria-hidden="true"><Icon name="play" size={12} /></span>
              <span><strong>A live demo</strong>, running in the docs page</span>
            </figcaption>
          </figure>

          <figure className={`${s.card} ${s.cardPrivate}`}>
            <div className={s.cardBar} aria-hidden="true">
              <span className={s.dots}><i /><i /><i /></span>
              <span className={s.addr}>help.acme.com/single-sign-on</span>
            </div>
            <LoopVideo {...LOOPS.private} dark className={s.cardLoop} />
            <figcaption className={s.cardCap}>
              <span className={s.cardIco} aria-hidden="true"><Icon name="lock" size={12} /></span>
              <span><strong>Private to Northwind</strong>, on a public page</span>
            </figcaption>
          </figure>

          <div className={`${s.chip} ${s.chipSync}`}>
            <span className={s.chipIco} aria-hidden="true"><Icon name="github" size={15} /></span>
            <span className={s.chipText}>
              <strong>Pushed to acme/docs</strong>
              <span>main · the guide updates on every push</span>
            </span>
            <span className={s.chipOk} aria-hidden="true"><Icon name="check" size={12} /></span>
          </div>
        </div>
        <p className={s.note}>Recorded in the studio and in a published guide, with fictional data.</p>

        <div className={s.trust}>
          <p className={s.trustLabel}>Bring your docs from</p>
          <ul className={s.marks} aria-label="Imports">
            <li>GitBook</li>
            <li>Mintlify</li>
            <li>Docusaurus</li>
            <li>MkDocs</li>
            <li><Icon name="github" size={15} />GitHub</li>
          </ul>
          <p className={s.trustFree}><Icon name="checkCircle" size={15} />Free while in beta</p>
        </div>
      </div>
    </SnapSection>
  );
}
