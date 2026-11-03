/**
 * Shared helpers for the page editor's round 2 runs against the real backend (stack.sh: API :8250,
 * Worker :8857, next dev :3470). Not a Playwright Test suite: plain scripts, run with node.
 *
 *   PB_SHOTS   where screenshots go (default: the OS temp dir)
 *   BROWSER    chromium (default) | webkit
 *   THEME      light (default) | dark
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pw = require("@playwright/test");

export const BROWSER = process.env.BROWSER === "webkit" ? "webkit" : "chromium";
export const THEME = process.env.THEME === "dark" ? "dark" : "light";
export const APP = process.env.PB_APP ?? "http://localhost:3470";
export const API = process.env.PB_API ?? "http://127.0.0.1:8250";
export const SHOTS = path.join(process.env.PB_SHOTS ?? path.join(os.tmpdir(), "pb-round2-shots"), BROWSER === "webkit" ? "webkit" : "");
fs.mkdirSync(SHOTS, { recursive: true });

export const fail = (m) => {
  throw new Error(m);
};

export async function launch() {
  return (BROWSER === "webkit" ? pw.webkit : pw.chromium).launch();
}

async function call(method, p, token, body) {
  const r = await fetch(`${API}${p}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (r.status >= 400) fail(`${method} ${p} → ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** A signed-in owner with a workspace and a folder (made once per process). */
let world = null;
export async function seed() {
  if (world) return world;
  const u = await call("POST", "/__sandbox/user", null, { email: "ada@round2.test", name: "Ada Owner" });
  const wss = await call("GET", "/api/v1/workspaces", u.token).catch(() => null);
  const list = Array.isArray(wss) ? wss : wss?.workspaces ?? wss?.items ?? [];
  let ws = list.find((w) => w.name === "Round 2");
  if (!ws) ws = await call("POST", "/api/v1/workspaces", u.token, { name: "Round 2" });
  let folder;
  try {
    folder = await call("POST", `/api/v1/workspaces/${ws.id}/folders`, u.token, { name: `Pages ${Date.now().toString(36)}` });
  } catch {
    folder = null;
  }
  world = { token: u.token, ws: ws.id, folder: folder?.id ?? null };
  return world;
}

export async function newPage(title, content) {
  const w = await seed();
  const r = await call("POST", "/api/v1/pages", w.token, { title, workspace: w.ws, ...(w.folder ? { folder: w.folder } : {}), ...(content !== undefined ? { content } : {}) });
  return r.document.slug;
}

/** The page's stored Markdown. */
export async function md(slug) {
  const w = await seed();
  return (await call("GET", `/api/v1/documents/${slug}`, w.token)).content;
}

export const pendingOf = new WeakMap();
/** The requests a page still has open, oldest first. */
export function pending(p) {
  const open = pendingOf.get(p);
  if (!open) return [];
  return [...open].sort((a, b) => a[1] - b[1]).map(([r, at]) => `${r.method()} ${r.url().slice(0, 140)} (${Date.now() - at} ms)`);
}

export async function context(browser, { width = 1280, height = 900, touch = false } = {}) {
  const w = await seed();
  const c = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: width < 500 ? 2 : 1, colorScheme: THEME, hasTouch: touch, isMobile: touch && BROWSER === "chromium" });
  if (BROWSER === "chromium") await c.grantPermissions(["clipboard-read", "clipboard-write"], { origin: APP }).catch(() => {});
  await c.addInitScript(([th, tok]) => {
    try {
      localStorage.setItem("markdrop_token", tok);
      localStorage.setItem("md_theme", th);
      localStorage.setItem("md_theme_beta", "1");
      localStorage.setItem("md_consent", "denied");
    } catch {}
  }, [THEME, w.token]);
  const p = await c.newPage();
  p.on("pageerror", (e) => console.log("  [pageerror]", e.message.slice(0, 300)));
  // Requests still open (printed when a step fails, to tell a hang from a bug).
  const open = new Map();
  p.on("request", (r) => open.set(r, Date.now()));
  p.on("requestfinished", (r) => open.delete(r));
  p.on("requestfailed", (r) => open.delete(r));
  p.on("response", (r) => {
    if (r.status() >= 400 && !/example\.com/.test(r.url())) console.log(`  [${r.status()}]`, r.request().method(), r.url().slice(0, 160));
  });
  p.on("console", (m) => m.type() === "error" && !/ERR_BLOCKED_BY_ORB|Failed to load resource/.test(m.text()) && console.log("  [console]", m.text().slice(0, 300)));
  pendingOf.set(p, open);
  return { c, p };
}

export async function shot(p, name, opts = {}) {
  await p.waitForTimeout(opts.wait ?? 400);
  await p.screenshot({ path: path.join(SHOTS, `r2-${name}-${THEME}.png`), fullPage: opts.full ?? false });
}

export async function edit(p, slug) {
  await p.goto(`${APP}/${slug}?edit=1`, { waitUntil: "networkidle" });
  await p.locator('.ProseMirror[contenteditable="true"]').waitFor({ timeout: 60000 });
  await p.waitForTimeout(800);
}

/** Waits for the autosave; returns the stored Markdown once it has every `want` and no `not`. */
export async function saved(p, slug, want = [], { not = [], timeout = 15000 } = {}) {
  const until = Date.now() + timeout;
  let m = "";
  const has = (w) => (w instanceof RegExp ? w.test(m) : m.includes(w));
  for (;;) {
    m = await md(slug);
    if (want.every(has) && !not.some(has)) return m;
    if (Date.now() > until) fail(`saved Markdown: missing ${want.filter((w) => !has(w)).join(" | ") || "-"}; still has ${not.filter(has).join(" | ") || "-"}\n---\n${m}`);
    await p.waitForTimeout(400);
  }
}
