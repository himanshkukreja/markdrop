"use client";

import { useEffect } from "react";
import { setAnalyticsDoc, type DocContext } from "@/lib/thirdPartyAnalytics";

/**
 * Tell analytics which document is open (lib/thirdPartyAnalytics): its opaque ref, kind and access.
 * Passing null does nothing, so a parent that hands the page to a child viewer (DocumentView →
 * ArtifactView) never clears what the child reported; unmounting clears it.
 */
export function useAnalyticsDoc(ctx: DocContext | null) {
  const key = ctx ? `${ctx.ref}|${ctx.kind}|${ctx.access}` : "";
  useEffect(() => {
    if (!ctx) return;
    setAnalyticsDoc(ctx);
    return () => setAnalyticsDoc(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures ctx
  }, [key]);
}
