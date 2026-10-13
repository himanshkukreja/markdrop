import SiteHeader from "@/components/shell/SiteHeader";
import FeedbackWidget from "@/components/FeedbackWidget";
import NamePrompt from "@/components/NamePrompt";

/** Account pages (/dashboard, /settings/*): header + AppShell rail (K1 adds the rail). */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main id="main" className="flex-1 min-h-0 min-w-0 flex flex-col w-full mx-auto max-w-screen-xl px-4 sm:px-6 py-4">{children}</main>
      <NamePrompt />
      <FeedbackWidget />
    </>
  );
}
