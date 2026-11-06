// The one-tap notification prompts' rules (lib/pushPrompt.ts). Run: node --test src/lib/pushPrompt.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { PUSH_PROMPT_KEYS, pushPromptState, readPromptDismissed, wantsBellNudge, writePromptDismissed } from "./pushPrompt.ts";

const base = { support: "ok", perm: "default", configured: true, subscribed: false, dismissed: false };

test("pushPromptState: shown only when a click can turn push on here", () => {
  assert.equal(pushPromptState(base), "show");
  // Already granted but this device isn't on the account (a 410'd subscription, another account's): offer it.
  assert.equal(pushPromptState({ ...base, perm: "granted" }), "show");
  assert.equal(pushPromptState({ ...base, subscribed: true }), "subscribed");
  assert.equal(pushPromptState({ ...base, perm: "granted", subscribed: true }), "subscribed");
  assert.equal(pushPromptState({ ...base, perm: "denied" }), "denied");
  assert.equal(pushPromptState({ ...base, configured: false }), "unconfigured");
  for (const support of ["ios-install", "unsupported", "off"]) {
    assert.equal(pushPromptState({ ...base, support }), "unsupported", support);
  }
  assert.equal(pushPromptState({ ...base, perm: "unsupported" }), "unsupported");
});

test("pushPromptState: Not now wins over everything", () => {
  assert.equal(pushPromptState({ ...base, dismissed: true }), "dismissed");
  assert.equal(pushPromptState({ ...base, dismissed: true, perm: "denied" }), "dismissed");
});

test("wantsBellNudge: a mention or a sign-off request, not shares or access requests alone", () => {
  assert.equal(wantsBellNudge([]), false);
  assert.equal(wantsBellNudge(["shared", "access_request"]), false);
  assert.equal(wantsBellNudge(["shared", "mention"]), true);
  assert.equal(wantsBellNudge(["signoff_requested"]), true);
  assert.equal(wantsBellNudge(["signoff_done"]), false);
});

function memory() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}

test("dismissal: per device and per prompt; storage that throws reads as not dismissed", () => {
  const s = memory();
  assert.equal(readPromptDismissed(s, "home"), false);
  writePromptDismissed(s, "home", 1234);
  assert.equal(readPromptDismissed(s, "home"), true);
  assert.equal(readPromptDismissed(s, "bell"), false);
  assert.equal(s.m.get(PUSH_PROMPT_KEYS.home), "1234");
  writePromptDismissed(s, "bell");
  assert.equal(readPromptDismissed(s, "bell"), true);
  assert.notEqual(PUSH_PROMPT_KEYS.home, PUSH_PROMPT_KEYS.bell);

  const broken = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceededError"); } };
  assert.equal(readPromptDismissed(broken, "home"), false);
  assert.doesNotThrow(() => writePromptDismissed(broken, "home"));
  assert.equal(readPromptDismissed(null, "home"), false);
  assert.doesNotThrow(() => writePromptDismissed(undefined, "bell"));
});
