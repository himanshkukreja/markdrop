/**
 * Mermaid in the page editor, on the real stack (up.sh): a ```mermaid block shows its diagram
 * unless it's being edited (click: the code, Esc or a click away: the diagram again), a render error
 * shows the error and the code, and a locked page shows diagrams to the owner, an admin and a member
 * (read only). Uses the existing seed (never reseeds) and makes its own pages.
 *
 *   [SHOT_DIR=…] [ONLY=…] node mermaid.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { APP, WORK, log, fail, seedNow, api, docOf, launch, ctx, stepper, saveState } from "./lib.mjs";

const OUT = process.env.MERMAID_SHOTS || path.join(path.dirname(WORK), "senseloaf", "shots", "editor-mermaid");
fs.mkdirSync(OUT, { recursive: true });
const S = seedNow();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const browser = await launch();
const { step, results } = stepper(browser);

// The Senseloaf "lifecycle" shape: 11 nodes, edge labels, <br/> in labels, a dotted edge.
const LIFECYCLE = [
  "```mermaid",
  "flowchart TD",
  "    A[Idea<br/>from a customer call] --> B{Worth a doc?}",
  "    B -- yes --> C[Draft in the editor]",
  "    B -- no --> K[Parking lot]",
  "    C --> D[Review<br/>by the team]",
  "    D -->|changes| C",
  "    D -->|approved| E[Lock the page]",
  "    E --> F[Publish to the guide]",
  "    F --> G[Readers]",
  "    G -.->|feedback| H[Insights]",
  "    H --> I[Fix list]",
  "    I -.-> C",
  "    F --> J[(Archive)]",
  "```",
].join("\n");
const BODY = `## The lifecycle\n\nHow a page moves from an idea to the archive.\n\n${LIFECYCLE}\n\nAfter the diagram.\n`;
const BROKEN = "## Broken\n\n```mermaid\nflowchart TD\n    A[Start --> B{{oops\n```\n\nAfter.\n";

const newPage = async (title, content) => {
  const r = await api("POST", "/api/v1/pages", T.owner, { title, workspace: S.ws, folder: S.folder, content });
  if (r.status >= 300) fail(`create ${title} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body.document.slug;
};
const content = async (slug) => (await docOf(slug, T.owner)).content;

/** Console errors and page errors, per page (checked at the end of each step). */
function watch(p) {
  const errs = [];
  p.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    // A browser's own resource noise (a 4xx it logs for a probe) isn't the app's.
    if (/Failed to load resource/.test(t)) return;
    errs.push(t.slice(0, 300));
  });
  p.on("pageerror", (e) => errs.push(`pageerror: ${e.message.slice(0, 300)}`));
  return errs;
}
const noErrors = (errs, where) => {
  if (errs.length) fail(`${where}: console errors:\n  ${errs.join("\n  ")}`);
};

async function shot(p, name, opts = {}) {
  await p.waitForTimeout(opts.wait ?? 400);
  if (opts.el) await opts.el.screenshot({ path: path.join(OUT, `${name}.png`) });
  else await p.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: !!opts.full });
  log("shot", name);
}

const block = (p) => p.locator('.pb-live .dxe-code[data-lang="mermaid"]').first();
const svgIn = (p) => block(p).locator(".md-diagram__canvas svg, .md-diagram svg").first();
const codeVisible = (p) => block(p).locator(".md-codeblock__body").isVisible();

async function openEditor(p, slug, editable = true) {
  await p.goto(`${APP}/${slug}?edit=1`, { waitUntil: "networkidle" });
  await p.locator(`.pb-live .ProseMirror[contenteditable="${editable}"]`).waitFor({ timeout: 30000 });
  await p.waitForTimeout(600);
}

/** The diagram is up: an SVG with every node and edge label, the code hidden. */
async function expectDiagram(p, where) {
  await svgIn(p).waitFor({ timeout: 20000 });
  if (await codeVisible(p)) fail(`${where}: the code shows with the diagram`);
  const info = await svgIn(p).evaluate((svg) => ({
    nodes: svg.querySelectorAll("g.node").length,
    labels: [...svg.querySelectorAll(".edgeLabel")].map((e) => e.textContent.trim()).filter(Boolean),
    text: svg.textContent,
    dotted: svg.querySelectorAll('path[class*="dotted"], path.edge-pattern-dotted').length,
    scripts: svg.querySelectorAll("script").length,
  }));
  if (info.nodes < 11) fail(`${where}: ${info.nodes} nodes (want 11)`);
  for (const l of ["yes", "no", "changes", "approved", "feedback"]) if (!info.labels.includes(l)) fail(`${where}: no edge label "${l}" (${info.labels.join(", ")})`);
  if (/<br|&lt;br/i.test(info.text)) fail(`${where}: a literal <br/> in a label`);
  if (!/Idea/.test(info.text) || !/from a customer call/.test(info.text)) fail(`${where}: the <br/> label lost its text`);
  if (info.dotted < 2) fail(`${where}: ${info.dotted} dotted edges (want 2)`);
  if (info.scripts) fail(`${where}: a <script> in the SVG`);
  return info;
}

const state = {};

/* ── 1. lazy: a page without mermaid loads none of mermaid's chunks ── */
await step("lazy", async () => {
  state.plain = await newPage("No diagrams here", "## Plain\n\n```js\nconst x = 1;\n```\n\nJust text.\n");
  state.page = await newPage("Mermaid lifecycle", BODY);
  const { c, p } = await ctx(browser, { token: T.owner });
  const errs = watch(p);
  const plainJs = new Set();
  p.on("request", (r) => r.resourceType() === "script" && plainJs.add(r.url()));
  await openEditor(p, state.plain);
  await p.locator(".pb-live .ProseMirror").getByText("Just text.").click();
  await p.keyboard.type(" More.");
  await p.waitForTimeout(1500);
  if (await p.locator(".md-diagram").count()) fail("a diagram on a page without mermaid");
  const { c: c2, p: p2 } = await ctx(browser, { token: T.owner });
  const mermaidJs = [];
  p2.on("response", async (r) => {
    if (r.request().resourceType() !== "script") return;
    const len = Number(r.headers()["content-length"] || (await r.body().catch(() => Buffer.alloc(0))).length);
    mermaidJs.push({ url: r.url(), len });
  });
  await openEditor(p2, state.page);
  await svgIn(p2).waitFor({ timeout: 20000 });
  const extra = mermaidJs.filter((s) => !plainJs.has(s.url));
  const big = extra.filter((s) => s.len > 200_000);
  log(`mermaid page loads ${extra.length} more scripts; big: ${big.map((b) => `${path.basename(b.url)} ${Math.round(b.len / 1024)} KB`).join(", ")}`);
  if (!big.length) fail("no big script only on the mermaid page (is mermaid in the first load?)");
  noErrors(errs, "plain page");
  await c.close();
  await c2.close();
});

/* ── 2. the owner: unfocused → diagram; click → code; Esc → diagram; click away → diagram ── */
await step("owner", async () => {
  state.page ??= await newPage("Mermaid lifecycle", BODY);
  const before = await content(state.page);
  const { c, p } = await ctx(browser, { token: T.owner });
  const errs = watch(p);
  await openEditor(p, state.page);
  await expectDiagram(p, "unfocused");
  await shot(p, "01-owner-unfocused-diagram", { wait: 800 });
  await shot(p, "01b-owner-diagram-block", { el: block(p) });

  // Typing elsewhere doesn't redraw the diagram (the SVG node stays the same element).
  await p.evaluate(() => {
    window.__svg = document.querySelector('.pb-live .dxe-code[data-lang="mermaid"] svg');
  });
  await p.locator(".pb-live .ProseMirror").getByText("How a page moves").click();
  await p.keyboard.press("End");
  await p.keyboard.type(" Typing here.");
  await p.waitForTimeout(1200);
  if (!(await p.evaluate(() => document.querySelector('.pb-live .dxe-code[data-lang="mermaid"] svg') === window.__svg))) fail("typing elsewhere redrew the diagram");

  // Click the diagram: the code shows, with the caret in it (and a live preview below).
  await svgIn(p).click();
  await block(p).locator(".md-codeblock__body").waitFor({ state: "visible", timeout: 5000 });
  const inCode = await p.evaluate(() => {
    const s = window.getSelection();
    return !!s?.anchorNode && !!(s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement)?.closest(".dxe-code .md-codeblock__pre");
  });
  if (!inCode) fail("click: the caret isn't in the code");
  await shot(p, "02-owner-click-code", { wait: 600 });

  // Edit: add a node; the preview follows (debounced), then Esc renders it.
  await p.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await p.keyboard.type("\n    J --> L[Later]");
  await p.waitForTimeout(1200);
  const live = await block(p).locator(".dxe-mermaid__view--live svg g.node").count();
  if (live < 12) fail(`live preview: ${live} nodes after adding one`);
  await shot(p, "03-owner-editing-live-preview");
  await p.keyboard.press("Escape");
  await p.waitForTimeout(400);
  if (await codeVisible(p)) fail("Esc: the code still shows");
  await svgIn(p).waitFor();
  await shot(p, "04-owner-esc-diagram", { wait: 600 });

  // Enter on the selected block edits again; a click into text renders it.
  await p.keyboard.press("Enter");
  await block(p).locator(".md-codeblock__body").waitFor({ state: "visible", timeout: 5000 });
  await p.locator(".pb-live .ProseMirror").getByText("After the diagram.").click();
  await p.waitForTimeout(400);
  if (await codeVisible(p)) fail("click away: the code still shows");
  // Click into the code, then out of the editor altogether (the page title).
  await svgIn(p).click();
  await block(p).locator(".md-codeblock__body").waitFor({ state: "visible", timeout: 5000 });
  await p.getByLabel("Page title").click();
  await p.waitForTimeout(400);
  if (await codeVisible(p)) fail("focus left the editor: the code still shows");

  // Saved: only the edits changed, the fence byte-exact otherwise.
  const t0 = Date.now();
  let md = "";
  while (Date.now() - t0 < 20000) {
    await p.waitForTimeout(700);
    md = await content(state.page);
    if ((await saveState(p)) === "saved" && md.includes("L[Later]")) break;
  }
  const want = before.replace("How a page moves from an idea to the archive.", "How a page moves from an idea to the archive. Typing here.").replace("    F --> J[(Archive)]\n", "    F --> J[(Archive)]\n    J --> L[Later]\n");
  if (md !== want) fail(`saved Markdown differs:\n--- want\n${want}\n--- got\n${md}`);
  noErrors(errs, "owner");
  await c.close();
});

/* ── 3. a render error: the error and the code; click edits it ── */
await step("error", async () => {
  state.broken = await newPage("Broken diagram", BROKEN);
  const { c, p } = await ctx(browser, { token: T.owner });
  const errs = watch(p);
  await openEditor(p, state.broken);
  const err = block(p).locator(".md-diagram-error");
  await err.waitFor({ timeout: 20000 });
  if (!(await err.getByText(/syntax error/).count())) fail("no syntax error message");
  if (!(await err.locator(".md-diagram-error__msg").count())) fail("no mermaid error detail");
  if (!(await err.locator("code").getByText("A[Start --> B{{oops").count())) fail("the code isn't shown with the error");
  await shot(p, "05-render-error", { el: block(p) });
  await err.locator(".md-diagram-error__msg").click();
  await block(p).locator(".md-codeblock__body").waitFor({ state: "visible", timeout: 5000 });
  await shot(p, "05b-render-error-editing", { el: block(p) });
  // Mermaid logs its own parse error to the console; the app adds none.
  noErrors(errs.filter((e) => !/Parse error|Syntax error|Expecting|mermaid/i.test(e)), "error");
  await c.close();
});

/* ── 4. a locked page: the owner and an admin edit (diagram until clicked), a member reads ── */
await step("locked", async () => {
  state.locked = await newPage("Product docs playbook", `---\nlocked: true\n---\n\n${BODY}`);
  const d = await docOf(state.locked, T.member);
  if (!d.page?.locked) fail(`not locked: ${JSON.stringify(d.page)}`);
  for (const who of ["owner", "admin"]) {
    const { c, p } = await ctx(browser, { token: T[who] });
    const errs = watch(p);
    await openEditor(p, state.locked, true);
    await expectDiagram(p, `locked, ${who}`);
    await shot(p, `06-locked-${who}-diagram`, { wait: 800 });
    await svgIn(p).click();
    await block(p).locator(".md-codeblock__body").waitFor({ state: "visible", timeout: 5000 });
    await p.keyboard.press("Escape");
    await p.waitForTimeout(400);
    if (await codeVisible(p)) fail(`locked, ${who}: Esc left the code up`);
    noErrors(errs, `locked, ${who}`);
    await c.close();
  }
  const { c, p } = await ctx(browser, { token: T.member });
  const errs = watch(p);
  await openEditor(p, state.locked, false);
  await expectDiagram(p, "locked, member");
  await svgIn(p).click();
  await p.waitForTimeout(600);
  if (await codeVisible(p)) fail("locked, member: a click shows the code");
  if (await block(p).getByRole("button", { name: /Edit diagram/ }).count()) fail("locked, member: an Edit button");
  if (!(await block(p).getByRole("button", { name: /View source/ }).count())) fail("locked, member: no View source");
  await shot(p, "07-locked-member-read-only", { wait: 600 });
  noErrors(errs, "locked, member");
  await c.close();
  // The reader's view, for comparison.
  const r = await ctx(browser, { token: T.reader });
  const rerrs = watch(r.p);
  await r.p.goto(`${APP}/${state.locked}`, { waitUntil: "networkidle" });
  await r.p.locator(".md-diagram svg").first().waitFor({ timeout: 20000 });
  await shot(r.p, "08-reader-view", { wait: 800 });
  noErrors(rerrs, "reader");
  await r.c.close();
});

/* ── 5. dark theme, the same diagram ── */
await step("dark", async () => {
  state.page ??= await newPage("Mermaid lifecycle", BODY);
  const { c, p } = await ctx(browser, { token: T.owner, theme: "dark" });
  const errs = watch(p);
  await openEditor(p, state.page);
  await expectDiagram(p, "dark");
  await shot(p, "09-owner-dark", { wait: 800 });
  noErrors(errs, "dark");
  await c.close();
});

await browser.close();
console.log("\n" + results.map(([n, r, ms]) => `${r === "ok" ? "✓" : "✗"} ${n.padEnd(10)} ${(ms / 1000).toFixed(1).padStart(5)} s  ${r === "ok" ? "" : r}`).join("\n"));
process.exit(results.some(([, r]) => r !== "ok") ? 1 : 0);
