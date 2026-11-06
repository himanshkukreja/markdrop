/**
 * The assistant's transport for the shared chat: POST /api/v1/ask with the scope (and, in a doc, where
 * the reader is), read as Ask Markdrop's events, handed to the chat as ChatEvents.
 */
import type { ChatEvent, ChatScope, ChatTransport, ChatTurn } from "@/components/chat/types";
import { askMarkdrop, getAskThread, type AskEvent, type AssistantContext, type AssistantScopeKind } from "@/lib/ask";
import { hrefOf } from "@/lib/search";
import { scopeBody, stageLabel, threadTurns, toCitation, toSource } from "./assistantCore.mjs";
import { getAssistant } from "./store";

type Linkable = { url?: string | null; slug?: string | null; kind?: string | null };
export const link = (x: Linkable) => {
  const kind = x.kind === "meeting" ? "page" : x.kind;
  return hrefOf({ url: x.url ?? "/", slug: x.slug ?? undefined, kind: (kind ?? "doc") as never });
};

export interface AssistantChatContext {
  ctx: AssistantContext | null;
}

export const assistantTransport: ChatTransport<ChatScope, AssistantChatContext> = async (req, emit) => {
  const kind = (req.scope.kind || "everything") as AssistantScopeKind;
  const ctx = req.context?.ctx ?? null;
  const scope = scopeBody(kind, ctx, req.scope);
  const reader = kind === "doc" ? safe(() => getAssistant().reader?.() ?? null) : null;
  await askMarkdrop(
    { question: req.question, thread_id: req.threadId, scope, context: reader },
    (e: AskEvent) => {
      const out = toChat(e, kind);
      if (out) emit(out);
    },
    req.signal,
  );
};

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

export function toChat(e: AskEvent, kind: AssistantScopeKind): ChatEvent | null {
  switch (e.type) {
    case "status": return { type: "stage", label: stageLabel(e.stage, kind) };
    case "results": return { type: "sources", items: (e.items || []).slice(0, 8).map((it) => toSource(it as never, link)), note: e.note ?? null };
    case "delta": return { type: "delta", text: e.text };
    case "done": return {
      type: "done",
      answer: e.answer,
      citations: (e.citations || []).map((c) => toCitation(c, link)),
      // No ranking in done (an answer from the account alone, a fixed reply): keep the streamed sources.
      sources: e.ranked && e.ranked.length ? e.ranked.slice(0, 8).map((it) => toSource(it as never, link)) : undefined,
      note: e.scope?.label ?? null,
      threadId: e.thread_id ?? undefined,
    };
    case "limit": return { type: "limit", message: e.message };
    case "error": return { type: "error", message: e.detail, retryable: e.code !== "not_found" };
    default: return null;
  }
}

export async function loadAssistantThread(id: string): Promise<ChatTurn[]> {
  const t = await getAskThread(id);
  return threadTurns(t.turns, link);
}
