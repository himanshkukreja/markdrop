import FolderView from "@/components/workspace/folder/FolderView";

type Props = { params: Promise<{ wsId: string }>; children: React.ReactNode };

/**
 * A workspace's listing, kept mounted across its top level and its folders (fix/ws-listing): moving
 * between folders never remounts it. FolderView reads which folder from the URL and switches in
 * place on a click (lib/folderNav), so a folder opens at once from what's cached while the router
 * catches the URL up. The pages below only carry each URL's link-preview metadata.
 */
export default async function WorkspaceLayout({ params, children }: Props) {
  const { wsId } = await params;
  const id = decodeURIComponent(wsId);
  return (
    <>
      <FolderView key={id} workspaceId={id} />
      {children}
    </>
  );
}
