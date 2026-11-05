/**
 * Hammer the page editor like a real user, on the real stack. Each step checks the saved Markdown.
 *   BROWSER=chromium|webkit [ONLY=…] node bughunt.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { APP, SHOTS, BROWSER, log, fail, seedNow, api, mcp, mcpToken, docOf, launch, ctx, shot, stepper, saveState } from "./lib.mjs";

const S = seedNow();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const browser = await launch();
const { step, results } = stepper(browser);
// The editor's shortcuts follow the OS, not the engine: Meta on macOS (Chromium and WebKit alike), Control
// on Linux (CI). And macOS's line end is Meta+ArrowRight (End scrolls the page there); Linux's is End.
const mod = process.platform === "darwin" ? "Meta" : "Control";
const lineEnd = process.platform === "darwin" ? "Meta+ArrowRight" : "End";
const content = async (slug) => (await docOf(slug, T.owner)).content;
// auto_cover: false — these checks compare the saved Markdown exactly (a new page otherwise gets an automatic cover).
const newPage = async (title, body = "\n") => (await api("POST", "/api/v1/pages", T.owner, { title, workspace: S.ws, folder: S.folder, content: body, auto_cover: false })).body.document.slug;

/** Wait until the editor says Saved and the server has a version that satisfies `pred`. */
async function settle(p, slug, pred = () => true, timeout = 20000) {
  const t0 = Date.now();
  let md = "";
  while (Date.now() - t0 < timeout) {
    await p.waitForTimeout(700);
    const status = await saveState(p);
    md = await content(slug);
    if (status === "saved" && pred(md)) return md;
  }
  return md;
}
async function openEditor(p, slug) {
  await p.goto(`${APP}/${slug}?edit=1`, { waitUntil: "networkidle" });
  await p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 30000 });
  await p.waitForTimeout(800);
}
async function clickText(p, text) {
  await p.locator(".pb-live .ProseMirror").getByText(text, { exact: false }).first().click();
  await p.waitForTimeout(250);
}

/* Turn into: every kind from text and back, and between kinds. */
await step("turn-into", async () => {
  const kinds = ["text", "h1", "h2", "h3", "todo", "bullet", "numbered", "toggle", "code", "quote"];
  const expect = { h1: "# Alpha", h2: "## Alpha", h3: "### Alpha", todo: "- [ ] Alpha", bullet: "- Alpha", numbered: "1. Alpha", toggle: ':::details{summary="Alpha"}', code: "```\nAlpha\n```", quote: "> Alpha" };
  const problems = [];
  for (let i = 1; i < kinds.length; i++) {
    const k = kinds[i];
    const slug = await newPage(`Turn ${k}`, "Before\n\nAlpha\n\nAfter\n");
    const { c, p } = await ctx(browser, { token: T.owner });
    await openEditor(p, slug);
    await clickText(p, "Alpha");
    await p.keyboard.press(`${mod}+Alt+${i}`);
    let md = await settle(p, slug, (m) => m.includes(expect[k]));
    if (!md.includes(expect[k])) problems.push(`text→${k}: ${JSON.stringify(md)}`);
    if (!/Before[\s\S]*After/.test(md)) problems.push(`text→${k} lost neighbours: ${JSON.stringify(md)}`);
    // …then another kind (heading 2), then back to text.
    if (k !== "toggle") {
      await p.keyboard.press(`${mod}+Alt+2`);
      md = await settle(p, slug, (m) => m.includes("## Alpha"));
      if (!md.includes("## Alpha")) problems.push(`${k}→h2: ${JSON.stringify(md)}`);
      await p.keyboard.press(`${mod}+Alt+0`);
      md = await settle(p, slug, (m) => /\n\nAlpha\n\n/.test(m));
      if (md !== "Before\n\nAlpha\n\nAfter\n") problems.push(`${k}→h2→text: ${JSON.stringify(md)}`);
    }
    await c.close();
  }
  if (problems.length) fail(problems.join("\n"));
});

/* Fast typing, Enter between blocks, then undo all and redo all. */
await step("typing-undo", async () => {
  const slug = await newPage("Typing");
  const { c, p } = await ctx(browser, { token: T.owner });
  await openEditor(p, slug);
  await p.locator(".pb-live .ProseMirror").click();
  await p.waitForTimeout(250);
  const lines = ["First line typed fast with **bold** words", "## A heading", "- one", "two", "", "Last paragraph 1234567890 the quick brown fox."];
  for (const [i, l] of lines.entries()) {
    await p.keyboard.type(l, { delay: 0 });
    if (i < lines.length - 1) await p.keyboard.press("Enter");
  }
  const want = "First line typed fast with **bold** words\n\n## A heading\n\n- one\n- two\n\nLast paragraph 1234567890 the quick brown fox.\n";
  let md = await settle(p, slug, (m) => m === want);
  if (md !== want) fail(`fast typing saved ${JSON.stringify(md)}`);
  // Undo everything (history across blocks), then redo everything.
  for (let i = 0; i < 80; i++) await p.keyboard.press(`${mod}+z`);
  md = await settle(p, slug, (m) => !m.trim());
  if (md.trim()) fail(`undo all left ${JSON.stringify(md)}`);
  for (let i = 0; i < 80; i++) await p.keyboard.press(`${mod}+Shift+z`);
  md = await settle(p, slug, (m) => m === want);
  if (md !== want) {
    // Say more: is it the count (more redos finish it) or a lost history item (nothing more to redo)?
    const shown = await p.locator(".pb-live .ProseMirror").innerText();
    for (let i = 0; i < 40; i++) await p.keyboard.press(`${mod}+Shift+z`);
    const more = await settle(p, slug, (m) => m === want, 8000);
    fail(`redo all saved ${JSON.stringify(md)}; editor showed ${JSON.stringify(shown.slice(-120))}; 40 more redos saved ${JSON.stringify(more.slice(-60))}`);
  }
  await c.close();
});

/* Drag a block by its handle above another. */
await step("drag", async () => {
  const slug = await newPage("Drag", "One\n\nTwo\n\nThree\n");
  const { c, p } = await ctx(browser, { token: T.owner });
  await openEditor(p, slug);
  const three = p.locator(".pb-live .ProseMirror p", { hasText: "Three" });
  await three.hover();
  const handle = p.getByRole("button", { name: /Move or change this/ }).first();
  await handle.waitFor({ timeout: 5000 });
  // Drop on the top edge of the first block: the block goes above it.
  const one = p.locator(".pb-live .ProseMirror p", { hasText: "One" });
  await handle.dragTo(one, { targetPosition: { x: Number(process.env.DX ?? 40), y: 2 } });
  const md = await settle(p, slug, (m) => m.startsWith("Three"));
  if (md !== "Three\n\nOne\n\nTwo\n") fail(`drag saved ${JSON.stringify(md)}`);
  await c.close();
});

/* Paste: a Notion export (HTML), a Google Docs clipboard (HTML), GitHub Markdown (plain text). */
const NOTION = `<meta charset="utf-8"><h2>Meeting</h2><p>Some <strong>bold</strong> and <em>italic</em> text with a <a href="https://example.com">link</a>.</p><ul><li>First</li><li>Second<ul><li>Nested</li></ul></li></ul><ul class="to-do-list"><li><div class="checkbox checkbox-off"></div> <span class="to-do-children-unchecked">Open task</span></li></ul><blockquote>A quote</blockquote><pre><code class="language-js">const x = 1;</code></pre><table><tbody><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></tbody></table>`;
const GDOCS = `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1234"><h1 dir="ltr" style="line-height:1.38;margin-top:20pt;margin-bottom:6pt;"><span style="font-size:20pt;font-family:Arial;color:#000000;font-weight:400;">Quarterly review</span></h1><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial;color:#000000;font-weight:700;">Bold lead</span><span style="font-size:11pt;font-family:Arial;color:#000000;font-weight:400;"> then plain and </span><span style="font-size:11pt;font-family:Arial;color:#000000;font-weight:400;font-style:italic;">italic</span></p><ol style="margin-top:0;margin-bottom:0;padding-inline-start:48px;"><li dir="ltr" style="list-style-type:decimal;font-size:11pt;" aria-level="1"><p dir="ltr" role="presentation"><span style="font-size:11pt;">Step one</span></p></li><li dir="ltr" style="list-style-type:decimal;font-size:11pt;" aria-level="1"><p dir="ltr" role="presentation"><span style="font-size:11pt;">Step two</span></p></li></ol></b>`;
const GITHUB = "## Install\n\n```bash\nnpm i markdrop\n```\n\n- [x] Done\n- [ ] Todo\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n> [!NOTE]\n> GitHub alert\n";
await step("paste", async () => {
  const problems = [];
  for (const [name, html, text, wants] of [
    ["notion", NOTION, "Meeting", ["## Meeting", "**bold**", "*italic*", "[link](https://example.com)", "- First", "  - Nested", "> A quote", "```js", "const x = 1;", "| a | b |"]],
    ["gdocs", GDOCS, "Quarterly review", ["# Quarterly review", "**Bold lead**", "*italic*", "1. Step one", "2. Step two"]],
    ["github", null, GITHUB, ["## Install", "```bash", "npm i markdrop", "- [x] Done", "- [ ] Todo", "| a | b |"]],
  ]) {
    const slug = await newPage(`Paste ${name}`);
    const { c, p } = await ctx(browser, { token: T.owner });
    await openEditor(p, slug);
    await p.locator(".pb-live .ProseMirror").click();
    await p.waitForTimeout(250);
    await p.locator(".pb-live .ProseMirror").evaluate((el, [h, t]) => {
      const dt = new DataTransfer();
      if (h) dt.setData("text/html", h);
      dt.setData("text/plain", t);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, [html, text]);
    const md = await settle(p, slug, (m) => m.trim().length > 5);
    fs.writeFileSync(path.join(SHOTS, `paste-${name}.md`), md);
    for (const w of wants) if (!md.includes(w)) problems.push(`${name} lacks ${JSON.stringify(w)}`);
    if (/<span|<b |style=|docs-internal/.test(md)) problems.push(`${name} kept raw HTML`);
    await shot(p, `60-paste-${name}`, { wait: 500 });
    await c.close();
  }
  if (problems.length) fail(problems.join("\n"));
});

/* A 300-block page: open it and type; per-key latency stays low. */
await step("long-page", async () => {
  const body = Array.from({ length: 300 }, (_, i) => (i % 10 === 0 ? `## Section ${i / 10}` : i % 3 === 0 ? `- item ${i}` : `Paragraph ${i} with some text to make it a realistic length for a page.`)).join("\n\n") + "\n";
  const slug = await newPage("Long page", body);
  const { c, p } = await ctx(browser, { token: T.owner });
  const t0 = Date.now();
  await openEditor(p, slug);
  log("300 blocks open in", Date.now() - t0, "ms");
  await clickText(p, "Paragraph 151");
  await p.keyboard.press(lineEnd); // macOS: End scrolls the page
  await p.waitForTimeout(250);
  // Long tasks while typing.
  await p.evaluate(() => {
    window.__long = [];
    try { new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ type: "longtask", buffered: false }); } catch {}
  });
  const lat = await p.evaluate(async () => {
    const ed = document.querySelector(".pb-live .ProseMirror");
    const times = [];
    for (let i = 0; i < 40; i++) {
      const t = performance.now();
      document.execCommand("insertText", false, "x");
      await new Promise((r) => requestAnimationFrame(() => r()));
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    return { p50: times[20], p95: times[38], max: times[39], n: ed.children.length };
  });
  log("keystroke→frame ms", JSON.stringify(lat));
  await p.keyboard.type(" typed");
  const md = await settle(p, slug, (m) => m.includes("x typed"));
  if (!md.includes("Paragraph 151 with some text to make it a realistic length for a page." + "x".repeat(40) + " typed")) fail("long page edit not saved right");
  const longTasks = await p.evaluate(() => window.__long);
  log("long tasks while typing", JSON.stringify(longTasks.map((d) => Math.round(d))));
  if (md.split("\n").filter(Boolean).length < 300) fail("blocks lost");
  if (lat.p95 > 50) fail(`slow typing on a 300-block page: ${JSON.stringify(lat)}`);
  await c.close();
});

/* Typing on a 300-block page with images and embeds, CPU throttled 4× (Chromium): no long task over
   100 ms, and nothing from the Markdown parser (pageRefs) while keys are going in. */
await step("perf-typing", async () => {
  if (BROWSER !== "chromium") return log("perf-typing: Chromium only (CPU throttling and the profiler)");
  const body = Array.from({ length: 300 }, (_, i) =>
    i % 50 === 25 ? `![Figure ${i}](asset:fake${i})` : i % 50 === 40 ? '::markdrop{src="launch-plan"}' : i % 10 === 0 ? `## Section ${i / 10}` : `Paragraph ${i} with some text to make it a realistic length for a page.`,
  ).join("\n\n") + "\n";
  const slug = await newPage("Perf typing", body);
  const { c, p } = await ctx(browser, { token: T.owner });
  await openEditor(p, slug);
  await clickText(p, "Paragraph 151");
  await p.keyboard.press(lineEnd);
  const cdp = await c.newCDPSession(p);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.CPU || 4) });
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await p.evaluate(() => {
    window.__lt = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push(Math.round(e.duration)))).observe({ type: "longtask" });
  });
  await cdp.send("Profiler.start");
  for (let i = 0; i < 3; i++) {
    await p.keyboard.type(" quick brown fox jumps over", { delay: 30 });
    await p.keyboard.press("Enter");
    await p.keyboard.type("a new line here", { delay: 30 });
  }
  const typing = await p.evaluate(() => window.__lt.slice());
  await p.waitForTimeout(1200); // the settled work after the last key
  const { profile: prof } = await cdp.send("Profiler.stop");
  const all = await p.evaluate(() => window.__lt.slice());
  // Self time per function, and the total under the Markdown parser.
  const byId = new Map(prof.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of prof.nodes) for (const ch of n.children ?? []) parent.set(ch, n.id);
  // The production build has no function names: the parser is whatever runs in the chunk that holds
  // mdast-util-from-markdown (its "Cannot close document" message) or micromark's tokenizer.
  const urls = [...new Set(prof.nodes.map((n) => n.callFrame.url).filter((u) => u.startsWith(APP)))];
  const parserFiles = new Set();
  for (const u of urls) if (/Cannot close document|micromark/.test(await (await fetch(u)).text())) parserFiles.add(u);
  const self = new Map();
  let parser = 0;
  const callers = new Map();
  prof.samples.forEach((id, i) => {
    const us = prof.timeDeltas[i] ?? 0;
    const f = byId.get(id).callFrame;
    const key = `${f.functionName || "(anon)"} ${(f.url || "").split("/").pop().slice(0, 40)}:${f.lineNumber}`;
    self.set(key, (self.get(key) ?? 0) + us);
    if (parserFiles.has(f.url)) {
      parser += us;
      // Who called the parser: the first frame outside its chunks.
      let x = id;
      while (x != null && parserFiles.has(byId.get(x).callFrame.url)) x = parent.get(x);
      const cf = x != null ? byId.get(x).callFrame : null;
      const k = cf ? `${cf.url.split("/").pop()}:${cf.lineNumber}:${cf.columnNumber}` : "(root)";
      callers.set(k, (callers.get(k) ?? 0) + us);
    }
  });
  for (const [k, us] of [...callers].sort((a, b) => b[1] - a[1]).slice(0, 4)) log("   parser called from", k, Math.round(us / 1000), "ms");
  log("parser chunks:", [...parserFiles].map((u) => u.split("/").pop()).join(", "));
  const top = [...self].filter(([k]) => !/^\((idle|program|garbage collector)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 8);
  log("long tasks while typing", JSON.stringify(typing), "| after", JSON.stringify(all.slice(typing.length)));
  log("Markdown parser (pageRefs) time:", Math.round(parser / 1000), "ms");
  for (const [k, us] of top) log("   ", (us / 1000).toFixed(1).padStart(7), "ms", k);
  await c.close();
  if (typing.some((d) => d > 100)) fail(`a long task over 100 ms while typing: ${JSON.stringify(typing)}`);
  if (parser > 50000) fail(`the Markdown parser ran ${Math.round(parser / 1000)} ms while typing`);
});

/* Offline then online; offline then closed (the local draft comes back). */
await step("offline", async () => {
  const slug = await newPage("Offline", "Start\n");
  const { c, p } = await ctx(browser, { token: T.owner });
  await openEditor(p, slug);
  await clickText(p, "Start");
  await p.keyboard.press("End");
  await c.setOffline(true);
  await p.keyboard.type(" typed offline");
  await p.waitForTimeout(3500);
  const status = await saveState(p);
  log("offline status:", status);
  await shot(p, "61-offline");
  if (status !== "offline") fail(`no offline status: ${status}`);
  await c.setOffline(false);
  let md = await settle(p, slug, (m) => m.includes("typed offline"), 30000);
  if (!md.includes("Start typed offline")) fail(`not saved after coming back online: ${JSON.stringify(md)}`);
  // Offline again, type, and close the tab without it saving: reopening offers the draft.
  await c.setOffline(true);
  await p.keyboard.type(" and lost?");
  await p.waitForTimeout(500);
  await c.close();
  const d = await ctx(browser, { token: T.owner });
  // Same browser profile is needed for localStorage: reuse a persistent state via storageState.
  await d.c.close();
});

await step("draft-restore", async () => {
  const slug = await newPage("Draft", "Start\n");
  const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await c.addInitScript((t) => { try { localStorage.setItem("markdrop_token", t); localStorage.setItem("md_consent", "denied"); } catch {} }, T.owner);
  const p = await c.newPage();
  await openEditor(p, slug);
  await clickText(p, "Start");
  await p.keyboard.press("End");
  await c.setOffline(true);
  await p.keyboard.type(" typed while offline");
  await p.waitForTimeout(800);
  p.on("dialog", (dl) => void dl.accept());
  await c.setOffline(false);
  // Close before the save goes out (reload fast): the draft must be offered.
  await c.route("**/api/v1/documents/*", (r) => (r.request().method() === "PUT" ? r.abort() : r.continue()));
  await p.reload({ waitUntil: "networkidle" });
  await c.unroute("**/api/v1/documents/*");
  await p.getByText("Unsaved changes from this browser").waitFor({ timeout: 20000 });
  await p.getByRole("button", { name: "Restore them" }).click();
  const md = await settle(p, slug, (m) => m.includes("typed while offline"));
  if (!md.includes("Start typed while offline")) fail(`draft not restored: ${JSON.stringify(md)}`);
  await c.close();
});

/* An AI app appends while the page is open: no local copy is left behind to be offered later as
   "unsaved changes", and nobody else signing in on this browser is offered one. */
await step("draft-after-append", async () => {
  const slug = await newPage("Draft after append", "Start\n");
  await api("PUT", `/api/v1/documents/${slug}/access/level`, T.owner, { level: "link" });
  const c = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await c.addInitScript(() => { try { localStorage.setItem("md_consent", "denied"); } catch {} });
  const p = await c.newPage();
  await p.goto(`${APP}/robots.txt`);
  await p.evaluate((t) => localStorage.setItem("markdrop_token", t), T.owner);
  await openEditor(p, slug);
  await clickText(p, "Start");
  await p.keyboard.press("End");
  await p.keyboard.type(" typed");
  await settle(p, slug, (m) => m.includes("Start typed"));
  const r = await mcp(mcpToken("ada@acme.test"), "append_blocks", { document: slug, markdown: "## From the AI app\n\nAppended." });
  if (r.isError) fail(r.text);
  await p.getByText("From the AI app").waitFor({ timeout: 15000 });
  await p.waitForTimeout(2500);
  const left = await p.evaluate((s) => localStorage.getItem(`md_page_draft:${s}`), slug);
  if (left) fail(`a local copy stayed after the append was in: ${left.slice(0, 120)}`);
  // Another account on this browser, straight into the editor address: no one's draft is offered.
  await p.evaluate((t) => { sessionStorage.clear(); localStorage.setItem("markdrop_token", t); }, T.member);
  await p.goto(`${APP}/${slug}?edit=1`, { waitUntil: "networkidle" });
  await p.waitForTimeout(3000);
  if (await p.getByText("Unsaved changes from this browser").count()) fail("another account is offered a draft");
  await c.close();
});

/* Two tabs of the same person editing the same page. */
await step("two-tabs", async () => {
  const slug = await newPage("Two tabs", "Shared line\n");
  const c = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await c.addInitScript((t) => { try { localStorage.setItem("markdrop_token", t); localStorage.setItem("md_consent", "denied"); } catch {} }, T.owner);
  const a = await c.newPage();
  const b = await c.newPage();
  await openEditor(a, slug);
  await openEditor(b, slug);
  await clickText(a, "Shared line");
  await a.keyboard.press("End");
  await a.keyboard.type(" from A");
  let md = await settle(a, slug, (m) => m.includes("from A"));
  await b.bringToFront();
  await b.waitForTimeout(1500);
  const bText = await b.locator(".pb-live .ProseMirror").innerText();
  log("tab B sees:", JSON.stringify(bText.slice(0, 60)));
  await clickText(b, "Shared line");
  await b.keyboard.press("End");
  await b.keyboard.type(" from B");
  await b.waitForTimeout(4500);
  md = await content(slug);
  const conflict = await b.getByText(/This page changed|same part of this page/).count();
  log("after B typed:", JSON.stringify(md), "conflict shown:", conflict);
  await shot(b, "62-two-tabs-b");
  if (!md.includes("Shared line from A")) fail(`tab B overwrote or split tab A's text: ${JSON.stringify(md)}`);
  if (!md.includes("from B") && !conflict) fail("tab B's text neither saved nor flagged");
  await c.close();
});

/* Classic ↔ blocks on an existing document: the Markdown stays byte-identical when untouched. */
await step("classic-roundtrip", async () => {
  const MD = "# Title\r\n\r\nWindows line endings, *emphasis*, __strong__, a list:\r\n\r\n* star bullet\r\n* another\r\n\r\n1) paren list\r\n\r\nSetext heading\r\n==============\r\n\r\n<div align=\"center\">raw html</div>\r\n\r\n[ref link][r]\r\n\r\n[r]: https://example.com\r\n\r\nFootnote[^1]\r\n\r\n[^1]: The note.\r\n\r\n| a |  b |\r\n|:--|--:|\r\n| 1 |  2 |\r\n\r\n    indented code\r\n\r\nTrailing spaces  \r\nhard break\r\n";
  const r = await api("POST", "/api/v1/documents", T.owner, { title: "Classic odd", content: MD, custom_slug: `classic-odd-${Date.now() % 100000}`, expires_in: "never" });
  const slug = r.body.slug;
  const sw = await api("PUT", `/api/v1/documents/${slug}/editor`, T.owner, { editor: "blocks" });
  if (sw.status !== 200) fail(`switch → ${sw.status}`);
  const { c, p } = await ctx(browser, { token: T.owner });
  const puts = [];
  p.on("request", (q) => { if (q.method() === "PUT" && q.url().endsWith(`/documents/${slug}`)) puts.push(q.postData()); });
  await openEditor(p, slug);
  await p.waitForTimeout(4000);
  await shot(p, "63-classic-odd-in-blocks", { full: true });
  await p.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
  await p.waitForTimeout(1500);
  const after = await content(slug);
  if (after !== MD) fail(`untouched Markdown changed (PUTs: ${puts.length}):\n${JSON.stringify(after)}`);
  // Back to classic.
  const back = await api("PUT", `/api/v1/documents/${slug}/editor`, T.owner, { editor: "classic" });
  if (back.status !== 200 || (await content(slug)) !== MD) fail("switching back changed it");
  // A one-word edit in the block editor changes only that line.
  await api("PUT", `/api/v1/documents/${slug}/editor`, T.owner, { editor: "blocks" });
  await openEditor(p, slug);
  await clickText(p, "another");
  await p.keyboard.press("End");
  await p.keyboard.type(" edited");
  const md = await settle(p, slug, (m) => m.includes("another edited"));
  const expect = MD.replace("* another", "* another edited");
  fs.writeFileSync(path.join(SHOTS, "classic-odd-after-edit.md"), md);
  if (md !== expect) log(`NOTE: a one-word edit rewrote more than its line (see classic-odd-after-edit.md)`);
  await c.close();
});

/* Phone, touch: tap into the text, type, the slash menu, the block menu. */
await step("phone-touch", async () => {
  const slug = await newPage("Phone", "Tap here\n\nSecond\n");
  const { c, p } = await ctx(browser, { token: T.owner, width: 390, height: 844, mobile: true });
  await openEditor(p, slug);
  await p.locator(".pb-live .ProseMirror").getByText("Tap here").tap();
  await p.waitForTimeout(300);
  await p.keyboard.press("End");
  await p.keyboard.type(" typed on a phone");
  await p.keyboard.press("Enter");
  await p.keyboard.type("/todo");
  await p.locator(".dxe-slash").first().waitFor({ timeout: 5000 });
  await shot(p, "64-phone-slash");
  await p.keyboard.press("Enter");
  await p.keyboard.type("Phone task");
  const md = await settle(p, slug, (m) => m.includes("Phone task"));
  if (!md.includes("Tap here typed on a phone") || !md.includes("- [ ] Phone task")) fail(`phone edit saved ${JSON.stringify(md)}`);
  const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 1) fail(`editor overflows the phone by ${over}px`);
  // The block menu on touch: tap the block, then its handle (or long-press).
  await p.locator(".pb-live .ProseMirror").getByText("Second").tap();
  await p.waitForTimeout(300);
  const handles = await p.getByRole("button", { name: /Move or change this|actions/ }).count();
  log("block handle buttons on touch:", handles);
  await shot(p, "65-phone-editor");
  await c.close();
});

await browser.close();
console.log(`\nResults (bug hunt, ${BROWSER}):`);
for (const [n, r] of results) console.log(`  ${r === "ok" ? "✓" : "✗"} ${n}: ${r}`);
process.exit(results.some(([, r]) => r !== "ok") ? 1 : 0);
