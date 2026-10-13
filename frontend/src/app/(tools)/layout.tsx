import SiteHeader from "@/components/shell/SiteHeader";
import FeedbackWidget from "@/components/FeedbackWidget";

/** Tools (/new, /upload, /builder, /share): the header only; each page sets its own width (D10). */
export default function ToolsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main id="main" className="flex-1 min-h-0 min-w-0 flex flex-col w-full mx-auto max-w-tool px-4 sm:px-6 py-4">{children}</main>
      <FeedbackWidget />
    </>
  );
}
