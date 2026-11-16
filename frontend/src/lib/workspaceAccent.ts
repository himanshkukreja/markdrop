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

/** Hand the accent to a framed Markdrop viewer (it accepts it only from its framing app window). */
export function sendViewerAccent(frame: HTMLIFrameElement | null, accent: string | null): void {
  if (!frame?.contentWindow || !accent) return;
  try { frame.contentWindow.postMessage({ md: 1, ev: "theme", accent }, "*"); } catch { /* the frame went away */ }
}
