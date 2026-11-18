/**
 * A live append followed at once by an edit to the same section (core/liveSync.mjs,
 * fix/merge-duplicate-lines): the e2e "real" suite's lock-mcp step, where an AI app's
 * append_blocks and then replace_section land in an open editor, now and then left the section
 * twice on the page. The editor took the append in but handed it up only after its 300 ms
 * debounce; the replace landing inside that window found it still "waiting" and merged it back in
 * as typing, on the base from before the append — both sides only added at the end, so both kept.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@tiptap/pm/state";
import { appendTr, incomingValue } from "../core/liveSync.mjs";
import { parseMarkdown, serializeMarkdown } from "../core/markdown.mjs";
import { schema } from "./helpers.mjs";

const PAGE = "# Launch plan\n\nShip it on Monday.\n\n- [ ] Book the room\n";
const APPENDED = "## Added by Claude\n\n- [ ] Draft the announcement email\n- [ ] Record the demo video";
const REPLACED = "## Added by Claude\n\n- [ ] Draft the announcement email\n- [ ] Record the demo video\n- [ ] Merged while Ada edits";

/** backend pages._join / appended: what the server holds after append_blocks. */
const serverAppend = (md, block) => [md, block].map((p) => p.replace(/^\n+|\n+$/g, "")).filter(Boolean).join("\n\n") + "\n";
/** usePageEditSession's `appended`: what the session counts as the page from then on. */
const sessionAppend = (md, block) => `${md.replace(/\s+$/, "")}\n\n${block.trim()}\n`;
const count = (s, needle) => s.split(needle).length - 1;

/** The editor as it holds `md` (what VisualEditor parses), and what it hands up. */
const open = (md) => {
  const parsed = parseMarkdown(md);
  return { meta: parsed, state: EditorState.create({ schema, doc: schema.nodeFromJSON(parsed.doc) }) };
};
const out = (ed) => serializeMarkdown({ ...ed.meta, doc: ed.state.doc.toJSON() });

test("a live append goes in at the end and hands up exactly what the server and the session hold", () => {
  const ed = open(PAGE);
  assert.equal(out(ed), PAGE);
  const tr = appendTr(ed.state, APPENDED);
  ed.state = ed.state.apply(tr);
  const after = out(ed);
  assert.equal(after, serverAppend(PAGE, APPENDED));
  // Handed up, it's no change of ours (the session's base already has it): nothing to save.
  assert.equal(after, sessionAppend(PAGE, APPENDED));
  assert.equal(appendTr(ed.state, "  \n"), null);
});

test("the race: an append still waiting when the replace lands is merged back in as typing — twice", () => {
  // Why the editor must hand an append up at once: had it waited for the debounce, the edit session
  // adopting the replaced version would reach the editor with the append still pending.
  const ed = open(PAGE);
  ed.state = ed.state.apply(appendTr(ed.state, APPENDED));
  const server = serverAppend(PAGE, REPLACED);
  const stale = incomingValue(PAGE, out(ed), server); // lastEmitted still the page before the append
  assert.equal(count(stale.incoming, "Record the demo video"), 2);
  assert.equal(count(stale.incoming, "## Added by Claude"), 2);
  assert.notEqual(stale.typed, null); // …and it would have been saved, so everyone saw it doubled
});

test("fixed: the append is handed up at once, so the replace shows as it is (once)", () => {
  const ed = open(PAGE);
  ed.state = ed.state.apply(appendTr(ed.state, APPENDED));
  const emitted = out(ed); // VisualEditor.append: emit() right after the transaction
  const server = serverAppend(PAGE, REPLACED);
  const r = incomingValue(emitted, null, server);
  assert.equal(r.incoming, server);
  assert.equal(r.typed, null);
  assert.equal(count(r.incoming, "Record the demo video"), 1);
  // And the session side: its base (with the append) under the editor's handed-up text is no
  // change of ours, so catching up adopts the replace as it is.
  assert.equal(emitted, sessionAppend(PAGE, APPENDED));
});

test("typing that is really waiting still survives a newer version, once", () => {
  const ed = open(PAGE);
  ed.state = ed.state.apply(appendTr(ed.state, APPENDED));
  const emitted = out(ed);
  // The author types at the top while the debounce runs; the replace lands.
  const typedHere = emitted.replace("Ship it on Monday.", "Ship it on Tuesday.");
  const server = serverAppend(PAGE, REPLACED);
  const r = incomingValue(emitted, typedHere, server);
  assert.ok(r.incoming.includes("Ship it on Tuesday."));
  assert.ok(r.incoming.includes("Merged while Ada edits"));
  assert.equal(count(r.incoming, "Record the demo video"), 1);
  assert.equal(r.typed, r.incoming);
  // Nothing waiting: the new value as it is.
  assert.deepEqual(incomingValue(emitted, null, server), { incoming: server, typed: null });
  assert.deepEqual(incomingValue(emitted, emitted, server), { incoming: server, typed: null });
});
