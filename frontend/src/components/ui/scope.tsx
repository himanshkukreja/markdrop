"use client";
/**
 * Theme islands (REVAMP_PLAN 5.3). `ThemeScope` pins a subtree to one theme: tokens re-scope by
 * `data-theme`, the `.dark` class keeps legacy `dark:` variants in step, and `color-scheme` keeps
 * native controls and scrollbars matching. Portals leave the island's DOM, so it also provides a
 * context: every DS portal (Dialog, Drawer, portalled Dropdown/Popover) reads `usePortalTheme()`
 * and stamps the same three markers on its portal root. Toasts are page-level and don't.
 */
import React, { createContext, useContext } from "react";

export type ScopeTheme = "dark" | "light";

export const ThemeScopeContext = createContext<ScopeTheme | null>(null);

export interface ThemeScopeProps extends React.HTMLAttributes<HTMLElement> {
  theme: ScopeTheme;
  /** Element to render; default "div". */
  as?: React.ElementType;
  /** Skip the `bg` fill (the scope still sets text colour and tokens). */
  bare?: boolean;
  children?: React.ReactNode;
}

export function ThemeScope({ theme, as: As = "div", bare, className, style, children, ...rest }: ThemeScopeProps) {
  const cls = "md-scope " + (theme === "dark" ? "dark " : "") + (bare ? "md-scope--bare " : "") + (className ?? "");
  return (
    <ThemeScopeContext.Provider value={theme}>
      <As data-theme={theme} className={cls.trim()} style={{ colorScheme: theme, ...style }} {...rest}>
        {children}
      </As>
    </ThemeScopeContext.Provider>
  );
}

/** The nearest ThemeScope's theme, or null when the subtree follows the page. */
export function usePortalTheme(): ScopeTheme | null {
  return useContext(ThemeScopeContext);
}

/**
 * The root every DS portal renders into `document.body`. Carries the nearest scope's markers, so a
 * dialog opened inside a dark island renders dark with dark native controls.
 */
export function PortalScope({ children, className }: { children?: React.ReactNode; className?: string }) {
  const theme = usePortalTheme();
  const cls = "md-portal" + (theme === "dark" ? " dark" : "") + (className ? " " + className : "");
  return (
    <div className={cls} data-theme={theme ?? undefined} style={theme ? { colorScheme: theme } : undefined}>
      {children}
    </div>
  );
}
