import { Suspense } from "react";
import type { Metadata } from "next";
import DomainSetup from "@/components/docs-sites/settings/DomainSetup";

export const metadata: Metadata = { title: "Add your own domain · Settings" };

/** Settings › Domains › add one (step 1 of 3; ?host= prefills it). */
export default function Page() {
  return (
    <Suspense>
      <DomainSetup host={null} />
    </Suspense>
  );
}
