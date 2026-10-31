import { PublishStateProvider } from "@/components/docs-sites/PublishState";
import { SiteProvider } from "@/components/docs-sites/SiteContext";

/** Every screen of one docs site shares the loaded site (it survives moving between tabs) and its publish state (the site bar's). */
export default async function SiteLayout({ params, children }: { params: Promise<{ siteId: string }>; children: React.ReactNode }) {
  const { siteId } = await params;
  return (
    <SiteProvider key={siteId} siteId={decodeURIComponent(siteId)}>
      <PublishStateProvider>{children}</PublishStateProvider>
    </SiteProvider>
  );
}
