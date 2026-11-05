"use client";

/**
 * The assistant's state, shared by every screen (no provider: a tiny store, so a screen registers what
 * it shows without re-rendering the app):
 *
 *  - `here`: what the person is looking at (a doc, a folder, a workspace, the meetings, a meeting, the
 *    home). Screens set it with `useAssistantHere` while mounted.
 *  - `insert` / `reader`: the open editor's "put this at the caret" and "where is the caret" (section,
 *    selection). Only an editor registers `insert`; nothing ever edits a doc by itself.
 *  - `open`, and what to ask on opening (`pending`: a question, a scope).
 *  - The conversation: one thread across screens (localStorage keeps its id for a reload; the turns
 *    live in the chat's memory under PERSIST_KEY).
 */
import { useEffect, useSyncExternalStore } from "react";
import type { AssistantReader, AssistantScopeKind } from "@/lib/ask";

export const PERSIST_KEY = "assistant";
const THREAD_KEY = "md_assistant_thread";

export interface AssistantHere {
  /** A document or page (its slug). */
  page?: string | null;
  workspace?: string | null;
  folder?: string | null;
  meeting?: string | null;
  /** The home: its box is the assistant itself (⌘J focuses it). */
  home?: boolean;
  /** The scope this screen starts on (else the server's default for `here`). */
  scope?: AssistantScopeKind | null;
}

export type InsertFn = (markdown: string) => Promise<boolean> | boolean;
export type ReaderFn = () => AssistantReader | null;

interface State {
  open: boolean;
  here: AssistantHere | null;
  insert: InsertFn | null;
  reader: ReaderFn | null;
  pending: { question?: string; scope?: AssistantScopeKind | null } | null;
  threadId: string | null;
  /** A home box is on screen and takes ⌘J (focuses itself). */
  homeFocus: (() => void) | null;
}

let state: State = { open: false, here: null, insert: null, reader: null, pending: null, threadId: readThread(), homeFocus: null };
const subs = new Set<() => void>();

function readThread(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = localStorage.getItem(THREAD_KEY);
    return v && /^[0-9a-f]{24}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}

export function getAssistant(): State {
  return state;
}

export function useAssistant(): State {
  return useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => state, () => SERVER);
}
const SERVER: State = { open: false, here: null, insert: null, reader: null, pending: null, threadId: null, homeFocus: null };

const SIDE_EVENT = "md:sidepanel";

export function openAssistant(opts: { question?: string; scope?: AssistantScopeKind | null } = {}) {
  if (state.here?.home && state.homeFocus && !opts.scope) {
    state.homeFocus();
    if (opts.question) set({ pending: { question: opts.question } });
    return;
  }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(SIDE_EVENT, { detail: "assistant" }));
  set({ open: true, pending: opts.question || opts.scope ? { question: opts.question, scope: opts.scope ?? null } : state.pending });
}

export function closeAssistant() {
  set({ open: false });
}

export function toggleAssistant() {
  if (state.open) closeAssistant();
  else openAssistant();
}

export function takePending() {
  const p = state.pending;
  if (p) set({ pending: null });
  return p;
}

export function setAssistantThread(id: string | null) {
  if (id === state.threadId) return;
  try {
    if (id) localStorage.setItem(THREAD_KEY, id);
    else localStorage.removeItem(THREAD_KEY);
  } catch { /* storage blocked: this visit only */ }
  set({ threadId: id });
}

/** What this screen shows, while it is mounted (the last one mounted wins; leaving restores nothing). */
export function useAssistantHere(here: AssistantHere | null) {
  const key = here ? JSON.stringify(here) : "";
  useEffect(() => {
    if (!key) return;
    const mine = JSON.parse(key) as AssistantHere;
    set({ here: mine });
    return () => {
      if (state.here && JSON.stringify(state.here) === key) set({ here: null });
    };
  }, [key]);
}

/** The open editor's insert (and caret reader): registered while it is editable. */
export function useAssistantEditor(insert: InsertFn | null, reader: ReaderFn | null) {
  useEffect(() => {
    if (!insert && !reader) return;
    set({ insert, reader });
    return () => {
      if (state.insert === insert && state.reader === reader) set({ insert: null, reader: null });
    };
  }, [insert, reader]);
}

/** A reader (no editor) can still say where they are: the section in view, the selected text. */
export function useAssistantReader(reader: ReaderFn | null) {
  useEffect(() => {
    if (!reader) return;
    if (state.reader) return; // an editor's reader wins
    set({ reader });
    return () => {
      if (state.reader === reader) set({ reader: null });
    };
  }, [reader]);
}

export function useHomeFocus(focus: (() => void) | null) {
  useEffect(() => {
    if (!focus) return;
    set({ homeFocus: focus });
    return () => {
      if (state.homeFocus === focus) set({ homeFocus: null });
    };
  }, [focus]);
}

/** One side panel at a time: another panel (From meetings) opening closes the assistant. */
if (typeof window !== "undefined") {
  window.addEventListener(SIDE_EVENT, (e) => {
    if ((e as CustomEvent).detail !== "assistant" && state.open) set({ open: false });
  });
}
