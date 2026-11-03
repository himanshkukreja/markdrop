/**
 * Pages (Markdrop documents in the block editor): the mention chip `:markdrop[Title]{src=<slug>}`
 * and the embed block `::markdrop{src=<slug> mode=…}` round-trip, and a chip the editor creates is
 * written so it reads back as the same chip.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, serializeMarkdown, mentionSource } from "../core/markdown.mjs";
import { schema, throughEditor, sameContent } from "./helpers.mjs";
import { PAGE_BLOCKS, itemsFor, filterItems } from "../blocks.ts";

const doc = (...content) => ({ type: "doc", content });
const para = (...kids) => ({ type: "paragraph", content: kids });
const text = (t) => ({ type: "text", text: t });

function write(...content) {
  const json = schema.nodeFromJSON(doc(...content)).toJSON();
  return serializeMarkdown({ doc: json, front: "", lead: "", tail: "\n", eol: "\n", bom: "", empty: false });
}

test("a mention is an inline chip with its label and attributes", () => {
  const { doc: d } = parseMarkdown("See :markdrop[Q3 plan]{src=q3-plan} for dates.\n");
  const kids = d.content[0].content;
  assert.equal(kids.length, 3);
  assert.deepEqual(kids[1], { type: "mention", attrs: { label: "Q3 plan", attributes: { src: "q3-plan" } } });
});

test("mentions and embeds round-trip byte for byte", () => {
  for (const md of [
    "See :markdrop[Q3 plan]{src=q3-plan} for dates.\n",
    'Two: :markdrop[A]{src="a-1"} and :markdrop[B **bold**]{src=b2 extra=1}.\n',
    "::markdrop{src=pricing-calc mode=live}\n",
    "::markdrop{src=handbook mode=card}\n\nText after.\n",
    "- [ ] Check :markdrop[the runbook]{src=runbook-7}\n- [x] Done\n",
    ":::details{summary=\"More\"}\nInside :markdrop[x]{src=x}.\n:::\n",
  ]) {
    const { out } = throughEditor(md);
    assert.equal(out, md);
  }
});

test("not a mention: no label, no src or across lines stays raw", () => {
  for (const md of [":markdrop{src=a}\n", ":markdrop[A]\n", ":markdrop[A]{title=x}\n"]) {
    const { doc: d } = parseMarkdown(md);
    const types = (d.content[0].content ?? []).map((n) => n.type);
    assert.ok(!types.includes("mention"), md);
    assert.equal(throughEditor(md).out, md);
  }
});

test("a chip the editor creates is written canonically and reads back", () => {
  const md = write(para(text("Read "), { type: "mention", attrs: { label: "Launch [beta] notes", attributes: { src: "launch-notes" } } }, text(" first.")));
  assert.equal(md, 'Read :markdrop[Launch [beta] notes]{src="launch-notes"} first.\n');
  const back = parseMarkdown(md).doc.content[0].content[1];
  assert.equal(back.type, "mention");
  assert.equal(back.attrs.label, "Launch [beta] notes");
  assert.equal(back.attrs.attributes.src, "launch-notes");
});

test("an edited paragraph keeps its other chips", () => {
  const src = "A :markdrop[One]{src=one} b.\n";
  const { state, json } = throughEditor(src);
  json.content[0].content.push({ type: "text", text: " More." });
  const out = serializeMarkdown({ ...state, doc: json });
  assert.ok(sameContent(out, 'A :markdrop[One]{src="one"} b. More.\n'));
  assert.match(out, /:markdrop\[One\]\{src="one"\}/);
});

test("mentionSource keeps balanced labels and cleans unsafe ones", () => {
  assert.equal(mentionSource({ label: "A [b] c", attributes: { src: "x" } }), ':markdrop[A [b] c]{src="x"}');
  assert.equal(mentionSource({ label: "A ] c", attributes: { src: "x" } }), ':markdrop[A  c]{src="x"}');
  assert.equal(mentionSource({ label: "Line\nbreak", attributes: { src: "x" } }), ':markdrop[Line break]{src="x"}');
});

test("a chip still waiting for its item isn't written", () => {
  assert.equal(write(para(text("A "), { type: "mention", attrs: { label: "", attributes: {} } }, text("b"))), "A b\n");
});

test("the page's / menu: every block exists, no Guides-only block", () => {
  const items = itemsFor(PAGE_BLOCKS);
  assert.equal(items.length, PAGE_BLOCKS.length);
  const ids = items.map((i) => i.id);
  for (const guides of ["private", "steps", "tabs", "cards", "api", "video", "clip", "embed", "markdrop"]) assert.ok(!ids.includes(guides), guides);
  assert.deepEqual(filterItems("embed", items).map((i) => i.id)[0], "page-embed");
  assert.deepEqual(filterItems("mention", items).map((i) => i.id), ["mention"]);
  assert.equal(itemsFor(undefined).length, itemsFor(null).length);
});

test("the page's toggle is written as :::details{summary}", () => {
  const toggle = itemsFor(["toggle"])[0];
  let inserted = null;
  const fake = { chain: () => ({ focus: () => ({ deleteRange: () => ({ insertContent: (c) => ({ run: () => (inserted = c) }) }) }) }) };
  toggle.run(fake, { from: 0, to: 0 });
  const md = write({ ...inserted, content: [para(text("Hidden."))] });
  assert.equal(md, ':::details{summary="More details"}\nHidden.\n:::\n');
});
