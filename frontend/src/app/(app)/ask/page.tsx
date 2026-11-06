import type { Metadata } from "next";
import AskPage from "@/components/ask/AskPage";

export const metadata: Metadata = {
  title: "Ask · Markdrop",
  robots: { index: false, follow: false },
};

/** Ask: the assistant's own page — your conversations, the scope (Everything, a workspace, My files), live suggestions. */
export default function Page() {
  return <AskPage />;
}
