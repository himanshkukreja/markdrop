"use client";

import { RefObject, useRef, useState, type KeyboardEvent } from "react";
import { Icon, Tooltip, cx } from "@/components/ui";

/**
 * Markdown formatting buttons for a textarea (used by /new, the viewer's editor and the builder).
 *
 * The buttons act on `click`, so Enter and Space work from the keyboard; `mousedown` only stops the
 * textarea losing its selection (and, on phones, the keyboard closing). It is one `toolbar` with a
 * single tab stop: arrow keys, Home and End move between buttons (WAI-ARIA toolbar pattern). Each
 * button is named, and a tooltip shows the name on hover and focus.
 */

interface ToolbarAction {
  title: string;
  icon?: string;
  label?: string;
  prefix: string;
  suffix: string;
  placeholder: string;
  /** Insert on a new line. */
  block?: boolean;
}

const ACTIONS: ToolbarAction[] = [
  { title: "Bold", icon: "bold", prefix: "**", suffix: "**", placeholder: "bold text" },
  { title: "Italic", icon: "italic", prefix: "_", suffix: "_", placeholder: "italic text" },
  { title: "Heading", icon: "heading", prefix: "## ", suffix: "", placeholder: "Heading", block: true },
  { title: "Inline code", label: "`", prefix: "`", suffix: "`", placeholder: "code" },
  { title: "Code block", icon: "code", prefix: "```\n", suffix: "\n```", placeholder: "code here", block: true },
  { title: "Link", icon: "link", prefix: "[", suffix: "](url)", placeholder: "link text" },
  { title: "List item", icon: "list", prefix: "- ", suffix: "", placeholder: "item", block: true },
];

interface Props {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  /** Inline on a tab row: no background, border or padding of its own. */
  bare?: boolean;
  /** Bigger (44px) targets, e.g. the phone strip above the keyboard. */
  large?: boolean;
  className?: string;
}

export default function MarkdownToolbar({ textareaRef, onChange, bare = false, large = false, className }: Props) {
  const [active, setActive] = useState(0);
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function applyAction(action: ToolbarAction) {
    const ta = textareaRef.current;
    if (!ta) return;

    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const value = ta.value;
    const selected = value.slice(start, end);
    const insertion = selected || action.placeholder;

    let before = value.slice(0, start);
    const after = value.slice(end);

    // Block-level actions start on a fresh line.
    if (action.block && before.length > 0 && !before.endsWith("\n")) {
      before += "\n";
    }

    onChange(before + action.prefix + insertion + action.suffix + after);

    // Back into the text with the inserted words selected, so typing replaces the placeholder.
    requestAnimationFrame(() => {
      ta.focus();
      const cursorStart = before.length + action.prefix.length;
      ta.setSelectionRange(cursorStart, cursorStart + insertion.length);
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const n = ACTIONS.length;
    let next = -1;
    if (e.key === "ArrowRight") next = (active + 1) % n;
    else if (e.key === "ArrowLeft") next = (active - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else return;
    e.preventDefault();
    setActive(next);
    btnRefs.current[next]?.focus();
  }

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      onKeyDown={onKeyDown}
      className={cx("md-toolbar", bare && "md-toolbar--bare", "min-w-0 items-center", className)}
    >
      {ACTIONS.map((action, i) => (
        <Tooltip key={action.title} content={action.title} side="bottom">
          <button
            ref={(el) => { btnRefs.current[i] = el; }}
            type="button"
            className={cx("md-toolbar__btn shrink-0 select-none", large ? "h-11 min-w-11" : "pointer-coarse:h-11 pointer-coarse:min-w-11")}
            aria-label={action.title}
            tabIndex={i === active ? 0 : -1}
            onFocus={() => setActive(i)}
            // Keep the textarea's selection and focus (and a phone's keyboard) while clicking.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => applyAction(action)}
          >
            {action.icon ? <Icon name={action.icon} size={14} /> : <span aria-hidden>{action.label}</span>}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}
