"use client";

import { useEffect, useRef } from "react";
import { Badge, useToast } from "@/components/ui";
import { getSite, type SiteDomain } from "@/lib/docsSites";
import { guideEvents } from "@/lib/guidesEvents";
import { useSite } from "../SiteContext";

/** What a domain is doing, as a badge. */
export function DomainBadge({ d }: { d: SiteDomain }) {
  if (d.status === "live") return <Badge tone="success" size="sm" dot>Live</Badge>;
  if (d.status === "failed") return <Badge tone="danger" size="sm" icon="alertCircle">Problem</Badge>;
  if (d.status === "removing") return <Badge size="sm" icon="clock">Removing…</Badge>;
  if (d.stage === "certificate") return <Badge tone="info" size="sm" icon="lock">Issuing certificate</Badge>;
  return <Badge tone="warning" size="sm" icon="clock">Waiting for DNS</Badge>;
}

/** A line under the host on the Domains list. */
export function domainNote(d: SiteDomain): string {
  if (d.status === "live") return "Your domain · the main address for links and search";
  if (d.status === "failed") return "Your domain · not live: fix the DNS record, then check again";
  if (d.status === "removing") return "Your domain · being removed";
  if (d.stage === "certificate") return "Your domain · DNS is right, the certificate is on its way";
  return "Your domain · add one DNS record to finish";
}

export const ownDomains = (domains: SiteDomain[] | undefined) => (domains ?? []).filter((d) => d && d.host);

/**
 * While one of the guide's domains is on its way, refresh the guide now and then (the server does
 * the checking): quickly at first, then every `everyMs`. A domain seen going live here gets a toast
 * (and its event) once.
 */
export function useDomainRefresh(everyMs = 30_000) {
  const { site, setSite } = useSite();
  const toast = useToast();
  const seen = useRef<Map<string, string>>(new Map());
  const domains = ownDomains(site.domains);

  useEffect(() => {
    for (const d of domains) {
      const before = seen.current.get(d.host);
      if (before && before !== "live" && d.status === "live") {
        guideEvents.domainLive();
        toast.success(<><span className="ph-sensitive ph-mask">{d.host}</span> is live.</>);
      }
      seen.current.set(d.host, d.status);
    }
  }, [domains, toast]);

  const waiting = domains.some((d) => d.status === "pending" || d.status === "removing");
  const quick = domains.some((d) => d.status === "removing" || (d.status === "pending" && !d.checked_at));
  const siteId = site.id;
  useEffect(() => {
    if (!waiting) return;
    let stop = false;
    const t = window.setInterval(async () => {
      if (stop || document.visibilityState === "hidden") return;
      try {
        const fresh = await getSite(siteId);
        if (!stop) setSite(fresh);
      } catch { /* the next tick tries again */ }
    }, quick ? 4000 : everyMs);
    return () => { stop = true; window.clearInterval(t); };
  }, [waiting, quick, siteId, setSite, everyMs]);
}
