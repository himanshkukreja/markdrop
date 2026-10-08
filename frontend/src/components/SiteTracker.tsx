"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { trackPageview } from "@/lib/track";

/**
 * Reports a page view on every route change. usePathname (unlike
 * useSearchParams) doesn't take the route out of static prerendering.
 */
export default function SiteTracker() {
  const pathname = usePathname();
  useEffect(() => {
    if (pathname) trackPageview(pathname);
  }, [pathname]);
  return null;
}
