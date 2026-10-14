"use client";

import { createContext, useContext } from "react";
import type { TenantChrome } from "./branding";

const TenantContext = createContext<TenantChrome | null>(null);

/**
 * Carries the tenant's branding to every client component under `/h/[host]`. Mounted once by
 * `app/h/[host]/layout.tsx`, so the views (DocumentView, ArtifactView) can render the tenant
 * chrome with `useTenant()` and no new props.
 */
export function TenantProvider({ value, children }: { value: TenantChrome | null; children: React.ReactNode }) {
  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

/** The tenant this page is served for, or null on markdrop.in (and on an unresolved host). */
export function useTenant(): TenantChrome | null {
  return useContext(TenantContext);
}
