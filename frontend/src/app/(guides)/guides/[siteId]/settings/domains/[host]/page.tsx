import { Suspense } from "react";
import type { Metadata } from "next";
import DomainSetup from "@/components/docs-sites/settings/DomainSetup";

// The title doesn't name the domain: it's the customer's, and titles reach history and analytics.
export const metadata: Metadata = { title: "Your domain · Settings" };

/** Settings › Domains › one domain: connect its DNS, then its live status (steps 2 and 3). */
export default async function Page({ params }: { params: Promise<{ host: string }> }) {
  const { host } = await params;
  return (
    <Suspense>
      <DomainSetup host={decodeURIComponent(host)} />
    </Suspense>
  );
}
