/** Typed page properties: the props line, value checks, and a database view's filter / sort / group. */
import test from "node:test";
import assert from "node:assert/strict";
import { applyView, checkValue, formatLine, groupRows, keyFromName, matches, readValues, sortRows, writeValues } from "./model.mjs";

// The backend writes exactly this line for these values (backend/tests/test_page_db.py checks the same).
const LINE = 'props: {status: "In build", owner: "0123456789abcdef01234567", related: ["prd-x", "https://a.b/c"], n: 3, done: true}';
const VALUES = { status: "In build", owner: "0123456789abcdef01234567", related: ["prd-x", "https://a.b/c"], n: 3, done: true };

test("formats the line like the backend", () => {
  assert.equal(formatLine(VALUES), LINE);
  assert.equal(formatLine({ "a key": 'x: "q"' }), 'props: {"a key": "x: \\"q\\""}');
});

test("reads it back, and hand-written flow maps", () => {
  assert.deepEqual(readValues(`---\n${LINE}\n---\nBody`), VALUES);
  assert.deepEqual(readValues("---\nprops: {status: In build, tags: [a, 'b c'], n: 2.5, ok: false}\n---\n"), { status: "In build", tags: ["a", "b c"], n: 2.5, ok: false });
  assert.deepEqual(readValues("---\nprops: {broken\n---\n"), {});
  assert.deepEqual(readValues("No front matter"), {});
  // A block mapping needs a YAML parser (the editor passes one).
  const block = "---\nprops:\n  status: Done\n---\n";
  assert.deepEqual(readValues(block), {});
  assert.deepEqual(readValues(block, { parseYaml: () => ({ props: { status: "Done", d: new Date("2026-11-20") } }) }), { status: "Done", d: "2026-11-20" });
});

test("writes change the line alone", () => {
  const md = "---\ntitle: A\nprops: {a: 1}\nicon: x\n---\nBody\n";
  assert.equal(writeValues(md, { b: "two" }), "---\ntitle: A\nprops: {a: 1, b: \"two\"}\nicon: x\n---\nBody\n");
  assert.equal(writeValues(md, { a: null }), "---\ntitle: A\nicon: x\n---\nBody\n");
  assert.equal(writeValues("---\nprops: {a: 1}\n---\nBody\n", { a: [] }), "Body\n");
  assert.equal(writeValues("Body\n", { s: "x" }), "---\nprops: {s: \"x\"}\n---\nBody\n");
  assert.equal(writeValues("---\r\ntitle: A\r\n---\r\nB", { s: "x" }), "---\r\ntitle: A\r\nprops: {s: \"x\"}\r\n---\r\nB");
  const block = "---\nprops:\n  status: Done\n  n: 1\ntitle: T\n---\n";
  assert.equal(writeValues(block, { status: "Open" }, { parseYaml: () => ({ props: { status: "Done", n: 1 } }) }), "---\nprops: {status: \"Open\", n: 1}\ntitle: T\n---\n");
});

test("keys from names", () => {
  assert.equal(keyFromName("Target date"), "target_date");
  assert.equal(keyFromName("Feature ID"), "feature_id");
  assert.equal(keyFromName("2nd"), "p_2nd");
  assert.equal(keyFromName("Icon"), "icon_2");
  assert.equal(keyFromName("Status", new Set(["status"])), "status_2");
});

const SCHEMA = [
  { key: "status", name: "Status", type: "select", options: [{ name: "Proposed", color: "blue" }, { name: "In build", color: "orange" }, { name: "In QA", color: "purple" }, { name: "Released", color: "green" }] },
  { key: "owner", name: "Owner", type: "person" },
  { key: "due", name: "Target date", type: "date" },
  { key: "tags", name: "Tags", type: "multi_select", options: [{ name: "api", color: "red" }, { name: "ui", color: "gray" }] },
  { key: "pts", name: "Points", type: "number" },
  { key: "ok", name: "Done", type: "checkbox" },
];
const row = (slug, values, extra = {}) => ({ slug, title: slug.toUpperCase(), url: "", updated_at: extra.u ?? "2026-11-01", created_at: null, rev: 1, can_edit: true, values });
const ROWS = [
  row("a", { status: "Released", owner: "u1", due: "2026-11-20", tags: ["api"], pts: 3, ok: true }),
  row("b", { status: "Proposed", owner: "u2", due: "2026-10-01", tags: ["ui", "api"], pts: 8 }),
  row("c", { status: "In build" }),
  row("d", {}),
];
const PEOPLE = { u1: { name: "Zed" }, u2: { name: "Ada" } };

test("filters", () => {
  const pick = (rule) => ROWS.filter((r) => matches(r, rule, SCHEMA)).map((r) => r.slug).join("");
  assert.equal(pick({ key: "status", op: "is", value: "proposed" }), "b");
  assert.equal(pick({ key: "Status", op: "is_not", value: "Proposed" }), "acd");
  assert.equal(pick({ key: "tags", op: "contains", value: "api" }), "ab");
  assert.equal(pick({ key: "due", op: "before", value: "2026-11-01" }), "b");
  assert.equal(pick({ key: "pts", op: "gt", value: 4 }), "b");
  assert.equal(pick({ key: "ok", op: "is", value: true }), "a");
  assert.equal(pick({ key: "ok", op: "is", value: false }), "bcd");
  assert.equal(pick({ key: "owner", op: "is_empty" }), "cd");
  assert.equal(pick({ key: "title", op: "contains", value: "c" }), "c");
  // A rule without a value yet (the filter menu while it's being written) filters nothing out.
  assert.equal(pick({ key: "status", op: "is", value: null }), "abcd");
});

test("sorts: select by option order, people by name, empty last both ways", () => {
  const order = (sort) => sortRows(ROWS, sort, SCHEMA, PEOPLE).map((r) => r.slug).join("");
  assert.equal(order([{ key: "status", dir: "asc" }]), "bcad");
  assert.equal(order([{ key: "status", dir: "desc" }]), "acbd");
  assert.equal(order([{ key: "owner", dir: "asc" }]), "bacd");
  assert.equal(order([{ key: "pts", dir: "desc" }]), "bacd");
  assert.equal(applyView(ROWS, { filter: [{ key: "status", op: "is_not_empty", value: null }], sort: [{ key: "due", dir: "asc" }] }, SCHEMA, PEOPLE).map((r) => r.slug).join(""), "bac");
});

test("groups: options in order, then empty", () => {
  const g = groupRows(ROWS, "status", SCHEMA, PEOPLE);
  assert.deepEqual(g.map((x) => [x.label, x.rows.map((r) => r.slug).join("")]), [["Proposed", "b"], ["In build", "c"], ["In QA", ""], ["Released", "a"], ["No Status", "d"]]);
  const t = groupRows(ROWS, "tags", SCHEMA, PEOPLE);
  assert.deepEqual(t.map((x) => [x.label, x.rows.map((r) => r.slug).join("")]), [["api", "ab"], ["ui", "b"], ["No Tags", "cd"]]);
  const p = groupRows(ROWS, "owner", SCHEMA, PEOPLE);
  assert.deepEqual(p.map((x) => x.label), ["Zed", "Ada", "No Owner"]);
});

test("groups: a date by month, in the rows' order", () => {
  const schema = [{ key: "date", name: "Date", type: "date" }];
  const rows = [
    { slug: "a", values: { date: "2026-11-04" } }, { slug: "b", values: { date: "2026-10-28" } },
    { slug: "c", values: {} }, { slug: "d", values: { date: "2026-10-02" } },
  ];
  const g = groupRows(rows, "date", schema, {});
  assert.deepEqual(g.map((x) => [x.label, x.rows.map((r) => r.slug).join(""), x.value]),
    [["November 2026", "a", null], ["October 2026", "bd", null], ["No Date", "c", null]]);
});

test("value checks", () => {
  assert.equal(checkValue(SCHEMA[0], "In QA"), null);
  assert.match(checkValue(SCHEMA[0], "Shipped"), /isn't one of/);
  assert.equal(checkValue(SCHEMA[2], "2026-02-30") === null, true); // the server checks real dates
  assert.match(checkValue(SCHEMA[2], "20-11-2026"), /YYYY-MM-DD/);
  assert.equal(checkValue({ key: "l", name: "L", type: "link" }, ["prd-x", "https://x.y"]), null);
  assert.match(checkValue({ key: "l", name: "L", type: "link" }, "javascript:alert(1)"), /http/);
});
