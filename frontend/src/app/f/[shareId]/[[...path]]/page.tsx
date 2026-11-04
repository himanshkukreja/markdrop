import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchSharedFolder } from "@/lib/workspaces";
import { internalHeaders } from "@/components/tenant/server";
import { ogCard } from "@/lib/og";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://api.markdrop.in";
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
  const sub = subPath(path);
  // The card is the backend's (routers/og.py): it names the folder only when a signed-out visitor
  // could open it, exactly like this page's anonymous fetch below.
  const q = new URLSearchParams({ v: "1" });
  if (sub) q.set("path", sub);
  const image = { url: `${API_URL}/api/v1/og/f/${encodeURIComponent(shareId)}.png?${q}`, width: 1200, height: 630, alt: "A Markdrop folder" };
  try {
    const r = await fetchSharedFolder(shareId, sub, null, internalHeaders());
    if (r.status === 200) {
      const title = `${r.data.folder.name} · ${r.data.workspace.name}`;
      const description = `A shared folder from ${r.data.workspace.name} on Markdrop.`;
      return { title, description, robots, ...ogCard(title, description, { ...image, alt: title }, { type: "website", siteName: "Markdrop" }) };
    }
  } catch { /* fall through */ }
  return { title: "Shared folder · Markdrop", description: "Sign in to open it.", robots, ...ogCard("A folder in a Markdrop workspace", "Sign in to open it.", image, { type: "website", siteName: "Markdrop" }) };
}

/** markdrop.in/f/<share_id>[/<sub/path>]: a shared folder (D2: each reader sees what they can open). */
export default async function SharedFolderPage({ params }: Props) {
  const { shareId, path } = await params;
  const sub = subPath(path);
  if (!SHARE_ID.test(shareId)) notFound();
  // Anonymous here (the session lives in the browser); 5xx/network errors throw to error.tsx.
  // Signed (T1): every anonymous render reaches the API from the same few server addresses.
  const r = await fetchSharedFolder(shareId, sub, null, internalHeaders());
  // Nothing an anonymous reader may open here — no such share, no such sub-folder, or one holding
  // only what a signed-in reader can open (indistinguishable on purpose): a real 404 status. The
  // segment's not-found.tsx still asks again with the reader's session in the browser.
  if (r.status === 404) notFound();
  return <SharedFolderView shareId={shareId} path={sub} initial={r.data} initialStatus={r.status} />;
}
