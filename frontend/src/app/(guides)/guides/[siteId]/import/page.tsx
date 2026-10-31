import type { Metadata } from "next";
import ImportProgress from "@/components/docs-sites/ImportProgress";

export const metadata: Metadata = { title: "Import" };

/** The GitBook import (?job=<id>, else the site's last import): live steps, then the report. */
export default function Page() {
  return <ImportProgress />;
}
