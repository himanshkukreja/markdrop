"use client";

import { useState } from "react";
import { Icon, cx } from "@/components/ui";
import { safeLogoUrl } from "@/lib/oauthClient";

/**
 * An OAuth client's logo on a light logo well, or a neutral tile with the name's first letter when
 * there is no usable logo (or it fails to load). Decorative: the name is always written beside it.
 * `referrerPolicy="no-referrer"` keeps the consent URL (it carries the request id) away from
 * whoever hosts the logo.
 */
export function ClientLogo({ name, logo, size = 40, className }: { name: string; logo: string | null | undefined; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const src = failed ? null : safeLogoUrl(logo);
  const initial = name.trim().charAt(0).toUpperCase();
  const box = { width: size, height: size };
  if (src) {
    return (
      <span
        className={cx("grid flex-none place-items-center overflow-hidden rounded-xl border border-border", className)}
        style={{ ...box, background: "var(--logo-well-light)", padding: Math.round(size * 0.14) }}
        aria-hidden="true"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" referrerPolicy="no-referrer" className="size-full object-contain" onError={() => setFailed(true)} />
      </span>
    );
  }
  return (
    <span
      className={cx("grid flex-none place-items-center rounded-xl border border-border bg-surface-active font-bold text-text-secondary", className)}
      style={{ ...box, fontSize: Math.round(size * 0.42) }}
      aria-hidden="true"
    >
      {initial && (initial.toLowerCase() !== initial.toUpperCase() || /\d/.test(initial)) ? initial : <Icon name="sparkle" size={Math.round(size * 0.45)} />}
    </span>
  );
}

export default ClientLogo;
