/**
 * Typed page properties (components/pages/props/model.mjs; backend services/page_db.py) live on one
 * `props:` line of a page's front matter. The editor carries the front matter through untouched, and
 * the panel's writes change that line alone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { throughEditor } from "./helpers.mjs";
import { splitFrontmatter, writeFrontmatter } from "../core/frontmatter.mjs";
import { readValues, writeValues } from "../../pages/props/model.mjs";

const PAGE = '---\nicon: 🚀\nprops: {status: "In build", owner: "0123456789abcdef01234567", target_date: "2026-11-20", related: ["prd-x", "https://example.com/a"], points: 3, done: true}\ncover: gallery:dawn\n---\n# Spec\n\nSome text.\n';

test("a page with typed properties goes through the editor byte for byte", () => {
  assert.equal(throughEditor(PAGE).out, PAGE);
  const block = '---\nprops:\n  status: In build\n  tags: [a, b]\ntitle: X\n---\nBody\n';
  assert.equal(throughEditor(block).out, block);
});

test("the line is YAML: a YAML parser reads the same values", () => {
  const front = PAGE.split("---\n")[1];
  assert.deepEqual(parse(front).props, readValues(PAGE));
});

test("setting a value through the panel changes only the props line", () => {
  const out = writeValues(PAGE, { status: "In QA", points: null });
  assert.equal(out, PAGE.replace('status: "In build"', 'status: "In QA"').replace(", points: 3", ""));
  assert.equal(throughEditor(out).out, out);
});

test("the page head's own writes (pagePropsWrite.ts) keep the props line", () => {
  const { front, body } = splitFrontmatter(PAGE);
  const out = writeFrontmatter(front, { full_width: "true", icon: null }) + body;
  assert.match(out, /\nprops: \{status: "In build"/);
  assert.deepEqual(readValues(out), readValues(PAGE));
});
