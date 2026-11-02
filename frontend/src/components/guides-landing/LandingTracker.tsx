"use client";

import { useEffect } from "react";
import { guideEvents } from "@/lib/guidesEvents";
import { studioUrl } from "@/lib/studioHost";
import { TOKEN_KEY_FOR_VIEW } from "./view";

/** Studio path of the studio home (lib/studioHost): where "Open your guides" goes. */
const STUDIO_HOME = "/";

/** The text of a start link (its first non-blank text node), so its label can change. */
function labelNode(a: HTMLAnchorElement): Text | null {
  const walker = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.trim()) return n as Text;
  return null;
}

/**
 * The landing page's analytics and its one bit of sign-in awareness, from one listener:
 *   - guide_landing_viewed once;
 *   - guide_landing_cta {id, section, pillar?} for every [data-cta] click (server HTML included, so
 *     clicks count before any island loads). A pillar card's button carries data-pillar: that is
 *     the landing test's per-pillar interest count;
 *   - every start link (a[data-start], a studio path) points at the studio on this host (the static
 *     HTML has guides.markdrop.in's; locally it is /guides/…). Signed in, the "Start a guide"
 *     buttons ([data-signed-in-label]) become "Open your guides", to the studio home.
 * Ids and enums only, never anything typed.
 */
export default function LandingTracker() {
  useEffect(() => {
    guideEvents.landingViewed();
    let signedIn = false;
    try {
      signedIn = !!localStorage.getItem(TOKEN_KEY_FOR_VIEW);
    } catch { /* storage off: signed out */ }
    document.querySelectorAll<HTMLAnchorElement>("a[data-start]").forEach((a) => {
      const label = a.getAttribute("data-signed-in-label");
      if (signedIn && label) {
        a.setAttribute("href", studioUrl(STUDIO_HOME));
        a.setAttribute("data-cta", "open");
        const text = labelNode(a);
        if (text) text.textContent = label;
        return;
      }
      a.setAttribute("href", studioUrl(a.getAttribute("data-start") || "/new"));
    });

    const onClick = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.("[data-cta]");
      if (!el || !el.closest("[data-guides-landing]")) return;
      const raw = el.getAttribute("data-cta") || "other";
      const id = raw === "guides_tour" ? "tour" : raw;
      const section = el.closest("section[id]")?.id || "page";
      guideEvents.landingCta(id, section, el.getAttribute("data-pillar"));
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  return null;
}
