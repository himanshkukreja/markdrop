import Hero from "@/components/landing/orbit";
import RenderBench from "@/components/landing/toys/RenderBench";
import DocsStudio from "@/components/landing/docs-studio/DocsStudio";
import LinkForge from "@/components/landing/toys/LinkForge";
import KeyLab from "@/components/landing/toys/KeyLab";
import SyncDesk from "@/components/landing/toys/SyncDesk";
import SendSim from "@/components/landing/toys/SendSim";
import DomainStudio from "@/components/landing/toys/DomainStudio";
import BuilderBlocks from "@/components/landing/toys/BuilderBlocks";
import CanTheyOpen from "@/components/landing/toys/CanTheyOpen";
import ClosingCta from "@/components/landing/closing/ClosingCta";
import StickyStart from "@/components/landing/closing/StickyStart";
import CtaTracker from "@/components/landing/CtaTracker";

/**
 * The landing page (REVAMP_BUILD §5.6.1): the Orbit Playground hero, eight playable sections (artifacts
 * first, then Docs Studio, a static section with no script), then the closing CTA. A server component that reads no cookies, headers or searchParams, so
 * `/` stays static: every section's copy and static first frame is server HTML, and each interactive
 * half loads on demand (components/landing/LazyIsland). At most one attract/demo loop runs at a time
 * (components/landing/PlayCoordinator). Nothing from the markdown pipeline (react-markdown, rehype,
 * KaTeX, Mermaid) ships here. The (marketing) layout adds the header and SiteFooter.
 */
export default function LandingPage() {
  return (
    <div className="w-full min-w-0 overflow-x-clip">
      <Hero />
      <RenderBench />
      <DocsStudio />
      <LinkForge />
      <KeyLab />
      <SyncDesk />
      <SendSim />
      <DomainStudio />
      <BuilderBlocks />
      <CanTheyOpen />
      <ClosingCta />
      <StickyStart />
      <CtaTracker />
    </div>
  );
}
