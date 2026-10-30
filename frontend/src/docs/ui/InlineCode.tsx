/** Inline `code` in short config/data strings (home notes, changelog summaries): backticks become code spans. */
export function InlineCode({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/`([^`]+)`/);
  return (
    <span className={className}>
      {parts.map((p, i) => (i % 2 ? <code key={i} className="dx-icode">{p}</code> : p))}
    </span>
  );
}
