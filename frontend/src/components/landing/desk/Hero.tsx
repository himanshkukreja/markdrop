import { preload } from "react-dom";
import { ButtonLink } from "../ds";
import HeroDesk from "./HeroDesk";
import TrailerButton, { type Trailer } from "../TrailerButton";
import s from "./Hero.module.css";
import { SnapSection } from "@/components/marketing/snap/Snap";

/** Feature video 01, the Markdrop overview (public/docs-assets/videos; the same file What is Markdrop plays). */
const OVERVIEW: Trailer = {
  src: "/docs-assets/videos/series-01-overview.mp4",
  poster: "/docs-assets/videos/series-01-overview.webp",
  title: "Markdrop in two and a half minutes",
  duration: "2:31",
  chaptersSrc: "/docs-assets/videos/series-01-overview.vtt",
  captionsSrc: "/docs-assets/videos/series-01-overview.captions.vtt",
  w: 1920,
  h: 1080,
};

/**
 * The landing hero, "Your desk, as links." (design canvas round 4, Hero C · Desk, simplified): the
 * copy on the left, vertically centred with the desk mat on the right. Server HTML for the copy and
 * CTAs; the desk is a client component rendered on the server at rest (see HeroDesk). "Watch the
 * overview" is a small island: the player and the video load only when it's clicked.
 *
 * From 1024px the hero is one viewport under the header, drawn at the artboard's 1280 × 720 and
 * zoomed to the window (Hero.module.css .canvas); phones get the stacked phone artboard.
 */
export default function Hero() {
  // The laptop's screen at rest (launch.html's render, as its poster) is the hero's LCP image.
  preload("/landing-desk/hero/html.webp", { as: "image", fetchPriority: "high", media: "(min-width: 600px)" });
  preload("/landing-desk/hero/html.phone.webp", { as: "image", fetchPriority: "high", media: "(max-width: 599px)" });
  return (
    <SnapSection id="hero" labelledBy="hero-h1" bare className={s.hero}>
      <div className={s.canvas}>
        <div className={s.grid}>
          <div className={s.copy}>
            <span className={s.eyebrow}>Docs and files as links that render</span>
            <h1 id="hero-h1" className={s.h1}>
              Your desk,
              <br />
              as links.
            </h1>
            <p className={s.sub}>Notes, pages, decks, sheets and video. Drop one on Markdrop and anyone opens it in a browser, exactly as you made it.</p>
            <div className={s.ctas}>
              <ButtonLink href="/new" variant="primary" iconRight="arrowRight" data-cta="hero_start">
                Start writing
              </ButtonLink>
              <ButtonLink href="/upload" variant="secondary" iconLeft="upload" data-cta="hero_upload">
                Upload a file
              </ButtonLink>
            </div>
            <span className={s.cap}>Documents need no account. Files need a free one.</span>
            <TrailerButton
              trailer={OVERVIEW}
              className={s.watch}
              cta="hero_overview"
              label={
                <>
                  Watch the overview
                  <span className={s.watchTime} aria-hidden>
                    · {OVERVIEW.duration}
                  </span>
                </>
              }
            />
          </div>
          <HeroDesk />
        </div>
      </div>
    </SnapSection>
  );
}
