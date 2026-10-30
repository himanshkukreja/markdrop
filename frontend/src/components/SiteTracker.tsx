"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { trackPageview } from "@/lib/track";
import { isDocsHost } from "@/docs/host";

/**
 * Reports a page view on every route change. usePathname (unlike
 * useSearchParams) doesn't take the route out of static prerendering.
 */
export default function SiteTracker() {
  const pathname = usePathname();
  useEffect(() => {
    // The docs host isn't wired into first-party analytics yet (the beat API doesn't accept its origin).
    if (pathname && !isDocsHost(location.hostname)) trackPageview(pathname);
  }, [pathname]);
  return null;
}
