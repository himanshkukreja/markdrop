export interface SseMessage {
  event: string;
  data: string;
}

export type AiEvent =
  | { type: "delta"; text: string; reset: boolean }
  | { type: "done"; usage: Record<string, unknown> | null; trimmed: boolean }
  | { type: "limit"; reason: string }
  | { type: "error"; detail: string };

export function createSseParser(onEvent: (m: SseMessage) => void): { push(text: string): void; end(): void };
export function toAiEvent(msg: SseMessage): AiEvent | null;
export const LIMIT_MESSAGES: Record<string, string>;
export function limitMessage(reason: string): string;
export function cleanAiMarkdown(md: string, partial?: boolean): string;
export function collectAiEvents(chunks: string[]): { text: string; done: boolean; limit: string | null; error: string | null; usage: Record<string, unknown> | null };
