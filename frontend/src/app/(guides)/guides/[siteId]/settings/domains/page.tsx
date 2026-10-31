import type { Metadata } from "next";
import DomainsSection from "@/components/docs-sites/settings/DomainsSection";

export const metadata: Metadata = { title: "Domains · Settings" };

/** Settings › Domains: the guide's addresses: its own domains and the free address. */
export default function Page() {
  return <DomainsSection />;
}
