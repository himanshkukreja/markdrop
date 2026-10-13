/**
 * BrowserFrame (K2 link & frames kit): product UI as illustration (REVAMP_PLAN 6.1). Neutral dots in
 * `border-strong`, an optional tab (favicon + title), and an address bar in LinkPill styling with the
 * key-fragment treatment. Follows the theme, except `paper`, which puts a white page inside (HTML
 * artifacts and PDFs render on white paper in both themes, with `color-scheme: light`).
 *
 * Server-compatible (no hooks). Decorative chrome is aria-hidden; the address text stays readable.
 * Give the frame an accessible name (aria-label / role) at the call site when it is an illustration.
 */
import type { HTMLAttributes, ReactNode } from "react";
import { LinkPill, parseLink, type LinkParts } from "./LinkPill";
import styles from "./BrowserFrame.module.css";

export interface BrowserFrameProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** Tab title. With a title the frame draws a tab strip above the address bar. */
  title?: ReactNode;
  /** Small icon in the tab (e.g. a FileIcon or MarkdropMark at 14px). */
  favicon?: ReactNode;
  /** "markdrop.in/slug#k=…" or the parts. Omit for a frame without an address bar. */
  url?: string | { host?: string; slug: string; fragment?: string };
  /** Leading icon of the address bar (default "link"; "globe" for an external page, null for none). */
  urlIcon?: string | null;
  /** Right side of the toolbar (a "Preview" caption, an IconButton…). */
  actions?: ReactNode;
  /** sm (32px chrome, thumbnails) · md (40px, default) · lg (44px, hero-scale). */
  size?: "sm" | "md" | "lg";
  /** A white page inside (HTML artifacts, PDF). */
  paper?: boolean;
  /** Class for the page area (padding, height, overflow). */
  bodyClassName?: string;
  children?: ReactNode;
}

function toParts(url: BrowserFrameProps["url"]): LinkParts | null {
  if (!url) return null;
  if (typeof url === "string") return parseLink(url);
  return { host: url.host ?? "markdrop.in", slug: url.slug, fragment: url.fragment ?? "" };
}

export function BrowserFrame({
  title,
  favicon,
  url,
  urlIcon = "link",
  actions,
  size = "md",
  paper,
  bodyClassName,
  className,
  children,
  ...rest
}: BrowserFrameProps) {
  const parts = toParts(url);
  const dots = (
    <span className={styles.dots} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
  const address = parts ? (
    <LinkPill
      variant="address"
      size="sm"
      host={parts.host}
      slug={parts.slug}
      fragment={parts.fragment || undefined}
      icon={urlIcon}
      middleEllipsis
      className={styles.address}
    />
  ) : null;

  return (
    <div {...rest} className={[styles.frame, className ?? ""].join(" ")} data-size={size}>
      {title ? (
        <>
          <div className={styles.strip}>
            {dots}
            <span className={styles.tab}>
              {favicon && (
                <span className={styles.favicon} aria-hidden="true">
                  {favicon}
                </span>
              )}
              <span className={styles.tabTitle}>{title}</span>
            </span>
          </div>
          {(address || actions) && (
            <div className={styles.toolbar}>
              <span className={styles.addressSlot}>{address}</span>
              {actions && <span className={styles.actions}>{actions}</span>}
            </div>
          )}
        </>
      ) : (
        <div className={styles.toolbar} data-single>
          {dots}
          <span className={styles.addressSlot}>{address}</span>
          {actions && <span className={styles.actions}>{actions}</span>}
        </div>
      )}
      <div className={[paper ? styles.paper : styles.body, bodyClassName ?? ""].join(" ")}>{children}</div>
    </div>
  );
}

export default BrowserFrame;
