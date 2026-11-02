import Hero from "@/components/landing/desk/Hero";
import Renders from "@/components/landing/desk/Renders";
import Stamps from "@/components/landing/desk/Stamps";
import Notebook from "@/components/landing/desk/Notebook";
import Drawer from "@/components/landing/desk/Drawer";
import ClearDesk from "@/components/landing/desk/ClearDesk";
import CtaTracker from "@/components/landing/CtaTracker";

/**
 * The landing page, "Drop it on the desk" (design canvas round 2 E's desk hero with round 3 H's drop
 * interaction and sections): the desk hero, what renders, stamps and who gets in, Markdrop Guides,
 * the tools drawer, the closing CTA. A server component that reads no cookies, headers or
 * searchParams, so `/` stays static. The hero's live renders, Mermaid and the viewers load only after
 * a drop (components/landing/desk/LinkCard); product loops load near the viewport. The (marketing)
 * layout adds the header and SiteFooter.
 */
export default function LandingPage() {
  return (
    <div className="w-full min-w-0 overflow-x-clip">
      <Hero />
      <Renders />
      <Stamps />
      <Notebook />
      <Drawer />
      <ClearDesk />
      <CtaTracker />
    </div>
  );
}
