import type { Metadata } from "next";
import NewSite from "@/components/docs-sites/NewSite";

export const metadata: Metadata = { title: "New guide" };

/** A new guide: where it lives (a workspace you admin, or personal), how it starts, its name and address. */
export default function Page() {
  return <NewSite />;
}
