"use client";

import { useEffect, useState } from "react";
import { cx } from "@/components/ui";
import { accentTokens } from "@/components/tenant/branding";
import styles from "./BrandTile.module.css";

export type LogoWell = "light" | "dark" | "checker" | null;

/** Branding as the API now returns it: `logo_well` is newer than lib/workspaces' type (D38). */
export type BrandingWithWell = import("@/lib/workspaces").Branding & { logo_well?: LogoWell | string | null };

export function wellOf(v: unknown): LogoWell {
  return v === "light" || v === "dark" || v === "checker" ? v : null;
}

export function initialsOf(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "W";
}

/**
 * A workspace's brand tile (settings list, detail header, invite card): the logo on its logo well
 * (D38: light, dark, checker, or automatic = follows the theme), else initials on the workspace
 * accent (text colour picked for contrast), else neutral initials. Decorative unless `label`.
 */
export function BrandTile({
  name, logoUrl, logoWell, accent, size = 40, label, className,
}: {
  name: string;
  logoUrl?: string | null;
  logoWell?: LogoWell | string | null;
  accent?: string | null;
  /** px */
  size?: number;
  /** Accessible name; omit when the name is already next to the tile. */
  label?: string;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [logoUrl]);
  const well = wellOf(logoWell);
  // Only http(s) logos (what the API hosts); anything else falls back to initials.
  const showLogo = !!logoUrl && /^https?:\/\//i.test(logoUrl) && !broken;
  const t = !showLogo ? accentTokens(accent) : null;
  const a11y = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true as const };

  return (
    <span
      {...a11y}
      className={cx(
        styles.tile,
        showLogo && (well === "light" ? styles.light : well === "dark" ? styles.dark : well === "checker" ? styles.checker : styles.auto),
        t && styles.accent,
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(11, Math.round(size * 0.36)),
        borderRadius: size <= 24 ? "var(--radius-sm)" : undefined,
        ...(t ? ({ "--ws-fill": t.accent, "--ws-on": t.onAccent } as React.CSSProperties) : null),
      }}
    >
      {showLogo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl!} alt="" onError={() => setBroken(true)} />
      ) : (
        size < 24 ? initialsOf(name).slice(0, 1) : initialsOf(name)
      )}
    </span>
  );
}

export default BrandTile;
