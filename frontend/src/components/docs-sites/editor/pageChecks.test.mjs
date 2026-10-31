/**
 * The editor's page checks (pageChecks.ts): links to missing or unpublished pages, images without a
 * description, empty and duplicate headings, long pages, the outline and the word count.
 * Runs on node's TypeScript type stripping (node ≥ 22.18); skipped without it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

let mod = null;
try {
  mod = await import("./pageChecks.ts");
} catch (e) {
  if (!/Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION|strip/i.test(String(e))) throw e;
}
const skip = mod ? false : "needs node with TypeScript type stripping";

const pages = [
  { id: "1", path: "/", title: "Welcome", published: true },
  { id: "2", path: "/getting-started/quickstart", title: "Quickstart", published: true },
  { id: "3", path: "/getting-started/payment-methods", title: "Payment methods", published: false },
];
const ctx = { path: "/getting-started/quickstart", pages, redirects: ["/old"], reserved: (s) => ["docs-assets", "api-reference"].includes(s) };

test("which links point at a page, and where", { skip }, () => {
  const { linkPath } = mod;
  assert.equal(linkPath("https://example.com/a", "/x"), null);
  assert.equal(linkPath("mailto:a@b.c", "/x"), null);
  assert.equal(linkPath("#pay", "/x"), null);
  assert.equal(linkPath("/docs-assets/a.png", "/x", ctx.reserved), null);
  assert.equal(linkPath("/files/guide.pdf", "/x"), null);
  assert.equal(linkPath("/a/b/#c", "/x"), "/a/b");
  assert.equal(linkPath("/a/b.md?x=1", "/x"), "/a/b");
  assert.equal(linkPath("payment-methods", "/getting-started/quickstart"), "/getting-started/payment-methods");
  assert.equal(linkPath("../orders", "/getting-started/quickstart"), "/orders");
  assert.equal(linkPath("/", "/x"), "/");
});

test("link problems: missing, not live yet, redirected, fine", { skip }, () => {
  const { linkProblem } = mod;
  assert.equal(linkProblem("/getting-started/missing", ctx).kind, "missing");
  const p = linkProblem("payment-methods", ctx);
  assert.equal(p.kind, "unpublished");
  assert.match(p.message, /Payment methods/);
  assert.equal(linkProblem("/old", ctx), null);
  assert.equal(linkProblem("/", ctx), null);
  assert.equal(linkProblem("https://x.y", ctx), null);
});

test("the checks and the looks-good row", { skip }, () => {
  const { scanPage, pageChecks } = mod;
  const body = [
    "Intro with [payments](payment-methods) and [nowhere](/nope) and [home](/).",
    "",
    "## Pay",
    "",
    "![](/docs-assets/a.png)",
    "",
    "## Pay",
    "",
    "##",
    "",
    "```md",
    "[inside code](/not-checked)",
    "## Not a heading",
    "```",
  ].join("\n");
  const checks = pageChecks(scanPage(body), ctx);
  const kinds = checks.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ["heading_duplicate", "heading_empty", "image_alt", "link_missing", "link_unpublished"]);
  const missing = checks.find((c) => c.kind === "link_missing");
  assert.deepEqual(missing.fix, { kind: "create_page", path: "/nope", title: "Nowhere" });
  assert.deepEqual(checks.find((c) => c.kind === "image_alt").fix, { kind: "image_alt", src: "/docs-assets/a.png" });
  const dup = checks.find((c) => c.kind === "heading_duplicate");
  assert.deepEqual(dup.target, { kind: "heading", text: "Pay", nth: 1 });

  const ok = pageChecks(scanPage("## One\n\nSee [home](/).\n"), ctx);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].kind, "ok");
  assert.equal(ok[0].note, "1 heading, 1 link checked.");
});

test("long pages, words and minutes", { skip }, () => {
  const { scanPage, pageChecks, readMinutes, LONG_PAGE_WORDS } = mod;
  const s = scanPage("Hello **there**, [a link](https://x.y) and `code`.\n\n```\nnot counted at all\n```\n");
  assert.equal(s.words, 6);
  assert.equal(readMinutes(0), 0);
  assert.equal(readMinutes(10), 1);
  assert.equal(readMinutes(920), 4);
  const long = scanPage(Array.from({ length: LONG_PAGE_WORDS + 5 }, () => "word").join(" "));
  assert.ok(pageChecks(long, ctx).some((c) => c.kind === "page_long"));
});

test("the outline: h2 and h3 outside containers, with which one of the same text it is", { skip }, () => {
  const { scanPage, outlineOf } = mod;
  const body = "# Title\n\n## Pay {#pay-now}\n\n### Cards\n\n::::steps\n## Step one\n::::\n\n## Track `orders`\n\n#### Deep\n\n### Cards\n";
  const out = outlineOf(scanPage(body));
  assert.deepEqual(out.map((o) => [o.level, o.text, o.nth]), [[2, "Pay", 0], [3, "Cards", 0], [2, "Track orders", 0], [3, "Cards", 1]]);
  assert.equal(out[0].slug, "pay-now");
  assert.equal(out[2].slug, "track-orders");
});
