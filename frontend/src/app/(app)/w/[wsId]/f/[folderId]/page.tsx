import type { Metadata } from "next";
import FolderView from "@/components/workspace/folder/FolderView";

export const metadata: Metadata = {
  title: "Folder · Markdrop",
  robots: { index: false, follow: false },
};

/** One folder of a workspace: breadcrumbs, subfolders, items (P2). */
export default async function WorkspaceFolderPage({ params }: { params: Promise<{ wsId: string; folderId: string }> }) {
  const { wsId, folderId } = await params;
  return <FolderView key={`${wsId}/${folderId}`} workspaceId={decodeURIComponent(wsId)} folderId={decodeURIComponent(folderId)} />;
}
