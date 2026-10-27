"use client";

import { usePathname } from "next/navigation";
import SharedFolderView from "./SharedFolderView";

/**
 * A shared-folder address with nothing an anonymous reader may open (404 status from page.tsx).
 * The folder may still hold what a signed-in reader can open, so the view asks again with their
 * session; anyone else sees the same "doesn't open anything" state as before.
 */
export default function SharedFolderNotFound() {
  const pathname = usePathname() || "";
  const [, f, shareId = "", ...rest] = pathname.split("/");
  if (f !== "f" || !shareId) return null;
  const path = rest.filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  }).join("/");
  return <SharedFolderView shareId={shareId} path={path} initial={null} initialStatus={404} />;
}
