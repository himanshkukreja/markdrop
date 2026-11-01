import type { Metadata } from "next";
import ChangelogScreen from "@/components/docs-sites/changelog/ChangelogScreen";

export const metadata: Metadata = { title: "Changelog" };

/** The guide's changelog: entries (?entry=<id>|new opens one), Coming next, products, preview. */
export default function Page() {
  return <ChangelogScreen />;
}
