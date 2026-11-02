import Hero from "@/components/landing/desk/Hero";
import Renders from "@/components/landing/desk/Renders";
import Stamps from "@/components/landing/desk/Stamps";
import Workspaces from "@/components/landing/desk/Workspaces";
import Notebook from "@/components/landing/desk/Notebook";
import Drawer from "@/components/landing/desk/Drawer";
import ClearDesk from "@/components/landing/desk/ClearDesk";
import CtaTracker from "@/components/landing/CtaTracker";
import l from "@/components/landing/desk/Landing.module.css";

/**
 * The landing page, "Drop it on the desk" (design canvas round 2 E's desk hero with round 3 H's drop
 * interaction and sections). One feature per section, each explained the same way (what it is, what
 * you can do, a docs link) beside the desk object that shows it: the desk hero, documents and files,
 * sharing and access, workspaces, Markdrop Guides, your tools (the drawer), the closing CTA.
 *
 * From 1024 × 640 every section is one viewport and the page snaps section by section
 * (Landing.module.css, scoped to this page's root). A server component that reads no cookies,
 * headers or searchParams, so `/` stays static. The hero's live renders, Mermaid and the viewers load
 * only after a drop (components/landing/desk/LinkCard); product loops load near the viewport. The
 * (marketing) layout adds the header and SiteFooter.
 */
export default function LandingPage() {
  return (
    <div className={l.root}>
      <Hero />
      <Renders />
      <Stamps />
      <Workspaces />
      <Notebook />
      <Drawer />
      <ClearDesk />
      <CtaTracker />
    </div>
  );
}
