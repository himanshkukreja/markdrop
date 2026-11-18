#!/usr/bin/env node
/**
 * Docs screenshots of the real app against a mocked API: no backend, database or Worker. A light
 * alternative to the demo stack (../stack/stack.sh) for shots whose data the seeds don't have
 * (HubSpot deals, Zoom review, the sections sidebar…). Every request to the fake API origin is
 * answered by Playwright from world.mjs (the Acme demo world) plus each shot's own handlers.
 *
 *   cd frontend
 *   NEXT_PUBLIC_API_URL=http://127.0.0.1:8799 NEXT_PUBLIC_LIGHT_THEME=true npx next dev --turbo -p 3481
 *   node scripts/docs-media/mock/shoot.mjs [--list] [--theme light|dark] [--keep-png] [id-substring…]
 *
 * Nothing listens on :8799. Output: public/docs-assets/<page>/<name>.webp and <name>.dark.webp at 2× DPR
 * (WebP q≈82, stepped down to stay ≤ 180 KB), like capture.mjs. Unmocked paths are answered 404 and
 * listed at the end. Shots: shots.mjs (format below). Then run `npm run docs:media-manifest`.
 *
 * Shot: { id, page: "/integrations/zoom", name, url, viewport?, themes?, prepare?(h), crop?: {selector, pad} |
 *         {box} | (h) => ({box}), handlers?: [[path|RegExp, (url, method, req, match) => body]] }
 */
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as world from "./world.mjs";
import SHOTS from "./shots.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, "../../..");
const ASSETS = path.join(FRONTEND, "public/docs-assets");
const APP = process.env.MOCK_APP || "http://localhost:3481";
const API = process.env.MOCK_API || "http://127.0.0.1:8799";
const CWEBP = process.env.CWEBP || "/opt/homebrew/bin/cwebp";
const MAX_BYTES = 180_000;

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const filters = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--theme");
if (flag("--list")) { for (const s of SHOTS) console.log(`${s.id.padEnd(28)} ${s.page}/${s.name}`); process.exit(0); }
const pick = SHOTS.filter((s) => !filters.length || filters.some((f) => s.id.includes(f)));
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
const unknown = new Set();

function toWebp(png, out) {
  for (const q of [82, 74, 66, 58, 50]) {
    execFileSync(CWEBP, ["-quiet", "-q", String(q), "-m", "6", png, "-o", out]);
    if (statSync(out).size <= MAX_BYTES) return q;
  }
  return 50;
}

const browser = await chromium.launch();
for (const shot of pick) {
  for (const theme of shot.themes || [opt("--theme") || "light", ...(opt("--theme") ? [] : ["dark"])]) {
    const vp = shot.viewport || { width: 1440, height: 900 };
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: shot.dpr || 2, colorScheme: theme, timezoneId: "Asia/Kolkata", locale: "en-US",
      isMobile: !!shot.mobile, hasTouch: !!shot.mobile });
    await ctx.clock.setFixedTime(new Date(world.NOW));
    await ctx.addInitScript(([t, ls]) => {
      localStorage.setItem("markdrop_token", "mock");
      localStorage.setItem("md_theme", t);
      for (const [k, v] of Object.entries(ls || {})) localStorage.setItem(k, v);
      const hide = () => { const s = document.createElement("style"); s.textContent = "nextjs-portal{display:none!important}*{caret-color:transparent}"; document.documentElement.appendChild(s); };
      if (document.documentElement) hide(); else document.addEventListener("DOMContentLoaded", hide);
    }, [theme, shot.storage]);
    world.extra.length = 0;
    world.extra.push(...(shot.handlers || []));
    await ctx.route(`${API}/**`, async (route) => {
      const req = route.request(); const u = new URL(req.url());
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      let body;
      try { body = world.answer(u, req.method(), req); } catch (e) { console.log("handler error", u.pathname, e.message); }
      if (body === undefined) { unknown.add(`${shot.id}: ${req.method()} ${u.pathname}`); return route.fulfill({ status: 404, headers: cors, contentType: "application/json", body: '{"detail":"Not found"}' }); }
      if (body && body.__status) return route.fulfill({ status: body.__status, headers: cors, contentType: "application/json", body: JSON.stringify(body.body ?? {}) });
      return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify(body) });
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("pageerror", shot.id, e.message.slice(0, 200)));
    const h = {
      page, theme, world, loc: (s) => page.locator(s).first(),
      goto: (u) => page.goto(APP + u, { waitUntil: "networkidle", timeout: 180_000 }),
      settle: (ms = 600) => page.waitForTimeout(ms),
    };
    try {
      await h.goto(shot.url);
      if (shot.prepare) await shot.prepare(h);
      await h.settle(700);
      await page.mouse.move(vp.width - 4, vp.height - 4);
      await h.settle(300);
      let clip;
      const c = typeof shot.crop === "function" ? await shot.crop(h) : shot.crop;
      if (c?.selector) {
        const b = await page.locator(c.selector).first().boundingBox();
        const pad = c.pad ?? 0;
        clip = { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: Math.min(vp.width, b.width + 2 * pad), height: b.height + 2 * pad };
      } else if (c?.box) clip = c.box;
      const dir = path.join(ASSETS, shot.page.replace(/^\//, ""));
      mkdirSync(dir, { recursive: true });
      const png = path.join(dir, `${shot.name}${theme === "dark" ? ".dark" : ""}.png`);
      await page.screenshot({ path: png, clip, fullPage: !clip && !!shot.fullPage });
      const out = png.replace(/\.png$/, ".webp");
      const q = toWebp(png, out);
      if (!flag("--keep-png")) rmSync(png);
      console.log(`✓ ${shot.id} ${theme} → ${path.relative(FRONTEND, out)} (${Math.round(statSync(out).size / 1024)} KB, q${q})`);
    } catch (e) {
      console.log(`✗ ${shot.id} ${theme}: ${e.message.split("\n")[0]}`);
      await page.screenshot({ path: path.join(HERE, `.fail-${shot.id}-${theme}.png`) }).catch(() => {});
    }
    await ctx.close();
  }
}
await browser.close();
if (unknown.size) console.log("unmocked (404):\n  " + [...unknown].join("\n  "));
