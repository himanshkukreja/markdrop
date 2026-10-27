import type { Metadata } from "next";
import FolderView from "@/components/workspace/folder/FolderView";

export const metadata: Metadata = {
  title: "Workspace · Markdrop",
  robots: { index: false, follow: false },
};

/** A workspace's top level: its folders, then what's filed at the top (P2). */
export default async function WorkspacePage({ params }: { params: Promise<{ wsId: string }> }) {
  const { wsId } = await params;
  return <FolderView key={wsId} workspaceId={decodeURIComponent(wsId)} folderId={null} />;
}
