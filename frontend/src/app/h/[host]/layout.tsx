import { resolveAppHost } from "@/lib/hostResolution";
import { TenantProvider } from "@/components/tenant/TenantProvider";
import { TenantStyle } from "@/components/tenant/TenantStyle";
import { tenantChromeFrom, type TenantResolution } from "@/components/tenant/branding";

/**
 * Everything under a workspace's own domain (reached only by the middleware rewrite to
 * `/h/<host>/…`). Provides the tenant's branding to the pages below and re-points the accent
 * tokens at the tenant's colour. It renders **no header**: the document views decide when chrome
 * shows (never in immersive mode), and the index, 404 and error pages draw `TenantHeader`
 * themselves.
 *
 * Reads only the route param, never headers or cookies, and the resolution is the same cached
 * fetch the page makes (Next dedupes it), so this adds no request.
 */
interface Props {
  children: React.ReactNode;
  params: Promise<{ host: string }>;
}

export default async function TenantLayout({ children, params }: Props) {
  const { host } = await params;
  // Same kind check as the page: a cdn-kind or unverified host has no tenant chrome either.
  const resolved = (await resolveAppHost(host)) as TenantResolution | null;
  const tenant = resolved ? tenantChromeFrom(resolved, resolved.host || host) : null;
  return (
    <TenantProvider value={tenant}>
      {tenant && <TenantStyle tenant={tenant} />}
      {children}
    </TenantProvider>
  );
}
