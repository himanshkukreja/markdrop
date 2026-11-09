import type { Metadata } from "next";
import { Suspense } from "react";
import TeamsReview from "@/components/teams/TeamsReview";

type Props = { params: Promise<{ wsId: string }> };

export const metadata: Metadata = { title: "Sort content into teams · Markdrop", robots: { index: false, follow: false } };

/** Teams (components/teams). */
export default async function Page({ params }: Props) {
  const p = await params;
  return <Suspense><TeamsReview ws={decodeURIComponent(p.wsId)} /></Suspense>;
}
