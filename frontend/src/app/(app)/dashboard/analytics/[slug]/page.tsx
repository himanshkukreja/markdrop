import type { Metadata } from "next";
import DocAnalytics from "@/components/analytics/DocAnalytics";

export const metadata: Metadata = {
  title: "Analytics · Markdrop",
  robots: { index: false, follow: false },
};

/** One document's analytics, with tabs by kind (?tab=), range (?range=) and ?internal=1. */
export default async function DocAnalyticsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <DocAnalytics key={slug} slug={decodeURIComponent(slug)} />;
}
