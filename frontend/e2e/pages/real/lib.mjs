/** Shared helpers for the page builder's real-stack Playwright runs (up.sh: API :8230, Worker :8837, next :3450;
 *  PB_STACK_ID=N moves them to 8180+10N / 8787+10N / 3400+10N and db markdrop_docs_demo_N, default 5). */
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
export const STACK_ID = Number(process.env.PB_STACK_ID || 5);
export const NEXT_PORT = 3400 + 10 * STACK_ID;
export const APP = `http://localhost:${NEXT_PORT}`;
export const TENANT = `http://acme.localhost:${NEXT_PORT}`;
export const API = `http://127.0.0.1:${8180 + 10 * STACK_ID}`;
export const WORKER = `http://127.0.0.1:${8787 + 10 * STACK_ID}`;
export const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const PY = path.join(ROOT, "backend", ".venv", "bin", "python");
const ENV = { ...process.env, STACK_ID: String(STACK_ID), DOCS_MEDIA_DATA: path.join(STACK, "data"), PB_STACK: STACK };

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
  const local = new RegExp(`^https://localhost:${NEXT_PORT}`);
  const tenant = new RegExp(`^https://acme\\.localhost(:${NEXT_PORT})?`);
  await c.route(new RegExp(`${local.source}/`), (r) => hop(r, local, APP));
  await c.route(new RegExp(`${tenant.source}/`), (r) => hop(r, tenant, TENANT));
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
  // Closing a WebKit context doesn't run the pages' pagehide (Chromium's does), so an editor closed
  // that way never lets go of its edit lock and holds the page for the next steps until the lock times
  // out. Leave the pages first, as a closed tab does.
  if (BROWSER === "webkit") {
    const close = c.close.bind(c);
    c.close = async (...a) => {
      const open = c.pages().filter((pg) => !pg.isClosed() && pg.url().startsWith("http"));
      for (const pg of open) await pg.goto("about:blank", { timeout: 5000 }).catch(() => {});
      if (open.length) await new Promise((r) => setTimeout(r, 300));
      return close(...a);
    };
  }
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

/**
 * The bars across the top of the screen: visible sticky or fixed elements within 120 px of the top,
 * 32 to 120 px tall and at least 60 % of the viewport wide, not counting one inside another (a bar's
 * own inner row). A screen with the app header and a document bar under it has two; one bar, one.
 */
export async function topBars(p) {
  return p.evaluate(() => {
    const vw = window.innerWidth;
    const hits = [];
    for (const el of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(el);
      if (cs.position !== "sticky" && cs.position !== "fixed") continue;
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.top < -1 || r.top > 120 || r.height < 32 || r.height > 120 || r.width < vw * 0.6) continue;
      hits.push(el);
    }
    const top = hits.filter((el) => !hits.some((o) => o !== el && o.contains(el)));
    return top.map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(/\s+/).slice(0, 3).join(".")}@${Math.round(el.getBoundingClientRect().top)}`);
  });
}

/** Upload a file as an artifact (upload-url → PUT the bytes → create) → the create response. */
export async function uploadFile(token, { bytes, filename, mime, title, slug, ...filing }) {
  const u = await api("POST", "/api/v1/artifacts/upload-url", token, { filename, content_type: mime, size_bytes: bytes.length });
  if (u.status !== 200 && u.status !== 201) fail(`upload-url ${filename} → ${u.status} ${JSON.stringify(u.body).slice(0, 200)}`);
  const put = await fetch(u.body.upload_url, { method: "PUT", body: bytes, headers: { "Content-Type": u.body.required_content_type } });
  if (!put.ok) fail(`PUT ${filename} → ${put.status}`);
  const r = await api("POST", "/api/v1/artifacts", token, { blob_key: u.body.blob_key, title, filename, ...(slug ? { custom_slug: slug } : {}), ...filing });
  if (r.status !== 200 && r.status !== 201) fail(`create ${filename} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
}

/**
 * The framed file view's layout: its bars (topBars), whether the app header (SiteHeader or
 * TenantHeader) is on the screen, and how far the file's frame starts below the lowest bar. One bar
 * with the frame right under it is the single-bar layout; the app header over a file bar is two.
 */
export async function fileLayout(p) {
  const bars = await topBars(p);
  const more = await p.evaluate(() => {
    const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const bar = [...document.querySelectorAll("header")].filter(vis).map((h) => h.getBoundingClientRect().bottom).sort((a, b) => b - a)[0] ?? 0;
    const frame = document.querySelector("main iframe, main .md-artframe");
    const box = frame?.closest(".md-artframe") || frame?.parentElement;
    return {
      headers: [...document.querySelectorAll("header")].filter(vis).map((h) => String(h.className).split(/\s+/).slice(0, 2).join(".")),
      frameTop: box ? Math.round(box.getBoundingClientRect().top) : null,
      barBottom: Math.round(bar),
    };
  });
  return { bars, ...more, gap: more.frameTop == null ? null : more.frameTop - more.barBottom };
}
