#!/usr/bin/env node
/**
 * Real Markdrop pages for the scene videos, captured from the local demo stack (STACK_ID, default 0)
 * and saved as images the scenes put inside their browser frames, plus the two /vscode/ stills
 * that are real pages.
 *
 *   node frontend/scripts/docs-media/scenes/stills.mjs [demo] [consent] [meeting] [release] [authorize]
 *
 *   demo       markdrop upload demo.mp4 → /demo (v1), markdrop replace → /demo (v2)   [_shots/demo-*.webp]
 *   consent    an OAuth client "Claude" asks for both scopes → /oauth/consent, then Approve
 *   meeting    the document an assistant publishes with publish_document (real API call)
 *   release    release-notes.md published the way the VS Code extension does (POST /api/v1/sync),
 *              then edited in the real web editor                              [_shots/release-*.webp]
 *   authorize  /extension/authorize (Connect VS Code), light + dark, 2× → public/docs-assets/vscode/sync/
 *
 * Runs against the sandbox API and the local Next app only (stack/stack.sh start); never production.
 * The sandbox's local addresses are rewritten in page text to the production ones (markdrop.in …).
 * Writes `_shots/facts.json` with what the scenes need to show (slugs, URLs, revisions).
 */
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, "../../..");
const SHOTS = path.join(FRONTEND, "content/docs/video-scenes/_shots");
const ASSETS = path.join(FRONTEND, "public/docs-assets");
const STACK_ID = Number(process.env.STACK_ID || 0);
const P = { app: 3400 + 10 * STACK_ID, api: 8180 + 10 * STACK_ID, worker: 8787 + 10 * STACK_ID };
const APP = `http://localhost:${P.app}`;
const API = `http://127.0.0.1:${P.api}`;
const DATA = path.join(HERE, "..", ".data", STACK_ID ? String(STACK_ID) : "");
const CLI = process.env.MARKDROP_CLI || "/tmp/markdrop-cli";
const FFMPEG = existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg";
const MOVIES = path.join(os.tmpdir(), "markdrop-scenes-cli", "Movies");

const which = process.argv.slice(2);
const want = (k) => !which.length || which.includes(k);
mkdirSync(SHOTS, { recursive: true });
const factsFile = path.join(SHOTS, "facts.json");
const facts = existsSync(factsFile) ? JSON.parse(readFileSync(factsFile, "utf8")) : {};

const fx = JSON.parse(readFileSync(path.join(DATA, "fixtures.json"), "utf8"));
async function sandbox(p, body = {}) {
  const r = await fetch(`${API}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${p} → ${r.status} ${await r.text()}`);
  return r.json();
}
const token = async () => (await sandbox("/__sandbox/mint", { email: fx.users.riya.email })).token;
async function api(method, p, tok, body) {
  const r = await fetch(`${API}${p}`, { method, headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch {}
  return { status: r.status, json: j, text };
}

function init({ tok, theme }) {
  return `(() => {
    try { ${tok ? `localStorage.setItem("markdrop_token", ${JSON.stringify(tok)});` : 'localStorage.removeItem("markdrop_token");'}
      localStorage.setItem("md_theme", ${JSON.stringify(theme)}); localStorage.setItem("md_consent", "denied"); } catch {}
    const rules = [[/https?:\\/\\/(?:localhost|127\\.0\\.0\\.1):${P.app}/g, "https://markdrop.in"], [/(?:localhost|127\\.0\\.0\\.1):${P.app}/g, "markdrop.in"],
      [/https?:\\/\\/127\\.0\\.0\\.1:${P.api}/g, "https://api.markdrop.in"], [/127\\.0\\.0\\.1:${P.api}/g, "api.markdrop.in"]];
    const LOCAL = /localhost:${P.app}|127\\.0\\.0\\.1:(${P.app}|${P.api}|${P.worker})/;
    const fix = (s) => rules.reduce((a, [re, to]) => a.replace(re, to), s);
    const walk = (root) => { const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n; while ((n = tw.nextNode())) if (LOCAL.test(n.nodeValue)) n.nodeValue = fix(n.nodeValue); };
    const css = "nextjs-portal,[data-nextjs-toast],#__next-build-watcher{display:none!important}*{caret-color:transparent!important}";
    const start = () => { const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st); walk(document.body);
      new MutationObserver((ms) => { for (const m of ms) { if (m.type === "characterData" && LOCAL.test(m.target.nodeValue)) m.target.nodeValue = fix(m.target.nodeValue);
        for (const n of m.addedNodes || []) { if (n.nodeType === 3) { if (LOCAL.test(n.nodeValue)) n.nodeValue = fix(n.nodeValue); } else if (n.nodeType === 1) walk(n); } } })
        .observe(document.documentElement, { subtree: true, childList: true, characterData: true }); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  })();`;
}

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--hide-scrollbars", "--force-color-profile=srgb", "--font-render-hinting=none"] });
async function ctx({ tok = null, theme = "light", w = 1280, h = 800, dpr = 1 } = {}) {
  const c = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, locale: "en-US", timezoneId: "UTC", colorScheme: theme });
  // Nothing beyond the local stack (the viewers' CDNs are allowed for the artifact pages).
  await c.route(/^https?:\/\/(?!localhost|127\.0\.0\.1|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|fonts\.(googleapis|gstatic)\.com)/, (r) => r.abort());
  await c.addInitScript(init({ tok, theme }));
  return c;
}
const settle = async (page, ms = 800) => {
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await page.waitForTimeout(ms);
};
function webp(png, out, { q = 86, maxBytes = Infinity } = {}) {
  for (let qq = q; qq >= 50; qq -= 6) {
    execFileSync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-i", png, "-c:v", "libwebp", "-quality", String(qq), "-compression_level", "6", out]);
    if (statSync(out).size <= maxBytes) break;
  }
  console.log(`  ${path.relative(FRONTEND, out)}  ${(statSync(out).size / 1024).toFixed(0)} KB`);
}
async function shot(page, name, opts = {}) {
  const png = path.join(os.tmpdir(), `${name}.png`);
  await page.screenshot({ path: png, animations: "disabled", caret: "hide", ...opts });
  const out = path.join(SHOTS, `${name}.webp`);
  webp(png, out, { q: 84 });
  rmSync(png, { force: true });
  return out;
}
/** The immersive viewer hides the bar; the docs videos show it the way readers first see it. */
async function openDoc(page, slug) {
  await page.goto(`${APP}/${slug}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await settle(page, 1500);
}

// ── demo: /demo after upload (v1) and after replace (v2) ────────────────────
async function demo() {
  console.log("▸ demo");
  const tok = await token();
  await sandbox("/__sandbox/cleanup");
  const env = { ...process.env, MARKDROP_TOKEN: tok, HOME: path.join(os.tmpdir(), "markdrop-scenes-cli", "home") };
  const run = (...a) => execFileSync(CLI, [...a, "--server", API], { cwd: MOVIES, env, stdio: ["ignore", "pipe", "pipe"] }).toString();
  run("upload", "demo.mp4");
  for (const v of ["v1", "v2"]) {
    if (v === "v2") run("replace", "demo", "demo-v2.mp4");
    const c = await ctx({ tok: null, w: 1280, h: 760 });
    const page = await c.newPage();
    await openDoc(page, "demo");
    // The player lives in the artifact frame (another origin): seek it to the end card, where v1 and v2 differ.
    let video = null;
    for (let i = 0; i < 40 && !video; i++) {
      for (const f of page.frames()) {
        if (await f.$("video").catch(() => null)) { video = f; break; }
      }
      if (!video) await page.waitForTimeout(500);
    }
    if (!video) throw new Error("no <video> on /demo");
    // The page around the player, with the player's picture taken out: the scene plays the real
    // video frames in that box (so the video moves). Playing and idle, so the controls fade out.
    await video.evaluate(async () => {
      const v = document.querySelector("video");
      v.muted = true;
      if (v.readyState < 1) await new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true }));
      v.currentTime = 30;
      await v.play();
    });
    await page.waitForTimeout(5000);
    const vb = await (await video.$("video")).boundingBox();
    const dims = await video.evaluate(() => { const v = document.querySelector("video"); return [v.videoWidth, v.videoHeight]; });
    // object-fit: contain → the picture's own box inside the element.
    const k = Math.min(vb.width / dims[0], vb.height / dims[1]);
    const rect = { x: vb.x + (vb.width - dims[0] * k) / 2, y: vb.y + (vb.height - dims[1] * k) / 2, w: dims[0] * k, h: dims[1] * k };
    await video.evaluate(() => { document.querySelector("video").style.opacity = "0"; });
    await page.waitForTimeout(300);
    await shot(page, `demo-${v}-page`);
    facts.demo = { ...(facts.demo || {}), rect, viewport: { w: 1280, h: 760 } };
    // The seconds the scene plays (0:32–0:40, the end card differs between v1 and v2).
    execFileSync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-ss", "32", "-i", path.join(DATA, "fixtures", `product-demo-${v}.mp4`), "-t", "8",
      "-vf", "scale=960:-2:flags=lanczos", "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-g", "6", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      path.join(SHOTS, `demo-${v}.mp4`)]);
    console.log(`  content/docs/video-scenes/_shots/demo-${v}.mp4  ${(statSync(path.join(SHOTS, `demo-${v}.mp4`)).size / 1024).toFixed(0)} KB`);
    await c.close();
  }
  facts.demo = { ...facts.demo, url: "https://markdrop.in/demo" };
}

// ── consent: Claude asks for both scopes ────────────────────────────────
async function consent() {
  console.log("▸ consent");
  const tok = await token();
  const reg = await api("POST", "/oauth/register", null, {
    client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
  });
  if (reg.status >= 300) throw new Error(`register → ${reg.status} ${reg.text}`);
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({
    response_type: "code", client_id: reg.json.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: challenge,
    code_challenge_method: "S256", scope: "documents:read documents:write", state: "docs", resource: `${API}/mcp`,
  });
  const r = await fetch(`${API}/oauth/authorize?${q}`, { redirect: "manual" });
  const loc = r.headers.get("location");
  if (!loc || !loc.includes("/oauth/consent")) throw new Error(`authorize → ${r.status} ${loc} ${await r.text()}`);
  const c = await ctx({ tok, w: 1280, h: 900 });
  // Approve sends the browser back to the app: stop that navigation (nothing leaves the machine), keep the page.
  await c.route("https://claude.ai/**", (rt) => rt.abort("aborted"));
  const page = await c.newPage();
  await page.goto(loc.replace(/^https?:\/\/[^/]+/, APP), { waitUntil: "domcontentloaded" });
  await settle(page, 1500);
  await shot(page, "consent");
  const btn = page.getByRole("button", { name: "Approve" });
  const box = await btn.boundingBox();
  facts.consent = { approve: box && { x: box.x + box.width / 2, y: box.y + box.height / 2 }, url: "markdrop.in" + new URL(loc).pathname + new URL(loc).search.replace(/request=[^&]+/, "request=…") };
  await btn.click();
  await page.waitForTimeout(3500);
  await shot(page, "consent-approved");
  await c.close();
}

// ── meeting: what publish_document makes of the notes ───────────────────────
const NOTES = `# Launch sync — Oct 30

**Attendees:** Riya, Alex, Sam, Maya

## Decisions
- Workflows beta ships **Nov 12** to the 40 waitlist teams.
- Pricing page goes live with the beta; the FAQ moves to the docs.
- Support rota covers launch week (Sam leads, Alex backs up).

## Action items
| Owner | Task | Due |
| --- | --- | --- |
| Alex | Finish onboarding emails | Nov 4 |
| Sam | Record the 60-second demo | Nov 6 |
| Maya | Final pricing review with finance | Nov 7 |
| Riya | Send the beta invite list | Nov 10 |

## Risks
- SSO setup for two enterprise pilots could slip past Nov 12.
- The import tool still times out on files over 50 MB.
`;
async function meeting() {
  console.log("▸ meeting");
  const tok = await token();
  const r = await api("POST", "/api/v1/documents", tok, { title: "Launch sync — Oct 30", content: NOTES });
  if (r.status !== 201) throw new Error(`create → ${r.status} ${r.text}`);
  const slug = r.json.slug;
  facts.meeting = { slug, url: `https://markdrop.in/${slug}`, title: "Launch sync — Oct 30", markdown: NOTES };
  const c = await ctx({ tok: null, w: 1280, h: 800 });
  const page = await c.newPage();
  await openDoc(page, slug);
  await shot(page, "meeting-doc");
  await c.close();
}

// ── release: the VS Code extension's publish, then a web edit ───────────────
const RELEASE = `# Release notes — v2.5

Shipped on November 3.

## New
- Workflows: chain steps and run them on a schedule.
- Faster search across every workspace.
- Dark mode for embedded dashboards.

## Fixed
- Exports keep their column order.
- Invites no longer expire after 24 hours.
`;
async function release() {
  console.log("▸ release");
  const tok = await token();
  await sandbox("/__sandbox/cleanup"); // so the extension's desired slug, release-notes, is free
  const r = await api("POST", "/api/v1/sync", tok, { title: "Release notes — v2.5", content: RELEASE, desired_slug: "release-notes" });
  if (r.status !== 201) throw new Error(`sync create → ${r.status} ${r.text}`);
  const doc = r.json;
  facts.release = { id: doc.id, slug: doc.slug, rev: doc.rev, url: `https://markdrop.in/${doc.slug}`, markdown: RELEASE };
  const c = await ctx({ tok, w: 1280, h: 800 });
  const page = await c.newPage();
  await openDoc(page, doc.slug);
  await shot(page, "release-doc");
  // Edit on the web: change one line, save.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await settle(page, 1200);
  const ta = page.locator("textarea").first();
  await ta.waitFor();
  await shot(page, "release-edit");
  const before = await ta.inputValue();
  const NEW_LINE = "- Faster search across every workspace, now with filters.";
  await ta.fill(before.replace("- Faster search across every workspace.", NEW_LINE));
  await page.waitForTimeout(500);
  await shot(page, "release-edited");
  const save = page.getByRole("button", { name: "Save changes" });
  const sb = await save.boundingBox();
  facts.release.save = sb && { x: sb.x + sb.width / 2, y: sb.y + sb.height / 2 };
  // Where the changed line sits in the textarea, for the typing effect in the scene.
  facts.release.line = await ta.evaluate((el, needle) => {
    const i = el.value.indexOf(needle);
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || 24;
    const lineNo = el.value.slice(0, i).split("\n").length - 1;
    const r = el.getBoundingClientRect();
    const c = document.createElement("canvas").getContext("2d");
    c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return { x: r.left + parseFloat(cs.paddingLeft), y: r.top + parseFloat(cs.paddingTop) + lineNo * lh - el.scrollTop, h: lh,
      w: r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), charW: c.measureText("M").width };
  }, NEW_LINE);
  facts.release.newLine = NEW_LINE;
  facts.release.oldLine = "- Faster search across every workspace.";
  await save.click();
  await settle(page, 1500);
  await page.mouse.move(640, 700);
  await page.waitForTimeout(800);
  await shot(page, "release-saved");
  const after = await api("GET", `/api/v1/sync/${doc.id}`, tok);
  facts.release.after = { rev: after.json?.rev, status: after.status };
  await c.close();
}

// ── authorize: the Connect VS Code page, light + dark ───────────────────────
async function authorize() {
  console.log("▸ authorize");
  const tok = await token();
  const dir = path.join(ASSETS, "vscode/sync");
  mkdirSync(dir, { recursive: true });
  for (const theme of ["light", "dark"]) {
    const c = await ctx({ tok, theme, w: 1440, h: 900, dpr: 2 });
    const page = await c.newPage();
    await page.goto(`${APP}/extension/authorize?redirect=${encodeURIComponent("vscode://HimanshuKukreja.markdrop/auth")}&state=demo`, { waitUntil: "domcontentloaded" });
    await settle(page, 1500);
    const card = page.locator(".md-card").first();
    await card.waitFor();
    const b = await card.boundingBox();
    const pad = 24;
    const png = path.join(os.tmpdir(), `vscode-authorize-${theme}.png`);
    await page.screenshot({ path: png, clip: { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad }, animations: "disabled", caret: "hide" });
    webp(png, path.join(dir, `vscode-authorize${theme === "dark" ? ".dark" : ""}.webp`), { q: 84, maxBytes: 180 * 1024 });
    await c.close();
  }
}

try {
  if (want("demo")) await demo();
  if (want("consent")) await consent();
  if (want("meeting")) await meeting();
  if (want("release")) await release();
  if (want("authorize")) await authorize();
} finally {
  writeFileSync(factsFile, `${JSON.stringify(facts, null, 1)}\n`);
  await browser.close();
}
