/**
 * Page AI's streams (SPEC.md "API contract"): Server-Sent Events over a fetch() body, since
 * EventSource can't POST or send a bearer token.
 *
 * Two layers, both without imports so `node --test` can load this file directly (Node ≥ 22.18
 * strips the types):
 *  - `SseParser`: bytes in, `{event, data}` messages out. Lines split on CRLF, LF or CR (a CR at
 *    the end of a chunk waits in case an LF follows), `event:` and `data:` build a message, a
 *    blank line dispatches it, comment lines (`: ok`, `: keep-alive`) are ignored.
 *  - `toAiEvent`: one message → one typed event. The backend sends the type in the JSON
 *    (`data: {"type":"delta","text":"…"}`) and may name it on an `event:` line too (the docs
 *    editor AI does); either works, the JSON wins.
 */

export interface SseMessage {
  event: string;
  data: string;
}

export type AiLimitReason =
  | "daily"
  | "monthly"
  | "burst"
  | "off"
  | "workspace_off"
  | "not_configured"
  | "blocked"
  | "user_daily"
  | (string & {});

export interface AiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  [k: string]: unknown;
}

export type AiEvent =
  | { type: "delta"; text: string }
  | { type: "done"; usage?: AiUsage; trimmed?: boolean; slug?: string; url?: string; title?: string; [k: string]: unknown }
  | { type: "limit"; reason: AiLimitReason; detail?: string }
  | { type: "error"; detail: string }
  | { type: "progress"; done?: number; total?: number; label?: string };

/** An incremental SSE parser: feed it text, it calls `onMessage` for each complete message. */
export class SseParser {
  private buf = "";
  private event = "";
  private data: string[] = [];
  private readonly onMessage: (m: SseMessage) => void;
  // (No parameter properties: Node's type stripping, which the unit test uses, doesn't allow them.)
  constructor(onMessage: (m: SseMessage) => void) {
    this.onMessage = onMessage;
  }

  private line(l: string) {
    if (l === "") {
      if (this.data.length) this.onMessage({ event: this.event || "message", data: this.data.join("\n") });
      this.event = "";
      this.data = [];
      return;
    }
    if (l.startsWith(":")) return;
    const i = l.indexOf(":");
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? "" : l.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
  }

  private drain(final: boolean) {
    for (;;) {
      const idx = this.buf.search(/[\r\n]/);
      if (idx < 0) break;
      if (this.buf[idx] === "\r" && idx === this.buf.length - 1 && !final) break;
      const width = this.buf[idx] === "\r" && this.buf[idx + 1] === "\n" ? 2 : 1;
      this.line(this.buf.slice(0, idx));
      this.buf = this.buf.slice(idx + width);
    }
  }

  push(text: string) {
    this.buf += text;
    this.drain(false);
  }

  /** The stream ended: whatever is left is a last line, then a dispatch. */
  end() {
    this.drain(true);
    if (this.buf) this.line(this.buf);
    this.buf = "";
    this.line("");
  }
}

/** One SSE message → a typed event, or null for anything it doesn't know (ignored). */
export function toAiEvent(m: SseMessage): AiEvent | null {
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(m.data);
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  const type = typeof body?.type === "string" ? body.type : m.event;
  if (type === "delta") {
    const text = typeof body?.text === "string" ? body.text : body ? "" : m.data;
    return text ? { type: "delta", text } : null;
  }
  if (type === "done") return { ...(body ?? {}), type: "done" } as AiEvent;
  if (type === "limit") {
    const reason = typeof body?.reason === "string" ? body.reason : "daily";
    return { type: "limit", reason, ...(typeof body?.detail === "string" ? { detail: body.detail } : {}) };
  }
  if (type === "error") {
    const detail = typeof body?.detail === "string" ? body.detail : typeof body?.message === "string" ? body.message : "";
    return { type: "error", detail };
  }
  if (type === "progress") {
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    return { type: "progress", done: num(body?.done), total: num(body?.total), label: typeof body?.label === "string" ? body.label : undefined };
  }
  return null;
}

/** Reads a response body as AI events until it ends or `signal` aborts. */
export async function readAiStream(body: ReadableStream<Uint8Array>, onEvent: (e: AiEvent) => void, signal?: AbortSignal): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser((m) => {
    const e = toAiEvent(m);
    if (e) onEvent(e);
  });
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}
