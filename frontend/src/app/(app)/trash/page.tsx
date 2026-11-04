import type { Metadata } from "next";
import TrashList from "@/components/trash/TrashList";

export const metadata: Metadata = {
  title: "Trash · Markdrop",
  robots: { index: false, follow: false },
};

/** Deleted items, for 30 days. */
export default function TrashPage() {
  return <TrashList />;
}
