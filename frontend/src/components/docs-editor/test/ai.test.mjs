/**
 * Page AI in the editor: the stream (lib/pages-ai/sseCore.mjs: SSE parsing, events, limits, the
 * answer's cleanup) and the accept path (menus/aiAccept.ts: an answer's Markdown through the
 * editor's parser into the right nodes, in the right place, in one transaction).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { createSseParser, toAiEvent, collectAiEvents, cleanAiMarkdown, limitMessage, LIMIT_MESSAGES } from "../../../lib/pages-ai/sseCore.mjs";
import { acceptTr, aiBlocks, afterBlock, wholeLines } from "../menus/aiAccept.ts";
import { parseMarkdown, serializeMarkdown } from "../core/markdown.mjs";
import { schema } from "./helpers.mjs";

/* ── the stream ─────────────────────────────────────────────────────────── */

const sse = (obj, event) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(obj)}\n\n`;

test("SSE: events split anywhere across chunks, CRLF / LF / CR, comments ignored", () => {
  const wire = `: ok\r\n\r\n${sse({ type: "delta", text: "Hel" }).replace(/\n/g, "\r\n")}${sse({ type: "delta", text: "lo\nworld" }).replace(/\n/g, "\r")}: keep-alive\n\n${sse({ type: "done", usage: { output_tokens: 3 } })}`;
  for (const size of [1, 2, 3, 7, 64, wire.length]) {
    const got = [];
    const p = createSseParser((m) => got.push(toAiEvent(m)));
    for (let i = 0; i < wire.length; i += size) p.push(wire.slice(i, i + size));
    p.end();
    assert.deepEqual(got.map((e) => e.type), ["delta", "delta", "done"], `chunk size ${size}`);
    assert.equal(got.map((e) => (e.type === "delta" ? e.text : "")).join(""), "Hello\nworld");
    assert.deepEqual(got[2].usage, { output_tokens: 3 });
  }
});

test("SSE: a multi-line data field and the event name as the type (docs Ask AI style)", () => {
  const got = [];
  const p = createSseParser((m) => got.push(m));
  p.push('event: delta\ndata: {"text":\ndata: "a"}\n\n');
  p.push("event: limit\ndata: {\"reason\":\"burst\"}\n\n");
  p.end();
  assert.equal(got[0].data, '{"text":\n"a"}');
  assert.deepEqual(toAiEvent(got[0]), { type: "delta", text: "a", reset: false });
  assert.deepEqual(toAiEvent(got[1]), { type: "limit", reason: "burst" });
});

test("SSE: a last event without its blank line still counts; unknown events are skipped", () => {
  const r = collectAiEvents([sse({ type: "delta", text: "x" }), sse({ type: "ping" }), 'data: {"type":"delta","text":"y"}']);
  assert.equal(r.text, "xy");
  assert.equal(r.done, false);
});

test("SSE: limit and error events", () => {
  const lim = collectAiEvents([sse({ type: "delta", text: "partial" }), sse({ type: "limit", reason: "daily" })]);
  assert.equal(lim.limit, "daily");
  const err = collectAiEvents([sse({ type: "error", detail: "The model is busy." })]);
  assert.equal(err.error, "The model is busy.");
  // An error's sentence may come as `message` (older shape).
  assert.deepEqual(toAiEvent({ event: "message", data: JSON.stringify({ type: "error", message: "Nope." }) }), { type: "error", detail: "Nope." });
  // A delta can replace what came so far (reset).
  assert.equal(collectAiEvents([sse({ type: "delta", text: "draft" }), sse({ type: "delta", text: "final", reset: true })]).text, "final");
});

test("limit messages: the spec's words per reason", () => {
  assert.equal(limitMessage("daily"), "AI limit reached for today. Try again tomorrow.");
  assert.equal(limitMessage("burst"), "You're going a bit fast. Try again in a minute.");
  for (const r of ["monthly", "global_daily", "global_monthly", "blocked", "user_daily", "workspace_off", "off", "not_configured"]) assert.ok(LIMIT_MESSAGES[r], r);
  assert.equal(limitMessage("something-new"), LIMIT_MESSAGES.daily);
});

test("the answer's cleanup: a fence around everything goes; a half-open one while streaming too", () => {
  assert.equal(cleanAiMarkdown("```markdown\n## Hi\n\nText\n```\n"), "## Hi\n\nText");
  assert.equal(cleanAiMarkdown("\n\n- [ ] One\n\n"), "- [ ] One");
  assert.equal(cleanAiMarkdown("```md\n## Hi\nmore", true), "## Hi\nmore");
  assert.equal(cleanAiMarkdown("``", true), "");
  // A code block inside the answer stays.
  assert.equal(cleanAiMarkdown("Run:\n\n```bash\nnpm i\n```"), "Run:\n\n```bash\nnpm i\n```");
});

/* ── the accept path ─────────────────────────────────────────────────────── */

const stateOf = (md) => EditorState.create({ schema, doc: schema.nodeFromJSON(parseMarkdown(md).doc) });
const mdOf = (doc) => serializeMarkdown({ ...parseMarkdown(""), doc: doc.toJSON(), front: "", empty: false });
const types = (doc) => doc.content.content.map((n) => n.type.name);
/** The position of the first text `s` in the document (its start). */
function find(doc, s) {
  let at = -1;
  doc.descendants((n, pos) => {
    if (at >= 0) return false;
    if (n.isText && n.text.includes(s)) at = pos + n.text.indexOf(s);
    return true;
  });
  assert.ok(at >= 0, `"${s}" is in the document`);
  return at;
}

test("to-dos with person and date chips come in as checkboxes and chips", () => {
  const md = "- [ ] Send the deck to legal :person[Ada Owner]{id=u1} :date[2026-11-10]\n- [ ] Book the venue :person[Ben Member]{id=u2}\n";
  const blocks = aiBlocks(md, schema);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "bulletList");
  const items = blocks[0].content;
  assert.equal(items.length, 2);
  assert.equal(items[0].attrs.checked, false);
  const inline = items[0].content[0].content;
  const person = inline.find((n) => n.type === "mention" && n.attrs.name === "person");
  const date = inline.find((n) => n.type === "mention" && n.attrs.name === "date");
  assert.deepEqual([person.attrs.label, person.attrs.attributes.id], ["Ada Owner", "u1"]);
  assert.equal(date.attrs.label, "2026-11-10");

  // Into the empty line "/ai" was typed on (a block target): the line becomes the list.
  const state = stateOf("# Plan\n\nIntro.\n\n\n\nAfter.\n");
  let empty = null;
  state.doc.forEach((n, pos) => {
    if (n.type.name === "paragraph" && !n.content.size && empty === null) empty = pos;
  });
  // (An empty paragraph between blocks, as the editor has one.)
  const withEmpty = empty === null ? state.apply(state.tr.insert(find(state.doc, "After.") - 1, schema.nodes.paragraph.create())) : state;
  let at = null;
  withEmpty.doc.forEach((n, pos) => {
    if (n.type.name === "paragraph" && !n.content.size && at === null) at = pos;
  });
  const tr = acceptTr(withEmpty, { mode: "block", from: at, to: at + 2 }, md);
  assert.ok(tr);
  assert.deepEqual(types(tr.doc), ["heading", "paragraph", "bulletList", "paragraph"]);
  const out = mdOf(tr.doc);
  assert.match(out, /- \[ \] Send the deck to legal :person\[Ada Owner\]\{id="?u1"?\} :date\[2026-11-10\]/);
});

test("a :::note Summary callout goes in at the top of the page", () => {
  const md = ":::note[Summary]\nWe ship on **November 10** in three waves.\n:::\n";
  const state = stateOf("# Launch\n\nBody text.\n");
  const tr = acceptTr(state, { mode: "insert", at: 0 }, md);
  const first = tr.doc.firstChild;
  assert.equal(first.type.name, "callout");
  assert.equal(first.attrs.kind, "note");
  assert.equal(first.attrs.label, "Summary");
  assert.equal(first.textContent, "We ship on November 10 in three waves.");
  assert.deepEqual(types(tr.doc), ["callout", "heading", "paragraph"]);
  assert.match(mdOf(tr.doc), /^:::note\[Summary\]\nWe ship on \*\*November 10\*\* in three waves\.\n:::/);
});

test("Turn into table: whole selected lines are swapped for the table", () => {
  const state = stateOf("Before.\n\nAda: frontend\n\nBen: backend\n\nAfter.\n");
  const from = find(state.doc, "Ada");
  const to = find(state.doc, "Ben: backend") + "Ben: backend".length;
  assert.ok(wholeLines(state.doc, from, to));
  const md = "| Person | Area |\n| --- | --- |\n| Ada | Frontend |\n| Ben | Backend |\n";
  const tr = acceptTr(state, { mode: "replace", from, to }, md);
  assert.deepEqual(types(tr.doc), ["paragraph", "table", "paragraph"]);
  const table = tr.doc.child(1);
  assert.equal(table.childCount, 3);
  assert.equal(table.child(1).child(0).textContent, "Ada");
});

test("Turn into checklist: lines become to-dos; a part of a line stays a line", () => {
  const state = stateOf("Buy milk\n\nCall Ada\n");
  const from = find(state.doc, "Buy");
  const to = find(state.doc, "Call Ada") + "Call Ada".length;
  const tr = acceptTr(state, { mode: "replace", from, to }, "- [ ] Buy milk\n- [ ] Call Ada\n");
  assert.deepEqual(types(tr.doc), ["bulletList"]);
  assert.equal(tr.doc.firstChild.childCount, 2);
  assert.equal(tr.doc.firstChild.firstChild.attrs.checked, false);

  // Improve part of a heading: the heading stays a heading, only the words change.
  const h = stateOf("## Our plan for teh launch\n\nText.\n");
  const a = find(h.doc, "teh launch");
  const tr2 = acceptTr(h, { mode: "replace", from: a, to: a + "teh launch".length }, "the launch");
  assert.equal(tr2.doc.firstChild.type.name, "heading");
  assert.equal(tr2.doc.firstChild.textContent, "Our plan for the launch");
});

test("Insert below puts blocks after the passage's block; an empty answer changes nothing", () => {
  const state = stateOf("First paragraph here.\n\nSecond.\n");
  const pos = find(state.doc, "paragraph");
  const at = afterBlock(state.doc, pos);
  const tr = acceptTr(state, { mode: "insert", at }, "An **explanation**.");
  assert.deepEqual(tr.doc.content.content.map((n) => n.textContent), ["First paragraph here.", "An explanation.", "Second."]);
  assert.equal(acceptTr(state, { mode: "insert", at }, "  \n\n"), null);
  // A fenced answer is unwrapped first.
  const tr3 = acceptTr(state, { mode: "insert", at: 0 }, "```markdown\n## Intro\n```");
  assert.equal(tr3.doc.firstChild.type.name, "heading");
});

test("Accept is one step: undoing it restores the page exactly", () => {
  const state = stateOf("Alpha beta.\n\nGamma.\n");
  const from = find(state.doc, "Alpha");
  const to = from + "Alpha beta.".length;
  const tr = acceptTr(state, { mode: "replace", from, to }, "- [ ] Alpha\n- [ ] Beta");
  assert.equal(tr.steps.length, 1);
  const back = tr.steps[0].invert(state.doc).apply(tr.doc).doc;
  assert.ok(back.eq(state.doc));
  // (The selection isn't part of it: the store sets it on the same transaction.)
  assert.ok(TextSelection.near(tr.doc.resolve(1)));
});

test("a selection of whole blocks (block boundaries) is swapped for the answer's blocks", () => {
  const state = stateOf("Keep.\n\nOne\n\nTwo\n\nKeep too.\n");
  let from = -1, to = -1;
  state.doc.forEach((n, pos) => {
    if (n.textContent === "One") from = pos;
    if (n.textContent === "Two") to = pos + n.nodeSize;
  });
  const tr = acceptTr(state, { mode: "replace", from, to }, "| A | B |\n| --- | --- |\n| One | Two |\n");
  assert.deepEqual(types(tr.doc), ["paragraph", "table", "paragraph"]);
  assert.deepEqual([tr.doc.firstChild.textContent, tr.doc.lastChild.textContent], ["Keep.", "Keep too."]);
});
