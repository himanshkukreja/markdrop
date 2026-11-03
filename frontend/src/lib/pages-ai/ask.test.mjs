// Ask this page: SSE parsing and section links. Run: node --test src/lib/pages-ai/ask.test.mjs
// (Node >= 22.18 strips the types from sse.ts and ask-core.ts; neither has imports.)
import test from "node:test";
import assert from "node:assert/strict";
import { SseParser, readAiStream, toAiEvent } from "./sse.ts";
import { bareId, createSlugger, historyFor, httpMessage, idCandidates, limitMessage, matchHeading, sectionId, sectionsUsed } from "./ask-core.ts";

const collect = (chunks) => {
  const out = [];
  const p = new SseParser((m) => out.push(m));
  for (const c of chunks) p.push(c);
  p.end();
  return out;
};

test("SSE: data-only JSON events, as the contract sends them", () => {
  const msgs = collect(['data: {"type":"delta","text":"Hel"}\n\n', 'data: {"type":"delta","text":"lo"}\n\ndata: {"type":"done"}\n\n']);
  assert.deepEqual(msgs.map(toAiEvent), [
    { type: "delta", text: "Hel" },
    { type: "delta", text: "lo" },
    { type: "done" },
  ]);
});

test("SSE: event lines (the docs editor AI's shape), comments, CRLF and chunks split anywhere", () => {
  const raw = ': ok\r\n\r\nevent: delta\r\ndata: {"text":"Ünïcode ✦"}\r\n\r\n: keep-alive\n\nevent: limit\ndata: {"reason":"burst"}\n\n';
  // Split byte-by-byte: a CR at a chunk's end waits for its LF.
  const msgs = collect([...raw]);
  assert.deepEqual(msgs.map(toAiEvent), [
    { type: "delta", text: "Ünïcode ✦" },
    { type: "limit", reason: "burst" },
  ]);
});

test("SSE: the JSON type wins over the event name; unknown and empty events are dropped", () => {
  assert.deepEqual(toAiEvent({ event: "message", data: '{"type":"error","detail":"Nope"}' }), { type: "error", detail: "Nope" });
  assert.deepEqual(toAiEvent({ event: "error", data: '{"message":"Old shape"}' }), { type: "error", detail: "Old shape" });
  assert.equal(toAiEvent({ event: "message", data: '{"type":"ping"}' }), null);
  assert.equal(toAiEvent({ event: "message", data: '{"type":"delta","text":""}' }), null);
  assert.deepEqual(toAiEvent({ event: "message", data: '{"type":"limit"}' }), { type: "limit", reason: "daily" });
  assert.deepEqual(toAiEvent({ event: "message", data: '{"type":"progress","done":2,"total":5}' }), { type: "progress", done: 2, total: 5, label: undefined });
  const done = toAiEvent({ event: "message", data: '{"type":"done","usage":{"cache_read_input_tokens":900},"trimmed":true}' });
  assert.equal(done.type, "done");
  assert.equal(done.trimmed, true);
  assert.equal(done.usage.cache_read_input_tokens, 900);
});

test("SSE: a multi-line data field joins with newlines; a last event without a blank line still dispatches", () => {
  const msgs = collect(["event: delta\ndata: line one\ndata: line two"]);
  assert.deepEqual(msgs, [{ event: "delta", data: "line one\nline two" }]);
  assert.deepEqual(toAiEvent(msgs[0]), { type: "delta", text: "line one\nline two" });
});

test("SSE: readAiStream reads a fetch body to the end", async () => {
  const enc = new TextEncoder();
  const parts = ['data: {"type":"delta","text":"Ans', 'wer"}\n\ndata: {"type":"delta","text":" [Intro](#intro)"}\n', '\ndata: {"type":"done"}\n\n'];
  const body = new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    },
  });
  const events = [];
  await readAiStream(body, (e) => events.push(e));
  assert.equal(events.map((e) => (e.type === "delta" ? e.text : "")).join(""), "Answer [Intro](#intro)");
  assert.equal(events.at(-1).type, "done");
});

test("SSE: aborting stops the read", async () => {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: {"type":"delta","text":"a"}\n\n'));
    },
  });
  const ctrl = new AbortController();
  const events = [];
  const run = readAiStream(body, (e) => {
    events.push(e);
    ctrl.abort();
  }, ctrl.signal);
  await run;
  assert.equal(events.length, 1);
});

test("section links: what counts as a link to a section", () => {
  assert.equal(sectionId("#rollout-plan"), "rollout-plan");
  assert.equal(sectionId("#user-content-rollout-plan"), "user-content-rollout-plan");
  assert.equal(sectionId("#caf%C3%A9"), "café");
  assert.equal(sectionId("#"), null);
  assert.equal(sectionId("#has space"), null);
  assert.equal(sectionId("https://example.com/#x"), null);
  assert.equal(sectionId("/other-page#x", { origin: "https://markdrop.in", pathname: "/launch" }), null);
  assert.equal(sectionId("https://markdrop.in/launch#goals", { origin: "https://markdrop.in", pathname: "/launch" }), "goals");
  assert.equal(sectionId("/launch/#goals", { origin: "https://markdrop.in", pathname: "/launch" }), "goals");
  assert.equal(sectionId(null), null);
});

test("section links: ids resolve with or without the reader's prefix", () => {
  assert.equal(bareId("user-content-goals"), "goals");
  assert.deepEqual(idCandidates("goals"), ["goals", "user-content-goals"]);
  assert.deepEqual(idCandidates("user-content-goals"), ["user-content-goals", "goals"]);
});

test("section links: editor headings match by slug, duplicates by position", () => {
  const texts = ["Goals", "Rollout plan", "Open questions", "Goals", "Café & crème"];
  assert.equal(matchHeading(texts, "rollout-plan"), 1);
  assert.equal(matchHeading(texts, "user-content-open-questions"), 2);
  assert.equal(matchHeading(texts, "goals"), 0);
  assert.equal(matchHeading(texts, "goals-1"), 3);
  assert.equal(matchHeading(texts, "café--crème"), 4);
  assert.equal(matchHeading(texts, "nowhere"), -1);
  // A suffix the page doesn't have falls back to the base heading.
  assert.equal(matchHeading(texts, "rollout-plan-2"), 1);
  // The same ids the reader's renderer makes (reading/slug.ts).
  const slug = createSlugger();
  assert.deepEqual(["A b", "A b", "A  B!"].map(slug), ["a-b", "a-b-1", "a-b-2"]);
});

test("section links: an answer's sections, in the order first cited, without repeats", () => {
  const answer = "We ship on **Nov 10** ([Timeline](#timeline)). Ben owns the backend ([Owners](#user-content-owners)); see [Timeline](#timeline) and [docs](https://markdrop.in/docs). [**Risks**](#risks)";
  assert.deepEqual(sectionsUsed(answer), [
    { id: "timeline", text: "Timeline" },
    { id: "user-content-owners", text: "Owners" },
    { id: "risks", text: "Risks" },
  ]);
  assert.deepEqual(sectionsUsed("No links here."), []);
});

test("history: the last 6 complete turns only", () => {
  const turns = Array.from({ length: 9 }, (_, i) => ({ q: `q${i}`, a: `a${i}`, state: i === 4 ? "error" : i === 7 ? "stopped" : "done" }));
  turns.push({ q: "now", a: "", state: "streaming" });
  const h = historyFor(turns);
  assert.equal(h.length, 6);
  assert.deepEqual(h.map((t) => t.q), ["q1", "q2", "q3", "q5", "q6", "q8"]);
  assert.deepEqual(Object.keys(h[0]), ["q", "a"]);
  assert.equal(historyFor([{ q: "x", a: "y".repeat(9000), state: "done" }])[0].a.length, 4000);
});

test("messages: each limit reason and HTTP status reads as a sentence", () => {
  assert.equal(limitMessage("daily"), "AI limit reached for today. Try again tomorrow.");
  for (const r of ["monthly", "burst", "blocked", "user_daily", "workspace_off", "off", "not_configured", "something-new", null]) {
    assert.match(limitMessage(r), /^[A-Z].+\.$/);
  }
  assert.equal(limitMessage("workspace_off"), "AI is off for this workspace.");
  assert.equal(httpMessage(429), limitMessage("burst"));
  for (const s of [0, 401, 403, 404, 500]) assert.match(httpMessage(s), /^[A-Z].+\.$/);
});
