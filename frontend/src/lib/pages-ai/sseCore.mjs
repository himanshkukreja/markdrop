/**
 * Page AI's stream, the pure part (no DOM, no fetch), so Node's test runner loads it as is
 * (src/components/docs-editor/test/ai.test.mjs). client.ts reads the response body and feeds it here.
 *
 * Server-Sent Events: lines end in CRLF, LF or CR (a CR at the end of a chunk waits for the next
 * chunk, in case an LF follows); `event:` and `data:` build an event; a blank line sends it; lines
 * starting with ":" are comments (`: ok`, `: keep-alive`). Each event's data is JSON:
 *
 *   {type:"delta", text}   more of the answer
 *   {type:"done", usage?}  finished
 *   {type:"limit", reason} daily | monthly | global_daily | global_monthly | burst | off | workspace_off |
 *                          not_configured | blocked | user_daily
 *   {type:"error", detail} something went wrong (a sentence to show)
 *
 * The type is the data's `type`, else the SSE event name (the docs Ask AI stream names its events
 * that way: `event: delta`), so either server style reads the same.
 */

/** A parser fed text chunks; `onEvent({event, data})` per complete event. */
export function createSseParser(onEvent) {
  let buf = "";
  let event = "";
  let data = [];
  const line = (l) => {
    if (l === "") {
      if (data.length) onEvent({ event: event || "message", data: data.join("\n") });
      event = "";
      data = [];
      return;
    }
    if (l.startsWith(":")) return;
    const i = l.indexOf(":");
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? "" : l.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  };
  const drain = (final) => {
    for (;;) {
      const idx = buf.search(/[\r\n]/);
      if (idx < 0) break;
      if (buf[idx] === "\r" && idx === buf.length - 1 && !final) break;
      const width = buf[idx] === "\r" && buf[idx + 1] === "\n" ? 2 : 1;
      line(buf.slice(0, idx));
      buf = buf.slice(idx + width);
    }
  };
  return {
    push(text) {
      buf += text;
      drain(false);
    },
    end() {
      drain(true);
      if (buf) line(buf);
      buf = "";
      line("");
    },
  };
}

/** One SSE message as a Page AI event (null: not one of ours). */
export function toAiEvent(msg) {
  let body = null;
  try {
    body = JSON.parse(msg.data);
  } catch {
    body = null;
  }
  const obj = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const type = typeof obj.type === "string" ? obj.type : msg.event;
  if (type === "delta") {
    const text = typeof obj.text === "string" ? obj.text : typeof body === "string" ? body : "";
    return { type: "delta", text, reset: obj.reset === true };
  }
  if (type === "done") return { type: "done", usage: obj.usage ?? null, trimmed: obj.trimmed === true };
  if (type === "limit") return { type: "limit", reason: typeof obj.reason === "string" ? obj.reason : "daily" };
  if (type === "error") {
    const detail = typeof obj.detail === "string" ? obj.detail : typeof obj.message === "string" ? obj.message : "";
    return { type: "error", detail };
  }
  return null;
}

/** What to say for each limit reason (the spec's words; unknown reasons get the daily one). */
export const LIMIT_MESSAGES = {
  daily: "AI limit reached for today. Try again tomorrow.",
  monthly: "AI limit reached for this month. It resets on the 1st.",
  global_daily: "AI limit reached for today. Try again tomorrow.",
  global_monthly: "AI limit reached for this month. It resets on the 1st.",
  burst: "You're going a bit fast. Try again in a minute.",
  blocked: "AI isn't available on your account. Contact support if this looks wrong.",
  user_daily: "You've used your AI for today. Try again tomorrow.",
  workspace_off: "AI is off for this workspace.",
  off: "AI isn't available right now.",
  not_configured: "AI isn't available right now.",
};

export function limitMessage(reason) {
  return LIMIT_MESSAGES[reason] ?? LIMIT_MESSAGES.daily;
}

/**
 * The model's answer as page Markdown: a fence around the whole answer (```markdown … ```) is
 * dropped, and so are blank lines at either end. While streaming (`partial`), an unfinished
 * opening fence line is dropped too, so the preview doesn't flash a code block.
 */
export function cleanAiMarkdown(md, partial = false) {
  let s = String(md ?? "").replace(/\r\n?/g, "\n");
  const open = /^\s*(`{3,}|~{3,})[ \t]*(?:markdown|md)?[ \t]*\n/i.exec(s);
  if (open) {
    const fence = open[1];
    const rest = s.slice(open[0].length);
    const close = new RegExp(`\\n${fence[0]}{${fence.length},}[ \\t]*\\n?\\s*$`);
    if (close.test(rest)) s = rest.replace(close, "");
    else if (partial) s = rest;
  } else if (partial && /^\s*(`{1,}|~{3,})[^\n]*$/.test(s) && !/^\s*`[^`\n]+`/.test(s)) {
    s = "";
  }
  return s.replace(/^\s*\n/, "").replace(/\s+$/, "");
}

/**
 * Reads a whole SSE body (an array of chunks) into the answer: for tests and for non-streaming
 * callers. Returns {text, done, limit, error, usage}.
 */
export function collectAiEvents(chunks) {
  const out = { text: "", done: false, limit: null, error: null, usage: null };
  const p = createSseParser((m) => {
    const e = toAiEvent(m);
    if (!e) return;
    if (e.type === "delta") out.text = e.reset ? e.text : out.text + e.text;
    else if (e.type === "done") {
      out.done = true;
      out.usage = e.usage;
    } else if (e.type === "limit") out.limit = e.reason;
    else if (e.type === "error") out.error = e.detail;
  });
  for (const c of chunks) p.push(c);
  p.end();
  return out;
}
