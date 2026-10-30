"use client";

import { useLayoutEffect, useState } from "react";

/**
 * Wraps Markdrop's own trackers in the root layout (Vercel Analytics and Speed Insights, the
 * first-party page view, PostHog/GA). A docs site that isn't Markdrop's marks its root
 * `data-docs-trackers="off"` (docs-site/layout.tsx, from site.json `integrations.markdropApp`), and
 * then none of them run there. Everywhere else, Markdrop's own docs included, this renders its
 * children unchanged: the server output is the same either way.
 *
 * Checked in a layout effect, which unmounts the trackers before they do anything deferred. A
 * tracker that acts in its first passive effect (SiteTracker's page view) can still run before that
 * re-render lands, so it also checks `appTrackersOff()` itself.
 */
export function appTrackersOff(): boolean {
  return typeof document !== "undefined" && !!document.querySelector('[data-docs-trackers="off"]');
}

export function AppTrackers({ children }: { children: React.ReactNode }) {
  const [on, setOn] = useState(true);
  useLayoutEffect(() => {
    if (appTrackersOff()) setOn(false);
  }, []);
  return on ? children : null;
}
