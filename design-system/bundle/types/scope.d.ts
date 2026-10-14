/**
 * Theme islands (REVAMP_PLAN 5.3). `ThemeScope` pins a subtree to one theme: tokens re-scope by
 * `data-theme`, the `.dark` class keeps legacy `dark:` variants in step, and `color-scheme` keeps
 * native controls and scrollbars matching. Portals leave the island's DOM, so it also provides a
 * context: every DS portal (Dialog, Drawer, portalled Dropdown/Popover) reads `usePortalTheme()`
 * and stamps the same three markers on its portal root. Toasts are page-level and don't.
 */
import React from "react";
export type ScopeTheme = "dark" | "light";
export declare const ThemeScopeContext: React.Context<ScopeTheme>;
export interface ThemeScopeProps extends React.HTMLAttributes<HTMLElement> {
    theme: ScopeTheme;
    /** Element to render; default "div". */
    as?: React.ElementType;
    /** Skip the `bg` fill (the scope still sets text colour and tokens). */
    bare?: boolean;
    children?: React.ReactNode;
}
export declare function ThemeScope({ theme, as: As, bare, className, style, children, ...rest }: ThemeScopeProps): import("react/jsx-runtime").JSX.Element;
/** The nearest ThemeScope's theme, or null when the subtree follows the page. */
export declare function usePortalTheme(): ScopeTheme | null;
/**
 * The root every DS portal renders into `document.body`. Carries the nearest scope's markers, so a
 * dialog opened inside a dark island renders dark with dark native controls.
 */
export declare function PortalScope({ children, className }: {
    children?: React.ReactNode;
    className?: string;
}): import("react/jsx-runtime").JSX.Element;
