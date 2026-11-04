"use client";

/**
 * The two ends of a page's top bar that used to be the app header above it (one bar now):
 *
 *   PageBrand     Markdrop's mark, or the workspace's logo (and name) on its own domain;
 *   PageAccount   Create (a "+" menu), then the avatar menu, or Sign in; on a workspace's domain
 *                 its own sign-in / account control (TenantAccount).
 *
 * The theme is in the avatar menu (signed in) or the ⋯ menu (signed out); on phones Create moves
 * into ⋯ (PageTopBar adds it).
 */
import { MarkdropLogo, cx } from "@/components/ui";
import CreateMenu from "@/components/CreateMenu";
import { HeaderAuthSlot } from "@/components/shell/AccountMenu";
import { TenantAccount, TenantBrand, useTenant } from "@/components/tenant";

export function PageBrand({ className, wordmark }: { className?: string; /** Markdrop's name beside its mark (the rail's head has room). */ wordmark?: boolean }) {
  const tenant = useTenant();
  return (
    <span className={cx("pb-bar__brand", className)}>
      {tenant ? <TenantBrand tenant={tenant} compact /> : <MarkdropLogo size={24} wordmark={!!wordmark} className="pb-bar__logo md-focus" />}
    </span>
  );
}

export function PageAccount({ returnPath }: { returnPath?: string }) {
  const tenant = useTenant();
  if (tenant) return <span className="pb-bar__app"><TenantAccount tenant={tenant} returnPath={returnPath} compact /></span>;
  return (
    <span className="pb-bar__app">
      <CreateMenu className="pb-bar__create pb-bar__wide" size="sm" />
      {/* The notification bell (feat/sl-notify) goes here, before the avatar. */}
      <HeaderAuthSlot className="pb-bar__auth" signInClassName="pb-bar__signin" />
    </span>
  );
}
