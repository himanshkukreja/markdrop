import type { Metadata } from "next";
import AnalyticsHome from "@/components/analytics/AnalyticsHome";

export const metadata: Metadata = {
  title: "Analytics · Markdrop",
  robots: { index: false, follow: false },
};

/** Everything you've published: views, people, engagement and what stands out. */
export default function AnalyticsPage() {
  return <AnalyticsHome />;
}
