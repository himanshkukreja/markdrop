import { SiteHeader } from "@/components/shell/SiteHeader";
import FeedbackWidget from "@/components/FeedbackWidget";

/**
 * Tools (/new, /upload, /builder, /share, /share/[id]): the default header and an instant shell
 * (no loading.tsx). The column is the tools width (1280); a page that wants less (share: 1024)
 * sets its own max width inside it (D10).
 */
export default function ToolsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main id="main" tabIndex={-1} className="mx-auto flex min-h-0 w-full min-w-0 max-w-tool flex-1 flex-col px-4 py-4 outline-none sm:px-6">
        {children}
      </main>
      <FeedbackWidget />
    </>
  );
}
