import type { Metadata } from "next";
import SiteSettings from "@/components/docs-sites/SiteSettings";

export const metadata: Metadata = {
  title: "Settings · Docs site · Markdrop",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <SiteSettings />;
}
