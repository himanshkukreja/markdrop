import { SiteProvider } from "@/components/docs-sites/SiteContext";

/** Every screen of one docs site shares the loaded site (it survives moving between tabs). */
export default async function SiteLayout({ params, children }: { params: Promise<{ siteId: string }>; children: React.ReactNode }) {
  const { siteId } = await params;
  return (
    <SiteProvider key={siteId} siteId={decodeURIComponent(siteId)}>
      {children}
    </SiteProvider>
  );
}
