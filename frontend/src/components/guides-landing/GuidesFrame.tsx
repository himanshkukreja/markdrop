"use client";

import "@/components/docs-sites/studio/studio.css";
import dynamic from "next/dynamic";
import { useEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { useLocationSearch } from "@/components/shell/useLocation";
import { StudioLoader } from "@/components/docs-sites/SiteContext";
import { GUIDES_VIEW_ATTR, TOKEN_KEY_FOR_VIEW, isAboutQuery } from "./view";

/**
 * The frame of everything under /guides (the (guides) layout).
 *
 *   /guides, signed out (or ?about=1)   the Markdrop Guides landing page: the page's own server HTML
 *                                        (header, sections, footer), static, indexable
 *   /guides, signed in                  the studio home (StudioShell + StudioHome)
 *   /guides/<anything else>             the studio, unchanged (StudioShell around the screen)
 *
 * Sign-in lives in localStorage (lib/api getToken), so the server can't tell the two apart and the
 * static HTML is always the landing page. The page's inline script (view.ts GUIDES_VIEW_SCRIPT)
 * marks <html> before first paint when a token is there, which hides the landing and shows a
 * loader; after hydration this frame swaps in the studio. A token the API rejects (AuthContext
 * clears it) falls back to the landing page.
 *
 * The studio's screens are split out (next/dynamic), so a landing visitor never downloads them.
 */
const StudioShell = dynamic(() => import("@/components/docs-sites/studio/StudioShell"), { loading: () => <StudioLoader /> });
const StudioHome = dynamic(() => import("@/components/docs-sites/StudioHome"), { loading: () => <StudioLoader /> });

const noSubscribe = () => () => {};
function readToken(): boolean {
  try {
    return !!window.localStorage.getItem(TOKEN_KEY_FOR_VIEW);
  } catch {
    return false;
  }
}

/** "landing" or "studio" for /guides itself ("landing" on the server and during hydration). */
export function useGuidesHomeView(atHome: boolean): "landing" | "studio" {
  const search = useLocationSearch();
  const hasToken = useSyncExternalStore(noSubscribe, readToken, () => false);
  const { user, loading } = useAuth();
  if (!atHome || isAboutQuery(search)) return "landing";
  // A token that turned out to be no good (or a sign-out on this screen) means the landing page.
  return hasToken && (loading || !!user) ? "studio" : "landing";
}

export default function GuidesFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const atHome = (pathname ?? "").replace(/\/+$/, "") === "/guides";
  const view = useGuidesHomeView(atHome);
  const landing = atHome && view === "landing";

  // Keep the pre-paint marker in step with what is shown (and gone once we leave /guides).
  useEffect(() => {
    const html = document.documentElement;
    if (atHome && view === "studio") {
      html.setAttribute(GUIDES_VIEW_ATTR, "studio");
      // The static page's title is the landing page's; the studio home keeps its own.
      document.title = "Your guides · Markdrop Guides";
    } else html.removeAttribute(GUIDES_VIEW_ATTR);
    return () => html.removeAttribute(GUIDES_VIEW_ATTR);
  }, [atHome, view]);

  if (landing) return <>{children}</>;
  return <StudioShell>{atHome ? <StudioHome /> : children}</StudioShell>;
}
