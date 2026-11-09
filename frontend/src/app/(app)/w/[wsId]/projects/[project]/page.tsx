import type { Metadata } from "next";
import { Suspense } from "react";
import { ProjectHome } from "@/components/teams/TeamSpaces";

type Props = { params: Promise<{ wsId: string; project: string }> };

export const metadata: Metadata = { title: "Project · Markdrop", robots: { index: false, follow: false } };

/** Teams (components/teams). */
export default async function Page({ params }: Props) {
  const p = await params;
  return <Suspense><ProjectHome ws={decodeURIComponent(p.wsId)} project={decodeURIComponent(p.project)} /></Suspense>;
}
