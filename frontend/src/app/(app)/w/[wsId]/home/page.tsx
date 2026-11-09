import type { Metadata } from "next";
import { Suspense } from "react";
import { CompanyHome } from "@/components/teams/TeamSpaces";

type Props = { params: Promise<{ wsId: string }> };

export const metadata: Metadata = { title: "Home · Markdrop", robots: { index: false, follow: false } };

/** Teams (components/teams). */
export default async function Page({ params }: Props) {
  const p = await params;
  return <Suspense><CompanyHome ws={decodeURIComponent(p.wsId)} /></Suspense>;
}
