import type { Metadata } from "next";
import FolderView from "@/components/workspace/folder/FolderView";
import { fetchSpacePreview, spaceMetadata } from "@/lib/og";

type Props = { params: Promise<{ wsId: string; folderId: string }> };

/** The link preview: names only when a signed-out visitor could see them (lib/og.ts). Never indexed. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { wsId, folderId } = await params;
  const ws = decodeURIComponent(wsId);
  const folder = decodeURIComponent(folderId);
  return spaceMetadata(ws, folder, await fetchSpacePreview(ws, folder));
}

/** One folder of a workspace: breadcrumbs, subfolders, items (P2). */
export default async function WorkspaceFolderPage({ params }: Props) {
  const { wsId, folderId } = await params;
  return <FolderView key={`${wsId}/${folderId}`} workspaceId={decodeURIComponent(wsId)} folderId={decodeURIComponent(folderId)} />;
}
