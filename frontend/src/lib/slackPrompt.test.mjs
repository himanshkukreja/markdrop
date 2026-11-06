// The bell's Slack nudge rules (lib/slackPrompt.ts). Run: node --test src/lib/slackPrompt.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { SLACK_PROMPT_KEY, readSlackPromptDismissed, slackPromptState, writeSlackPromptDismissed } from "./slackPrompt.ts";

const base = { configured: true, teams: 1, on: false, dismissed: false, pushSettled: true, pushShowing: false };

test("slackPromptState: shown when a workspace of yours has Slack and you haven't turned it on", () => {
  assert.equal(slackPromptState(base), "show");
  assert.equal(slackPromptState({ ...base, on: true }), "on");
  assert.equal(slackPromptState({ ...base, teams: 0 }), "no-slack");
  assert.equal(slackPromptState({ ...base, configured: false }), "unconfigured");
});

test("slackPromptState: one nudge at a time (push first), and never before push has decided", () => {
  assert.equal(slackPromptState({ ...base, pushShowing: true }), "push-first");
  assert.equal(slackPromptState({ ...base, pushSettled: false }), "wait");
  // Push dismissed or not offered on this device: Slack's turn.
  assert.equal(slackPromptState({ ...base, pushSettled: true, pushShowing: false }), "show");
});

test("slackPromptState: Not now wins", () => {
  assert.equal(slackPromptState({ ...base, dismissed: true }), "dismissed");
  assert.equal(slackPromptState({ ...base, dismissed: true, pushShowing: true }), "dismissed");
});

test("dismissed: remembered per device; storage that throws reads as not dismissed", () => {
  const mem = new Map();
  const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(readSlackPromptDismissed(store), false);
  writeSlackPromptDismissed(store, 5);
  assert.equal(mem.get(SLACK_PROMPT_KEY), "5");
  assert.equal(readSlackPromptDismissed(store), true);
  const broken = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); } };
  assert.equal(readSlackPromptDismissed(broken), false);
  writeSlackPromptDismissed(broken);
  assert.equal(readSlackPromptDismissed(null), false);
});
