/**
 * EditorFrame (K2 link & frames kit): a head row (file tab, toolbar, meter), a `code-bg` body with a
 * line-number gutter, and a status bar. Follows the theme (mocks never stay dark; REVAMP_PLAN 5.4).
 *
 * Server-compatible (no hooks). String children render as numbered lines (gutter + mono 13/20);
 * any other children render as-is in the body (a real textarea/CodeMirror, a SplitPane…), so the
 * same frame serves illustrations and the /new editor shell. The frame shows `:focus-within` with a
 * `border-focus` edge; `readOnly` adds a quiet "Read only" note in the head.
 */
import type { HTMLAttributes, ReactNode } from "react";
import { KitIcon } from "./DeviceGlyph";
import styles from "./EditorFrame.module.css";

export interface EditorFrameProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** File tab text, e.g. "release-notes.md". */
  tab?: ReactNode;
  /** Tab icon: an icon name (default "lines") or a node (VSCodeIcon, FileIcon). null hides it. */
  icon?: string | ReactNode | null;
  /** Head-row controls after the tab (Tabs, formatting IconButtons). */
  toolbar?: ReactNode;
  /** Right end of the head row (a character Meter, a sync Badge). */
  meter?: ReactNode;
  /** Status bar content (left-aligned; put a right group in a flex child with margin-left:auto). */
  status?: ReactNode;
  /** Code as text (numbered lines) or any body node. */
  children?: ReactNode;
  readOnly?: boolean;
  /** First line number for string children (default 1). */
  startLine?: number;
  /** 1-based line numbers to highlight (accent-soft) for string children. */
  highlight?: number[];
  /** Class for the body (height, overflow). */
  bodyClassName?: string;
}

export function EditorFrame({
  tab,
  icon = "lines",
  toolbar,
  meter,
  status,
  children,
  readOnly,
  startLine = 1,
  highlight,
  bodyClassName,
  className,
  ...rest
}: EditorFrameProps) {
  const hasHead = tab != null || toolbar != null || meter != null || readOnly;
  const iconNode = icon == null ? null : typeof icon === "string" ? <KitIcon name={icon} size={14} /> : icon;
  const lines = typeof children === "string" ? children.replace(/\n$/, "").split("\n") : null;
  const hl = new Set(highlight ?? []);

  return (
    <div {...rest} className={[styles.frame, className ?? ""].join(" ")} data-readonly={readOnly || undefined}>
      {hasHead && (
        <div className={styles.head}>
          {tab != null && (
            <span className={styles.tab}>
              {iconNode && (
                <span className={styles.tabIcon} aria-hidden="true">
                  {iconNode}
                </span>
              )}
              <span className={styles.tabText}>{tab}</span>
            </span>
          )}
          {toolbar != null && <div className={styles.toolbar}>{toolbar}</div>}
          {(meter != null || readOnly) && (
            <div className={styles.meter}>
              {readOnly && <span className={styles.readOnly}>Read only</span>}
              {meter}
            </div>
          )}
        </div>
      )}
      <div className={[styles.body, bodyClassName ?? ""].join(" ")}>
        {lines ? (
          // Focusable so keyboard users can scroll long lines sideways (WCAG 2.1.1).
          <pre className={`${styles.code} md-focus`} tabIndex={0}>
            <code className={styles.codeGrid}>
              {lines.map((line, i) => {
                const n = startLine + i;
                return (
                  <span key={i} className={styles.line} data-hl={hl.has(n) || undefined}>
                    <span className={styles.num} aria-hidden="true">
                      {n}
                    </span>
                    <span className={styles.text}>{line || " "}</span>
                  </span>
                );
              })}
            </code>
          </pre>
        ) : (
          children
        )}
      </div>
      {status != null && <div className={styles.status}>{status}</div>}
    </div>
  );
}

export default EditorFrame;
