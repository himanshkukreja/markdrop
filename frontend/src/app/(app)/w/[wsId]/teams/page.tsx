import type { Metadata } from "next";
import { Suspense } from "react";
import BrowseTeams from "@/components/teams/BrowseTeams";

type Props = { params: Promise<{ wsId: string }> };

export const metadata: Metadata = { title: "Teams · Markdrop", robots: { index: false, follow: false } };

/** Teams (components/teams). */
export default async function Page({ params }: Props) {
  const p = await params;
  return <Suspense><BrowseTeams ws={decodeURIComponent(p.wsId)} /></Suspense>;
}
