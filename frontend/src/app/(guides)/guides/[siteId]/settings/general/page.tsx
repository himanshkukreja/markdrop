import type { Metadata } from "next";
import GeneralSection from "@/components/docs-sites/settings/GeneralSection";

export const metadata: Metadata = { title: "General · Settings" };

/** Settings › General: the guide's name, its free address, its logo, where it started and GitHub sync. */
export default function Page() {
  return <GeneralSection />;
}
