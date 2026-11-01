import type { Metadata } from "next";
import GuidesFrame from "@/components/guides-landing/GuidesFrame";

export const metadata: Metadata = {
  title: { default: "Markdrop Guides", template: "%s · Markdrop Guides" },
  description: "Write, design and publish help centers, product guides and handbooks with your team.",
  // The studio's screens stay out of search. /guides itself (the landing page) opts back in.
  robots: { index: false, follow: false },
};

/**
 * Markdrop Guides (/guides/**): its own area of the app, not a workspace page. Full-window screens
 * under the studio's header (the Markdrop mark + "Guides", the guide switcher, the account
 * menu) and its styles (studio.css). Each screen renders <main id="main">.
 *
 * /guides itself is the Markdrop Guides landing page for signed-out visitors and the studio home
 * for signed-in ones: GuidesFrame (components/guides-landing) decides, and wraps every other
 * screen in the studio's shell as before.
 */
export default function DocsStudioLayout({ children }: { children: React.ReactNode }) {
  return <GuidesFrame>{children}</GuidesFrame>;
}
