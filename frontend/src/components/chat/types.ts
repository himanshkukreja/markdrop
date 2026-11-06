/**
 * The shared chat (components/chat): one conversation UI for every "ask" surface (Ask across meetings, Ask
 * this meeting; next, Ask Markdrop everywhere). The chat knows nothing about meetings or pages: a
 * `ChatTransport` turns a question into `ChatEvent`s, citations arrive already described, and scope /
 * context are opaque values the transport understands.
 */
import type { ReactNode } from "react";

/** One source an answer cites. `token` is what the model wrote between brackets ("s12", "M2-s14", "3"). */
export interface ChatCitation {
  token: string;
  /** e.g. "Sprint planning". */
  title: string;
  /** e.g. "Nov 2, 2026 · Sprint planning". */
  subtitle?: string | null;
  /** e.g. "Ben Member · 0:53". */
  meta?: string | null;
  /** What the source says there (a transcript line, a paragraph). */
  quote?: string | null;
  href: string;
  /** An icon name from components/ui (default "doc"). */
  icon?: string;
  /** The link's label in the sources list (default "Open"). E.g. "Jump to moment". */
  action?: string;
  external?: boolean;
}

/** What an answer read (shown while it is written, then folded into "N sources"). */
export interface ChatSource {
  id: string;
  title: string;
  subtitle?: string | null;
  href: string;
  icon?: string;
}

export type ChatEvent =
  /** What the assistant is doing ("Finding the meetings…"). */
  | { type: "stage"; label: string }
  /** What it is reading; `note`: which part it picked ("Only Daily standup · last month"). */
  | { type: "sources"; items: ChatSource[]; note?: string | null }
  | { type: "delta"; text: string }
  | { type: "done"; answer: string; citations: ChatCitation[]; sources?: ChatSource[]; note?: string | null; threadId?: string | null }
  /** An AI budget or limit ("AI budget reached, try again later"). */
  | { type: "limit"; message: string }
  | { type: "error"; message: string; retryable?: boolean };

export interface ChatHistoryItem { question: string; answer: string }

export interface ChatRequest<S = unknown, C = unknown> {
  question: string;
  history: ChatHistoryItem[];
  scope: S;
  context: C | undefined;
  threadId: string | null;
  signal: AbortSignal;
}

/** Ask: emit events as they come; resolve when the stream ends (a stream without `done` is "stopped early"). */
export type ChatTransport<S = unknown, C = unknown> = (req: ChatRequest<S, C>, emit: (e: ChatEvent) => void) => Promise<void>;

export type ChatTurnState = "streaming" | "done" | "stopped" | "limit" | "error" | "withheld";

export interface ChatTurn {
  id: string;
  question: string;
  answer: string;
  state: ChatTurnState;
  stage?: string | null;
  note?: string | null;
  /** Which part of the scope the answer used ("From your question: Daily standup"). */
  scopeNote?: string | null;
  citations: ChatCitation[];
  sources: ChatSource[];
}

/** A suggested question; `label` (optional): a small topic line above it ("Sourcing"). */
export interface ChatSuggestion { q: string; icon?: string; label?: string | null }

/** A scope chip in the composer: one menu of choices ("All meetings" ▾). Its value is `scope[id]`. */
export interface ChatScopeOption {
  id: string;
  /** The chip's label for the empty value ("All meetings"). */
  label: string;
  icon?: string;
  choices: Array<{ value: string; label: string; icon?: string }>;
}

export type ChatScope = Record<string, string>;

export type ChatLayout = "page" | "panel" | "sheet";

export interface ChatProps<C = unknown> {
  transport: ChatTransport<ChatScope, C>;
  /** Survives navigation within the app (and a reload, with `loadThread`): one conversation per key. */
  persistKey: string;

  layout?: ChatLayout;
  scope?: ChatScope;
  scopeOptions?: ChatScopeOption[];
  onScopeChange?: (scope: ChatScope) => void;
  /** What the person is looking at ({page, section, selection}…), passed to the transport as is. */
  context?: C;

  /** The server-side conversation to continue; `onThreadChange` hears a new one (null: a new chat). */
  threadId?: string | null;
  onThreadChange?: (id: string | null) => void;
  /** Reads a saved conversation (a reload): its turns. */
  loadThread?: (id: string) => Promise<ChatTurn[]>;

  suggestions?: ChatSuggestion[];
  /** Follow-up questions offered under the latest answer. */
  followUps?: (turn: ChatTurn) => string[];
  /** "Insert into doc": shown on finished answers when given (the answer as Markdown, citations as links). */
  onInsert?: (markdown: string, turn: ChatTurn) => void;
  /** A citation or source was opened (e.g. close the panel on phones). */
  onNavigate?: () => void;

  empty?: { icon?: string; title: ReactNode; sub?: ReactNode };
  placeholder?: string;
  followUpPlaceholder?: string;
  /** The line under the composer ("AI can be wrong…"). */
  footnote?: ReactNode;
  /** Above the thread (e.g. "Writing the summary…"). */
  banner?: ReactNode;
  /** The citation tokens (group 1) the transport's answers use; default chatCore DEFAULT_CITE. */
  citePattern?: RegExp;
  autoFocus?: boolean;
  maxLength?: number;
  /** The assistant's name for screen readers and the avatar's title. */
  assistantName?: string;
  className?: string;
  /** For tests: data-testid on the root. */
  testId?: string;
}

/** What the parent can do with a mounted chat (ref). */
export interface ChatHandle {
  ask: (question: string) => void;
  newChat: () => void;
  focus: () => void;
  hasTurns: () => boolean;
}
