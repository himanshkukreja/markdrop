/**
 * Docs stills for /workspaces/team (light + dark, 2×) from the e2e world team.mjs leaves behind:
 *   PB_STACK_ID=… PB_WORK=… ONLY=enable,board,own,groups,week node team.mjs && NO_RESEED=1 node team-docs-shots.mjs
 * Writes PNGs to $PB_WORK/docs-shots/; convert with Pillow to public/docs-assets/workspaces/team/*.webp.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { APP, WORK, seedNow } from "./lib.mjs";

const S = seedNow();
const out = path.join(WORK, "docs-shots");
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const team = `${APP}/team/${encodeURIComponent(S.ws)}`;
for (const theme of ["light", "dark"]) {
  const c = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, colorScheme: theme });
  await c.addInitScript(([t, th]) => { localStorage.setItem("markdrop_token", t); localStorage.setItem("md_theme", th); localStorage.setItem("md_theme_beta", "1"); localStorage.setItem("md_consent", "denied"); }, [S.users.admin.token, theme]);
  const p = await c.newPage();
  await p.goto(team);
  await p.getByTestId("team-cards").waitFor({ timeout: 30000 });
  await p.waitForTimeout(800);
  await p.mouse.move(5, 995);
  const main = await p.locator(".tm-page").boundingBox();
  await p.screenshot({ path: path.join(out, `board${theme === "dark" ? ".dark" : ""}.png`), clip: { x: main.x - 16, y: 70, width: main.width + 32, height: 900 } });
  const glance = p.locator(".tm-glance");
  await glance.scrollIntoViewIfNeeded();
  await p.waitForTimeout(300);
  await glance.screenshot({ path: path.join(out, `glance${theme === "dark" ? ".dark" : ""}.png`) });
  await p.locator('[data-testid="team-card"][data-person="Raj Patel"]').click();
  await p.getByTestId("team-person").waitFor();
  await p.waitForTimeout(800);
  const pm = await p.locator(".tm-page").boundingBox();
  await p.screenshot({ path: path.join(out, `person${theme === "dark" ? ".dark" : ""}.png`), clip: { x: pm.x - 16, y: 70, width: pm.width + 32, height: 860 } });
  await c.close();
}
await browser.close();
console.log("shots in", out);
