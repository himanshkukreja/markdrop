import CreateMenu from "@/components/CreateMenu";
import HeaderAuth from "@/components/HeaderAuth";

/**
 * TEMPORARY port of the pre-revamp header so the route-group move builds. The shell work package
 * (K1) replaces this file with the real SiteHeader (REVAMP_PLAN 4.2): sticky, theme toggle,
 * account menu, mobile drawer, variants "default" | "marketing" | "minimal".
 */
export default function SiteHeader({ variant = "default" }: { variant?: "default" | "marketing" | "minimal" }) {
  return (
    <header className="no-print shrink-0 border-b border-border bg-bg">
      <div className="max-w-screen-xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-2">
        <a href="/" className="text-xl font-bold tracking-tight">
          mark<span className="text-accent-text">drop</span>
        </a>
        {variant !== "minimal" && (
          <div className="flex items-center gap-2 sm:gap-4 shrink-0">
            <CreateMenu />
            <HeaderAuth />
          </div>
        )}
      </div>
    </header>
  );
}
