import type { Metadata } from "next";
import { fetchSpacePreview, spaceMetadata } from "@/lib/og";

type Props = { params: Promise<{ wsId: string }> };

/** The link preview: names only when a signed-out visitor could see them (lib/og.ts). Never indexed. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const wsId = decodeURIComponent((await params).wsId);
  return spaceMetadata(wsId, null, await fetchSpacePreview(wsId, null));
}

/** A workspace's top level: its folders, then what's filed at the top (P2). The listing itself is the layout's (layout.tsx): it stays mounted from folder to folder. */
export default function Page() {
  return null;
}
