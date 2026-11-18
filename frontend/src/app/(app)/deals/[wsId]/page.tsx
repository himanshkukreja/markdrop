import type { Metadata } from "next";
import DealsSection from "@/components/hubspot/deals/DealsSection";

type Props = { params: Promise<{ wsId: string }> };

export const metadata: Metadata = {
  title: "Deals · Markdrop",
  robots: { index: false, follow: false },
};

/** The HubSpot team's Deals: a board by pipeline stage (or a list) of its open deals (components/hubspot/deals). */
export default async function Page({ params }: Props) {
  const { wsId } = await params;
  // ?space=team:<id> (the sidebar's Deals row) only marks the row: the deals are the workspace's HubSpot team's.
  return <DealsSection workspaceId={decodeURIComponent(wsId)} />;
}
