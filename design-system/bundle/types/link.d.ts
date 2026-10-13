/**
 * Link plumbing. The design system depends on React only, so it can't import next/link. Every DS
 * component that renders a link (Button with href, Dropdown items, MarkdropLogo, DocumentRow,
 * Breadcrumb, RouterTabs) asks this context for the component to render. The default is a plain
 * <a>; the app mounts `NextLinkProvider` (components/theme) once at the root to get client routing.
 */
import React from "react";
export type LinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
};
export type LinkComponent = React.ComponentType<LinkProps & React.RefAttributes<HTMLAnchorElement>>;
/** The default: a plain anchor. */
export declare const PlainLink: React.ForwardRefExoticComponent<React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
} & React.RefAttributes<HTMLAnchorElement>>;
export declare function LinkProvider({ component, children }: {
    component: LinkComponent;
    children?: React.ReactNode;
}): import("react/jsx-runtime").JSX.Element;
/** The link component to render for an href (next/link under NextLinkProvider, else <a>). */
export declare function useLinkComponent(): LinkComponent;
/** Convenience: renders whatever `useLinkComponent()` returns. */
export declare const Anchor: React.ForwardRefExoticComponent<React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
} & React.RefAttributes<HTMLAnchorElement>>;
