import type { Metadata } from "next";
import { TenantProvider } from "@/components/tenant/TenantProvider";
import { TenantStyle } from "@/components/tenant/TenantStyle";
import { tenantChromeFrom, type TenantResolution } from "@/components/tenant/branding";
import { assertTenantHost, tenantHostOf } from "@/components/tenant/assertHost";
import { resolveTenantHostQuietly } from "@/components/tenant/server";

/**
 * Everything under a workspace's own domain (reached only by the middleware rewrite to
 * `/h/<host>/…`). Provides the tenant's branding to the pages below and re-points the accent
 * tokens at the tenant's colour. It renders **no header**: the document views decide when chrome
 * shows (never in immersive mode), and the index, 404 and error pages draw `TenantHeader`
 * themselves.
 *
 * The host is never taken from the path alone (`assertTenantHost`): `/h/<host>` must be the host
 * this request arrived on, or the segment is a 404. Tenant pages render per request anyway
 * (force-dynamic), so reading headers here costs nothing.
 */
interface Props {
  children: React.ReactNode;
  params: Promise<{ host: string }>;
}

export const dynamic = "force-dynamic";

/**
 * The tenant's defaults for every page below, the 404 included: without them a tenant 404 (and
 * anything a page leaves unset) inherited markdrop.in's title, description and Open Graph card.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { host: param } = await params;
  const host = await tenantHostOf(param);
  const resolved = host ? await resolveTenantHostQuietly(host) : null;
  const siteName = resolved?.site_name?.trim() || host || "Not found";
  const description = host ? `Documents from ${siteName}` : "";
  return {
    title: siteName,
    description,
    applicationName: siteName,
    icons: resolved?.favicon_url ? [{ rel: "icon", url: resolved.favicon_url }] : undefined,
    manifest: null,
    robots: host ? undefined : { index: false, follow: false },
    openGraph: { title: siteName, description, type: "website", siteName, ...(host ? { url: `https://${host}/` } : {}) },
    twitter: { card: "summary", title: siteName, description },
  };
}

export default async function TenantLayout({ children, params }: Props) {
  const { host: param } = await params;
  const host = await assertTenantHost(param);
  // Same kind check as the pages: a cdn-kind, unverified or lapsed host has no tenant chrome.
  // Quiet: an API blip renders unbranded here and the page itself shows the retryable error.
  const resolved = (await resolveTenantHostQuietly(host)) as TenantResolution | null;
  const tenant = resolved ? tenantChromeFrom(resolved, resolved.host || host) : null;
  return (
    <TenantProvider value={tenant}>
      {tenant && <TenantStyle tenant={tenant} />}
      {children}
    </TenantProvider>
  );
}
