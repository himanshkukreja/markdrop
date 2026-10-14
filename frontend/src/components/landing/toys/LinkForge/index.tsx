import Link from "next/link";
import LazyIsland from "../../LazyIsland";
import View, { Icon } from "./View";
import { COPY, initialState } from "./model";
import s from "./LinkForge.module.css";

/**
 * Landing section 3: Link Forge, "Make the link yours." (design/revamp-canvas/PlayLinkForge.dc.html).
 *
 * Server component. The static first frame is View(initialState), heading and lead included, so the
 * whole section reads without JavaScript; LazyIsland swaps in the playable Game as the section nears
 * the viewport. The CTAs are plain server links outside the island.
 */
export default function LinkForge() {
  return (
    <section id="link-forge" aria-labelledby="lf-h2" className={s.section}>
      <div className={s.dots} aria-hidden="true" />
      <div className={s.glow} aria-hidden="true" />
      <div className={`${s.inner} mx-auto max-w-marketing px-4 py-16 sm:px-6 sm:py-24`}>
        <LazyIsland name="link-forge">
          <View state={initialState} />
        </LazyIsland>
        <div className={s.cta}>
          <Link id="lf-cta-new" data-cta="toy_link_forge_new" href={COPY.ctaPrimaryHref} className={`md-btn md-btn--primary md-btn--lg ${s.ctaBtn}`}>
            {COPY.ctaPrimary}
            <Icon name="arrowRight" size={16} />
          </Link>
          <p>{COPY.ctaNote}</p>
          <span className={s.ctaSp} aria-hidden="true" />
          <Link id="lf-cta-ws" data-cta="toy_link_forge_workspaces" href={COPY.ctaSecondaryHref} className={`md-btn md-btn--ghost md-btn--md ${s.ctaBtn}`}>
            {COPY.ctaSecondary}
          </Link>
        </div>
      </div>
    </section>
  );
}
