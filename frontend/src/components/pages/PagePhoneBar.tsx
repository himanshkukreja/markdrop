"use client";

/**
 * Phones: the page's bottom toolbar while editing (the caret is in the page). It sits on top of
 * the keyboard (the visual viewport), with 44 px targets:
 *
 *   +        a new block under this one, with the block menu ("/") open
 *   /        the block menu at the caret
 *   ⋮⋮       this block's menu (Turn into, colour, duplicate, delete, …)
 *   ☑        select this block (then the selection bar's actions)
 *   Aa       format: bold, italic, underline, strike, code, link, and Turn into (a bottom sheet)
 *   ✦        Ask AI: on the selection (a bottom sheet), or the "/ai" prompt at the caret
 *   🎙       From meetings (memory/MeetingMemory's panel, a bottom sheet), when the workspace has
 *            meetings: the pill above Ask steps aside while this toolbar is up
 *   ↶ ↷      undo, redo
 *   ⌄        done: put the keyboard away
 *
 * Buttons never take the focus from the page (pointerdown is cancelled), so the keyboard stays up.
 */
import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Icon, cx } from "@/components/ui";
import { PageSheet } from "./PageChrome";
import { openSlashAt } from "@/components/docs-editor/menus/slash";
import { aiHooks } from "@/components/docs-editor/menus/aiKeys";
import { MEETINGS_BUTTON_EVENT, services } from "@/components/docs-editor/menus/mediaUpload";

type Cmds = Record<string, ((...a: unknown[]) => boolean) | undefined>;
const has = (ed: Editor, name: string) => typeof (ed.commands as unknown as Cmds)[name] === "function";
const run = (ed: Editor, name: string, ...args: unknown[]) => {
  const chain = ed.chain().focus() as unknown as Record<string, (...a: unknown[]) => { run: () => boolean }>;
  if (typeof chain[name] !== "function") return false;
  return (chain[name](...args) as unknown as { run: () => boolean }).run();
};

/** Where the caret's top-level block starts (for its menu). */
function blockPos(ed: Editor): number | null {
  const s = ed.state.selection as unknown as { headBlock?: number; $from: { depth: number; node: (d: number) => { type: { name: string } }; before: (d: number) => number } };
  if (typeof s.headBlock === "number") return s.headBlock;
  const $f = s.$from;
  for (let d = $f.depth; d >= 1; d--) if ($f.node(d - 1).type.name === "doc") return $f.before(d);
  return null;
}

/** The keyboard's height (iOS and Android keep `position: fixed` under it otherwise). */
function useKeyboardInset(on: boolean) {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!on || !vv) return;
    let raf = 0;
    const up = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))));
    };
    up();
    vv.addEventListener("resize", up);
    vv.addEventListener("scroll", up);
    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener("resize", up);
      vv.removeEventListener("scroll", up);
    };
  }, [on]);
  return inset;
}

const MARKS: Array<{ cmd: string; mark: string; icon?: string; text?: string; label: string }> = [
  { cmd: "toggleBold", mark: "bold", icon: "bold", label: "Bold" },
  { cmd: "toggleItalic", mark: "italic", icon: "italic", label: "Italic" },
  { cmd: "toggleUnderline", mark: "underline", text: "U", label: "Underline" },
  { cmd: "toggleStrike", mark: "strike", text: "S", label: "Strikethrough" },
  { cmd: "toggleCode", mark: "code", icon: "code", label: "Inline code" },
];

const TURN: Array<{ label: string; glyph: string; go: (ed: Editor) => boolean; on: (ed: Editor) => boolean }> = [
  { label: "Text", glyph: "T", go: (ed) => run(ed, "setParagraph"), on: (ed) => ed.isActive("paragraph") && !ed.isActive("bulletList") && !ed.isActive("orderedList") && !ed.isActive("taskList") && !ed.isActive("blockquote") },
  { label: "Heading 1", glyph: "H1", go: (ed) => run(ed, "toggleHeading", { level: 1 }), on: (ed) => ed.isActive("heading", { level: 1 }) },
  { label: "Heading 2", glyph: "H2", go: (ed) => run(ed, "toggleHeading", { level: 2 }), on: (ed) => ed.isActive("heading", { level: 2 }) },
  { label: "Heading 3", glyph: "H3", go: (ed) => run(ed, "toggleHeading", { level: 3 }), on: (ed) => ed.isActive("heading", { level: 3 }) },
  { label: "Bulleted list", glyph: "•", go: (ed) => run(ed, "toggleBulletList"), on: (ed) => ed.isActive("bulletList") },
  { label: "Numbered list", glyph: "1.", go: (ed) => run(ed, "toggleOrderedList"), on: (ed) => ed.isActive("orderedList") },
  { label: "To-do list", glyph: "☐", go: (ed) => run(ed, "toggleTaskList"), on: (ed) => ed.isActive("taskList") },
  { label: "Quote", glyph: "❝", go: (ed) => run(ed, "toggleBlockquote"), on: (ed) => ed.isActive("blockquote") },
];

export function PagePhoneBar({ editor, readOnly, ai = false }: { editor: Editor | null; readOnly: boolean; ai?: boolean }) {
  const [focused, setFocused] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [, setTick] = useState(0);
  const blurTimer = useRef(0);

  useEffect(() => {
    if (!editor) return;
    const focus = () => {
      window.clearTimeout(blurTimer.current);
      setFocused(true);
    };
    // A short grace: tapping a toolbar button blurs for a moment on some browsers.
    const blur = () => {
      window.clearTimeout(blurTimer.current);
      blurTimer.current = window.setTimeout(() => setFocused(editor.isFocused), 120);
    };
    const tick = () => setTick((n) => n + 1);
    editor.on("focus", focus);
    editor.on("blur", blur);
    editor.on("transaction", tick);
    if (editor.isFocused) setFocused(true);
    window.addEventListener(MEETINGS_BUTTON_EVENT, tick);
    return () => {
      window.removeEventListener(MEETINGS_BUTTON_EVENT, tick);
      editor.off("focus", focus);
      editor.off("blur", blur);
      editor.off("transaction", tick);
      window.clearTimeout(blurTimer.current);
    };
  }, [editor]);

  const shown = !!editor && !readOnly && (focused || sheet);
  const inset = useKeyboardInset(shown);
  if (!editor || editor.isDestroyed) return null;

  // Keep the caret (and the keyboard) in the page. Not on a touch's pointerdown: WebKit then sends no
  // click at all, so every button was dead on iPhones; the mousedown that follows a tap keeps the focus.
  const keep = (e: React.PointerEvent | React.MouseEvent) => {
    if ((e as React.PointerEvent).pointerType !== "touch") e.preventDefault();
  };
  // The block menu opens on a "/" at the start of a line or after a space (as when typed).
  const slashAtCaret = () => {
    const { $from } = editor.state.selection;
    const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset, "\n", "\n");
    editor.chain().focus().insertContent(before && !/\s/.test(before) ? " /" : "/").run();
  };
  // A new block under this one, with the block menu open (what "+" beside a block does).
  const addBlock = () => {
    const { $from } = editor.state.selection;
    const empty = $from.parent.type.name === "paragraph" && !$from.parent.content.size;
    const pos = blockPos(editor);
    const node = pos === null ? null : editor.state.doc.nodeAt(pos);
    if (empty || !node) {
      slashAtCaret();
      return;
    }
    openSlashAt(editor, pos! + node.nodeSize);
  };
  const blockMenu = () => {
    const api = (editor.storage as unknown as { dxeBlockMenu?: { open: (pos: number) => void } }).dxeBlockMenu;
    const pos = blockPos(editor);
    if (api && pos !== null) api.open(pos);
  };
  const can = editor.can();
  const meetings = services(editor).meetingsButton;
  const btn = (label: string, body: React.ReactNode, onClick: () => void, opts: { disabled?: boolean; pressed?: boolean; wide?: boolean; testId?: string } = {}) => (
    <button
      type="button"
      className={cx("pb-phonebar__btn", opts.wide && "pb-phonebar__btn--wide")}
      aria-label={label}
      data-testid={opts.testId}
      aria-pressed={opts.pressed}
      disabled={opts.disabled}
      onPointerDown={keep}
      onMouseDown={keep}
      onClick={onClick}
    >
      {body}
    </button>
  );

  return (
    <>
      <div
        className="pb-phonebar no-print"
        data-on={shown ? "" : undefined}
        role="toolbar"
        aria-label="Editing"
        aria-hidden={!shown}
        style={{ transform: shown ? `translate3d(0, ${-inset}px, 0)` : undefined }}
      >
        {btn("Add a block", <Icon name="plus" size={20} aria-hidden />, addBlock)}
        {btn("Block menu (/)", <span className="pb-phonebar__glyph" aria-hidden>/</span>, slashAtCaret)}
        {btn("This block's menu", <Icon name="grip" size={20} aria-hidden />, blockMenu)}
        {btn("Select this block", <Icon name="checkSquare" size={20} aria-hidden />, () => editor.commands.keyboardShortcut("Escape"))}
        {btn("Format", <Icon name="type" size={20} aria-hidden />, () => setSheet(true), { pressed: sheet })}
        {ai && btn("Ask AI", <Icon name="sparkle" size={20} aria-hidden />, () => {
          const h = aiHooks(editor);
          if (!h || h.busy()) return;
          const { from, to } = editor.state.selection;
          if (from !== to && editor.state.doc.textBetween(from, to, " ").trim()) h.menu();
          else h.prompt();
        })}
        {meetings && btn(meetings.count ? `From meetings (${meetings.count} related)` : "From meetings", (
          <span className="pb-phonebar__mm" aria-hidden>
            <Icon name="mic" size={20} />
            {meetings.count > 0 && <span className="pb-phonebar__count">{meetings.count}</span>}
          </span>
        ), meetings.open, { testId: "mm-phonebar" })}
        <span className="pb-phonebar__sep" aria-hidden />
        {btn("Undo", <Icon name="undo" size={20} aria-hidden />, () => run(editor, "undo"), { disabled: !(can as unknown as Cmds).undo?.() })}
        {btn("Redo", <Icon name="redo" size={20} aria-hidden />, () => run(editor, "redo"), { disabled: !(can as unknown as Cmds).redo?.() })}
        {btn("Done", <Icon name="chevronDown" size={20} aria-hidden />, () => { editor.commands.blur(); (document.activeElement as HTMLElement | null)?.blur?.(); }, { wide: true })}
      </div>
      <PageSheet open={sheet} onClose={() => setSheet(false)} title="Format">
        <div className="pb-format">
          <div className="pb-format__marks" role="group" aria-label="Text style">
            {MARKS.filter((m) => has(editor, m.cmd)).map((m) => (
              <button
                key={m.cmd}
                type="button"
                className="pb-format__mark md-focus"
                aria-label={m.label}
                aria-pressed={editor.isActive(m.mark)}
                onPointerDown={keep}
                onMouseDown={keep}
                onClick={() => run(editor, m.cmd)}
              >
                {m.icon ? <Icon name={m.icon} size={18} aria-hidden /> : <span className={`pb-format__t pb-format__t--${m.mark}`} aria-hidden>{m.text}</span>}
              </button>
            ))}
            {has(editor, "setLink") && (
              <button
                type="button"
                className="pb-format__mark md-focus"
                aria-label="Link"
                aria-pressed={editor.isActive("link")}
                onPointerDown={keep}
                onMouseDown={keep}
                onClick={() => {
                  if (editor.isActive("link")) {
                    run(editor, "unsetLink");
                    return;
                  }
                  const href = window.prompt("Link to");
                  if (href && /^(https?:\/\/|mailto:|\/)/.test(href.trim())) run(editor, "setLink", { href: href.trim() });
                }}
              >
                <Icon name="link" size={18} aria-hidden />
              </button>
            )}
          </div>
          <p className="pb-format__h">Turn into</p>
          <div className="pb-format__turn" role="group" aria-label="Turn into">
            {TURN.map((t) => (
              <button
                key={t.label}
                type="button"
                className="pb-format__row md-focus"
                aria-pressed={t.on(editor)}
                onPointerDown={keep}
                onMouseDown={keep}
                onClick={() => {
                  t.go(editor);
                  setSheet(false);
                }}
              >
                <span className="pb-format__glyph" aria-hidden>{t.glyph}</span>
                {t.label}
                {t.on(editor) && <Icon name="check" size={16} className="pb-format__check" aria-hidden />}
              </button>
            ))}
          </div>
        </div>
      </PageSheet>
    </>
  );
}

export default PagePhoneBar;
