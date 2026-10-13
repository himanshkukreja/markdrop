"use client";

import NextLink from "next/link";
import React from "react";
import { LinkProvider, type LinkProps } from "@/components/ui/link";

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

const AppLink = React.forwardRef<HTMLAnchorElement, LinkProps>(function AppLink({ href, ...rest }, ref) {
  if (isInternal(href, { href, ...rest })) return <NextLink ref={ref} href={href} {...rest} />;
  return <a ref={ref} href={href} {...rest} />;
});

/** Mount once at the root so every design-system link uses client routing. */
export function NextLinkProvider({ children }: { children: React.ReactNode }) {
  return <LinkProvider component={AppLink}>{children}</LinkProvider>;
}

export default NextLinkProvider;
