import type { Metadata } from "next";
import SitesList from "@/components/docs-sites/SitesList";

export const metadata: Metadata = {
  title: "Docs sites · Markdrop",
  robots: { index: false, follow: false },
};

/** A workspace's docs sites (Main board): cards, "New docs site", the free plan's usage. */
export default async function DocsSitesPage({ params }: { params: Promise<{ wsId: string }> }) {
  const { wsId } = await params;
  return <SitesList key={wsId} wsId={decodeURIComponent(wsId)} />;
}
