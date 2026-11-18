import type { Metadata } from "next";
import DealView from "@/components/hubspot/deals/DealView";

type Props = { params: Promise<{ wsId: string; dealId: string }> };

export const metadata: Metadata = {
  title: "Deal · Markdrop",
  robots: { index: false, follow: false },
};

/** One HubSpot deal: Overview, Calls, Assets and HubSpot activity (components/hubspot/deals). */
export default async function Page({ params }: Props) {
  const { wsId, dealId } = await params;
  return <DealView workspaceId={decodeURIComponent(wsId)} dealId={decodeURIComponent(dealId)} />;
}
