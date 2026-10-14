import type { Metadata } from "next";
import TokensClient from "./TokensClient";

export const metadata: Metadata = {
  title: "API tokens · Markdrop",
  robots: { index: false, follow: false },
};

export default function TokensPage() {
  return <TokensClient />;
}
