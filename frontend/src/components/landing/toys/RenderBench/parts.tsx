import { ICONS } from "@/components/ui/icons";
import { FBY, type FileId } from "./model";

/**
 * Server-safe stand-ins for the design-system `Icon` and `FileIcon`. They render the same DS markup
 * (`.md-icon`, stroked on the 24px grid) from the shared `ICONS` map, but without importing
 * `components/ui/primitives`, which pulls in React hooks and so can't load in the server-rendered
 * poster. No hooks, no "use client".
 */
export function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  const d = (ICONS as Record<string, string>)[name] ?? "";
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className ? "md-icon " + className : "md-icon"} style={{ fontSize: size }}>
      <path d={d} />
    </svg>
  );
}

/** FileIcon for the seven sample files: the family glyph in its category tint. */
export function FileIcon({ id, size = 20 }: { id: FileId; size?: number }) {
  const f = FBY[id];
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="md-icon" style={{ fontSize: size, color: f.iconTint }}>
      <path d={(ICONS as Record<string, string>)[f.icon] ?? ""} />
    </svg>
  );
}

/** The Markdrop drop, used by the eyebrow, the upload card and the drag hot zone. */
export function Drop({ className, width, height }: { className?: string; width?: number; height?: number }) {
  return (
    <svg viewBox="0 0 14 18" width={width} height={height} aria-hidden="true" focusable="false" className={className}>
      <path d="M7 0.5c0 0 6 7.4 6 10.6a6 6 0 0 1-12 0C1 7.9 7 0.5 7 0.5z" />
    </svg>
  );
}

export function cx(...a: Array<string | false | null | undefined>): string {
  return a.filter(Boolean).join(" ");
}
