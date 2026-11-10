import type { Metadata } from "next";
import { Suspense } from "react";
import TeamHome from "@/components/teams/TeamHome";

type Props = { params: Promise<{ wsId: string; team: string }> };

export const metadata: Metadata = { title: "Team settings · Markdrop", robots: { index: false, follow: false } };

/** Teams: Team settings opens as a dialog over the team's home (components/teams/TeamDialog). */
export default async function Page({ params }: Props) {
  const p = await params;
  return <Suspense><TeamHome ws={decodeURIComponent(p.wsId)} team={decodeURIComponent(p.team)} settings /></Suspense>;
}
