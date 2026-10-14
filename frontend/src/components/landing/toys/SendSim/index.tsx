import { Button } from "@/components/ui/primitives";
import { ICONS } from "@/components/ui/icons";
import LazyIsland from "../../LazyIsland";
import View from "./View";
import { initialState } from "./model";
import s from "./SendSim.module.css";

/**
 * Landing section 6, toy 5 of 8: "Send files device to device." Server component. The head (eyebrow,
 * H2, lead, CTA) is real server HTML outside the island; the toy's static first frame is
 * View(initialState), swapped for the game when the section nears the viewport.
 */
export default function SendSim() {
  return (
    <section id="send-sim" aria-labelledby="send-sim-title" className={s.section}>
      <div className="mx-auto max-w-marketing px-4 sm:px-6 py-16 sm:py-24">
        <header className={s.head}>
          <div>
            <p className={s.eyebrow}>
              <span className={s.eyebrowIc}>
                <svg viewBox="0 0 24 24" width={14} height={14} aria-hidden="true" focusable="false" className={s.ic}><path d={ICONS.wave} /></svg>
              </span>
              Send device to device
            </p>
            <h2 id="send-sim-title" className={s.h2}>
              Send files device to device<span className={s.dot}>.</span>
            </h2>
            <p className={s.lead}>
              Add files, press Send, then share the link or the QR code. Up to 10 people get them browser to browser, and Markdrop never stores the files.
            </p>
          </div>
          <div className={s.cta}>
            <span className={s.ctaGlow}>
              <Button href="/share" data-cta="toy_send_sim_share" variant="primary" size="lg" iconRight="arrowRight">Send a file</Button>
            </span>
          </div>
        </header>
        <LazyIsland name="send-sim" className={s.island}>
          <View state={initialState} />
        </LazyIsland>
      </div>
    </section>
  );
}
