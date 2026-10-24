import type { Metadata } from "next";
import ConnectionsClient from "./ConnectionsClient";

export const metadata: Metadata = {
  title: "Connected apps · Markdrop",
  robots: { index: false, follow: false },
};

export default function ConnectionsPage() {
  return <ConnectionsClient />;
}
