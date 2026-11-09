/**
 * Jira inside pages (components/jira/pages): the inline chip `:jira[KEY]{site=…}`, the card
 * `::jira{key=… site=…}` and the list `::jira-list{…}` read as their nodes, round-trip byte for byte,
 * and what the editor writes for a new one reads back the same. The "/" items are offered only when
 * the page's host has Jira.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, serializeMarkdown, mentionSource, mentionComplete } from "../core/markdown.mjs";
import { schema, throughEditor } from "./helpers.mjs";
import { PAGE_BLOCKS, itemsFor, filterItems } from "../blocks.ts";

const doc = (...content) => ({ type: "doc", content });
const para = (...kids) => ({ type: "paragraph", content: kids });
const text = (t) => ({ type: "text", text: t });

function write(...content) {
  const json = schema.nodeFromJSON(doc(...content)).toJSON();
  return serializeMarkdown({ doc: json, front: "", lead: "", tail: "\n", eol: "\n", bom: "", empty: false });
}

test("a Jira chip is an inline mention named jira; cards and lists are leaves", () => {
  const { doc: d } = parseMarkdown("Blocked on :jira[PAY-12]{site=acme.atlassian.net} today.\n\n::jira{key=PAY-3}\n\n::jira-list{project=PAY}\n");
  assert.deepEqual(d.content[0].content[1], { type: "mention", attrs: { name: "jira", label: "PAY-12", attributes: { site: "acme.atlassian.net" } } });
  assert.equal(d.content[1].type, "directiveLeaf");
  assert.equal(d.content[1].attrs.name, "jira");
  assert.equal(d.content[2].attrs.name, "jira-list");
});

test("Jira chips, cards and lists round-trip byte for byte", () => {
  for (const md of [
    "Blocked on :jira[PAY-12]{site=acme.atlassian.net} today.\n",
    "Two: :jira[PAY-1] and :jira[WEB-22]{site=\"acme.atlassian.net\"}.\n",
    "::jira{key=PAY-3}\n",
    "::jira{key=PAY-3 site=acme.atlassian.net}\n\nAfter.\n",
    '::jira-list{jql="project = &quot;PAY&quot; AND status != Done" cols="status,due" limit=10 title="Open"}\n',
    "- [ ] Ship it :jira[PAY-9]\n- [x] Done\n",
    "| Issue | Note |\n| --- | --- |\n| :jira[PAY-4] | x |\n",
  ]) {
    const { out } = throughEditor(md);
    assert.equal(out, md);
  }
});

test("a chip that isn't a key stays text; one the editor makes reads back the same", () => {
  const { doc: d } = parseMarkdown("Not a key :jira[hello]{site=x.y} here.\n");
  assert.ok(!JSON.stringify(d).includes('"name":"jira"'));
  const md = write(para(text("See "), { type: "mention", attrs: { name: "jira", label: "PAY-7", attributes: { site: "acme.atlassian.net" } } }, text(".")));
  assert.equal(md, 'See :jira[PAY-7]{site="acme.atlassian.net"}.\n');
  assert.equal(throughEditor(md).out, md);
  // A chip whose picker is still open (no key yet) isn't written.
  assert.equal(write(para(text("x"), { type: "mention", attrs: { name: "jira", label: "", attributes: {} } }, text(" y"))), "x y\n");
  assert.equal(mentionComplete({ name: "jira", label: "PAY-1" }), true);
  assert.equal(mentionSource({ name: "jira", label: "PAY-1", attributes: {} }), ":jira[PAY-1]");
  const card = write({ type: "directiveLeaf", attrs: { name: "jira", attributes: { key: "PAY-3", site: "acme.atlassian.net" } } });
  assert.equal(card, '::jira{key="PAY-3" site="acme.atlassian.net"}\n');
  assert.equal(parseMarkdown(card).doc.content[0].attrs.attributes.key, "PAY-3");
});

test("the / menu offers Jira on pages whose host has it", () => {
  for (const id of ["jira", "jira-card", "jira-list", "jira-create"]) assert.ok(PAGE_BLOCKS.includes(id), id);
  const items = itemsFor(PAGE_BLOCKS);
  const jira = items.filter((it) => it.id.startsWith("jira"));
  assert.equal(jira.length, 4);
  const withJira = { storage: { dxeServices: { pages: { jiraPages: {} } } } };
  const without = { storage: { dxeServices: { pages: {} } } };
  for (const it of jira) {
    assert.equal(it.available(withJira), true);
    assert.equal(it.available(without), false);
  }
  assert.deepEqual(new Set(filterItems("jira", jira).map((it) => it.id)), new Set(["jira", "jira-card", "jira-list", "jira-create"]));
  assert.ok(filterItems("jql", jira).some((it) => it.id === "jira-list"));
});
