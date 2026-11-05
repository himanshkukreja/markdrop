/**
 * One-bar screenshots: an owner editing a page, a member reading, an anonymous reader, a page on a
 * tenant domain and a classic document; light and dark at 1440 and 390.
 *   OUT=<dir> node onebar-shots.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { APP, TENANT, log, reseed, api, docOf, launch, ctx, editPage } from "./lib.mjs";

const OUT = process.env.OUT || "/tmp/onebar";
fs.mkdirSync(OUT, { recursive: true });
const S = reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const body = (t) => `## Why\n\nWe ship the page builder to every workspace this quarter. ${t} keeps the plan in one place.\n\n## Timeline\n\n- [x] Beta with design partners\n- [ ] Public launch\n- [ ] Docs and videos\n\n## Risks\n\n> Keep the editor smooth on long pages.\n\nMore notes follow here, with enough text to make the column feel like a real page that someone wrote.\n`;
async function page(title, extra) {
  const r = await api("POST", "/api/v1/pages", T.owner, { title, content: body(title), ...extra });
  if (r.status !== 201) throw new Error(`create ${title} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.document.slug;
}
const top = await page("Launch plan Q4", { workspace: S.ws, folder: S.folder });
await api("PUT", `/api/v1/documents/${top}/access/level`, T.owner, { level: "link" });
const mid = await page("Rollout checklist", { parent: top });
const leaf = await page("Week one tasks for the launch team", { parent: mid });
const classic = await api("POST", "/api/v1/documents", T.owner, { content: `# Release notes\n\n${body("This document")}`, title: "Release notes", expires_in: "never", access_level: "link", workspace: S.ws, folder: S.folder });
const classicSlug = classic.body.slug;
log("pages", top, mid, leaf, "classic", classicSlug, classic.status);
const d = await docOf(leaf, T.owner);
const tenantAddr = `${TENANT}/${[...(d.folder_path || []), ...(d.page_path || []), leaf].join("/")}`;
await fetch(`${APP}/api/revalidate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag: "host:acme.localhost" }) });

const browser = await launch();
// A second viewer so presence shows.
const watcher = await ctx(browser, { token: T.reader });
await watcher.p.goto(`${APP}/${leaf}`, { waitUntil: "networkidle" });

const cases = [
  ["owner-editing", T.owner, `${APP}/${leaf}`, ".pb-live .ProseMirror"],
  ["member-reading", T.reader, `${APP}/${leaf}`, ".pb-page"],
  ["anonymous", null, `${APP}/${leaf}`, ".pb-page"],
  ["tenant", null, tenantAddr, ".pb-page"],
  ["classic", T.owner, `${APP}/${classicSlug}`, "main"],
  ["classic-anon", null, `${APP}/${classicSlug}`, "main"],
];
const only = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
for (const [name, token, url, sel] of cases) {
  if (only && !only.has(name)) continue;
  for (const theme of ["light", "dark"]) {
    for (const width of [1440, 390]) {
      const { c, p } = await ctx(browser, { token, theme, width, height: width < 500 ? 844 : 900, mobile: width < 500 });
      try {
        await p.goto(url, { waitUntil: "networkidle" });
        await p.locator(sel).first().waitFor({ timeout: 25000 });
        await p.waitForTimeout(1500);
        if (name.startsWith("classic") && process.env.FRAMED) {
          await p.getByRole("button", { name: "Show details" }).click();
          await p.waitForTimeout(800);
        }
        const file = path.join(OUT, `${name}${process.env.FRAMED && name.startsWith("classic") ? "-framed" : ""}-${theme}-${width}.png`);
        await p.screenshot({ path: file });
        if (width === 1440 && theme === "light") {
          await p.mouse.wheel(0, 500);
          await p.waitForTimeout(600);
          await p.screenshot({ path: path.join(OUT, `${name}-${theme}-${width}-scrolled.png`) });
        }
        const sw = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        log("shot", name, theme, width, sw > 0 ? `HSCROLL ${sw}` : "");
      } catch (e) {
        log("FAIL", name, theme, width, e.message.slice(0, 200));
      }
      await c.close();
    }
  }
}
/* The rail: collapse (button and ⌘\\), remembered, peek on the left edge, the drawer below 1280 px. */
if (!only || only.has("rail")) {
  const bad = [];
  const { c, p } = await ctx(browser, { token: T.owner, theme: "light", width: 1440 });
  await p.goto(`${APP}/${leaf}`, { waitUntil: "networkidle" });
  await editPage(p, 25000);
  await p.waitForTimeout(800);
  const railX = () => p.locator(".pb-rail").evaluate((el) => Math.round(el.getBoundingClientRect().right));
  if ((await railX()) < 200) bad.push("rail not open at first");
  await p.locator(".pb-barwrap:visible").first().getByRole("button", { name: "Hide the sidebar" }).click();
  await p.waitForTimeout(400);
  if ((await railX()) > 5) bad.push("button didn't collapse the rail");
  await p.screenshot({ path: path.join(OUT, "rail-collapsed-light-1440.png") });
  await p.mouse.move(4, 400);
  await p.waitForTimeout(400);
  if ((await railX()) < 200) bad.push("no peek on the left edge");
  await p.screenshot({ path: path.join(OUT, "rail-peek-light-1440.png") });
  await p.mouse.move(900, 400);
  await p.waitForTimeout(600);
  if ((await railX()) > 5) bad.push("peek didn't go away");
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForTimeout(800);
  if ((await railX()) > 5) bad.push("collapsed not remembered");
  await p.locator(".pb-live .ProseMirror").click();
  await p.keyboard.press("ControlOrMeta+Backslash");
  await p.waitForTimeout(400);
  if ((await railX()) < 200) bad.push("⌘\\ didn't expand it");
  await c.close();
  for (const theme of ["light", "dark"]) {
    const m = await ctx(browser, { token: T.reader, theme, width: 390, height: 844, mobile: true });
    await m.p.goto(`${APP}/${leaf}`, { waitUntil: "networkidle" });
    await m.p.locator(".pb-page").waitFor({ timeout: 25000 });
    await m.p.getByRole("button", { name: "Show the sidebar" }).first().click();
    await m.p.waitForTimeout(500);
    const vis = await m.p.locator(".pb-rail").isVisible();
    if (!vis) bad.push(`${theme}: phone drawer didn't open`);
    await m.p.screenshot({ path: path.join(OUT, `rail-drawer-${theme}-390.png`) });
    await m.p.locator(".pb-railscrim").click({ position: { x: 370, y: 400 } });
    await m.p.waitForTimeout(400);
    if (await m.p.locator(".pb-rail").isVisible()) bad.push(`${theme}: scrim didn't close the drawer`);
    // ⋯ on a phone
    await m.p.getByRole("button", { name: "Page options" }).first().click();
    await m.p.waitForTimeout(500);
    await m.p.screenshot({ path: path.join(OUT, `menu-sheet-${theme}-390.png`) });
    await m.c.close();
  }
  log("rail", bad.length ? `PROBLEMS: ${bad.join("; ")}` : "ok");
}
/* Someone else is editing: the owner holds the lock; a viewer sees it on the bar. */
if (!only || only.has("editing")) {
  const ed = await ctx(browser, { token: T.owner, width: 1440 });
  await ed.p.goto(`${APP}/${leaf}`, { waitUntil: "networkidle" });
  await editPage(ed.p, 25000);
  await ed.p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 25000 });
  await ed.p.locator(".pb-live .ProseMirror").getByText("More notes follow").click();
  await ed.p.keyboard.press("End");
  await ed.p.keyboard.type(" Editing now.");
  await ed.p.waitForTimeout(2500);
  for (const [who, tok] of [["member", T.reader], ["anonymous", null]]) for (const theme of ["light", "dark"]) {
    for (const width of [1440, 390]) {
      const { c, p } = await ctx(browser, { token: tok, theme, width, height: width < 500 ? 844 : 900, mobile: width < 500 });
      await p.goto(`${APP}/${leaf}`, { waitUntil: "networkidle" });
      await p.locator(".pb-page").first().waitFor({ timeout: 25000 });
      const badge = await p.locator(".pb-barwrap [data-editing]").first().waitFor({ timeout: 15000 }).then(() => true, () => false);
      await p.waitForTimeout(800);
      if (width === 1440) {
        await p.locator(".pb-barwrap [data-editing]").first().hover().catch(() => {});
        await p.waitForTimeout(700);
      }
      await p.screenshot({ path: path.join(OUT, `someone-editing-${who}-${theme}-${width}.png`) });
      const named = await p.locator(".pb-barwrap").first().innerText().catch(() => "");
      log("editing", who, theme, width, badge ? "badge shown" : "NO BADGE", /Ada Owner/.test(named) ? "NAMED" : "no name in bar");
      await c.close();
    }
  }
  await ed.c.close();
}
await watcher.c.close();
await browser.close();
