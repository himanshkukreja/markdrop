import type { Metadata } from "next";
import StudioShell from "@/components/docs-sites/studio/StudioShell";

export const metadata: Metadata = {
  title: { default: "Docs Studio · Markdrop", template: "%s · Docs Studio" },
  description: "Write, design and publish documentation websites with your team.",
  robots: { index: false, follow: false },
};

/**
 * Docs Studio (/docs-studio/**): its own area of the app, not a workspace page. Full-window screens
 * under the studio's header (the Markdrop mark + "Docs Studio", the site switcher, the account
 * menu) and its violet accent (studio.css). Each screen renders <main id="main">.
 */
export default function DocsStudioLayout({ children }: { children: React.ReactNode }) {
  return <StudioShell>{children}</StudioShell>;
}
