import type { Metadata } from "next";
import FixListScreen from "@/components/docs-sites/FixListScreen";

export const metadata: Metadata = { title: "Fix list" };

/** What to fix next in the guide, ranked by how many readers it affects (from Insights and reader signals). */
export default function Page() {
  return <FixListScreen />;
}
