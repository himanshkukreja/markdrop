import { SiteHeader } from "@/components/shell/SiteHeader";
import { SiteFooter } from "@/components/shell/SiteFooter";
import FeedbackWidget from "@/components/FeedbackWidget";

/**
 * Marketing pages (/, /enterprise): the marketing header (72px, transparent until scrolled),
 * full-bleed sections, the SiteFooter. No cookies/headers/searchParams here, so both stay static.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader variant="marketing" />
      <main id="main" tabIndex={-1} className="w-full min-w-0 flex-1 outline-none">{children}</main>
      <SiteFooter />
      <FeedbackWidget />
    </>
  );
}
