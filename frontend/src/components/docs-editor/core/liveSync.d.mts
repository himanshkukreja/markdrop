import type { EditorState, Transaction } from "@tiptap/pm/state";

export function incomingValue(lastEmitted: string, pending: string | null, value: string): { incoming: string; typed: string | null };
export function appendTr(state: EditorState, markdown: string): Transaction | null;
