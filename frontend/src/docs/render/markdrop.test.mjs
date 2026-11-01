/**
 * `::markdrop` through the renderer's own plugins (render/plugins.ts → the `docs-markdrop` element
 * and its whitelisted attributes), the agent Markdown (markdown.ts) and docs:check.
 *   node --test src/docs/render/markdrop.test.mjs
 *
 * plugins.ts and markdown.ts are TypeScript with `@/` and extensionless imports: they load through
 * node's type stripping and a small resolve hook (skipped on a node without type stripping).
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
import remarkRehype from "remark-rehype";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, "../../..");
const canTs = !!process.features?.typescript;

let plugins, md;
if (canTs) {
  const src = pathToFileURL(path.join(FRONTEND, "src") + "/").href;
  // `@/x` → src/x.ts; `./x` without an extension → ./x.ts; .ts files load as ES modules.
  const hook = `export async function resolve(s, c, next) {
    let spec = s.startsWith("@/") ? ${JSON.stringify(src)} + s.slice(2) + ".ts" : s;
    if (/^\\.\\.?\\//.test(spec) && !/\\.[a-z]+$/i.test(spec)) spec += ".ts";
    const r = await next(spec, c);
    return r.url.endsWith(".ts") ? { ...r, format: "module-typescript" } : r;
  }`;
  register("data:text/javascript," + encodeURIComponent(hook));
  plugins = await import("./plugins.ts");
  md = await import("../markdown.ts");
}

/** Markdown → the hast the component map receives. */
function hast(source) {
  const p = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkDirective).use(plugins.remarkDocs).use(remarkRehype);
  return p.runSync(p.parse(source), source);
}
function find(tree, tag) {
  const out = [];
  const visit = (n) => {
    if (n.type === "element" && n.tagName === tag) out.push(n);
    (n.children ?? []).forEach(visit);
  };
  visit(tree);
  return out;
}

const skip = !canTs && "no type stripping";

test("renderer: ::markdrop becomes docs-markdrop with its whitelisted attributes", { skip }, () => {
  const tree = hast('Intro.\n\n::markdrop{src="https://markdrop.in/acme-pricing" title="Pricing calculator" height=640 mode=preview version=3 onload="alert(1)" style="x"}\n\nAfter.');
  const [el] = find(tree, "docs-markdrop");
  assert.ok(el, "a docs-markdrop element");
  assert.deepEqual(el.properties, { src: "https://markdrop.in/acme-pricing", label: "Pricing calculator", eid: "acme-pricing", height: "640", mode: "preview", version: "3" });
  assert.equal(el.children.length, 0);
});

test("renderer: the [label] is the title when there is no title attribute", { skip }, () => {
  const [el] = find(hast('::markdrop[Price list]{src="https://markdrop.in/acme-prices" aspect="16:9" captions="/docs-assets/v/a.vtt" summary="Plans and prices."}'), "docs-markdrop");
  assert.deepEqual(el.properties, { src: "https://markdrop.in/acme-prices", label: "Price list", summary: "Plans and prices.", eid: "acme-prices", aspect: "16:9", captions: "/docs-assets/v/a.vtt" });
});

test("renderer: each block gets a stable id on its page (the same file twice: ~2)", { skip }, () => {
  const tree = hast('::markdrop{src="https://markdrop.in/a"}\n\n::markdrop{src="https://markdrop.in/b"}\n\n:::note\n::markdrop{src="https://markdrop.in/a"}\n:::\n\n::markdrop{src="https://x.example/c"}');
  assert.deepEqual(find(tree, "docs-markdrop").map((e) => e.properties.eid), ["a", "b", "a~2", "file"]);
});

test("renderer: inside containers, and code stays code", { skip }, () => {
  const tree = hast(':::tip\n::markdrop{src="https://markdrop.in/a"}\n:::\n\n```md\n::markdrop{src="https://markdrop.in/b"}\n```');
  const els = find(tree, "docs-markdrop");
  assert.equal(els.length, 1);
  assert.equal(els[0].properties.src, "https://markdrop.in/a");
});

test("agent Markdown: a Markdrop file becomes its link and text version", { skip }, () => {
  assert.equal(md.toPlainMarkdown('See it:\n\n::markdrop{src="https://markdrop.in/acme" title="Pricing calculator"}'), "See it:\n\n[Markdrop file: Pricing calculator](https://markdrop.in/acme)");
  assert.equal(md.toPlainMarkdown("::markdrop[Tour]{src=https://markdrop.in/tour}"), "[Markdrop file: Tour](https://markdrop.in/tour)");
  assert.equal(md.toPlainMarkdown('::markdrop{src="https://evil.example/x"}'), "");
  assert.equal(
    md.toPlainMarkdown('::markdrop{src="https://markdrop.in/acme" title="Pricing" summary="Pick a plan and seats; the total updates."}\n\nAfter.'),
    "[Markdrop file: Pricing](https://markdrop.in/acme)\n\nPick a plan and seats; the total updates.\n\nAfter.",
  );
  // The build's resolver (content.ts) adds what it knows of the file.
  const out = md.toPlainMarkdown('::markdrop{src="https://markdrop.in/acme-prices"}', { markdrop: () => ["[PDF: Price list](https://markdrop.in/acme-prices) (3 pages)", "", "Text: Starter $9"] });
  assert.equal(out, "[PDF: Price list](https://markdrop.in/acme-prices) (3 pages)\n\nText: Starter $9");
  // Search reads the summary too.
  assert.equal(md.plainText('::markdrop{src="https://markdrop.in/acme" title="Pricing" summary="Seats and plans."}'), "Markdrop file: Pricing Seats and plans.");
  assert.ok(md.LEAF_DIRECTIVES.includes("markdrop"));
});

/* ── docs:check ──────────────────────────────────────────────────────────── */

function docsCheck(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-check-markdrop-"));
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

const page = (body) => `---\ntitle: A page\ndescription: A page for the test.\nupdated: 2026-11-02\n---\n\n${body}\n`;
const site = { nav: [{ group: "Guide", pages: ["/guide/a"] }] };

test("docs:check: ::markdrop is known; a good block passes", () => {
  const out = docsCheck({ "site.json": site, "guide/a.md": page('Text.\n\n::markdrop{src="https://markdrop.in/acme-pricing" title="Pricing" height=600}\n\n::markdrop[Tour]{src="https://markdrop.in/acme-tour" aspect="16:9" mode=card version=2}') });
  assert.match(out, / 0 errors, 0 warnings/, out);
});

test("docs:check: a missing or foreign src is an error; bad values warn", () => {
  const out = docsCheck({ "site.json": site, "guide/a.md": page('::markdrop{title="x"}\n\n::markdrop{src="https://example.com/x"}\n\n::markdrop{src="https://markdrop.in/a" height=5 mode=auto colour=red}') });
  assert.match(out, /::markdrop needs src=/, out);
  assert.match(out, /isn't a Markdrop link/, out);
  assert.match(out, /height="5" must be a number of pixels/, out);
  assert.match(out, /mode="auto" must be live, preview, card/, out);
  assert.match(out, /doesn't know "colour"/, out);
  assert.match(out, / 2 errors, 3 warnings/, out);
});
