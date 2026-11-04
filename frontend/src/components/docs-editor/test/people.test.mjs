/**
 * The `@` people picker's rules (menus/peopleMatch.ts): when `@` opens it (start of a line, after
 * whitespace or punctuation; never "a@b.com", never in code), when it stays open, and the fuzzy
 * filter by name or email. Plus the "/" menu in a table cell (inline items only) and "/person".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@tiptap/pm/state";
import { filterPeople, keepsOpen, mayOpen, opensAfter, triggerContext } from "../menus/peopleMatch.ts";
import { PAGE_BLOCKS, BLOCK_ITEMS, cellItems, filterItems, itemsFor } from "../blocks.ts";
import { parseMarkdown } from "../core/markdown.mjs";
import { schema } from "./helpers.mjs";

const PEOPLE = [
  { id: "1", name: "Ada Lovelace", email: "ada@acme.test", you: true },
  { id: "2", name: "Ben Member", email: "ben.member@acme.test" },
  { id: "3", name: "Benoît Ordóñez", email: "bo@acme.test" },
  { id: "4", name: "Wes Admin", email: "w.admin@acme.test" },
  { id: "5", name: "Vic Viewer", email: "victoria@else.test" },
  { id: "6", name: "Zed", email: null },
];
const names = (xs) => xs.map((x) => x.name);

test("@ opens at the start of a line, after whitespace or punctuation", () => {
  for (const c of [null, "", " ", " ", "\t", "(", "[", "\"", "“", "'", ",", ";", ":", "—", "-", "/", ".", "!"]) assert.equal(opensAfter(c), true, JSON.stringify(c));
});

test("@ stays closed after a letter, digit, underscore or another @ (a@b.com, handles)", () => {
  for (const c of ["a", "Z", "é", "ж", "字", "7", "_", "@"]) assert.equal(opensAfter(c), false, c);
});

test("one word keeps it open (even with no match); more words only while someone matches", () => {
  assert.equal(keepsOpen("", PEOPLE), true);
  assert.equal(keepsOpen("nobody", PEOPLE), true);
  assert.equal(keepsOpen("ben", null), true);
  assert.equal(keepsOpen("ben m", PEOPLE), true);
  assert.equal(keepsOpen("ben ", PEOPLE), true);
  assert.equal(keepsOpen("ben said", PEOPLE), false);
  assert.equal(keepsOpen("ben said", null), true); // not loaded yet: give it a chance
  assert.equal(keepsOpen(" ben", PEOPLE), false); // "@ " is not a mention
  assert.equal(keepsOpen("a b c d", null), false);
  assert.equal(keepsOpen("x".repeat(61), PEOPLE), false);
});

test("filter: by name (start, a word, words in order), by email, then letters in order; accents ignored", () => {
  assert.deepEqual(names(filterPeople(PEOPLE, "")), names(PEOPLE));
  assert.deepEqual(names(filterPeople(PEOPLE, "ben")), ["Ben Member", "Benoît Ordóñez"]);
  assert.deepEqual(names(filterPeople(PEOPLE, "BEN")), ["Ben Member", "Benoît Ordóñez"]);
  assert.equal(filterPeople(PEOPLE, "member")[0].name, "Ben Member");
  assert.deepEqual(names(filterPeople(PEOPLE, "ben m")), ["Ben Member"]);
  assert.deepEqual(names(filterPeople(PEOPLE, "benoit ord")), ["Benoît Ordóñez"]);
  assert.deepEqual(names(filterPeople(PEOPLE, "ordonez")), ["Benoît Ordóñez"]);
  // Email: its start, a word of its local part, anywhere in it.
  assert.deepEqual(names(filterPeople(PEOPLE, "victoria")), ["Vic Viewer"]);
  assert.deepEqual(names(filterPeople(PEOPLE, "admin")), ["Wes Admin"]);
  assert.deepEqual(names(filterPeople(PEOPLE, "else.test")), ["Vic Viewer"]);
  // Fuzzy: letters in order.
  assert.equal(filterPeople(PEOPLE, "bnmb")[0].name, "Ben Member");
  assert.equal(filterPeople(PEOPLE, "wsad")[0].name, "Wes Admin");
  // Name matches rank before email matches.
  const r = filterPeople([{ id: "a", name: "Xavier", email: "ada@x.test" }, { id: "b", name: "Ada Two", email: "z@x.test" }], "ada");
  assert.deepEqual(r.map((x) => x.id), ["b", "a"]);
  // No match, and someone with no email.
  assert.deepEqual(filterPeople(PEOPLE, "qqqq"), []);
  assert.deepEqual(names(filterPeople(PEOPLE, "zed")), ["Zed"]);
  // A single letter doesn't fuzzy-match everyone.
  assert.deepEqual(names(filterPeople(PEOPLE, "v")), ["Vic Viewer"]);
});

/** A state with the caret at the end of the first text block containing `marker`. */
function stateAt(md, marker = "@") {
  const doc = schema.nodeFromJSON(parseMarkdown(md).doc);
  let at = null;
  doc.descendants((n, pos) => {
    if (at !== null) return false;
    if (n.isText && n.text.includes(marker)) {
      at = pos + n.text.lastIndexOf(marker);
      return false;
    }
    return true;
  });
  assert.notEqual(at, null, `no ${marker} in ${md}`);
  return { state: EditorState.create({ doc }), at };
}
/** The suggestion's range: from the @ to the end of its text node. */
function rangeOf(state, at) {
  const $ = state.doc.resolve(at);
  return { from: at, to: $.end() };
}
const opens = (md, people = PEOPLE, force = false) => {
  const { state, at } = stateAt(md);
  return mayOpen(state, rangeOf(state, at), people, force);
};

test("in a document: where @ opens and where it doesn't", () => {
  assert.equal(opens("@ben\n"), true);
  assert.equal(opens("Ask @ben\n"), true);
  assert.equal(opens("(cc @ben)\n".replace(")", "")), true);
  assert.equal(opens("Ask (@ben\n"), true);
  assert.equal(opens("mail a@b.com\n"), false);
  assert.equal(opens("- [ ] Check with @\n"), true);
  assert.equal(opens("> quoted @w\n"), true);
  assert.equal(opens("| A | B |\n| --- | --- |\n| x @be | y |\n"), true);
  // Code: a code block, Mermaid, math, inline code.
  assert.equal(opens("```js\nconst a = @b\n```\n"), false);
  assert.equal(opens("```mermaid\ngraph TD\n  A-->@B\n```\n"), false);
  assert.equal(opens("$$\nx @ y\n$$\n"), false);
  assert.equal(opens("Use `x @y` here\n"), false);
  // A space keeps an open picker open, but never opens one (coming back to "@ben m" left as text).
  {
    const { state, at } = stateAt("Ask @ben m\n");
    assert.equal(mayOpen(state, rangeOf(state, at), PEOPLE, false, true), true);
    assert.equal(mayOpen(state, rangeOf(state, at), PEOPLE, false, false), false);
    const one = stateAt("Ask @ben\n");
    assert.equal(mayOpen(one.state, rangeOf(one.state, one.at), PEOPLE, false, false), true);
  }
  // "/person" put it there: opens even straight after text.
  assert.equal(opens("word@\n", PEOPLE, true), true);
  assert.equal(opens("word@\n", PEOPLE, false), false);
});

test("the trigger context reads the character before, code and the query", () => {
  const { state, at } = stateAt("Hello, @ben m\n");
  const c = triggerContext(state, rangeOf(state, at));
  assert.deepEqual(c, { before: " ", inCode: false, query: "ben m" });
  const s2 = stateAt("@x\n");
  assert.equal(triggerContext(s2.state, rangeOf(s2.state, s2.at)).before, null);
});

test("the / menu in a table cell: only inline items, and /person is there", () => {
  const page = itemsFor(PAGE_BLOCKS);
  const cell = cellItems(page);
  assert.deepEqual(cell.map((x) => x.id).sort(), ["date", "emoji", "mention", "person"]);
  assert.equal(filterItems("person", cell)[0].id, "person");
  assert.equal(filterItems("@", cell)[0].id, "person");
  // No blocks in a cell.
  for (const id of ["table", "h1", "code", "mermaid", "columns-2", "image", "callout-note"]) assert.ok(!cell.some((x) => x.id === id), id);
  // The Guides editor's cell menu: the keyboard key only.
  assert.deepEqual(cellItems(BLOCK_ITEMS).map((x) => x.id), ["kbd"]);
});
