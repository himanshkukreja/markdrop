/**
 * Screen-reader plumbing (REVAMP_PLAN 8.2, 11.2).
 * - `StatusRegion`: one visually hidden polite live region. Mount it once at the root.
 * - `announce(text)`: sets that region's text. It clears first, so the same message twice in a row
 *   ("Copied", "Copied") is announced twice. Buttons never carry aria-live themselves (unreliable
 *   while they hold focus).
 * - `VisuallyHidden`, `SkipLink`.
 */
import React from "react";
/** Announce `text` politely through the shared status region. Safe to call anywhere on the client. */
export declare function announce(text: string): void;
/** The one polite live region `announce()` writes to. Mount once, near the root. */
export declare function StatusRegion(): import("react/jsx-runtime").JSX.Element;
export interface VisuallyHiddenProps extends React.HTMLAttributes<HTMLElement> {
    as?: React.ElementType;
    children?: React.ReactNode;
}
/** Text for screen readers only. */
export declare function VisuallyHidden({ as: As, className, ...rest }: VisuallyHiddenProps): import("react/jsx-runtime").JSX.Element;
export interface SkipLinkProps {
    href?: string;
    children?: React.ReactNode;
    className?: string;
}
/**
 * "Skip to content": the first focusable element of a shell, visible only on focus. It moves focus
 * to the target without touching `location.hash`, because the hash can hold an E2E key (`#k=`)
 * or a tenant token that a plain `href="#main"` navigation would wipe.
 */
export declare function SkipLink({ href, children, className }: SkipLinkProps): import("react/jsx-runtime").JSX.Element;
