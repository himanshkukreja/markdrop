/**
 * The app shell and workspace screens on phones and tablets (fix/mobile-shell): every screen and the
 * menus, sheets and dialogs on it, at every device size, as the owner and as a member, on seeded data.
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
 *   hover          a control that only shows on hover (opacity 0 / hidden until :hover) on a touch screen
 *
 * Screenshots of every state go to $PB_WORK/mobile-shell/<browser>/<theme>/<device>/<role>-<state>.png
 * and the findings to findings-<browser>.json there. Exit code 1 when anything is flagged (a regression).
 *
 *   PB_STACK_ID=34 BROWSER=chromium|webkit [DEVICES=phone-360,ipad-air] [ROLES=owner,member]
 *     [THEMES=light,dark] [ONLY=files,palette,…] [NO_RESEED=1] [SHOTS=0] node mobile-shell.mjs
 *
 * Dark runs the phones and one tablet (the colours, not the layout, change); light runs every device.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, webkit } from "@playwright/test";
import { APP, API, BROWSER, STACK, STACK_ID, WORK, log, fail, reseed, seedNow, api } from "./lib.mjs";

export const DEVICES = [
  { name: "phone-360", w: 360, h: 780, kind: "phone" }, // small Android
  { name: "phone-375", w: 375, h: 667, kind: "phone" }, // iPhone SE
  { name: "phone-393", w: 393, h: 852, kind: "phone" }, // iPhone 15 / Pixel
  { name: "phone-412", w: 412, h: 915, kind: "phone" }, // big Android
  { name: "phone-land", w: 852, h: 393, kind: "phone" }, // iPhone landscape
  { name: "ipad-mini", w: 744, h: 1133, kind: "tablet" },
  { name: "ipad-air", w: 820, h: 1180, kind: "tablet" },
  { name: "ipad-air-land", w: 1180, h: 820, kind: "tablet" },
  { name: "ipad-pro", w: 1024, h: 1366, kind: "tablet" },
  { name: "android-tab", w: 800, h: 1280, kind: "tablet" },
];
const DARK_DEVICES = new Set(["phone-360", "phone-393", "phone-land", "ipad-air"]);

const want = (env, all) => (process.env[env] ? process.env[env].split(",").map((s) => s.trim()).filter(Boolean) : all);
const devices = DEVICES.filter((d) => want("DEVICES", DEVICES.map((x) => x.name)).includes(d.name));
const roles = want("ROLES", ["owner", "member"]);
const themes = want("THEMES", ["light", "dark"]);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const SHOOT = process.env.SHOTS !== "0";
const OUT = path.join(WORK, "mobile-shell", BROWSER);
fs.mkdirSync(OUT, { recursive: true });

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../..").split("/.claude/worktrees/")[0];
const PY = path.join(ROOT, "backend", ".venv", "bin", "python");
const HERE = path.dirname(new URL(import.meta.url).pathname);

/* ── Seed ─────────────────────────────────────────────────────────────── */

function seedListing() {
  execFileSync(PY, [path.join(HERE, "seed_listing.py")], { stdio: "pipe", env: { ...process.env, STACK_ID: String(STACK_ID), PB_STACK: STACK } });
  return JSON.parse(fs.readFileSync(path.join(STACK, "seed-listing.json"), "utf8"));
}

const EXTRA = path.join(STACK, "seed-mobile-shell.json");

/** On top of seed.py + seed_listing.py: a Board folder, personal files, trash, a share for each person
 *  (Shared with me and the bell), and an access request waiting for the owner. */
async function seedExtra(L) {
  const T = Object.fromEntries(Object.entries(L.users).map(([k, u]) => [k, u.token]));
  const WS = L.ws;
  const ok = (r, what) => {
    if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body;
  };
  const board = ok(await api("POST", `/api/v1/workspaces/${WS}/folders`, T.owner, { name: "Roadmap" }), "board folder");
  const boardId = board.id ?? board.folder?.id;
  ok(await api("PUT", `/api/v1/workspaces/${WS}/folders/${boardId}/properties`, T.owner, {
    properties: [
      { key: "status", name: "Status", type: "select", options: [{ name: "Planned", color: "gray" }, { name: "In build", color: "blue" }, { name: "Shipped", color: "green" }] },
      { key: "owner", name: "Owner", type: "text" },
      { key: "due", name: "Due", type: "date" },
    ],
  }), "board schema");
  const pages = { "Search v2": "In build", "Bulk export": "In build", SSO: "Shipped", "Audit log": "Planned", "Mobile app": "Planned", "Usage-based billing with a long title that wraps": "Planned" };
  for (const [title, status] of Object.entries(pages)) {
    const r = ok(await api("POST", "/api/v1/pages", T.owner, { title, workspace: WS, folder: boardId, auto_cover: false }), `page ${title}`);
    ok(await api("PATCH", `/api/v1/documents/${r.document.slug}/properties`, T.owner, { values: { status, owner: "Ada", due: "2026-12-01" } }), `values ${title}`);
  }
  // My files: a few personal documents; one goes to the trash.
  const mine = [];
  for (const [i, title] of ["Quarterly letter to investors", "Interview loop", "Notes from the offsite", "Draft: pricing page copy"].entries()) {
    const d = ok(await api("POST", "/api/v1/documents", T.owner, { title, content: `# ${title}\n\nSome words for item ${i}.\n`, expires_in: "never", access_level: i === 0 ? "private" : undefined }), `doc ${title}`);
    mine.push(d);
  }
  const trashed = ok(await api("POST", "/api/v1/documents", T.owner, { title: "Old launch checklist", content: "# Old\n", expires_in: "never" }), "trash doc");
  const del = await api("DELETE", `/api/v1/documents/${trashed.slug}`, T.owner, undefined, trashed.edit_token ? { "X-Edit-Token": trashed.edit_token } : {});
  if (del.status >= 300) log("trash: delete →", del.status);
  // Shares: Ada → Ben (Ben's Shared with me + bell), Ben → Ada (Ada's). Straight to the db: the seed's
  // people have reserved @*.test addresses, which the sharing route's email check refuses.
  const benDoc = ok(await api("POST", "/api/v1/documents", T.member, { title: "Ben's backend notes", content: "# Notes\n", expires_in: "never", access_level: "private" }), "ben doc");
  const who = (k) => ({ id: L.users[k].id ?? L.users[k].user_id, email: L.users[k].email, name: L.users[k].name });
  const [ada, ben] = [who("owner"), who("member")];
  execFileSync(PY, [path.join(HERE, "seed_mobile_shell.py"), JSON.stringify([
    { slug: mine[1].slug, from: ada.id, from_email: ada.email, from_name: ada.name, to: ben.id, to_email: ben.email },
    { slug: benDoc.slug, from: ben.id, from_email: ben.email, from_name: ben.name, to: ada.id, to_email: ada.email },
  ])], { stdio: "pipe", env: { ...process.env, STACK_ID: String(STACK_ID) } });
  // Cy asks Ada for access to her private letter.
  const req = await api("POST", `/api/v1/documents/${mine[0].slug}/access-requests`, T.stranger, { message: "Could I read this before Thursday's call?", role: "viewer" });
  if (req.status >= 300) log("access request →", req.status, JSON.stringify(req.body).slice(0, 200));
  const out = { board: boardId, mine: mine.map((d) => d.slug), request: req.body?.id ?? null };
  fs.writeFileSync(EXTRA, JSON.stringify(out, null, 1));
  return out;
}

let L, X;
if (process.env.NO_RESEED && fs.existsSync(EXTRA) && fs.existsSync(path.join(STACK, "seed-listing.json"))) {
  seedNow();
  L = JSON.parse(fs.readFileSync(path.join(STACK, "seed-listing.json"), "utf8"));
  X = JSON.parse(fs.readFileSync(EXTRA, "utf8"));
} else {
  reseed();
  L = seedListing();
  X = await seedExtra(L);
}
const T = Object.fromEntries(Object.entries(L.users).map(([k, u]) => [k, u.token]));
const WS = L.ws;
// A busy folder (the first top-level one with items) for the folder screen.
const busyFolder = await (async () => {
  const r = await api("GET", `/api/v1/workspaces/${WS}/tree`, T.owner);
  const folders = r.body?.folders ?? [];
  return (folders.find((f) => f.name === "Product") ?? folders[0])?.id;
})();

let adminToken = null;
async function admin() {
  if (adminToken) return adminToken;
  const env = fs.readFileSync(path.join(ROOT, "frontend/scripts/docs-media/stack/.env"), "utf8");
  const v = (k) => (env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] ?? "").replace(/^['"]|['"]$/g, "");
  const r = await api("POST", "/api/v1/admin/login", null, { username: v("MARKDROP_ADMIN_USERNAME") || "admin", password: v("MARKDROP_ADMIN_PASSWORD") || "changeme" });
  adminToken = r.body?.token ?? null;
  if (!adminToken) log("admin login →", r.status);
  return adminToken;
}

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
      // The hit area along the centre lines, walked out 1 px at a time (a stretched link's ::after or
      // a larger invisible hit area counts; the screen's edge counts as reach).
      const owns = (x, y) => { const h = document.elementFromPoint(x, y); return !!h && (h === target || target.contains(h)); };
      const reach = (dx, dy) => {
        for (let s = 1; s <= 22; s++) {
          const x = cx + dx * s, y = cy + dy * s;
          if (x < 0 || y < 0 || x >= vw || y >= vh) return 22;
          if (!owns(x, y)) return s - 1;
        }
        return 22;
      };
      const hw = reach(-1, 0) + reach(1, 0) + 1, hh = reach(0, -1) + reach(0, 1) + 1;
      if (hw < 43 || hh < 43) push("target", el, `${Math.round(r.width)}×${Math.round(r.height)} (hit ${hw}×${hh})`);
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
    // An avatar's initials (one or two letters in a small round chip) are a mark, not text to read.
    const br = el.getBoundingClientRect();
    if (n.nodeValue.trim().length <= 2 && br.width <= 28 && br.height <= 28 && /^[A-Z?]+$/i.test(n.nodeValue.trim())) continue;
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

/* ── Screens and states ───────────────────────────────────────────────── */

const wsUrl = `${APP}/w/${WS}`;
const busyUrl = `${APP}/w/${WS}/f/${busyFolder}`;
const boardUrl = `${APP}/w/${WS}/f/${X.board}`;

const click = async (p, loc, timeout = 8000) => {
  const l = typeof loc === "string" ? p.locator(loc).first() : loc.first();
  await l.waitFor({ state: "visible", timeout });
  await l.scrollIntoViewIfNeeded().catch(() => {});
  await l.tap({ timeout }).catch(async () => l.click({ timeout }));
  await p.waitForTimeout(450);
};
const visibleFirst = async (p, locs) => {
  for (const l of locs) {
    const v = l.first();
    if (await v.isVisible().catch(() => false)) return v;
  }
  return null;
};
const openPalette = async (p) => {
  const b = await visibleFirst(p, [p.getByRole("button", { name: "Search", exact: true }), p.getByRole("button", { name: /Search everything/ })]);
  if (b) { await b.tap().catch(() => b.click()); } else { await p.keyboard.press("Control+K"); }
  await p.getByRole("combobox", { name: /Search everything/ }).waitFor({ timeout: 8000 });
  await p.waitForTimeout(300);
};
const openBrowse = async (p, dev) => {
  if (dev.w >= 1024 && dev.kind === "tablet" && dev.w !== 1024) return "skip"; // the rail is on screen
  const b = await visibleFirst(p, [p.getByRole("button", { name: "Browse" }), p.getByRole("button", { name: "Menu" })]);
  if (!b) return "skip";
  await b.tap().catch(() => b.click());
  await p.getByRole("dialog").first().waitFor({ timeout: 6000 });
  await p.waitForTimeout(450);
};
const firstRowMenu = (p) => p.locator("main").getByRole("button", { name: /^(More actions|Actions|More actions for .*|Actions for .*)$/ });

/** [name, roles, url(role), ready locator(p), action?(p, dev)] — an action returning "skip" skips the state. */
const STATES = [
  ["files", ["owner", "member"], () => `${APP}/dashboard`, (p) => p.locator("main h1, main [role=tablist]").first()],
  ["files-rowmenu", ["owner"], () => `${APP}/dashboard`, (p) => p.locator("main h1").first(), async (p) => click(p, firstRowMenu(p))],
  ["files-share", ["owner"], () => `${APP}/dashboard`, (p) => p.locator("main h1").first(), async (p) => {
    await click(p, firstRowMenu(p));
    await click(p, p.getByRole("menuitem", { name: /^Share|Who can open/ }));
    await p.getByRole("dialog").first().waitFor({ timeout: 8000 });
  }],
  ["shared", ["owner", "member"], () => `${APP}/shared`, (p) => p.locator("main h1").first()],
  ["recent", ["owner"], () => `${APP}/recent`, (p) => p.locator("main h1").first()],
  ["trash", ["owner"], () => `${APP}/trash`, (p) => p.locator("main h1").first()],
  ["drawer", ["owner", "member"], () => `${APP}/dashboard`, (p) => p.locator("main h1").first(), openBrowse],
  ["account", ["owner"], () => `${APP}/dashboard`, (p) => p.locator("main h1").first(), async (p) => click(p, p.getByRole("button", { name: /^Account menu/ }))],
  ["create", ["owner"], () => `${APP}/dashboard`, (p) => p.locator("main h1").first(), async (p) => click(p, p.locator("header .md-create").first())],
  ["bell", ["owner", "member"], () => `${APP}/dashboard`, (p) => p.locator("main h1").first(), async (p) => {
    await click(p, p.getByRole("button", { name: /Notifications/ }));
    await p.waitForTimeout(600);
  }],
  ["palette", ["owner"], () => `${APP}/dashboard`, (p) => p.locator("main h1").first(), async (p) => openPalette(p)],
  ["palette-results", ["owner", "member"], () => wsUrl, (p) => p.locator("main h1").first(), async (p) => {
    await openPalette(p);
    await p.getByRole("combobox", { name: /Search/ }).fill("plan");
    await p.waitForTimeout(1500);
  }],
  ["ws-list", ["owner", "member"], () => `${wsUrl}?view=list`, (p) => p.locator("main h1").first()],
  ["ws-grid", ["owner"], () => `${wsUrl}?view=grid`, (p) => p.locator("main h1").first()],
  ["ws-cards", ["owner"], () => `${wsUrl}?view=cards`, (p) => p.locator("main h1").first()],
  ["ws-rowmenu", ["owner", "member"], () => `${busyUrl}?view=list`, (p) => p.locator("main h1").first(), async (p) => click(p, firstRowMenu(p))],
  ["ws-new", ["owner"], () => busyUrl, (p) => p.locator("main h1").first(), async (p) => click(p, p.getByRole("button", { name: "New", exact: true }))],
  ["ws-more", ["owner"], () => busyUrl, (p) => p.locator("main h1").first(), async (p) => {
    const b = await visibleFirst(p, [p.locator("main").getByRole("button", { name: "More actions", exact: true })]);
    if (!b) return "skip";
    await b.tap().catch(() => b.click());
    await p.waitForTimeout(450);
  }],
  ["ws-share", ["owner"], () => busyUrl, (p) => p.locator("main h1").first(), async (p) => {
    await click(p, p.getByRole("button", { name: /^Share( folder| workspace)?$/ }));
    await p.getByRole("dialog").first().waitFor({ timeout: 8000 });
  }],
  ["ws-newfolder", ["owner"], () => busyUrl, (p) => p.locator("main h1").first(), async (p) => {
    await click(p, p.getByRole("button", { name: "New", exact: true }));
    await click(p, p.getByRole("menuitem", { name: /New folder/ }));
    await p.getByRole("dialog").first().waitFor({ timeout: 8000 });
  }],
  ["upload", ["owner"], () => busyUrl, (p) => p.locator("main h1").first(), async (p) => {
    const input = p.locator('input[type="file"]').first();
    await input.waitFor({ state: "attached", timeout: 8000 });
    await input.setInputFiles([
      { name: "field-notes-from-the-customer-visit.md", mimeType: "text/markdown", buffer: Buffer.from("# Field notes\n\nThe customer wants offline mode.\n") },
      { name: "pricing.html", mimeType: "text/html", buffer: Buffer.from("<!doctype html><title>Pricing</title><h1>Pricing</h1>") },
    ]);
    await p.waitForTimeout(1500);
  }],
  ["folder", ["owner", "member"], () => busyUrl, (p) => p.locator("main h1").first()],
  ["table", ["owner", "member"], () => `${boardUrl}?view=table`, (p) => p.locator("main table, main [role=grid]").first()],
  ["board", ["owner", "member"], () => `${boardUrl}?view=board`, (p) => p.getByRole("list", { name: /Pages by/ }).first()],
  ["settings-account", ["owner"], () => `${APP}/settings/account`, (p) => p.locator("main h1").first()],
  ["settings-workspaces", ["owner"], () => `${APP}/settings/workspaces`, (p) => p.locator("main h1").first()],
  ["settings-people", ["owner", "member"], () => `${APP}/settings/workspaces/${WS}`, (p) => p.locator("main h1").first()],
  ["settings-look", ["owner"], () => `${APP}/settings/workspaces/${WS}?tab=look`, (p) => p.locator("main h1").first()],
  ["settings-advanced", ["owner"], () => `${APP}/settings/workspaces/${WS}?tab=advanced`, (p) => p.locator("main h1").first()],
  ["settings-tokens", ["owner"], () => `${APP}/settings/tokens`, (p) => p.locator("main h1").first()],
  ["settings-connections", ["owner"], () => `${APP}/settings/connections`, (p) => p.locator("main h1").first()],
  ["search", ["owner"], () => `${APP}/search?q=plan`, (p) => p.locator("main h1, main input").first()],
  ["request", ["owner"], () => (X.request ? `${APP}/requests/${X.request}` : null), (p) => p.locator("main h1").first()],
  ["login", ["anon"], () => `${APP}/login`, (p) => p.locator("h1").first()],
  ["auth-modal", ["anon"], () => `${APP}/enterprise`, (p) => p.locator("h1").first(), async (p) => {
    await click(p, p.getByRole("button", { name: /Sign in to create a workspace/ }).or(p.getByRole("link", { name: /Sign in to create a workspace/ })));
    await p.getByRole("dialog").first().waitFor({ timeout: 8000 });
  }],
  ["p2p-send", ["owner", "anon"], () => `${APP}/share`, (p) => p.locator("h1").first()],
  ["p2p-receive", ["anon"], () => `${APP}/share/abcd-efgh-ijkl`, (p) => p.locator("h1, h2").first()],
  ["admin-login", ["anon"], () => `${APP}/admin`, (p) => p.locator("input").first()],
  ["admin", ["admin"], () => `${APP}/admin`, (p) => p.locator("h1").first()],
  ["admin-users", ["admin"], () => `${APP}/admin?tab=users`, (p) => p.locator("h1").first()],
];

/* ── Run ──────────────────────────────────────────────────────────────── */

const browserType = BROWSER === "webkit" ? webkit : chromium;
const browser = await browserType.launch();
const findings = [];
let states = 0;

async function newContext(dev, theme, role) {
  const token = role === "anon" || role === "admin" ? null : T[role];
  const at = role === "admin" ? await admin() : null;
  const c = await browser.newContext({
    viewport: { width: dev.w, height: dev.h },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: theme,
  });
  await c.addInitScript(([t, th, a]) => {
    try {
      if (t) localStorage.setItem("markdrop_token", t);
      else localStorage.removeItem("markdrop_token");
      if (a) localStorage.setItem("markdrop_admin_token", a);
      localStorage.setItem("md_theme", th);
      localStorage.setItem("md_theme_beta", "1");
      localStorage.setItem("md_consent", "denied");
      localStorage.setItem("md_install_dismissed", "1");
    } catch {}
  }, [token, theme, at]);
  const p = await c.newPage();
  p.on("pageerror", (e) => log("  [pageerror]", dev.name, e.message.slice(0, 200)));
  return { c, p };
}

for (const theme of themes) {
  for (const dev of devices) {
    if (theme === "dark" && !DARK_DEVICES.has(dev.name)) continue;
    for (const role of [...roles, "anon", "admin"]) {
      const list = STATES.filter(([name, rs]) => rs.includes(role) && (!ONLY || ONLY.has(name)));
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
          if (action) {
            const r = await action(p, dev);
            if (r === "skip") continue;
          }
          await p.waitForTimeout(250);
          const res = await p.evaluate(measure, { checkTargets: true });
          if (!action || name === "files" || name === "folder") {
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
        // Close whatever is open before the next state.
        await p.keyboard.press("Escape").catch(() => {});
        await p.keyboard.press("Escape").catch(() => {});
      }
      await c.close();
    }
  }
}

// Orientation change: a phone turned sideways and back, and an iPad turned, keep a fitting layout.
if (!ONLY || ONLY.has("rotate")) {
  for (const [a, b] of [[DEVICES[2], DEVICES[4]], [DEVICES[6], DEVICES[7]]]) {
    const { c, p } = await newContext(a, "light", "owner");
    for (const u of [`${APP}/dashboard`, busyUrl, `${boardUrl}?view=board`]) {
      await p.goto(u, { waitUntil: "domcontentloaded" });
      await p.locator("main h1, main [role=list]").first().waitFor({ timeout: 30000 }).catch(() => {});
      await p.waitForTimeout(600);
      for (const d of [b, a]) {
        await p.setViewportSize({ width: d.w, height: d.h });
        await p.waitForTimeout(600);
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
// Group by rule + state + element, listing the devices.
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
  .map((g) => `${g.rule.padEnd(9)} ${g.state.padEnd(20)} ${g.who}  — ${[...g.details].slice(0, 2).join(" | ")}  [${g.where.size}: ${[...g.where].slice(0, 4).join(" ")}${g.where.size > 4 ? " …" : ""}]`);
fs.writeFileSync(path.join(OUT, `findings-${BROWSER}.txt`), lines.join("\n") + "\n");
console.log(`\n${states} states, ${findings.length} findings in ${groups.size} groups (${OUT}/findings-${BROWSER}.txt)`);
const byRule = {};
for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
console.log(byRule);
if (findings.length) process.exit(1);
