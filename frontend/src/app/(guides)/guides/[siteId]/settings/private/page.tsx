import type { Metadata } from "next";
import PrivateSection from "@/components/docs-sites/settings/PrivateSection";

export const metadata: Metadata = { title: "Private pages · Settings" };

/** Settings › Private pages: rules, group access, access requests, preview as, history. */
export default function Page() {
  return <PrivateSection />;
}
