"use client";

/**
 * Ask AI state for one browser tab: the panel's conversation, the ⌘K palette's one-off answer,
 * the page the reader is on, the composer's context tag and draft, and whether Ask AI is
 * available. A tiny external store (useSyncExternalStore), so the header button, the page's
 * actions, the palette and the panel share it without a provider. The panel's conversation and
 * open state are kept in sessionStorage, so they survive a reload but not a new tab.
 *
 * Streaming: each question gets its own AbortController (keyed by turn id, so a palette answer
 * moved to the panel keeps streaming). Events update the state at once; listeners are notified
 * at most once per animation frame.
 */
import { useSyncExternalStore } from "react";
import { AskHttpError, fetchStatus, sendAnswerFeedback, streamAsk, type AskApi, type AskStatus, type Availability, type HistoryMessage, type OpenIn, type Source } from "./api";
import type { SseMessage } from "./sse";
import type { AiSettings } from "../../brand";
import { aboutText } from "../site";

/* ── the site's settings (configureAsk, from AskRoot) ────────────────────── */

let api: AskApi | null = null;
let assistant = "Ask AI";
let product: string | undefined;

/** What the assistant is called (site.json `ai.assistantName`), for messages. */
export function assistantName(): string {
  return assistant;
}

/** "about Markdrop" (the site's product), or "about these docs". */
export function aboutProduct(): string {
  return aboutText(product);
}

export interface AskContext {
  path: string;
  title: string;
  mdUrl: string;
  section?: { id: string; label: string };
}

export type TurnState = "pending" | "streaming" | "done" | "error" | "limit" | "stopped";

export interface Turn {
  id: string;
  question: string;
  answer: string;
  state: TurnState;
  status?: AskStatus | null;
  sources: Source[];
  requestId?: string;
  outcome?: string;
  message?: string;
  openIn?: OpenIn[];
  feedback?: "up" | "down";
  ctx?: AskContext | null;
}

export interface Thread {
  conversationId?: string;
  turns: Turn[];
}

export type ThreadKey = "panel" | "palette";

export interface AskState {
  open: boolean;
  full: boolean;
  panel: Thread;
  palette: Thread;
  /** The docs page on screen (registered by DocPageProvider), or null on the home/changelog. */
  page: AskContext | null;
  /** The composer's context tag (sent as page_path). Follows the page until removed. */
  context: AskContext | null;
  draft: string;
  /** Bumped when something asks the composer to take focus (and put the caret at the end). */
  focusNonce: number;
  availability: "unknown" | "available" | "unavailable";
  unavailableReason?: string;
  siteUrl: string;
}

const STORE_KEY = "docs_ask_v1";
const MAX_HISTORY_TURNS = 10;

const initial: AskState = {
  open: false,
  full: false,
  panel: { turns: [] },
  palette: { turns: [] },
  page: null,
  context: null,
  draft: "",
  focusNonce: 0,
  availability: "unknown",
  siteUrl: "",
};

let state: AskState = initial;
let loaded = false;
const listeners = new Set<() => void>();
const controllers = new Map<string, AbortController>();

/* ── persistence ─────────────────────────────────────────────────────────── */

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  // A reload or navigation away inside the save delay still keeps the latest state.
  window.addEventListener("pagehide", () => saveTimer && saveNow());
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return;
    const v = JSON.parse(raw) as { open?: boolean; full?: boolean; panel?: Thread };
    const turns = Array.isArray(v.panel?.turns) ? v.panel!.turns.filter((t) => t && typeof t.question === "string" && typeof t.answer === "string") : [];
    state = {
      ...state,
      open: !!v.open,
      full: !!v.full,
      panel: {
        conversationId: typeof v.panel?.conversationId === "string" ? v.panel.conversationId : undefined,
        // An answer that was still streaming when the tab reloaded is gone: show it as stopped.
        turns: turns.map((t) => (t.state === "pending" || t.state === "streaming" ? { ...t, state: "stopped" as const, status: null } : { ...t, sources: Array.isArray(t.sources) ? t.sources : [] })),
      },
    };
  } catch {
    /* private mode or bad JSON: start fresh */
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveNow() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  try {
    const { open, full, panel } = state;
    sessionStorage.setItem(STORE_KEY, JSON.stringify({ open, full, panel: { conversationId: panel.conversationId, turns: panel.turns.slice(-20) } }));
  } catch {
    /* quota or private mode */
  }
}
function scheduleSave() {
  if (typeof window === "undefined" || saveTimer) return;
  saveTimer = setTimeout(saveNow, 400);
}

/* ── store plumbing ──────────────────────────────────────────────────────── */

let frame: number | null = null;
function notify() {
  if (frame !== null) return;
  const run = () => {
    frame = null;
    listeners.forEach((l) => l());
  };
  frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : (setTimeout(run, 16) as unknown as number);
}

function set(patch: Partial<AskState> | ((s: AskState) => Partial<AskState>), sync = false) {
  load();
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  scheduleSave();
  if (sync) {
    if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    frame = null;
    listeners.forEach((l) => l());
  } else notify();
}

function subscribe(cb: () => void) {
  load();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function snapshot(): AskState {
  load();
  return state;
}

export function useAsk(): AskState {
  return useSyncExternalStore(subscribe, snapshot, () => initial);
}

export function getAskState(): AskState {
  return snapshot();
}

/* ── turns ───────────────────────────────────────────────────────────────── */

function locate(turnId: string): ThreadKey | null {
  if (state.panel.turns.some((t) => t.id === turnId)) return "panel";
  if (state.palette.turns.some((t) => t.id === turnId)) return "palette";
  return null;
}

function patchTurn(turnId: string, patch: Partial<Turn> | ((t: Turn) => Partial<Turn>), threadPatch?: (th: Thread) => Partial<Thread>) {
  const key = locate(turnId);
  if (!key) return;
  set((s) => {
    const th = s[key];
    const turns = th.turns.map((t) => (t.id === turnId ? { ...t, ...(typeof patch === "function" ? patch(t) : patch) } : t));
    return { [key]: { ...th, ...(threadPatch ? threadPatch(th) : {}), turns } } as Partial<AskState>;
  });
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function history(turns: Turn[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const t of turns.filter((x) => x.state === "done" && x.answer.trim()).slice(-MAX_HISTORY_TURNS)) {
    out.push({ role: "user", content: t.question }, { role: "assistant", content: t.answer });
  }
  return out;
}

function parse(data: string): Record<string, unknown> {
  try {
    const v = JSON.parse(data);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function openInList(v: unknown): OpenIn[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const list = v.filter((x): x is OpenIn => !!x && typeof x.label === "string" && typeof x.href === "string" && /^https:\/\//.test(x.href));
  return list.length ? list : undefined;
}

function sourceList(v: unknown): Source[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is Source => !!x && typeof x.n === "number" && typeof x.id === "string" && typeof x.url === "string" && typeof x.title === "string");
}

function onEvent(turnId: string, m: SseMessage) {
  const d = parse(m.data);
  switch (m.event) {
    case "status":
      if (typeof d.label === "string") patchTurn(turnId, { state: "streaming", status: { phase: String(d.phase ?? ""), label: d.label } });
      break;
    case "delta": {
      const text = typeof d.text === "string" ? d.text : "";
      patchTurn(turnId, (t) => ({ state: "streaming", answer: d.reset ? text : t.answer + text }));
      break;
    }
    case "citations":
      patchTurn(turnId, { sources: sourceList(d.sources) });
      break;
    case "done":
      patchTurn(
        turnId,
        { state: "done", status: null, requestId: typeof d.request_id === "string" ? d.request_id : undefined, outcome: typeof d.outcome === "string" ? d.outcome : undefined, openIn: openInList(d.open_in) },
        (th) => ({ conversationId: th.conversationId ?? (typeof d.conversation_id === "string" ? d.conversation_id : undefined) }),
      );
      break;
    case "limit": {
      const reason = typeof d.reason === "string" ? d.reason : "";
      patchTurn(turnId, { state: "limit", status: null, message: typeof d.message === "string" ? d.message : `${assistant} can't answer right now.`, openIn: openInList(d.open_in) });
      if (reason === "disabled" || reason === "not_configured") set({ availability: "unavailable", unavailableReason: reason });
      break;
    }
    case "error":
      patchTurn(turnId, {
        state: "error",
        status: null,
        message: typeof d.message === "string" ? d.message : `${assistant} hit a problem answering that. Try again.`,
        requestId: typeof d.request_id === "string" ? d.request_id : undefined,
        openIn: openInList(d.open_in),
      });
      break;
  }
}

function httpMessage(status: number): string {
  if (status === 429) return `You're asking faster than ${assistant} can answer. Wait a minute and try again.`;
  if (status === 413 || status === 422) return "That question couldn't be sent. Shorten it and try again.";
  return unreachable();
}

function unreachable(): string {
  return `${assistant} couldn't be reached. Check your connection and try again.`;
}

/** Stops one streaming answer, keeping what arrived. */
export function stopTurn(turnId: string) {
  const c = controllers.get(turnId);
  if (!c) return;
  controllers.delete(turnId);
  c.abort();
  patchTurn(turnId, (t) => (t.state === "pending" || t.state === "streaming" ? { state: "stopped", status: null } : {}));
}

function stopThread(key: ThreadKey) {
  for (const t of state[key].turns) if (controllers.has(t.id)) stopTurn(t.id);
}

export function isStreaming(t: Turn): boolean {
  return t.state === "pending" || t.state === "streaming";
}

/** Asks `question` in a thread (the panel's conversation, or the palette's single answer). */
export function askIn(key: ThreadKey, question: string, ctx: AskContext | null) {
  const q = question.trim();
  if (!q) return;
  stopThread(key);
  const th = state[key];
  const turn: Turn = { id: uid(), question: q, answer: "", state: "pending", status: { phase: "searching", label: "Looking through the docs" }, sources: [], ctx };
  const body = { question: q, history: key === "panel" ? history(th.turns) : [], page_path: ctx?.path ?? null, conversation_id: key === "panel" ? th.conversationId ?? null : null };
  set({ [key]: { ...th, turns: [...th.turns, turn] } } as Partial<AskState>, true);
  const ac = new AbortController();
  controllers.set(turn.id, ac);
  const call = api
    ? streamAsk(api, body, ac.signal, (m) => {
        if (!ac.signal.aborted) onEvent(turn.id, m);
      })
    : Promise.reject(new Error("Ask AI is off for this site"));
  call
    .then(() => {
      if (ac.signal.aborted) return;
      patchTurn(turn.id, (t) => (isStreaming(t) ? { state: t.answer ? "stopped" : "error", status: null, message: t.answer ? undefined : "The answer stopped before it finished. Try again." } : {}));
    })
    .catch((err: unknown) => {
      if (ac.signal.aborted) return;
      const message = err instanceof AskHttpError ? httpMessage(err.status) : unreachable();
      patchTurn(turn.id, (t) => (isStreaming(t) ? { state: "error", status: null, message } : {}));
    })
    .finally(() => {
      if (controllers.get(turn.id) === ac) controllers.delete(turn.id);
    });
}

/* ── availability ────────────────────────────────────────────────────────── */

let statusAsked: Promise<Availability> | null = null;
/**
 * Checks /docs/ai/status once; resolves false only when the server says Ask AI is off, or the
 * site has no Ask AI at all (then nothing is asked).
 */
export function ensureStatus(): Promise<boolean> {
  if (!api) return Promise.resolve(false);
  const cfg = api;
  statusAsked ??= fetchStatus(cfg).then((a) => {
    if (a.available === false) set({ availability: "unavailable", unavailableReason: a.reason });
    else if (a.available === true) set({ availability: "available" });
    else statusAsked = null;
    return a;
  });
  return statusAsked.then((a) => a.available !== false);
}

/* ── panel actions ───────────────────────────────────────────────────────── */

export interface OpenAskOptions {
  /** Asked right away (after the availability check). */
  question?: string;
  /** Replaces the composer's context tag (null removes it). */
  context?: AskContext | null;
  /** Prefills the composer. */
  draft?: string;
}

/** Whatever had focus before the panel opened; focus goes back there when it closes. */
let opener: HTMLElement | null = null;

export function openAsk(opts: OpenAskOptions = {}) {
  if (!state.open && typeof document !== "undefined") {
    const a = document.activeElement;
    opener = a instanceof HTMLElement && a !== document.body ? a : null;
  }
  set((s) => ({
    open: true,
    ...(opts.context !== undefined ? { context: opts.context } : {}),
    ...(opts.draft !== undefined ? { draft: opts.draft } : {}),
    focusNonce: s.focusNonce + 1,
  }), true);
  const q = opts.question?.trim();
  void ensureStatus().then((ok) => {
    if (!q) return;
    if (ok) askIn("panel", q, opts.context !== undefined ? opts.context : state.context);
    else set({ draft: q });
  });
}

/** Opens the panel about the page on screen (the rail card, "Ask about this page"). */
export function askAboutPage() {
  openAsk({ context: state.page });
}

/** "Ask about this" on a heading: context = that section, composer prefilled. */
export function askAboutSection(id: string, label: string) {
  const page = state.page;
  openAsk({ context: page ? { ...page, section: { id, label } } : null, draft: `About “${label}”: ` });
}

export function closeAsk({ restoreFocus = true }: { restoreFocus?: boolean } = {}) {
  stopThread("panel");
  set({ open: false }, true);
  const back = opener;
  opener = null;
  if (restoreFocus && back) setTimeout(() => back.isConnected && back.focus({ preventScroll: true }), 0);
}

export function toggleAsk() {
  if (getAskState().open) closeAsk();
  else openAsk();
}

export function setFull(full: boolean) {
  set({ full });
}

export function newConversation() {
  stopThread("panel");
  set((s) => ({ panel: { turns: [] }, draft: "", context: s.page, focusNonce: s.focusNonce + 1 }), true);
}

export function setDraft(draft: string) {
  set({ draft }, true);
}

export function setContext(context: AskContext | null) {
  set({ context });
}

export function setFeedback(turnId: string, feedback: "up" | "down") {
  patchTurn(turnId, { feedback });
}

/** The site's Ask AI settings (AskRoot, from the docs layout). Until then nothing is asked. */
export function configureAsk(siteUrl: string, ai: AiSettings, productName?: string) {
  api = { api: ai.api, site: ai.site, appSession: ai.appSession };
  assistant = ai.name;
  product = productName;
  if (state.siteUrl !== siteUrl) set({ siteUrl });
}

/** Answer feedback for a turn, to the site's Ask AI backend. */
export function sendFeedback(requestId: string, helpful: boolean, comment?: string) {
  if (api) sendAnswerFeedback(api, requestId, helpful, comment);
}

/** Called by DocPageProvider: the page on screen. A new page resets the context tag to it. */
export function setAskPage(page: AskContext | null) {
  if (state.page?.path === page?.path) return;
  set({ page, context: page });
}

/* ── palette ─────────────────────────────────────────────────────────────── */

export function askInPalette(question: string) {
  set({ palette: { turns: [] } });
  askIn("palette", question, state.page);
}

export function clearPalette() {
  stopThread("palette");
  set({ palette: { turns: [] } });
}

/** Moves the palette's answer (streaming or not) into the panel's conversation and opens it. */
export function continueInPanel() {
  set((s) => ({
    panel: { conversationId: s.panel.conversationId ?? s.palette.conversationId, turns: [...s.panel.turns, ...s.palette.turns] },
    palette: { turns: [] },
    open: true,
    focusNonce: s.focusNonce + 1,
  }), true);
}

/* ── helpers for the views ───────────────────────────────────────────────── */

/** The Markdown address an outside assistant should read for a turn: its page, or llms.txt. */
export function contextUrl(ctx: AskContext | null | undefined, siteUrl: string): string {
  return ctx?.mdUrl || `${siteUrl.replace(/\/+$/, "")}/llms.txt`;
}

export function claudeHref(question: string, ctx: AskContext | null | undefined, siteUrl: string): string {
  const prompt = `Read ${contextUrl(ctx, siteUrl)} and answer my question ${aboutProduct()}: ${question}`.slice(0, 1500);
  return `https://claude.ai/new?q=${encodeURIComponent(prompt)}`;
}
