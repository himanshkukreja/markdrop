import type { Metadata } from "next";
import NewSite from "@/components/docs-sites/NewSite";

export const metadata: Metadata = {
  title: "New docs site · Markdrop",
  robots: { index: false, follow: false },
};

export default async function NewDocsSitePage({ params }: { params: Promise<{ wsId: string }> }) {
  const { wsId } = await params;
  return <NewSite wsId={decodeURIComponent(wsId)} />;
}
