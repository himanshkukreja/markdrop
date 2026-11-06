/**
 * Jira in Markdrop's UI: a neutral ticket glyph in the accent colour, not Atlassian's logo (the design
 * system has no brand icons, and docs media show Markdrop's UI only).
 */
export function JiraMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden focusable="false" className={className}
      fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--accent-text, currentColor)" }}>
      <path d="M3 8a2 2 0 0 0 2-2V5h14v1a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2v1H5v-1a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4z" />
      <path d="M9 9.5h6M9 12h6M9 14.5h3.5" />
    </svg>
  );
}
