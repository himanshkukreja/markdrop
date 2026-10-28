import type { Metadata } from "next";
import LiveNow from "@/components/analytics/LiveNow";

export const metadata: Metadata = {
  title: "Live now · Analytics · Markdrop",
  robots: { index: false, follow: false },
};

/** Who is on your links right now (polls every 10 s while visible). */
export default function LiveAnalyticsPage() {
  return <LiveNow />;
}
