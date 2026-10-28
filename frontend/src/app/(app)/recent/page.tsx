import type { Metadata } from "next";
import PersonalItems from "@/components/workspace/PersonalItems";

export const metadata: Metadata = {
  title: "Recent · Markdrop",
  robots: { index: false, follow: false },
};

/** What you opened lately. */
export default function RecentPage() {
  return <PersonalItems mode="recent" />;
}
