#!/usr/bin/env node
/**
 * The markdrop.in landing page's Pages loop (frontend/public/landing-desk/pages(.dark).{mp4,webm,webp}):
 * the real page editor, recorded with Playwright against the page builder's mock API. See README.md.
 *
 *   zsh stack.sh up                    mock API :8797 + `next dev` :3197 of this checkout
 *   node record.mjs                    record both themes → .data/<theme>/master.mp4 + take.json
 *   node record.mjs encode             cut + encode (nice -n 10, one file at a time) → public/landing-desk/pages*
 *   node record.mjs all                record, then encode
 *   node record.mjs sheet              contact sheets of the masters (.data/<theme>/sheet.png, a frame every 2 s)
 *   zsh stack.sh down
 *
 * env: APP (http://localhost:3197), API (http://127.0.0.1:8797), THEMES (light,dark), HEADED=1,
 *      DATA (masters and the generated files; default ./.data, git-ignored), KEEP=1 keeps the raw frames.
 *
 * The take (one per theme, ~30 s recorded, ~23 s after the 1.4× speed-up):
 *   a page "Launch review" in Acme's workspace with one line of text → "/" opens the block menu →
 *   "callout" → a callout, typed into → "/" "todo" → a to-do → "/embed" → the item picker → Acme →
 *   "q3" → Q3 report: the PDF renders in the page (the real Worker PDF viewer, pdf.js) and the view
 *   rests on it until "Saved" (the poster frame) → "/embed" → "offsite" → the team photo renders →
 *   back to the top → cross-fade into the start.
 *
 * The embedded files are real: a 2-page Acme Q3 report PDF (printed by Chromium from REPORT_HTML) and
 * an illustration for the photo (PHOTO_HTML), cached in DATA/files. The PDF frame is served by the
 * REAL Worker code (worker/src/index.js, imported here with an in-memory R2 marking both files
 * public): the mock's stand-ins (/v/pdf/<slug>, /r/<slug>) are intercepted with Playwright routes.
 * The mock's access-test items (secret plan, password doc, encrypted doc) are filtered out of the
 * picker's listings so they don't show in the loop.
 *
 * Selectors are the page builder's as of feat/page-builder c39d8f2 (SEL below, the picker's "Search
 * items" field and "Acme" tab, the slash menu's "callout" / "todo" / "embed" filters). If the polish
 * renames them, change them here. Fictional data only (Acme, Ada Owner).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, "../../..");
const WORKER = path.resolve(FRONTEND, "../worker/src/index.js");
const OUT = path.join(FRONTEND, "public/landing-desk");
const DATA = path.resolve(process.env.DATA || path.join(HERE, ".data"));
const APP = process.env.APP || "http://localhost:3197";
const API = process.env.API || "http://127.0.0.1:8797";
const THEMES = (process.env.THEMES || "light,dark").split(",");
const FFMPEG = fs.existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg";
const FFPROBE = fs.existsSync("/opt/homebrew/bin/ffprobe") ? "/opt/homebrew/bin/ffprobe" : "ffprobe";

/** The browser window: the app's header plus the 720 px page column, with a little air. 4:3. */
const VIEW = { width: 960, height: 720 };
const DPR = 2;

/** The cut: speed-up, last frame held, cross-fade back into the start, output width (≈2× as shown), CRF H.264 / VP9. */
const CUT = { speed: 1.4, hold: 1.0, fade: 0.5, width: 1200, crf: [32, 46] };

const SEL = {
  editor: ".ProseMirror[contenteditable='true']",
  slash: ".dxe-slash",
  embed: ".pb-embed",
  img: ".pb-embed__img",
  frame: ".pb-embed iframe",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("•", ...a);
const ff = (args) => execFileSync("nice", ["-n", "10", FFMPEG, "-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: "inherit" });

/* ── the embedded files ─────────────────────────────────────────────────────── */

const REPORT_HTML = `<!doctype html><meta charset="utf-8"><style>
  @page { size: Letter; margin: 0 }
  * { box-sizing: border-box }
  body { margin: 0; font: 13px/1.55 "Helvetica Neue", Helvetica, Arial, sans-serif; color: #1d2433 }
  .pg { width: 8.5in; height: 11in; padding: 0.7in 0.75in; position: relative; page-break-after: always; overflow: hidden }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 14px; color: #0f5f55 }
  .mark { width: 28px; height: 28px; border-radius: 7px; background: #0f766e; color: #fff; display: grid; place-items: center; font-weight: 800 }
  .meta { position: absolute; right: 0.75in; top: 0.78in; font-size: 11px; color: #6b7280; letter-spacing: .04em; text-transform: uppercase }
  h1 { font-size: 40px; line-height: 1.05; letter-spacing: -.02em; margin: 0.55in 0 8px }
  .sub { font-size: 15px; color: #4b5563; margin: 0 0 28px }
  .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 26px }
  .kpi { border: 1px solid #e5e7eb; border-radius: 10px; padding: 14px 16px }
  .kpi span { display: block; font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: .05em }
  .kpi b { display: block; font-size: 28px; letter-spacing: -.02em; margin: 4px 0 2px }
  .kpi em { font-style: normal; font-size: 12px; color: #0f766e; font-weight: 700 }
  h2 { font-size: 17px; margin: 22px 0 8px }
  .chart { border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px 18px 10px }
  p { margin: 0 0 10px; color: #374151 }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #e5e7eb }
  th { color: #6b7280; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .04em }
  td.n { text-align: right; font-variant-numeric: tabular-nums }
  .foot { position: absolute; left: 0.75in; right: 0.75in; bottom: 0.5in; font-size: 10px; color: #9ca3af; display: flex; justify-content: space-between }
</style>
<div class="pg">
  <div class="brand"><span class="mark">A</span>Acme</div>
  <div class="meta">Board update · October 2026</div>
  <h1>Q3 report</h1>
  <p class="sub">Revenue, customers and what we ship next quarter.</p>
  <div class="kpis">
    <div class="kpi"><span>Revenue</span><b>$2.06M</b><em>+18% vs Q2</em></div>
    <div class="kpi"><span>Active teams</span><b>5,690</b><em>+38%</em></div>
    <div class="kpi"><span>Net retention</span><b>124%</b><em>+6 pts</em></div>
  </div>
  <h2>Monthly revenue</h2>
  <div class="chart">
    <svg viewBox="0 0 600 190" width="100%">
      <g stroke="#eef0f3">${[30, 70, 110, 150].map((y) => `<line x1="0" x2="600" y1="${y}" y2="${y}"/>`).join("")}</g>
      ${[52, 58, 61, 66, 70, 75, 83, 90, 97].map((v, i) => `<rect x="${12 + i * 66}" y="${170 - v * 1.6}" width="40" height="${v * 1.6}" rx="5" fill="${i > 5 ? "#0f766e" : "#99d6cf"}"/>`).join("")}
      <g font-size="11" fill="#6b7280">${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"].map((m, i) => `<text x="${32 + i * 66}" y="186" text-anchor="middle">${m}</text>`).join("")}</g>
    </svg>
  </div>
  <h2>Highlights</h2>
  <p>Revenue grew for the ninth month in a row, led by teams that moved their docs and launch material into one workspace. Expansion revenue passed new business for the first time.</p>
  <p>Support tickets per account fell by a quarter after the new onboarding guides went live.</p>
  <div class="foot"><span>Acme · Confidential</span><span>1 / 2</span></div>
</div>
<div class="pg">
  <div class="brand"><span class="mark">A</span>Acme</div>
  <h2 style="margin-top:.5in">Revenue by plan</h2>
  <table>
    <tr><th>Plan</th><th class="n">Q2</th><th class="n">Q3</th><th class="n">Change</th></tr>
    <tr><td>Team</td><td class="n">$842k</td><td class="n">$968k</td><td class="n">+15%</td></tr>
    <tr><td>Business</td><td class="n">$611k</td><td class="n">$744k</td><td class="n">+22%</td></tr>
    <tr><td>Enterprise</td><td class="n">$293k</td><td class="n">$348k</td><td class="n">+19%</td></tr>
  </table>
  <h2>Next quarter</h2>
  <p>Ship the page builder to every workspace, open the partner program and hire two support engineers in Europe.</p>
  <div class="foot"><span>Acme · Confidential</span><span>2 / 2</span></div>
</div>`;

/** "Team offsite photo": a calm illustration (lake, hills, evening sky, tents), 1600 × 900. */
const PHOTO_HTML = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0}</style>
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6c9a8"/><stop offset=".55" stop-color="#f9e2c7"/><stop offset="1" stop-color="#fdf1e2"/></linearGradient>
    <linearGradient id="lake" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9cc7cf"/><stop offset="1" stop-color="#4e8794"/></linearGradient>
    <radialGradient id="sun" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff6e5"/><stop offset=".6" stop-color="#ffd9a6"/><stop offset="1" stop-color="#ffd9a6" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1600" height="900" fill="url(#sky)"/>
  <circle cx="1080" cy="410" r="190" fill="url(#sun)"/>
  <circle cx="1080" cy="410" r="62" fill="#fff3df"/>
  <path d="M0 470 L180 330 L320 420 L520 250 L720 430 L860 360 L1000 470 Z" fill="#c9a6a9"/>
  <path d="M600 480 L820 300 L960 400 L1150 280 L1380 440 L1600 330 L1600 520 L600 520 Z" fill="#b48f98"/>
  <path d="M0 520 C 220 450, 420 500, 640 470 S 1100 440, 1600 490 L1600 560 L0 560 Z" fill="#6f8f7f"/>
  <rect y="548" width="1600" height="352" fill="url(#lake)"/>
  <g fill="#fff3df" opacity=".55">${Array.from({ length: 9 }, (_, i) => `<rect x="${1000 + (i % 3) * 30 - i * 6}" y="${575 + i * 22}" width="${160 - i * 14}" height="4" rx="2"/>`).join("")}</g>
  <path d="M0 640 C 260 610, 420 680, 640 668 C 760 662, 840 720, 980 900 L0 900 Z" fill="#3f5f55"/>
  <g fill="#2f4a42">${[[90, 600], [150, 585], [215, 605], [520, 640], [585, 628]].map(([x, y]) => `<path d="M${x} ${y} l26 -110 l26 110 z"/>`).join("")}</g>
  <g transform="translate(300 650)"><path d="M0 70 L70 0 L140 70 Z" fill="#e9785a"/><path d="M70 0 L92 70 L48 70 Z" fill="#b8553c"/></g>
  <g transform="translate(440 668)"><path d="M0 56 L56 0 L112 56 Z" fill="#f1b24a"/><path d="M56 0 L74 56 L38 56 Z" fill="#c98a28"/></g>
  <g fill="#253a34">${[[230, 735], [262, 728], [294, 736], [326, 730]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="13"/><rect x="${x - 13}" y="${y + 12}" width="26" height="40" rx="11"/>`).join("")}</g>
  <circle cx="380" cy="790" r="14" fill="#ffb15c"/><circle cx="380" cy="790" r="34" fill="#ffb15c" opacity=".25"/>
</svg>`;

async function makeFiles(browser) {
  const dir = path.join(DATA, "files");
  fs.mkdirSync(dir, { recursive: true });
  const pdf = path.join(dir, "q3-report.pdf");
  const png = path.join(dir, "team-photo.png");
  const p = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  if (!fs.existsSync(pdf)) {
    await p.setContent(REPORT_HTML);
    await p.pdf({ path: pdf, format: "Letter", printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  }
  if (!fs.existsSync(png)) {
    await p.setContent(PHOTO_HTML);
    await p.screenshot({ path: png });
  }
  await p.close();
  return { "art/q3-report.pdf": { body: fs.readFileSync(pdf), type: "application/pdf" }, "art/team-photo.png": { body: fs.readFileSync(png), type: "image/png" } };
}

/** The real Worker, with an in-memory R2 holding the two files (public, so no tokens). */
async function workerFor(files) {
  const worker = (await import(WORKER)).default;
  const meta = (k, o) => ({ key: k, size: o.body.length, etag: "e", httpEtag: '"e"', uploaded: new Date(), httpMetadata: { contentType: o.type }, customMetadata: { public: "1" } });
  const ARTIFACTS = {
    async head(k) {
      return files[k] ? meta(k, files[k]) : null;
    },
    async get(k, opts) {
      const o = files[k];
      if (!o) return null;
      let b = o.body;
      if (opts?.range) b = b.subarray(opts.range.offset, opts.range.offset + opts.range.length);
      return { ...meta(k, o), body: new Blob([b]).stream(), writeHttpMetadata: (h) => h.set("content-type", o.type) };
    },
  };
  return (url, headers) => worker.fetch(new Request(url, { headers }), { ARTIFACTS, ARTIFACT_SIGNING_KEY: "landing-loop" });
}

/* ── signed in, the theme, no dev chrome, a fake cursor (as scripts/docs-media/capture.mjs draws it) ── */

function initScript({ theme }) {
  try {
    localStorage.setItem("markdrop_token", "tok-owner");
    localStorage.setItem("md_theme", theme);
    localStorage.setItem("md_theme_beta", "1");
    localStorage.setItem("md_consent", "denied");
  } catch {}
  const add = () => {
    if (document.getElementById("__ll-style") || window.top !== window) return;
    const st = document.createElement("style");
    st.id = "__ll-style";
    st.textContent = `nextjs-portal, [data-nextjs-toast], #__next-build-watcher { display: none !important; }
      #__ll-cursor { position: fixed; left: 0; top: 0; width: 26px; height: 26px; z-index: 2147483647; pointer-events: none; transform: translate(-100px, -100px); }
      #__ll-cursor svg { filter: drop-shadow(0 1px 2px rgba(0,0,0,.35)); }
      .__ll-ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 40px; height: 40px; margin: -20px 0 0 -20px; border-radius: 50%;
        background: rgba(37, 99, 235, .25); border: 2px solid rgba(37, 99, 235, .5); animation: __ll-r .5s ease-out forwards; }
      @keyframes __ll-r { from { transform: scale(.3); opacity: 1 } to { transform: scale(1.3); opacity: 0 } }`;
    document.head.appendChild(st);
    const c = document.createElement("div");
    c.id = "__ll-cursor";
    c.innerHTML = `<svg width="26" height="26" viewBox="0 0 26 26"><path d="M4 2.5 L4 21 L9.2 16.4 L12.6 24 L16 22.5 L12.7 15 L19.5 15 Z" fill="#fff" stroke="#111827" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    document.documentElement.appendChild(c);
  };
  window.__ll = {
    move(x, y) {
      const c = document.getElementById("__ll-cursor");
      if (c) c.style.transform = `translate(${x - 4}px, ${y - 2}px)`;
    },
    ripple(x, y) {
      const r = document.createElement("div");
      r.className = "__ll-ripple";
      r.style.left = `${x}px`;
      r.style.top = `${y}px`;
      document.documentElement.appendChild(r);
      setTimeout(() => r.remove(), 600);
    },
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add);
  else add();
}

function cursor(page) {
  let at = [VIEW.width * 0.78, VIEW.height * 0.82];
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  async function moveTo(x, y, ms = 650) {
    const [x0, y0] = at;
    const n = Math.max(8, Math.round(ms / 16));
    for (let i = 1; i <= n; i++) {
      const t = ease(i / n);
      const nx = x0 + (x - x0) * t;
      const ny = y0 + (y - y0) * t;
      await page.mouse.move(nx, ny);
      await page.evaluate(([a, b]) => window.__ll?.move(a, b), [nx, ny]);
      await sleep(ms / n);
    }
    at = [x, y];
  }
  return {
    show: () => page.evaluate(([a, b]) => window.__ll?.move(a, b), at),
    moveTo,
    async click(locator, { dx = 0.5, dy = 0.5, ms } = {}) {
      const b = await locator.boundingBox();
      if (!b) throw new Error("nothing to click");
      const x = b.x + b.width * dx;
      const y = b.y + b.height * dy;
      await moveTo(x, y, ms);
      await sleep(120);
      await page.evaluate(([a, c]) => window.__ll?.ripple(a, c), [x, y]);
      await page.mouse.click(x, y);
    },
  };
}

/* ── screencast: CDP frames at device resolution → a near-lossless master ───────── */

async function screencast(page, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  let n = 0;
  cdp.on("Page.screencastFrame", (f) => {
    const file = path.join(dir, `f${String(++n).padStart(5, "0")}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, t: Date.now() });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: VIEW.width * DPR, maxHeight: VIEW.height * DPR, everyNthFrame: 1 });
  const t0 = Date.now();
  return {
    /** Seconds since the recording started (the master's clock). */
    elapsed: () => (Date.now() - t0) / 1000,
    async stop(master) {
      const end = Date.now();
      await cdp.send("Page.stopScreencast").catch(() => {});
      await sleep(200);
      await cdp.detach().catch(() => {});
      // Chrome sends a frame only when something changes: each frame lasts until the next one.
      const list = ["ffconcat version 1.0"];
      frames.forEach((f, i) => {
        const next = i + 1 < frames.length ? frames[i + 1].t : end;
        list.push(`file '${f.file}'`, `duration ${Math.max(0.001, (next - f.t) / 1000).toFixed(4)}`);
      });
      list.push(`file '${frames.at(-1).file}'`);
      const lf = path.join(dir, "list.ffconcat");
      fs.writeFileSync(lf, list.join("\n") + "\n");
      ff(["-f", "concat", "-safe", "0", "-i", lf, "-vf", `fps=30,scale=${VIEW.width * DPR}:${VIEW.height * DPR}:flags=lanczos,format=yuv420p`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "10", master]);
      log(`master ${path.relative(DATA, master)}: ${frames.length} frames, ${((end - frames[0].t) / 1000).toFixed(1)} s`);
    },
  };
}

/* ── the take ─────────────────────────────────────────────────────────────────── */

async function api(p, body, token = "tok-owner") {
  const r = await fetch(`${API}${p}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return r.status === 204 ? null : r.json();
}

/** Scroll the page (whatever scrolls it) back to the top, smoothly. */
async function toTop(page) {
  await page.evaluate(() => {
    const all = [document.scrollingElement, ...document.querySelectorAll("*")].filter((el) => el && el.scrollTop > 0);
    for (const el of all) el.scrollTo({ top: 0, behavior: "smooth" });
  });
}

async function typeSlow(page, text, delay = 55) {
  for (const ch of text) {
    await page.keyboard.type(ch);
    await sleep(delay + (ch === " " ? 25 : 0));
  }
}

async function take(browser, files, theme) {
  const workerFetch = await workerFor(files);
  await api("/__mock/reset", {});
  const { document: doc } = await api("/api/v1/pages", { title: "Launch review", workspace: "ws1", folder: "f-guides", content: "Everything for Thursday's launch review, in one place.\n" });
  log(theme, "page", doc.slug);

  const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: DPR, colorScheme: theme, reducedMotion: "no-preference" });
  await ctx.addInitScript(initScript, { theme });
  // The mock's stand-ins for the Worker → the real Worker with the real files.
  await ctx.route(`${API}/v/pdf/q3-report*`, async (route) => {
    const u = new URL(route.request().url());
    const res = await workerFetch(`${API}/v/pdf/art/q3-report.pdf?theme=${u.searchParams.get("theme") || theme}`, { "sec-fetch-dest": "iframe" });
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
  });
  await ctx.route(`${API}/r/art/**`, async (route) => {
    const req = route.request();
    const res = await workerFetch(req.url(), { ...req.headers() });
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
  });
  await ctx.route(`${API}/r/team-photo*`, (route) => route.fulfill({ status: 200, contentType: "image/png", body: files["art/team-photo.png"].body }));
  // The mock's access-test items (a secret plan, a password doc, an encrypted one) stay out of the picker.
  const HIDE = new Set(["secret-plan", "pw-doc", "enc-doc"]);
  const listing = async (route) => {
    const res = await route.fetch();
    const j = await res.json();
    for (const k of ["items", "documents"]) if (Array.isArray(j[k])) j[k] = j[k].filter((d) => !HIDE.has(d.slug));
    await route.fulfill({ response: res, json: j });
  };
  await ctx.route(`${API}/api/v1/workspaces/ws1/items**`, listing);
  await ctx.route(`${API}/api/v1/me/documents**`, listing);

  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message.slice(0, 200)));
  await page.goto(`${APP}/${doc.slug}?edit=1`, { waitUntil: "networkidle" });
  const ed = page.locator(SEL.editor);
  await ed.waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500);
  // The caret at the end of the line, before the take starts.
  await ed.getByText("in one place").click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("End");
  await page.mouse.move(VIEW.width * 0.78, VIEW.height * 0.82);
  const cur = cursor(page);
  await cur.show();
  await page.waitForTimeout(800);

  const dir = path.join(DATA, theme);
  const rec = await screencast(page, path.join(dir, "frames"));
  let poster = 0;
  await sleep(900);

  // 1. "/" → the block menu → a callout.
  await page.keyboard.press("Enter");
  await sleep(250);
  await page.keyboard.type("/");
  await page.locator(SEL.slash).waitFor();
  await sleep(900);
  await typeSlow(page, "callout", 85);
  await sleep(500);
  await page.keyboard.press("Enter");
  await sleep(250);
  await typeSlow(page, "Ship the docs before the announcement.");
  await sleep(500);
  // Out of the callout: Enter on its empty last line leaves the block.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await sleep(250);

  // 2. a to-do.
  await page.keyboard.type("/");
  await page.locator(SEL.slash).waitFor();
  await sleep(350);
  await typeSlow(page, "todo", 85);
  await sleep(350);
  await page.keyboard.press("Enter");
  await sleep(200);
  await typeSlow(page, "Check the Q3 numbers with Ben");
  await sleep(450);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await sleep(200);

  // 3. embed the PDF and the photo from Acme's workspace.
  for (const [q, title] of [["q3", "Q3 report"], ["offsite", "Team offsite photo"]]) {
    await page.keyboard.type("/");
    await page.locator(SEL.slash).waitFor();
    await sleep(250);
    await typeSlow(page, "embed", 85);
    await sleep(350);
    await page.keyboard.press("Enter");
    const dlg = page.getByRole("dialog");
    await dlg.waitFor();
    await sleep(400);
    const tab = dlg.getByRole("tab", { name: "Acme" });
    if (await tab.count()) {
      await cur.click(tab, { ms: 550 });
      await sleep(300);
    }
    await dlg.getByLabel("Search items").focus();
    await typeSlow(page, q, 110);
    const hit = dlg.getByText(title, { exact: true }).first();
    await hit.waitFor();
    await sleep(500);
    await cur.click(hit, { dx: 0.3, ms: 600 });
    await dlg.waitFor({ state: "hidden" });
    // Off the page's text (hovering a callout shows its title field).
    void cur.moveTo(VIEW.width * 0.9, VIEW.height * 0.62, 450);
    const fig = page.locator(SEL.embed).last();
    await fig.waitFor();
    if (q === "q3") {
      // The PDF's first page under the callout and the to-do (after the editor's own scroll to the block).
      await sleep(350);
      await toTop(page);
      await page.frameLocator(SEL.frame).last().locator(".page canvas").first().waitFor({ timeout: 30000 });
      await toTop(page);
      // Autosave catches up ("Saved"), then the poster frame.
      await sleep(900);
      await page.getByText("Saved", { exact: true }).first().waitFor({ timeout: 4000 }).catch(() => {});
      await sleep(300);
      poster = rec.elapsed();
      await sleep(900);
    } else {
      // Follow the photo down the page while it loads.
      await fig.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
      await page.locator(SEL.img).last().waitFor();
      await page.waitForFunction((s) => [...document.querySelectorAll(s)].every((i) => i.complete && i.naturalWidth), SEL.img);
      await sleep(400);
      await fig.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
      await sleep(900);
    }
    await page.keyboard.press("Enter").catch(() => {});
    await sleep(150);
  }
  await cur.moveTo(VIEW.width * 0.86, VIEW.height * 0.9, 500);
  await page.getByText("Saved", { exact: false }).first().waitFor({ timeout: 15000 }).catch(() => log("  (no Saved indicator)"));
  await sleep(1200);
  // Back to the top (the whole page so far), so the cross-fade into the start is short.
  await toTop(page);
  await sleep(1600);
  await rec.stop(path.join(dir, "master.mp4"));
  fs.writeFileSync(path.join(dir, "take.json"), JSON.stringify({ poster, slug: doc.slug }, null, 2));
  if (!process.env.KEEP) fs.rmSync(path.join(dir, "frames"), { recursive: true, force: true });
  const saved = await api(`/__mock/doc/${doc.slug}`);
  for (const want of [":::note", "- [ ] Check the Q3 numbers", 'src="q3-report"', 'src="team-photo"']) {
    if (!saved?.content?.includes(want)) log(`  ! saved Markdown lacks ${want}`);
  }
  await page.screenshot({ path: path.join(dir, "end.png") });
  await ctx.close();
}

/* ── the cut ──────────────────────────────────────────────────────────────────── */

const duration = (f) => Number(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim());
const kb = (f) => `${Math.round(fs.statSync(f).size / 1024)} KB`;

function encode(theme) {
  const master = path.join(DATA, theme, "master.mp4");
  if (!fs.existsSync(master)) return log(`! no ${master}: record first`);
  const { speed, hold, fade: x, width, crf } = CUT;
  const len = duration(master) / speed + hold;
  const pre = [`setpts=PTS/${speed}`, "fps=30", `tpad=stop_mode=clone:stop_duration=${hold}`,
    `scale=${width}:-2:flags=lanczos:out_range=tv:out_color_matrix=bt709`, "format=yuv420p"].join(",");
  // A = from x to the end, B = the first x seconds; A's last x seconds fade into B: no seam. Video
  // range (tv) and BT.709, tagged: the frames are full-range JPEGs, which some decoders refuse.
  const graph = [`[0:v]${pre},split[a0][b0]`, `[a0]trim=start=${x},setpts=PTS-STARTPTS[a]`, `[b0]trim=end=${x},setpts=PTS-STARTPTS[b]`,
    `[a][b]xfade=transition=fade:duration=${x}:offset=${(len - 2 * x).toFixed(3)},format=yuv420p[v]`].join(";");
  const tmp = path.join(DATA, theme, "loop.mp4");
  ff(["-i", master, "-filter_complex", graph, "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "8", tmp]);
  fs.mkdirSync(OUT, { recursive: true });
  const base = path.join(OUT, theme === "dark" ? "pages.dark" : "pages");
  const color = ["-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];
  ff(["-i", tmp, "-an", "-c:v", "libx264", "-preset", "slow", "-tune", "animation", "-crf", String(crf[0]), "-pix_fmt", "yuv420p",
    "-profile:v", "high", "-g", "60", ...color, "-movflags", "+faststart", `${base}.mp4`]);
  ff(["-i", tmp, "-an", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String(crf[1]), "-row-mt", "1", "-deadline", "good", "-cpu-used", "2",
    "-g", "60", "-pix_fmt", "yuv420p", ...color, `${base}.webm`]);
  // The poster: the PDF resting under the callout and the to-do, "Saved" (take.json), on the loop's clock.
  const takeFile = path.join(DATA, theme, "take.json");
  const tk = fs.existsSync(takeFile) ? JSON.parse(fs.readFileSync(takeFile, "utf8")) : {};
  const at = tk.poster ? tk.poster / speed - x : (len - x) * 0.5;
  ff(["-ss", at.toFixed(2), "-i", tmp, "-frames:v", "1", "-c:v", "libwebp", "-quality", "80", "-compression_level", "6", `${base}.webp`]);
  log(`${path.basename(base)}: ${(len - x).toFixed(1)} s · mp4 ${kb(`${base}.mp4`)} · webm ${kb(`${base}.webm`)} · poster ${kb(`${base}.webp`)} (at ${at.toFixed(1)} s)`);
}

function sheet(theme) {
  const master = path.join(DATA, theme, "master.mp4");
  if (!fs.existsSync(master)) return;
  ff(["-i", master, "-vf", "fps=1/2,scale=480:-2,tile=4x4", "-frames:v", "1", path.join(DATA, theme, "sheet.png")]);
  log(`sheet ${path.join(DATA, theme, "sheet.png")}`);
}

/* ── main ─────────────────────────────────────────────────────────────────────── */

const mode = process.argv[2] || "record";
if (mode === "record" || mode === "all") {
  const browser = await chromium.launch({ headless: !process.env.HEADED });
  const files = await makeFiles(browser);
  for (const theme of THEMES) await take(browser, files, theme);
  await browser.close();
}
if (mode === "encode" || mode === "all") for (const theme of THEMES) encode(theme);
if (mode === "sheet") for (const theme of THEMES) sheet(theme);
