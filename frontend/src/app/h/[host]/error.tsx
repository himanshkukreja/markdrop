"use client";

import { TenantError } from "@/components/tenant/TenantError";

/** Route errors on a workspace's own domain, in tenant chrome (the root error.tsx draws SiteHeader). */
export default function TenantErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <TenantError error={error} reset={reset} />;
}
