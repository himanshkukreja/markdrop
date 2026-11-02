"use client";

import "@/components/docs-sites/studio/studio.css";
import dynamic from "next/dynamic";
import { useSelectedLayoutSegment } from "next/navigation";
import { StudioLoader } from "@/components/docs-sites/SiteContext";

/**
 * The frame of everything under the /guides route tree (the (guides) layout):
 *
 *   /guides                 the Markdrop Guides landing page, for everyone: the page's own server
 *                           HTML (header, sections, footer), static, indexable
 *   /guides/<anything>      a studio screen, in the studio's shell (served as
 *                           guides.markdrop.in/<anything>; the home is /guides/home)
 *
 * Decided by the route segment, not the address: on the studio host the address has no /guides.
 * The studio's screens are split out (next/dynamic), so a landing visitor never downloads them.
 */
const StudioShell = dynamic(() => import("@/components/docs-sites/studio/StudioShell"), { loading: () => <StudioLoader /> });

export default function GuidesFrame({ children }: { children: React.ReactNode }) {
  // null: the layout's own page (/guides, the landing page).
  const segment = useSelectedLayoutSegment();
  if (segment === null) return <>{children}</>;
  return <StudioShell>{children}</StudioShell>;
}
