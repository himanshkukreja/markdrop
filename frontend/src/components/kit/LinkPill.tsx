/**
 * LinkPill (K2 link & frames kit): `markdrop.in/slug` in mono, an optional key fragment in the one
 * standard key treatment (REVAMP_PLAN 6.1: mono accent-text on an accent-soft chip led by the `key`
 * icon, "Stays in your browser" where there is room), and an optional DS CopyButton.
 *
 * Server-compatible: no hooks. It renders the DS CopyButton and Anchor (client components) only when
 * `copy` / `href` are set. Long paths ellipsise (or middle-ellipsise) but the fragment chip never
 * shrinks out of view. The DOM always holds the full text, so screen readers and text selection get
 * the whole link.
 */
import type { ReactNode } from "react";
import { CopyButton } from "@/components/ui/markdrop";
import { Anchor } from "@/components/ui/link";
import { KitIcon } from "./DeviceGlyph";
import styles from "./LinkPill.module.css";

export interface LinkParts {
  host: string;
  slug: string;
  /** Normalised to start with "#", or "" when there is none. */
  fragment: string;
}

/** "https://markdrop.in/a/b#k=x" → { host: "markdrop.in", slug: "a/b", fragment: "#k=x" }. */
export function parseLink(url: string): LinkParts {
  const noProto = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const hashAt = noProto.indexOf("#");
  const beforeHash = hashAt >= 0 ? noProto.slice(0, hashAt) : noProto;
  const fragment = hashAt >= 0 ? noProto.slice(hashAt) : "";
  const slashAt = beforeHash.indexOf("/");
  return slashAt >= 0
    ? { host: beforeHash.slice(0, slashAt), slug: beforeHash.slice(slashAt + 1), fragment }
    : { host: beforeHash, slug: "", fragment };
}

/** Normalises "k=abc" / "#k=abc" to "#k=abc"; "" stays "". */
export function normalizeFragment(fragment?: string | null): string {
  if (!fragment) return "";
  return fragment.startsWith("#") ? fragment : `#${fragment}`;
}

/** The full https URL for a host/slug/fragment triple. */
export function linkHref(host: string, slug: string, fragment?: string): string {
  return `https://${host}${slug ? `/${slug.replace(/^\/+/, "")}` : ""}${normalizeFragment(fragment)}`;
}

export type LinkPillSize = "sm" | "md" | "lg";

export interface LinkPillProps {
  /** Default "markdrop.in". */
  host?: string;
  /** The path after the host, without a leading slash ("release-notes", "share/7f3a9c21e4"). */
  slug: string;
  /** "#k=…" or "k=…": shown in the key treatment and included in the copied URL. */
  fragment?: string;
  /** true copies the full URL (fragment included); a string copies that string instead. */
  copy?: boolean | string;
  /** How the copy control looks: icon-only ghost (default) or a labelled "Copy link" button. */
  copyAs?: "icon" | "secondary" | "primary";
  /** CopyButton label (default "Copy link"). */
  copyLabel?: string;
  onCopy?: () => void;
  size?: LinkPillSize;
  /** Keep the start and the last characters of a long slug ("very-long-sl…-notes"). */
  middleEllipsis?: boolean;
  /** Makes host/slug a link (DS Anchor, so next/link for internal hrefs). */
  href?: string;
  target?: string;
  /** Leading icon name (default "link"); null hides it. */
  icon?: string | null;
  /** "Stays in your browser" after the key chip. Default: shown at size lg. */
  fragmentLabel?: boolean;
  /** "pill" (default, bordered on --bg) or "address" (a browser address bar on surface-inset). */
  variant?: "pill" | "address";
  /** Optional trailing content (a badge, a button) before the copy control. */
  trailing?: ReactNode;
  className?: string;
}

const TAIL = 6;

/** The fragment chip in the standard key treatment. Exported for frames that place it themselves. */
export function KeyChip({ fragment, size = "md", empty, className }: { fragment?: string; size?: LinkPillSize; empty?: boolean; className?: string }) {
  const f = normalizeFragment(fragment) || "#k=";
  return (
    <span
      className={[styles.chip, empty ? styles.chipEmpty : "", className ?? ""].join(" ")}
      data-size={size}
      title={empty ? "The key goes here" : "The key. It stays in your browser."}
    >
      <KitIcon name="key" size={size === "sm" ? 12 : 14} className={styles.chipIcon} />
      {empty ? (
        <>
          <span className={styles.chipText}>#k=</span>
          <span className={styles.chipHole} aria-hidden="true" />
          <span className="md-visually-hidden">(missing)</span>
        </>
      ) : (
        <span className={styles.chipText}>{f}</span>
      )}
    </span>
  );
}

export function LinkPill({
  host = "markdrop.in",
  slug,
  fragment,
  copy,
  copyAs = "icon",
  copyLabel = "Copy link",
  onCopy,
  size = "md",
  middleEllipsis,
  href,
  target,
  icon = "link",
  fragmentLabel,
  variant = "pill",
  trailing,
  className,
}: LinkPillProps) {
  const cleanSlug = slug.replace(/^\/+/, "");
  const frag = normalizeFragment(fragment);
  const full = linkHref(host, cleanSlug, frag);
  const showLabel = !!frag && (fragmentLabel ?? size === "lg");
  const split = middleEllipsis && cleanSlug.length > TAIL * 2;
  const head = split ? cleanSlug.slice(0, -TAIL) : cleanSlug;
  const tail = split ? cleanSlug.slice(-TAIL) : "";

  const path = (
    <>
      <span className={styles.host}>
        {host}
        {cleanSlug ? "/" : ""}
      </span>
      {split ? (
        <>
          <span className={styles.slugHead}>{head}</span>
          <span className={styles.slugTail}>{tail}</span>
        </>
      ) : (
        <span className={styles.slugHead}>{cleanSlug}</span>
      )}
    </>
  );

  const copyText = typeof copy === "string" ? copy : full;
  const btnSize = size === "lg" ? "md" : "sm";

  return (
    <span
      className={[styles.pill, className ?? ""].join(" ")}
      data-size={size}
      data-variant={variant}
      title={full.replace(/^https:\/\//, "")}
    >
      {icon && (
        <span className={styles.lead} aria-hidden="true">
          <KitIcon name={icon} size={size === "lg" ? 14 : 12} />
        </span>
      )}
      <span className={styles.url}>
        {href ? (
          <Anchor href={href} target={target} rel={target === "_blank" ? "noopener noreferrer" : undefined} className={`md-focus ${styles.path} ${styles.pathLink}`}>
            {path}
          </Anchor>
        ) : (
          <span className={styles.path}>{path}</span>
        )}
        {frag && <KeyChip fragment={frag} size={size} />}
        {showLabel && <span className={styles.label}>Stays in your browser</span>}
      </span>
      {trailing}
      {copy ? (
        copyAs === "icon" ? (
          <CopyButton text={copyText} label={copyLabel} iconOnly size="sm" onCopy={onCopy} className={styles.copy} />
        ) : (
          <CopyButton text={copyText} label={copyLabel} size={btnSize} variant={copyAs} onCopy={onCopy} className={styles.copy} />
        )
      ) : null}
    </span>
  );
}

export default LinkPill;
