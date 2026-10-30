/**
 * Block converter tests (synthetic fixtures only; no third-party content).
 *   node --test scripts/docs-import/test/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { convertBody, faIcon, faName, firstParagraph, parseGitbookPage, tagAttrs, trimDescription, videoEmbedUrl } from "../lib/convert.mjs";
import { createSite, isOpaqueImage } from "../lib/site.mjs";
import { decodeEntities, inlineMarkdown, parseHtml } from "../lib/html.mjs";
import { createSlugger, headingIds } from "../lib/slug.mjs";

/** A ctx like the importer's: links under https://docs.example.com map to themselves minus .md. */
function makeCtx(over = {}) {
  const counts = [];
  const issues = [];
  const images = [];
  const ctx = {
    count: (kind, how) => counts.push(`${kind} → ${how}`),
    issue: (kind, line, msg) => issues.push({ kind, line, msg }),
    link(href) {
      if (/^broken:/.test(href)) return null;
      const m = /^(?:https:\/\/docs\.example\.com)?(\/[^#]*?)(?:\.md)?(#.*)?$/.exec(href);
      return m ? m[1] + (m[2] ?? "") : href;
    },
    image(src, { alt, caption, darkSrc }) {
      images.push({ src, alt, caption, darkSrc });
      return { src: `/docs-assets/x/${images.length}.png`, alt: alt || caption || "generated alt" };
    },
    file: (i, src) => ({ href: `/docs-assets/x/file-${i}.csv`, name: "template.csv", ext: "csv", size: "2KB" }),
    video: () => "intro-video",
    pageInfo: (href) => (href.includes("/guides/setup") ? { title: "Setup", description: "Set it up in five minutes." } : null),
    ...over,
  };
  return { ctx, counts, issues, images };
}
const convert = (md, over) => {
  const t = makeCtx(over);
  return { out: convertBody(md, 0, t.ctx), ...t };
};

/** Directive structure as docs:check sees it: every opener closed, inner fewer colons than outer. */
function assertBalanced(md) {
  const stack = [];
  let fence = false;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) continue;
    const open = /^\s*(:{3,})([A-Za-z][\w-]*)/.exec(line);
    if (open) {
      const top = stack[stack.length - 1];
      if (top) assert.ok(open[1].length < top, `:::${open[2]} (${open[1].length}) inside a ${top}-colon block in:\n${md}`);
      stack.push(open[1].length);
      continue;
    }
    const close = /^\s*(:{3,})\s*$/.exec(line);
    if (close) assert.equal(close[1].length, stack.pop(), `closing ${close[1]} mismatched in:\n${md}`);
  }
  assert.equal(stack.length, 0, `unclosed directives in:\n${md}`);
}

test("page envelope: preamble, title, description, agent footer", () => {
  const src = [
    "> For the complete documentation index, see [llms.txt](https://docs.example.com/llms.txt). Markdown versions of documentation pages are available by appending `.md`.",
    "",
    "# Getting set up",
    "",
    "Everything you need before your first run",
    "",
    "Body starts here.",
    "",
    "",
    "---",
    "",
    "# Agent Instructions",
    "Ask things.",
  ].join("\n");
  const p = parseGitbookPage(src, "Everything you need before your first run");
  assert.equal(p.title, "Getting set up");
  assert.equal(p.description, "Everything you need before your first run");
  assert.equal(p.body, "Body starts here.\n");
  assert.equal(p.bodyLine, 6);
  // No llms.txt description: the first paragraph stays in the body.
  const q = parseGitbookPage(src, "");
  assert.equal(q.description, "");
  assert.match(q.body, /^Everything you need/);
});

test("hints map to callouts", () => {
  const { out, counts } = convert(['{% hint style="info" %}', "Info.", "{% endhint %}", "", '{% hint style="success" %}', "Yay.", "{% endhint %}", '{% hint style="warning" %}', "Careful.", "{% endhint %}", '{% hint style="danger" %}', "Stop.", "{% endhint %}"].join("\n"));
  assert.match(out, /:::note\nInfo\.\n:::/);
  assert.match(out, /:::tip\nYay\.\n:::/);
  assert.match(out, /:::warning\nCareful\.\n:::/);
  assert.match(out, /:::danger\nStop\.\n:::/);
  assert.equal(counts.filter((c) => c.startsWith("hint")).length, 4);
  assertBalanced(out);
});

test("tabs with a nested hint get more colons outside", () => {
  const { out } = convert(["{% tabs %}", '{% tab title="macOS" %}', "Use brew.", "", '{% hint style="info" %}', "Needs Homebrew.", "{% endhint %}", "{% endtab %}", '{% tab title="Linux [beta]" %}', "Use curl.", "{% endtab %}", "{% endtabs %}"].join("\n"));
  assert.match(out, /^:::::tabs$/m);
  assert.match(out, /^::::tab\[macOS\]$/m);
  assert.match(out, /^::::tab\[Linux \(beta\)\]$/m);
  assert.match(out, /^:::note$/m);
  assertBalanced(out);
});

test("stepper: one ### heading per step, other headings below it, untitled steps named", () => {
  const { out, issues } = convert(["{% stepper %}", "{% step %}", "## Install", "Run it.", "### Details", "More.", "{% endstep %}", "{% step %}", "**Configure**", "Edit the file.", "{% endstep %}", "{% step %}", "Just text.", "{% endstep %}", "{% endstepper %}"].join("\n"));
  assert.match(out, /^:::steps$/m);
  assert.match(out, /^### Install$/m);
  assert.match(out, /^#### Details$/m);
  assert.match(out, /^### Configure$/m);
  assert.match(out, /^### Step 3$/m);
  assert.ok(issues.some((i) => i.kind === "stepper"));
  assertBalanced(out);
});

test("content-refs in a row become one card grid", () => {
  const { out } = convert(['{% content-ref url="/guides/setup.md" %}', "[setup.md](/guides/setup.md)", "{% endcontent-ref %}", "", '{% content-ref url="https://docs.example.com/guides/other.md" %}', "[Other guide](https://docs.example.com/guides/other.md)", "{% endcontent-ref %}"].join("\n"));
  const grids = out.match(/^::::cards$/gm) ?? [];
  assert.equal(grids.length, 1);
  assert.match(out, /:::card\[setup\.md\]\{href="\/guides\/setup"\}\nSet it up in five minutes\.\n:::/);
  assert.match(out, /:::card\[Other guide\]\{href="\/guides\/other"\}/);
  assertBalanced(out);
});

test("embeds: first video is a ::video slot, the rest ::embed", () => {
  const { out } = convert(['{% embed url="https://www.youtube.com/watch?v=abcdef12345" %}', "Product tour", "{% endembed %}", "", '{% embed url="https://youtu.be/zzzzzz99999" %}', "", '{% embed url="https://www.figma.com/file/x" %}'].join("\n"));
  assert.match(out, /^::video\{id="intro-video" title="Product tour"\}$/m);
  assert.match(out, /^::embed\{src="https:\/\/youtu\.be\/zzzzzz99999" title="youtu\.be"\}$/m);
  assert.match(out, /^::embed\{src="https:\/\/www\.figma\.com\/file\/x" title="www\.figma\.com"\}$/m);
  assert.equal(videoEmbedUrl("https://www.youtube.com/watch?v=abcdef12345"), "https://www.youtube-nocookie.com/embed/abcdef12345");
  assert.equal(videoEmbedUrl("https://vimeo.com/123456"), "https://player.vimeo.com/video/123456");
  assert.equal(videoEmbedUrl("https://www.loom.com/share/abc123"), "https://www.loom.com/embed/abc123");
});

test("file blocks become a download card", () => {
  const { out } = convert('{% file src="/files/abc123" %}');
  assert.match(out, /::::cards\n:::card\[template\.csv\]\{href="\/docs-assets\/x\/file-0\.csv" icon="download"\}\nCSV file, 2KB\n:::\n::::/);
  const none = convert('{% file src="/files/zzz" %}', { file: () => null });
  assert.match(none.out, /:::note/);
  assert.ok(none.issues.some((i) => i.kind === "file"));
});

test("code titles move into the fence; prompts become soft-wrapped titled text fences", () => {
  const { out, counts } = convert(['{% code title="app.js" lineNumbers="true" %}', "```js", "run()", "```", "{% endcode %}", "", '{% prompt description="Summarise" icon="star" %}', "", "```markdown", "Summarise [doc].", "```", "", "{% endprompt %}"].join("\n"));
  assert.match(out, /^```js title="app\.js"$/m);
  assert.match(out, /^```text wrap title="Summarise"$/m);
  assert.ok(counts.some((c) => c.includes("dropped: lineNumbers")));
  // A prompt without its own fence gets one.
  const bare = convert(['{% prompt description="Find people" %}', "Find candidates in Berlin.", "{% endprompt %}"].join("\n")).out;
  assert.match(bare, /^```text wrap title="Find people"\nFind candidates in Berlin\.\n```$/m);
});

test("Font Awesome names → design-system icons", () => {
  assert.equal(faName("bolt"), "zap");
  assert.equal(faName("fa-hand-wave"), "wave");
  assert.equal(faName("desktop"), "monitor");
  assert.equal(faName("lightbulb-regular"), "bulb");
  assert.equal(faName("chess-rook"), undefined);
  assert.equal(faIcon("fa-regular fa-lightbulb"), "bulb", "the style class is skipped");
});

test("tags inside code fences are left alone", () => {
  const { out } = convert(["```liquid", '{% hint style="info" %}', "{% endhint %}", "```"].join("\n"));
  assert.match(out, /\{% hint style="info" %\}/);
  assert.doesNotMatch(out, /:::note/);
});

test("columns flatten, if keeps content and reports, unknown blocks keep content", () => {
  const { out, issues } = convert(["{% columns %}", '{% column width="50%" %}', "Left.", "{% endcolumn %}", "{% column %}", "Right.", "{% endcolumn %}", "{% endcolumns %}", '{% if visitor.claims.plan == "pro" %}', "Pro only.", "{% endif %}", "{% fancything %}", "Inside.", "{% endfancything %}"].join("\n"));
  assert.match(out, /Left\.\n\nRight\./);
  assert.match(out, /Pro only\./);
  assert.match(out, /Inside\./);
  assert.ok(issues.some((i) => i.kind === "if"));
  assert.ok(issues.some((i) => i.kind === "fancything"));
  assert.doesNotMatch(out, /\{%/);
});

test("include and openapi become notes and are reported", () => {
  const { out, issues } = convert(['{% include "../shared/footer.md" %}', "", '{% openapi src="https://api.example.com/openapi.json" path="/pets" method="get" %}', "[openapi.json](https://api.example.com/openapi.json)", "{% endopenapi %}"].join("\n"));
  assert.equal((out.match(/^:::note$/gm) ?? []).length, 2);
  assert.match(out, /\(\[source\]\(https:\/\/api\.example\.com\/openapi\.json\)\)/);
  assert.deepEqual(issues.map((i) => i.kind).sort(), ["include", "openapi"]);
});

test("<details> becomes :::details[summary]", () => {
  const { out } = convert(["<details>", "", "<summary>Why <strong>this</strong>?</summary>", "", "Because.", "", "</details>"].join("\n"));
  assert.match(out, /:::details\[Why this\?\]\nBecause\.\n:::/);
});

test("figures: caption is the alt when GitBook has none; dark <source> is passed on", () => {
  const html = '<figure><picture><source srcset="https://cdn.example.com/dark.png" media="(prefers-color-scheme: dark)"><img src="https://cdn.example.com/light.png?alt=media&amp;token=1" alt=""></picture><figcaption><p>The <strong>Settings</strong> page</p></figcaption></figure>';
  const { out, images } = convert(html);
  assert.equal(images[0].src, "https://cdn.example.com/light.png?alt=media&token=1");
  assert.equal(images[0].darkSrc, "https://cdn.example.com/dark.png");
  assert.equal(out.trim(), '![The Settings page](/docs-assets/x/1.png "The Settings page")');
});

test("markdown images: escaped URLs are unescaped", () => {
  const { images } = convert("![Logo](https://cdn.example.com/a.png?alt=media\\&token=2)");
  assert.equal(images[0].src, "https://cdn.example.com/a.png?alt=media&token=2");
});

test("card tables become cards with icons and targets; covers are reported", () => {
  const html =
    '<table data-view="cards"><thead><tr><th></th><th></th><th data-hidden data-card-cover data-type="image">Cover</th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody>' +
    '<tr><td><i class="fa-bolt">:bolt:</i> <strong>Fast start</strong></td><td>Go in a minute</td><td><a href="https://cdn.example.com/c.svg">c.svg</a></td><td><a href="/guides/setup.md">Setup</a></td></tr>' +
    '<tr><td><a href="/guides/other.md"><strong>Other</strong></a></td><td>More</td><td></td><td></td></tr></tbody></table>';
  const { out, issues } = convert(html);
  assert.match(out, /::::cards\n:::card\[Fast start\]\{href="\/guides\/setup" icon="zap"\}\nGo in a minute\n:::\n:::card\[Other\]\{href="\/guides\/other"\}\nMore\n:::\n::::/);
  assert.ok(issues.some((i) => /cover/.test(i.msg)));
  assert.equal(faIcon("fa-user-group"), "users");
});

test("HTML tables become GFM tables (pipes escaped, hidden columns dropped)", () => {
  const html = '<table><thead><tr><th width="100">Name</th><th data-hidden>Secret</th><th>Value</th></tr></thead><tbody><tr><td>a|b</td><td>x</td><td><code>1</code> <a href="/guides/setup.md">setup</a></td></tr></tbody></table>';
  const { out } = convert(html);
  assert.equal(out.trim(), ["| Name | Value |", "| --- | --- |", "| a\\|b | `1` [setup](/guides/setup) |"].join("\n"));
});

test("inline HTML becomes Markdown; autolinks survive; leftovers are reported", () => {
  const { out, issues } = convert("Press <kbd>Ctrl</kbd> or mail <help@example.com>, see <a href=\"https://docs.example.com/guides/setup.md\">setup</a> and <mark style=\"color:red;\">this</mark>. <blink>old</blink>");
  assert.equal(out.trim(), "Press :kbd[Ctrl] or mail <help@example.com>, see [setup](/guides/setup) and this. <blink>old</blink>");
  const r = convert("A <u>word</u> and <abbr title='x'>HTML</abbr>.");
  assert.equal(r.out.trim(), "A word and HTML.");
  assert.ok(r.issues.some((i) => i.kind === "html"));
  void issues;
});

test("broken links become plain text", () => {
  const { out } = convert("See [the old page](broken://pages/123) now.");
  assert.equal(out.trim(), "See the old page now.");
});

test("headings: body H1s shift down, empty ones go, bold wrappers come off", () => {
  const { out } = convert(["# Big", "", "## **Bold one**", "", "## ", "", "### <br>", "text"].join("\n"));
  assert.equal(out.trim(), ["## Big", "", "### Bold one", "", "text"].join("\n"));
});

test("trimDescription keeps whole sentences or words", () => {
  const long = "First sentence is here and it is long enough to count as a description. " + "x".repeat(120);
  assert.equal(trimDescription(long), "First sentence is here and it is long enough to count as a description.");
  const words = "word ".repeat(60);
  const t = trimDescription(words);
  assert.ok(t.length <= 160 && t.endsWith("…"));
  assert.equal(trimDescription("short"), "short");
});

test("firstParagraph skips headings, directives and images", () => {
  assert.equal(firstParagraph(["## Head", "", ":::note", "x", ":::", "", "![a](b)", "", "The **real** [first](/x) one.", "", "Next."].join("\n")), "x");
  assert.equal(firstParagraph(["## Head", "", "The **real** [first](/x) one."].join("\n")), "The real first one.");
});

test("tag attributes and HTML entities", () => {
  assert.deepEqual(tagAttrs(`style="info" title='A "b"' lineNumbers=true fullWidth`), { style: "info", title: 'A "b"', lineNumbers: "true", fullWidth: "true" });
  assert.deepEqual(tagAttrs(`"../x.md"`), { _: "../x.md" });
  assert.equal(decodeEntities("a &amp; b &#x27;c&#39; &mdash;"), "a & b 'c' —");
  assert.equal(inlineMarkdown(parseHtml("<p>One</p><p>Two <em>three</em></p>")), "One Two *three*");
});

test("heading ids match the engine's slugger", () => {
  const ids = headingIds(["## Step 1 — Do it", "```", "## not a heading", "```", "## Step 1 — Do it", "### A & B"].join("\n")).map((h) => h.id);
  assert.deepEqual(ids, ["step-1--do-it", "step-1--do-it-1", "a--b"]);
  const s = createSlugger();
  assert.equal(s("Hello, World!"), "hello-world");
});

test("site: llms.txt sections, sidebar groups, brand, file links", () => {
  const site = createSite("https://docs.example.com");
  const llms = ["# Example", "", "## Guides", "", "- [Welcome](https://docs.example.com/readme.md): Start here", "- [Setup](https://docs.example.com/guides/setup.md)", "", "## API", "- [Auth](https://docs.example.com/api/auth.md): Tokens", "", "---", "# Agent Instructions", "- [Nope](https://docs.example.com/x.md)"].join("\n");
  const sections = site.parseLlms(llms);
  assert.equal(sections.length, 2);
  assert.deepEqual(sections[0].pages.map((p) => p.gb), ["/", "/guides/setup"]);
  assert.equal(sections[1].pages[0].description, "Tokens");

  const html =
    '<header data-gb-site-header="true"><a href="/"><img alt="" src="https://docs.example.com/~gitbook/image?url=https%3A%2F%2Fcdn.example.com%2Flogo.png&amp;width=32"/><div>Example Docs</div></a></header>' +
    '<style>:root{--primary-original: 37 99 235;}</style><link rel="icon" href="https://cdn.example.com/fav.png"/>' +
    '<aside><div><a href="/"><div>Example Docs</div></a></div><div data-testid="toc-scroll-container"><ul>' +
    '<li><a href="/"><span>Welcome</span></a></li>' +
    '<li><div><button type="button"><span>Guides</span></button></div><div><ul><li><a href="/guides/setup"><svg><path d="x"/></svg><span>Setup</span></a><ul><li><a href="/guides/setup/deep"><span>Deep</span></a></li></ul></li></ul></div></li>' +
    '<li><a href="https://status.example.com"><span>Status</span></a></li>' +
    '</ul></div><a href="https://www.gitbook.com/powered-by?x"><span>Powered by GitBook</span></a></aside>';
  const sb = site.parseSidebar(html);
  assert.deepEqual(sb.groups.map((g) => g.group), [null, "Guides"]);
  assert.deepEqual(sb.groups[1].items.map((i) => [i.gb, i.title, i.depth]), [["/guides/setup", "Setup", 0], ["/guides/setup/deep", "Deep", 1]]);
  assert.deepEqual(sb.external, [{ href: "https://status.example.com", title: "Status" }]);
  const b = site.detectBrand(html);
  assert.equal(b.siteName, "Example Docs");
  assert.equal(b.logo, "https://cdn.example.com/logo.png");
  assert.equal(b.wordmark, false);
  assert.equal(b.accent, "#2563eb");
  assert.equal(b.favicon, "https://cdn.example.com/fav.png");
  assert.equal(site.gbPathOf("https://docs.example.com/guides/setup.md#x"), "/guides/setup");
  assert.equal(site.gbPathOf("https://other.example.com/a"), null);
  const files = site.fileLinks('<div><a class="hover:underline" target="_blank" href="https://x-files.gitbook.io/~/files/v0/b/o/a.xlsx?alt=media&amp;t=1">a.xlsx</a></div><div class="s">10KB</div>');
  assert.deepEqual(files, [{ url: "https://x-files.gitbook.io/~/files/v0/b/o/a.xlsx?alt=media&t=1", name: "a.xlsx", size: "10KB" }]);
});

test("brand: GitBook's light and dark logos; one image for both means no dark logo", () => {
  const site = createSite("https://docs.example.com");
  const head = (light, dark) =>
    `<header data-gb-site-header="true"><a href="/"><img alt="" class="block dark:hidden size-8" src="https://docs.example.com/~gitbook/image?url=${encodeURIComponent(light)}&amp;width=32"/>` +
    `<img alt="" class="hidden dark:block size-8" src="https://docs.example.com/~gitbook/image?url=${encodeURIComponent(dark)}&amp;width=32"/><div>Example</div></a></header>`;
  const two = site.detectBrand(head("https://cdn.example.com/logo.png", "https://cdn.example.com/logo-dark.png"));
  assert.equal(two.logo, "https://cdn.example.com/logo.png");
  assert.equal(two.logoDark, "https://cdn.example.com/logo-dark.png");
  const one = site.detectBrand(head("https://cdn.example.com/logo.png", "https://cdn.example.com/logo.png"));
  assert.equal(one.logo, "https://cdn.example.com/logo.png");
  assert.equal(one.logoDark, null);
});

test("page icons from GitBook's sidebar data", () => {
  const site = createSite("https://docs.example.com");
  const html =
    '<script>self.__next_f.push([1,"{\\"pages\\":[{\\"id\\":\\"a\\",\\"title\\":\\"Welcome\\",\\"href\\":\\"/\\",\\"icon\\":\\"hand-wave\\",\\"type\\":\\"document\\"},' +
    '{\\"id\\":\\"b\\",\\"title\\":\\"Setup\\",\\"href\\":\\"/guides/setup\\",\\"icon\\":\\"bolt\\"},{\\"id\\":\\"c\\",\\"title\\":\\"Plain\\",\\"href\\":\\"/guides/plain\\"}]}"])</script>';
  assert.deepEqual([...site.pageIcons(html)], [["/", "hand-wave"], ["/guides/setup", "bolt"]]);
  assert.equal(site.pageIcons("").size, 0);
});

test("isOpaqueImage: PNG colour types and tRNS, JPEG, WebP", () => {
  const png = (colorType, chunks = []) => {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write("IHDR", 4, "latin1");
    ihdr.writeUInt32BE(32, 8);
    ihdr.writeUInt32BE(32, 12);
    ihdr[16] = 8;
    ihdr[17] = colorType;
    const rest = chunks.map((t) => {
      const c = Buffer.alloc(13);
      c.writeUInt32BE(1, 0);
      c.write(t, 4, "latin1");
      return c;
    });
    return Buffer.concat([sig, ihdr, ...rest, Buffer.from([0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54, 0, 0, 0, 0])]);
  };
  assert.equal(isOpaqueImage(png(2)), true, "RGB");
  assert.equal(isOpaqueImage(png(3)), true, "palette without tRNS");
  assert.equal(isOpaqueImage(png(3, ["tRNS"])), false, "palette with tRNS");
  assert.equal(isOpaqueImage(png(6)), false, "RGBA");
  assert.equal(isOpaqueImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)])), true, "JPEG");
  const webp = (chunk, flags = 0) => {
    const b = Buffer.alloc(40);
    b.write("RIFF", 0, "latin1");
    b.write("WEBP", 8, "latin1");
    b.write(chunk, 12, "latin1");
    b[20] = flags;
    return b;
  };
  assert.equal(isOpaqueImage(webp("VP8 ")), true);
  assert.equal(isOpaqueImage(webp("VP8X", 0x10)), false);
  assert.equal(isOpaqueImage(webp("VP8L")), false);
  assert.equal(isOpaqueImage(Buffer.from("<svg/>")), false);
});
