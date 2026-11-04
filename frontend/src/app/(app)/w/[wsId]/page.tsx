import type { Metadata } from "next";
import FolderView from "@/components/workspace/folder/FolderView";
import { fetchSpacePreview, spaceMetadata } from "@/lib/og";

type Props = { params: Promise<{ wsId: string }> };

/** The link preview: names only when a signed-out visitor could see them (lib/og.ts). Never indexed. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const wsId = decodeURIComponent((await params).wsId);
  return spaceMetadata(wsId, null, await fetchSpacePreview(wsId, null));
}

/** A workspace's top level: its folders, then what's filed at the top (P2). */
export default async function WorkspacePage({ params }: Props) {
  const { wsId } = await params;
  return <FolderView key={wsId} workspaceId={decodeURIComponent(wsId)} folderId={null} />;
}
