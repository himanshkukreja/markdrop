/**
 * Paste rules without a DOM (menus/paste.ts): a pasted link on its own and what it can become,
 * which part of the clipboard to read, Markdown from other tools, styles as marks, code languages.
 * The HTML normaliser needs a DOM and is covered by the Playwright pass.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { bareUrl, markdropSlug, pasteTargets, pickSource, pasteMarkdown, styleMarks, codeLanguage } from "../menus/paste.ts";
import { parseBlocks } from "../core/markdown.mjs";

test("a link on its own is a bare URL; anything more isn't", () => {
  assert.equal(bareUrl("https://example.com/a?b=1#c"), "https://example.com/a?b=1#c");
  assert.equal(bareUrl("  https://example.com/x \n"), "https://example.com/x");
  assert.equal(bareUrl("http://localhost:3130/q3-plan"), "http://localhost:3130/q3-plan");
  assert.equal(bareUrl("see https://example.com"), null);
  assert.equal(bareUrl("https://a.com https://b.com"), null);
  assert.equal(bareUrl("ftp://example.com/file"), null);
  assert.equal(bareUrl("javascript:alert(1)"), null);
  assert.equal(bareUrl("example.com"), null);
  assert.equal(bareUrl(""), null);
  // The HTML is the address, or one link to it.
  assert.equal(bareUrl("https://example.com/", '<meta charset="utf-8"><a href="https://example.com/">https://example.com/</a>'), "https://example.com/");
  assert.equal(bareUrl("https://example.com/", '<a href="https://example.com/">Example Domain</a>'), "https://example.com/");
  assert.equal(bareUrl("https://e.com/?a=1&b=2", '<a href="https://e.com/?a=1&amp;b=2">x</a>'), "https://e.com/?a=1&b=2");
  assert.equal(bareUrl("https://example.com/", "<p>https://example.com/</p>"), "https://example.com/");
  // Rich HTML with that text isn't a bare link.
  assert.equal(bareUrl("https://example.com/", '<h1><a href="https://example.com/">x</a></h1><ul><li>y</li></ul>'), null);
  assert.equal(bareUrl("https://example.com/", '<a href="https://other.com/">https://example.com/</a> and more'), null);
});

test("Markdrop items: markdrop.in/<slug> and this app's own origin, not app routes", () => {
  assert.equal(markdropSlug("https://markdrop.in/q3-plan"), "q3-plan");
  assert.equal(markdropSlug("https://www.markdrop.in/q3-plan?x=1#h"), "q3-plan");
  assert.equal(markdropSlug("http://markdrop.in/q3-plan"), null); // embedSlug: https only
  assert.equal(markdropSlug("https://markdrop.in/dashboard"), null);
  assert.equal(markdropSlug("https://markdrop.in/w/acme"), null);
  assert.equal(markdropSlug("https://markdrop.in/"), null);
  assert.equal(markdropSlug("https://evil.com/q3-plan"), null);
  assert.equal(markdropSlug("http://localhost:3130/q3-plan", "localhost:3130"), "q3-plan");
  assert.equal(markdropSlug("http://localhost:3130/settings", "localhost:3130"), null);
  assert.equal(markdropSlug("http://localhost:3131/q3-plan", "localhost:3130"), null);
});

test("what a pasted link can become", () => {
  const ids = (url, o) => pasteTargets(url, o).items.map((i) => i.id);
  assert.deepEqual(ids("https://example.com/post"), ["link", "bookmark"]);
  assert.deepEqual(ids("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), ["link", "bookmark", "embed"]);
  assert.deepEqual(ids("https://youtu.be/dQw4w9WgXcQ"), ["link", "bookmark", "embed"]);
  assert.deepEqual(ids("https://markdrop.in/q3-plan"), ["link", "mention", "bookmark", "embed"]);
  assert.deepEqual(ids("https://markdrop.in/q3-plan", { blockOk: false }), ["link", "mention"]);
  assert.deepEqual(ids("https://www.youtube.com/watch?v=dQw4w9WgXcQ", { blockOk: false }), ["link"]);
  const yt = pasteTargets("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(yt.web, true);
  assert.equal(yt.slug, null);
  assert.match(yt.items.find((i) => i.id === "embed").hint, /YouTube/);
  const md = pasteTargets("https://markdrop.in/q3-plan");
  assert.equal(md.slug, "q3-plan");
  assert.equal(md.web, false);
  for (const it of md.items) assert.ok(it.label && it.hint && it.icon);
});

test("which part of the clipboard is read", () => {
  assert.deepEqual(pickSource({ types: ["text/plain", "text/html"], html: "<p>x</p>", text: "x" }), { kind: "html" });
  // VS Code: the text, as Markdown or as code.
  assert.deepEqual(pickSource({ types: ["text/plain", "text/html", "vscode-editor-data"], html: "<div>…</div>", text: "# Hi", vscode: '{"mode":"markdown"}' }), { kind: "markdown" });
  assert.deepEqual(pickSource({ types: ["text/plain", "text/html", "vscode-editor-data"], html: "<div>…</div>", text: "const a = 1", vscode: '{"version":1,"mode":"typescriptreact"}' }), { kind: "code", language: "tsx" });
  assert.deepEqual(pickSource({ types: ["vscode-editor-data"], html: "", text: "x", vscode: "not json" }), { kind: "markdown" });
  // Notion: the HTML, unless it lost the to-dos the Markdown has.
  const notion = ["text/plain", "text/html", "text/_notion-blocks-v3-production"];
  assert.deepEqual(pickSource({ types: notion, html: '<ul class="to-do-list"><li><div class="checkbox checkbox-on"></div>a</li></ul>', text: "- [x] a" }), { kind: "html" });
  assert.deepEqual(pickSource({ types: notion, html: "<ul><li>a</li></ul>", text: "- [x] a" }), { kind: "markdown" });
  assert.deepEqual(pickSource({ types: notion, html: "<h2>a</h2>", text: "## a" }), { kind: "html" });
  assert.deepEqual(pickSource({ types: notion, html: "", text: "## a" }), { kind: "markdown" });
});

test("Markdown from other tools: Notion callouts, GitHub alerts, details", () => {
  assert.equal(pasteMarkdown("<aside>\n💡 Remember the **milk**\n\n</aside>"), ':::note{icon="💡"}\nRemember the **milk**\n:::');
  assert.equal(pasteMarkdown("<aside>💡 One line</aside>", { page: false }), ":::note\nOne line\n:::");
  assert.equal(pasteMarkdown("> [!WARNING]\n> Careful\n> now\n\nAfter"), ":::warning\nCareful\nnow\n:::\n\nAfter");
  assert.equal(pasteMarkdown("> [!IMPORTANT]\n> Read this"), ":::note[Important]\nRead this\n:::\n");
  assert.equal(pasteMarkdown('<details>\n<summary>Why "this"?</summary>\n\nBecause.\n</details>'), ':::details{summary="Why &quot;this&quot;?"}\nBecause.\n:::');
  assert.equal(pasteMarkdown("<details><summary>Q</summary>A</details>", { page: false }), ":::details[Q]\nA\n:::");
  // Code keeps its own text.
  const fenced = "```html\n<aside>💡 x</aside>\n```\n";
  assert.equal(pasteMarkdown(fenced), fenced);
  assert.equal(pasteMarkdown("Plain *text*\n"), "Plain *text*\n");
  // And the results read as the blocks they name.
  const blocks = parseBlocks(pasteMarkdown("<aside>\n🚀 Ship it\n</aside>\n\n> [!TIP]\n> Small steps\n\n<details><summary>More</summary>\n\nHidden\n</details>\n"), { verify: true });
  assert.deepEqual(blocks.map((b) => b.type), ["callout", "callout", "details"]);
  assert.deepEqual(blocks[0].attrs.attributes, { icon: "🚀" });
  assert.equal(blocks[1].attrs.kind, "tip");
  assert.deepEqual(blocks[2].attrs.attributes, { summary: "More" });
});

test("styles as marks (Google Docs, Word)", () => {
  assert.deepEqual(styleMarks("font-size:11pt;font-family:Arial;color:#000000;font-weight:700;font-style:normal;text-decoration:none"), { bold: true, italic: false });
  assert.deepEqual(styleMarks("font-weight:400;font-style:italic;text-decoration:line-through"), { bold: false, italic: true, strike: true });
  assert.deepEqual(styleMarks("font-weight: bold !important"), { bold: true });
  assert.deepEqual(styleMarks("font-weight:normal"), { bold: false });
  assert.deepEqual(styleMarks("font-family:'Courier New',monospace"), { code: true });
  assert.deepEqual(styleMarks("font-family:Roboto Mono"), { code: true });
  assert.deepEqual(styleMarks("font-family:Arial"), {});
  assert.deepEqual(styleMarks(""), {});
  assert.deepEqual(styleMarks(null), {});
});

test("code languages from labels and classes", () => {
  assert.equal(codeLanguage("language-JavaScript", { fromClass: true }), "javascript");
  assert.equal(codeLanguage("hljs language-ts", { fromClass: true }), "ts");
  assert.equal(codeLanguage("highlight highlight-source-shell notranslate", { fromClass: true }), "bash");
  assert.equal(codeLanguage("highlight-text-md", { fromClass: true }), "markdown");
  assert.equal(codeLanguage("hljs", { fromClass: true }), null);
  assert.equal(codeLanguage("Plain Text"), null);
  assert.equal(codeLanguage("C++"), "cpp");
  assert.equal(codeLanguage("C#"), "csharp");
  assert.equal(codeLanguage("Python"), "python");
  assert.equal(codeLanguage("Visual Basic"), "vb");
  assert.equal(codeLanguage("no way; at all"), null);
  assert.equal(codeLanguage(""), null);
});
