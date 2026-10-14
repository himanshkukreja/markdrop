import LazyIsland from "../../LazyIsland";
import { ICONS } from "@/components/ui/icons";
import View from "./View";
import { initialState } from "./model";
import s from "./KeyLab.module.css";

/**
 * Landing section 3: Key Lab, "The key lives in the link" (PlayKeyLab.dc.html). The section head is
 * server HTML; the playable stage is a lazy island whose static first frame is View(initialState).
 */
export default function KeyLab() {
  return (
    <section id="key-lab" aria-labelledby="kl-title" className={s.section}>
      <div className={s.dots} aria-hidden="true" />
      <div className="relative mx-auto max-w-marketing px-4 py-16 sm:px-6 md:py-24">
        <div className={s.bighash} aria-hidden="true">
          #
        </div>
        <header className={s.head}>
          <p className={s.eyebrow}>
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="md-icon" style={{ fontSize: 14 }}>
              <path d={ICONS.key} />
            </svg>
            End-to-end encryption
          </p>
          <h2 id="kl-title" className={s.h2}>
            The key lives in <em>the link</em>
          </h2>
          <p className={s.lead}>
            Encrypt a document and the key goes after the <code>#</code> in its link. Browsers never send that part to a server, so
            Markdrop stores ciphertext it has no key for.
          </p>
        </header>
        <LazyIsland name="key-lab">
          <View state={initialState} />
        </LazyIsland>
      </div>
    </section>
  );
}
