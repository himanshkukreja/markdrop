"use client";

/**
 * The floating format toolbar over a text selection: bold, italic, inline code, link (with an
 * inline address form), turn into heading, turn into list, more (strikethrough, keyboard key), then
 * Ask AI (rewrite the selection; the answer is a suggestion to accept or discard, see assist.tsx)
 * and Comment. A toolbar in the ARIA sense: one tab stop, arrow keys move between buttons.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { BubbleMenu } from "@tiptap/react/menus";
import { useEditorState } from "@tiptap/react";
import { Icon } from "@/components/ui";
import { cx } from "../views/shared";
import { useHost } from "../host";
import type { AssistAction } from "../types";
import { ASSIST_LABEL, type AssistStore } from "./assist";
import { ColorList } from "./ColorMenu";
import { setTextColor } from "../pageKeys";

const CODE_PARENTS = new Set(["codeBlock", "mathBlock"]);

function Btn({ label, active, onClick, children, keys, className, expanded }: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  keys?: string;
  className?: string;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx("dxe-tb__btn", active && "dxe-tb__btn--on", className)}
      aria-label={label}
      aria-pressed={expanded === undefined ? active : undefined}
      aria-haspopup={expanded === undefined ? undefined : "menu"}
      aria-expanded={expanded}
      title={keys ? `${label} (${keys})` : label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

const mod = typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform) ? "⌘" : "Ctrl+";
const alt = typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform) ? "⌥" : "Alt+";

type Menu = null | "heading" | "list" | "more" | "ai" | "color";
type View = "buttons" | "link" | "lang";

interface MenuOption {
  label: string;
  hint?: string;
  icon?: string;
  glyph?: string;
  on?: boolean;
  run: () => void;
}

/** A short menu under one of the toolbar's buttons (inside the toolbar, so the selection stays). */
function ToolMenu({ options, label, onClose }: { options: MenuOption[]; label: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className="dxe-tb__menu"
      onKeyDown={(e) => {
        const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          const j = (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[j]?.focus();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.stopPropagation();
        }
      }}
    >
      {options.map((o) => (
        <button
          key={o.label}
          type="button"
          role={o.on === undefined ? "menuitem" : "menuitemradio"}
          aria-checked={o.on === undefined ? undefined : o.on}
          className={cx("dxe-tb__item", o.on && "dxe-tb__item--on")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            o.run();
            onClose();
          }}
        >
          <span className="dxe-tb__itemicon" aria-hidden>{o.icon ? <Icon name={o.icon} size={15} /> : <span className="dxe-tb__glyph">{o.glyph}</span>}</span>
          <span className="dxe-tb__itemlabel">{o.label}</span>
          {o.hint && <span className="dxe-tb__itemhint">{o.hint}</span>}
        </button>
      ))}
    </div>
  );
}

/** The toolbar's state while the selection is empty (it is hidden then). */
const IDLE = {
  bold: false, italic: false, strike: false, code: false, underline: false, span: null as Record<string, string> | null, kbd: false,
  link: false, href: "", h2: false, h3: false, h4: false, bullet: false, ordered: false, quote: false, from: -1, to: -1,
};

export function FormatToolbar({ editor, stickyTop, assist }: { editor: Editor; stickyTop?: () => number; assist?: AssistStore }) {
  const host = useHost();
  const [view, setView] = useState<View>("buttons");
  const [menu, setMenu] = useState<Menu>(null);
  const [href, setHref] = useState("");
  const [lang, setLang] = useState("");
  const bar = useRef<HTMLDivElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const langInput = useRef<HTMLInputElement>(null);
  const st = useEditorState({
    editor,
    // The toolbar is hidden while the selection is empty or is whole blocks, so typing (and
    // Shift+↓ over a hundred blocks) gets one constant state: no isActive walks, no re-render.
    selector: ({ editor: e }) => (e.state.selection.empty || e.state.selection instanceof NodeSelection || "anchorBlock" in e.state.selection ? IDLE : {
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      underline: e.isActive("underline"),
      span: (e.getAttributes("span").attributes as Record<string, string> | undefined) ?? null,
      kbd: e.isActive("kbd"),
      link: e.isActive("link"),
      href: (e.getAttributes("link").href as string | undefined) ?? "",
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      h4: e.isActive("heading", { level: 4 }),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      quote: e.isActive("blockquote"),
      from: e.state.selection.from,
      to: e.state.selection.to,
    }),
  });

  // A new selection starts on the buttons.
  useEffect(() => {
    setMenu(null);
    if (view === "lang") setView("buttons");
  }, [st.from, st.to]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (view === "link") linkInput.current?.focus();
    if (view === "lang") langInput.current?.focus();
  }, [view]);

  // Ctrl/⌘ K opens the link form when there is a selection.
  useEffect(() => {
    const open = () => {
      setHref(editor.getAttributes("link").href ?? "");
      setView("link");
    };
    const h = editor.storage as unknown as { docsLink?: { open?: () => void } };
    h.docsLink = { open };
  }, [editor]);

  const languages = host.assistLanguages ?? [];
  const shownLangs = useMemo(() => {
    const q = lang.trim().toLowerCase();
    return q ? languages.filter((l) => l.toLowerCase().includes(q)) : languages;
  }, [languages, lang]);

  const applyLink = () => {
    const v = href.trim();
    const chain = editor.chain().focus().extendMarkRange("link");
    if (v) chain.setLink({ href: v }).run();
    else chain.unsetLink().run();
    setView("buttons");
  };

  const ask = (action: AssistAction, language?: string) => {
    if (!host.assist || !assist) return;
    setMenu(null);
    setView("buttons");
    assist.start(editor, host.assist, action, language);
  };

  const comment = () => {
    if (!host.onComment) return;
    const { from, to } = editor.state.selection;
    const doc = editor.state.doc;
    const quote = doc.textBetween(from, to, "\n", " ").trim();
    if (!quote) return;
    const $from = doc.resolve(from);
    const $to = doc.resolve(to);
    const prefix = $from.parent.isTextblock ? doc.textBetween($from.start(), from, "\n", " ").slice(-40) : "";
    const suffix = $to.parent.isTextblock ? doc.textBetween(to, $to.end(), "\n", " ").slice(0, 40) : "";
    host.onComment({ quote: quote.slice(0, 500), prefix, suffix });
    // The toolbar goes; the comment's highlight shows what it's about.
    editor.commands.setTextSelection(to);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (menu) return setMenu(null);
      setView("buttons");
      editor.commands.focus();
      return;
    }
    if (view !== "buttons" || menu || (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End")) return;
    const btns = Array.from(bar.current?.querySelectorAll<HTMLButtonElement>(":scope > .dxe-tb__btn, :scope > .dxe-tb__group > .dxe-tb__btn") ?? []);
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const n = btns.length;
    const j = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + n) % n;
    e.preventDefault();
    btns[j]?.focus();
  };

  const toggle = (m: Exclude<Menu, null>) => setMenu((cur) => (cur === m ? null : m));
  const chain = () => editor.chain().focus();
  const textOn = !st.h2 && !st.h3 && !st.h4;

  return (
    <BubbleMenu
      editor={editor}
      // Above the selection, or below it when the host's sticky bars (stickyTop) would cover it.
      options={{ placement: "top", offset: 8, flip: () => ({ padding: { top: (stickyTop?.() ?? 0) + 8 } }) }}
      shouldShow={({ editor: e, state, from, to }) => {
        if (!e.isEditable || from === to) return false;
        if (assist?.busy) return false;
        if (state.selection instanceof NodeSelection || "anchorBlock" in state.selection) return false;
        const $from = state.doc.resolve(from);
        if (CODE_PARENTS.has($from.parent.type.name)) return false;
        return state.doc.textBetween(from, to, " ").trim().length > 0 || view !== "buttons";
      }}
    >
      <div ref={bar} role="toolbar" aria-label="Format text" className="dxe-tb" onKeyDown={onKeyDown}>
        {view === "link" && (
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
              <button type="button" className="dxe-tb__btn" aria-label="Remove link" onClick={() => { setHref(""); editor.chain().focus().extendMarkRange("link").unsetLink().run(); setView("buttons"); }}>
                <Icon name="x" />
              </button>
            )}
          </form>
        )}
        {view === "lang" && (
          <div className="dxe-tb__lang">
            <div className="dxe-tb__langhead">
              <button type="button" className="dxe-tb__btn" aria-label="Back" onMouseDown={(e) => e.preventDefault()} onClick={() => setView("buttons")}>
                <Icon name="arrowLeft" />
              </button>
              <input
                ref={langInput}
                value={lang}
                onChange={(e) => setLang(e.target.value)}
                placeholder="Translate to…"
                aria-label="Search languages"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && shownLangs[0]) {
                    e.preventDefault();
                    ask("translate", shownLangs[0]);
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    (e.currentTarget.closest(".dxe-tb__lang")?.querySelector(".dxe-tb__langlist button") as HTMLButtonElement | null)?.focus();
                  }
                }}
              />
            </div>
            <div className="dxe-tb__langlist" role="menu" aria-label="Languages"
              onKeyDown={(e) => {
                if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                e.preventDefault();
                const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
                const i = items.indexOf(document.activeElement as HTMLButtonElement);
                if (e.key === "ArrowUp" && i <= 0) return langInput.current?.focus();
                items[Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))]?.focus();
              }}
            >
              {shownLangs.map((l) => (
                <button key={l} type="button" role="menuitem" className="dxe-tb__item" onMouseDown={(e) => e.preventDefault()} onClick={() => ask("translate", l)}>
                  <span className="dxe-tb__itemlabel">{l}</span>
                </button>
              ))}
              {!shownLangs.length && <p className="dxe-tb__none">No language matches.</p>}
            </div>
          </div>
        )}
        {view === "buttons" && (
          <>
            <Btn label="Bold" keys={`${mod}B`} active={st.bold} onClick={() => chain().toggleBold().run()}>
              <Icon name="bold" />
            </Btn>
            <Btn label="Italic" keys={`${mod}I`} active={st.italic} onClick={() => chain().toggleItalic().run()}>
              <Icon name="italic" />
            </Btn>
            {host.pages && (
              <Btn label="Underline" keys={`${mod}U`} active={st.underline} onClick={() => chain().toggleMark("underline").run()}>
                <span className="dxe-tb__u" aria-hidden>U</span>
              </Btn>
            )}
            <Btn label="Inline code" keys={`${mod}E`} active={st.code} onClick={() => chain().toggleCode().run()}>
              <Icon name="code" />
            </Btn>
            <Btn
              label={st.link ? "Edit link" : "Link"}
              keys={`${mod}K`}
              active={st.link}
              onClick={() => {
                setHref(st.href);
                setView("link");
              }}
            >
              <Icon name="link" />
            </Btn>
            {host.pages && (
              <span className="dxe-tb__group">
                <Btn label="Colour" keys={`${mod}⇧H: last colour`} active={!!st.span} expanded={menu === "color"} onClick={() => toggle("color")}>
                  <span className="dxe-tb__color" data-color={st.span?.color} data-bg={st.span?.bg} aria-hidden>A</span>
                  <Icon name="chevronDown" size={12} />
                </Btn>
                {menu === "color" && (
                  <div className="dxe-tb__menu dxe-tb__menu--color">
                    <ColorList current={st.span ? (st.span.color ? { color: st.span.color } : { bg: st.span.bg }) : null} onPick={(c) => setTextColor(editor, c)} onClose={() => setMenu(null)} />
                  </div>
                )}
              </span>
            )}
            <span className="dxe-tb__group">
              <Btn label="Turn into heading" active={!textOn} expanded={menu === "heading"} onClick={() => toggle("heading")}>
                <Icon name="heading" />
              </Btn>
              {menu === "heading" && (
                <ToolMenu
                  label="Turn into"
                  onClose={() => setMenu(null)}
                  options={[
                    { label: "Text", icon: "lines", on: textOn && !st.bullet && !st.ordered, run: () => chain().setParagraph().run() },
                    { label: "Heading", glyph: "H2", hint: `${mod}${alt}2`, on: st.h2, run: () => chain().setHeading({ level: 2 }).run() },
                    { label: "Subheading", glyph: "H3", hint: `${mod}${alt}3`, on: st.h3, run: () => chain().setHeading({ level: 3 }).run() },
                    { label: "Small heading", glyph: "H4", hint: `${mod}${alt}4`, on: st.h4, run: () => chain().setHeading({ level: 4 }).run() },
                  ]}
                />
              )}
            </span>
            <span className="dxe-tb__group">
              <Btn label="Turn into list" active={st.bullet || st.ordered} expanded={menu === "list"} onClick={() => toggle("list")}>
                <Icon name="list" />
              </Btn>
              {menu === "list" && (
                <ToolMenu
                  label="Turn into a list"
                  onClose={() => setMenu(null)}
                  options={[
                    { label: "Bulleted list", icon: "list", hint: `${mod}⇧8`, on: st.bullet, run: () => chain().toggleBulletList().run() },
                    { label: "Numbered list", glyph: "1.", hint: `${mod}⇧7`, on: st.ordered, run: () => chain().toggleOrderedList().run() },
                    { label: "Quote", icon: "message", hint: `${mod}⇧B`, on: st.quote, run: () => chain().toggleBlockquote().run() },
                  ]}
                />
              )}
            </span>
            <span className="dxe-tb__group">
              <Btn label="More formatting" active={st.strike || st.kbd} expanded={menu === "more"} onClick={() => toggle("more")}>
                <Icon name="more" />
              </Btn>
              {menu === "more" && (
                <ToolMenu
                  label="More formatting"
                  onClose={() => setMenu(null)}
                  options={[
                    { label: "Strikethrough", glyph: "S", hint: `${mod}⇧S`, on: st.strike, run: () => chain().toggleStrike().run() },
                    { label: "Keyboard key", glyph: "⌘", hint: `${mod}⇧K`, on: st.kbd, run: () => chain().toggleMark("kbd").run() },
                  ]}
                />
              )}
            </span>
            {(host.assist || host.onComment) && <span className="dxe-tb__sep" aria-hidden />}
            {host.assist && assist && (
              <span className="dxe-tb__group">
                <Btn label="Ask AI" className="dxe-tb__btn--text" expanded={menu === "ai"} onClick={() => toggle("ai")}>
                  <Icon name="zap" size={15} />
                  <span>Ask AI</span>
                  <Icon name="chevronDown" size={12} />
                </Btn>
                {menu === "ai" && (
                  <ToolMenu
                    label="Ask AI"
                    onClose={() => setMenu(null)}
                    options={[
                      { label: ASSIST_LABEL.improve, icon: "sparkle", run: () => ask("improve") },
                      { label: ASSIST_LABEL.shorten, icon: "minimize", run: () => ask("shorten") },
                      { label: ASSIST_LABEL.fix, icon: "checkCircle", run: () => ask("fix") },
                      ...(languages.length ? [{ label: "Translate…", icon: "globe", run: () => { setLang(""); setView("lang"); } }] : []),
                    ]}
                  />
                )}
              </span>
            )}
            {host.onComment && (
              <Btn label="Comment" onClick={comment}>
                <Icon name="message" />
              </Btn>
            )}
          </>
        )}
      </div>
    </BubbleMenu>
  );
}
