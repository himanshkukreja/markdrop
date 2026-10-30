/**
 * The renderer's parsing rules: image alt text the directive syntax cut short (render/rules.mjs),
 * the `{…}` attribute regexes and parseAttrs, `::api` in the plain Markdown (markdown.ts), and
 * docs:check's `::api` rules.
 *   node --test src/docs/render/render.test.mjs
 *
 * markdown.ts is TypeScript with a `@/` import: it loads through node's type stripping and a tiny
 * resolve hook, and those tests are skipped on a node without type stripping.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkDirective from "remark-directive";
import { fixImageAlts, imageAltFromSource, parserOptions } from "./rules.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, "../../..");

/* ── image alt text ──────────────────────────────────────────────────────── */

/** The docs pipeline's parser (gfm, math, directive), with or without the alt fix. */
function alts(md, { fix = true, directive = true } = {}) {
  const p = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
  if (directive) p.use(remarkDirective);
  if (fix)
    p.use(function () {
      const self = this;
      return (tree, file) => fixImageAlts(tree, String(file.value), parserOptions(self.data()));
    });
  const tree = p.runSync(p.parse(md), md);
  const out = [];
  const visit = (n) => {
    if (n.type === "image" || n.type === "imageReference") out.push(n.alt);
    (n.children ?? []).forEach(visit);
  };
  visit(tree);
  return out;
}
/** What CommonMark (+ gfm, math) makes of the same alt: the reference, no directive syntax. */
const plain = (md) => alts(md, { fix: false, directive: false });

test("alt: the directive syntax no longer swallows ':15' (the bug)", () => {
  const md = "![Video at 0:15 shows the button](/x.png)";
  assert.deepEqual(alts(md, { fix: false }), ["Video at 0 shows the button"]); // what the parser alone gives
  assert.deepEqual(alts(md), ["Video at 0:15 shows the button"]);
});

test("alt: times, words with colons, ratios", () => {
  assert.deepEqual(alts("![The 10:30 meeting](/x.png)"), ["The 10:30 meeting"]);
  assert.deepEqual(alts("![a:b](/x.png)"), ["a:b"]);
  assert.deepEqual(alts("![16:9 at 1:2:3](/x.png)"), ["16:9 at 1:2:3"]);
  assert.deepEqual(alts("Inline ![step 2:open](/i.png) icon."), ["step 2:open"]);
});

test("alt: emphasis, code, escapes, strikethrough and math read as CommonMark reads them", () => {
  for (const md of [
    "![a *b* \\: c:d](/x.png)",
    "![**Bold** and `co:de` at 0:15](/x.png)",
    "![~~old~~ 1:2](/x.png)",
    "![$x$ at 1:2](/x.png)",
    "![Settings: Theme, Fonts](/x.png)",
    "![a \\[b\\] 0:15](/x.png \"Caption: here\")",
    "![The *Share* dialog: People](/docs-assets/a/b.webp)",
    "![Logo](https://example.com/logo.png)",
    "| Col |\n| --- |\n| ![cell 0:15](/c.png) |",
    "- item ![in a list 1:2](/l.png)",
    "[![linked 0:15](/i.png)](https://example.com)",
  ]) {
    assert.deepEqual(alts(md), plain(md), md);
  }
});

test("alt: reference images re-resolve through their definition", () => {
  assert.deepEqual(alts("![full 0:15][x]\n\n[x]: /y.png"), ["full 0:15"]);
  assert.deepEqual(alts("![collapsed 0:15][]\n\n[collapsed 0:15]: /y.png"), ["collapsed 0:15"]);
  assert.deepEqual(alts("![shortcut 0:15]\n\n[shortcut 0:15]: /y.png"), ["shortcut 0:15"]);
});

test("alt: a text directive in the label reads the way the page renders it", () => {
  assert.deepEqual(alts("![Press :kbd[Ctrl] at 0:15](/x.png)"), ["Press Ctrl at 0:15"]);
  assert.deepEqual(alts("![see :term[API] here](/x.png)"), ["see :term[API] here"]);
});

test("alt: anything that doesn't line up keeps the parser's alt", () => {
  // A label split across blockquote lines: the slice holds "> ", so it can't re-parse alone.
  const md = "> ![quoted at\n> 0:15](/q.png)";
  assert.deepEqual(alts(md), alts(md, { fix: false }));
  // No positions, wrong node, bad slice.
  assert.equal(imageAltFromSource("![a 0:15](/x)", { type: "image", url: "/x" }), undefined);
  assert.equal(imageAltFromSource("![a 0:15](/x)", { type: "link", url: "/x", position: { start: { offset: 0 }, end: { offset: 13 } } }), undefined);
  assert.equal(imageAltFromSource("xx![a 0:15](/x)", { type: "image", url: "/x", position: { start: { offset: 0 }, end: { offset: 13 } } }), undefined);
  // The url must match, so a mis-positioned node can't take another image's text.
  assert.equal(imageAltFromSource("![a 0:15](/x)", { type: "image", url: "/other", position: { start: { offset: 0 }, end: { offset: 13 } } }), undefined);
  assert.equal(imageAltFromSource("![a 0:15](/x)", { type: "image", url: "/x", position: { start: { offset: 0 }, end: { offset: 13 } } }), "a 0:15");
  // Without a source (no file value) nothing changes.
  const tree = { type: "root", children: [{ type: "image", url: "/x", alt: "a 0", position: { start: { offset: 0 }, end: { offset: 13 } } }] };
  fixImageAlts(tree, undefined);
  assert.equal(tree.children[0].alt, "a 0");
});

test("alt: every image in the Markdrop docs reads as CommonMark reads it", () => {
  const dir = path.join(FRONTEND, "content", "docs");
  if (!fs.existsSync(dir)) return;
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith(".md")) files.push(path.join(d, e.name));
    }
  };
  walk(dir);
  let n = 0;
  for (const f of files) {
    const md = fs.readFileSync(f, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
    if (md.includes(":kbd[")) continue; // :kbd in an alt reads as its label, CommonMark keeps the syntax
    const got = alts(md);
    n += got.length;
    assert.deepEqual(got, plain(md), path.relative(dir, f));
  }
  assert.ok(n > 0);
});

/* ── markdown.ts (TypeScript, loaded through type stripping) ─────────────── */

const canTs = !!process.features?.typescript;
let md;
if (canTs) {
  const src = pathToFileURL(path.join(FRONTEND, "src") + "/").href;
  // `@/x` → src/x.ts; .ts files load as ES modules (the package has no "type").
  const hook = `export async function resolve(s, c, next) {
    const r = await next(s.startsWith("@/") ? ${JSON.stringify(src)} + s.slice(2) + ".ts" : s, c);
    return r.url.endsWith(".ts") ? { ...r, format: "module-typescript" } : r;
  }`;
  register("data:text/javascript," + encodeURIComponent(hook));
  md = await import("../markdown.ts");
}

test("directive regexes: a quoted value may hold braces", { skip: !canTs && "no type stripping" }, () => {
  const leaf = md.DIRECTIVE_LEAF.exec('::api{op="GET /api/v1/documents/{id}"}');
  assert.ok(leaf);
  assert.equal(leaf[1], "api");
  assert.equal(leaf[3], 'op="GET /api/v1/documents/{id}"');
  const labelled = md.DIRECTIVE_LEAF.exec("::api[Fetch it]{op='GET /a/{id}/b/{c}' x=1}  ");
  assert.equal(labelled[2], "Fetch it");
  assert.equal(labelled[3], "op='GET /a/{id}/b/{c}' x=1");
  // Like remark-directive: an unclosed quote, or text after the braces, isn't a directive.
  assert.equal(md.DIRECTIVE_LEAF.exec('::api{op="GET /a}'), null);
  assert.equal(md.DIRECTIVE_LEAF.exec('::api{op="GET /a"} trailing'), null);
  // Unchanged for what already worked.
  assert.ok(md.DIRECTIVE_LEAF.exec('::video{id="x" title="A {b}"}'));
  assert.deepEqual(md.DIRECTIVE_LEAF.exec("::embed{src=https://x.y}").slice(1), ["embed", undefined, "src=https://x.y"]);
  const open = md.DIRECTIVE_OPEN.exec(':::card[Docs]{href="/a/{b}" icon="book"}');
  assert.deepEqual(open.slice(1), [":::", "card", "Docs", 'href="/a/{b}" icon="book"']);
  assert.ok(md.DIRECTIVE_OPEN.exec("::::tabs{sync=os}"));
  assert.equal(md.DIRECTIVE_OPEN.exec(":::note{a=\"x}"), null);
});

test("parseAttrs: quoted values whole, braces, ids and classes", { skip: !canTs && "no type stripping" }, () => {
  assert.deepEqual(md.parseAttrs('op="GET /api/v1/documents/{id}"'), { op: "GET /api/v1/documents/{id}" });
  assert.deepEqual(md.parseAttrs("op='POST /a/{b}' flag"), { op: "POST /a/{b}", flag: "" });
  assert.deepEqual(md.parseAttrs('#main .a .b title="x #y .z" n=3'), { id: "main", class: "a b", title: "x #y .z", n: "3" });
  assert.deepEqual(md.parseAttrs(undefined), {});
});

test("toPlainMarkdown: ::api becomes a code span, after its label", { skip: !canTs && "no type stripping" }, () => {
  assert.equal(md.toPlainMarkdown('Intro.\n\n::api{op="GET /api/v1/documents/{id}"}\n\nAfter.'), "Intro.\n\n`GET /api/v1/documents/{id}`\n\nAfter.");
  assert.equal(md.toPlainMarkdown("::api[Fetch a document]{op='get  /v1/x'}"), "Fetch a document: `GET /v1/x`");
  assert.equal(md.toPlainMarkdown("::api{}"), "");
  // Inside a callout it is quoted with the rest.
  assert.equal(md.toPlainMarkdown(':::note\n::api{op="DELETE /v1/x/{id}"}\n:::'), "> **Note**\n>\n> `DELETE /v1/x/{id}`");
  // Inside code it stays as written.
  assert.equal(md.toPlainMarkdown('```md\n::api{op="GET /a"}\n```'), '```md\n::api{op="GET /a"}\n```');
  // Search text keeps the method and path.
  assert.equal(md.plainText('::api{op="GET /v1/things/{id}"}'), "GET /v1/things/{id}");
  assert.equal(md.normalizeApiOp("  patch\t/v1/x "), "PATCH /v1/x");
  assert.ok(md.LEAF_DIRECTIVES.includes("api"));
});

/* ── docs:check ──────────────────────────────────────────────────────────── */

function docsCheck(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-check-api-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
    }
    try {
      return execFileSync(process.execPath, [path.join(FRONTEND, "scripts", "docs-check.mjs")], { env: { ...process.env, DOCS_CONTENT_DIR: dir }, encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      return String(e.stdout ?? "") + String(e.stderr ?? "");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const page = (body) => `---\ntitle: A page\ndescription: A page for the test.\nupdated: 2026-10-31\n---\n\n${body}\n`;
const SPEC = {
  openapi: "3.1.0",
  info: { title: "T", version: "1", "x-docs-exported": "2026-10-31" },
  paths: { "/v1/things/{id}": { get: { summary: "Get a thing", tags: ["things"], responses: { 200: { description: "OK" } } } } },
};
const OVERLAY = { groups: [{ id: "things", title: "Things", tags: ["things"] }], operations: { "GET /v1/things/{id}": { title: "Get a thing", description: "Returns one thing." } } };

test("docs:check: ::api is known, op must be METHOD /path", () => {
  const site = { nav: [{ group: "Guide", pages: ["/guide/a"] }] };
  const ok = docsCheck({ "site.json": site, "guide/a.md": page('Text.\n\n::api{op="GET /v1/things/{id}"}\n\n::api[Make one]{op="post /v1/things"}') });
  if (process.env.DEBUG_DOCS_CHECK) console.log(ok);
  assert.match(ok, / 0 errors, 0 warnings/, ok);
  const bad = docsCheck({ "site.json": site, "guide/a.md": page('::api{op="FETCH /v1/x"}\n\n::api{op="GET v1/x"}\n\n::api{op=GET /v1/x}\n\n::api') });
  assert.equal((bad.match(/::api needs op="METHOD \/path"/g) ?? []).length, 4, bad);
});

test("docs:check: with an OpenAPI reference, an op that isn't in it warns", () => {
  const site = { nav: [{ group: "Guide", pages: ["/guide/a"] }], openapi: { spec: "openapi.json", overlay: "overlay.json", base: "/api" } };
  const out = docsCheck({ "site.json": site, "openapi.json": SPEC, "overlay.json": OVERLAY, "guide/a.md": page('::api{op="get /v1/things/{id}"}\n\n::api{op="DELETE /v1/things/{id}"}') });
  if (process.env.DEBUG_DOCS_CHECK) console.log(out);
  assert.doesNotMatch(out, /doesn't build|is missing/, out);
  assert.doesNotMatch(out, /"GET \/v1\/things\/\{id\}" isn't an operation/, out);
  assert.match(out, /::api op "DELETE \/v1\/things\/\{id\}" isn't an operation in the API reference/, out);
});
