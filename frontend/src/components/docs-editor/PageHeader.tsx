"use client";

/**
 * Page icon, title and description above the content, bound to the frontmatter keys `icon`,
 * `title` and `description` (each written back in place; the rest of the frontmatter is untouched).
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { readMeta, writeFrontmatter } from "./core/frontmatter.mjs";
import { IconPicker } from "./views/shared";

const DESCRIPTION_MAX = 160;

function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

export function PageHeader({ front, onFront, readOnly }: { front: string; onFront: (front: string) => void; readOnly?: boolean }) {
  const meta = readMeta(front);
  const title = useRef<HTMLTextAreaElement>(null);
  const desc = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    autosize(title.current);
    autosize(desc.current);
  });
  // Re-measure when the column width changes (stylesheet arriving, window resize).
  useEffect(() => {
    const els = [title.current, desc.current].filter(Boolean) as HTMLTextAreaElement[];
    if (typeof ResizeObserver === "undefined" || !els.length) return;
    let w = els.map((e) => e.clientWidth);
    const ro = new ResizeObserver(() => {
      const now = els.map((e) => e.clientWidth);
      if (now.some((x, i) => x !== w[i])) {
        w = now;
        els.forEach(autosize);
      }
    });
    els.forEach((e) => ro.observe(e));
    return () => ro.disconnect();
  }, []);
  const set = (key: "title" | "description" | "icon", v: string | null) => onFront(writeFrontmatter(front, { [key]: v }, { keep: ["title", "description"] }));
  const over = meta.description.length > DESCRIPTION_MAX;
  return (
    <header className="dxe-header">
      <div className="dxe-header__icon">
        <IconPicker value={meta.icon || null} label="Page icon" readOnly={readOnly} onChange={(icon) => set("icon", icon)} />
        {!meta.icon && !readOnly && <span className="dxe-muted">Icon</span>}
      </div>
      <textarea
        ref={title}
        className="dxe-header__title"
        rows={1}
        value={meta.title}
        placeholder="Page title"
        aria-label="Page title"
        readOnly={readOnly}
        onChange={(e) => set("title", e.target.value.replace(/\n/g, " "))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            desc.current?.focus();
          }
        }}
      />
      <textarea
        ref={desc}
        className="dxe-header__desc"
        rows={1}
        value={meta.description}
        placeholder="A one-sentence description (shown under the title and in search results)"
        aria-label="Page description"
        aria-invalid={over || undefined}
        readOnly={readOnly}
        onChange={(e) => set("description", e.target.value.replace(/\n/g, " "))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.currentTarget.closest(".dxe-root")?.querySelector(".ProseMirror") as HTMLElement | null)?.focus();
          }
        }}
      />
      {over && (
        <p className="dxe-header__warn" role="status">
          {meta.description.length}/{DESCRIPTION_MAX} characters: search results cut it short.
        </p>
      )}
    </header>
  );
}
