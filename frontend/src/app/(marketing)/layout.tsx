import SiteHeader from "@/components/shell/SiteHeader";
import FeedbackWidget from "@/components/FeedbackWidget";

/** Marketing pages: full-bleed sections under the marketing header (REVAMP_PLAN 4.1). */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader variant="marketing" />
      <main id="main" className="flex-1 min-w-0 w-full">{children}</main>
      <FeedbackWidget />
    </>
  );
}
