"use client";

import type { ReactNode } from "react";
import type { ArtifactRenderer } from "@/lib/api";

/**
 * Type chip for an artifact — a tinted, icon-led badge whose colour is keyed to
 * the file family, so a dashboard of mixed documents stays scannable at a
 * glance rather than turning into a wall of identical rows.
 */
const STYLES: Record<
  ArtifactRenderer,
  { label: string; ring: string; text: string; bg: string; icon: ReactNode }
> = {
  html: {
    label: "HTML",
    ring: "ring-orange-500/25",
    text: "text-orange-600 dark:text-orange-400",
    bg: "bg-orange-500/10",
    icon: (
      <path d="M4 17l-3-5 3-5M20 7l3 5-3 5M14 4l-4 16" strokeLinecap="round" strokeLinejoin="round" />
    ),
  },
  pdf: {
    label: "PDF",
    ring: "ring-red-500/25",
    text: "text-red-600 dark:text-red-400",
    bg: "bg-red-500/10",
    icon: (
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" strokeLinejoin="round" />
        <path d="M14 2v6h6" strokeLinejoin="round" />
      </>
    ),
  },
  sheet: {
    label: "Sheet",
    ring: "ring-emerald-500/25",
    text: "text-emerald-600 dark:text-emerald-400",
    bg: "bg-emerald-500/10",
    icon: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M3 9h18M3 15h18M9 3v18" />
      </>
    ),
  },
  docx: {
    label: "Word",
    ring: "ring-blue-500/25",
    text: "text-blue-600 dark:text-blue-400",
    bg: "bg-blue-500/10",
    icon: (
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" strokeLinejoin="round" />
        <path d="M14 2v6h6" strokeLinejoin="round" />
        <path d="M8 13h8M8 17h5" strokeLinecap="round" />
      </>
    ),
  },
  bundle: {
    label: "Site",
    ring: "ring-teal-500/25",
    text: "text-teal-600 dark:text-teal-400",
    bg: "bg-teal-500/10",
    icon: (
      <>
        <path d="M3 7l9-4 9 4-9 4-9-4z" strokeLinejoin="round" />
        <path d="M3 12l9 4 9-4M3 17l9 4 9-4" strokeLinejoin="round" />
      </>
    ),
  },
  image: {
    label: "Image",
    ring: "ring-violet-500/25",
    text: "text-violet-600 dark:text-violet-400",
    bg: "bg-violet-500/10",
    icon: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="m21 15-5-5L5 21" strokeLinejoin="round" />
      </>
    ),
  },
  text: {
    label: "Text",
    ring: "ring-sky-500/25",
    text: "text-sky-600 dark:text-sky-400",
    bg: "bg-sky-500/10",
    icon: (
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" strokeLinejoin="round" />
        <path d="M8 13h8M8 17h5" strokeLinecap="round" />
      </>
    ),
  },
  download: {
    label: "File",
    ring: "ring-gray-500/25",
    text: "text-gray-600 dark:text-gray-400",
    bg: "bg-gray-500/10",
    icon: (
      <>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" strokeLinecap="round" />
        <path d="m7 10 5 5 5-5M12 15V3" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },
};

export function artifactStyle(renderer: ArtifactRenderer | null | undefined) {
  return STYLES[renderer ?? "download"] ?? STYLES.download;
}

export function formatBytes(n: number | null | undefined): string {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ArtifactBadge({
  renderer,
  label,
  className = "",
}: {
  renderer: ArtifactRenderer | null | undefined;
  label?: string | null;
  className?: string;
}) {
  const s = artifactStyle(renderer);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${s.bg} ${s.text} ${s.ring} ${className}`}
    >
      <svg
        className="w-3 h-3"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden
      >
        {s.icon}
      </svg>
      {label || s.label}
    </span>
  );
}
