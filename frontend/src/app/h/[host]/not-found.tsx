import { TenantNotFound } from "@/components/tenant/TenantNotFound";

/**
 * Any `notFound()` under a workspace's own domain lands here, inside the tenant layout, so the
 * 404 wears the tenant's header and accent and never Markdrop's (REVAMP_PLAN 7.22).
 */
export default function TenantNotFoundPage() {
  return <TenantNotFound />;
}
