import type { ElementType, HTMLAttributes, ReactNode } from "react";

/**
 * The reading layer's type wrapper (REVAMP_PLAN 5.4, 7.6). Maps every `--tw-prose-*` variable
 * (and its `invert` twin) to tokens, so prose follows the theme with no `dark:prose-invert`.
 * Styles live in styles/prose.css (`.md-prose`).
 *
 * - `reading`: 17/28 Manrope in text-secondary on the 680 measure; h1 32/40 800, h2 24/32 700
 *   (48px above), h3 19/28 600, h4 16/24 600. The viewer.
 * - `compact`: 14/22 for previews (/new, the builder, the admin editor).
 *
 * Not a client component: usable from server components.
 */
export type ProseSize = "reading" | "compact";

export interface ProseProps extends HTMLAttributes<HTMLElement> {
  size?: ProseSize;
  /** Element to render (default div). */
  as?: ElementType;
  /** Apply the 680px measure (max-width) and centre the column. Default false: the parent sets the width. */
  measure?: boolean;
  children?: ReactNode;
}

export function Prose({ size = "reading", as: Tag = "div", measure = false, className, children, ...rest }: ProseProps) {
  const cls = ["prose md-prose", `md-prose--${size}`, measure && "md-prose--measure", className].filter(Boolean).join(" ");
  return (
    <Tag className={cls} {...rest}>
      {children}
    </Tag>
  );
}
