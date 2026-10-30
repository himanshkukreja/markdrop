import type { Metadata } from "next";
import { SiteProvider } from "@/components/docs-sites/SiteContext";

export const metadata: Metadata = {
  title: "Docs site · Markdrop",
  robots: { index: false, follow: false },
};

/** Every screen of one docs site shares the loaded site (it survives moving between tabs). */
export default async function SiteLayout({ params, children }: { params: Promise<{ wsId: string; siteId: string }>; children: React.ReactNode }) {
  const { wsId, siteId } = await params;
  return (
    <SiteProvider key={siteId} wsId={decodeURIComponent(wsId)} siteId={decodeURIComponent(siteId)}>
      {children}
    </SiteProvider>
  );
}
