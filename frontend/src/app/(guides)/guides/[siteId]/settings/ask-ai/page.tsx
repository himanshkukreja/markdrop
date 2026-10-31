import type { Metadata } from "next";
import AskAiSection from "@/components/docs-sites/settings/AskAiSection";

export const metadata: Metadata = { title: "Ask AI · Settings" };

/** Settings › Ask AI: ask AI on the guide: on or off, usage, its name and suggested questions. */
export default function Page() {
  return <AskAiSection />;
}
