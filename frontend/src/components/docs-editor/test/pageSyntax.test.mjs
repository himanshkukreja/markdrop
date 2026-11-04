/**
 * PAGE_SYNTAX (backend/app/mcp/page_tools.py) tells AI apps what a page's Markdown may hold. Every
 * construct it names must be one the editor models: each example below goes through the editor
 * byte-identical with no raw (Markdown-only) block, and PAGE_SYNTAX mentions it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FRONTEND, throughEditor } from "./helpers.mjs";

const PY = fs.readFileSync(path.join(FRONTEND, "../backend/app/mcp/page_tools.py"), "utf8");
const block = PY.slice(PY.indexOf("PAGE_SYNTAX = ("), PY.indexOf("_SYNTAX = PAGE_SYNTAX"));
// The Python string: its literals joined, with \" unescaped.
const SYNTAX = [...block.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((m) => m[1].replace(/\\"/g, '"')).join("");

/** [what PAGE_SYNTAX must mention, a full example of it] */
const CASES = [
  ["- [ ]", "- [ ] To do\n- [x] Done\n"],
  ["```mermaid", "```mermaid\ngraph TD\n  A --> B\n```\n"],
  ["$$", "Inline $E = mc^2$.\n\n$$\na^2 + b^2 = c^2\n$$\n"],
  [":::note", ':::note{icon="💡" color="blue"}\nA callout.\n:::\n'],
  ["[Title]", ":::tip[A title]\nA shortcut.\n:::\n"],
  [':::details{summary="Title"}', ':::details{summary="Why?"}\nBecause.\n:::\n'],
  ["heading=2", ':::details{summary="FAQ" heading="2"}\nAnswers.\n:::\n'],
  [':span[text]{color="red"}', 'A :span[red word]{color="red"} here.\n'],
  [':span[text]{bg="yellow"}', 'A :span[highlight]{bg="yellow"} here.\n'],
  [":u[text]", "Some :u[underlined] text.\n"],
  ["#b-", 'A paragraph. {#b-k3x9a1 color="green"}\n'],
  ['## Title {bg="blue"}', '## Title {bg="blue"}\n'],
  ['- Item {bg="pink"}', '- Item {bg="pink"}\n- Another\n'],
  ['| Ada {bg="yellow"} |', '| Name | Role |\n| --- | --- |\n| Ada {bg="yellow"} | Owner |\n'],
  ['{caption="', '```js\nconsole.log(1);\n```\n{caption="A small example"}\n'],
  ["header-column", '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n{header-column widths="120,"}\n'],
  ['header-row="off"', '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n{header-row="off"}\n'],
  ["::::columns", '::::columns\n:::column{width="40%"}\nLeft.\n:::\n\n:::column{width="60%"}\nRight.\n:::\n::::\n'],
  [":::indent", "A parent line.\n\n:::indent\nNested under it.\n:::\n"],
  [':::button{label="Add a task"}', ':::button{label="Add a task"}\n- [ ] New task\n:::\n'],
  [":::signoff{#b-k3x9a1", ':::signoff{#b-k3x9a1 person="6650f0c2a1" label="Release approval" options="Approved for production|Not approved" lock=above}\nQA passed on staging.\n:::\n'],
  ['label="Release approval"', ':::signoff{#b-k3x9a2 person="6650f0c2a1" label="Release approval"}\n:::\n'],
  ["![alt](asset:<id>)", "![A chart](asset:a1b2c3d4)\n"],
  ['{width="60%" align="left"}', '![A chart](asset:a1b2c3d4 "Its caption"){width="60%" align="left"}\n'],
  ["::markdrop{src=", '::markdrop{src="q3-report" mode="card"}\n'],
  [":markdrop[Title]", 'Read :markdrop[the plan]{src="launch-plan"} first.\n'],
  ["::page{src=", '::page{src="launch-sync"}\n'],
  ["::toc", "::toc\n"],
  ["::breadcrumb", "::breadcrumb\n"],
  ["::bookmark{url=", '::bookmark{url="https://example.com/" title="Example" description="An example"}\n'],
  ["::embed{src=", '::embed{src="https://www.youtube.com/watch?v=dQw4w9WgXcQ"}\n'],
  [":person[Name]", 'Owner :person[Ada Lovelace]{id="6650f0c2a1"}.\n'],
  [":date[YYYY-MM-DD]", "Due :date[2026-11-10].\n"],
  [":kbd[", "Press :kbd[⌘ K] to search.\n"],
];

function raw(n) {
  return (n.type === "rawBlock" || n.type === "rawInline" ? [n] : []).concat(...(n.content ?? []).map(raw));
}

test("PAGE_SYNTAX was read from page_tools.py", () => {
  assert.ok(SYNTAX.startsWith("Page Markdown:"), SYNTAX.slice(0, 80));
  assert.ok(!/TODO/.test(block), "PAGE_SYNTAX still has a TODO");
});

for (const [mention, md] of CASES) {
  test(`page syntax: ${mention}`, () => {
    assert.ok(SYNTAX.includes(mention), `PAGE_SYNTAX doesn't mention ${mention}`);
    const { json, out } = throughEditor(md);
    assert.equal(out, md, "not byte-identical through the editor");
    assert.deepEqual(raw(json).map((n) => n.type), [], "the editor keeps it as raw Markdown");
  });
}
