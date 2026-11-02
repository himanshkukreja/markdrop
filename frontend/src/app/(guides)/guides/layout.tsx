import type { Metadata } from "next";
import GuidesFrame from "@/components/guides-landing/GuidesFrame";
import { STUDIO_BOOT_SCRIPT } from "@/lib/studioSession";

export const metadata: Metadata = {
  title: { default: "Markdrop Guides", template: "%s · Markdrop Guides" },
  description: "Write, design and publish help centers, product guides and handbooks with your team.",
  // The studio's screens stay out of search. /guides itself (the landing page) opts back in.
  robots: { index: false, follow: false },
};

/**
 * The /guides route tree: the Markdrop Guides landing page (/guides, on markdrop.in) and the
 * studio's screens (everything below it), which are served on the studio's own host,
 * guides.markdrop.in (the middleware rewrites guides.markdrop.in/<path> to /guides/<path>, and
 * "/" to /guides/home; lib/studioHost). GuidesFrame wraps the studio's screens in its shell (the
 * Markdrop mark + "Guides", the guide switcher, the account menu) and its styles (studio.css).
 * Each screen renders <main id="main">.
 *
 * The boot script runs first, before anything renders: on the studio host it takes a sign-in
 * handed over from markdrop.in, or goes to get one (lib/studioSession). Anywhere else it does
 * nothing.
 */
export default function DocsStudioLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: STUDIO_BOOT_SCRIPT }} />
      <GuidesFrame>{children}</GuidesFrame>
    </>
  );
}
