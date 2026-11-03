/** Shared helpers for the page builder's real-stack Playwright runs (up.sh: API :8230, Worker :8837, next :3450). */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "@playwright/test";

export const here = path.dirname(fileURLToPath(import.meta.url));
// State and output live outside the repo: <main checkout>/.work/page-builder (or $PB_WORK).
const ROOT = path.resolve(here, "../../../..").split("/.claude/worktrees/")[0];
export const WORK = process.env.PB_WORK || path.join(ROOT, ".work", "page-builder");
export const STACK = path.join(WORK, "stack");
export const BROWSER = process.env.BROWSER === "webkit" ? "webkit" : "chromium";
export const SHOTS = path.join(WORK, "real-shots", process.env.SHOT_DIR || BROWSER);
fs.mkdirSync(SHOTS, { recursive: true });
export const APP = "http://localhost:3450";
export const TENANT = "http://acme.localhost:3450";
export const API = "http://127.0.0.1:8230";
export const WORKER = "http://127.0.0.1:8837";
export const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const PY = path.join(ROOT, "backend", ".venv", "bin", "python");
const ENV = { ...process.env, STACK_ID: "5", DOCS_MEDIA_DATA: path.join(STACK, "data"), PB_STACK: STACK };

export const log = (...a) => console.log("•", ...a);
export const fail = (m) => {
  throw new Error(m);
};

export function reseed() {
  execFileSync(PY, [path.join(here, "seed.py")], { stdio: "pipe", env: ENV });
  return JSON.parse(fs.readFileSync(path.join(STACK, "seed.json"), "utf8"));
}
export const seedNow = () => JSON.parse(fs.readFileSync(path.join(STACK, "seed.json"), "utf8"));

export function mcpToken(email, read = false) {
  return execFileSync(PY, [path.join(here, "mint_mcp.py"), email, ...(read ? ["read"] : [])], {
    env: ENV,
    encoding: "utf8",
  }).trim().split("\n").pop();
}

/** REST: api("GET", "/api/v1/documents/x", token) → {status, body}. */
export async function api(method, p, token, body, headers = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: r.status, body: json };
}

let rpcId = 0;
/** MCP tools/call over the hosted endpoint → {status, isError, text, data}. */
export async function mcp(token, name, args) {
  const r = await fetch(`${API}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  if (r.status !== 200) return { status: r.status, isError: true, text: await r.text() };
  const j = await r.json();
  const res = j.result ?? {};
  return { status: 200, isError: !!res.isError, text: res.content?.[0]?.text ?? JSON.stringify(j.error ?? j), data: res.structuredContent };
}

export async function docOf(slug, token) {
  const r = await api("GET", `/api/v1/documents/${slug}`, token);
  if (r.status !== 200) fail(`GET ${slug} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
}

export async function launch() {
  return BROWSER === "webkit" ? webkit.launch() : chromium.launch();
}

/** A context with a session token (or none), the theme, and the prod-https → local-http rewrites the handoff needs. */
export async function ctx(browser, { token = null, theme = "light", width = 1440, height = 900, video = null, mobile = false } = {}) {
  const c = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: width < 500 ? 2 : 1,
    colorScheme: theme,
    ...(mobile ? { hasTouch: true, isMobile: BROWSER !== "webkit" ? true : undefined } : {}),
    ...(video ? { recordVideo: { dir: video, size: { width, height } } } : {}),
  });
  // WebKit can't fulfill a route with a redirect: a page that replaces its location does the same
  // (and keeps the fragment, where the handoff carries its token).
  const hop = (r, from, to) =>
    BROWSER === "webkit"
      ? r.fulfill({ status: 200, contentType: "text/html", body: `<script>location.replace(location.href.replace(${from.toString()}, ${JSON.stringify(to)}))</script>` })
      : r.fulfill({ status: 302, headers: { location: r.request().url().replace(from, to) } });
  await c.route(/^https:\/\/localhost:3450\//, (r) => hop(r, /^https:\/\/localhost:3450/, APP));
  await c.route(/^https:\/\/acme\.localhost(:3450)?\//, (r) => hop(r, /^https:\/\/acme\.localhost(:3450)?/, TENANT));
  await c.addInitScript(
    ([t, th]) => {
      try {
        if (location.hostname === "localhost") {
          if (t) localStorage.setItem("markdrop_token", t);
        }
        localStorage.setItem("md_theme", th);
        localStorage.setItem("md_theme_beta", "1");
        localStorage.setItem("md_consent", "denied");
      } catch {}
    },
    [token, theme],
  );
  const p = await c.newPage();
  p.on("pageerror", (e) => console.log("  [pageerror]", e.message.slice(0, 300)));
  return { c, p };
}

/** Record every API response body (text) a page receives, to check for leaks. */
export function captureApi(p) {
  const bodies = [];
  p.on("response", async (r) => {
    const u = r.url();
    if (!u.startsWith(API)) return;
    try {
      bodies.push({ url: u, status: r.status(), body: await r.text() });
    } catch {}
  });
  return bodies;
}

export async function shot(p, name, opts = {}) {
  if (opts.full) {
    for (let y = 0; y < 9000; y += 600) {
      await p.mouse.wheel(0, 600);
      await p.waitForTimeout(150);
    }
    await p.evaluate(() => window.scrollTo(0, 0));
  }
  await p.waitForTimeout(opts.wait ?? 500);
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: opts.full ?? false });
  log("shot", name);
}

export function stepper(browser) {
  const results = [];
  async function step(name, fn) {
    if (ONLY && !ONLY.has(name)) return;
    const t0 = Date.now();
    try {
      await fn();
      results.push([name, "ok", Date.now() - t0]);
      log(`✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (e) {
      results.push([name, `FAIL ${e.message.split("\n")[0].slice(0, 300)}`, Date.now() - t0]);
      for (const cx of browser.contexts()) for (const pg of cx.pages()) await pg.screenshot({ path: path.join(SHOTS, `fail-${name}.png`) }).catch(() => {});
      console.error(`✗ ${name}:`, e.message.slice(0, 2000));
    }
    for (const cx of browser.contexts()) await cx.close().catch(() => {});
  }
  return { step, results };
}

/** A PNG made by the browser (a coloured box with a label). */
export async function pngBytes(browser, label = "Pasted screenshot", colors = ["#f97316", "#db2777"]) {
  const tmp = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await tmp.setContent(`<style>body{margin:0}</style><div style="width:640px;height:360px;display:grid;place-items:center;background:linear-gradient(135deg,${colors[0]},${colors[1]});font:700 40px system-ui;color:#fff">${label}</div>`);
  const buf = await tmp.screenshot();
  await tmp.close();
  return [...buf];
}

/** The editor's save state: "saved", "saving", "offline" or "error" (the top bar's indicator). */
export const saveState = (p) => p.locator(".pb-save").first().getAttribute("data-state").catch(() => null);

export async function waitSaved(p, timeout = 20000) {
  await p.waitForTimeout(2600);
  await p.locator('.pb-save[data-state="saved"]').first().waitFor({ state: "attached", timeout });
}
