import test from "node:test";
import assert from "node:assert/strict";
import { pageRefs } from "./pageRefs.mjs";
import { embedSlug, embedMode, assetId, webEmbedUrl, lockedOf, LOCKED, refreshDelay, pagePath, fillTemplate, appendMarkdown } from "./pageBlocks.mjs";

test("embedSlug: bare slugs and Markdrop links", () => {
  assert.equal(embedSlug("q3-plan"), "q3-plan");
  assert.equal(embedSlug(" q3_plan "), "q3_plan");
  assert.equal(embedSlug("https://markdrop.in/q3-plan"), "q3-plan");
  assert.equal(embedSlug("https://markdrop.in/"), null);
  assert.equal(embedSlug("http://markdrop.in/x"), null);
  assert.equal(embedSlug("https://evil.example/x"), null);
  assert.equal(embedSlug("https://docs.acme.com/guides/x", ["docs.acme.com"]), "x");
  assert.equal(embedSlug("../etc"), null);
  assert.equal(embedSlug(""), null);
  assert.equal(embedSlug(null), null);
});

test("embedMode defaults to live", () => {
  assert.equal(embedMode("card"), "card");
  assert.equal(embedMode("preview"), "preview");
  assert.equal(embedMode("full"), "live");
  assert.equal(embedMode(undefined), "live");
});

test("webEmbedUrl allows known providers only, as their embed links", () => {
  assert.equal(webEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  assert.equal(webEmbedUrl("https://youtu.be/dQw4w9WgXcQ?t=3"), "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  assert.equal(webEmbedUrl("https://vimeo.com/123456789"), "https://player.vimeo.com/video/123456789");
  assert.equal(webEmbedUrl("https://www.loom.com/share/0123456789abcdef0123456789abcdef"), "https://www.loom.com/embed/0123456789abcdef0123456789abcdef");
  assert.match(webEmbedUrl("https://www.figma.com/design/abc/Thing"), /^https:\/\/www\.figma\.com\/embed\?embed_host=markdrop&url=/);
  assert.equal(webEmbedUrl("https://codepen.io/ada/pen/xyz"), "https://codepen.io/ada/embed/xyz?default-tab=result");
  assert.equal(webEmbedUrl("https://evil.example/embed"), null);
  assert.equal(webEmbedUrl("http://www.youtube.com/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(webEmbedUrl("javascript:alert(1)"), null);
});

test("assetId reads asset: addresses only", () => {
  assert.equal(assetId("asset:abc123"), "abc123");
  assert.equal(assetId("asset:../x"), null);
  assert.equal(assetId("https://x/asset:abc"), null);
});

test("pageRefs finds embeds, mentions and page images, not code", () => {
  const md = [
    "# Plan",
    "",
    "See :markdrop[the deck]{src=deck-1} and :markdrop[x]{src=https://markdrop.in/deck-2}.",
    "",
    "::markdrop{src=pricing mode=card}",
    "",
    "::markdrop{src=pricing}",
    "",
    "![Shot](asset:img1)",
    "",
    "```",
    "::markdrop{src=in-code}",
    "```",
    "",
    ":::note",
    "![Inside](asset:img2) and :markdrop[y]{src=deck-1}",
    ":::",
  ].join("\n");
  const r = pageRefs(md);
  assert.deepEqual(r.embeds, ["pricing"]);
  assert.deepEqual(r.mentions, ["deck-1", "deck-2"]);
  assert.deepEqual(r.slugs, ["pricing", "deck-1", "deck-2"]);
  assert.deepEqual(r.assets, ["img1", "img2"]);
});

test("pageRefs: a page with nothing to find isn't parsed, and the same text isn't read twice", () => {
  // A long page with no reference: answered without the Markdown parser (well under the time a parse
  // of 300 blocks takes), every time.
  const plain = Array.from({ length: 300 }, (_, i) => (i % 10 ? `Paragraph ${i} with some words in it.` : `## Section ${i}`)).join("\n\n");
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) assert.deepEqual(pageRefs(plain + " ".repeat(i)), { slugs: [], embeds: [], mentions: [], assets: [] });
  assert.ok(performance.now() - t0 < 200, "50 reads of a 300-block page without references");
  // The same text twice: the same answer object (the renderer and the image links share it).
  const md = `${plain}\n\n::page{src=kid}\n\n![a](asset:a1)`;
  const a = pageRefs(md);
  assert.equal(pageRefs(md), a);
  assert.deepEqual(a.embeds, ["kid"]);
  assert.deepEqual(a.assets, ["a1"]);
  // Each kind of reference still gets through the quick check.
  assert.deepEqual(pageRefs("::page{src=p1}").embeds, ["p1"]);
  assert.deepEqual(pageRefs(":markdrop[x]{src=m1}").mentions, ["m1"]);
  assert.deepEqual(pageRefs("::markdrop{src=https://markdrop.in/e1}").embeds, ["e1"]);
  assert.deepEqual(pageRefs("![x](asset:i1)").assets, ["i1"]);
  assert.deepEqual(pageRefs("").slugs, []);
});

test("locked placeholders never name the item", () => {
  for (const s of ["signin", "denied", "password", "encrypted", "missing"]) {
    const l = lockedOf(s);
    assert.ok(l.title && l.body);
  }
  assert.equal(lockedOf("weird"), LOCKED.missing);
  assert.equal(lockedOf("password").title, "Password-protected — open it");
});

test("refreshDelay: before the soonest expiry, never below 5 s", () => {
  const now = Date.parse("2026-11-03T10:00:00Z");
  assert.equal(refreshDelay({ a: { expires_at: "2026-11-03T10:10:00Z" }, b: { expires_at: "2026-11-03T10:05:00Z" } }, now), 4 * 60_000);
  assert.equal(refreshDelay({ a: { expires_at: "2026-11-03T10:00:10Z" } }, now), 5_000);
  assert.equal(refreshDelay({ a: { state: "ok" } }, now), null);
  assert.equal(refreshDelay(null, now), null);
});

test("pagePath: slug on markdrop.in, folders and ancestors on a custom domain", () => {
  assert.equal(pagePath("child"), "/child");
  assert.equal(pagePath("child", { tenant: true, folderPath: ["guides"], ancestors: ["parent"] }), "/guides/parent/child");
  assert.equal(pagePath("a b", { tenant: true }), "/a%20b");
});

test("fillTemplate fills title and date", () => {
  assert.equal(fillTemplate("# {{title}}\n{{ date }}", { title: "Sync", date: new Date("2026-11-03T12:00:00Z") }), "# Sync\n2026-11-03");
});

test("appendMarkdown joins with one blank line", () => {
  assert.equal(appendMarkdown("# A\n\nText\n", "- [ ] item\n"), "# A\n\nText\n\n- [ ] item\n");
  assert.equal(appendMarkdown("", "x"), "x\n");
  assert.equal(appendMarkdown("a\n", "  "), "a\n");
});
