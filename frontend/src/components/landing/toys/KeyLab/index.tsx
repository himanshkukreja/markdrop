import LazyIsland from "../../LazyIsland";
import { ICONS } from "@/components/ui/icons";
import View from "./View";
import { initialState } from "./model";
import s from "./KeyLab.module.css";

/** What the toy doesn't show, said in the head: the password mode, recovery, and no third-party analytics. */
const FACTS: Array<{ icon: keyof typeof ICONS; t: string; d: string }> = [
  { icon: "lock", t: "Add a password.", d: "Readers need the link and the password, checked in their browser." },
  { icon: "link", t: "Get back in.", d: "Paste the full link, or open it in a browser that kept the key." },
  { icon: "eyeOff", t: "No analytics tools.", d: "Third-party analytics never load on an encrypted page. We only count views." },
];

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
            Encrypt a document and your browser seals it before it&rsquo;s sent. The key goes after the <code>#</code> in its link,
            which browsers never send to a server, so our servers store only the encrypted text and never receive the key.
          </p>
          <ul className={s.facts} aria-label="Also part of encryption">
            {FACTS.map((f) => (
              <li key={f.t} className={s.fact}>
                <span className={s.factIc}>
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="md-icon">
                    <path d={ICONS[f.icon]} />
                  </svg>
                </span>
                <span>
                  <b>{f.t}</b> {f.d}
                </span>
              </li>
            ))}
          </ul>
        </header>
        <LazyIsland name="key-lab">
          <View state={initialState} />
        </LazyIsland>
      </div>
    </section>
  );
}
