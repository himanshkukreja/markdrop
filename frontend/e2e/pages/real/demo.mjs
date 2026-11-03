/**
 * A recorded walkthrough of the page builder on the real stack (up.sh), at a human pace:
 * create a page from a template in a workspace folder, write with the slash menu, mention and embed
 * workspace items, set an icon and a cover, an AI app appends through MCP while the page is open,
 * read it as a workspace reader, then as someone outside the workspace (restricted items stay hidden).
 *
 *   node demo.mjs   (after real.mjs has seeded; writes $PB_WORK/real-shots/demo-raw/*.webm)
 * Encode afterwards, one at a time: nice -n 10 ffmpeg -i <raw>.webm … real-shots/demo.webm
 */
import fs from "node:fs";
import path from "node:path";
import { APP, WORK, log, seedNow, mcpToken, api, mcp, launch, ctx, waitSaved } from "./lib.mjs";

const S = seedNow();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const RAW = path.join(WORK, "real-shots", "demo-raw");
fs.rmSync(RAW, { recursive: true, force: true });
fs.mkdirSync(RAW, { recursive: true });
const tok = mcpToken("ada@acme.test");
const browser = await launch();
const { c, p } = await ctx(browser, { token: null, width: 1280, height: 800, video: RAW });
const pause = (ms = 700) => p.waitForTimeout(ms);
const type = (s) => p.keyboard.type(s, { delay: 38 });
const signIn = async (t) => {
  await p.evaluate((x) => localStorage.setItem("markdrop_token", x), t);
};
async function glide(dy, steps = 30) {
  for (let i = 0; i < steps; i++) {
    await p.mouse.wheel(0, dy / steps);
    await p.waitForTimeout(28);
  }
}
async function slash(q) {
  await type(`/${q}`);
  await p.locator(".dxe-slash").waitFor({ timeout: 5000 });
  await pause(450);
  await p.keyboard.press("Enter");
}
async function pick(q, title, mode) {
  const dlg = p.getByRole("dialog");
  await dlg.waitFor();
  await dlg.getByRole("tab", { name: "Acme" }).click();
  await dlg.getByLabel("Search items").pressSequentially(q, { delay: 60 });
  await dlg.getByText(title).first().waitFor({ timeout: 15000 });
  await pause(500);
  if (mode) await dlg.getByRole("radio", { name: mode }).click().catch(() => {});
  await dlg.getByText(title).first().click();
  await dlg.waitFor({ state: "hidden" });
  await pause(900);
}

await p.goto(`${APP}/robots.txt`);
await signIn(T.owner);

// 1. A new page from a template, in the team's folder.
await p.goto(`${APP}/w/${S.ws}/f/${S.folder}`, { waitUntil: "networkidle" });
await pause(1200);
await p.getByRole("button", { name: "New page" }).first().click();
await pause(900);
await p.getByRole("dialog").getByText("Feature guide / release notes").click();
await pause(500);
await p.getByRole("dialog").getByLabel("Title").fill("");
await p.getByRole("dialog").getByLabel("Title").pressSequentially("Page builder launch", { delay: 45 });
await pause(700);
await p.getByRole("dialog").getByRole("button", { name: "Create page" }).click();
await p.waitForURL(/\?edit=1/, { timeout: 30000 });
const slug = new URL(p.url()).pathname.split("/").pop();
await p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 30000 });
await pause(1500);

// 2. Icon and cover.
await p.locator(".pb-head").hover();
await pause(400);
await p.getByRole("button", { name: "Add icon" }).click();
await p.getByLabel("Search emoji").pressSequentially("rocket", { delay: 60 });
await pause(500);
await p.getByRole("button", { name: "rocket" }).first().click();
await pause(600);
await p.locator(".pb-head").hover();
await p.getByRole("button", { name: "Add cover" }).click();
await pause(900);
await p.getByRole("tab", { name: "Calm" }).click();
await pause(900);
await p.getByRole("button", { name: "Dawn" }).click();
await p.keyboard.press("Escape");
await p.waitForFunction(() => (document.querySelector(".pb-cover-img__img")?.naturalWidth ?? 0) > 0, null, { timeout: 20000 });
await pause(900);

// 3. Write: a mention, embeds of workspace items, a callout.
const ed = p.locator(".pb-live .ProseMirror");
await ed.getByText("Announcement sent").click();
await pause(300);
await p.keyboard.press("End");
await p.keyboard.press("Enter");
await p.keyboard.press("Enter");
await type("Read the plan first: ");
await slash("mention");
await pick("launch", "Launch plan");
await p.keyboard.press("End");
await type(" — then check the numbers.");
await p.keyboard.press("Enter");
await slash("embed");
await pick("q3", "Q3 report", "Live");
await p.keyboard.press("Enter");
await slash("embed");
await pick("pricing", "Pricing calculator", "Live");
await p.keyboard.press("Enter");
await slash("warn");
await type("Ship the docs before the announcement.");
await waitSaved(p);
await pause(800);

// 4. An AI app adds a section through MCP while the page is open: it appears in place.
await api("PUT", `/api/v1/documents/${slug}/access/level`, T.owner, { level: "link" });
const ap = await mcp(tok, "append_blocks", { document: slug, markdown: "## Added by Claude\n\n- [ ] Draft the announcement email\n- [ ] Record the demo video" });
log("append_blocks", ap.isError ? ap.text : "ok");
await p.getByText("Added by Claude").waitFor({ timeout: 15000 });
await p.getByText("Added by Claude").scrollIntoViewIfNeeded();
await pause(2200);

// 5. The page as a reader in the workspace sees it (a viewer: the same layout, read only).
await p.evaluate(() => sessionStorage.clear()); // signing out drops the tab's edit secrets
await signIn(T.reader);
await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
await p.locator(".pb-page .pb-embed").first().waitFor({ timeout: 20000 });
await pause(1500);
await glide(1400, 50);
await pause(1200);
await glide(1600, 50);
await pause(1500);
await glide(1600, 50);
await pause(1200);

// 6. The same page for someone outside the workspace: the items they can't open stay hidden.
await p.evaluate(() => sessionStorage.clear()); // signing out drops the tab's edit secrets
await signIn(T.stranger);
await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
await p.locator(".pb-locked").first().waitFor({ timeout: 20000 });
await pause(1200);
await glide(1200, 45);
await pause(1500);
await glide(1400, 45);
await pause(2000);

const video = p.video();
await c.close();
const raw = await video.path();
log("raw video", raw, `${(fs.statSync(raw).size / 1e6).toFixed(1)} MB`);
await browser.close();
