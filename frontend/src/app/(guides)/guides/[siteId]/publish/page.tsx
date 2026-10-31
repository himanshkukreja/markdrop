import type { Metadata } from "next";
import PublishScreen from "@/components/docs-sites/PublishScreen";

export const metadata: Metadata = { title: "Publish" };

/** What changed since the last publish, Publish (or submit for review), reviews and every published version. */
export default function Page() {
  return <PublishScreen />;
}
