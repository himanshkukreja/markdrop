import type { Metadata } from "next";
import RequestReview from "@/components/access/RequestReview";

export const metadata: Metadata = {
  title: "Access request · Markdrop",
  robots: { index: false, follow: false },
};

/** Where an access-request email's buttons land: the owner reviews and decides here. */
export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RequestReview id={decodeURIComponent(id)} />;
}
