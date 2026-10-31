// Guides product events. Run: node --test src/lib/guidesEventsCore.test.mjs
// (Node >= 22.18 strips the types from guidesEventsCore.ts; it has no imports.)
import test from "node:test";
import assert from "node:assert/strict";
import { createdEvents, sitePatchEvents } from "./guidesEventsCore.ts";

const SECRET = /acme|https?:|\.com|body\s*\{|Quickstart|secret/i;
const noContent = (events) => {
  for (const [, props] of events) for (const v of Object.values(props)) assert.ok(!(typeof v === "string" && SECRET.test(v)), `content leaked: ${v}`);
};

test("guide_created names the source, never the import's address", () => {
  const imp = createdEvents({ workspace_id: "ws1", source: { kind: "gitbook", url: "https://docs.acme.com" } });
  assert.deepEqual(imp, [["guide_created", { source: "import", workspace: true }], ["guide_import_started", { source: "gitbook" }]]);
  noContent(imp);
  assert.deepEqual(createdEvents({ workspace_id: null, source: { kind: "template", template: "api" } }), [["guide_created", { source: "template", template: "api", workspace: false }]]);
  assert.deepEqual(createdEvents({ source: { kind: "template", template: "<b>x</b>" } }), [["guide_created", { source: "template", workspace: false }]]);
  assert.deepEqual(createdEvents({ source: { kind: "blank" } }), [["guide_created", { source: "blank", workspace: false }]]);
});

test("a design save reports its choices, not its CSS or logo", () => {
  const ev = sitePatchEvents({ settings: { theme: { preset: "editorial", mode: "dark", brand: { enabled: true, logo_url: "https://acme.com/logo.svg" }, custom_css: "body { color: red }", fonts: {} } } });
  assert.deepEqual(ev, [["guide_design_saved", { preset: "editorial", mode: "dark", brand: true, css: true }]]);
  noContent(ev);
  assert.deepEqual(sitePatchEvents({ settings: { theme: { preset: "nope", custom_css: null } } }), [["guide_design_saved", { css: false }]]);
});

test("settings changes map to one event each, with enums and counts only", () => {
  const ev = sitePatchEvents({
    name: "Acme Docs",
    slug: "acme",
    settings: {
      ai: { enabled: false, name: "Acme bot", suggestions: ["How do I reset my secret?", "Quickstart?"] },
      access: { level: "password", password: "hunter2-secret" },
      seo: { index: false },
      review: { required: true },
      redirects: [{ from: "/a", to: "/b" }],
    },
  });
  assert.deepEqual(ev.map(([n]) => n), [
    "guide_renamed", "guide_address_changed", "guide_ask_ai_toggled", "guide_ask_ai_renamed", "guide_ask_ai_questions",
    "guide_access_changed", "guide_indexing_changed", "guide_reviews_required", "guide_redirects_saved",
  ]);
  assert.deepEqual(Object.fromEntries(ev), {
    guide_renamed: {}, guide_address_changed: {}, guide_ask_ai_toggled: { enabled: false }, guide_ask_ai_renamed: {},
    guide_ask_ai_questions: { n: 2 }, guide_access_changed: { access: "password" }, guide_indexing_changed: { enabled: false },
    guide_reviews_required: { enabled: true }, guide_redirects_saved: { n: 1 },
  });
  noContent(ev);
});

test("event names and props fit the beat API (snake_case, ≤ 40 chars, ≤ 8 flat props)", () => {
  const all = [
    ...createdEvents({ workspace_id: "w", source: { kind: "gitbook" } }),
    ...sitePatchEvents({ name: "x", slug: "y", settings: { theme: { preset: "clean", mode: "both", brand: { enabled: false }, custom_css: "" }, ai: { enabled: true, name: null, suggestions: [] }, access: { level: "members" }, seo: { index: true }, review: { required: false }, redirects: [] } }),
  ];
  for (const [name, props] of all) {
    assert.match(name, /^[a-z][a-z0-9_]{0,39}$/);
    assert.ok(Object.keys(props).length <= 8);
    for (const [k, v] of Object.entries(props)) {
      assert.match(k, /^[a-z][a-z0-9_]{0,39}$/);
      assert.ok(["string", "number", "boolean"].includes(typeof v));
    }
  }
});
