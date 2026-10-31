"use client";

/**
 * The floating format toolbar over a text selection: bold, italic, strikethrough, inline code,
 * keyboard key, link (with an inline address form) and "turn into" for the block. A toolbar in the
 * ARIA sense: one tab stop, arrow keys move between buttons.
 */
import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { BubbleMenu } from "@tiptap/react/menus";
import { useEditorState } from "@tiptap/react";
import { Icon } from "@/components/ui";
import { cx } from "../views/shared";

const CODE_PARENTS = new Set(["codeBlock", "mathBlock"]);

function Btn({ label, active, onClick, children, keys }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode; keys?: string }) {
  return (
    <button
      type="button"
      className={cx("dxe-tb__btn", active && "dxe-tb__btn--on")}
      aria-label={label}
      aria-pressed={active}
      title={keys ? `${label} (${keys})` : label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

const mod = typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform) ? "⌘" : "Ctrl+";

export function FormatToolbar({ editor, stickyTop }: { editor: Editor; stickyTop?: () => number }) {
  const [linking, setLinking] = useState(false);
  const [href, setHref] = useState("");
  const bar = useRef<HTMLDivElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      kbd: e.isActive("kbd"),
      link: e.isActive("link"),
      href: (e.getAttributes("link").href as string | undefined) ?? "",
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
    }),
  });

  useEffect(() => {
    if (linking) linkInput.current?.focus();
  }, [linking]);

  // Ctrl/⌘ K opens the link form when there is a selection.
  useEffect(() => {
    const open = () => {
      setHref(editor.getAttributes("link").href ?? "");
      setLinking(true);
    };
    const h = editor.storage as unknown as { docsLink?: { open?: () => void } };
    h.docsLink = { open };
  }, [editor]);

  const applyLink = () => {
    const v = href.trim();
    const chain = editor.chain().focus().extendMarkRange("link");
    if (v) chain.setLink({ href: v }).run();
    else chain.unsetLink().run();
    setLinking(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (linking || (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End")) {
      if (e.key === "Escape") {
        e.preventDefault();
        setLinking(false);
        editor.commands.focus();
      }
      return;
    }
    const btns = Array.from(bar.current?.querySelectorAll<HTMLButtonElement>(".dxe-tb__btn") ?? []);
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const n = btns.length;
    const j = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + n) % n;
    e.preventDefault();
    btns[j]?.focus();
  };

  return (
    <BubbleMenu
      editor={editor}
      // Above the selection, or below it when the host's sticky bars (stickyTop) would cover it.
      options={{ placement: "top", offset: 8, flip: () => ({ padding: { top: (stickyTop?.() ?? 0) + 8 } }) }}
      shouldShow={({ editor: e, state, from, to }) => {
        if (!e.isEditable || from === to) return false;
        if (state.selection instanceof NodeSelection) return false;
        const $from = state.doc.resolve(from);
        if (CODE_PARENTS.has($from.parent.type.name)) return false;
        return state.doc.textBetween(from, to, " ").trim().length > 0 || linking;
      }}
    >
      <div ref={bar} role="toolbar" aria-label="Format text" className="dxe-tb" onKeyDown={onKeyDown}>
        {linking ? (
          <form
            className="dxe-tb__link"
            onSubmit={(e) => {
              e.preventDefault();
              applyLink();
            }}
          >
            <Icon name="link" />
            <input ref={linkInput} value={href} onChange={(e) => setHref(e.target.value)} placeholder="/page, #section or https://…" aria-label="Link address" />
            <button type="submit" className="dxe-tb__btn" aria-label="Apply link">
              <Icon name="check" />
            </button>
            {st.link && (
              <button type="button" className="dxe-tb__btn" aria-label="Remove link" onClick={() => { setHref(""); editor.chain().focus().extendMarkRange("link").unsetLink().run(); setLinking(false); }}>
                <Icon name="x" />
              </button>
            )}
          </form>
        ) : (
          <>
            <Btn label="Bold" keys={`${mod}B`} active={st.bold} onClick={() => editor.chain().focus().toggleBold().run()}>
              <Icon name="bold" />
            </Btn>
            <Btn label="Italic" keys={`${mod}I`} active={st.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>
              <Icon name="italic" />
            </Btn>
            <Btn label="Strikethrough" keys={`${mod}Shift+S`} active={st.strike} onClick={() => editor.chain().focus().toggleStrike().run()}>
              <span className="dxe-tb__glyph dxe-tb__glyph--strike">S</span>
            </Btn>
            <Btn label="Inline code" keys={`${mod}E`} active={st.code} onClick={() => editor.chain().focus().toggleCode().run()}>
              <Icon name="code" />
            </Btn>
            <Btn label="Keyboard key" keys={`${mod}Shift+K`} active={st.kbd} onClick={() => editor.chain().focus().toggleMark("kbd").run()}>
              <span className="dxe-tb__glyph dxe-tb__glyph--kbd">⌘</span>
            </Btn>
            <Btn
              label={st.link ? "Edit link" : "Link"}
              keys={`${mod}K`}
              active={st.link}
              onClick={() => {
                setHref(st.href);
                setLinking(true);
              }}
            >
              <Icon name="link" />
            </Btn>
            <span className="dxe-tb__sep" aria-hidden />
            <Btn label="Heading" active={st.h2} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
              <span className="dxe-tb__glyph">H2</span>
            </Btn>
            <Btn label="Subheading" active={st.h3} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
              <span className="dxe-tb__glyph">H3</span>
            </Btn>
          </>
        )}
      </div>
    </BubbleMenu>
  );
}
