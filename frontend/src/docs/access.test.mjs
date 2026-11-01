import { test } from "node:test";
import assert from "node:assert/strict";
import { accessValue, effectiveRule, hasPrivate, parseVariant, readAccess, ruleOf, ruleSets, splitPrivate } from "./access.mjs";

const PAGE = `Intro for everyone.

:::private[SSO certificate]{access="northwind"}
## Rotate the certificate

The secret value is \`nw-cert-7731\`.

\`\`\`bash
:::
echo still-inside-the-fence
\`\`\`
:::

## Public heading

:::note
A public note.
:::

::::private{access="members"}
:::warning
Team-only warning text.
:::
::::

Tail.`;

test("hidden sections leave nothing but a placeholder", () => {
  const { body, rules, hidden } = splitPrivate(PAGE, null);
  assert.deepEqual(rules, ["northwind", "members"]);
  assert.equal(hidden, 2);
  for (const secret of ["nw-cert-7731", "Rotate the certificate", "still-inside-the-fence", "Team-only warning text"]) assert.ok(!body.includes(secret), secret);
  assert.match(body, /::private-locked\[SSO certificate\]\{access="northwind"\}/);
  assert.match(body, /::private-locked\{access="members"\}/);
  for (const kept of ["Intro for everyone.", "## Public heading", "A public note.", "Tail."]) assert.ok(body.includes(kept), kept);
});

test("revealed sections keep their text and carry the render key", () => {
  const { body } = splitPrivate(PAGE, new Set(["northwind"]), "K123");
  assert.ok(body.includes("nw-cert-7731"));
  assert.ok(body.includes("echo still-inside-the-fence"));
  assert.match(body, /:::private\[SSO certificate\]\{access="northwind" k="K123"\}/);
  assert.ok(!body.includes("Team-only warning text"));
});

test("unclosed sections are hidden to the end; quotes and list items are followed", () => {
  const { body } = splitPrivate("a\n:::private\nsecret\nmore secret", null);
  assert.equal(body, 'a\n::private-locked{access="members"}');
  const q = splitPrivate("> :::private{access=acme}\n> quoted secret\n> :::\nafter", null);
  assert.ok(!q.body.includes("quoted secret"));
  assert.match(q.body, /^> ::private-locked\{access="acme"\}/);
  const l = splitPrivate("- :::private\n  list secret\n  :::\n- next", null);
  assert.ok(!l.body.includes("list secret"));
  assert.ok(l.body.includes("- next"));
});

test("code blocks are never read as sections", () => {
  const src = "```md\n:::private\nshown as code\n:::\n```";
  assert.equal(splitPrivate(src, null).body, src);
  assert.equal(hasPrivate("plain"), false);
});

test("rule values, inheritance and the site's rules", () => {
  assert.equal(accessValue("Public"), "public");
  assert.equal(accessValue(""), undefined);
  assert.equal(accessValue("inherit"), undefined);
  assert.equal(accessValue("../x"), "invalid");
  assert.equal(effectiveRule(undefined, "northwind"), "northwind");
  assert.equal(effectiveRule("public", "northwind"), undefined);
  assert.equal(effectiveRule("partners", "northwind"), "partners");
  const a = readAccess({ access: { rules: { northwind: { kind: "people", name: "Northwind", nav: "show" }, bad: { kind: "nope" }, UP: { kind: "members" } } } });
  assert.equal(a.rules.get("northwind").kind, "people");
  assert.ok(a.rules.has("members"));
  assert.ok(!a.rules.has("bad") && !a.rules.has("UP"));
  assert.equal(ruleOf(a, "gone").kind, "unknown");
});

test("variants: every combination, sorted, at most three rules", () => {
  assert.deepEqual(ruleSets(["b", "a"]), [["a"], ["b"], ["a", "b"]]);
  assert.equal(ruleSets(["a", "b", "c", "d"]).length, 7);
  assert.deepEqual(parseVariant(["x-access", "a.b", "guides", "x"]), { rules: ["a", "b"], path: "/guides/x" });
  assert.equal(parseVariant(["guides", "x"]), null);
  assert.equal(parseVariant(["x-access", "A!", "x"]), null);
});
