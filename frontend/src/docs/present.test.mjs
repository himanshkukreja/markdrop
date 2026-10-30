/**
 * Page and home presentation settings (present.mjs) and the renderer's pure rules (render/rules.mjs).
 *   node --test src/docs/present.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { heroLede, looseText, pageLede, repeats, startCardText } from "./present.mjs";
import { aliasNodes, aliasesByTarget, hasWrapFlag } from "./render/rules.mjs";

test("looseText / repeats", () => {
  assert.equal(looseText("  Set it UP…  "), "set it up");
  assert.equal(looseText("“Quoted” text."), '"quoted" text');
  assert.ok(repeats("Set it up.", "Set it up. Then run it."));
  assert.ok(repeats("Everything you need before your first…", "Everything you need before your first run, and more."));
  assert.ok(!repeats("Set it up", "Before you set it up"));
  assert.ok(!repeats("", "anything"));
});

test("pageLede: only with pages.showDescription, and never twice", () => {
  const intro = "This guide walks you through it.";
  assert.equal(pageLede(undefined, "Set up in minutes", intro), undefined);
  assert.equal(pageLede({ showDescription: false }, "Set up in minutes", intro), undefined);
  assert.equal(pageLede({ showDescription: true }, "Set up in minutes", intro), "Set up in minutes");
  assert.equal(pageLede({ showDescription: true }, "", intro), undefined);
  // The page already opens with it (a description taken from the first paragraph, or one trimmed for the frontmatter).
  assert.equal(pageLede({ showDescription: true }, "This guide walks you through it.", intro), undefined);
  assert.equal(pageLede({ showDescription: true }, "This guide walks you…", intro), undefined);
});

test("heroLede: the description unless it repeats the headline", () => {
  assert.equal(heroLede("Docs for Acme", "Everything about Acme."), "Everything about Acme.");
  assert.equal(heroLede("Start building with Acme", "Start building with Acme."), undefined);
  assert.equal(heroLede("Acme", ""), undefined);
});

test("startCardText: site.json overrides the page's words", () => {
  const page = { title: "Write a Job", description: "Turn a role into a job configuration." };
  assert.deepEqual(startCardText({ page: "/a" }, page), page);
  assert.deepEqual(startCardText({ title: "Hiring workflows", description: "Set up a role" }, page), { title: "Hiring workflows", description: "Set up a role" });
  assert.deepEqual(startCardText({ title: "  " }, page), page);
});

test("hasWrapFlag: a bare wrap, not inside a value", () => {
  assert.ok(hasWrapFlag("wrap"));
  assert.ok(hasWrapFlag('wrap title="Prompt"'));
  assert.ok(hasWrapFlag('title="Prompt" wrap'));
  assert.ok(hasWrapFlag("{2-3} wrap"));
  assert.ok(!hasWrapFlag('title="wrap it up"'));
  assert.ok(!hasWrapFlag("title=wrap"));
  assert.ok(!hasWrapFlag("wrapped"));
  assert.ok(!hasWrapFlag(""));
  assert.ok(!hasWrapFlag(null));
});

test("alias anchors: one hidden span per old id, never a taken id", () => {
  const aliases = aliasesByTarget({ "id-1.-intro": "1-intro", "old-intro": "1-intro", "x": "x", "step-2": "step-2--go" });
  assert.deepEqual(aliases.get("1-intro"), ["id-1.-intro", "old-intro"]);
  assert.equal(aliases.has("x"), false, "an alias to itself is dropped");
  const nodes = aliasNodes(aliases, "1-intro", new Set(["old-intro"]));
  assert.equal(nodes.length, 1);
  assert.deepEqual(nodes[0], { type: "element", tagName: "span", properties: { id: "id-1.-intro", className: ["dx-anchor-alias"], ariaHidden: "true" }, children: [] });
  assert.deepEqual(aliasNodes(aliases, "nothing", new Set()), []);
  assert.equal(aliasesByTarget(undefined).size, 0);
});
