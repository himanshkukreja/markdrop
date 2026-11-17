"use client";

import { useEffect, useState } from "react";
import { useTenant } from "@/components/tenant";
import { getWorkspace } from "@/lib/workspaces";

/**
 * The workspace's brand accent (Workspace settings › Look) for chrome drawn inside a framed viewer,
 * such as the video player's progress bar: the custom domain's accent when there is one, else the
 * accent of the workspace the item is filed in (members only; anyone else gets null and the
 * viewer keeps Markdrop's). Always "#rrggbb" or null.
 */
const cache = new Map<string, Promise<string | null>>();

function hex(v: unknown): string | null {
  return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim() : null;
}

export function useWorkspaceAccent(workspaceId: string | null | undefined): string | null {
  const tenant = useTenant();
  const fromTenant = hex(tenant?.accentColor);
  const [accent, setAccent] = useState<string | null>(null);
  useEffect(() => {
    if (fromTenant || !workspaceId) return;
    let live = true;
    if (!cache.has(workspaceId)) {
      cache.set(workspaceId, getWorkspace(workspaceId).then((w) => hex(w.branding?.accent_color)).catch(() => null));
    }
    cache.get(workspaceId)!.then((a) => { if (live) setAccent(a); });
    return () => { live = false; };
  }, [workspaceId, fromTenant]);
  return fromTenant ?? accent;
}

/** A video's chapters for the player's progress bar: `t` in seconds into the video, `title` plain text. */
export type ViewerChapter = { t: number; title: string };

/**
 * Hand a video's chapters to the framed player (worker/src/index.js: {md:1, ev:"chapters", list}). It
 * takes them from its framing window, checks them (≤40, ascending, text ≤80 characters) and draws them
 * as text. An empty list clears them.
 */
export function sendViewerChapters(frame: HTMLIFrameElement | null, chapters: ViewerChapter[] | null | undefined): void {
  if (!frame?.contentWindow || !chapters) return;
  const list = chapters
    .filter((c) => Number.isFinite(c.t) && c.t >= 0 && typeof c.title === "string" && c.title.trim())
    .slice(0, 40)
    .map((c) => ({ t: c.t, title: c.title.trim().slice(0, 80) }));
  try { frame.contentWindow.postMessage({ md: 1, ev: "chapters", list }, "*"); } catch { /* the frame went away */ }
}

/** Hand the accent to a framed Markdrop viewer (it accepts it only from its framing app window). */
export function sendViewerAccent(frame: HTMLIFrameElement | null, accent: string | null): void {
  if (!frame?.contentWindow || !accent) return;
  try { frame.contentWindow.postMessage({ md: 1, ev: "theme", accent }, "*"); } catch { /* the frame went away */ }
}
