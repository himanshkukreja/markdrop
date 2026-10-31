import type { Metadata } from "next";
import AccessSection from "@/components/docs-sites/settings/AccessSection";

export const metadata: Metadata = { title: "Readers and access · Settings" };

/** Settings › Readers and access: who can read the guide, and whether search engines index it. */
export default function Page() {
  return <AccessSection />;
}
