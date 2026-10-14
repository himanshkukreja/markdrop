/**
 * CommandBlock (K2 link & frames kit): a terminal command on `code-bg` in mono with a prompt and a DS
 * CopyButton. Follows the theme (D14). The prompt is decorative (aria-hidden, unselectable) and is
 * never copied. Multi-line commands get one prompt per line; the copy is the lines joined by "\n".
 *
 * Server-compatible (no hooks); the CopyButton is a client component rendered only when `copy`.
 */
import { CopyButton } from "@/components/ui/markdrop";
import styles from "./CommandBlock.module.css";

export interface CommandBlockProps {
  /** The command (newlines = several commands). */
  command: string;
  /** Default "$". Pass "" for none. */
  prompt?: string;
  /** Show the copy button (default true). */
  copy?: boolean;
  /** Copy button label (default "Copy command"); also what the status region announces as done. */
  copyLabel?: string;
  onCopy?: () => void;
  /** Optional small caption above the command ("Terminal", "macOS and Linux"). */
  label?: string;
  /** Wrap long commands instead of scrolling sideways. */
  wrap?: boolean;
  className?: string;
}

export function CommandBlock({ command, prompt = "$", copy = true, copyLabel = "Copy command", onCopy, label, wrap, className }: CommandBlockProps) {
  const lines = command.replace(/\n$/, "").split("\n");
  return (
    <div className={[styles.block, className ?? ""].join(" ")} data-wrap={wrap || undefined}>
      {label && <div className={styles.label}>{label}</div>}
      <div className={styles.row}>
        {/* Focusable so keyboard users can scroll a long command sideways (WCAG 2.1.1). */}
        <pre className={`${styles.pre} md-focus`} tabIndex={wrap ? undefined : 0}>
          <code className={styles.code}>
            {lines.map((line, i) => (
              <span key={i} className={styles.line}>
                {prompt && (
                  <span className={styles.prompt} aria-hidden="true">
                    {prompt}
                  </span>
                )}
                <span className={styles.cmd}>{line}</span>
              </span>
            ))}
          </code>
        </pre>
        {copy && <CopyButton text={lines.join("\n")} label={copyLabel} copiedLabel="Copied" iconOnly size="sm" onCopy={onCopy} className={styles.copy} />}
      </div>
    </div>
  );
}

export default CommandBlock;
