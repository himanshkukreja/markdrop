import type { Metadata } from "next";
import { Suspense } from "react";
import TeamHome from "@/components/teams/TeamHome";

type Props = { params: Promise<{ wsId: string; team: string }> };

export const metadata: Metadata = { title: "Team · Markdrop", robots: { index: false, follow: false } };

/** Teams (components/teams). */
export default async function Page({ params }: Props) {
  const p = await params;
  return <Suspense><TeamHome ws={decodeURIComponent(p.wsId)} team={decodeURIComponent(p.team)} /></Suspense>;
}
