import type { Metadata } from "next";
import DealsSection from "@/components/hubspot/deals/DealsSection";

export const metadata: Metadata = {
  title: "Deals · Markdrop",
  robots: { index: false, follow: false },
};

/** Deals across all your HubSpot teams (the sidebar's top "Deals"): the same board and list with a Team filter;
 *  /deals?team=<workspace id> opens it filtered to that workspace's HubSpot team (components/hubspot/deals). */
export default function Page() {
  return <DealsSection />;
}
