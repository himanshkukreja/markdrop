/**
 * Markdrop Guides and Analytics on phones and tablets (fix/mobile-guides): every studio screen, the
 * published guide's reading view (the docs engine on docs.localhost: the same renderer every
 * *.guides.markdrop.in site is built with) and every Analytics screen, at every device size, as the
 * owner (Ada, Guides admin) and a member (Ben, Guides editor), on seeded data (seed_mobile_guides.py).
 * Each state is measured in the page and flagged automatically:
 *
 *   hscroll        the page scrolls sideways (scrollWidth > clientWidth)
 *   offscreen      a visible control or text is cut off by the viewport's edge (not by its own scroller)
 *   popup          a menu, popover, sheet or dialog doesn't fit inside the viewport
 *   target         an interactive element's touch target is under 44 × 44 px (probed with
 *                  elementFromPoint, so a larger invisible hit area counts, and a neighbour inside the
 *                  44 px box doesn't)
 *   input          a text field's font size is under 16 px (iOS zooms the page on focus)
 *   text           text under 12 px
 *   overlap        two fixed or sticky bars cover each other
 *   sticky         the top bar doesn't stay on screen after a long scroll
 *   zoom           the viewport meta disables pinch zoom
 *   hover          a control that only shows on hover (opacity 0 until :hover) on a touch screen
 *   image          an image is distorted (rendered aspect differs from its natural aspect under
 *                  object-fit: fill) or wider than the viewport
 *   keyboard       (Ask AI) with the on-screen keyboard up, the composer is not inside the visual viewport
 *
 * Screenshots of every state go to $PB_WORK/mobile-guides/<browser>/<theme>/<device>/<role>-<state>.png
 * and the findings to findings-<browser>.{json,txt} there. Exit code 1 when anything is flagged.
 *
 *   PB_STACK_ID=36 BROWSER=chromium|webkit [DEVICES=phone-360,ipad-air] [ROLES=owner,member]
 *     [THEMES=light,dark] [ONLY=home,editor,…] [NO_RESEED=1] [SHOTS=0] node mobile-guides.mjs
 *
 * Dark runs a phone, the phone in landscape and one tablet (colours, not layout, change); light runs
 * every device.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, webkit } from "@playwright/test";
import { APP, BROWSER, STACK, STACK_ID, WORK, log, reseed, seedNow, here } from "./lib.mjs";

export const DEVICES = [
  { name: "phone-360", w: 360, h: 780, kind: "phone" }, // small Android
  { name: "phone-375", w: 375, h: 667, kind: "phone" }, // iPhone SE
  { name: "phone-393", w: 393, h: 852, kind: "phone" }, // iPhone 15 / Pixel
  { name: "phone-412", w: 412, h: 915, kind: "phone" }, // big Android
  { name: "phone-land", w: 852, h: 393, kind: "phone" }, // iPhone landscape
  { name: "ipad-mini", w: 744, h: 1133, kind: "tablet" },
  { name: "ipad-768", w: 768, h: 1024, kind: "tablet" },
  { name: "ipad-810", w: 810, h: 1080, kind: "tablet" },
  { name: "ipad-air", w: 820, h: 1180, kind: "tablet" },
  { name: "ipad-pro11", w: 834, h: 1194, kind: "tablet" },
  { name: "ipad-land", w: 1024, h: 768, kind: "tablet" },
  { name: "ipad-air-land", w: 1180, h: 820, kind: "tablet" },
  { name: "ipad-pro", w: 1024, h: 1366, kind: "tablet" },
  { name: "android-tab", w: 800, h: 1280, kind: "tablet" },
];
const DARK_DEVICES = new Set(["phone-393", "phone-land", "ipad-air"]);

const want = (env, all) => (process.env[env] ? process.env[env].split(",").map((s) => s.trim()).filter(Boolean) : all);
const devices = DEVICES.filter((d) => want("DEVICES", DEVICES.map((x) => x.name)).includes(d.name));
const roles = want("ROLES", ["owner", "member"]);
const themes = want("THEMES", ["light", "dark"]);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const SHOOT = process.env.SHOTS !== "0";
const OUT = path.join(WORK, "mobile-guides", process.env.OUT_TAG || BROWSER);
fs.mkdirSync(OUT, { recursive: true });

const ROOT = path.resolve(here, "../../../..").split("/.claude/worktrees/")[0];
const PY = path.join(ROOT, "backend", ".venv", "bin", "python");
const NEXT_PORT = new URL(APP).port;
const DOCS = `http://docs.localhost:${NEXT_PORT}`;

/* ── Seed ─────────────────────────────────────────────────────────────── */

const MOBILE = path.join(STACK, "mobile.json");
let S, M;
if (process.env.NO_RESEED && fs.existsSync(MOBILE)) {
  S = seedNow();
  M = JSON.parse(fs.readFileSync(MOBILE, "utf8"));
} else {
  S = reseed();
  execFileSync(PY, [path.join(here, "seed_mobile_guides.py")], { stdio: "inherit", env: { ...process.env, STACK_ID: String(STACK_ID), PB_STACK: STACK } });
  M = JSON.parse(fs.readFileSync(MOBILE, "utf8"));
}
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));

/* ── The measurement, in the page ─────────────────────────────────────── */


/** Runs in the page: every rule above, as [{rule, who, detail}]. */
function measure({ checkTargets }) {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const out = [];
  const seen = new Set();
  const push = (rule, el, detail) => {
    const who = describe(el);
    const k = `${rule}|${who}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ rule, who, detail });
  };
  function describe(el) {
    if (!el || el.nodeType !== 1) return String(el);
    const bits = [el.tagName.toLowerCase()];
    const role = el.getAttribute("role");
    if (role) bits.push(`[role=${role}]`);
    const name = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    if (name) bits.push(`"${name.replace(/[0-9a-f]{24}/g, "…").replace(/\d+/g, "#").slice(0, 48)}"`);
    const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || "")
      .split(/\s+/).filter((c) => c && !/^(ph-|md-focus)/.test(c) && !/[\[\]:]/.test(c)).slice(0, 2).join(".");
    if (cls) bits.push(`.${cls}`);
    return bits.join("");
  }
  const visible = (el) => {
    if (!el.isConnected) return false;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      if (a.getAttribute("aria-hidden") === "true" && a.closest("[inert], [aria-hidden=true]") && !a.closest("[role=dialog]")) return false;
      if (a.hasAttribute("inert")) return false;
      if (a.hasAttribute("data-audit-skip")) return false;
      const cs = getComputedStyle(a);
      if (cs.clipPath === "inset(50%)" || cs.clip === "rect(0px, 0px, 0px, 0px)") return false;
    }
    return true;
  };
  /** The part of an element's box its clipping ancestors (overflow ≠ visible) leave showing. */
  const clipped = (el) => {
    let r = el.getBoundingClientRect();
    let { left, right, top, bottom } = r;
    let fixedAncestor = false;
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.position === "fixed") fixedAncestor = true;
      if (a === document.body) break;
      const ox = cs.overflowX, oy = cs.overflowY;
      if (ox !== "visible" || oy !== "visible") {
        const ar = a.getBoundingClientRect();
        if (ox !== "visible") { left = Math.max(left, ar.left); right = Math.min(right, ar.right); }
        if (oy !== "visible") { top = Math.max(top, ar.top); bottom = Math.min(bottom, ar.bottom); }
      }
    }
    if (getComputedStyle(el).position === "fixed") fixedAncestor = true;
    return { left, right, top, bottom, fixed: fixedAncestor, empty: right - left < 1 || bottom - top < 1 };
  };

  // 1. sideways scroll
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 1 || document.body.scrollWidth > de.clientWidth + 1) {
    const culprits = [];
    for (const el of document.body.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 && r.width > 0 && visible(el)) {
        const c = clipped(el);
        if (!c.empty && c.right > vw + 1 && !(el.parentElement && el.parentElement.getBoundingClientRect().right > vw + 1)) culprits.push(el);
      }
    }
    push("hscroll", culprits[0] || de, `scrollWidth ${Math.max(de.scrollWidth, document.body.scrollWidth)} > ${de.clientWidth}${culprits.length ? ` (first: ${culprits.slice(0, 3).map(describe).join(", ")})` : ""}`);
  }

  const INTERACTIVE = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=tab], [role=option], [role=switch], [role=checkbox], [role=radio], [role=combobox], [tabindex]:not([tabindex="-1"])';
  const modal = [...document.querySelectorAll('[aria-modal="true"]')].filter(visible).pop();
  const scope = modal || document.body;

  // 2. off-screen controls and text
  for (const el of scope.querySelectorAll(`${INTERACTIVE}, h1, h2, h3, p, label, li, td, th`)) {
    if (!visible(el)) continue;
    const c = clipped(el);
    if (c.empty) continue;
    const offX = c.left < -1 || c.right > vw + 1;
    const offY = c.fixed && (c.top < -1 || c.bottom > vh + 1);
    if (offX || offY) push("offscreen", el, `visible box ${Math.round(c.left)},${Math.round(c.top)} → ${Math.round(c.right)},${Math.round(c.bottom)} in ${vw}×${vh}`);
  }

  // 3. popups fit the viewport
  for (const el of document.querySelectorAll('[role=menu], [role=dialog], [role=alertdialog], [role=listbox], .md-popover, .md-sheet')) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "absolute") continue;
    if (el.getAttribute("role") === "listbox" && el.closest("[role=dialog]")) continue;
    const r = el.getBoundingClientRect();
    if (r.left < -1 || r.right > vw + 1 || r.top < -1 || r.bottom > vh + 1) push("popup", el, `${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)} in ${vw}×${vh}`);
  }

  // 4. touch targets
  if (checkTargets) {
    for (const el of scope.querySelectorAll(INTERACTIVE)) {
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      if (el.matches("[role=listbox], [role=menu], [role=dialog], [role=grid], [role=tabpanel], [role=region], [role=group], ul, ol, main, section, form, div[tabindex='0'][class*='scroll']")) continue;
      if (el.matches("input[type=checkbox], input[type=radio]") && el.closest("label")) continue; // the label is the target
      let target = el;
      if (!visible(target)) {
        // A hidden native input behind a custom control: its label is the target.
        if (el.matches("input") && el.closest("label") && visible(el.closest("label"))) target = el.closest("label");
        else continue;
      }
      const r = target.getBoundingClientRect();
      // Inline links inside running text are exempt (WCAG 2.5.8's inline exception).
      if (el.tagName === "A" && getComputedStyle(el).display === "inline") {
        const block = el.parentElement;
        const t = (block?.innerText || "").trim().length;
        if (t > (el.innerText || "").trim().length + 12) continue;
      }
      if (r.width >= 43.5 && r.height >= 43.5) continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      // Under something else at its own centre: obscured, not a target right now.
      const atCentre = document.elementFromPoint(Math.min(vw - 1, Math.max(0, cx)), Math.min(vh - 1, Math.max(0, cy)));
      if (!atCentre || !(target === atCentre || target.contains(atCentre) || atCentre.contains(target))) continue;
      const probes = [[cx - 21.5, cy], [cx + 21.5, cy], [cx, cy - 21.5], [cx, cy + 21.5]];
      let ok = true;
      for (const [x, y] of probes) {
        if (x < 0 || y < 0 || x >= vw || y >= vh) continue;
        const hit = document.elementFromPoint(x, y);
        if (!hit || !(hit === target || target.contains(hit))) { ok = false; break; }
      }
      if (!ok) push("target", el, `${Math.round(r.width)}×${Math.round(r.height)}`);
    }
  }

  // 5. text fields under 16 px
  for (const el of scope.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]):not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), textarea, select, [contenteditable="true"]')) {
    if (!visible(el)) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 15.95) push("input", el, `${fs}px`);
  }

  // 6. text under 12 px
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue.trim()) continue;
    const el = n.parentElement;
    if (!el || el.closest("script, style, noscript, svg, [data-audit-skip]")) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs >= 11.95) continue;
    if (!visible(el)) continue;
    push("text", el, `${fs}px`);
  }

  // 7. fixed and sticky bars covering each other
  const bars = [];
  for (const el of document.body.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") continue;
    if (!visible(el) || cs.pointerEvents === "none") continue;
    if (el.closest('[aria-modal="true"], [role=menu], [role=listbox], [role=tooltip], .md-popover, .md-scrim, .md-drawer-scrim, .md-skiplink, [data-audit-skip]')) continue;
    if (el.matches('[aria-modal="true"], .md-scrim, .md-drawer-scrim')) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height >= vw * vh * 0.9) continue;
    if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
    bars.push([el, r, cs.position]);
  }
  const top = bars.filter(([el]) => !bars.some(([o]) => o !== el && o.contains(el)));
  for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
    const [a, ra, pa] = top[i], [b, rb, pb] = top[j];
    if (a.contains(b) || b.contains(a)) continue;
    // A sticky element inside a scroller that the other isn't part of can't cover it in flow.
    const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
    const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (w > 2 && h > 2 && (pa === "fixed" || pb === "fixed" || modal == null)) {
      // Two sticky things only overlap in a bad way when they're both stuck at the same place.
      push("overlap", a, `${describe(a)} (${pa}) and ${describe(b)} (${pb}) overlap ${Math.round(w)}×${Math.round(h)}`);
    }
  }

  // 8. hover-only controls (touch screens): opacity 0 / visibility hidden unless hovered
  for (const el of scope.querySelectorAll(INTERACTIVE)) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    if (el.closest("[data-audit-skip], .md-visually-hidden, .md-skiplink")) continue;
    let hidden = false;
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (Number(s.opacity) === 0 && s.display !== "none") { hidden = true; break; }
    }
    if (hidden && cs.visibility !== "hidden" && !el.closest("[aria-hidden=true]")) {
      // Opacity 0 but in the layout and clickable: a hover-only affordance.
      if (cs.pointerEvents !== "none") push("hover", el, "opacity 0 until hover/focus");
    }
  }

  // 9. pinch zoom
  const meta = document.querySelector('meta[name="viewport"]')?.getAttribute("content") || "";
  if (/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0*)?\b/i.test(meta)) push("zoom", document.documentElement, meta);

  return out;
}

/** After a long scroll (and an overscroll at the end), the top bar is still at the top. */
async function stickyCheck(p) {
  return p.evaluate(async () => {
    const header = document.querySelector("header.sticky, header[class*='sticky']");
    const de = document.scrollingElement || document.documentElement;
    if (!header || de.scrollHeight <= window.innerHeight + 200) return null;
    window.scrollTo(0, de.scrollHeight);
    await new Promise((r) => setTimeout(r, 250));
    const r = header.getBoundingClientRect();
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 100));
    return Math.abs(r.top) > 1 ? `the header is at ${Math.round(r.top)} after scrolling` : null;
  });
}


/** Runs in the page: images that are distorted or wider than the viewport. */
function measureImages() {
  const vw = document.documentElement.clientWidth;
  const out = [];
  for (const img of document.querySelectorAll("img, video")) {
    const r = img.getBoundingClientRect();
    if (r.width < 24 || r.height < 24) continue;
    const cs = getComputedStyle(img);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    const nw = img.naturalWidth ?? img.videoWidth, nh = img.naturalHeight ?? img.videoHeight;
    const who = `${img.tagName.toLowerCase()} ${(img.getAttribute("alt") || img.currentSrc || img.src || "").split("?")[0].split("/").pop().slice(0, 40)}`;
    // A clipped ancestor (a scroller, a card) bounds what shows.
    let right = r.right;
    for (let a = img.parentElement; a && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.overflowX !== "visible") { right = Math.min(right, a.getBoundingClientRect().right); }
    }
    if (right > vw + 1) out.push({ rule: "image", who, detail: `right edge ${Math.round(right)} > ${vw}` });
    if (img.tagName === "IMG" && nw && nh && (cs.objectFit === "fill" || !cs.objectFit) && !/\.svg/.test(img.currentSrc || "")) {
      const a = r.width / r.height, n = nw / nh;
      if (Math.abs(a - n) / n > 0.04) out.push({ rule: "image", who, detail: `stretched: ${Math.round(r.width)}×${Math.round(r.height)} for a ${nw}×${nh} image` });
    }
  }
  return out;
}

/** With the on-screen keyboard up (the visual viewport shrinks by `kb` px from the bottom), is the
 *  focused field and the composer around it still inside it? Emulated: we can't raise a real keyboard,
 *  so we shrink the layout viewport the way iOS (resizes-visual) and Android (resizes-content) do. */
async function keyboardCheck(p, dev, focus) {
  const kb = Math.round(dev.h * (dev.kind === "phone" ? 0.42 : 0.33));
  await focus.focus().catch(() => {});
  await p.setViewportSize({ width: dev.w, height: dev.h - kb });
  await p.waitForTimeout(500);
  const res = await p.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return "nothing focused";
    const r = el.getBoundingClientRect();
    const vv = window.visualViewport;
    const top = vv ? vv.offsetTop : 0, bottom = top + (vv ? vv.height : window.innerHeight);
    if (r.bottom > bottom + 1 || r.top < top - 1) return `focused ${el.tagName.toLowerCase()} at ${Math.round(r.top)}–${Math.round(r.bottom)}, visible ${Math.round(top)}–${Math.round(bottom)}`;
    return null;
  });
  await p.setViewportSize({ width: dev.w, height: dev.h });
  await p.waitForTimeout(300);
  return res;
}

/* ── Screens and states ───────────────────────────────────────────────── */

const G = `${APP}/guides`;
const site = `${G}/${M.site}`;

const click = async (p, loc, timeout = 8000) => {
  const l = typeof loc === "string" ? p.locator(loc).first() : loc.first();
  await l.waitFor({ state: "visible", timeout });
  await l.scrollIntoViewIfNeeded().catch(() => {});
  await l.tap({ timeout }).catch(async () => l.click({ timeout }));
  await p.waitForTimeout(500);
};
const visibleFirst = async (p, locs) => {
  for (const l of locs) {
    const v = l.first();
    if (await v.isVisible().catch(() => false)) return v;
  }
  return null;
};
const h1 = (p) => p.locator("main h1, h1").first();
const anyMain = (p) => p.locator("main").first();
const dialog = (p) => p.getByRole("dialog").first();

/** [name, roles, url(role), ready locator(p), action?(p, dev) → "skip" | string (a finding) | void] */
const STATES = [
  // Studio home, people, create
  ["home", ["owner", "member"], () => `${G}/home`, (p) => p.getByRole("tabpanel").first()],
  ["home-list", ["owner"], () => `${G}/home`, (p) => p.getByRole("tabpanel").first(), async (p) => {
    const b = await visibleFirst(p, [p.getByRole("radio", { name: "List" })]);
    if (!b) return "skip";
    await b.tap();
    await p.waitForTimeout(400);
  }],
  ["home-cardmenu", ["owner", "member"], () => `${G}/home`, (p) => p.getByRole("tabpanel").first(), async (p) => click(p, p.getByRole("button", { name: "More for Acme Docs" }))],
  ["home-preview", ["owner"], () => `${G}/home`, (p) => p.getByRole("tabpanel").first(), async (p) => {
    await click(p, p.getByRole("link", { name: "Preview API reference" }));
    await p.waitForURL(/preview=1|page=/, { timeout: 15000 });
    await p.waitForTimeout(2000);
  }],
  ["home-switch", ["owner"], () => site, (p) => p.getByRole("navigation", { name: "Guide" }), async (p) => click(p, p.getByRole("button", { name: /switch guide/i }))],
  ["members", ["owner", "member"], () => `${G}/members`, h1],
  ["new", ["owner"], () => `${G}/new`, h1],
  ["new-template", ["owner"], () => `${G}/new`, h1, async (p) => {
    await click(p, p.locator("label").filter({ hasText: "From a template" }));
    await p.waitForTimeout(600);
  }],
  ["new-scrolled", ["owner"], () => `${G}/new`, h1, async (p) => {
    await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
    await p.waitForTimeout(300);
  }],
  // Editor
  ["editor", ["owner", "member"], () => `${site}?page=${M.page}`, (p) => p.getByRole("textbox").first()],
  ["editor-long", ["owner"], () => `${site}?page=${M.long_page}`, (p) => p.getByRole("textbox").first()],
  ["editor-markdown", ["owner"], () => `${site}?page=${M.long_page}`, (p) => p.getByRole("textbox").first(), async (p) => {
    await click(p, p.getByRole("radio", { name: "Markdown" }));
    await p.waitForTimeout(600);
  }],
  ["editor-tree", ["owner", "member"], () => `${site}?page=${M.page}`, (p) => p.getByRole("textbox").first(), async (p) => {
    const b = await visibleFirst(p, [p.getByRole("button", { name: "Pages", exact: true })]);
    if (!b) return "skip";
    await b.tap();
    await dialog(p).waitFor({ timeout: 6000 });
    await p.waitForTimeout(500);
  }],
  ["editor-panel", ["owner"], () => `${site}?page=${M.page}`, (p) => p.getByRole("textbox").first(), async (p) => {
    const b = await visibleFirst(p, [p.locator('button[title="Checks, page settings, comments and history"]')]);
    if (!b) return "skip";
    await b.tap();
    await dialog(p).waitFor({ timeout: 6000 });
    await p.waitForTimeout(500);
  }],
  ["editor-preview", ["owner"], () => `${site}?page=${M.long_page}&preview=1`, (p) => anyMain(p), async (p) => p.waitForTimeout(1500)],
  ["editor-slash", ["owner"], () => `${site}?page=${M.page}`, (p) => p.getByRole("textbox").first(), async (p, dev) => {
    const ed = p.getByRole("textbox", { name: /^Content of/ }).first();
    await ed.scrollIntoViewIfNeeded();
    await ed.tap();
    await p.keyboard.press("Control+End").catch(() => {});
    await p.keyboard.press("Enter");
    await p.keyboard.type("/");
    await p.waitForTimeout(700);
  }],
  // Publish, versions
  ["publish", ["owner"], () => `${site}/publish`, h1],
  ["publish-compare", ["owner"], () => `${site}/publish/compare`, (p) => anyMain(p), async (p) => p.waitForTimeout(1200)],
  // Settings
  ["settings", ["owner", "member"], () => `${site}/settings`, h1],
  ...["general", "people", "domains", "domains/new", "access", "private", "ask-ai", "redirects", "api-reference", "github", "export", "danger"].map((s) =>
    [`settings-${s.replace("/", "-")}`, s === "people" ? ["owner", "member"] : ["owner"], () => `${site}/settings/${s}`, h1]),
  // Insights, Fix list, Changelog, Design
  ["insights", ["owner", "member"], () => `${site}/insights`, h1, async (p) => p.waitForTimeout(1200)],
  ["fixes", ["owner"], () => `${site}/fixes`, h1, async (p) => p.waitForTimeout(800)],
  ["fixes-open", ["owner"], () => `${site}/fixes`, h1, async (p) => {
    const b = await visibleFirst(p, [p.locator("main details summary"), p.locator("main [aria-expanded=false]")]);
    if (!b) return "skip";
    await b.tap();
    await p.waitForTimeout(500);
  }],
  ["changelog", ["owner"], () => `${site}/changelog`, h1],
  ["design", ["owner"], () => `${site}/design`, anyMain, async (p) => p.waitForTimeout(1200)],
  // The published guide (docs engine)
  ["site-home", ["anon"], () => `${DOCS}/`, (p) => p.locator("main").first()],
  ["site-page", ["anon"], () => `${DOCS}/sharing/request-access`, (p) => p.locator("main h1").first()],
  ["site-api", ["anon"], () => `${DOCS}/api`, (p) => p.locator("main").first()],
  ["site-menu", ["anon"], () => `${DOCS}/sharing/request-access`, (p) => p.locator("main h1").first(), async (p) => {
    const b = await visibleFirst(p, [p.getByRole("button", { name: "Open the docs menu" })]);
    if (!b) return "skip";
    await b.tap();
    await dialog(p).waitFor({ timeout: 6000 });
    await p.waitForTimeout(500);
  }],
  ["site-search", ["anon"], () => `${DOCS}/sharing/request-access`, (p) => p.locator("main h1").first(), async (p) => {
    await click(p, p.getByRole("button", { name: "Search the docs" }));
    await p.getByRole("dialog", { name: "Search the docs or ask" }).waitFor({ timeout: 6000 });
    await p.keyboard.type("share");
    await p.waitForTimeout(900);
  }],
  ["site-ask", ["anon"], () => `${DOCS}/sharing/request-access`, (p) => p.locator("main h1").first(), async (p, dev) => {
    const b = await visibleFirst(p, [p.getByRole("button", { name: /^Ask/ })]);
    if (!b) return "skip";
    await b.tap();
    await p.waitForTimeout(900);
    const box = await visibleFirst(p, [p.locator(".dx-askpanel textarea, [role=dialog] textarea")]);
    if (!box) return "no Ask AI composer";
    return keyboardCheck(p, dev, box);
  }],
  // Analytics
  ["an-home", ["owner"], () => `${APP}/dashboard/analytics`, h1, async (p) => p.waitForTimeout(1500)],
  ["an-live", ["owner"], () => `${APP}/dashboard/live`, h1, async (p) => p.waitForTimeout(1200)],
  ["an-overview", ["owner"], () => `${APP}/dashboard/analytics/launch-plan`, h1, async (p) => p.waitForTimeout(1500)],
  ["an-tooltip", ["owner"], () => `${APP}/dashboard/analytics/launch-plan`, h1, async (p) => {
    await p.waitForTimeout(1500);
    const chart = p.locator("main svg").filter({ has: p.locator("path, rect") }).first();
    if (!(await chart.isVisible().catch(() => false))) return "skip";
    const b = await chart.boundingBox();
    await p.touchscreen.tap(b.x + b.width * 0.6, b.y + b.height * 0.5);
    await p.waitForTimeout(500);
    const tip = await p.locator('[role=tooltip], [data-chart-tip], .md-chart-tip').first().isVisible().catch(() => false);
    if (!tip) return "tapping a chart shows no tooltip";
  }],
  ["an-content", ["owner"], () => `${APP}/dashboard/analytics/launch-plan?tab=content`, h1, async (p) => p.waitForTimeout(1500)],
  ["an-audience", ["owner"], () => `${APP}/dashboard/analytics/launch-plan?tab=audience`, h1, async (p) => p.waitForTimeout(1500)],
  ["an-pages", ["owner"], () => `${APP}/dashboard/analytics/q3-report?tab=pages`, h1, async (p) => p.waitForTimeout(1500)],
  ["an-versions", ["owner"], () => `${APP}/dashboard/analytics/q3-report?tab=versions`, h1, async (p) => p.waitForTimeout(1500)],
  ["an-video", ["owner"], () => `${APP}/dashboard/analytics/${M.video}?tab=video`, h1, async (p) => p.waitForTimeout(1500)],
];

/* ── Run ──────────────────────────────────────────────────────────────── */

const browserType = BROWSER === "webkit" ? webkit : chromium;
const browser = await browserType.launch();
const findings = [];
let states = 0;

async function newContext(dev, theme, role) {
  const token = role === "anon" ? null : T[role];
  const c = await browser.newContext({
    viewport: { width: dev.w, height: dev.h },
    deviceScaleFactor: 2,
    isMobile: BROWSER === "webkit" ? undefined : true,
    hasTouch: true,
    colorScheme: theme,
  });
  await c.addInitScript(([t, th]) => {
    try {
      if (t) localStorage.setItem("markdrop_token", t);
      else localStorage.removeItem("markdrop_token");
      localStorage.setItem("md_theme", th);
      localStorage.setItem("md_theme_beta", "1");
      localStorage.setItem("md_consent", "denied");
      localStorage.setItem("md_install_dismissed", "1");
    } catch {}
  }, [token, theme]);
  const p = await c.newPage();
  p.on("pageerror", (e) => log("  [pageerror]", dev.name, e.message.slice(0, 200)));
  return { c, p };
}

for (const theme of themes) {
  for (const dev of devices) {
    if (theme === "dark" && !DARK_DEVICES.has(dev.name)) continue;
    for (const role of [...roles, "anon"]) {
      const list = STATES.filter(([name, rs]) => rs.includes(role) && (!ONLY || ONLY.has(name) || ONLY.has(name.split("-")[0])));
      if (!list.length) continue;
      const { c, p } = await newContext(dev, theme, role);
      for (const [name, , url, ready, action] of list) {
        const u = url(role);
        if (!u) continue;
        const key = `${theme}/${dev.name}/${role}/${name}`;
        try {
          await p.goto(u, { waitUntil: "domcontentloaded", timeout: 45000 });
          await ready(p).waitFor({ state: "visible", timeout: 30000 });
          await p.waitForTimeout(700);
          let extra = null;
          if (action) {
            const r = await action(p, dev);
            if (r === "skip") continue;
            if (typeof r === "string") extra = r;
          }
          await p.waitForTimeout(250);
          const res = [...(await p.evaluate(measure, { checkTargets: true })), ...(await p.evaluate(measureImages))];
          if (extra) res.push({ rule: name === "site-ask" ? "keyboard" : name === "an-tooltip" ? "touch" : "state", who: name, detail: extra });
          if (!action) {
            const s = await stickyCheck(p).catch(() => null);
            if (s) res.push({ rule: "sticky", who: "header", detail: s });
          }
          states++;
          for (const f of res) findings.push({ browser: BROWSER, theme, device: dev.name, role, state: name, ...f });
          if (SHOOT) {
            const dir = path.join(OUT, theme, dev.name);
            fs.mkdirSync(dir, { recursive: true });
            await p.screenshot({ path: path.join(dir, `${role}-${name}.png`) });
          }
          log(`${key}: ${res.length ? res.map((f) => f.rule).join(",") : "ok"}`);
        } catch (e) {
          findings.push({ browser: BROWSER, theme, device: dev.name, role, state: name, rule: "error", who: "-", detail: e.message.split("\n")[0].slice(0, 200) });
          log(`${key}: ERROR ${e.message.split("\n")[0].slice(0, 200)}`);
          const dir = path.join(OUT, theme, dev.name);
          fs.mkdirSync(dir, { recursive: true });
          await p.screenshot({ path: path.join(dir, `${role}-${name}-error.png`) }).catch(() => {});
        }
        await p.keyboard.press("Escape").catch(() => {});
        await p.keyboard.press("Escape").catch(() => {});
      }
      await c.close();
    }
  }
}

// Orientation change: a phone turned sideways and back, and an iPad turned, keep a fitting layout.
if (!ONLY || ONLY.has("rotate")) {
  const by = Object.fromEntries(DEVICES.map((d) => [d.name, d]));
  for (const [a, b] of [[by["phone-393"], by["phone-land"]], [by["ipad-air"], by["ipad-air-land"]]]) {
    const { c, p } = await newContext(a, "light", "owner");
    for (const u of [`${G}/home`, `${site}?page=${M.page}`, `${site}/insights`, `${APP}/dashboard/analytics/launch-plan`]) {
      await p.goto(u, { waitUntil: "domcontentloaded" });
      await p.locator("main h1, main [role=textbox], [role=tabpanel]").first().waitFor({ timeout: 30000 }).catch(() => {});
      await p.waitForTimeout(900);
      for (const d of [b, a]) {
        await p.setViewportSize({ width: d.w, height: d.h });
        await p.waitForTimeout(700);
        const res = (await p.evaluate(measure, { checkTargets: false })).filter((f) => ["hscroll", "offscreen", "popup", "overlap"].includes(f.rule));
        states++;
        for (const f of res) findings.push({ browser: BROWSER, theme: "light", device: `${a.name}→${d.name}`, role: "owner", state: `rotate:${u.replace(APP, "").replace(/[0-9a-f]{24}/g, "…")}`, ...f });
      }
    }
    await c.close();
  }
}

await browser.close();

/* ── Report ───────────────────────────────────────────────────────────── */

fs.writeFileSync(path.join(OUT, `findings-${BROWSER}.json`), JSON.stringify(findings, null, 1));
const groups = new Map();
for (const f of findings) {
  const k = `${f.rule}|${f.state}|${f.who}`;
  const g = groups.get(k) ?? { ...f, where: new Set(), details: new Set() };
  g.where.add(`${f.theme[0]}:${f.device}:${f.role}`);
  g.details.add(f.detail);
  groups.set(k, g);
}
const lines = [...groups.values()]
  .sort((a, b) => a.rule.localeCompare(b.rule) || a.state.localeCompare(b.state))
  .map((g) => `${g.rule.padEnd(9)} ${g.state.padEnd(22)} ${g.who}  — ${[...g.details].slice(0, 2).join(" | ")}  [${g.where.size}: ${[...g.where].slice(0, 4).join(" ")}${g.where.size > 4 ? " …" : ""}]`);
fs.writeFileSync(path.join(OUT, `findings-${BROWSER}.txt`), lines.join("\n") + "\n");
console.log(`\n${states} states, ${findings.length} findings in ${groups.size} groups (${OUT}/findings-${BROWSER}.txt)`);
const byRule = {};
for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
console.log(byRule);
if (findings.length) process.exit(1);
