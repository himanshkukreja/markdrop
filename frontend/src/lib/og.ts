import type { Metadata } from "next";

/**
 * Link-preview cards for markdrop.in. Slack, WhatsApp, iMessage and the rest need an absolute https
 * URL to a 1200×630 PNG, so every page resolves against SITE_ORIGIN (the root layout's metadataBase;
 * markdrop.in itself 307s to www, and a crawler shouldn't have to follow that).
 *
 * The static cards are drawn by backend/scripts/make_default_og.py on the document cards' grid.
 */
export const SITE_ORIGIN = "https://www.markdrop.in";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "https://api.markdrop.in";

type OgImage = { url: string; width: number; height: number; alt: string };

/** The site-wide default: any URL with no card of its own shares with this one. */
export const DEFAULT_OG_IMAGE: OgImage = { url: "/og/markdrop.png", width: 1200, height: 630, alt: "Markdrop: drop it, it renders." };
/** A file-transfer room (/share/<id>): it sends files, it doesn't render them. */
export const TRANSFER_OG_IMAGE: OgImage = { url: "/og/transfer.png", width: 1200, height: 630, alt: "Files sent with Markdrop" };

/** openGraph + twitter for a page that sets its own title and description. */
export function ogCard(title: string, description: string, image: OgImage = DEFAULT_OG_IMAGE, extra: Metadata["openGraph"] = {}): Pick<Metadata, "openGraph" | "twitter"> {
  return {
    openGraph: { title, description, images: [image], ...extra },
    twitter: { card: "summary_large_image", title, description, images: [image.url] },
  };
}

/* ── Workspaces and folders ────────────────────────────────────────────────────
 * Crawlers are never signed in, so the backend answers what a signed-out visitor may know
 * (services/folder_preview.py): names only when the workspace or folder is already public, else
 * `visible: false` and a content-free card. The card URL is the backend's (it decides again on
 * its own, never trusting this side). `s` changes when visibility does, so unfurl caches re-fetch. */

export interface SpacePreview {
  visible: boolean;
  workspace?: string;
  folder?: string;
  items?: number;
  host?: string | null;
}

/** null when it doesn't exist (or the API can't be reached): the caller shows the generic card. */
export async function fetchSpacePreview(wsId: string, folderId: string | null): Promise<SpacePreview | null> {
  const path = folderId ? `w/${encodeURIComponent(wsId)}/f/${encodeURIComponent(folderId)}` : `w/${encodeURIComponent(wsId)}`;
  try {
    const res = await fetch(`${API_BASE}/api/v1/og/${path}.json`, { next: { revalidate: 60 }, signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    return (await res.json()) as SpacePreview;
  } catch {
    return null;
  }
}

const ID = /^[0-9a-f]{24}$/;

function itemsLabel(n: number): string {
  return n === 1 ? "1 item" : `${n} items`;
}

/**
 * The metadata of markdrop.in/w/<ws>[/f/<folder>]. Never indexed (an app URL). Names appear only
 * when `p.visible`; otherwise the text is generic and the card is the content-free one.
 */
export function spaceMetadata(wsId: string, folderId: string | null, p: SpacePreview | null): Metadata {
  const robots = { index: false, follow: false };
  const kind = folderId ? "folder" : "workspace";
  const valid = ID.test(wsId) && (!folderId || ID.test(folderId));
  const imagePath = folderId ? `w/${wsId}/f/${folderId}` : `w/${wsId}`;
  const image: OgImage = valid
    ? { url: `${API_BASE}/api/v1/og/${imagePath}.png?v=1&s=${p?.visible ? "1" : "0"}`, width: 1200, height: 630, alt: kind === "folder" ? "A Markdrop folder" : "A Markdrop workspace" }
    : DEFAULT_OG_IMAGE;
  if (p?.visible && p.workspace) {
    const name = kind === "folder" ? (p.folder ?? "Folder") : p.workspace;
    const title = kind === "folder" ? `${name} · ${p.workspace}` : `${p.workspace} · Markdrop`;
    const count = itemsLabel(p.items ?? 0);
    const description = kind === "folder" ? `A folder in ${p.workspace} on Markdrop · ${count}` : `Documents and files from ${p.workspace} on Markdrop · ${count}`;
    return { title, description, robots, ...ogCard(title, description, { ...image, alt: title }, { type: "website", siteName: "Markdrop" }) };
  }
  const title = kind === "folder" ? "A folder in a Markdrop workspace" : "A Markdrop workspace";
  const description = "Sign in to open it.";
  return { title: `${title} · Markdrop`, description, robots, ...ogCard(title, description, image, { type: "website", siteName: "Markdrop" }) };
}
