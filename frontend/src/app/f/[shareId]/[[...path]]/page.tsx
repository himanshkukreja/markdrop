import type { Metadata } from "next";
import { fetchSharedFolder } from "@/lib/workspaces";
import { internalHeaders } from "@/components/tenant/server";
import SharedFolderView from "./SharedFolderView";

interface Props {
  params: Promise<{ shareId: string; path?: string[] }>;
}

// Always fresh: what a folder page lists depends on access settings that change without notice,
// and the browser asks again with the reader's session anyway.
export const dynamic = "force-dynamic";

const SHARE_ID = /^[A-Za-z0-9_-]{6,32}$/;

function subPath(path: string[] | undefined): string {
  return (path ?? []).map((s) => decodeURIComponent(s)).join("/");
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { shareId, path } = await params;
  // A folder link is a capability, like a document link: never indexed.
  const robots = { index: false, follow: false };
  if (!SHARE_ID.test(shareId)) return { title: "Folder · Markdrop", robots };
  try {
    const r = await fetchSharedFolder(shareId, subPath(path), null, internalHeaders());
    if (r.status === 200) {
      const title = `${r.data.folder.name} · ${r.data.workspace.name}`;
      return { title, description: `A shared folder from ${r.data.workspace.name} on Markdrop.`, robots, openGraph: { title } };
    }
  } catch { /* fall through */ }
  return { title: "Shared folder · Markdrop", robots };
}

/** markdrop.in/f/<share_id>[/<sub/path>]: a shared folder (D2: each reader sees what they can open). */
export default async function SharedFolderPage({ params }: Props) {
  const { shareId, path } = await params;
  const sub = subPath(path);
  if (!SHARE_ID.test(shareId)) return <SharedFolderView shareId={shareId} path={sub} initial={null} initialStatus={404} />;
  // Anonymous here (the session lives in the browser); 5xx/network errors throw to error.tsx.
  // Signed (T1): every anonymous render reaches the API from the same few server addresses.
  const r = await fetchSharedFolder(shareId, sub, null, internalHeaders());
  return <SharedFolderView shareId={shareId} path={sub} initial={r.data} initialStatus={r.status} />;
}
