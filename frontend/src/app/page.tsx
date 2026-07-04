import Hero from "@/components/landing/Hero";
import FeatureGrid from "@/components/landing/FeatureGrid";
import P2PShowcase from "@/components/landing/P2PShowcase";
import VSCodeShowcase from "@/components/landing/VSCodeShowcase";
import GoogleDocsShowcase from "@/components/landing/GoogleDocsShowcase";
import HowItWorks from "@/components/landing/HowItWorks";
import CallToAction from "@/components/landing/CallToAction";
import LandingFooter from "@/components/landing/LandingFooter";

export default function LandingPage() {
  return (
    <div className="w-full">
      {/* Ambient background: drifting aurora blobs + dotted grid, fixed behind everything */}
      <div aria-hidden className="fixed inset-0 -z-10 overflow-hidden pointer-events-none">
        <div className="md-aurora absolute -top-40 -left-32 w-[38rem] h-[38rem] rounded-full blur-3xl opacity-40 dark:opacity-50 vscode:opacity-60"
          style={{ background: "radial-gradient(circle, rgba(37,99,235,0.55), transparent 65%)" }} />
        <div className="md-aurora-2 absolute top-1/3 -right-40 w-[42rem] h-[42rem] rounded-full blur-3xl opacity-35 dark:opacity-45 vscode:opacity-55"
          style={{ background: "radial-gradient(circle, rgba(14,165,233,0.45), transparent 65%)" }} />
        <div className="md-aurora absolute bottom-0 left-1/4 w-[34rem] h-[34rem] rounded-full blur-3xl opacity-30 dark:opacity-40 vscode:opacity-45"
          style={{ background: "radial-gradient(circle, rgba(59,130,246,0.45), transparent 65%)" }} />
        <div className="absolute inset-0 md-grid" />
      </div>

      <Hero />
      <FeatureGrid />
      <P2PShowcase />
      <VSCodeShowcase />
      <GoogleDocsShowcase />
      <HowItWorks />
      <CallToAction />
      <LandingFooter />
    </div>
  );
}
