import type { Metadata } from "next";
import InsightsScreen from "@/components/docs-sites/InsightsScreen";

export const metadata: Metadata = { title: "Insights" };

/** How readers use the published guide: views, pages, referrers, searches, Ask AI questions and feedback. */
export default function Page() {
  return <InsightsScreen />;
}
