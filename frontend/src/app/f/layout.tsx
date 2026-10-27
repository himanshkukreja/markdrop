import { SiteHeader } from "@/components/shell/SiteHeader";
import { SiteFooter } from "@/components/shell/SiteFooter";

/**
 * Shared folder pages (markdrop.in/f/<share_id>[/<sub/path>]): the default header, one column,
 * the site footer. Workspace domains render their own folder pages (/h/…); this is markdrop.in's.
 */
export default function SharedFolderLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main id="main" tabIndex={-1} className="mx-auto w-full min-w-0 max-w-app flex-1 px-4 py-8 outline-none sm:px-6 sm:py-12">
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
