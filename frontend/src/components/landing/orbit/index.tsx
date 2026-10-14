import LazyIsland from "../LazyIsland";
import S from "./Orbit.module.css";
import View from "./View";
import { initialState } from "./model";
import { ButtonLink, DropSvg, Icon, MarkdropMark } from "./ds";
import { k } from "./scenes";

/**
 * The landing hero: the Orbit playground (design/revamp-canvas/PlayFinal + PlayFinalMobile).
 *
 * Server component. The copy column (badge, the static H1 that is the LCP element, subhead, CTAs,
 * caption) is plain server HTML and never animates in. The playable world is a LazyIsland whose
 * children are the static first frame for both layouts (CSS shows one): the planet, the moons in their
 * resting seats and the intro card. The game chunk loads when the browser is idle after first paint.
 * The section starts behind the 56px transparent marketing header (O11) so the glow bleeds up under it.
 */
export default function Hero() {
  return (
    <section id="hero" className={k("hero")} aria-labelledby="hero-h1">
      <div className={k("grid")}>
        <div className={k("copy")}>
          <span className={k("kicker")}><MarkdropMark size={18} />No login. No friction. Just links.</span>
          <h1 id="hero-h1" className={k("h1")}>
            <span className={k("h1-l")}>Drop it.</span>{" "}
            <span className={k("h1-l")}>It renders<span className={k("h1-end")}>.<span className={k("hdrop")} aria-hidden="true"><DropSvg w={14} h={18} pathCls={k("drop-p")} /></span><span className={k("hrip")} aria-hidden="true" /></span></span>
          </h1>
          <p className={k("sub")}>Markdown, AI write-ups, HTML pages, PDFs, spreadsheets, Word docs, video and zipped sites become links that open rendered in any browser.</p>
          <div className={k("ctas")}>
            <span className={k("cta-wrap")}><ButtonLink href="/new" variant="primary" iconRight="arrowRight" data-cta="hero_start">Start writing</ButtonLink></span>
            <ButtonLink href="/upload" variant="secondary" iconLeft="upload" data-cta="hero_upload">Upload a file</ButtonLink>
          </div>
          <p className={k("cap")}><span className={k("cap-ok")}><Icon name="check" size={14} /></span>Markdown never needs an account. Files need a free one.</p>
        </div>
        <LazyIsland name="hero" when="idle" className={S.island}>
          <View state={initialState("desktop")} form="desktop" />
          <View state={initialState("mobile")} form="mobile" />
        </LazyIsland>
      </div>
    </section>
  );
}
