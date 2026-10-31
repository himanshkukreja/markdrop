import type { Metadata } from "next";
import CompareScreen from "@/components/docs-sites/publish/CompareScreen";

export const metadata: Metadata = { title: "What changed" };

/** Two publishes, or the live publish and the drafts, side by side: pages added, edited, removed and a line diff. */
export default function Page() {
  return <CompareScreen />;
}
