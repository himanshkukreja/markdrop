import { ButtonLink, MarkdropMark } from "../ds";
import s from "./Sections.module.css";
import { SnapSection } from "@/components/marketing/snap/Snap";

/** 8 · "Clear your desk." The closing CTA. Server HTML, no script. */
export default function ClearDesk() {
  return (
    <SnapSection id="start" labelledBy="start-h">
      <div className={s.cta}>
        <span className={s.ctaSticky} aria-hidden="true">
          markdrop.in/
          <br />
          <span>your-turn</span>
        </span>
        <span className={s.ctaMark} aria-hidden="true">
          <span className={s.ctaRing} />
          <span style={{ display: "inline-flex", filter: "drop-shadow(var(--shadow-glow))" }}>
            <MarkdropMark size={72} />
          </span>
        </span>
        <h2 id="start-h" className={s.ctaH}>
          Clear your desk.
        </h2>
        <p className={s.lede} style={{ textAlign: "center" }}>Write a document now, no account needed. Files need a free account: sign in with Google or an email code.</p>
        <div className={s.btnRow} style={{ justifyContent: "center", marginTop: 8 }}>
          <ButtonLink href="/new" variant="primary" iconRight="arrowRight" data-cta="start_write">
            Start writing
          </ButtonLink>
          <ButtonLink href="/upload" variant="secondary" iconLeft="upload" data-cta="start_upload">
            Upload a file
          </ButtonLink>
        </div>
      </div>
    </SnapSection>
  );
}
