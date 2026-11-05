import { SiteHeader } from "@/components/shell/SiteHeader";
import { AppShell } from "@/components/shell/AppShell";
import FeedbackWidget from "@/components/FeedbackWidget";

/**
 * Account pages (/dashboard (Home), /dashboard/files, /settings/*…): the full-width header (Create is
 * primary on /dashboard; phones: Menu opens the sidebar drawer), then the AppShell sidebar beside the
 * content column holding <main id="main">. Feedback lives in the rail
 * and the account menu here, so the floating launcher is off. The global NamePrompt modal is gone:
 * the dashboard shows an inline name card instead (REVAMP_PLAN 7.10).
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader width="full" search menu />
      <AppShell>{children}</AppShell>
      <FeedbackWidget launcher={false} />
    </>
  );
}
