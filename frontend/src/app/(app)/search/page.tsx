import type { Metadata } from "next";
import SearchPage from "@/components/search/SearchPage";

export const metadata: Metadata = {
  title: "Search · Markdrop",
  robots: { index: false, follow: false },
};

/** Global search: every result, with filters and the AI answer. */
export default function Page() {
  return <SearchPage />;
}
