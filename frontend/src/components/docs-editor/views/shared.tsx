"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { ICONS, Icon, IconButton, Input, Popover } from "@/components/ui";
import { labelText, textLabel } from "../core/fence.mjs";

export const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");

/** Sets attributes on the node at `pos` (a child of a node view, which has no updateAttributes of its own). */
export function setAttrsAt(editor: Editor, pos: number, attrs: Record<string, unknown>) {
  editor
    .chain()
    .command(({ tr }) => {
      const n = tr.doc.nodeAt(pos);
      if (!n) return false;
      tr.setNodeMarkup(pos, undefined, { ...n.attrs, ...attrs });
      return true;
    })
    .run();
}

/** Positions of a node's children, given the node's own position. */
export function childPositions(node: PMNode, pos: number): number[] {
  const out: number[] = [];
  node.forEach((_, offset) => out.push(pos + 1 + offset));
  return out;
}

/** `attributes` with one key set, or removed when the value is empty. */
export function withAttr(attributes: Record<string, string> | null | undefined, key: string, value: string) {
  const next = { ...(attributes ?? {}) };
  if (value) next[key] = value;
  else delete next[key];
  return next;
}

/**
 * A directive `[label]` edited as plain text in an input that sits inside the document but outside
 * ProseMirror's editable content.
 */
export function LabelInput({
  label,
  onChange,
  placeholder,
  className,
  readOnly,
  "aria-label": ariaLabel,
}: {
  label: string | null | undefined;
  onChange: (label: string | null) => void;
  placeholder?: string;
  className?: string;
  readOnly?: boolean;
  "aria-label": string;
}) {
  return (
    <input
      className={cx("dxe-label", !label && "dxe-label--empty", className)}
      value={labelText(label)}
      placeholder={placeholder}
      aria-label={ariaLabel}
      readOnly={readOnly}
      onChange={(e) => onChange(textLabel(e.target.value))}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.currentTarget.closest("[data-node-view-wrapper]")?.querySelector("[data-node-view-content] [contenteditable], [data-node-view-content]") as HTMLElement | null)?.focus();
        }
      }}
      spellCheck
    />
  );
}

/** A small labelled field for block forms (video id, embed address…). */
export function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={cx("dxe-field", wide && "dxe-field--wide")}>
      <span className="dxe-field__label">{label}</span>
      {children}
    </label>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  mono,
  wide,
  readOnly,
  list,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  wide?: boolean;
  readOnly?: boolean;
  list?: string;
}) {
  return (
    <Field label={label} wide={wide}>
      <Input size="sm" mono={mono} value={value} placeholder={placeholder} readOnly={readOnly} list={list} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

const ICON_NAMES = Object.keys(ICONS).sort();

/** A searchable grid of the Markdrop icon set. */
export function IconPicker({
  value,
  onChange,
  label,
  className,
  allowNone = true,
  readOnly,
  size = "md",
}: {
  value: string | null | undefined;
  onChange: (icon: string | null) => void;
  label: string;
  className?: string;
  allowNone?: boolean;
  readOnly?: boolean;
  size?: "sm" | "md";
}) {
  const [q, setQ] = useState("");
  const names = useMemo(() => ICON_NAMES.filter((n) => n.toLowerCase().includes(q.trim().toLowerCase())), [q]);
  const trigger = (
    <button type="button" className={cx("dxe-iconpick", `dxe-iconpick--${size}`, !value && "dxe-iconpick--empty", className)} aria-label={value ? `${label}: ${value}` : label} disabled={readOnly}>
      <Icon name={value && ICONS[value] ? value : "plus"} />
    </button>
  );
  if (readOnly) return trigger;
  return (
    <Popover trigger={trigger} aria-label={label} width={292} portal>
      {({ close }) => (
        <div className="dxe-icongrid">
          <Input size="sm" iconPrefix="search" placeholder="Search icons" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search icons" />
          <div className="dxe-icongrid__list" role="listbox" aria-label="Icons">
            {names.map((n) => (
              <button
                key={n}
                type="button"
                role="option"
                aria-selected={n === value}
                className="dxe-icongrid__opt"
                title={n}
                aria-label={n}
                onClick={() => {
                  onChange(n);
                  close();
                }}
              >
                <Icon name={n} />
              </button>
            ))}
          </div>
          {allowNone && value ? (
            <IconButton
              icon="x"
              label="Remove icon"
              size="sm"
              onClick={() => {
                onChange(null);
                close();
              }}
            />
          ) : null}
        </div>
      )}
    </Popover>
  );
}
