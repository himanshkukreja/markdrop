/**
 * Targeted fixtures per block: how each construct is modeled, how a block the editor creates is
 * written, and how an edited block keeps what it can (fences, attribute text, untouched rows).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, serializeMarkdown, serializeBlock, parseBlocks, fp } from "../core/markdown.mjs";
import { schema, throughEditor, sameContent, clone, p } from "./helpers.mjs";

/** Markdown of a document built from fresh nodes (no source to reuse). */
function write(...content) {
  const doc = schema.nodeFromJSON({ type: "doc", content }).toJSON();
  return serializeMarkdown({ doc, front: "", lead: "", tail: "\n", eol: "\n", bom: "", empty: false });
}

const one = (md) => parseMarkdown(md).doc.content[0];
const text = (t, marks) => ({ type: "text", text: t, ...(marks ? { marks: marks.map((m) => (typeof m === "string" ? { type: m } : m)) } : {}) });
const para = (...kids) => ({ type: "paragraph", content: kids });

function roundTrips(md) {
  assert.equal(throughEditor(md).out, md);
}

/* ── modeling ─────────────────────────────────────────────────────────────── */

test("callouts: kind, title, attributes", () => {
  for (const kind of ["note", "tip", "warning", "danger"]) {
    const n = one(`:::${kind}[Heads up]{#x}\nBody.\n:::\n`);
    assert.equal(n.type, "callout");
    assert.equal(n.attrs.kind, kind);
    assert.equal(n.attrs.label, "Heads up");
    assert.deepEqual(n.attrs.attributes, { id: "x" });
  }
  assert.equal(one(":::note\nBody.\n:::\n").attrs.label, null);
});

test("steps keep headings and blocks as children", () => {
  const n = one("::::steps\n### One\nDo it.\n\n### Two\nThen this.\n::::\n");
  assert.equal(n.type, "steps");
  assert.deepEqual(n.content.map((k) => k.type), ["heading", "paragraph", "heading", "paragraph"]);
});

test("tabs hold tab panes with labels and sync", () => {
  const n = one('::::tabs{sync="os"}\n:::tab[macOS]\nMac.\n:::\n:::tab[Linux]\nLinux.\n:::\n::::\n');
  assert.equal(n.type, "tabs");
  assert.deepEqual(n.attrs.attributes, { sync: "os" });
  assert.deepEqual(n.content.map((t) => [t.type, t.attrs.label]), [["tab", "macOS"], ["tab", "Linux"]]);
});

test("tabs with anything but tab panes stay raw (the renderer would drop the rest)", () => {
  assert.equal(one("::::tabs\nLoose text.\n:::tab[A]\nA.\n:::\n::::\n").type, "rawBlock");
});

test("cards hold cards with title, href and icon", () => {
  const n = one('::::cards\n:::card[Title]{href="/a" icon="zap"}\nBody.\n:::\n::::\n');
  assert.equal(n.content[0].type, "card");
  assert.equal(n.content[0].attrs.label, "Title");
  assert.deepEqual(n.content[0].attrs.attributes, { href: "/a", icon: "zap" });
});

test("details, video, clip, embed, api", () => {
  assert.equal(one(":::details[More]\nX.\n:::\n").type, "details");
  for (const [md, name] of [
    ['::video{id="v" title="T" duration="0:32"}\n', "video"],
    ['::clip{src="/docs-assets/a/b" alt="A" theme="both"}\n', "clip"],
    ['::embed{src="https://x.dev" title="X"}\n', "embed"],
    ['::api{op="GET /v1/things/{id}"}\n', "api"],
  ]) {
    const n = one(md);
    assert.equal(n.type, "directiveLeaf");
    assert.equal(n.attrs.name, name);
    roundTrips(md);
  }
});

test("a paragraph holding only an image is a figure; alt keeps colons", () => {
  const n = one('![At 0:15 it plays](/docs-assets/a.webp "Caption")\n');
  assert.equal(n.type, "figure");
  assert.deepEqual([n.attrs.src, n.attrs.alt, n.attrs.title], ["/docs-assets/a.webp", "At 0:15 it plays", "Caption"]);
  // Edited (caption changed), the alt survives.
  const d = clone(n);
  d.attrs.title = "New caption";
  assert.equal(serializeBlock(d), '![At 0:15 it plays](/docs-assets/a.webp "New caption")');
});

test("code fences: language and raw meta (title, wrap, highlights)", () => {
  const n = one('```bash title="Install" wrap {2}\nnpm i\n```\n');
  assert.equal(n.type, "codeBlock");
  assert.equal(n.attrs.language, "bash");
  assert.equal(n.attrs.meta, 'title="Install" wrap {2}');
});

test("inline marks: bold, italic, strike, code, link around code, kbd", () => {
  const n = one("**b** *i* ~~s~~ `c` [`code link`](/x) :kbd[⌘ K]\n");
  const marks = n.content.filter((k) => k.type === "text" && k.marks).map((k) => [k.text, k.marks.map((m) => m.type).sort().join("+")]);
  assert.deepEqual(marks, [["b", "bold"], ["i", "italic"], ["s", "strike"], ["c", "code"], ["code link", "code+link"], ["⌘ K", "kbd"]]);
});

test("a colon before a word is text, not a directive", () => {
  const n = one("At 0:30, ratio 16:9 and Note:this.\n");
  assert.deepEqual(n.content, [{ type: "text", text: "At 0:30, ratio 16:9 and Note:this." }]);
});

test("unknown directives and HTML are kept verbatim as raw blocks/inlines", () => {
  for (const md of [":::custom[X]{a=1}\nBody.\n:::\n", "::thing{a=\"b\"}\n", "<div>\nhtml\n</div>\n", "[ref]: https://x.dev\n"]) {
    assert.equal(one(md).type, "rawBlock", md);
    roundTrips(md);
  }
  const n = one('Has :abbr[HTML]{title="x"} and <b>tags</b>.\n');
  assert.deepEqual(n.content.filter((k) => k.type === "rawInline").map((k) => k.attrs.value), [':abbr[HTML]{title="x"}', "<b>", "</b>"]);
});

test("math: block and inline", () => {
  assert.equal(one("$$\na^2\n$$\n").type, "mathBlock");
  assert.equal(one("Inline $x$ math.\n").content[1].type, "inlineMath");
});

test("tables: alignment and cells with pipes in code", () => {
  const n = one("| a | b |\n|:--|--:|\n| `x\\|y` | 2 |\n");
  assert.deepEqual(n.attrs.align, ["left", "right"]);
  assert.equal(n.content[1].content[0].content[0].text, "x|y");
});

/* ── writing new blocks ───────────────────────────────────────────────────── */

test("new callout / steps / details", () => {
  assert.equal(write({ type: "callout", attrs: { kind: "tip", label: "Title" }, content: [p("Hi")] }), ":::tip[Title]\nHi\n:::\n");
  assert.equal(write({ type: "callout", attrs: { kind: "warning" }, content: [p("Careful")] }), ":::warning\nCareful\n:::\n");
  assert.equal(
    write({ type: "steps", content: [{ type: "heading", attrs: { level: 3 }, content: [text("One")] }, p("Do it.")] }),
    ":::steps\n### One\n\nDo it.\n:::\n",
  );
  assert.equal(write({ type: "details", attrs: { label: "More" }, content: [p("X")] }), ":::details[More]\nX\n:::\n");
});

test("new tabs and cards get a longer outer fence", () => {
  const tabs = {
    type: "tabs",
    attrs: { attributes: { sync: "os" } },
    content: [
      { type: "tab", attrs: { label: "A" }, content: [p("a")] },
      { type: "tab", attrs: { label: "B" }, content: [{ type: "codeBlock", attrs: { language: "bash", meta: 'title="x"' }, content: [text("ls")] }] },
    ],
  };
  assert.equal(write(tabs), '::::tabs{sync="os"}\n:::tab[A]\na\n:::\n\n:::tab[B]\n```bash title="x"\nls\n```\n:::\n::::\n');
  const cards = { type: "cards", content: [{ type: "card", attrs: { label: "T", attributes: { href: "/a", icon: "zap" } }, content: [p("Body")] }] };
  assert.equal(write(cards), '::::cards\n:::card[T]{href="/a" icon="zap"}\nBody\n:::\n::::\n');
});

test("deep nesting sizes every fence so inner closers never close outer blocks", () => {
  const doc = {
    type: "steps",
    content: [
      { type: "heading", attrs: { level: 3 }, content: [text("S")] },
      { type: "tabs", content: [{ type: "tab", attrs: { label: "A" }, content: [{ type: "callout", attrs: { kind: "note" }, content: [p("deep")] }] }] },
    ],
  };
  const md = write(doc);
  assert.match(md, /^:{6}steps\n/);
  assert.ok(md.includes("\n:::::tabs\n::::tab[A]\n:::note\ndeep\n:::\n::::\n:::::\n::::::"));
  assert.ok(sameContent(md, md));
  const back = parseMarkdown(md).doc.content[0];
  assert.equal(back.type, "steps");
  assert.equal(back.content[1].content[0].content[0].type, "callout");
});

test("new leaves, figure, code, table, inline marks", () => {
  assert.equal(write({ type: "directiveLeaf", attrs: { name: "video", attributes: { id: "intro", title: 'Say "hi"' } } }), '::video{id="intro" title="Say &quot;hi&quot;"}\n');
  assert.equal(write({ type: "directiveLeaf", attrs: { name: "api", attributes: { op: "POST /v1/x" } } }), '::api{op="POST /v1/x"}\n');
  assert.equal(write({ type: "figure", attrs: { src: "/docs-assets/a.webp", alt: "Alt", title: "Cap" } }), '![Alt](/docs-assets/a.webp "Cap")\n');
  assert.equal(write({ type: "codeBlock", attrs: { language: "js", meta: "wrap" }, content: [text("x()")] }), "```js wrap\nx()\n```\n");
  assert.equal(
    write({
      type: "table",
      attrs: { align: [null, "center"] },
      content: [
        { type: "tableRow", content: [{ type: "tableHeader", content: [text("A")] }, { type: "tableHeader", content: [text("B")] }] },
        { type: "tableRow", content: [{ type: "tableCell", content: [text("a|b", ["code"])] }, { type: "tableCell", content: [] }] },
      ],
    }),
    "| A | B |\n| --- | :-: |\n| `a\\|b` |  |\n",
  );
  assert.equal(
    write(para(text("Press "), text("Ctrl K", ["kbd"]), text(" or "), text("docs", ["bold", { type: "link", attrs: { href: "/d" } }]), text(" and "), text("x", ["code", "italic"]))),
    "Press :kbd[Ctrl K] or [**docs**](/d) and *`x`*\n",
  );
});

test("typed text that looks like syntax is escaped, and reads back as typed", () => {
  const typed = "Use *stars*, _under_, [brackets], `ticks`, <tags>, a | pipe, 10:30 and :kbd[x], $5, # hash";
  const md = write(para(text(typed)));
  const back = parseMarkdown(md).doc.content[0];
  assert.deepEqual(back.content, [{ type: "text", text: typed }]);
});

/* ── editing keeps what it can ────────────────────────────────────────────── */

test("editing a callout's body keeps its fence line exactly", () => {
  const src = "::::warning[Mind this]{#w .x}\nOld text.\n\nSecond.\n::::\n";
  const st = parseMarkdown(src);
  const d = clone(st.doc);
  d.content[0].content[0].content[0].text = "New text.";
  assert.equal(serializeMarkdown({ ...st, doc: d }), "::::warning[Mind this]{#w .x}\nNew text.\n\nSecond.\n::::\n");
});

test("changing a callout's kind or title rewrites only its fence line", () => {
  const src = ":::note[Old]\nBody **kept** as written.\n:::\n";
  const st = parseMarkdown(src);
  const d = clone(st.doc);
  d.content[0].attrs.kind = "tip";
  d.content[0].attrs.label = "New";
  assert.equal(serializeMarkdown({ ...st, doc: d }), ":::tip[New]\nBody **kept** as written.\n:::\n");
});

test("editing one table cell rewrites only its row", () => {
  const src = "| A   | B |\n|-----|---|\n| one | 1 |\n| two | 2 |\n";
  const st = parseMarkdown(src);
  const d = clone(st.doc);
  d.content[0].content[2].content[1].content[0].text = "22";
  assert.equal(serializeMarkdown({ ...st, doc: d }), "| A   | B |\n|-----|---|\n| one | 1 |\n| two | 22 |\n");
});

test("adding a row keeps the other rows and the delimiter", () => {
  const src = "| A | B |\n|---|---|\n| 1 | 2 |\n";
  const st = parseMarkdown(src);
  const d = clone(st.doc);
  d.content[0].content.push({ type: "tableRow", content: [{ type: "tableCell", content: [text("3")] }, { type: "tableCell", content: [text("4")] }] });
  const doc = schema.nodeFromJSON(d).toJSON();
  assert.equal(serializeMarkdown({ ...st, doc }), "| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n");
});

test("editing a list item keeps the list's marker style and numbering", () => {
  const st = parseMarkdown("* one\n* two\n\n1) a\n1) b\n");
  const d = clone(st.doc);
  d.content[0].content[1].content[0].content[0].text = "TWO";
  d.content[1].content[0].content[0].content[0].text = "A";
  assert.equal(serializeMarkdown({ ...st, doc: d }), "* one\n* TWO\n\n1) A\n1) b\n");
});

test("a list moved next to another list switches marker so they stay two lists", () => {
  const st = parseMarkdown("- a\n- b\n\nText.\n\n- c\n");
  const d = clone(st.doc);
  d.content.splice(1, 1); // delete the paragraph between them
  const out = serializeMarkdown({ ...st, doc: d });
  assert.equal(out, "- a\n- b\n\n* c\n");
  assert.equal(parseMarkdown(out).doc.content.length, 2);
});

test("a heading followed directly by text keeps the single newline only while they stay neighbours", () => {
  const src = "### Step\nDo it.\n\nOther.\n";
  const st = parseMarkdown(src);
  assert.equal(serializeMarkdown(st), src);
  const d = clone(st.doc);
  d.content.reverse();
  const out = serializeMarkdown({ ...st, doc: d });
  assert.ok(sameContent(out, "Other.\n\nDo it.\n\n### Step\n"), out);
});

test("empty paragraphs (Enter on an empty line, trailing node) write nothing", () => {
  const st = parseMarkdown("A\n\nB\n");
  const d = clone(st.doc);
  d.content.splice(1, 0, { type: "paragraph", attrs: { md: null } });
  d.content.push({ type: "paragraph", attrs: { md: null } });
  assert.equal(serializeMarkdown({ ...st, doc: d }), "A\n\nB\n");
});

/* ── documents ────────────────────────────────────────────────────────────── */

test("edge documents round-trip exactly", () => {
  for (const md of [
    "",
    "\n",
    "   \n\n",
    "No trailing newline",
    "---\ntitle: Only frontmatter\n---\n",
    "---\ntitle: X\n---\n\n\nBody after blank lines.\n\n\n",
    "﻿---\ntitle: BOM\n---\nText\n",
    "Line one\r\nline two\r\n\r\n- a\r\n- b\r\n",
    "Tabs\tinside\ttext\n\n\tindented code with tab\n",
    "# Title\n\n\n\nFour blank lines above.\n",
    "Trailing spaces   \n\nNext\n",
    "Paragraph\n    lazy continuation\n",
    "> quote\nlazy\n",
    "Unicode: café, 日本語, emoji 🙂, RTL مرحبا\n",
  ])
    roundTrips(md);
});

test("a new page (empty) gets its first content with a trailing newline", () => {
  const st = parseMarkdown("");
  const doc = { type: "doc", content: [p("Hello")] };
  assert.equal(serializeMarkdown({ ...st, doc }), "Hello\n");
  const st2 = parseMarkdown("---\ntitle: T\n---\n");
  assert.equal(serializeMarkdown({ ...st2, doc }), "---\ntitle: T\n---\n\nHello\n");
});

test("parseBlocks reads a pasted fragment into blocks", () => {
  const blocks = parseBlocks(":::tip\nPasted.\n:::\n\nAnd text.\n");
  assert.deepEqual(blocks.map((b) => b.type), ["callout", "paragraph"]);
  assert.equal(fp(blocks[0]), blocks[0].attrs.md.fp);
});
