/** lib/signoff.mjs: options, attributes and the decision's colour (the backend's rules). */
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_OPTIONS, joinOptions, parseOptions, signoffInfo, tone } from "./signoff.mjs";

test("options: trimmed, unique, at most 6; defaults when none", () => {
  assert.deepEqual(parseOptions(" Approved for production | Not approved |  | Approved for production"), ["Approved for production", "Not approved"]);
  assert.deepEqual(parseOptions(""), DEFAULT_OPTIONS);
  assert.deepEqual(parseOptions(undefined), DEFAULT_OPTIONS);
  assert.equal(parseOptions("a|b|c|d|e|f|g|h").length, 6);
  assert.equal(parseOptions("x".repeat(200))[0].length, 80);
  assert.equal(joinOptions(["Yes", 'A "quoted" one', "B|C", "", "Yes"]), "Yes|A ”quoted” one|B C");
});

test("attributes: id only when it is a block anchor; label default", () => {
  assert.deepEqual(signoffInfo({ id: "b-k3x9a1", person: " u1 ", label: "Release  approval", options: "A|B", lock: "above" }), {
    id: "b-k3x9a1", person: "u1", label: "Release approval", options: ["A", "B"], lock: true,
  });
  const bare = signoffInfo({ id: "Nope", option: "Approved" });
  assert.equal(bare.id, null);
  assert.equal(bare.label, "Sign-off");
  assert.equal(bare.lock, false);
  assert.equal(bare.person, null);
});

test("tone matches the server", () => {
  const opts = ["Approved for production", "Approved with notes", "Not approved"];
  assert.equal(tone("Approved for production", opts), "success");
  assert.equal(tone("Approved with notes", opts), "warning");
  assert.equal(tone("Not approved", opts), "danger");
  assert.equal(tone("Rejected", ["Ship", "Rejected"]), "danger");
  assert.equal(tone("Purple", ["Red", "Purple"]), "neutral");
  assert.equal(tone(null, opts), null);
});
