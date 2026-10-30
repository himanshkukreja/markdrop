#!/usr/bin/env node
/**
 * Docs media capture runner: screenshots, clips and feature videos of the real app, from the local
 * demo stack (stack/stack.sh + seed.py). Shot list: shots.mjs.
 *
 *   npm run docs:media -- <id…>          capture these shots (all of them when none are given)
 *   npm run docs:media -- --list         list shot ids
 *   options: --theme light|dark   only this theme · --headed · --keep-raw (keep PNG/frames in .data/raw)
 *            --no-manifest (don't touch content/docs/media.json / videos.json)
 *
 * What it does per shot (and per theme):
 *   1. a fresh Chrome context (channel "chrome": H.264 plays), the shot's viewport at 2× DPR for
 *      screenshots, every non-local request blocked (production is never contacted), workspace
 *      hosts (docs.acme.com, help.acme.com) mapped to 127.0.0.1, the browser clock set to the
 *      seed's demo "now" (Playwright clock), signed in by putting a minted token in
 *      localStorage.markdrop_token, theme by localStorage.md_theme;
 *   2. runs the shot's `prepare` (not recorded) and `steps` (recorded for clips/videos) with a
 *      fake cursor, click ripples and human-paced typing;
 *   3. screenshot → crop (element / union of elements / box, with padding) → WebP (q≈82, ≤180 KB);
 *      clip → MP4 (H.264, yuv420p, faststart) + WebM (VP9) + WebP poster, ≤1.5 MB;
 *      video → MP4 1920×1080 + WebP poster (+ WebVTT chapters from on-screen captions);
 *   4. for videos, writes the matching entry of frontend/content/docs/videos.json; then refreshes
 *      frontend/content/docs/media.json with the engine's own generator (npm run docs:media-manifest).
 *
 * Outputs: frontend/public/docs-assets/<page-id>/<name>(.dark).webp, …/<name>.mp4|.webm|.webp,
 * frontend/public/docs-assets/videos/<id>.mp4|.webp|.vtt. <page-id> is the docs page path without
 * the leading slash (e.g. workspaces/custom-domain).
 */
import { chromium } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import BASE_SHOTS from "./shots.mjs";
import { readdirSync } from "node:fs";

/** Shots live in shots.mjs plus one file per area in shots/ (each `export default [...]`), so several
 *  people can author shots at once without editing the same file. Ids must be unique across files. */
const SHOT_DIR = new URL("./shots/", import.meta.url);
const EXTRA_SHOTS = [];
try {
  for (const f of readdirSync(SHOT_DIR).filter((n) => n.endsWith(".mjs")).sort()) {
    const mod = await import(new URL(f, SHOT_DIR).href);
    EXTRA_SHOTS.push(...(mod.default || []));
  }
} catch (e) {
  if (e?.code !== "ENOENT") throw e;
}
const SHOTS = [...BASE_SHOTS, ...EXTRA_SHOTS];
{
  const seen = new Set();
  for (const s of SHOTS) {
    if (seen.has(s.id)) throw new Error(`Duplicate shot id: ${s.id}`);
    seen.add(s.id);
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, "../..");
const REPO = path.resolve(FRONTEND, "..");
// Several stacks can run side by side: STACK_ID=N (default 0) targets instance N
// (API 8180+10N, Worker 8787+10N, Next 3400+10N, data .data/N/). See stack/stack.sh.
const STACK_ID = Number(process.env.STACK_ID || 0);
const PORTS = { app: 3400 + 10 * STACK_ID, api: 8180 + 10 * STACK_ID, worker: 8787 + 10 * STACK_ID };
const BASE_DATA = process.env.DOCS_MEDIA_DATA || path.join(HERE, ".data");
const DATA = STACK_ID ? path.join(BASE_DATA, String(STACK_ID)) : BASE_DATA;
const PUBLIC = path.join(FRONTEND, "public");
const ASSETS = path.join(PUBLIC, "docs-assets");
const MANIFEST = path.join(FRONTEND, "content/docs/media.json");
const VIDEOS_JSON = path.join(FRONTEND, "content/docs/videos.json");
const FFMPEG = process.env.FFMPEG || (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg");
const FFPROBE = process.env.FFPROBE || (existsSync("/opt/homebrew/bin/ffprobe") ? "/opt/homebrew/bin/ffprobe" : "ffprobe");
const PY = process.env.DOCS_MEDIA_PYTHON || path.join(REPO, "backend/.venv/bin/python");

export const APP = process.env.DOCS_MEDIA_APP || `http://localhost:${PORTS.app}`;
export const API = process.env.DOCS_MEDIA_API || `http://127.0.0.1:${PORTS.api}`;
export const DOCS = process.env.DOCS_MEDIA_DOCS || `http://docs.localhost:${PORTS.app}`;
/** Workspace domains of the demo world; the capture browser resolves them to 127.0.0.1. */
export const TENANT_HOSTS = ["docs.acme.com", "help.acme.com", "docs.acme.test", "help.acme.test"];
export const tenant = (host, p = "/") => `http://${host}:${new URL(APP).port}${p}`;

const BUDGET = { screenshot: 180 * 1024, clip: 1.5 * 1024 * 1024, video: 12 * 1024 * 1024 };
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "docs.localhost", ...TENANT_HOSTS]);
// Public CDNs the artifact viewers load their renderers from (PDF.js, SheetJS, …) and fonts.
const CDN = /(^|\.)(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/;

// ── CLI ───────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const onlyTheme = opt("--theme");
const ids = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--theme");

if (flag("--list")) {
  for (const s of SHOTS) console.log(`${s.id.padEnd(28)} ${s.kind.padEnd(10)} ${s.page}`);
  process.exit(0);
}

// ── Stack + fixtures ──────────────────────────────────────────────────────────

function fixtures() {
  const file = path.join(DATA, "fixtures.json");
  if (!existsSync(file)) throw new Error(`no ${file}: run seed.py first (see stack/stack.sh)`);
  return JSON.parse(readFileSync(file, "utf8"));
}

async function ensureStack() {
  for (const [name, url] of [["API", `${API}/__sandbox/health`], ["app", `${APP}/`]]) {
    const host = new URL(url).hostname;
    if (!["localhost", "127.0.0.1"].includes(host)) throw new Error(`${name} must be local: ${url}`);
    const ok = await fetch(url).then((r) => r.ok).catch(() => false);
    if (!ok) throw new Error(`${name} is not answering at ${url} — run frontend/scripts/docs-media/stack/stack.sh start`);
  }
  // Keep the seeded world's clock near the real one, so server-side windows (analytics' "last
  // 30 days") and the browser's frozen clock agree: shift every timestamp if it drifted.
  const fx = fixtures();
  const drift = Math.abs(Date.now() - Date.parse(fx.demo_now));
  if (drift > 20 * 60 * 1000) {
    console.log(`· demo clock is ${Math.round(drift / 60000)} min old — rebasing the seeded data`);
    const r = spawnSync(PY, [path.join(HERE, "seed.py"), "--rebase"], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("seed.py --rebase failed");
  }
  return fixtures();
}

async function sandbox(p, body = {}) {
  const res = await fetch(`${API}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`sandbox ${p} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function tokenFor(who, fx) {
  if (!who || who === "anon") return null;
  const user = fx.users[who === "owner" ? "riya" : who];
  if (!user) throw new Error(`unknown auth "${who}"`);
  return (await sandbox("/__sandbox/mint", { email: user.email })).token;
}

// ── In-page helpers (init script) ─────────────────────────────────────────────

/**
 * Runs in every document of a capture context:
 *  - the session token and theme in localStorage (before the app's own scripts read them);
 *  - CSS that hides dev-only chrome (Next's dev indicator) and the text caret;
 *  - URL scrubbing: the sandbox's local addresses read as the production ones in text, so a
 *    screenshot says markdrop.in/… and docs.acme.com/…, never localhost:<port>;
 *  - a fake cursor + click ripple + caption layer for clips and videos (driven by the runner).
 */
function initScript({ token, theme, cursor, scrub, ports }) {
  try {
    if (token) localStorage.setItem("markdrop_token", token);
    else localStorage.removeItem("markdrop_token");
    localStorage.setItem("md_theme", theme);
    localStorage.setItem("md_consent", "denied"); // no consent banner in shots (and no third-party analytics)
  } catch {}
  const css = `nextjs-portal, [data-nextjs-toast], #__next-build-watcher { display: none !important; }
    * { caret-color: transparent !important; }
    #__mdcap-cursor { position: fixed; left: 0; top: 0; width: 26px; height: 26px; z-index: 2147483647; pointer-events: none;
      transform: translate(-100px, -100px); transition: opacity .2s; will-change: transform; }
    #__mdcap-cursor svg { filter: drop-shadow(0 1px 2px rgba(0,0,0,.35)); }
    .__mdcap-ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 44px; height: 44px; margin: -22px 0 0 -22px;
      border-radius: 50%; background: rgba(37, 99, 235, .28); border: 2px solid rgba(37, 99, 235, .55);
      animation: __mdcap-r .55s ease-out forwards; }
    @keyframes __mdcap-r { from { transform: scale(.3); opacity: 1 } to { transform: scale(1.35); opacity: 0 } }
    #__mdcap-caption { position: fixed; left: 50%; bottom: 36px; transform: translateX(-50%); z-index: 2147483645; pointer-events: none;
      font: 600 22px/1.3 Manrope, -apple-system, system-ui, sans-serif; color: #fff; background: rgba(17, 24, 39, .86);
      padding: 12px 22px; border-radius: 12px; opacity: 0; transition: opacity .35s; max-width: 80vw; text-align: center; letter-spacing: -.01em; }
    #__mdcap-caption.on { opacity: 1; }`;
  const add = () => {
    if (document.getElementById("__mdcap-style")) return;
    const st = document.createElement("style");
    st.id = "__mdcap-style";
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
    if (cursor && window.top === window) {
      const c = document.createElement("div");
      c.id = "__mdcap-cursor";
      c.innerHTML = `<svg width="26" height="26" viewBox="0 0 26 26"><path d="M4 2.5 L4 21 L9.2 16.4 L12.6 24 L16 22.5 L12.7 15 L19.5 15 Z" fill="#fff" stroke="#111827" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
      document.documentElement.appendChild(c);
      const cap = document.createElement("div");
      cap.id = "__mdcap-caption";
      document.documentElement.appendChild(cap);
      const last = window.__mdcapPos;
      if (last) c.style.transform = `translate(${last[0]}px, ${last[1]}px)`;
    }
  };
  window.__mdcap = {
    move(x, y) {
      window.__mdcapPos = [x, y];
      const c = document.getElementById("__mdcap-cursor");
      if (c) c.style.transform = `translate(${x - 4}px, ${y - 2}px)`;
    },
    ripple(x, y) {
      const r = document.createElement("div");
      r.className = "__mdcap-ripple";
      r.style.left = `${x}px`;
      r.style.top = `${y}px`;
      document.documentElement.appendChild(r);
      setTimeout(() => r.remove(), 700);
    },
    caption(text) {
      const el = document.getElementById("__mdcap-caption");
      if (!el) return;
      if (text) {
        el.textContent = text;
        el.classList.add("on");
      } else el.classList.remove("on");
    },
    hideCursor(hide) {
      const c = document.getElementById("__mdcap-cursor");
      if (c) c.style.opacity = hide ? "0" : "1";
    },
  };
  if (scrub) {
    // Ports of this stack instance (STACK_ID): app, API, Worker.
    const [P, A, W] = [ports.app, ports.api, ports.worker];
    const rules = [
      [new RegExp(`https?://localhost:${P}`, "g"), "https://markdrop.in"],
      [new RegExp(`https?://127\\.0\\.0\\.1:${P}`, "g"), "https://markdrop.in"],
      [new RegExp(`localhost:${P}`, "g"), "markdrop.in"],
      [new RegExp(`https?://docs\\.localhost:${P}`, "g"), "https://docs.markdrop.in"],
      [new RegExp(`http://((?:docs|help)\\.acme\\.(?:com|test)):${P}`, "g"), "https://$1"],
      [new RegExp(`((?:docs|help)\\.acme\\.(?:com|test)):${P}`, "g"), "$1"],
      [new RegExp(`https?://127\\.0\\.0\\.1:${A}`, "g"), "https://api.markdrop.in"],
      [new RegExp(`https?://127\\.0\\.0\\.1:${W}`, "g"), "https://markdrop-artifacts.markdrop-in.workers.dev"],
    ];
    const LOCAL = new RegExp(`localhost:${P}|127\\.0\\.0\\.1:(${P}|${A}|${W})|acme\\.(com|test):${P}`);
    const LOCAL_INPUT = new RegExp(`localhost:${P}|acme\\.(com|test):${P}`);
    const fix = (s) => {
      let out = s;
      for (const [re, to] of rules) out = out.replace(re, to);
      return out;
    };
    const walk = (root) => {
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = tw.nextNode())) {
        if (n.nodeValue && LOCAL.test(n.nodeValue)) n.nodeValue = fix(n.nodeValue);
      }
      for (const el of root.querySelectorAll ? root.querySelectorAll("input[readonly], textarea[readonly]") : []) {
        if (LOCAL_INPUT.test(el.value)) el.value = fix(el.value);
      }
    };
    const start = () => {
      walk(document.body || document.documentElement);
      new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === "characterData" && m.target.nodeValue && LOCAL.test(m.target.nodeValue)) {
            m.target.nodeValue = fix(m.target.nodeValue);
          }
          for (const node of m.addedNodes || []) {
            if (node.nodeType === 3) {
              if (LOCAL.test(node.nodeValue)) node.nodeValue = fix(node.nodeValue);
            } else if (node.nodeType === 1) walk(node);
          }
        }
      }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add);
  else add();
}

// ── Shot helpers (the `h` passed to prepare/steps) ────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function loc(page, spec) {
  if (!spec) throw new Error("no locator");
  if (typeof spec === "string") return page.locator(spec).first();
  if (typeof spec.locator === "function" || spec.constructor?.name === "Locator") return spec;
  if (spec.role) return page.getByRole(spec.role, { name: spec.name, exact: spec.exact }).nth(spec.nth ?? 0);
  if (spec.text) return page.getByText(spec.text, { exact: spec.exact }).nth(spec.nth ?? 0);
  if (spec.label) return page.getByLabel(spec.label, { exact: spec.exact }).nth(spec.nth ?? 0);
  if (spec.placeholder) return page.getByPlaceholder(spec.placeholder).nth(spec.nth ?? 0);
  if (spec.css) return page.locator(spec.css).nth(spec.nth ?? 0);
  throw new Error(`bad locator ${JSON.stringify(spec)}`);
}

function helpers(page, ctx, shot, fx, rec) {
  let pos = [shot.viewport.width * 0.62, shot.viewport.height * 0.55];
  const cues = [];
  const dbg = process.env.DOCS_MEDIA_DEBUG ? (m) => console.log(`    [${rec ? rec.elapsed().toFixed(2) : "-"}] ${m}`) : () => {};
  const h = {
    debug: dbg,
    page,
    context: ctx,
    fx,
    shot,
    APP,
    API,
    DOCS,
    tenant,
    sandbox,
    loc: (spec) => loc(page, spec),
    sleep,
    async goto(url, opts = {}) {
      const full = url.startsWith("http") ? url : `${APP}${url}`;
      await page.goto(full, { waitUntil: "domcontentloaded", timeout: 180_000, ...opts });
      await h.settle(opts.settle ?? 600);
      await page.evaluate(([x, y]) => window.__mdcap?.move(x, y), pos).catch(() => {});
    },
    /** Network quiet, fonts loaded, then a beat. */
    async settle(ms = 400) {
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
      await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
      await sleep(ms);
    },
    async move(target, { duration = 650 } = {}) {
      let x, y;
      if (Array.isArray(target)) [x, y] = target;
      else {
        const l = loc(page, target);
        await l.scrollIntoViewIfNeeded().catch(() => {});
        const b = await l.boundingBox();
        if (!b) throw new Error(`no box for ${JSON.stringify(target)}`);
        [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
      }
      const [x0, y0] = pos;
      // Time-based, so the motion lasts `duration` however slow each round trip is.
      const dist = Math.hypot(x - x0, y - y0);
      const total = rec ? Math.min(duration, 250 + dist * 0.9) : 0;
      const t0 = Date.now();
      for (;;) {
        const f = total ? Math.min(1, (Date.now() - t0) / total) : 1;
        const t = ease(f);
        const px = x0 + (x - x0) * t, py = y0 + (y - y0) * t;
        await page.mouse.move(px, py);
        if (rec) await page.evaluate(([a, b]) => window.__mdcap?.move(a, b), [px, py]).catch(() => {});
        if (f >= 1) break;
      }
      pos = [x, y];
      return [x, y];
    },
    async click(target, opts = {}) {
      dbg(`click ${JSON.stringify(target)}`);
      const [x, y] = await h.move(target, opts);
      if (rec) {
        await sleep(opts.hover ?? 180);
        await page.evaluate(([a, b]) => window.__mdcap?.ripple(a, b), [x, y]).catch(() => {});
      }
      await page.mouse.down();
      await sleep(rec ? 70 : 10);
      await page.mouse.up();
      await sleep(opts.after ?? (rec ? 450 : 150));
    },
    async hover(target, ms = 600) {
      await h.move(target);
      await sleep(ms);
    },
    /** Human-paced typing: 35–110 ms per key, longer after spaces and punctuation. */
    async type(target, text, { clear = false, speed = 1 } = {}) {
      if (target) await h.click(target);
      dbg(`type ${text.slice(0, 30)}`);
      if (clear) {
        await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
        await page.keyboard.press("Backspace");
      }
      for (const ch of text) {
        await page.keyboard.type(ch);
        if (rec) await sleep((35 + Math.random() * 75) * (/[\s.,:;!?]/.test(ch) ? 1.8 : 1) / speed);
      }
    },
    /** A paste: the whole text arrives at once, as from the clipboard. */
    async paste(target, text) {
      if (target) await h.click(target);
      dbg("paste");
      await page.keyboard.insertText(text);
    },
    async press(key, after = 300) {
      await page.keyboard.press(key);
      await sleep(rec ? after : 100);
    },
    async scrollTo(target, { block = "center" } = {}) {
      await loc(page, target).evaluate((el, b) => el.scrollIntoView({ block: b, behavior: "instant" }), block);
      await sleep(rec ? 500 : 200);
    },
    async wheel(dy, steps = 12) {
      for (let i = 0; i < steps; i++) {
        await page.mouse.wheel(0, dy / steps);
        await sleep(rec ? 28 : 0);
      }
      await sleep(rec ? 350 : 100);
    },
    /** On-screen caption (videos); also becomes a WebVTT cue / chapter. Empty text hides it. */
    async caption(text, hold = 0) {
      const t = rec ? rec.elapsed() : 0;
      if (cues.length && cues[cues.length - 1].end == null) cues[cues.length - 1].end = t;
      if (text) cues.push({ start: t, end: null, text });
      await page.evaluate((s) => window.__mdcap?.caption(s), text || "").catch(() => {});
      if (hold) await sleep(hold);
    },
    cues,
    async hideCursor(hide = true) {
      await page.evaluate((v) => window.__mdcap?.hideCursor(v), hide).catch(() => {});
    },
  };
  return h;
}

// ── Screencast (clips/videos): CDP frames at device resolution → ffmpeg ──────

async function startScreencast(page, dir, size) {
  mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  const t0 = Date.now();
  let n = 0;
  cdp.on("Page.screencastFrame", async (f) => {
    const file = path.join(dir, `f${String(++n).padStart(5, "0")}.jpg`);
    writeFileSync(file, Buffer.from(f.data, "base64"));
    // Arrival time (wall clock), the same clock as `end` below; metadata.timestamp is on another base.
    frames.push({ file, t: Date.now() });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 });
  const wall0 = Date.now();
  return {
    elapsed: () => (Date.now() - wall0) / 1000,
    async stop() {
      // Chrome only sends frames when something changes; hold the last one to the real end.
      const end = Date.now();
      await cdp.send("Page.stopScreencast").catch(() => {});
      await sleep(150);
      await cdp.detach().catch(() => {});
      void t0;
      return { frames, start: frames[0]?.t ?? wall0, end };
    },
  };
}

function framesToVideo({ frames, end }, out, { fps = 30, trimStart = 0, trimEnd = 0, width }) {
  if (!frames.length) throw new Error("no frames recorded");
  const list = [];
  const t0 = frames[0].t;
  for (let i = 0; i < frames.length; i++) {
    const next = i + 1 < frames.length ? frames[i + 1].t : end;
    const dur = Math.max(0.001, (next - frames[i].t) / 1000); // real gaps; fps= below resamples
    list.push(`file '${frames[i].file}'`, `duration ${dur.toFixed(4)}`);
  }
  list.push(`file '${frames[frames.length - 1].file}'`);
  const listFile = `${out}.ffconcat`;
  writeFileSync(listFile, `ffconcat version 1.0\n${list.join("\n")}\n`);
  const total = (end - t0) / 1000;
  const vf = [`fps=${fps}`, width ? `scale=${width}:-2:flags=lanczos` : null, "format=yuv420p"].filter(Boolean).join(",");
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile];
  if (trimStart) args.push("-ss", String(trimStart));
  if (trimEnd) args.push("-t", String(Math.max(1, total - trimStart - trimEnd)));
  // Intermediate: near-lossless, so the final encodes can be tuned without re-recording.
  args.push("-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "10", "-pix_fmt", "yuv420p", out);
  execFileSync(FFMPEG, args, { stdio: "inherit" });
  rmSync(listFile, { force: true });
}

function probe(file) {
  const out = execFileSync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file]).toString();
  const j = JSON.parse(out);
  return { width: j.streams?.[0]?.width, height: j.streams?.[0]?.height, duration: Number(j.format?.duration || 0) };
}

function encodeMp4(src, out, { crf, width, maxBytes, tune = "animation" }) {
  for (let c = crf; c <= crf + 12; c += 3) {
    const vf = width ? ["-vf", `scale=${width}:-2:flags=lanczos`] : [];
    execFileSync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-i", src, ...vf, "-an", "-c:v", "libx264", "-preset", "slow",
      "-tune", tune, "-crf", String(c), "-pix_fmt", "yuv420p", "-profile:v", "high", "-movflags", "+faststart", out]);
    if (!maxBytes || statSync(out).size <= maxBytes) return c;
  }
  console.warn(`  ! ${path.relative(FRONTEND, out)} is ${(statSync(out).size / 1024).toFixed(0)} KB, over budget`);
  return null;
}

function encodeWebm(src, out, { crf, width, maxBytes }) {
  for (let c = crf; c <= crf + 15; c += 5) {
    const vf = width ? ["-vf", `scale=${width}:-2:flags=lanczos`] : [];
    execFileSync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-i", src, ...vf, "-an", "-c:v", "libvpx-vp9", "-b:v", "0",
      "-crf", String(c), "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", "-pix_fmt", "yuv420p", out]);
    if (!maxBytes || statSync(out).size <= maxBytes) return c;
  }
  console.warn(`  ! ${path.relative(FRONTEND, out)} is ${(statSync(out).size / 1024).toFixed(0)} KB, over budget`);
  return null;
}

function toWebp(src, out, { maxBytes, quality = 82, width, seek }) {
  for (let q = quality; q >= 50; q -= 6) {
    const args = ["-y", "-hide_banner", "-loglevel", "error"];
    if (seek != null) args.push("-ss", String(seek));
    args.push("-i", src, "-frames:v", "1");
    if (width) args.push("-vf", `scale=${width}:-2:flags=lanczos`);
    args.push("-c:v", "libwebp", "-quality", String(q), "-compression_level", "6", "-preset", "picture", out);
    execFileSync(FFMPEG, args);
    if (!maxBytes || statSync(out).size <= maxBytes) return q;
  }
  console.warn(`  ! ${path.relative(FRONTEND, out)} is ${(statSync(out).size / 1024).toFixed(0)} KB, over the ${maxBytes / 1024} KB budget`);
  return null;
}

function vtt(cues, total) {
  const ts = (s) => {
    const ms = Math.max(0, Math.round(s * 1000));
    const hh = String(Math.floor(ms / 3600000)).padStart(2, "0");
    const mm = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
    const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
    return `${hh}:${mm}:${ss}.${String(ms % 1000).padStart(3, "0")}`;
  };
  return `WEBVTT\n\n${cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end ?? total)}\n${c.text}`).join("\n\n")}\n`;
}

const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

// ── Crop ──────────────────────────────────────────────────────────────────────

/**
 * The capture rectangle in PAGE coordinates (the screenshot is taken with fullPage, so a crop may
 * be taller than the viewport). Element boxes come back relative to the viewport: add the scroll.
 */
async function cropBox(page, crop, viewport) {
  const [sx, sy] = await page.evaluate(() => [window.scrollX, window.scrollY]);
  if (!crop || crop === "viewport") return { x: sx, y: sy, width: viewport.width, height: viewport.height };
  const pad = crop.pad ?? 0;
  let box;
  if (crop.box) box = { ...crop.box, x: crop.box.x + sx, y: crop.box.y + sy };
  else {
    const specs = crop.union || [crop.selector ?? crop];
    const boxes = [];
    for (const s of specs) {
      const l = loc(page, s);
      await l.waitFor({ state: "visible", timeout: 30_000 });
      const b = await l.boundingBox();
      if (b) boxes.push(b);
    }
    if (!boxes.length) throw new Error(`crop target not found: ${JSON.stringify(crop)}`);
    const x1 = Math.min(...boxes.map((b) => b.x)), y1 = Math.min(...boxes.map((b) => b.y));
    const x2 = Math.max(...boxes.map((b) => b.x + b.width)), y2 = Math.max(...boxes.map((b) => b.y + b.height));
    box = { x: x1 + sx, y: y1 + sy, width: x2 - x1, height: y2 - y1 };
    if (crop.maxHeight) box.height = Math.min(box.height, crop.maxHeight);
  }
  const x = Math.max(0, Math.floor(box.x - pad)), y = Math.max(0, Math.floor(box.y - pad));
  const width = Math.min(viewport.width - (x - sx), Math.ceil(box.width + 2 * pad));
  const height = Math.ceil(box.height + 2 * pad);
  return { x, y, width, height };
}

// ── Manifest ──────────────────────────────────────────────────────────────────

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function record(manifest, file, kind, extra = {}) {
  const rel = `/${path.relative(PUBLIC, file).split(path.sep).join("/")}`;
  let dims = {};
  if (/\.(mp4|webm)$/.test(file)) {
    const p = probe(file);
    dims = { width: p.width, height: p.height, duration: Math.round(p.duration * 10) / 10 };
  } else if (/\.webp$/.test(file)) {
    const p = probe(file);
    dims = { width: p.width, height: p.height };
  }
  manifest[rel] = { kind, ...dims, bytes: statSync(file).size, ...extra };
  return rel;
}

// ── Run one shot ──────────────────────────────────────────────────────────────

const pageId = (p) => p.replace(/^\/+|\/+$/g, "") || "index";

async function runShot(browser, shot, theme, fx, manifest, videosJson) {
  const kind = shot.kind;
  const recording = kind === "clip" || kind === "video";
  const viewport = shot.viewport || (kind === "video" ? { width: 1440, height: 810 } : { width: 1440, height: 900 });
  const out = shot.out || { video: 1920, clip: 1440 }[kind];
  const dpr = shot.dpr || (kind === "screenshot" ? 2 : kind === "video" ? 1920 / viewport.width : Math.max(1, out / viewport.width));
  const token = await tokenFor(shot.auth || "anon", fx);
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: dpr,
    colorScheme: theme,
    locale: "en-US",
    timezoneId: shot.timezone || "UTC",
    reducedMotion: shot.reducedMotion || "no-preference",
    permissions: ["clipboard-read", "clipboard-write"],
    ...(shot.userAgent ? { userAgent: shot.userAgent } : {}),
  });
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    // Only http(s) can reach the network; chrome-extension:// (the PDF viewer), blob: and data: stay.
    if (!/^https?:$/.test(u.protocol) || LOCAL_HOSTS.has(u.hostname) || CDN.test(u.hostname)) return route.continue();
    return route.abort("blockedbyclient");
  });
  await context.clock.install({ time: new Date(fx.demo_now) });
  await context.addInitScript(initScript, { token, theme, cursor: recording, scrub: shot.scrub !== false, ports: PORTS });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`  · page error: ${String(e.message).slice(0, 160)}`));
  const shotDir = path.join(DATA, "raw", `${shot.id}-${theme}`);
  rmSync(shotDir, { recursive: true, force: true });
  mkdirSync(shotDir, { recursive: true });

  const written = [];
  let rec = null;
  try {
    await sandbox("/__sandbox/cleanup");
    const pre = helpers(page, context, { ...shot, viewport }, fx, null);
    if (shot.url) await pre.goto(typeof shot.url === "function" ? shot.url(fx) : shot.url);
    if (shot.prepare) await shot.prepare(pre);

    if (!recording) {
      if (shot.steps) await shot.steps(pre);
      await pre.settle(shot.settle ?? 500);
      // Crops are taken from a full-page capture; from the top, so sticky headers stay where they belong.
      if (!shot.keepScroll) await page.evaluate(() => window.scrollTo(0, 0));
      const clip = await cropBox(page, typeof shot.crop === "function" ? await shot.crop(pre) : shot.crop, viewport);
      const png = path.join(shotDir, "shot.png");
      await page.screenshot({ path: png, clip, fullPage: true, animations: "disabled", caret: "hide", scale: "device" });
      const dir = path.join(ASSETS, pageId(shot.page));
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${shot.name || shot.id}${theme === "dark" ? ".dark" : ""}.webp`);
      toWebp(png, file, { maxBytes: BUDGET.screenshot, quality: shot.quality || 82 });
      written.push(record(manifest, file, "screenshot", { theme, dpr }));
    } else {
      const size = { width: Math.round(viewport.width * dpr), height: Math.round(viewport.height * dpr) };
      rec = await startScreencast(page, path.join(shotDir, "frames"), size);
      const h = helpers(page, context, { ...shot, viewport }, fx, rec);
      await h.page.evaluate(([x, y]) => window.__mdcap?.move(x, y), [viewport.width * 0.62, viewport.height * 0.55]).catch(() => {});
      await sleep(400);
      await shot.steps(h);
      await sleep(shot.tail ?? 900);
      await h.caption("");
      const raw = await rec.stop();
      rec = null;
      const master = path.join(shotDir, "master.mp4");
      framesToVideo(raw, master, { fps: 30, trimStart: shot.trim?.start || 0.3, trimEnd: shot.trim?.end || 0, width: kind === "video" ? 1920 : out });
      const total = probe(master).duration;
      if (kind === "clip") {
        if (total > 12.5) console.warn(`  ! clip is ${total.toFixed(1)} s (clips should be 3–12 s)`);
        const dir = path.join(ASSETS, pageId(shot.page));
        mkdirSync(dir, { recursive: true });
        const base = path.join(dir, `${shot.name || shot.id}${theme === "dark" ? ".dark" : ""}`);
        encodeMp4(master, `${base}.mp4`, { crf: 26, maxBytes: BUDGET.clip });
        encodeWebm(master, `${base}.webm`, { crf: 40, maxBytes: BUDGET.clip });
        toWebp(master, `${base}.webp`, { seek: shot.poster ?? Math.max(0, total - 0.5), maxBytes: BUDGET.screenshot });
        written.push(record(manifest, `${base}.mp4`, "clip", { theme }), record(manifest, `${base}.webm`, "clip", { theme }),
          record(manifest, `${base}.webp`, "poster", { theme }));
      } else {
        const dir = path.join(ASSETS, "videos");
        mkdirSync(dir, { recursive: true });
        const base = path.join(dir, shot.name || shot.id);
        encodeMp4(master, `${base}.mp4`, { crf: 23, width: 1920, maxBytes: BUDGET.video, tune: "stillimage" });
        toWebp(master, `${base}.webp`, { seek: shot.poster ?? 2, width: 1920, maxBytes: 260 * 1024 });
        written.push(record(manifest, `${base}.mp4`, "video", { theme }), record(manifest, `${base}.webp`, "poster", { theme }));
        const entry = { src: `/docs-assets/videos/${path.basename(base)}.mp4`, poster: `/docs-assets/videos/${path.basename(base)}.webp`, duration: fmtDur(total) };
        if (h.cues.length) {
          writeFileSync(`${base}.vtt`, vtt(h.cues, total));
          written.push(record(manifest, `${base}.vtt`, "chapters"));
          entry.chapters = `/docs-assets/videos/${path.basename(base)}.vtt`;
        }
        videosJson[shot.videoId || shot.id] = entry;
      }
    }
  } finally {
    if (rec) await rec.stop().catch(() => {});
    // Put back whatever the shot changed in the seeded world (domains, …).
    if (shot.after) await shot.after(helpers(page, context, { ...shot, viewport }, fx, null)).catch((e) => console.warn(`  ! after(): ${e.message}`));
    await context.close();
    if (!flag("--keep-raw")) rmSync(shotDir, { recursive: true, force: true });
  }
  return written;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const fx = await ensureStack();
  const chosen = ids.length ? ids.map((id) => SHOTS.find((s) => s.id === id) || (() => { throw new Error(`unknown shot ${id} (try --list)`); })()) : SHOTS;
  const args = [`--host-resolver-rules=${TENANT_HOSTS.map((h) => `MAP ${h} 127.0.0.1`).join(", ")}`, "--hide-scrollbars", "--force-color-profile=srgb", "--font-render-hinting=none"];
  const browser = await chromium.launch({ channel: "chrome", headless: !flag("--headed"), args });
  // Some things only render in a headed browser (Chrome's built-in PDF viewer in a blob iframe,
  // used by the upload preview): shots with `headed: true` get a real window, parked off-screen.
  let headedBrowser = null;
  const browserFor = async (shot) => {
    if (!shot.headed || flag("--headed")) return browser;
    // Playwright's default --disable-extensions also disables Chrome's PDF viewer (a component extension).
    headedBrowser ||= await chromium.launch({
      channel: "chrome", headless: false, args: [...args, "--window-position=-3000,-3000"],
      ignoreDefaultArgs: ["--disable-extensions", "--disable-component-extensions-with-background-pages"],
    });
    return headedBrowser;
  };
  const manifest = {}; // this run's outputs, for the log (media.json itself is the engine's)
  const videosJson = {}; // this run's ::video entries, merged into videos.json at the end
  const failures = [];
  try {
    for (const shot of chosen) {
      const themes = (shot.themes || (shot.kind === "screenshot" ? ["light", "dark"] : ["light"])).filter((t) => !onlyTheme || t === onlyTheme);
      for (const theme of themes) {
        const t = Date.now();
        process.stdout.write(`▸ ${shot.id} [${shot.kind}, ${theme}] … `);
        try {
          const files = await runShot(await browserFor(shot), shot, theme, fx, manifest, videosJson);
          console.log(`${((Date.now() - t) / 1000).toFixed(1)} s`);
          for (const f of files) console.log(`    ${f}  ${(manifest[f].bytes / 1024).toFixed(0)} KB${manifest[f].width ? `  ${manifest[f].width}×${manifest[f].height}` : ""}${manifest[f].duration ? `  ${manifest[f].duration} s` : ""}`);
        } catch (e) {
          console.log("FAILED");
          console.error(`    ${e.stack || e}`);
          failures.push(`${shot.id} (${theme})`);
        }
      }
    }
  } finally {
    await browser.close();
    if (headedBrowser) await headedBrowser.close();
  }
  if (!flag("--no-manifest")) {
    if (Object.keys(videosJson).length) {
      // Re-read just before writing and merge only this run's entries: parallel runs (STACK_ID)
      // may have written theirs since this one started.
      const merged = { ...readJson(VIDEOS_JSON), ...videosJson };
      const sorted = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
      writeFileSync(VIDEOS_JSON, `${JSON.stringify(sorted, null, 2)}\n`);
    }
    // media.json belongs to the docs engine: regenerate it with the engine's own script.
    const gen = path.join(FRONTEND, "scripts/docs-media-manifest.mjs");
    if (existsSync(gen)) {
      const r = spawnSync(process.execPath, [gen], { cwd: FRONTEND, stdio: "inherit", env: { ...process.env, PATH: `${path.dirname(FFPROBE)}:${process.env.PATH}` } });
      if (r.status !== 0) console.warn("  ! docs-media-manifest.mjs failed");
    } else console.warn(`  ! ${path.relative(FRONTEND, gen)} not found: ${path.relative(FRONTEND, MANIFEST)} not refreshed`);
  }
  if (failures.length) {
    console.error(`\n${failures.length} failed: ${failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
