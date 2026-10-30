import type { Metadata } from "next";
import SiteSettings from "@/components/docs-sites/SiteSettings";

export const metadata: Metadata = { title: "Settings" };

/** Address, own domain, Ask AI, access, search indexing, reviews, redirects, unpublish and delete. */
export default function Page() {
  return <SiteSettings />;
}
