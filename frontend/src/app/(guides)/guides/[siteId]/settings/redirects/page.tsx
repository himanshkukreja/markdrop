import type { Metadata } from "next";
import RedirectsSection from "@/components/docs-sites/settings/RedirectsSection";

export const metadata: Metadata = { title: "Redirects · Settings" };

/** Settings › Redirects: old addresses that send readers to the right page. */
export default function Page() {
  return <RedirectsSection />;
}
