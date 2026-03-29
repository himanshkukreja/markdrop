"use client";

import { RefObject } from "react";

interface ToolbarAction {
  label: string;
  title: string;
  prefix: string;
  suffix: string;
  placeholder: string;
  block?: boolean; // Insert on new line
}

const ACTIONS: ToolbarAction[] = [
  { label: "B",   title: "Bold",         prefix: "**",  suffix: "**",  placeholder: "bold text" },
  { label: "I",   title: "Italic",       prefix: "_",   suffix: "_",   placeholder: "italic text" },
  { label: "H",   title: "Heading",      prefix: "## ", suffix: "",    placeholder: "Heading",     block: true },
  { label: "`",   title: "Inline code",  prefix: "`",   suffix: "`",   placeholder: "code" },
  { label: "</>", title: "Code block",   prefix: "```\n", suffix: "\n```", placeholder: "code here", block: true },
  { label: "🔗",  title: "Link",         prefix: "[",   suffix: "](url)", placeholder: "link text" },
  { label: "•",   title: "List item",    prefix: "- ",  suffix: "",    placeholder: "item",        block: true },
];

interface Props {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
}

export default function MarkdownToolbar({ textareaRef, onChange }: Props) {
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

    // For block-level actions, ensure we start on a fresh line
    if (action.block && before.length > 0 && !before.endsWith("\n")) {
      before += "\n";
    }

    const newText = before + action.prefix + insertion + action.suffix + after;
    onChange(newText);

    // Restore focus and set cursor position after the inserted text
    requestAnimationFrame(() => {
      ta.focus();
      const cursorStart = before.length + action.prefix.length;
      const cursorEnd = cursorStart + insertion.length;
      ta.setSelectionRange(cursorStart, cursorEnd);
    });
  }

  return (
    <div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50">
      {ACTIONS.map((action) => (
        <button
          key={action.title}
          type="button"
          title={action.title}
          onMouseDown={(e) => {
            // Prevent textarea from losing focus
            e.preventDefault();
            applyAction(action);
          }}
          className={`px-2 py-1 text-xs rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 select-none ${
            action.label === "B" ? "font-bold" : ""
          } ${action.label === "I" ? "italic" : ""}`}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
