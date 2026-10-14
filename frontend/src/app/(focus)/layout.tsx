import { SiteHeader } from "@/components/shell/SiteHeader";

/**
 * Focus pages (/login, /invite/[token], /auth/*, /extension/authorize): the minimal header (logo and
 * theme only), then a centred column; each page draws its own card.
 */
export default function FocusLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader variant="minimal" />
      <main id="main" tabIndex={-1} className="mx-auto flex min-h-0 w-full min-w-0 max-w-marketing flex-1 flex-col px-4 py-6 outline-none sm:px-6 sm:py-10">
        {children}
      </main>
    </>
  );
}
