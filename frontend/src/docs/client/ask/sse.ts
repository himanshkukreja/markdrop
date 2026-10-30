/**
 * Server-Sent Events over a fetch() body. EventSource can't POST, so Ask AI reads the response
 * stream itself: lines are split on CRLF, LF or CR (a CR at the end of a chunk waits for the
 * next one in case an LF follows), `event:` and `data:` fields build an event, a blank line
 * dispatches it, and comment lines (`: ok`, `: keep-alive`) are ignored.
 */
export interface SseMessage {
  event: string;
  data: string;
}

export async function readSse(body: ReadableStream<Uint8Array>, onMessage: (m: SseMessage) => void, signal?: AbortSignal): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event = "";
  let data: string[] = [];

  const line = (l: string) => {
    if (l === "") {
      if (data.length) onMessage({ event: event || "message", data: data.join("\n") });
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

  const drain = (final: boolean) => {
    for (;;) {
      const idx = buf.search(/[\r\n]/);
      if (idx < 0) break;
      if (buf[idx] === "\r" && idx === buf.length - 1 && !final) break;
      const width = buf[idx] === "\r" && buf[idx + 1] === "\n" ? 2 : 1;
      line(buf.slice(0, idx));
      buf = buf.slice(idx + width);
    }
  };

  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      drain(false);
    }
    buf += decoder.decode();
    drain(true);
    if (buf) line(buf);
    line("");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}
