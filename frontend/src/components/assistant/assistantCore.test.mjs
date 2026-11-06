import { test } from "node:test";
import assert from "node:assert/strict";
import { askPlaceholder, askTitle, chipKey, initialScope, scopeWorkspace, insertAfterSection, insertAtCaret, isAssistantKey, meetingOptions, periodRange, scopeBody, scopeChips, starters, stageLabel, threadTurns, toCitation } from "./assistantCore.mjs";

const link = (x) => ({ href: x.url && x.url.startsWith("/") ? x.url : `/${x.slug ?? ""}`, external: false });
const ctx = {
  scopes: [{ kind: "doc", label: "This doc", sub: "PRD" }, { kind: "meetings", label: "Meetings", sub: null },
    { kind: "workspace", label: "Workspace", sub: "Acme" }, { kind: "mine", label: "My files", sub: null }, { kind: "everything", label: "Everything", sub: null }],
  workspaces: [{ id: "w2", name: "Beta" }, { id: "w1", name: "Acme" }],
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
  // A chip per workspace, named after it, the current one first.
  assert.deepEqual(scopeChips(ctx).map((s) => s.key), ["doc", "meetings", "workspace:w1", "workspace:w2", "mine", "everything"]);
  assert.deepEqual(scopeChips(ctx).map((s) => s.label), ["This page", "Meetings", "Acme", "Beta", "My files", "Everything"]);
  // Outside any workspace (a page of your own): every workspace before My files.
  const own = { ...ctx, scopes: [ctx.scopes[0], ctx.scopes[3], ctx.scopes[4]], workspace: null };
  assert.deepEqual(scopeChips(own).map((s) => s.key), ["doc", "workspace:w2", "workspace:w1", "mine", "everything"]);
  assert.equal(chipKey({ kind: "workspace" }, ctx), "workspace:w1");
  assert.equal(chipKey({ kind: "workspace", workspace: "w2" }, ctx), "workspace:w2");
  assert.equal(chipKey({ kind: "mine" }, ctx), "mine");
  assert.equal(initialScope(ctx), "doc");
  assert.equal(initialScope(ctx, "meetings"), "meetings");
  assert.equal(initialScope(ctx, "folder"), "doc");
  assert.equal(initialScope(null), "everything");
});

test("scope bodies", () => {
  const day = new Date(2026, 10, 4);
  assert.deepEqual(scopeBody("doc", ctx), { kind: "doc", page: "prd" });
  assert.deepEqual(scopeBody("workspace", ctx), { kind: "workspace", workspace: "w1" });
  assert.deepEqual(scopeBody("workspace", ctx, { workspace: "w2" }), { kind: "workspace", workspace: "w2" });
  assert.deepEqual(scopeBody("workspace", null, { workspace: "w2" }), { kind: "workspace", workspace: "w2" });
  assert.deepEqual(scopeBody("mine", null), { kind: "mine" });
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
  assert.equal(p.meta, "This page");
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

test("the name follows the scope", () => {
  assert.equal(askTitle("everything"), "Ask");
  assert.equal(askTitle("workspace", "Senseloaf"), "Ask Senseloaf");
  assert.equal(askTitle("meetings", "Senseloaf"), "Ask Senseloaf");
  assert.equal(askTitle("workspace", null), "Ask");
  assert.equal(askTitle("mine"), "Ask my files");
  assert.equal(askTitle("doc", "Senseloaf"), "Ask this page");
  assert.equal(askPlaceholder("workspace", "Senseloaf"), "Ask anything about Senseloaf…");
  assert.equal(askPlaceholder("everything"), "Ask anything…");
  assert.deepEqual(scopeWorkspace({ kind: "workspace", workspace: "w2" }, ctx), { id: "w2", name: "Beta" });
  assert.deepEqual(scopeWorkspace({ kind: "meetings" }, ctx), { id: "w1", name: "Acme" });
  assert.equal(scopeWorkspace({ kind: "mine" }, ctx), null);
});

test("starters and stages per scope", () => {
  assert.equal(starters("doc", ctx)[0].q, "Summarize this page");
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

test("classic docs: insert after the reader's section, or at the end", () => {
  const md = "# Title\n\nIntro.\n\n## Payments\n\nHosted page.\n\n```\n## not a heading\n```\n\n### Detail\n\nMore.\n\n## Rollout\n\nLater.\n";
  const out = insertAfterSection(md, "Payments", "Decided on Oct 28 [[1]](/m).");
  assert.ok(out.includes("More.\n\nDecided on Oct 28 [[1]](/m).\n\n## Rollout"), out);
  assert.ok(insertAfterSection(md, null, "X").endsWith("Later.\n\nX\n"));
  assert.ok(insertAfterSection(md, "Rollout", "X").endsWith("Later.\n\nX\n"));
  assert.equal(insertAfterSection("", null, "X"), "X\n");
});

test("classic editor: insert at the caret on its own paragraph", () => {
  const r = insertAtCaret("one\ntwo\n\nthree", 2, "NEW");
  assert.equal(r.value, "one\n\nNEW\n\ntwo\n\nthree");
  assert.equal(r.value.slice(0, r.caret), "one\n\nNEW");
  assert.equal(insertAtCaret("", 0, "NEW").value, "NEW\n");
  assert.equal(insertAtCaret("end", 3, "NEW").value, "end\n\nNEW\n");
});
