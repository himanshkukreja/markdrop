import type { Metadata } from "next";
import StudioShell from "@/components/docs-sites/studio/StudioShell";

export const metadata: Metadata = {
  title: { default: "Markdrop Guides", template: "%s · Markdrop Guides" },
  description: "Write, design and publish help centers, product guides and handbooks with your team.",
  robots: { index: false, follow: false },
};

/**
 * Markdrop Guides (/guides/**): its own area of the app, not a workspace page. Full-window screens
 * under the studio's header (the Markdrop mark + "Guides", the guide switcher, the account
 * menu) and its violet accent (studio.css). Each screen renders <main id="main">.
 */
export default function DocsStudioLayout({ children }: { children: React.ReactNode }) {
  return <StudioShell>{children}</StudioShell>;
}
