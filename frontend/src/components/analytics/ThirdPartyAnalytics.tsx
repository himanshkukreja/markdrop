"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { thirdPartyAnalyticsHost } from "@/lib/analyticsConfig";
import { CONSENT_OPEN_EVENT, resolveConsent, setConsent } from "@/lib/consent";
import { onRoute, pauseRecordingFor, startThirdParty } from "@/lib/thirdPartyAnalytics";
import { trackingDisabled } from "@/lib/track";

const ConsentBanner = dynamic(() => import("./ConsentBanner"), { ssr: false });

/**
 * Mounts PostHog and Google Analytics (lib/thirdPartyAnalytics) once the page is idle and consent
 * is known, reports route changes, and shows the consent prompt where it applies. Renders nothing
 * on the server, so every route stays static. usePathname, not useSearchParams.
 */
export default function ThirdPartyAnalytics() {
  const pathname = usePathname();
  const [ask, setAsk] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!thirdPartyAnalyticsHost() || trackingDisabled()) return;
    let cancelled = false;
    const start = () => {
      void resolveConsent().then(({ mode, ask: needsAsk }) => {
        if (cancelled) return;
        setAsk(needsAsk);
        setActive(true);
        void startThirdParty(mode);
      });
    };
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(start, { timeout: 3000 });
    else setTimeout(start, 1500);
    const reopen = () => setAsk(true);
    window.addEventListener(CONSENT_OPEN_EVENT, reopen);
    return () => {
      cancelled = true;
      window.removeEventListener(CONSENT_OPEN_EVENT, reopen);
    };
  }, []);

  useLayoutEffect(() => {
    if (active && pathname) pauseRecordingFor(pathname);
  }, [active, pathname]);

  useEffect(() => {
    if (active && pathname) onRoute(pathname);
  }, [active, pathname]);

  const choose = useCallback((granted: boolean) => {
    setConsent(granted ? "granted" : "denied");
    setAsk(false);
    void startThirdParty(granted ? "full" : "limited");
  }, []);

  if (!ask || pathname?.startsWith("/admin")) return null;
  return <ConsentBanner onChoose={choose} />;
}
