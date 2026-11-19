#!/usr/bin/env node
/**
 * Docs CLIPS of the real app against the mocked API (the clip side of shoot.mjs): same Acme world
 * (world.mjs), same fake cursor, click ripples, screencast and encoders as capture.mjs (imported from
 * it), so a clip recorded here matches one recorded on the demo stack. Clips: clips.mjs.
 *
 *   cd frontend
 *   NEXT_PUBLIC_API_URL=http://127.0.0.1:8799 NEXT_PUBLIC_LIGHT_THEME=true npx next dev --turbo -p 3481
 *   node scripts/docs-media/mock/ssr-stub.mjs &      (clips of pages: the server render of /<slug> gets "sign in")
 *   node scripts/docs-media/mock/record.mjs [--list] [--still] [--keep-raw] [id-substring…]
 *
 * --still: run prepare + steps without recording and save a PNG to mock/.still-<id>.png (fast checks).
 * Output: public/docs-assets/<page>/<name>.mp4 (H.264) + .webm (VP9) + .webp poster, 1440 px wide,
 * ≤ 1.5 MB each, light theme (like capture.mjs clips). Then run `npm run docs:media-manifest`.
 *
 * Clip: { id, page, name, url, viewport, out?, storage?, handlers?, prepare?(h), steps(h), tail?, poster?, trim? }
 * h: capture.mjs's helpers (move, click, hover, type, press, wheel, sleep, settle, loc…) plus world, goto(path) and
 * live(msg?): sends the page's mocked live socket a message (default {type: "changed"}: the page re-reads the document).
 */
import { chromium } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as world from "./world.mjs";
import CLIPS from "./clips.mjs";
import { BUDGET, initScript, helpers, startScreencast, framesToVideo, probe, encodeMp4, encodeWebm, toWebp, sleep } from "../capture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, "../../..");
const ASSETS = path.join(FRONTEND, "public/docs-assets");
const APP = process.env.MOCK_APP || "http://localhost:3481";
const API = process.env.MOCK_API || "http://127.0.0.1:8799";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const filters = args.filter((a) => !a.startsWith("--"));
if (flag("--list")) { for (const c of CLIPS) console.log(`${c.id.padEnd(24)} ${c.page}/${c.name}`); process.exit(0); }
const pick = CLIPS.filter((c) => !filters.length || filters.some((f) => c.id.includes(f)));
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
const unknown = new Set();

const browser = await chromium.launch({ channel: "chrome", args: ["--hide-scrollbars", "--force-color-profile=srgb", "--font-render-hinting=none"] });
for (const clip of pick) {
  const theme = "light";
  const viewport = clip.viewport || { width: 1440, height: 900 };
  const out = clip.out || 1440;
  const dpr = Math.max(1, out / viewport.width);
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: dpr, colorScheme: theme, timezoneId: "Asia/Kolkata", locale: "en-US" });
  await ctx.clock.install({ time: new Date(world.NOW) });
  await ctx.addInitScript(initScript, { token: "mock", theme, cursor: true, scrub: false, ports: {} });
  await ctx.addInitScript(([ls]) => {
    try {
      localStorage.setItem("md_consent", "denied");
      for (const [k, v] of Object.entries(ls || {})) localStorage.setItem(k, v);
    } catch { /* storage off */ }
  }, [clip.storage]);
  world.extra.length = 0;
  world.extra.push(...(clip.handlers || []));
  await ctx.route(`${API}/**`, async (route) => {
    const req = route.request(); const u = new URL(req.url());
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    let body;
    try { body = world.answer(u, req.method(), req); } catch (e) { console.log("handler error", u.pathname, e.message); }
    if (body && body.__delay) { await sleep(body.__delay); body = body.body; }
    if (body === undefined) { unknown.add(`${clip.id}: ${req.method()} ${u.pathname}`); return route.fulfill({ status: 404, headers: cors, contentType: "application/json", body: '{"detail":"Not found"}' }); }
    if (body && body.__status) return route.fulfill({ status: body.__status, headers: cors, contentType: "application/json", body: JSON.stringify(body.body ?? {}) });
    if (body && body.__raw) return route.fulfill({ status: 200, headers: cors, contentType: body.type, body: body.__raw });
    return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify(body) });
  });
  // The documents' live socket (/ws/docs/<slug>): held open, so a clip can say "changed" (h.live) and
  // the page re-reads the document as it does when someone else edits it.
  const sockets = [];
  await ctx.routeWebSocket(/\/ws\/docs\//, (ws) => { sockets.push(ws); });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror", clip.id, e.message.slice(0, 200)));
  if (process.env.MOCK_DEBUG) page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) console.log("console", clip.id, m.text().slice(0, 300)); });
  const shot = { ...clip, viewport };
  const live = (msg = { type: "changed" }) => { for (const ws of sockets) { try { ws.send(JSON.stringify(msg)); } catch { /* closed */ } } };
  const withGoto = (h) => Object.assign(h, { world, live, goto: (u, o = {}) => h.page.goto(APP + u, { waitUntil: "networkidle", timeout: 180_000, ...o }) });
  const rawDir = path.join(HERE, ".raw", clip.id);
  rmSync(rawDir, { recursive: true, force: true });
  let rec = null;
  try {
    const pre = withGoto(helpers(page, ctx, shot, {}, null));
    await pre.goto(clip.url);
    await pre.settle(600);
    if (clip.prepare) await clip.prepare(pre);
    if (flag("--still")) {
      await clip.steps(pre);
      await pre.settle(500);
      await page.screenshot({ path: path.join(HERE, `.still-${clip.id}.png`) });
      console.log(`✓ ${clip.id} still → mock/.still-${clip.id}.png`);
    } else {
      rec = await startScreencast(page, path.join(rawDir, "frames"), { width: Math.round(viewport.width * dpr), height: Math.round(viewport.height * dpr) });
      const h = withGoto(helpers(page, ctx, shot, {}, rec));
      await page.evaluate(([x, y]) => window.__mdcap?.move(x, y), clip.cursor || [viewport.width * 0.62, viewport.height * 0.55]).catch(() => {});
      await sleep(400);
      await clip.steps(h);
      await sleep(clip.tail ?? 900);
      const raw = await rec.stop();
      rec = null;
      const master = path.join(rawDir, "master.mp4");
      framesToVideo(raw, master, { fps: 30, trimStart: clip.trim?.start || 0.3, trimEnd: clip.trim?.end || 0, width: out });
      const total = probe(master).duration;
      if (total > 12.5) console.warn(`  ! ${clip.id} is ${total.toFixed(1)} s (clips should be 3–12 s)`);
      const dir = path.join(ASSETS, clip.page.replace(/^\//, ""));
      mkdirSync(dir, { recursive: true });
      const base = path.join(dir, clip.name);
      encodeMp4(master, `${base}.mp4`, { crf: 26, maxBytes: BUDGET.clip });
      encodeWebm(master, `${base}.webm`, { crf: 40, maxBytes: BUDGET.clip });
      toWebp(master, `${base}.webp`, { seek: clip.poster ?? Math.max(0, total - 0.5), maxBytes: BUDGET.screenshot });
      const p = probe(`${base}.mp4`);
      console.log(`✓ ${clip.id} → ${path.relative(FRONTEND, base)}.{mp4,webm,webp} ${p.width}×${p.height} ${p.duration.toFixed(1)} s`);
    }
  } catch (e) {
    console.log(`✗ ${clip.id}: ${e.message.split("\n")[0]}`);
    await page.screenshot({ path: path.join(HERE, `.fail-${clip.id}.png`) }).catch(() => {});
  } finally {
    if (rec) await rec.stop().catch(() => {});
    await ctx.close();
    if (!flag("--keep-raw")) rmSync(rawDir, { recursive: true, force: true });
  }
}
await browser.close();
if (unknown.size) console.log("unmocked (404):\n  " + [...unknown].join("\n  "));
