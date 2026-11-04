"use client";

import { useLayoutEffect } from "react";
import { MarkdropLogo, Skeleton } from "@/components/ui";
import MarkdropLoader from "@/components/MarkdropLoader";
import { OPENING_ATTR, OPENING_SCRIPT, openingEnded, openingNow, openingStarted } from "@/lib/opening";
import vs from "./viewer.module.css";

/**
 * What a signed-in reader sees while their own read of a gated item is in flight (lib/opening):
 * never the anonymous locked view under it. Hidden unless <html> carries data-md-opening, which
 * OPENING_SCRIPT sets before the first paint (server render) and the layout effect sets on a
 * client-side mount; a stranger (no session) sees the locked view as before.
 *
 *   page  the page's own screen: the rail with the logo (wide screens), the one 48 px bar, the paper
 *   else  the brand loader, after the usual 300 ms grace, on the ground a document's full-screen
 *         reader and a file's frame open on (the file's frame cover then carries the loader on)
 *
 * The cover goes when the read answers: the item itself, or the gate when it's refused.
 */
export function OpeningCover({ tenant }: { tenant: boolean }) {
  useLayoutEffect(() => {
    const d = document.documentElement;
    if (!d.hasAttribute(OPENING_ATTR)) {
      const k = openingNow();
      if (k) d.setAttribute(OPENING_ATTR, k);
    }
    if (d.hasAttribute(OPENING_ATTR)) openingStarted();
    return () => openingEnded();
  }, []);

  return (
    <div className={vs.opening} data-opening-cover="">
      <script dangerouslySetInnerHTML={{ __html: OPENING_SCRIPT }} />
      <div className={vs.openingAny}>
        <div className={vs.openingLoader}>
          <MarkdropLoader label="" hideWordmark size="md" delay={0} />
        </div>
      </div>
      <div className={vs.openingPage}>
        <div className={vs.openingRail}>
          <div className={vs.openingRailHead}>{!tenant && <MarkdropLogo size={24} wordmark href="/" />}</div>
          <div className="flex flex-col gap-2.5 pt-3">
            {[70, 55, 62].map((w, i) => <Skeleton key={i} width={`${w}%`} height={12} />)}
          </div>
        </div>
        <div className={vs.openingPaper}>
          <div className={vs.openingBar}>
            <span className={vs.openingBarBtn} />
            <span className={vs.openingBrand}>{!tenant && <MarkdropLogo size={24} wordmark={false} href="/" />}</span>
            <Skeleton width={180} height={14} />
            <span className="flex-1" />
            <Skeleton variant="circle" height={28} />
          </div>
          <div className={vs.openingCol}>
            <Skeleton width="55%" height={40} />
            <div className="mt-8 flex flex-col gap-3">
              {[100, 94, 97, 72, 100, 90, 96, 58].map((w, i) => <Skeleton key={i} width={`${w}%`} />)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
