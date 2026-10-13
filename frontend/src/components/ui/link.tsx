"use client";
/**
 * Link plumbing. The design system depends on React only, so it can't import next/link. Every DS
 * component that renders a link (Button with href, Dropdown items, MarkdropLogo, DocumentRow,
 * Breadcrumb, RouterTabs) asks this context for the component to render. The default is a plain
 * <a>; the app mounts `NextLinkProvider` (components/theme) once at the root to get client routing.
 */
import React, { createContext, useContext } from "react";

export type LinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };
export type LinkComponent = React.ComponentType<LinkProps & React.RefAttributes<HTMLAnchorElement>>;

/** The default: a plain anchor. */
export const PlainLink = React.forwardRef<HTMLAnchorElement, LinkProps>(function PlainLink(props, ref) {
  return <a ref={ref} {...props} />;
});

const LinkContext = createContext<LinkComponent>(PlainLink);

export function LinkProvider({ component, children }: { component: LinkComponent; children?: React.ReactNode }) {
  return <LinkContext.Provider value={component}>{children}</LinkContext.Provider>;
}

/** The link component to render for an href (next/link under NextLinkProvider, else <a>). */
export function useLinkComponent(): LinkComponent {
  return useContext(LinkContext);
}

/** Convenience: renders whatever `useLinkComponent()` returns. */
export const Anchor = React.forwardRef<HTMLAnchorElement, LinkProps>(function Anchor(props, ref) {
  const L = useLinkComponent();
  return <L ref={ref} {...props} />;
});
