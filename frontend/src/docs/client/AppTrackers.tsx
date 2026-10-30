"use client";

import { useLayoutEffect, useState } from "react";

/**
 * Wraps Markdrop's own trackers in the root layout (Vercel Analytics and Speed Insights, the
 * first-party page view, PostHog/GA). A docs site that isn't Markdrop's marks its root
 * `data-docs-trackers="off"` (docs-site/layout.tsx, from site.json `integrations.markdropApp`), and
 * then none of them run there. Everywhere else, Markdrop's own docs included, this renders its
 * children unchanged: the server output is the same either way.
 *
 * Checked in a layout effect, which runs before any passive effect, so a tracker never starts on a
 * page it shouldn't (the trackers start in passive effects, and Vercel's render client-side only).
 */
export function AppTrackers({ children }: { children: React.ReactNode }) {
  const [on, setOn] = useState(true);
  useLayoutEffect(() => {
    if (document.querySelector('[data-docs-trackers="off"]')) setOn(false);
  }, []);
  return on ? children : null;
}
