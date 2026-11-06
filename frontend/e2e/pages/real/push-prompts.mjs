/**
 * One-tap "turn on notifications" prompts (feat/push-prompts: components/push/usePushPrompt.ts) on the
 * real stack: up.sh with PB_PUSH=1 (a throwaway VAPID pair, the fake push service). The browser's
 * PushManager is stubbed the way push.mjs does it (Playwright's Chromium has no push service).
 *
 *   home       Home shows the card; Turn on subscribes this device (server lists it); the card is gone,
 *              and stays gone on reload
 *   notnow     another device: Not now hides the card for good there (reload, a second tab)
 *   bell       a mention for this person: the bell panel's "Get these on this device" row; Turn on
 *              subscribes; the row and Home's card are gone after
 *   bellnotnow the row's Not now hides it for good on this device (reopen, reload); Home's card stays
 *   quiet      no mention / sign-off in the list (only a share): no row
 *   blocked    notifications blocked for the site: no card, no row (Chromium; Settings explains)
 *   mobile     the card on a phone (390) and a tablet in portrait (820) and landscape (1180): no sideways
 *              scroll, 44 px buttons, inside the viewport; light + dark screenshots
 *
 * Playwright's WebKit can't grant notifications: its permission prompt is answered "Allow" by a stub
 * (as in push.mjs, but kept across reloads). Without a PushManager there the card must stay hidden (checked instead).
 *
 *   PB_PUSH=1 zsh up.sh restart-api, then  [BROWSER=webkit] [ONLY=…] node push-prompts.mjs   (existing seed)
 */
import crypto from "node:crypto";
import { chromium as chromiumType } from "@playwright/test";
import { APP, API, BROWSER, log, fail, seedNow, api, launch, ctx, stepper, shot } from "./lib.mjs";

const S = seedNow();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const ID = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.id]));
const chromium = BROWSER === "chromium";
const browser = chromium ? await chromiumType.launch({ channel: "chromium" }) : await launch();
const { step, results } = stepper(browser);
const run = Date.now().toString(36).slice(-5);
const WHO = "reader"; // Vic, a viewer in the workspace: mentions reach them
const CARD = '[data-testid="push-prompt-home"]';
const NUDGE = '[data-testid="push-prompt-bell"]';

if ((await api("GET", "/__sandbox/fakepush")).status !== 200) fail("the API runs without PB_PUSH=1 (restart it: PB_PUSH=1 zsh up.sh restart-api)");

const b64u = (buf) => Buffer.from(buf).toString("base64url");
function device(name) {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const id = `${run}-${name}-${crypto.randomBytes(3).toString("hex")}`;
  return { id, endpoint: `${API}/__sandbox/fakepush/${id}`, p256dh: b64u(ecdh.getPublicKey()), auth: b64u(crypto.randomBytes(16)) };
}

/** A signed-in context whose PushManager hands out `dev`'s subscription; permission "default" until asked. */
async function pushCtx(who, dev, opts = {}) {
  const { c, p } = await ctx(browser, { token: T[who], ...opts });
  if (!opts.blocked) {
    if (chromium) await c.grantPermissions(["notifications"], { origin: APP }).catch((e) => log(`(grant: ${e.message.slice(0, 80)})`));
    else {
      await c.addInitScript(() => {
        if (!("Notification" in window)) return;
        // Kept across reloads, as Safari keeps a site's permission.
        const K = "md_e2e_notif_perm";
        try {
          Object.defineProperty(Notification, "permission", { get: () => localStorage.getItem(K) || "default", configurable: true });
          Notification.requestPermission = async () => { localStorage.setItem(K, "granted"); return "granted"; };
        } catch {}
      });
    }
  } else {
    await c.addInitScript(() => {
      try { Object.defineProperty(Notification, "permission", { get: () => "denied", configurable: true }); } catch {}
    });
  }
  await c.addInitScript(([endpoint, p256dh, auth]) => {
    if (!("PushManager" in window)) return;
    const KEY = "md_e2e_push_sub";
    const make = (key) => ({
      endpoint, expirationTime: null, options: { applicationServerKey: key, userVisibleOnly: true },
      toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh, auth } }),
      getKey: () => null,
      unsubscribe: async () => { localStorage.removeItem(KEY); return true; },
    });
    PushManager.prototype.subscribe = async function (o) {
      const k = o.applicationServerKey;
      const bytes = Array.from(new Uint8Array(k.buffer ? k.buffer.slice(k.byteOffset, k.byteOffset + k.byteLength) : k));
      localStorage.setItem(KEY, JSON.stringify(bytes));
      return make(new Uint8Array(bytes).buffer);
    };
    PushManager.prototype.getSubscription = async function () {
      const v = localStorage.getItem(KEY);
      return v ? make(new Uint8Array(JSON.parse(v)).buffer) : null;
    };
  }, [dev.endpoint, dev.p256dh, dev.auth]);
  return { c, p };
}

const devices = async (who) => (await api("GET", "/api/v1/push", T[who])).body.devices;
const supported = (p) => p.evaluate(() => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window);

async function home(p) {
  await p.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
  await p.getByTestId("home").waitFor({ timeout: 30000 });
  await p.evaluate(() => navigator.serviceWorker?.ready.then(() => true));
}

/** The card's state after the page's look at this device (GET /push) has settled. */
async function cardShown(p, want) {
  if (want) { await p.locator(CARD).waitFor({ timeout: 15000 }); return; }
  await p.waitForLoadState("networkidle");
  await p.waitForTimeout(800);
  if (await p.locator(CARD).count()) fail("the Home card is showing");
}

async function openBell(p) {
  await p.locator('header button[aria-label^="Notifications"]').first().click();
  await p.locator('[aria-busy="true"][aria-label="Loading notifications"]').waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(400);
}
async function nudgeShown(p, want) {
  if (want) { await p.locator(NUDGE).waitFor({ timeout: 15000 }); return; }
  await p.waitForLoadState("networkidle");
  await p.waitForTimeout(800);
  if (await p.locator(NUDGE).count()) fail("the bell's nudge is showing");
}
async function closeBell(p) {
  await p.keyboard.press("Escape");
  await p.waitForTimeout(300);
}

/** A workspace page where the owner mentions `who` (a bell notification for them). */
async function mention(who, label) {
  const title = `Prompt ${label} ${run}`;
  const r = await api("POST", "/api/v1/pages", T.owner, { title, workspace: S.ws, folder: S.folder, content: "# Plan\n" });
  if (r.status >= 300) fail(`create → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  const slug = r.body.document.slug;
  const u = await api("PUT", `/api/v1/documents/${slug}`, T.owner, {
    title, content: `# Plan\n\nPing :person[${S.users[who].name}]{id="${ID[who]}"} about the ${label} rollout.\n`,
  });
  if (u.status !== 200) fail(`save → ${u.status} ${JSON.stringify(u.body).slice(0, 200)}`);
  const list = (await api("GET", "/api/v1/notifications?limit=20", T[who])).body.items;
  if (!list.some((n) => n.kind === "mention")) fail(`no mention notification for ${who}: ${JSON.stringify(list.map((n) => n.kind))}`);
}

async function clean(who) {
  for (const d of await devices(who)) await api("DELETE", `/api/v1/push/devices/${d.id}`, T[who]);
}

await clean(WHO);
await api("DELETE", "/__sandbox/fakepush");
let webkitNoPush = false;

/* ── home ─────────────────────────────────────────────────────────────── */
await step("home", async () => {
  const { c, p } = await pushCtx(WHO, device("home"));
  await home(p);
  if (!(await supported(p))) {
    webkitNoPush = true;
    await cardShown(p, false);
    log(`${BROWSER} has no PushManager: the card stays hidden (checked)`);
    await c.close();
    return;
  }
  await cardShown(p, true);
  await shot(p, `push-prompt-home-${BROWSER}`);
  await p.locator(CARD).getByRole("button", { name: "Turn on" }).click();
  await p.getByText("Notifications are on for this device.").waitFor({ timeout: 15000 });
  await p.locator(CARD).waitFor({ state: "detached", timeout: 5000 });
  const d = await devices(WHO);
  if (d.length !== 1) fail(`server devices ${d.length}`);
  await home(p);
  await cardShown(p, false);
  await c.close();
});

/* ── notnow ───────────────────────────────────────────────────────────── */
await step("notnow", async () => {
  if (webkitNoPush) return log("skipped (no PushManager)");
  const { c, p } = await pushCtx(WHO, device("notnow"));
  await home(p);
  await cardShown(p, true); // another device of the same person: offered here too
  await p.locator(CARD).getByRole("button", { name: "Not now" }).click();
  await p.locator(CARD).waitFor({ state: "detached", timeout: 5000 });
  if (!(await p.evaluate(() => localStorage.getItem("md_push_prompt_home")))) fail("Not now isn't remembered");
  await home(p);
  await cardShown(p, false);
  const p2 = await c.newPage();
  await home(p2);
  await cardShown(p2, false);
  if ((await devices(WHO)).length !== 1) fail("Not now subscribed something");
  await c.close();
});

/* ── bell ─────────────────────────────────────────────────────────────── */
await step("bell", async () => {
  if (webkitNoPush) return log("skipped (no PushManager)");
  await mention(WHO, "bell");
  const { c, p } = await pushCtx(WHO, device("bell"), { width: 1280, height: 860 });
  await home(p);
  await openBell(p);
  await nudgeShown(p, true);
  await shot(p, `push-prompt-bell-${BROWSER}`);
  await p.locator(NUDGE).getByRole("button", { name: "Turn on" }).click();
  await p.getByText("Notifications are on for this device.").waitFor({ timeout: 15000 });
  await p.locator(NUDGE).waitFor({ state: "detached", timeout: 5000 });
  if ((await devices(WHO)).length !== 2) fail("the bell's Turn on didn't add this device");
  // One look at the device: Home's card went at the same time.
  await closeBell(p);
  await cardShown(p, false);
  await home(p);
  await openBell(p);
  await nudgeShown(p, false);
  await c.close();
});

/* ── bellnotnow ───────────────────────────────────────────────────────── */
await step("bellnotnow", async () => {
  if (webkitNoPush) return log("skipped (no PushManager)");
  const { c, p } = await pushCtx(WHO, device("bellnotnow"), { width: 390, height: 844, mobile: true });
  await home(p);
  await cardShown(p, true);
  await openBell(p); // a phone: the bottom sheet
  await nudgeShown(p, true);
  await shot(p, `push-prompt-bell-phone-${BROWSER}`);
  const x = p.locator(NUDGE).getByRole("button", { name: "Not now" });
  const box = await x.boundingBox();
  if (!box || box.width < 44 || box.height < 44) fail(`Not now is ${JSON.stringify(box)} on a phone`);
  await x.click();
  await p.locator(NUDGE).waitFor({ state: "detached", timeout: 5000 });
  await closeBell(p);
  await openBell(p);
  await nudgeShown(p, false);
  await closeBell(p);
  await home(p);
  await cardShown(p, true); // only the bell's row was dismissed
  await openBell(p);
  await nudgeShown(p, false);
  await c.close();
});

/* ── quiet ────────────────────────────────────────────────────────────── */
await step("quiet", async () => {
  if (webkitNoPush) return log("skipped (no PushManager)");
  // Wes (admin) has no mention or sign-off request in the list (shares at most).
  const list = (await api("GET", "/api/v1/notifications?limit=50", T.admin)).body.items;
  if (list.some((n) => n.kind === "mention" || n.kind === "signoff_requested")) fail("the admin has a mention: pick someone else");
  await clean("admin");
  const { c, p } = await pushCtx("admin", device("quiet"), { width: 1280, height: 860 });
  await home(p);
  await openBell(p);
  await nudgeShown(p, false);
  await c.close();
});

/* ── blocked ──────────────────────────────────────────────────────────── */
if (chromium) {
  await step("blocked", async () => {
    await clean("member");
    await mention("member", "blocked");
    const { c, p } = await pushCtx("member", device("blocked"), { blocked: true, width: 1280, height: 860 });
    await home(p);
    if ((await p.evaluate(() => Notification.permission)) !== "denied") fail("the stub didn't block");
    await cardShown(p, false);
    await openBell(p);
    await nudgeShown(p, false);
    await c.close();
  });
}

/* ── mobile ───────────────────────────────────────────────────────────── */
await step("mobile", async () => {
  if (webkitNoPush) return log("skipped (no PushManager)");
  await clean("owner");
  for (const [w, h] of [[360, 780], [390, 844], [820, 1180], [1180, 820]]) {
    for (const theme of w === 390 || w === 820 ? ["light", "dark"] : ["light"]) {
      const { c, p } = await pushCtx("owner", device(`m${w}${theme}`), { width: w, height: h, mobile: true, theme });
      await home(p);
      await cardShown(p, true);
      const m = await p.evaluate((sel) => {
        const card = document.querySelector(sel);
        const r = card.getBoundingClientRect();
        const btns = [...card.querySelectorAll("button")].map((b) => { const q = b.getBoundingClientRect(); return { t: b.textContent.trim(), w: q.width, h: q.height, l: q.left, r: q.right }; });
        const title = getComputedStyle(card.querySelector("h2")).fontSize;
        return { side: document.documentElement.scrollWidth - window.innerWidth, l: r.left, r: r.right, vw: window.innerWidth, btns, title };
      }, CARD);
      if (m.side > 1) fail(`${w}: scrolls sideways by ${m.side}px`);
      if (m.l < 0 || m.r > m.vw) fail(`${w}: card outside the viewport ${JSON.stringify(m)}`);
      for (const b of m.btns) if (b.h < 44 || b.w < 44 || b.l < 0 || b.r > m.vw) fail(`${w}: button ${JSON.stringify(b)}`);
      if (parseFloat(m.title) < 12) fail(`${w}: title ${m.title}`);
      await p.locator(CARD).scrollIntoViewIfNeeded();
      await shot(p, `push-prompt-home-${w}-${theme}-${BROWSER}`);
      await c.close();
    }
  }
});

await browser.close();
console.log("\n" + results.map(([n, r, ms]) => `${r === "ok" ? "✓" : "✗"} ${n.padEnd(11)} ${r === "ok" ? "" : r} (${(ms / 1000).toFixed(1)} s)`).join("\n"));
process.exit(results.some(([, r]) => r !== "ok") ? 1 : 0);
