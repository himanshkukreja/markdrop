"use client";

/**
 * The `@` people picker (pages): type `@` at the start of a line or after a space or punctuation
 * (never in code) and a popup at the caret lists the workspace's members, avatar, name and email.
 * Typing filters it (fuzzy, by name or email: menus/peopleMatch.ts); ↑/↓ move, Enter or Tab insert,
 * Esc closes it and keeps what was typed, Backspace past the `@` closes it; the mouse works too.
 * `/person` opens the same picker (blocks.ts → services.openPeople).
 *
 * What it inserts is the person mention `:person[Name]{id="…"}` (the `mention` node, name "person")
 * and its block gets an anchor, so the notification a save sends opens the page right there.
 *
 * Members are fetched once per editor (the host's `pages.mentionable`) and kept; the list shows a
 * loading row only when that is slow. A page in no workspace, an edit-link editor with no account
 * and someone who isn't a member of the page's workspace get a line saying so, never anyone's email.
 */
import { Extension, type Editor, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { exitSuggestion, type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Avatar, Spinner, useAnchored } from "@/components/ui";
import type { MentionPeople, MentionPerson } from "../types";
import { cx } from "../views/shared";
import { ensureAnchorAround } from "./blockOps";
import { usePresence } from "./motion";
import { filterPeople, mayOpen } from "./peopleMatch";

interface MenuState {
  open: boolean;
  query: string;
  items: MentionPerson[];
  index: number;
  getRect: (() => DOMRect | null) | null;
  pick: ((p: MentionPerson) => void) | null;
  /** The members' fetch (PeopleStore.status), here so the menu redraws when it changes. */
  status: PeopleStore["status"];
}

const CLOSED: Omit<MenuState, "status"> = { open: false, query: "", items: [], index: 0, getRect: null, pick: null };
/** The loading row waits this long: a quick fetch never shows it. */
const SLOW_MS = 250;

/** Per editor: the menu's state, and the members (fetched once, then kept). */
export class PeopleStore {
  state: MenuState = { ...CLOSED, status: "idle" };
  /** "/person" put the `@` there: open even where a typed one wouldn't. */
  force = false;
  /** Where the open picker's `@` is (another `@` isn't "already open"). */
  openAt: number | null = null;
  status: "idle" | "loading" | "ready" | "error" = "idle";
  result: MentionPeople | null = null;
  fetcher: (() => Promise<MentionPeople>) | null = null;
  private subs = new Set<() => void>();
  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };
  get = () => this.state;
  private emit() {
    if (this.state.status !== this.status) this.state = { ...this.state, status: this.status };
    this.subs.forEach((f) => f());
  }
  set(patch: Partial<MenuState>) {
    this.state = { ...this.state, ...patch, status: this.status };
    this.emit();
  }
  /** The members once loaded (null before). */
  people(): MentionPerson[] | null {
    return this.status === "ready" ? this.result?.people ?? [] : null;
  }
  /** Starts the one fetch (again after a failure). */
  load() {
    if (this.status === "loading" || this.status === "ready") return;
    if (!this.fetcher) {
      this.result = { state: "personal", people: [] };
      this.status = "ready";
      this.emit();
      return;
    }
    this.status = "loading";
    this.emit();
    this.fetcher().then(
      (r) => {
        this.result = r;
        this.status = "ready";
        // The open menu filters what just arrived.
        this.set({ items: filterPeople(this.result.people, this.state.query), index: 0 });
      },
      () => {
        this.status = "error";
        this.emit();
      },
    );
  }
}

export const peopleKey = new PluginKey("docsPeople");

/** Puts the person mention in place of `@query` (the same node "/person" always made). */
export function insertPerson(editor: Editor, range: Range, p: MentionPerson) {
  const label = p.name.replace(/[[\]\\\n\r]+/g, " ").trim() || "Someone";
  // A space after the chip, to keep typing (as the date chip has), unless one or punctuation is
  // already there, or the chip ends a table cell (a cell's value: a trailing space there is
  // written into the Markdown as "&#x20;").
  const $end = editor.state.doc.resolve(range.to);
  const cell = /^table(Cell|Header)$/.test($end.parent.type.name);
  const next = $end.parent.textBetween($end.parentOffset, Math.min($end.parentOffset + 1, $end.parent.content.size), "", "\ufffc");
  const space = next === "" ? !cell : /[\p{L}\p{N}]/u.test(next);
  const content: Array<Record<string, unknown>> = [{ type: "mention", attrs: { name: "person", label, attributes: { id: p.id } } }];
  if (space) content.push({ type: "text", text: " " });
  editor.chain().focus().insertContentAt(range, content).run();
  // The block gets an anchor ({#b-…}), so the person's notification opens the page right here.
  try {
    ensureAnchorAround(editor, range.from);
  } catch {
    /* an anchor is a convenience: the mention stands without one */
  }
}

/**
 * `@PAY-12` (or `@jira`): a Jira issue's chip (components/jira/pages), offered after the people when the
 * page's host has Jira. "jira:" alone inserts an empty chip, whose issue picker opens.
 */
function jiraOptions(editor: Editor, query: string): MentionPerson[] {
  if (!(editor.storage as unknown as { dxeServices?: { pages?: { jiraPages?: unknown } } }).dxeServices?.pages?.jiraPages) return [];
  const q = query.trim();
  if (/^[A-Za-z][A-Za-z0-9_]{0,19}-[1-9][0-9]{0,8}$/.test(q)) return [{ id: `jira:${q.toUpperCase()}`, name: `${q.toUpperCase()} · Jira issue` }];
  if (q.length >= 2 && "jira".startsWith(q.toLowerCase())) return [{ id: "jira:", name: "Jira issue…" }];
  return [];
}

/** "/person" (and an empty person chip): an `@` that opens the picker. */
export function openPeopleAt(editor: Editor, store: PeopleStore, range: Range) {
  store.force = true;
  editor.chain().focus().insertContentAt(range, "@").run();
}

export function PeopleMention(store: PeopleStore, listboxId: string) {
  return Extension.create({
    name: "docsPeople",
    // Before the keymaps (with the "/" menu), so Enter, Tab, arrows and Esc reach it while open.
    priority: 1000,
    addProseMirrorPlugins() {
      const editor = this.editor;
      const aria = (on: boolean, index = 0) => {
        const el = editor.view.dom;
        if (on) {
          el.setAttribute("aria-controls", listboxId);
          el.setAttribute("aria-expanded", "true");
          el.setAttribute("aria-activedescendant", `${listboxId}-${index}`);
        } else {
          el.removeAttribute("aria-controls");
          el.removeAttribute("aria-activedescendant");
          el.setAttribute("aria-expanded", "false");
        }
      };
      const show = (p: SuggestionProps<MentionPerson, MentionPerson>) => {
        store.load();
        store.openAt = p.range.from;
        const prev = store.get();
        const same = prev.open && prev.items.length === p.items.length && prev.items.every((it, i) => it.id === p.items[i]?.id);
        const index = same ? prev.index : 0;
        store.set({ open: true, query: p.query, items: p.items, index, getRect: p.clientRect ?? null, pick: (it) => p.command(it) });
        aria(p.items.length > 0, index);
      };
      return [
        Suggestion<MentionPerson, MentionPerson>({
          editor,
          pluginKey: peopleKey,
          char: "@",
          // Names have spaces ("@ben m"); peopleMatch.keepsOpen closes it once nobody matches.
          allowSpaces: true,
          startOfLine: false,
          // Our own rule (peopleMatch.opensAfter): after whitespace or punctuation, never "a@b".
          allowedPrefixes: null,
          allow: ({ state, range, isActive }) => mayOpen(state, range, store.people(), store.force, !!isActive && store.openAt === range.from),
          items: ({ query, editor: e }) => {
            const people = store.people();
            return [...(people ? filterPeople(people, query) : []), ...jiraOptions(e, query)];
          },
          command: ({ editor: e, range, props }) =>
            props.id.startsWith("jira:")
              ? void e.chain().focus().insertContentAt(range, [{ type: "mention", attrs: { name: "jira", label: props.id.slice(5), attributes: {} } }, { type: "text", text: " " }]).run()
              : insertPerson(e, range, props),
          render: () => ({
            onStart: show,
            onUpdate: show,
            onKeyDown: ({ event }: SuggestionKeyDownProps) => {
              const s = store.get();
              if (!s.open) return false;
              // Esc: the suggestion plugin closes it (and keeps it closed for this `@`); the text stays.
              if (event.key === "Escape") return true;
              const n = s.items.length;
              if (!n) {
                // Still loading: wait (Enter would otherwise start a new line under the `@`).
                if ((event.key === "Enter" || event.key === "Tab") && store.status === "loading") return true;
                return false;
              }
              const go = (index: number) => {
                store.set({ index });
                aria(true, index);
                return true;
              };
              if (event.key === "ArrowDown" || event.key === "ArrowUp") return go((s.index + (event.key === "ArrowDown" ? 1 : -1) + n) % n);
              if (event.key === "Enter" || event.key === "Tab") {
                if (event.isComposing) return false;
                const it = s.items[s.index];
                if (it) s.pick?.(it);
                return true;
              }
              return false;
            },
            onExit: () => {
              store.force = false;
              store.openAt = null;
              store.set(CLOSED);
              aria(false);
            },
          }),
        }),
      ];
    },
  });
}

/** Closes the picker and keeps the text (a click outside, the editor losing focus). */
export function closePeople(editor: Editor) {
  if (!editor.isDestroyed && (peopleKey.getState(editor.state) as { active?: boolean } | undefined)?.active) exitSuggestion(editor.view, peopleKey);
}

const NOTE: Record<Exclude<MentionPeople["state"], "ok">, string> = {
  personal: "This page isn't in a workspace, so there's no one to mention. Move it into a workspace to mention your team.",
  signin: "Sign in to mention people.",
  not_member: "Only members of this page's workspace can mention people here.",
};

/** The popup at the caret. */
export function PeopleMenu({ store, listboxId }: { store: PeopleStore; listboxId: string }) {
  const live = useSyncExternalStore(store.subscribe, store.get, store.get);
  const { mounted, closing } = usePresence(live.open);
  const last = useRef(live);
  if (live.open) last.current = live;
  const s = live.open ? live : last.current;
  const panel = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLElement | null>(null);
  anchor.current = { getBoundingClientRect: () => s.getRect?.() ?? new DOMRect(-9999, -9999, 0, 0) } as HTMLElement;
  const status = s.status;
  const result = store.result;

  // A loading row only when the fetch is slow.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!live.open || status !== "loading") {
      setSlow(false);
      return;
    }
    const t = window.setTimeout(() => setSlow(true), SLOW_MS);
    return () => window.clearTimeout(t);
  }, [live.open, status]);

  const rect = live.open ? s.getRect?.() : null;
  const { up, style } = useAnchored(mounted, anchor, panel, {
    placement: "auto",
    align: "left",
    portal: true,
    fit: true,
    watch: `${s.items.length}|${status}|${slow}|${rect ? `${Math.round(rect.left)},${Math.round(rect.bottom)}` : ""}`,
  });

  // The chosen row stays in view.
  useLayoutEffect(() => {
    const el = panel.current?.querySelector<HTMLElement>(`#${CSS.escape(`${listboxId}-${s.index}`)}`);
    el?.scrollIntoView({ block: "nearest" });
  }, [s.index, listboxId]);

  if (!mounted || typeof document === "undefined") return null;

  let body: React.ReactNode;
  if (s.items.length) {
    body = (
      <div id={live.open ? listboxId : undefined} role="listbox" aria-label="Mention someone" className="dxe-people__list">
        {s.items.map((p, i) => (
          <div
            key={p.id}
            id={live.open ? `${listboxId}-${i}` : undefined}
            role="option"
            aria-selected={i === s.index}
            className={cx("dxe-people__opt", i === s.index && "dxe-people__opt--on")}
            onMouseMove={() => {
              if (store.get().index !== i) store.set({ index: i });
            }}
            onClick={() => s.pick?.(p)}
          >
            <Avatar name={p.name} src={p.avatar_url ?? undefined} size="sm" className="dxe-people__avatar" />
            <span className="dxe-people__text ph-no-capture">
              <span className="dxe-people__name ph-mask">
                {p.name}
                {p.you && <span className="dxe-people__you"> (you)</span>}
              </span>
              {p.email && <span className="dxe-people__email ph-mask">{p.email}</span>}
            </span>
          </div>
        ))}
      </div>
    );
  } else {
    let note: React.ReactNode = null;
    if (status === "loading") note = slow ? (<><Spinner size={14} /> Loading people…</>) : null;
    else if (status === "error") note = "Couldn't load people. Check your connection, then type @ again.";
    else if (result && result.state !== "ok") note = NOTE[result.state];
    else if (result && !result.people.length) note = "No one to mention yet. Invite people to the workspace first.";
    else note = s.query ? <>No one matches “{s.query.trim()}”</> : "No one matches";
    body = note ? (
      <div className="dxe-people__note" role="status">
        {note}
      </div>
    ) : (
      <div className="dxe-people__note dxe-people__note--wait" aria-hidden />
    );
  }

  return createPortal(
    <div
      ref={panel}
      className={cx("dxe-people dxe-pop", up && "dxe-pop--up")}
      data-closing={closing ? "" : undefined}
      style={style ?? { position: "fixed", left: -9999, top: -9999 }}
      onMouseDown={(e) => e.preventDefault()} // keep focus (and the caret) in the page
    >
      {body}
    </div>,
    document.body,
  );
}
