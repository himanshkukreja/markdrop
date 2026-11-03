import type { Metadata } from "next";
import NewPageScreen from "@/components/pages/NewPageScreen";

export const metadata: Metadata = {
  title: "New page · Markdrop",
  robots: { index: false, follow: false },
};

/** A new page from a template (the Create menu's "Page"). */
export default function NewPagePage() {
  return <NewPageScreen />;
}
