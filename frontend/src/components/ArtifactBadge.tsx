"use client";

import { Badge, FileIcon, cx, type FileRenderer } from "@/components/ui";
import type { ArtifactRenderer } from "@/lib/api";

/**
 * Type chip for an artifact. A neutral DS `Badge` (status colours are for states, never for file
 * families); the family's category tint lives on the `FileIcon` beside it, so a mixed list stays
 * scannable without a rainbow of badges.
 */
const LABELS: Record<ArtifactRenderer, string> = {
  html: "HTML",
  video: "Video",
  pdf: "PDF",
  sheet: "Sheet",
  docx: "Word",
  bundle: "Site",
  image: "Image",
  text: "Text",
  download: "File",
};

/** The DS FileIcon renderer for an artifact renderer (`download` has none: name/mime decide). */
export function artifactFileRenderer(renderer: ArtifactRenderer | null | undefined): FileRenderer | undefined {
  if (!renderer || renderer === "download") return undefined;
  return renderer === "bundle" ? "zip" : renderer;
}

export function artifactStyle(renderer: ArtifactRenderer | null | undefined) {
  const r = renderer ?? "download";
  return { label: LABELS[r] ?? LABELS.download, fileRenderer: artifactFileRenderer(r) };
}

/** "2.4 MB", "25 MB" (a whole number drops its ".0"), "1.2 GB". */
export function formatBytes(n: number | null | undefined): string {
  if (!n) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  const one = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  if (n < 1024 * 1024) return `${one(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${one(n / (1024 * 1024))} MB`;
  return `${one(n / (1024 * 1024 * 1024))} GB`;
}

export default function ArtifactBadge({
  renderer,
  label,
  icon = false,
  className = "",
}: {
  renderer: ArtifactRenderer | null | undefined;
  label?: string | null;
  /** Draw the family's FileIcon inside the badge (for places with no icon beside it). */
  icon?: boolean;
  className?: string;
}) {
  const s = artifactStyle(renderer);
  return (
    <Badge tone="neutral" variant="outline" size="sm" upper className={cx("shrink-0", className)}>
      {icon && <FileIcon renderer={s.fileRenderer} size={12} />}
      {label || s.label}
    </Badge>
  );
}
