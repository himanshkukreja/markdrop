import { test } from "node:test";
import assert from "node:assert/strict";
import { initialScope, isAssistantKey, meetingOptions, periodRange, scopeBody, scopeChips, starters, stageLabel, threadTurns, toCitation } from "./assistantCore.mjs";

const link = (x) => ({ href: x.url && x.url.startsWith("/") ? x.url : `/${x.slug ?? ""}`, external: false });
const ctx = {
  scopes: [{ kind: "doc", label: "This doc", sub: "PRD" }, { kind: "meetings", label: "Meetings", sub: null },
    { kind: "workspace", label: "Workspace", sub: "Acme" }, { kind: "everything", label: "Everything", sub: null }],
  default: "doc", page: { slug: "prd", title: "PRD", editor: "blocks" }, workspace: { id: "w1", name: "Acme" },
  folder: null, meeting: { id: "m1", title: "Standup" }, series: ["Daily Standup"], can_insert: true,
  status: { search: { enabled: true, reason: null, message: null }, meetings: null },
};

test("periods are local, inclusive days", () => {
  const wed = new Date(2026, 10, 4); // Wed 4 Nov 2026
  assert.deepEqual(periodRange("week", wed), { since: "2026-11-02", until: "2026-11-04" });
  assert.deepEqual(periodRange("7d", wed), { since: "2026-10-29", until: "2026-11-04" });
  assert.deepEqual(periodRange("month", wed), { since: "2026-11-01", until: "2026-11-04" });
  assert.deepEqual(periodRange("last-month", wed), { since: "2026-10-01", until: "2026-10-31" });
  assert.deepEqual(periodRange("", wed), {});
  assert.deepEqual(periodRange("week", new Date(2026, 10, 8)), { since: "2026-11-02", until: "2026-11-08" }); // Sunday
});

test("scopes come from the server; the wanted one wins when offered", () => {
  assert.deepEqual(scopeChips(ctx).map((s) => s.kind), ["doc", "meetings", "workspace", "everything"]);
  assert.equal(initialScope(ctx), "doc");
  assert.equal(initialScope(ctx, "meetings"), "meetings");
  assert.equal(initialScope(ctx, "folder"), "doc");
  assert.equal(initialScope(null), "everything");
});

test("scope bodies", () => {
  const day = new Date(2026, 10, 4);
  assert.deepEqual(scopeBody("doc", ctx), { kind: "doc", page: "prd" });
  assert.deepEqual(scopeBody("workspace", ctx), { kind: "workspace", workspace: "w1" });
  assert.deepEqual(scopeBody("meetings", ctx, {}), { kind: "meetings", workspace: "w1" });
  assert.deepEqual(scopeBody("meetings", ctx, { meeting: "this", series: "Daily Standup" }), { kind: "meetings", workspace: "w1", meeting: "m1" });
  assert.deepEqual(scopeBody("meetings", ctx, { series: "Daily Standup", period: "7d" }, day),
    { kind: "meetings", workspace: "w1", series: "Daily Standup", since: "2026-10-29", until: "2026-11-04" });
  assert.deepEqual(scopeBody("folder", ctx), { kind: "everything" });
  assert.deepEqual(scopeBody("doc", null), { kind: "everything" });
});

test("meetings chips: this meeting, series, period", () => {
  const opts = meetingOptions(ctx);
  assert.deepEqual(opts.map((o) => o.id), ["meeting", "series", "period"]);
  assert.equal(opts[0].choices[1].label, "This meeting · Standup");
  assert.deepEqual(meetingOptions({ ...ctx, meeting: null, series: [] }).map((o) => o.id), ["period"]);
});

test("citations: moments jump, meetings and pages open", () => {
  const m = toCitation({ label: "M2-s14", key: "d:1", title: "Standup", url: "/t#b-t0014", kind: "page", moment: "Bo · 0:53",
    quote: "We ship Friday", subtitle: "Nov 2, 2026 · Daily Standup", source_kind: "moment" }, link);
  assert.deepEqual(m, { token: "M2-s14", title: "Standup", subtitle: "Nov 2, 2026 · Daily Standup", meta: "Bo · 0:53", quote: "We ship Friday",
    href: "/t#b-t0014", external: false, icon: "mic", action: "Jump to moment" });
  const p = toCitation({ label: "1", key: "d:2", title: "PRD", url: "/prd", kind: "page", source_kind: "this page" }, link);
  assert.equal(p.meta, "This doc");
  assert.equal(p.icon, "lines");
  assert.equal(p.action, "Open");
});

test("saved turns keep their scope; withheld ones stay hidden", () => {
  const t = threadTurns([{ question: "q", answer: "a [1]", intent: "page", citations: [{ label: "1", key: "d:1", title: "x", url: "/x", kind: "doc" }], scope: { kind: "doc", label: "This doc · PRD" } },
    { question: "q2", answer: null, intent: "ask", citations: [], withheld: true }], link);
  assert.equal(t[0].scopeNote, "This doc · PRD");
  assert.equal(t[0].citations[0].token, "1");
  assert.equal(t[1].state, "withheld");
});

test("starters and stages per scope", () => {
  assert.equal(starters("doc", ctx)[0].q, "Summarize this doc");
  assert.equal(starters("meetings", ctx)[0].q, "What was decided?");
  assert.deepEqual(starters("everything", ctx, [{ q: "Home one" }]), [{ q: "Home one" }]);
  assert.equal(stageLabel("searching", "meetings"), "Finding the meetings…");
  assert.equal(stageLabel("nope", "doc"), "Thinking…");
});

test("⌘J / Ctrl+J, unless something handled it", () => {
  assert.equal(isAssistantKey({ key: "j", metaKey: true }), true);
  assert.equal(isAssistantKey({ key: "J", ctrlKey: true }), true);
  assert.equal(isAssistantKey({ key: "j", metaKey: true, defaultPrevented: true }), false);
  assert.equal(isAssistantKey({ key: "j", metaKey: true, shiftKey: true }), false);
  assert.equal(isAssistantKey({ key: "j" }), false);
  assert.equal(isAssistantKey({ key: "k", metaKey: true }), false);
});
