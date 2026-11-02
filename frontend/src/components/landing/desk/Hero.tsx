import { preload } from "react-dom";
import { ButtonLink, Icon } from "../ds";
import Desk from "./Desk";
import s from "./Desk.module.css";

const PROOF = [
  { icon: "user", text: "No account for documents" },
  { icon: "globe", text: "Opens in any browser" },
  { icon: "lock", text: "You choose who opens it" },
];

/**
 * The landing hero: what Markdrop is, in one line, over the desk. Server HTML for the copy and CTAs;
 * the desk is a client component rendered on the server in its resting state (see Desk).
 *
 * From 900px the hero is exactly one viewport under the header (Landing.module.css --land-h): the
 * copy takes what it needs and the desk is scaled to fit the rest (Desk.module.css .stage), so the
 * whole desk is on screen without scrolling at every laptop and desktop size.
 */
export default function Hero() {
  // The laptop's screen (the sample page, rendered) is the hero's largest image: fetch it first.
  preload("/landing-desk/screens/calculator.webp", { as: "image", fetchPriority: "high" });
  return (
    <section id="hero" aria-labelledby="hero-h1" className={s.wrap}>
      <div className={s.head}>
        <div className={s.title}>
          <span className={s.eyebrow}>Documents and files, shared as links</span>
          <h1 id="hero-h1" className={s.h1}>
            Drop it.{" "}
            <br className={s.br} />
            It renders.
          </h1>
          <ul className={s.proof} aria-label="Why Markdrop">
            {PROOF.map((p) => (
              <li key={p.text}>
                <Icon name={p.icon} />
                {p.text}
              </li>
            ))}
          </ul>
        </div>
        <div className={s.side}>
          <p className={s.sub}>
            Write Markdown, or drop a file you already have: an HTML page, a PDF, a spreadsheet, a Word document, a video, a zipped site. You get a link that opens in any browser, exactly as you made it.
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
