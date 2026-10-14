import LazyIsland from "../../LazyIsland";
import { ICONS } from "@/components/ui/icons";
import View from "./View";
import { initialState } from "./model";
import s from "./DomainStudio.module.css";

/**
 * Landing section 6, Domain Studio (board: design/revamp-canvas/PlayDomainStudio.dc.html).
 * Server component: the section head is plain server HTML, and the toy's static first frame
 * (View at its initial state) is swapped for the playable Game when the section nears the viewport.
 */
export default function DomainStudio() {
  return (
    <section id="domain-studio" aria-labelledby="domain-studio-title" className={s.section}>
      <div className={s.bgfx} aria-hidden="true" />
      <div className={`${s.inner} mx-auto max-w-marketing px-4 sm:px-6`}>
        <header className={s.hd}>
          <p className={s.eyb}>
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="md-icon" style={{ fontSize: 14 }}>
              <path d={ICONS.globe} />
            </svg>
            Workspaces
          </p>
          <h2 id="domain-studio-title" className={s.h2}>
            Your domain. Your brand.
          </h2>
          <p className={s.lead}>Publish on your own domain, with your logo, your accent and your rules for who can read what.</p>
        </header>
        <LazyIsland name="domain-studio">
          <View state={initialState} />
        </LazyIsland>
      </div>
    </section>
  );
}
