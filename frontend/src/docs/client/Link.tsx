"use client";

/**
 * The docs' link: next/link that prefetches on intent instead of on sight.
 *
 * next/link prefetches every link that scrolls into view. On a docs page that is the whole sidebar
 * and the page's own links: 10–20 payload requests per view, which on the docs edge are Worker
 * invocations (docs-platform/README.md). Here a link prefetches when a reader shows intent: the
 * pointer arrives (mouse or pen), a finger touches it, or keyboard focus lands on it. That is
 * still ahead of the click (a hover precedes a click by ~100–300 ms), and the router's cache makes
 * a repeat hover free. The prefetch is the same one next/link makes on hover (kind "auto").
 *
 * Rendered HTML is unchanged: next/link writes no prefetch attribute on the <a>.
 */
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";
import React from "react";
import { LinkProvider, type LinkProps } from "@/components/ui/link";

type Props = React.ComponentProps<typeof NextLink>;

/** The path to prefetch for an href, or null (another origin, a hash on this page, not a string). */
export function prefetchTarget(href: Props["href"]): string | null {
  if (typeof href !== "string" || !href.startsWith("/") || href.startsWith("//")) return null;
  return href.split("#")[0] || null;
}

export const DocsLink = React.forwardRef<HTMLAnchorElement, Props>(function DocsLink(
  { href, prefetch: _prefetch, onPointerEnter, onTouchStart, onFocus, ...rest },
  ref,
) {
  const router = useRouter();
  const intent = () => {
    const target = prefetchTarget(href);
    if (target) router.prefetch(target, { kind: PrefetchKind.AUTO });
  };
  return (
    <NextLink
      ref={ref}
      href={href}
      prefetch={false}
      onPointerEnter={(e) => {
        onPointerEnter?.(e);
        intent();
      }}
      onTouchStart={(e) => {
        onTouchStart?.(e);
        intent();
      }}
      onFocus={(e) => {
        onFocus?.(e);
        intent();
      }}
      {...rest}
    />
  );
});

/**
 * Design-system links (Button with href, …) inside the docs: DocsLink for in-site paths, a plain
 * <a> for everything else (the same split as the app's NextLinkProvider).
 */
const DsLink = React.forwardRef<HTMLAnchorElement, LinkProps>(function DsLink({ href, ...rest }, ref) {
  const internal = href.startsWith("/") && !href.startsWith("//") && !rest.target && rest.download === undefined && !href.startsWith("/api/");
  if (internal) return <DocsLink ref={ref} href={href} {...rest} />;
  return <a ref={ref} href={href} {...rest} />;
});

export function DocsLinkProvider({ children }: { children: React.ReactNode }) {
  return <LinkProvider component={DsLink}>{children}</LinkProvider>;
}

export default DocsLink;
