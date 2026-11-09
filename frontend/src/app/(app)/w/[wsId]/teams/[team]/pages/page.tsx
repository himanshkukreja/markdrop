import type { Metadata } from "next";
import { Suspense } from "react";
import { TeamPages } from "@/components/teams/TeamSpaces";

type Props = { params: Promise<{ wsId: string; team: string }> };

export const metadata: Metadata = { title: "Team pages · Markdrop", robots: { index: false, follow: false } };

/** Teams (components/teams). */
export default async function Page({ params }: Props) {
  const p = await params;
  return <Suspense><TeamPages ws={decodeURIComponent(p.wsId)} team={decodeURIComponent(p.team)} /></Suspense>;
}
