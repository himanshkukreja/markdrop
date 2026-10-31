import type { Metadata } from "next";
import DangerSection from "@/components/docs-sites/settings/DangerSection";

export const metadata: Metadata = { title: "Take it down · Settings" };

/** Settings › Take it down: unpublish or delete the guide. */
export default function Page() {
  return <DangerSection />;
}
