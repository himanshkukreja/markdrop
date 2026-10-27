/**
 * Tenant chrome (REVAMP_PLAN 7.8, 7.22): everything a page on a workspace's own domain draws
 * instead of Markdrop's chrome. `app/h/[host]/layout.tsx` mounts `TenantProvider` and
 * `TenantStyle`; client components below it read the tenant with `useTenant()`.
 */
export { TenantProvider, useTenant } from "./TenantProvider";
export { TenantHeader, TenantBrand, type TenantHeaderProps } from "./TenantHeader";
export { TenantFooter } from "./TenantFooter";
export { TenantNotFound } from "./TenantNotFound";
export { TenantError } from "./TenantError";
export { TenantFolderIndex, type TenantFolderIndexProps } from "./TenantFolderIndex";
export { TenantFolderPage, type TenantFolderPageProps } from "./TenantFolderPage";
export { TenantHome } from "./TenantHome";
export { TenantHandoff } from "./TenantHandoff";
export { TenantLoading } from "./TenantLoading";
export { TenantStyle } from "./TenantStyle";
export type { TenantChrome, LogoWell, TenantResolution } from "./branding";
