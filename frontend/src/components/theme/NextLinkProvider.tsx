"use client";

import NextLink from "next/link";
import React from "react";
import { LinkProvider, type LinkProps } from "@/components/ui/link";
import { folderLinkClick, folderLinkIntent, isFolderHref } from "@/lib/folderNav";

/**
 * next/link for in-app hrefs, a plain <a> for everything else: other origins, protocol-relative
 * URLs, hash-only links, new tabs, downloads and API routes (not pages, so client navigation
 * would only fail and fall back).
 */
function isInternal(href: string, props: LinkProps): boolean {
  if (!href.startsWith("/") || href.startsWith("//")) return false;
  if (props.target || props.download !== undefined) return false;
  if (href.startsWith("/api/")) return false;
  return true;
}

/**
 * Links to a workspace or one of its folders (/w/<ws>[/f/<folder>]), wherever they are (the rail,
 * folder rows, breadcrumbs, ⌘K): never prefetched in the viewport (each is a server render, and a
 * page full of them used to queue dozens of requests ahead of the click); intent (hover, focus,
 * touch) warms the folder's rows instead, and a plain click on one while that workspace's listing
 * is on screen switches folders in place (lib/folderNav).
 */
const FolderLink = React.forwardRef<HTMLAnchorElement, LinkProps>(function FolderLink(
  { href, onClick, onPointerEnter, onFocus, onTouchStart, prefetch: _prefetch, ...rest },
  ref,
) {
  return (
    <NextLink
      ref={ref}
      href={href}
      prefetch={false}
      {...rest}
      onPointerEnter={(e) => { onPointerEnter?.(e); folderLinkIntent(href); }}
      onFocus={(e) => { onFocus?.(e); folderLinkIntent(href); }}
      onTouchStart={(e) => { onTouchStart?.(e); folderLinkIntent(href); }}
      onClick={(e) => { onClick?.(e); folderLinkClick(e, href); }}
    />
  );
});

const AppLink = React.forwardRef<HTMLAnchorElement, LinkProps>(function AppLink({ href, prefetch, ...rest }, ref) {
  if (isInternal(href, { href, ...rest })) {
    if (isFolderHref(href)) return <FolderLink ref={ref} href={href} {...rest} />;
    return <NextLink ref={ref} href={href} {...(prefetch === false ? { prefetch: false } : {})} {...rest} />;
  }
  return <a ref={ref} href={href} {...rest} />;
});

/** Mount once at the root so every design-system link uses client routing. */
export function NextLinkProvider({ children }: { children: React.ReactNode }) {
  return <LinkProvider component={AppLink}>{children}</LinkProvider>;
}

export default NextLinkProvider;
