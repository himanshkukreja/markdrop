import type { Metadata } from "next";
import PeopleSection from "@/components/docs-sites/settings/PeopleSection";

export const metadata: Metadata = { title: "People and reviews · Settings" };

/** Settings › People and reviews: roles on this guide, and whether changes need a review. */
export default function Page() {
  return <PeopleSection />;
}
