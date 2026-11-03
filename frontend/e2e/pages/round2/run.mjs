/**
 * Round 2 of the page editor, end to end on the real backend (see stack.sh): colours, underline,
 * block colour and anchors, columns, image resize/align/full screen, multi-block selection,
 * nesting, tables, code captions, the button block, uploads as Markdrop files, the reader, touch.
 * Each step checks the Markdown the page stored.
 *
 *   node run.mjs                              Chromium, light
 *   BROWSER=webkit THEME=dark node run.mjs
 *   ONLY=colors,columns-slash node run.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP, BROWSER, SHOTS, THEME, context, edit, fail, launch, md, newPage, pending, saved, shot } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, "../../../src/components/docs-editor/test/fixtures/pages.md");
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const MOD = "ControlOrMeta";
const browser = await launch();
const ctx = (o) => context(browser, o);

const results = [];
async function step(name, fn) {
  if (ONLY && !ONLY.has(name)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push([name, "ok", Date.now() - t0]);
    console.log("• ok", name);
  } catch (e) {
    results.push([name, `FAIL ${e.message.split("\n")[0]}`, Date.now() - t0]);
    for (const cx of browser.contexts())
      for (const pg of cx.pages()) {
        await pg.screenshot({ path: path.join(SHOTS, `fail-${name}-${THEME}.png`) }).catch(() => {});
        for (const r of pending(pg)) console.error("   still open:", r);
      }
    console.error(`✗ ${name}:`, e.message.slice(0, 1500));
  } finally {
    for (const cx of browser.contexts()) await cx.close().catch(() => {});
  }
}

/** Selects `text` (its first occurrence) through the editor instance. */
async function selectText(p, text) {
  const ok = await p.evaluate((t) => {
    const ed = document.querySelector(".ProseMirror").editor;
    let at = null;
    ed.state.doc.descendants((n, pos) => {
      if (at !== null || !n.isText) return at === null;
      const i = n.text.indexOf(t);
      if (i >= 0) at = pos + i;
      return false;
    });
    if (at === null) return false;
    ed.chain().focus().setTextSelection({ from: at, to: at + t.length }).run();
    return true;
  }, text);
  if (!ok) fail(`no text “${text}”`);
  await p.waitForTimeout(250);
}

/** The caret at the end of the block holding `text`. */
async function caretAfter(p, text) {
  await p.locator(".ProseMirror").getByText(text, { exact: false }).first().click();
  const ok = await p.evaluate((t) => {
    const ed = document.querySelector(".ProseMirror").editor;
    let at = null;
    ed.state.doc.descendants((n, pos) => {
      if (at !== null) return false;
      if (n.isTextblock && n.textContent.includes(t)) {
        at = pos + 1 + n.content.size;
        return false;
      }
      return true;
    });
    if (at === null) return false;
    ed.chain().focus().setTextSelection(at).run();
    return true;
  }, text);
  if (!ok) fail(`no block “${text}”`);
  await p.waitForTimeout(150);
}

const para = (p, text) => p.locator(".ProseMirror p", { hasText: text }).first();
async function blockMenu(p, text) {
  const el = para(p, text);
  await el.hover();
  await p.waitForTimeout(250);
  const box = await el.boundingBox();
  await p.mouse.move(box.x + 10, box.y + box.height / 2);
  await p.waitForTimeout(250);
  await p.locator(".dxe-handle__grip").first().click();
  await p.locator('[role="menu"]').first().waitFor();
}

/* ── 1. text colour, background, underline, last colour ─────────────────────── */
await step("colors", async () => {
  const slug = await newPage("Colours", "Plain words here and there\n\nSecond line\n");
  const { p } = await ctx();
  await edit(p, slug);
  await selectText(p, "words");
  await p.getByRole("button", { name: "Colour", exact: true }).click();
  await p.getByRole("menu", { name: "Colour" }).waitFor();
  await shot(p, "01-text-colour-menu");
  await p.getByRole("menuitemradio", { name: "Red", exact: true }).click();
  await selectText(p, "there");
  await p.getByRole("button", { name: "Colour", exact: true }).click();
  await p.getByRole("menuitemradio", { name: "Yellow background", exact: true }).click();
  await selectText(p, "Plain");
  await p.keyboard.press(`${MOD}+u`);
  await selectText(p, "here");
  await p.keyboard.press(`${MOD}+Shift+h`); // the last colour: yellow background
  await p.keyboard.press("End");
  await saved(p, slug, [':span[words]{color="red"}', ':span[there]{bg="yellow"}', ":u[Plain]", ':span[here]{bg="yellow"}']);
  await shot(p, "02-colours-applied");
});

/* ── 2. block colour and Copy link to block (scroll + highlight on open) ────────── */
await step("block-colour-anchor", async () => {
  const slug = await newPage("Block colour", "First paragraph\n\nSecond line\n\nThird line\n");
  const { p } = await ctx();
  await edit(p, slug);
  await blockMenu(p, "Second line");
  await shot(p, "03-block-menu");
  await p.getByRole("button", { name: "Blue background" }).click();
  await blockMenu(p, "Third line");
  await p.getByRole("button", { name: "Red text" }).click();
  await blockMenu(p, "Third line");
  await p.getByRole("menuitem", { name: /Copy link to block/ }).click();
  const m = await saved(p, slug, ['Second line {bg="blue"}', /Third line \{#b-[a-z0-9]{6} color="red"\}/]);
  const id = /\{#(b-[a-z0-9]{6})/.exec(m)[1];
  await shot(p, "04-block-coloured");
  // The reader opens at the block and flashes it.
  await p.goto(`${APP}/${slug}#${id}`, { waitUntil: "networkidle" });
  await p.locator(`[data-bid="${id}"].pb-flash`).waitFor({ timeout: 10000 });
  await shot(p, "05-anchor-flash", { wait: 300 });
  // …and so does the editor.
  await p.goto(`${APP}/${slug}?edit=1#${id}`, { waitUntil: "networkidle" });
  await p.locator(".dxe-visual .dxe-flash").waitFor({ timeout: 10000 });
});

/* ── 3. columns: /columns, typing, resize; dragging a block beside another ─────── */
await step("columns-slash", async () => {
  const slug = await newPage("Columns", "Intro\n");
  const { p } = await ctx();
  await edit(p, slug);
  await caretAfter(p, "Intro");
  await p.keyboard.press("Enter");
  await p.keyboard.type("/columns");
  await p.locator(".dxe-slash").waitFor();
  await p.keyboard.press("Enter");
  await p.keyboard.type("Left text");
  await p.locator(".dxe-column").nth(1).locator("p").first().click();
  await p.keyboard.type("Right text");
  await saved(p, slug, ["::::columns", ":::column", "Left text", "Right text"]);
  const h = p.locator(".dxe-column__resize").first();
  const b = await h.boundingBox();
  await p.mouse.move(b.x + b.width / 2, b.y + 20);
  // The block handle of the right column's first block sits on the divider until the pointer
  // moves there; it steps aside on the next frame.
  await p.waitForTimeout(250);
  const under = await p.evaluate(([x, y]) => document.elementFromPoint(x, y)?.className ?? "", [b.x + b.width / 2, b.y + 20]);
  if (!String(under).includes("dxe-column__resize")) fail(`the divider isn't under the pointer (${under})`);
  await p.mouse.down();
  await p.mouse.move(b.x + 120, b.y + 20, { steps: 8 });
  await shot(p, "06-columns-resizing", { wait: 100 });
  await p.mouse.up();
  await saved(p, slug, [/:::column\{width="\d+(\.\d)?%"\}/]);
  await shot(p, "07-columns");
  await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
  await p.locator(".pb-columns .pb-column").nth(1).waitFor();
  await shot(p, "08-columns-reader");
});

await step("columns-drag", async () => {
  const slug = await newPage("Drag beside", "Alpha block\n\nBeta block\n\nGamma block\n");
  const { p } = await ctx();
  await edit(p, slug);
  const g = para(p, "Gamma block");
  await g.hover();
  const gb = await g.boundingBox();
  await p.mouse.move(gb.x + 10, gb.y + gb.height / 2);
  await p.waitForTimeout(300);
  const grip = p.locator(".dxe-handle__grip").first();
  const a = await para(p, "Alpha block").boundingBox();
  const ed = await p.locator(".ProseMirror").boundingBox();
  await grip.dragTo(p.locator(".ProseMirror"), { targetPosition: { x: ed.width - 12, y: a.y - ed.y + a.height / 2 } });
  await p.waitForTimeout(400);
  const m = await saved(p, slug, ["::::columns"]);
  if (!/:::column\nAlpha block\n:::\n\n:::column\nGamma block\n:::/.test(m)) fail(`not side by side:\n${m}`);
  if (!m.includes("Beta block")) fail("Beta lost");
  await shot(p, "09-columns-by-drag");
});

/* ── 3b. controls drawn before the edit lock (the page opens read only) work after it ── */
await step("after-lock", async () => {
  const slug = await newPage("After the lock", "- [ ] A task\n\n::::columns\n:::column\nLeft\n:::\n\n:::column\nRight\n:::\n::::\n");
  const { p } = await ctx();
  await edit(p, slug);
  const box = p.locator("input.dxe-task").first();
  if (await box.isDisabled()) fail("the to-do's checkbox stays disabled once the page is editable");
  if (!(await p.locator(".dxe-column__resize").first().isVisible())) fail("the column divider is hidden once the page is editable");
  await box.click();
  await saved(p, slug, ["- [x] A task"]);
});

/* ── 4. images: resize, align, caption, full screen (editor and reader) ────────── */
async function pngBytes() {
  const tmp = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await tmp.setContent(`<div style="width:640px;height:360px;display:grid;place-items:center;background:linear-gradient(135deg,#2563eb,#14b8a6);font:700 40px system-ui;color:#fff">A screenshot</div>`);
  const buf = await tmp.screenshot();
  await tmp.close();
  return [...buf];
}
await step("image", async () => {
  const slug = await newPage("Images", "Before the image\n");
  const { p } = await ctx();
  await edit(p, slug);
  await caretAfter(p, "Before the image");
  await p.keyboard.press("Enter");
  const bytes = await pngBytes();
  await p.locator(".ProseMirror").evaluate((el, b) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(b)], "screenshot.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, bytes);
  const box = p.locator(".dxe-figure__box").first();
  await box.waitFor({ timeout: 15000 });
  await saved(p, slug, [/!\[[^\]]*\]\(asset:[A-Za-z0-9_-]+/]);
  await p.locator(".dxe-figure__box img[src]").first().waitFor();
  await box.hover();
  const h = await p.locator(".dxe-figure__handle--r").first().boundingBox();
  await p.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await p.mouse.down();
  await p.mouse.move(h.x - 100, h.y + h.height / 2, { steps: 8 });
  await shot(p, "10-image-resizing", { wait: 100 });
  await p.mouse.up();
  await box.hover();
  await p.getByRole("button", { name: "Align left" }).click();
  await p.getByLabel("Caption").fill("The dashboard");
  await saved(p, slug, [/!\[[^\]]*\]\(asset:[A-Za-z0-9_-]+ "The dashboard"\)\{align="left" width="\d+%"\}/]);
  await shot(p, "11-image-left");
  await box.hover();
  await p.getByRole("button", { name: "View full screen" }).click();
  await p.locator(".dxe-lightbox").waitFor();
  await shot(p, "12-image-full-screen");
  await p.keyboard.press("Escape");
  await p.locator(".dxe-lightbox").waitFor({ state: "detached" });
  // The reader: same width and alignment, full screen on click.
  await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
  await p.locator('.pb-figure[data-align="left"]').waitFor();
  await p.locator(".pb-figure__open").click();
  await p.locator(".dxe-lightbox").waitFor();
  await p.getByRole("button", { name: "Download" }).waitFor();
  await shot(p, "13-reader-image-full-screen");
});

/* ── 5. multi-block selection ───────────────────────────────────────────────── */
const FIVE = "One block\n\nTwo block\n\nThree block\n\nFour block\n\nFive block\n";
const selCount = (p) => p.locator(".ProseMirror .dxe-block-sel").count();
await step("multi-select-keys", async () => {
  const slug = await newPage("Select keys", FIVE);
  const { p } = await ctx();
  await edit(p, slug);
  await caretAfter(p, "Two block");
  await p.keyboard.press("Escape");
  if ((await selCount(p)) !== 1) fail(`Esc selected ${await selCount(p)}`);
  await p.keyboard.press("Shift+ArrowDown");
  await p.keyboard.press("Shift+ArrowDown");
  if ((await selCount(p)) !== 3) fail(`Shift+↓ selected ${await selCount(p)}`);
  await p.locator(".dxe-selbar").waitFor();
  if (await p.locator(".dxe-tb").isVisible().catch(() => false)) fail("the format toolbar shows over a block selection");
  await shot(p, "14-blocks-selected");
  await p.keyboard.press("Backspace");
  await saved(p, slug, ["One block", "Five block"], { not: ["Two", "Three", "Four"] });
  await p.keyboard.press(`${MOD}+z`);
  await saved(p, slug, ["Two block", "Three block", "Four block"]);
  // ⌘A twice: the block's text, then every block.
  await caretAfter(p, "Three block");
  await p.keyboard.press(`${MOD}+a`);
  await p.keyboard.press(`${MOD}+a`);
  if ((await selCount(p)) !== 5) fail(`⌘A ⌘A selected ${await selCount(p)}`);
  // Shift+click
  await caretAfter(p, "One block");
  await para(p, "Three block").click({ modifiers: ["Shift"] });
  if ((await selCount(p)) !== 3) fail(`Shift+click selected ${await selCount(p)}`);
  // Turn into and colour from the selection bar.
  await p.locator(".dxe-selbar").getByRole("button", { name: "Turn into" }).click();
  await p.getByRole("menuitem", { name: "Heading 2" }).click();
  await saved(p, slug, ["## One block", "## Two block", "## Three block"]);
  await p.locator(".dxe-selbar").getByRole("button", { name: "Colour" }).click();
  await p.getByRole("menuitemradio", { name: "Purple", exact: true }).click();
  await saved(p, slug, ['## One block {color="purple"}', '## Three block {color="purple"}']);
  await shot(p, "15-bulk-turn-colour");
});

await step("multi-select-mouse", async () => {
  const slug = await newPage("Select mouse", FIVE);
  const { p } = await ctx();
  await edit(p, slug);
  // Drag-select from the left margin.
  const one = await para(p, "One block").boundingBox();
  const three = await para(p, "Three block").boundingBox();
  const ed = await p.locator(".ProseMirror").boundingBox();
  await p.mouse.move(ed.x - 60, one.y - 6);
  await p.mouse.down();
  await p.mouse.move(ed.x + 120, three.y + three.height / 2, { steps: 10 });
  await shot(p, "16-marquee", { wait: 100 });
  await p.mouse.up();
  if ((await selCount(p)) !== 3) fail(`marquee selected ${await selCount(p)}`);
  // Drag the selection below "Five block".
  const two = para(p, "Two block");
  const tb = await two.boundingBox();
  await p.mouse.move(tb.x + 10, tb.y + tb.height / 2);
  await p.waitForTimeout(300);
  const five = await para(p, "Five block").boundingBox();
  await p.locator(".dxe-handle__grip").first().dragTo(p.locator(".ProseMirror"), { targetPosition: { x: 80, y: five.y - ed.y + five.height + 4 } });
  await saved(p, slug, [/Four block\n\nFive block\n\nOne block\n\nTwo block\n\nThree block/]);
  // Cut and paste them back to the top.
  await p.waitForTimeout(300);
  if ((await selCount(p)) !== 3) {
    await caretAfter(p, "One block");
    await p.keyboard.press("Escape");
    await p.keyboard.press("Shift+ArrowDown");
    await p.keyboard.press("Shift+ArrowDown");
  }
  await p.keyboard.press(`${MOD}+x`);
  await saved(p, slug, ["Four block"], { not: ["One block"] });
  await para(p, "Four block").click();
  await p.keyboard.press("Home");
  await p.keyboard.press(`${MOD}+v`);
  await saved(p, slug, ["One block", "Three block", "Four block"]);
});

/* ── 6. nesting with Tab ────────────────────────────────────────────────────── */
await step("nesting", async () => {
  const slug = await newPage("Nesting", "Parent block\n\nChild block\n\nAfter block\n\n- Item\n\nUnder the item\n");
  const { p } = await ctx();
  await edit(p, slug);
  await caretAfter(p, "Child block");
  await p.keyboard.press("Tab");
  await saved(p, slug, [":::indent\nChild block\n:::"]);
  await caretAfter(p, "After block");
  await p.keyboard.press("Tab");
  await saved(p, slug, [":::indent\nChild block\n\nAfter block\n:::"]);
  await shot(p, "17-nested");
  await p.keyboard.press("Shift+Tab");
  await saved(p, slug, [":::indent\nChild block\n:::\n\nAfter block"]);
  await caretAfter(p, "Under the item");
  await p.keyboard.press("Tab");
  await saved(p, slug, ["- Item\n\n  Under the item"]);
  await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
  await p.locator(".pb-indent").waitFor();
  await shot(p, "18-nested-reader");
});

/* ── 7. tables, code caption, button ────────────────────────────────────────── */
await step("table", async () => {
  const slug = await newPage("Table", "| Name | Role |\n| --- | --- |\n| Ada | Owner |\n| Ben | Member |\n");
  const { p } = await ctx();
  await edit(p, slug);
  await p.locator(".ProseMirror td", { hasText: "Ada" }).click();
  await p.locator(".dxe-tablebar").waitFor();
  await p.getByRole("button", { name: "Header column" }).click();
  await p.locator(".ProseMirror td", { hasText: "Owner" }).click();
  await p.getByRole("button", { name: "Cell colour" }).click();
  await p.getByRole("menuitemradio", { name: "Green background" }).click();
  await saved(p, slug, ['| Owner {bg="green"} |', "{header-column}"]);
  // Resize the first column by its right edge.
  const th = await p.locator(".ProseMirror th").first().boundingBox();
  await p.mouse.move(th.x + th.width - 2, th.y + th.height / 2);
  await p.waitForTimeout(200);
  await p.mouse.down();
  await p.mouse.move(th.x + th.width + 90, th.y + th.height / 2, { steps: 8 });
  await p.mouse.up();
  await saved(p, slug, [/header-column widths="\d+,/]);
  await shot(p, "19-table");
  await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
  await p.locator("table[data-hcol] col").first().waitFor({ state: "attached" });
  await shot(p, "20-table-reader");
});

await step("code-caption-button", async () => {
  const slug = await newPage("Code and button", "Start\n");
  const { p } = await ctx();
  await edit(p, slug);
  await caretAfter(p, "Start");
  await p.keyboard.press("Enter");
  await p.keyboard.type("/code");
  await p.locator(".dxe-slash").waitFor();
  await p.keyboard.press("Enter");
  await p.keyboard.type("npm run build");
  await p.getByLabel("Code caption").fill("Build the site");
  await saved(p, slug, ['```\nnpm run build\n```\n{caption="Build the site"}']);
  await p.locator(".ProseMirror > p").last().click();
  await p.keyboard.type("/button");
  await p.locator(".dxe-slash").waitFor();
  await p.keyboard.press("Enter");
  await p.locator(".dxe-button__tpl p").first().click();
  await p.keyboard.type("Call the client");
  await p.locator(".dxe-button__btn").click();
  const m = await saved(p, slug, [':::button{label="Add a task"}']);
  if ((m.match(/- \[ \] Call the client/g) ?? []).length !== 2) fail(`the button didn't insert:\n${m}`);
  await shot(p, "21-code-caption-button");
  await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
  const body = await p.locator(".pb-page").innerText();
  if (!body.includes("Build the site")) fail("caption missing for readers");
  if ((body.match(/Call the client/g) ?? []).length !== 1) fail("readers see the button's template");
});

/* ── 8. /file: an upload becomes a Markdrop file embedded in the page ───────────── */
await step("media-upload", async () => {
  const slug = await newPage("Uploads", "Attachments below\n");
  const { p } = await ctx();
  await edit(p, slug);
  await caretAfter(p, "Attachments below");
  await p.keyboard.press("Enter");
  await p.keyboard.type("/file");
  await p.locator(".dxe-slash").waitFor();
  const chooser = p.waitForEvent("filechooser");
  await p.keyboard.press("Enter");
  const fc = await chooser;
  await fc.setFiles({ name: "pricing.html", mimeType: "text/html", buffer: Buffer.from("<!doctype html><meta charset=utf-8><title>Pricing</title><h1>Pricing calculator</h1>") });
  const m = await saved(p, slug, [/::markdrop\{src="?[A-Za-z0-9_-]+"?\}/], { timeout: 30000 });
  void m;
  await p.locator(".ProseMirror [data-type], .ProseMirror .dxe-block").filter({ hasText: /Pricing/ }).first().waitFor({ timeout: 20000 }).catch(() => {});
  await shot(p, "22-file-upload", { wait: 1500 });
});

/* ── 9. the reader, everything at once (desktop and phone) ──────────────────── */
await step("reader", async () => {
  const content = fs.readFileSync(FIXTURE, "utf8");
  const slug = await newPage("All of round 2", content);
  const stored = await md(slug);
  for (const width of [1280, 390]) {
    const { p, c } = await ctx({ width, height: width < 500 ? 844 : 900 });
    await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
    await p.locator(".pb-columns").first().waitFor();
    await shot(p, `23-reader-${width}`, { full: true, wait: 1200 });
    if (width < 500) {
      const dir = await p.locator(".pb-columns").first().evaluate((el) => getComputedStyle(el).flexDirection);
      if (dir !== "column") fail(`columns don't stack on phones (${dir})`);
      const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (over > 1) fail(`the page scrolls sideways on a phone (${over}px)`);
    }
    await c.close();
  }
  const { p } = await ctx();
  await p.goto(`${APP}/${slug}?edit=1`, { waitUntil: "networkidle" });
  await p.locator(".ProseMirror").waitFor();
  await p.waitForTimeout(3000);
  if ((await md(slug)) !== stored) fail("opening the page in the editor changed its Markdown");
  await shot(p, "24-editor-all", { full: true, wait: 800 });
});

/* ── 10. touch at 390: the touch bar's "+", its block menu, a long press ───────── */
await step("touch", async () => {
  const slug = await newPage("Touch", "First on the phone\n\nSecond on the phone\n");
  const { p } = await ctx({ width: 390, height: 844, touch: true });
  await edit(p, slug);
  await para(p, "Second on the phone").tap();
  await p.locator(".dxe-touchbar").waitFor({ timeout: 5000 });
  await shot(p, "25-touch-bar");
  await p.getByRole("button", { name: "Add a block" }).tap();
  await p.locator(".dxe-slash").waitFor();
  await shot(p, "26-touch-slash");
  await p.keyboard.press("Escape");
  await p.getByRole("button", { name: "Block menu" }).tap();
  await p.locator('[role="menu"]').first().waitFor();
  await shot(p, "27-touch-block-menu");
  await p.keyboard.press("Escape");
  if (BROWSER === "chromium") {
    // A long press on a block opens its menu.
    const b = await para(p, "First on the phone").boundingBox();
    const cdp = await p.context().newCDPSession(p);
    const pt = [{ x: b.x + 20, y: b.y + b.height / 2 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt });
    await p.waitForTimeout(800);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await p.locator('[role="menu"]').first().waitFor({ timeout: 4000 });
    await shot(p, "28-long-press-menu");
  }
  const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 1) fail(`the editor scrolls sideways on a phone (${over}px)`);
});

await browser.close();
console.log(`\nResults (${BROWSER}, ${THEME}):`);
for (const [n, r, ms] of results) console.log(`  ${r === "ok" ? "✓" : "✗"} ${n}: ${r} (${(ms / 1000).toFixed(1)}s)`);
process.exit(results.some(([, r]) => r !== "ok") ? 1 : 0);
