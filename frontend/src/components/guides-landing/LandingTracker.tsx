"use client";

import { useEffect } from "react";
import { guideEvents } from "@/lib/guidesEvents";
import { TOKEN_KEY_FOR_VIEW } from "./view";

/** Where every "start" button goes once we know the visitor is signed in (else: sign in first). */
const NEW_GUIDE = "/guides/new";

/**
 * The landing page's analytics and its one bit of sign-in awareness, from one listener:
 *   - guide_landing_viewed once;
 *   - guide_landing_cta {id, section, pillar?} for every [data-cta] click (server HTML included, so
 *     clicks count before any island loads). A pillar card's button carries data-pillar: that is
 *     the landing test's per-pillar interest count;
 *   - guide_landing_demo {step: "used"} the first time focus moves into the live calculator (its
 *     frame is sandboxed, so this is all the page can know about it, by design);
 *   - signed in (the ?about=1 view): the start buttons go straight to a new guide.
 * Ids and enums only, never anything typed.
 */
export default function LandingTracker() {
  useEffect(() => {
    guideEvents.landingViewed();
    try {
      if (localStorage.getItem(TOKEN_KEY_FOR_VIEW)) {
        document.querySelectorAll<HTMLAnchorElement>("a[data-start]").forEach((a) => a.setAttribute("href", NEW_GUIDE));
      }
    } catch { /* storage off: keep the sign-in links */ }

    const onClick = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.("[data-cta]");
      if (!el || !el.closest("[data-guides-landing]")) return;
      const raw = el.getAttribute("data-cta") || "other";
      const id = raw === "guides_tour" ? "tour" : raw;
      const section = el.closest("section[id]")?.id || "page";
      guideEvents.landingCta(id, section, el.getAttribute("data-pillar"));
    };
    let used = false;
    const onBlur = () => {
      if (used) return;
      // Focus left the page for a frame: was it the live demo?
      window.setTimeout(() => {
        if (document.activeElement?.matches?.("iframe[data-live-demo]")) {
          used = true;
          guideEvents.landingDemo("used");
        }
      }, 0);
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  return null;
}
