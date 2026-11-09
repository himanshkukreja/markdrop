/**
 * Moving between a workspace's folders without waiting for the server (fix/ws-listing).
 *
 * /w/<ws> and /w/<ws>/f/<folder> are one listing (app/(app)/w/[wsId]/(listing)/layout.tsx keeps it mounted
 * across them). While it is on screen it registers here; a plain click on any link to the same
 * workspace (a folder row, the rail, a breadcrumb) then switches folders in place at once, from
 * the cached tree and rows, and the router catches the URL up in the background. Anything else
 * (another workspace, a modified click, nothing registered) is an ordinary link.
 *
 * Intent (hover, focus, touch) on such a link warms that folder's rows (lib/navStore), so the
 * click usually finds them cached. Plain module, no React: the root link provider imports it.
 */
import type { MouseEvent } from "react";

export interface FolderTarget {
  workspaceId: string;
  /** null: the workspace's top level. */
  folderId: string | null;
}

const RE = /^\/w\/([^/?#]+)(?:\/f\/([^/?#]+))?\/?(?:[?#].*)?$/;

/** The workspace and folder a /w/… href points at, else null. Query strings are allowed (and
 *  mean the link isn't a plain folder switch). */
export function parseFolderHref(href: string): (FolderTarget & { plain: boolean }) | null {
  const m = RE.exec(href);
  if (!m) return null;
  try {
    return {
      workspaceId: decodeURIComponent(m[1]!),
      folderId: m[2] ? decodeURIComponent(m[2]) : null,
      plain: !/[?#]/.test(href),
    };
  } catch {
    return null;
  }
}

export const isFolderHref = (href: string) => RE.test(href);

interface Listing {
  workspaceId: string;
  go: (target: FolderTarget, href: string) => void;
}

let listing: Listing | null = null;
let warm: ((target: FolderTarget) => void) | null = null;

/** The listing on screen registers its in-place navigation; returns the unregister. */
export function registerListing(l: Listing): () => void {
  listing = l;
  return () => {
    if (listing === l) listing = null;
  };
}

/** Whoever can prefetch a folder's rows (lib/navStore) registers it here, once. */
export function setFolderWarmer(fn: (target: FolderTarget) => void) {
  warm = fn;
}

/** Hover / focus / touch on a /w/… link: warm that folder's rows. */
export function folderLinkIntent(href: string) {
  const t = parseFolderHref(href);
  if (t && t.plain && warm) warm(t);
}

/**
 * A click on a /w/… link. When it's a plain left click to a folder of the workspace whose listing
 * is on screen, switch in place and stop the link's own navigation (preventDefault); otherwise do
 * nothing and let the link navigate.
 */
export function folderLinkClick(e: MouseEvent<HTMLAnchorElement>, href: string): boolean {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  const target = e.currentTarget.getAttribute("target");
  if (target && target !== "_self") return false;
  const t = parseFolderHref(href);
  if (!t || !t.plain || !listing || listing.workspaceId !== t.workspaceId) return false;
  e.preventDefault();
  listing.go({ workspaceId: t.workspaceId, folderId: t.folderId }, href);
  return true;
}
