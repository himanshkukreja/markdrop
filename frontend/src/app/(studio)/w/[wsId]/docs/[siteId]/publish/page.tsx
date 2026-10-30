import type { Metadata } from "next";
import PublishScreen from "@/components/docs-sites/PublishScreen";

export const metadata: Metadata = {
  title: "Publish · Docs site · Markdrop",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <PublishScreen />;
}
