import { MarkdropMark } from "../orbit/ds";
import SlugStart from "./SlugStart";
import s from "./Closing.module.css";

/**
 * Landing section 10, the closing CTA (Landing.dc.html S8 / MobileLanding.dc.html S8): "Your link could
 * look like this." Server component: the mark and the heading are server HTML; the slug form is a tiny
 * client island that still works without JS (a plain GET form to /new?slug=).
 */
export default function ClosingCta() {
  return (
    <section id="start" aria-labelledby="closing-title" className={s.section} data-closing-cta="">
      <span className={s.mark}>
        <MarkdropMark size={96} />
      </span>
      <h2 id="closing-title" className={s.h2}>
        Your link could look like this.
      </h2>
      <SlugStart />
    </section>
  );
}
