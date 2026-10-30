import type { Metadata } from "next";
import ImportProgress from "@/components/docs-sites/ImportProgress";

export const metadata: Metadata = {
  title: "Import · Docs site · Markdrop",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <ImportProgress />;
}
