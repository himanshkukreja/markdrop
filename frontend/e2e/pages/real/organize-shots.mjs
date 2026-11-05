/**
 * Screenshots of the Meetings hub's ⋯ menu and the Organize meetings dialog (before / after the
 * 2026-11-05 redesign), light and dark, desktop and phone, on the REAL stack (up.sh, PB_FAKE_MEETINGS_AI=1).
 *
 *   PB_STACK_ID=55 PB_WORK=… BROWSER=chromium TAG=before|after [OUT=dir] node organize-shots.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { APP, BROWSER, WORK, log, fail, reseed, api, launch, ctx } from "./lib.mjs";

const TAG = process.env.TAG || "after";
const OUT = process.env.OUT || path.resolve(WORK, "..", "organize-shots");
fs.mkdirSync(OUT, { recursive: true });
const browser = await launch();
const S = reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = S.ws;
const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const talk = (w) => `Ada Owner: Morning, quick sync on the ${w} rollout.\nBen Member: The ${w} work is on track.\nVic Viewer: Good, ship it Friday.\n`;
for (const [t, ago, w] of [["Daily Sync Up", 9, "otter"], ["Daily Sync Up", 5, "lynx"], ["Weekly ops review", 14, "heron"],
  ["Weekly ops review", 7, "finch"], ["Kickoff with Senseloaf", 20, "zebra"], ["Hiring loop", 3, "quokka"]]) {
  const r = await api("POST", "/api/v1/meetings/import", T.owner, { workspace: WS, wait: true, title: t, date: day(ago), sources: [{ name: `${t}.txt`, text: talk(w) }] });
  if (r.status >= 300) fail(`import ${t}: ${r.status}`);
}

for (const theme of ["light", "dark"]) {
  for (const [size, opts] of [["desk", { width: 1280, height: 800 }], ["phone", { width: 390, height: 844, mobile: true }]]) {
    const { c, p } = await ctx(browser, { token: T.owner, theme, ...opts });
    await p.goto(`${APP}/meetings/${WS}`);
    await p.getByTestId("meeting-card").first().waitFor({ timeout: 30000 });
    await p.getByTestId("meetings-more").click();
    await p.getByRole("menuitem", { name: /Organize/ }).first().waitFor({ timeout: 10000 });
    await p.waitForTimeout(400);
    await p.screenshot({ path: path.join(OUT, `${TAG}-${BROWSER}-menu-${theme}-${size}.png`) });
    await p.getByRole("menuitem", { name: /Organize/ }).first().click();
    await p.getByRole("dialog").waitFor({ timeout: 10000 });
    await p.waitForTimeout(900);
    await p.screenshot({ path: path.join(OUT, `${TAG}-${BROWSER}-dialog-${theme}-${size}.png`) });
    log("shots", theme, size);
    await c.close();
  }
}
await browser.close();
