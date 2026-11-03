/**
 * The "/" menu's list (blocks.ts): sections before typing, consistent labels, shortcuts, fuzzy
 * search, search-only variants, and the Guides block set's own sections.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { BLOCK_ITEMS, GROUPS, PAGE_BLOCKS, filterItems, itemsFor, orderItems } from "../blocks.ts";

const page = itemsFor(PAGE_BLOCKS);
const ids = (xs) => xs.map((x) => x.id);
const labels = (xs) => xs.map((x) => x.label);

test("a page's menu comes in sections, in the spec's order", () => {
  const shown = orderItems(page);
  const groups = [...new Set(shown.map((x) => x.group))];
  assert.deepEqual(groups, ["basic", "media", "markdrop", "advanced", "inline"]);
  assert.deepEqual(labels(shown.filter((x) => x.group === "basic")), [
    "Text", "Heading 1", "Heading 2", "Heading 3", "To-do list", "Bulleted list", "Numbered list", "Toggle list",
    "Toggle heading 1", "Toggle heading 2", "Toggle heading 3", "Quote", "Divider", "Callout",
  ]);
  assert.deepEqual(labels(shown.filter((x) => x.group === "media")), ["Image", "Video", "Audio", "File", "Bookmark", "Web embed"]);
  assert.deepEqual(labels(shown.filter((x) => x.group === "markdrop")), ["Embed an item", "Mention an item", "Sub-page"]);
  assert.deepEqual(labels(shown.filter((x) => x.group === "advanced")), ["Table", "Columns", "Code", "Equation", "Mermaid diagram", "Table of contents", "Breadcrumb", "Button"]);
  assert.deepEqual(labels(shown.filter((x) => x.group === "inline")), ["Mention a person", "Date", "Emoji"]);
  // An empty query is the sectioned list.
  assert.deepEqual(ids(filterItems("", page)), ids(shown));
});

test("shortcut hints: Markdown a page turns into the block", () => {
  const by = Object.fromEntries(page.map((x) => [x.id, x.shortcut]));
  assert.deepEqual([by.h1, by.h2, by.h3, by.tasks, by.bullets, by.numbers, by.quote, by.divider, by.code, by.math], ["#", "##", "###", "[]", "-", "1.", ">", "---", "```", "$$"]);
  // The Guides editor has no [] or $$ rule: no hint there.
  const guides = Object.fromEntries(BLOCK_ITEMS.map((x) => [x.id, x.shortcut]));
  assert.equal(guides.tasks, undefined);
  assert.equal(guides.math, undefined);
});

test("search: labels first, then aliases and descriptions, then letters in order", () => {
  assert.equal(filterItems("head", page)[0].id, "h1");
  assert.equal(filterItems("todo", page)[0].id, "tasks");
  assert.equal(filterItems("tdl", page)[0].id, "tasks");
  assert.equal(filterItems("mrmd", page)[0].id, "mermaid");
  assert.equal(filterItems("columns", page)[0].id, "columns-2");
  assert.equal(filterItems("youtube", page)[0].id, "web-embed");
  assert.equal(filterItems("##", page)[0].id, "h2");
  assert.deepEqual(filterItems("zzqx", page), []);
  // Variants only show up when searched for.
  assert.ok(!ids(orderItems(page)).includes("callout-warning"));
  assert.equal(filterItems("warn", page)[0].id, "callout-warning");
  assert.equal(filterItems("4", page)[0].id, "columns-4");
});

test("the Guides menu: its own blocks right after the basics, no page-only blocks", () => {
  const shown = orderItems(BLOCK_ITEMS);
  const groups = [...new Set(shown.map((x) => x.group))];
  assert.deepEqual(groups, ["basic", "docs", "media", "markdrop", "advanced", "inline"]);
  assert.deepEqual(labels(shown.filter((x) => x.group === "docs")), ["Steps", "Tabs", "Cards", "Details", "Private section", "API endpoint"]);
  assert.ok(labels(shown).includes("Heading 2") && !labels(shown).includes("Heading 1"));
  assert.equal(GROUPS.find(([g]) => g === "docs")[1], "Guide blocks");
});
