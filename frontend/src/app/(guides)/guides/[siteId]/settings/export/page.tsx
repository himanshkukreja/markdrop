import type { Metadata } from "next";
import ExportSection from "@/components/docs-sites/settings/ExportSection";

export const metadata: Metadata = { title: "Export & self-host · Settings" };

/** Settings › Export & self-host: download the guide as a content folder, and how to serve it yourself. */
export default function Page() {
  return <ExportSection />;
}
