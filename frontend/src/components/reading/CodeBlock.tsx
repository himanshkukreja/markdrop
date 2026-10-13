"use client";

import type { ReactNode } from "react";
import { CopyButton } from "@/components/ui";
import { useOverflowFade } from "./ScrollBox";

export interface CodeBlockProps {
  /** The raw code (what Copy copies). */
  code: string;
  /** Language id from the fence (`python`, `ts`…). Shown as the mono eyebrow; "text" when absent. */
  language?: string;
  /**
   * Highlighted content for the `<pre>` (MarkdownPreview passes the hljs `<code>` element). When
   * absent, `code` is rendered as plain text.
   */
  children?: ReactNode;
  className?: string;
}

/**
 * A fenced code block (REVAMP_PLAN 7.6 "CodeBlock"): a 32px header strip with the language and a
 * ghost "Copy" that is always visible at 100% opacity on every device; a 13/20 mono body on
 * `code-bg` with a `code-border` hairline, `syntax-*` colours (styles/syntax.css), horizontal scroll
 * with a right-edge fade while more code is hidden. Follows the theme (D14).
 */
export function CodeBlock({ code, language, children, className }: CodeBlockProps) {
  const [ref, { overflowing, more }] = useOverflowFade<HTMLPreElement>();
  const lang = (language ?? "").trim();
  return (
    <div className={["md-codeblock not-prose", className].filter(Boolean).join(" ")} role="group" aria-label={lang ? `Code, ${lang}` : "Code"}>
      <div className="md-codeblock__head">
        <span className="md-codeblock__lang">{lang || "text"}</span>
        <CopyButton text={code} label="Copy" copiedLabel="Copied" announceText="Code copied" variant="ghost" size="sm" className="md-codeblock__copy no-print" />
      </div>
      <div className="md-codeblock__body" data-more={more ? "" : undefined}>
        <pre ref={ref} className="md-codeblock__pre" tabIndex={overflowing ? 0 : undefined}>
          {children ?? <code>{code}</code>}
        </pre>
        <span className="md-codeblock__fade" aria-hidden />
      </div>
    </div>
  );
}
