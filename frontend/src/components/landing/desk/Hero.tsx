import { preload } from "react-dom";
import { ButtonLink } from "../ds";
import Desk from "./Desk";
import s from "./Desk.module.css";

/**
 * The landing hero: "Drop it. It renders." over the desk. Server HTML for the copy and CTAs; the desk
 * is a client component rendered on the server in its resting state (see Desk).
 */
export default function Hero() {
  // The laptop's screen (the sample page, rendered) is the hero's largest image: fetch it first.
  preload("/landing-desk/screens/calculator.webp", { as: "image", fetchPriority: "high" });
  return (
    <section id="hero" aria-labelledby="hero-h1" className={s.wrap}>
      <div className={s.head}>
        <div className={s.title}>
          <span className={s.eyebrow}>Docs and files as links that render</span>
          <h1 id="hero-h1" className={s.h1}>
            Drop it.
            <br />
            It renders.
          </h1>
        </div>
        <div className={s.side}>
          <p className={s.sub}>
            Notes, pages, decks, sheets and video. Drop one on Markdrop and you get a link anyone opens in a browser, exactly as you made it.
          </p>
          <div className={s.ctas}>
            <ButtonLink href="/new" variant="primary" iconRight="arrowRight" data-cta="hero_start">
              Start writing
            </ButtonLink>
            <ButtonLink href="/upload" variant="secondary" iconLeft="upload" data-cta="hero_upload">
              Upload a file
            </ButtonLink>
          </div>
        </div>
      </div>
      <Desk />
    </section>
  );
}
