import type { Metadata } from "next";
import { Suspense } from "react";
import { TeamFiles } from "@/components/teams/TeamFiles";

type Props = { params: Promise<{ wsId: string; team: string }> };

export const metadata: Metadata = { title: "Files & pages · Markdrop", robots: { index: false, follow: false } };

/** A team's Files & pages: its folder / page tree (components/teams/TeamFiles). */
export default async function Page({ params }: Props) {
  const p = await params;
  return <Suspense><TeamFiles ws={decodeURIComponent(p.wsId)} team={decodeURIComponent(p.team)} /></Suspense>;
}
