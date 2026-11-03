/**
 * The 300-block profile (Chromium): a page with every round 2 construct, 300 top-level blocks.
 *   - load: navigation → editable, and the long tasks on the way;
 *   - typing 60 characters in the middle: the editor's dispatch time per transaction, the slow key
 *     events (Event Timing, ≥16 ms: input delay + handlers + the next paint), and a CPU profile's
 *     top self-time functions;
 *   - arrow keys (selection only), a block selection of 100 blocks, a hover sweep over the handle;
 *   - the reader: navigation → first block visible, and its long tasks.
 *
 *   node perf.mjs                 (against stack.sh; PB_APP to point at `next start` instead)
 *   PERF_OUT=result.json          also write the numbers to a file
 */
import fs from "node:fs";
import { APP, context, launch, newPage, readerContext } from "./lib.mjs";
import { page300 } from "./page300.mjs";

const stat = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const q = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))] ?? 0;
  return { n: s.length, median: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +(s[s.length - 1] ?? 0).toFixed(2) };
};

const slug = await newPage("300 blocks", page300());
const browser = await launch();
const { p } = await context(browser);
const cdp = await p.context().newCDPSession(p);
await p.addInitScript(() => {
  window.__long = [];
  try {
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ type: "longtask", buffered: true });
  } catch {}
});

// Warm the route (dev compiles on first hit), then measure.
await p.goto(`${APP}/${slug}?edit=1`, { waitUntil: "networkidle" });
await p.locator('.ProseMirror[contenteditable="true"]').waitFor({ timeout: 90000 });
await p.waitForTimeout(1500);
const t0 = Date.now();
await p.goto(`${APP}/${slug}?edit=1`, { waitUntil: "domcontentloaded" });
await p.locator('.ProseMirror[contenteditable="true"]').waitFor({ timeout: 90000 });
const loadMs = Date.now() - t0;
await p.waitForTimeout(2500);
const loadLong = await p.evaluate(() => window.__long);
const blocks = await p.evaluate(() => document.querySelector(".ProseMirror").editor.state.doc.childCount);

await p.evaluate(() => {
  const view = document.querySelector(".ProseMirror").editor.view;
  const orig = view.dispatch.bind(view);
  window.__d = [];
  view.dispatch = (tr) => {
    const t = performance.now();
    orig(tr);
    window.__d.push(performance.now() - t);
  };
  window.__e = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (["keydown", "keypress", "keyup", "input", "beforeinput", "pointerdown", "pointerup", "click", "mousemove"].includes(e.name)) window.__e.push({ name: e.name, duration: e.duration, processing: +(e.processingEnd - e.processingStart).toFixed(1) });
  }).observe({ type: "event", durationThreshold: 16, buffered: false });
});
// The caret in the middle of the page (the 40th paragraph).
await p.evaluate(() => {
  const ed = document.querySelector(".ProseMirror").editor;
  let at = null, n = 0;
  ed.state.doc.forEach((node, off) => {
    if (node.type.name === "paragraph" && n++ === 40 && at === null) at = off + 1 + node.content.size;
  });
  ed.chain().focus().setTextSelection(at).scrollIntoView().run();
});
await p.waitForTimeout(500);

const take = () => p.evaluate(() => {
  const out = { d: window.__d, e: window.__e, long: window.__long };
  window.__d = [];
  window.__e = [];
  window.__long = [];
  return out;
});
await take();

// Typing, with a CPU profile.
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
await cdp.send("Profiler.start");
const text = " the quick brown fox jumps over the lazy dog again and again";
await p.keyboard.type(text, { delay: 40 });
await p.waitForTimeout(800);
const { profile } = await cdp.send("Profiler.stop");
const typing = await take();

// Self time by function.
const self = new Map();
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const dt = profile.timeDeltas;
profile.samples.forEach((id, i) => {
  const n = byId.get(id);
  const f = n.callFrame;
  if (["(idle)", "(program)", "(garbage collector)"].includes(f.functionName)) return;
  const key = `${f.functionName || "(anonymous)"} ${(f.url.split("/").pop() || "").split("?")[0]}:${f.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
});
const busy = [...self.values()].reduce((a, b) => a + b, 0);
/** Inclusive time of this app's own functions (any frame from src/, not node_modules). */
function appInclusive(prof) {
  const nodes = new Map(prof.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const ours = new Map();
  prof.samples.forEach((id, i) => {
    if (["(idle)", "(program)", "(garbage collector)"].includes(nodes.get(id).callFrame.functionName)) return;
    const seen = new Set();
    for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
      const f = nodes.get(cur).callFrame;
      if (!/\/src\/|_src_|components_|\/(lib|app)\//.test(f.url) || /node_modules/.test(f.url)) continue;
      const key = `${f.functionName || "(anonymous)"} ${(f.url.split("/").pop() || "").split("?")[0]}:${f.lineNumber + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ours.set(key, (ours.get(key) ?? 0) + (prof.timeDeltas[i] ?? 0) / 1000);
    }
  });
  return [...ours.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${v.toFixed(1)} ms  ${k}`);
}
const topOurs = appInclusive(profile);
const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${v.toFixed(1)} ms  ${k}`);

// Arrow keys: selection changes only.
for (let i = 0; i < 30; i++) await p.keyboard.press(i % 2 ? "ArrowDown" : "ArrowUp", { delay: 20 });
await p.waitForTimeout(400);
const arrows = await take();

// Select 100 blocks (Esc, then Shift+↓ ×99) and clear it.
await cdp.send("Profiler.start");
await p.keyboard.press("Escape");
for (let i = 0; i < 99; i++) await p.keyboard.press("Shift+ArrowDown");
await p.waitForTimeout(400);
const selProfile = (await cdp.send("Profiler.stop")).profile;
const selected = await p.locator(".ProseMirror .dxe-block-sel").count();
const blockSel = await take();
const slowest = blockSel.d.map((ms, i) => [i, +ms.toFixed(1)]).sort((a, b) => b[1] - a[1]).slice(0, 5);
await p.keyboard.press("ArrowDown");

// Hover sweep over the page (the block handle follows the pointer).
const box = await p.locator(".ProseMirror").boundingBox();
for (let y = 120; y < 860; y += 12) await p.mouse.move(box.x + 40, y);
await p.waitForTimeout(400);
const hover = await take();

// The reader (signed out: the owner opens the editor at the page's address).
const rd = (await readerContext(browser, slug)).p;
await rd.addInitScript(() => {
  window.__long = [];
  try {
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ type: "longtask", buffered: true });
  } catch {}
});
const r0 = Date.now();
await rd.goto(`${APP}/${slug}`, { waitUntil: "domcontentloaded" });
await rd.locator(".pb-page h2").first().waitFor({ timeout: 90000 });
const readerMs = Date.now() - r0;
await rd.waitForTimeout(2000);
const readerLong = await rd.evaluate(() => window.__long);

const evStat = (x) => ({ slow_events: x.e.length, worst_event_ms: Math.max(0, ...x.e.map((e) => e.duration)), long_tasks: x.long.length, worst_long_task_ms: Math.round(Math.max(0, ...x.long)) });
const res = {
  app: APP,
  blocks,
  load: { to_editable_ms: loadMs, long_tasks: loadLong.length, worst_long_task_ms: Math.round(Math.max(0, ...loadLong)), total_long_ms: Math.round(loadLong.reduce((a, b) => a + b, 0)) },
  typing: { keystrokes: text.length, dispatch_ms: stat(typing.d), ...evStat(typing), cpu_busy_ms: Math.round(busy), cpu_ms_per_key: +(busy / text.length).toFixed(2), top_self_time: top, top_app_inclusive: topOurs },
  arrows: { dispatch_ms: stat(arrows.d), ...evStat(arrows) },
  select_100_blocks: { selected, dispatch_ms: stat(blockSel.d), slowest_dispatches: slowest, ...evStat(blockSel), top_app_inclusive: appInclusive(selProfile) },
  hover_sweep: evStat(hover),
  reader: { to_first_heading_ms: readerMs, long_tasks: readerLong.length, worst_long_task_ms: Math.round(Math.max(0, ...readerLong)) },
};
console.log(JSON.stringify(res, null, 2));
if (process.env.PERF_OUT) fs.writeFileSync(process.env.PERF_OUT, JSON.stringify(res, null, 2));
await browser.close();
