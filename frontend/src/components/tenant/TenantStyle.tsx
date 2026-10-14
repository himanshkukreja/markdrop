import { tenantCss, type TenantChrome } from "./branding";

/**
 * The tenant's accent and logo-well tokens as one small stylesheet (server-rendered, so the first
 * paint is already on-brand). Values are computed in `branding.ts`; nothing raw is interpolated.
 */
export function TenantStyle({ tenant }: { tenant: Pick<TenantChrome, "accentColor"> }) {
  return <style data-tenant-accent="" dangerouslySetInnerHTML={{ __html: tenantCss(tenant) }} />;
}

export default TenantStyle;
