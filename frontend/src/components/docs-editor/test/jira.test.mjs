/**
 * Jira inside pages (components/jira/pages): the inline chip `:jira[KEY]{site=…}`, the card
 * `::jira{key=… site=…}` and the list `::jira-list{…}` read as their nodes, round-trip byte for byte,
 * and what the editor writes for a new one reads back the same. The "/jira …" commands: offered to
 * signed-in editors (the host's `jira`), their words, and the list presets' JQL.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, serializeMarkdown, mentionSource, mentionComplete } from "../core/markdown.mjs";
import { schema, throughEditor } from "./helpers.mjs";
import { GROUPS, JIRA_BLOCKS, JIRA_PRESETS, PAGE_BLOCKS, itemsFor, filterItems, jiraQueryAt } from "../blocks.ts";

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

test("the / menu offers every Jira command to signed-in editors, in a Jira section", () => {
  const ids = ["jira", "jira-card", "jira-list", "jira-mine", "jira-sprint", "jira-bugs", "jira-recent", "jira-epic", "jira-create", "jira-from-text"];
  assert.deepEqual(JIRA_BLOCKS, ids);
  for (const id of ids) assert.ok(PAGE_BLOCKS.includes(id), id);
  const items = itemsFor(PAGE_BLOCKS);
  const jira = items.filter((it) => it.id.startsWith("jira"));
  assert.deepEqual(jira.map((it) => it.id), ids);
  for (const it of jira) assert.equal(it.group, "jira", it.id);
  assert.ok(GROUPS.some(([g, label]) => g === "jira" && label === "Jira"));
  // Offered whenever the host gives the commands (whether or not this person has connected Jira:
  // choosing one then leads to Jira). Cards, lists and presets only on pages; none without the host.
  const runs = [];
  const page = { storage: { dxeServices: { jira: { mode: "page", run: (_e, _r, a) => runs.push(a) } } } };
  const doc = { storage: { dxeServices: { jira: { mode: "doc", run: () => {} } } } };
  const without = { storage: { dxeServices: { pages: { jiraPages: {} } } } };
  for (const it of jira) {
    assert.equal(it.available(page), true, it.id);
    assert.equal(it.available(without), false, it.id);
    assert.equal(it.available(doc), ["jira", "jira-create", "jira-from-text"].includes(it.id), it.id);
  }
  // Each item hands its action to the host.
  for (const it of jira) it.run(page, { from: 1, to: 2 });
  assert.deepEqual(runs, ["issue", "card", "list", "mine", "sprint", "bugs", "recent", "epic", "create", "from-text"]);
  // "/jira" lists them all; the commands' own words find each one.
  assert.deepEqual(filterItems("jira", jira).map((it) => it.id).sort(), [...ids].sort());
  const first = (q) => filterItems(q, jira)[0]?.id;
  assert.equal(first("jira issue"), "jira");
  assert.equal(first("jira card"), "jira-card");
  assert.equal(first("jira list"), "jira-list");
  assert.equal(first("jira my issues"), "jira-mine");
  assert.equal(first("jira sprint"), "jira-sprint");
  assert.equal(first("jira bugs"), "jira-bugs");
  assert.equal(first("jira recently updated"), "jira-recent");
  assert.equal(first("jira create"), "jira-create");
  assert.equal(first("jira from selection"), "jira-from-text");
  assert.equal(first("jira epic"), "jira-epic");
  assert.equal(first("sprint"), "jira-sprint");
  assert.equal(first("bugs"), "jira-bugs");
  assert.ok(filterItems("jql", jira).some((it) => it.id === "jira-list"));
  // In a table cell: the inline chip only.
  assert.deepEqual(jira.filter((it) => it.cell).map((it) => it.id), ["jira"]);
});

test("'/jira my issues': the menu's query keeps the words after jira", () => {
  assert.deepEqual(jiraQueryAt("/jira my issues"), { index: 0, query: "jira my issues" });
  assert.deepEqual(jiraQueryAt("Blocked /jira sprint"), { index: 8, query: "jira sprint" });
  assert.deepEqual(jiraQueryAt("x /jira "), { index: 2, query: "jira " });
  assert.equal(jiraQueryAt("/jira"), null); // one word: the usual query
  assert.equal(jiraQueryAt("a/jira my"), null); // not after a space
  assert.equal(jiraQueryAt("/heading two"), null);
  assert.equal(jiraQueryAt("/jira one two three four"), null);
});

test("the presets are ::jira-list blocks with a JQL each reader runs as themselves", () => {
  assert.deepEqual(JIRA_PRESETS.mine(), {
    jql: "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC", title: "My open issues", cols: "status,priority,due,updated",
  });
  assert.equal(JIRA_PRESETS.sprint("PAY").jql, 'project = "PAY" AND sprint in openSprints() ORDER BY rank ASC');
  assert.equal(JIRA_PRESETS.bugs("PAY").jql, 'project = "PAY" AND issuetype = Bug AND resolution = Unresolved ORDER BY priority DESC, created DESC');
  assert.equal(JIRA_PRESETS.recent("WEB").jql, 'project = "WEB" AND updated >= -7d ORDER BY updated DESC');
  assert.equal(JIRA_PRESETS.epic("PAY-12").jql, "parent = PAY-12 ORDER BY rank ASC");
  assert.equal(JIRA_PRESETS.epic("PAY-12").title, "PAY-12 · child issues");
  // Only real keys: nothing else reaches the JQL.
  for (const bad of ["pay", "PAY\" OR 1=1", "", "P AY"]) {
    assert.equal(JIRA_PRESETS.sprint(bad), null, bad);
    assert.equal(JIRA_PRESETS.bugs(bad), null, bad);
    assert.equal(JIRA_PRESETS.recent(bad), null, bad);
  }
  assert.equal(JIRA_PRESETS.epic("PAY"), null);
  assert.equal(JIRA_PRESETS.epic("PAY-1 OR x"), null);
  // Each one, written as the editor writes it, reads back as a list with its JQL and round-trips.
  for (const p of [JIRA_PRESETS.mine(), JIRA_PRESETS.sprint("PAY"), JIRA_PRESETS.bugs("PAY"), JIRA_PRESETS.recent("PAY"), JIRA_PRESETS.epic("PAY-1")]) {
    const md = write({ type: "directiveLeaf", attrs: { name: "jira-list", attributes: { jql: p.jql, title: p.title, cols: p.cols } } });
    const back = parseMarkdown(md).doc.content[0];
    assert.equal(back.attrs.name, "jira-list");
    assert.equal(back.attrs.attributes.jql, p.jql);
    assert.equal(back.attrs.attributes.title, p.title);
    assert.equal(throughEditor(md).out, md);
  }
});
