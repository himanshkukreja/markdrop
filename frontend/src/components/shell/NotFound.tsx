"use client";

import { useEffect, useState } from "react";
import styles from "./shell.module.css";

/** The mark with its drop missing: the drop falls, lands beside the pill and splashes, once. */
export function MissedDropMark({ size = 96 }: { size?: number }) {
  return (
    <svg width={size * 1.5} height={size} viewBox="0 0 72 48" className={styles.missed} aria-hidden>
      <rect x="4" y="8" width="32" height="32" rx="8" style={{ fill: "var(--logo-ground)" }} />
      <text x="7" y="31" fontSize="18" fontWeight="700" style={{ fontFamily: "var(--font-mono), ui-monospace, monospace", fill: "var(--logo-ink)" }}>
        m
      </text>
      {/* Where the drop should have been: an empty socket. */}
      <circle cx="31" cy="28" r="3.5" fill="none" strokeWidth="1" strokeDasharray="2 2" style={{ stroke: "var(--logo-drop)", opacity: 0.55 }} />
      <ellipse className={styles.ring} cx="52" cy="40" rx="5" ry="1.6" fill="none" strokeWidth="1" style={{ stroke: "var(--logo-drop)" }} />
      <circle className={styles.spray} cx="48" cy="38" r="1" style={{ fill: "var(--logo-drop)" }} />
      <circle className={`${styles.spray} ${styles.sprayR}`} cx="56" cy="38" r="1" style={{ fill: "var(--logo-drop)" }} />
      <circle className={styles.drop} cx="52" cy="36" r="4" style={{ fill: "var(--logo-dot)" }} />
    </svg>
  );
}

/** The address that was asked for, read after mount (never server-rendered: 404 HTML is shared). */
export function AttemptedPath() {
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => {
    setPath(window.location.host + decodeURIComponentSafe(window.location.pathname));
  }, []);
  if (!path) return <span className="block h-6" aria-hidden />;
  return (
    <code className="font-mono text-code inline-block max-w-full rounded-md bg-code-inline-bg px-2 py-1 text-code-inline [overflow-wrap:anywhere]">
      {path}
    </code>
  );
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
