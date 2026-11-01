/**
 * Private pages in the studio: how rules read and what the people box holds (privateModel.ts).
 * Runs on node's TypeScript type stripping (node ≥ 22.18); skipped without it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

let mod = null;
try {
  mod = await import("./privateModel.ts");
} catch (e) {
  if (!/Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION|strip/i.test(String(e?.message ?? e))) throw e;
}

test("rules read the way readers and admins say them", { skip: !mod }, () => {
  const { ruleLabel, ruleWho } = mod;
  assert.equal(ruleLabel({ kind: "members", name: "anything" }), "Team members");
  assert.equal(ruleLabel({ kind: "password", name: "Partners" }), "Partners (password)");
  assert.equal(ruleLabel({ kind: "people", name: "Northwind" }), "Northwind");
  assert.equal(ruleWho({ kind: "people", name: "N", domains_count: 1, domains: ["northwind.com"], emails_count: 2 }), "Anyone at @northwind.com and 2 people, signing in with their email.");
  assert.equal(ruleWho({ kind: "people", name: "N", domains_count: 2, emails_count: 1 }), "Anyone at 2 domains and 1 person, signing in with their email.");
  assert.equal(ruleWho({ kind: "people", name: "N" }), "Nobody yet: add people or a domain.");
  assert.equal(ruleWho({ kind: "password", name: "P", has_password: true }), "Anyone with the password.");
  assert.match(ruleWho({ kind: "members", name: "" }), /every other private page/);
});

test("one box takes emails and domains, any separator, once each", { skip: !mod }, () => {
  const { splitPeople } = mod;
  assert.deepEqual(splitPeople("@Northwind.com, jane@partner.io\njane@partner.io; contoso.com  "), { emails: ["jane@partner.io"], domains: ["northwind.com", "contoso.com"] });
  assert.deepEqual(splitPeople("   "), { emails: [], domains: [] });
});
