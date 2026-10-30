/**
 * The page ↔ editor document split (pageDoc.ts): title / description / icon are the API's fields,
 * other frontmatter keys are frontmatter_extra, the body is markdown — nothing lost or duplicated.
 * Runs on node's TypeScript type stripping (node ≥ 22.18); skipped without it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

let mod = null;
try {
  mod = await import("./pageDoc.ts");
} catch (e) {
  if (!/Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION|strip/i.test(String(e?.message ?? e))) throw e;
}
const t = mod ? test : test.skip;

const fields = (over = {}) => ({ title: "Quickstart", description: "Set up in five minutes.", icon: null, markdown: "## Install\n\nRun it.\n", frontmatter_extra: {}, ...over });

t("compose puts the header in the frontmatter and parse takes it back out", () => {
  const { composeDoc, parseDoc } = mod;
  const doc = composeDoc(fields({ icon: "zap" }));
  assert.equal(doc, "---\ntitle: Quickstart\ndescription: Set up in five minutes.\nicon: zap\n---\n\n## Install\n\nRun it.\n");
  const back = parseDoc(doc, {});
  assert.deepEqual(back, { title: "Quickstart", description: "Set up in five minutes.", icon: "zap", markdown: "## Install\n\nRun it.\n", frontmatter_extra: {} });
});

t("extra keys round-trip typed, never duplicate the header", () => {
  const { composeDoc, parseDoc } = mod;
  const extra = { keywords: ["setup", "install"], since: "2.1", nav: { label: "Start" }, anchors: { "old-id": "install" }, n: 3, flag: true };
  const doc = composeDoc(fields({ frontmatter_extra: { ...extra, title: "ignored", hidden: true } }));
  assert.equal((doc.match(/^title:/gm) ?? []).length, 1);
  assert.ok(!/^hidden:/m.test(doc));
  const back = parseDoc(doc, {});
  assert.deepEqual(back.frontmatter_extra, extra);
  assert.equal(back.title, "Quickstart");
  assert.equal(back.hidden, undefined);
});

t("quoting: titles that YAML would read as something else stay strings", () => {
  const { composeDoc, parseDoc } = mod;
  for (const title of ["yes", "null", "1.0", "Note: read this", "# not a comment", "'quoted'", "  spaced  ", "a \"b\" c"]) {
    const back = parseDoc(composeDoc(fields({ title })), {});
    assert.equal(back.title, title, title);
  }
});

t("an empty description stays a field, not a lost key", () => {
  const { composeDoc, parseDoc } = mod;
  const doc = composeDoc(fields({ description: "" }));
  assert.match(doc, /^description: ""$/m);
  assert.equal(parseDoc(doc, {}).description, "");
});

t("a body that still carries its own --- block is folded in, not shown twice", () => {
  const { composeDoc, parseDoc } = mod;
  const doc = composeDoc(fields({ markdown: "---\ntitle: Old\nkeywords: [a, b]\n---\nBody\n", frontmatter_extra: { since: "1" } }));
  assert.equal((doc.match(/^---$/gm) ?? []).length, 2);
  const back = parseDoc(doc, {});
  assert.equal(back.title, "Quickstart");
  assert.equal(back.markdown, "Body\n");
  assert.deepEqual(back.frontmatter_extra, { keywords: ["a", "b"], since: "1" });
});

t("invalid YAML mid-typing keeps the previous extra keys", () => {
  const { parseDoc } = mod;
  const prev = { keywords: ["x"] };
  const back = parseDoc("---\ntitle: Hi\nkeywords: [unclosed\n---\nBody", prev);
  assert.equal(back.title, "Hi");
  assert.equal(back.frontmatter_extra, prev);
  assert.equal(back.markdown, "Body");
});

t("hidden typed into the frontmatter becomes the field", () => {
  const { parseDoc } = mod;
  assert.equal(parseDoc("---\ntitle: A\nhidden: true\n---\nx", {}).hidden, true);
  assert.equal(parseDoc("---\ntitle: A\nhidden: false\n---\nx", {}).hidden, false);
  assert.deepEqual(parseDoc("---\ntitle: A\nhidden: true\n---\nx", {}).frontmatter_extra, {});
});

t("setDocKeys edits one key in place, like the editor's header", () => {
  const { composeDoc, setDocKeys } = mod;
  const doc = composeDoc(fields({ frontmatter_extra: { since: "2" } }));
  const withIcon = setDocKeys(doc, { icon: "book" });
  assert.match(withIcon, /^icon: book$/m);
  assert.ok(withIcon.endsWith("\n\n## Install\n\nRun it.\n"));
  assert.equal(setDocKeys(withIcon, { icon: null }), doc);
  assert.equal(setDocKeys("Body only", { icon: "zap" }), "---\nicon: zap\n---\n\nBody only");
});

t("no frontmatter at all: the whole text is the body", () => {
  const { parseDoc } = mod;
  assert.deepEqual(parseDoc("Just text", { a: 1 }), { title: "", description: "", icon: null, markdown: "Just text", frontmatter_extra: {} });
});
