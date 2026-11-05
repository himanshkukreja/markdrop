/**
 * Push notifications (lib/push.ts, the service worker in lib/pwaWorker.ts, backend services/push.py)
 * on the real stack: up.sh with PB_PUSH=1 (a throwaway VAPID pair, and a fake push service inside the
 * sandbox API that keeps what it was sent, still encrypted). The browser's PushManager is stubbed
 * (Playwright's Chromium has no push service) with a subscription whose keys this script holds, so it
 * decrypts exactly what a phone would get; the service worker then receives it for real through
 * DevTools (ServiceWorker.deliverPushMessage) and shows the notification.
 *
 *   settings   Settings › Account: "Turn on" (after the click) → this device listed, kinds shown
 *   deliver    a mention → one encrypted message: the bell's sentence, the block's link, the read link;
 *              nothing else; the worker shows it (title, body, tag) and the open window's bell updates
 *   click      the notification's click: the open Markdrop window goes to the page at the block
 *              (no reload) and the notification is marked read
 *   privacy    access gone before sending → nothing is sent at all
 *   prefs      Mentions switched off → a mention sends nothing
 *   gone       the push service says 410 → the device is forgotten; the card offers "Turn on" again
 *   signout    signing out removes this browser's device
 *   blocked    notifications blocked for the site → the card explains, no button
 *   ios        an iPhone in a Safari tab (no PushManager): "install the app first" + Install app (390 px)
 *
 *   PB_PUSH=1 zsh up.sh restart-api, then  [BROWSER=webkit] [ONLY=…] node push.mjs   (existing seed)
 */
import crypto from "node:crypto";
import { chromium as chromiumType } from "@playwright/test";
import { APP, API, BROWSER, log, fail, seedNow, api, launch, ctx, stepper, shot } from "./lib.mjs";

const S = seedNow();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const ID = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.id]));
const chromium = BROWSER === "chromium";
// Chromium's new headless mode: the old headless shell reports Notification.permission "denied"
// whatever was granted, and has no notification centre for showNotification.
const browser = chromium ? await chromiumType.launch({ channel: "chromium" }) : await launch();
const { step, results } = stepper(browser);
const run = Date.now().toString(36).slice(-5);
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

if ((await api("GET", "/__sandbox/fakepush")).status !== 200) fail("the API runs without PB_PUSH=1 (restart it: PB_PUSH=1 zsh up.sh restart-api)");

/* ── A device: its keys (held here), and the stubbed PushManager in its pages ── */

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();

function device(name) {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const id = `${run}-${name}-${crypto.randomBytes(3).toString("hex")}`;
  return { id, ecdh, auth, endpoint: `${API}/__sandbox/fakepush/${id}`, p256dh: b64u(ecdh.getPublicKey()), authB64: b64u(auth) };
}

/** RFC 8291, the browser's side (what services/webpush.decrypt does in Python). */
function decrypt(dev, body) {
  const buf = Buffer.from(body, "base64");
  const salt = buf.subarray(0, 16);
  const idlen = buf[20];
  const asPub = buf.subarray(21, 21 + idlen);
  const data = buf.subarray(21 + idlen);
  const secret = dev.ecdh.computeSecret(asPub);
  const ikm = hmac(hmac(dev.auth, secret), Buffer.concat([Buffer.from("WebPush: info\0"), dev.ecdh.getPublicKey(), asPub, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\u0001")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\u0001")).subarray(0, 12);
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end--;
  if (plain[end - 1] !== 2) fail("not a final record");
  return JSON.parse(plain.subarray(0, end - 1).toString("utf8"));
}

/** A signed-in context whose PushManager hands out `dev`'s subscription (Chromium has no push service here). */
async function pushCtx(who, dev, opts = {}) {
  const { c, p } = await ctx(browser, { token: T[who], ...opts });
  if (opts.grant !== false) await c.grantPermissions(["notifications"], { origin: APP }).catch((e) => log(`(grant: ${e.message.slice(0, 80)})`));
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
  }, [dev.endpoint, dev.p256dh, dev.authB64]);
  return { c, p };
}

const received = async (dev) => (await api("GET", "/__sandbox/fakepush")).body.received.filter((r) => r.id === dev.id);
const flush = async () => (await api("POST", "/__sandbox/push/flush")).body;
const devices = async (who) => (await api("GET", "/api/v1/push", T[who])).body.devices;

async function openSettings(p) {
  await p.goto(`${APP}/settings/account#notifications`, { waitUntil: "networkidle" });
  await p.locator('[data-testid="push-card"]').waitFor({ timeout: 30000 });
  await p.evaluate(() => navigator.serviceWorker.ready.then(() => true));
}

async function turnOn(p) {
  await p.getByRole("button", { name: "Turn on" }).click();
  await p.getByText("Notifications are on for this device.").waitFor({ timeout: 15000 });
  await p.locator('[data-testid="push-devices"] li').first().waitFor({ timeout: 10000 });
}

/** A page in the workspace that mentions `who` at a block (created, then saved, as the owner). */
async function mentionPage(who, label) {
  const title = `Push ${label} ${run}`;
  const r = await api("POST", "/api/v1/pages", T.owner, { title, workspace: S.ws, folder: S.folder, content: "# Plan\n" });
  if (r.status >= 300) fail(`create → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  const slug = r.body.document.slug;
  const block = `b-${crypto.randomBytes(3).toString("hex")}`;
  const name = S.users[who].name;
  const u = await api("PUT", `/api/v1/documents/${slug}`, T.owner, {
    title, content: `# Plan\n\nPing :person[${name}]{id="${ID[who]}"} about the ${label} rollout. {#${block}}\n`,
  });
  if (u.status !== 200) fail(`save → ${u.status} ${JSON.stringify(u.body).slice(0, 200)}`);
  return { slug, block, title };
}

/** The page is under the worker (the first load registers it; claim() or a reload takes over). */
async function controlled(p) {
  await p.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await p.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 5000 }).catch(() => {});
  if (!(await p.evaluate(() => !!navigator.serviceWorker.controller))) {
    await p.reload({ waitUntil: "networkidle" });
    await p.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
  }
}

/** The worker's registration id for the app (DevTools), to deliver a push message to it. */
async function registrationId(c, p) {
  const cdp = await c.newCDPSession(p);
  const regs = new Map();
  cdp.on("ServiceWorker.workerRegistrationUpdated", (e) => e.registrations.forEach((r) => regs.set(r.scopeURL, r.registrationId)));
  await cdp.send("ServiceWorker.enable");
  for (let i = 0; i < 40 && !regs.get(`${APP}/`); i++) await p.waitForTimeout(100);
  const id = regs.get(`${APP}/`);
  if (!id) fail(`no worker registration for ${APP}/: ${JSON.stringify([...regs])}`);
  return { cdp, id };
}

const notificationsShown = (sw) =>
  sw.evaluate(() => self.registration.getNotifications().then((ns) => ns.map((n) => ({ title: n.title, body: n.body, tag: n.tag, data: n.data }))));

async function swOf(c) {
  for (let i = 0; i < 50; i++) {
    const w = c.serviceWorkers().find((s) => s.url().endsWith("/sw.js"));
    if (w) return w;
    await new Promise((r) => setTimeout(r, 100));
  }
  fail("no service worker in the context");
}

await api("DELETE", "/__sandbox/fakepush");
for (const d of await devices("member")) await api("DELETE", `/api/v1/push/devices/${d.id}`, T.member);
await api("PATCH", "/api/v1/push/prefs", T.member, { mention: true, signoff_requested: true, shared: true, access_request: true });

/* ── settings ─────────────────────────────────────────────────────────── */
const PHONE = device("phone");
await step("settings", async () => {
  const { c, p } = await pushCtx("member", PHONE);
  await openSettings(p);
  const supported = await p.evaluate(() => "PushManager" in window && "Notification" in window);
  if (!supported) {
    // Playwright's WebKit without Web Push: the card says so and offers nothing to click.
    await p.getByText("This browser can't show notifications from websites.").waitFor({ timeout: 10000 });
    await shot(p, `push-unsupported-${BROWSER}`);
    log("this WebKit has no PushManager: unsupported state checked");
    await c.close();
    return;
  }
  await p.getByText("Off. Your browser asks for permission when you turn them on.").waitFor();
  await turnOn(p);
  const list = await p.locator('[data-testid="push-devices"] li').allInnerTexts();
  if (list.length !== 1 || !/This device/.test(list[0])) fail(`devices: ${JSON.stringify(list)}`);
  for (const k of ["Mentions", "Sign-off requests", "Shared with you", "Access requests"]) {
    if (!(await p.getByRole("switch", { name: k, exact: true }).count())) fail(`no ${k} switch`);
  }
  await p.getByRole("button", { name: "Send a test" }).waitFor();
  const d = await devices("member");
  if (d.length !== 1 || !d[0].label) fail(`server devices ${JSON.stringify(d)}`);
  log("device", d[0].label);
  await p.locator("#notifications").scrollIntoViewIfNeeded();
  await shot(p, `push-settings-on-${BROWSER}`);
  // Send a test: the fake push service gets one, readable only with this device's keys.
  await p.getByRole("button", { name: "Send a test" }).click();
  await p.getByText("Sent. It should arrive in a few seconds.").waitFor({ timeout: 10000 });
  const got = await received(PHONE);
  const msg = decrypt(PHONE, got.at(-1).body);
  if (msg.title !== "Notifications are on" || msg.url !== "/settings/account#push") fail(`test message ${JSON.stringify(msg)}`);
  if (got.at(-1).headers["content-encoding"] !== "aes128gcm" || !/^vapid t=/.test(got.at(-1).headers.authorization)) fail(`headers ${JSON.stringify(got.at(-1).headers)}`);
  await c.close();
});

/* ── deliver + click ──────────────────────────────────────────────────── */
let delivered = null;
if (chromium) {
  await step("deliver", async () => {
    if (!(await devices("member")).length) fail("run settings first (no device)");
    const before = (await received(PHONE)).length;
    const m = await mentionPage("member", "deliver");
    const out = await flush();
    if (out.sent !== 1) fail(`flush ${JSON.stringify(out)}`);
    const got = await received(PHONE);
    if (got.length !== before + 1) fail(`received ${got.length - before}`);
    const msg = decrypt(PHONE, got.at(-1).body);
    log("message", JSON.stringify(msg).slice(0, 300));
    const want = `${S.users.owner.name} mentioned you in “${m.title}”`;
    if (msg.title !== want) fail(`title ${msg.title} ≠ ${want}`);
    if (msg.url !== `/${m.slug}#${m.block}`) fail(`url ${msg.url}`);
    if (!/about the deliver rollout/.test(msg.body)) fail(`body ${msg.body}`);
    if (!msg.read?.startsWith(`${API}/api/v1/push/read?t=`)) fail(`read ${msg.read}`);
    const keys = Object.keys(msg).sort().join(",");
    if (keys !== "body,count,ids,kind,read,tag,title,ts,url,v") fail(`keys ${keys}`);
    if (Buffer.from(got.at(-1).body, "base64").includes(Buffer.from(m.title))) fail("title readable by the push service");
    for (const leak of [S.users.owner.email, S.users.member.email, "edit_secret"]) if (JSON.stringify(msg).includes(leak)) fail(`leaks ${leak}`);
    delivered = { msg, ...m };
  });

  await step("click", async () => {
    if (!delivered) fail("needs deliver");
    const { c, p } = await pushCtx("member", PHONE);
    await p.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
    await controlled(p);
    const bell = p.locator('header button[aria-label^="Notifications"]').first();
    await bell.waitFor({ timeout: 20000 });
    const unreadBefore = (await api("GET", "/api/v1/notifications/unread-count", T.member)).body.unread_count;
    if (unreadBefore < 1) fail(`unread ${unreadBefore}`);
    // The push arrives: the worker shows it.
    const { cdp, id } = await registrationId(c, p);
    await cdp.send("ServiceWorker.deliverPushMessage", { origin: APP, registrationId: id, data: JSON.stringify(delivered.msg) });
    const sw = await swOf(c);
    let shown = [];
    for (let i = 0; i < 50 && !shown.length; i++) {
      shown = await notificationsShown(sw);
      if (!shown.length) await p.waitForTimeout(100);
    }
    log("shown", JSON.stringify(shown).slice(0, 300));
    const n = shown.find((x) => x.tag === delivered.msg.tag);
    if (!n) fail(`not shown: ${JSON.stringify(shown)}`);
    if (n.title !== delivered.msg.title || n.body !== delivered.msg.body || n.data.url !== delivered.msg.url) fail(`shown ${JSON.stringify(n)}`);
    // The bell heard about it (MD_PUSH) and shows the count.
    await p.waitForFunction(() => /unread/.test(document.querySelector('header button[aria-label^="Notifications"]')?.getAttribute("aria-label") || ""), null, { timeout: 10000 });
    // A second push for the same page replaces it (one per page).
    await cdp.send("ServiceWorker.deliverPushMessage", { origin: APP, registrationId: id, data: JSON.stringify({ ...delivered.msg, title: "Two updates" }) });
    await p.waitForTimeout(800);
    const again = (await notificationsShown(sw)).filter((x) => x.tag === delivered.msg.tag);
    if (again.length !== 1 || again[0].title !== "Two updates") fail(`same tag stacked: ${JSON.stringify(again)}`);
    // Click: this window goes to the page at the block, without a reload, and it's marked read.
    await p.evaluate(() => { window.__mdNoReload = true; });
    await sw.evaluate(async (tag) => {
      const [x] = await self.registration.getNotifications({ tag });
      x.close();
      await self.__mdPush.openFromNotification(x.data);
    }, delivered.msg.tag);
    await p.waitForURL((u) => u.pathname === `/${delivered.slug}` && u.hash === `#${delivered.block}`, { timeout: 20000 });
    if (!(await p.evaluate(() => window.__mdNoReload === true))) fail("the page reloaded instead of navigating");
    // The page scrolled to the block and flashed it (components/pages/anchors.ts).
    await p.locator(`[data-bid="${delivered.block}"]`).first().waitFor({ timeout: 20000 });
    await p.waitForFunction((b) => {
      const el = document.querySelector(`[data-bid="${b}"]`);
      const r = el?.getBoundingClientRect();
      return !!r && r.top >= 0 && r.bottom <= window.innerHeight;
    }, delivered.block, { timeout: 10000 });
    await shot(p, "push-clicked-page");
    const ids = delivered.msg.ids;
    let read = false;
    for (let i = 0; i < 30 && !read; i++) {
      const list = (await api("GET", "/api/v1/notifications?limit=50", T.member)).body.items;
      read = list.filter((x) => ids.includes(x.id)).every((x) => x.read);
      if (!read) await p.waitForTimeout(200);
    }
    if (!read) fail("the clicked notification isn't marked read");
    if ((await notificationsShown(sw)).some((x) => x.tag === delivered.msg.tag)) fail("the notification is still showing");
    await c.close();
  });
}

/* ── privacy / prefs / gone ───────────────────────────────────────────── */
await step("privacy", async () => {
  if (!(await devices("member")).length) fail("needs a device (settings)");
  const before = (await received(PHONE)).length;
  const m = await mentionPage("member", "secret merger");
  const lv = await api("PUT", `/api/v1/documents/${m.slug}/access/level`, T.owner, { level: "private" });
  if (lv.status !== 204) fail(`level → ${lv.status}`);
  const out = await flush();
  if (out.no_access !== 1 || out.sent) fail(`flush ${JSON.stringify(out)}`);
  if ((await received(PHONE)).length !== before) fail("something was sent about a page they can't open");
});

await step("prefs", async () => {
  if (!(await devices("member")).length) fail("needs a device (settings)");
  const { c, p } = await pushCtx("member", PHONE);
  await openSettings(p);
  const sw = p.getByRole("switch", { name: "Mentions", exact: true });
  if (!(await sw.isChecked())) fail("Mentions not on");
  const toggle = () => sw.evaluate((el) => el.click()); // the input sits under the switch's track
  await toggle();
  for (let i = 0; i < 30 && (await api("GET", "/api/v1/push", T.member)).body.prefs.mention !== false; i++) await p.waitForTimeout(200);
  if ((await api("GET", "/api/v1/push", T.member)).body.prefs.mention !== false) fail("Mentions didn't turn off");
  const before = (await received(PHONE)).length;
  await mentionPage("member", "quiet");
  const out = await flush();
  if (out.sent) fail(`sent with Mentions off: ${JSON.stringify(out)}`);
  if ((await received(PHONE)).length !== before) fail("a push went with Mentions off");
  await toggle();
  for (let i = 0; i < 30 && (await api("GET", "/api/v1/push", T.member)).body.prefs.mention !== true; i++) await p.waitForTimeout(200);
  if ((await api("GET", "/api/v1/push", T.member)).body.prefs.mention !== true) fail("Mentions didn't turn back on");
  await c.close();
});

await step("gone", async () => {
  if (!(await devices("member")).length) fail("needs a device (settings)");
  await api("POST", "/__sandbox/fakepush/answer", null, { status: 410 });
  await mentionPage("member", "gone");
  await flush();
  await api("DELETE", "/__sandbox/fakepush");
  if ((await devices("member")).length) fail("a 410 device is still listed");
  const { c, p } = await pushCtx("member", PHONE);
  await openSettings(p);
  // The browser still holds its (dead) subscription; the server doesn't: the card offers Turn on.
  await p.getByRole("button", { name: "Turn on" }).waitFor({ timeout: 10000 });
  if (await p.locator('[data-testid="push-devices"]').count()) fail("devices list shown with none");
  await turnOn(p);
  if ((await devices("member")).length !== 1) fail("turning on again didn't add it");
  await c.close();
});

await step("signout", async () => {
  const dev = device("laptop");
  const { c, p } = await pushCtx("admin", dev);
  await openSettings(p);
  if (!(await p.evaluate(() => "PushManager" in window))) { log("no PushManager here: skipped"); await c.close(); return; }
  await turnOn(p);
  if ((await devices("admin")).length !== 1) fail("admin device not added");
  await p.getByRole("button", { name: "Sign out on this device" }).click();
  await p.waitForURL((u) => u.pathname === "/", { timeout: 20000 });
  const left = (await api("GET", "/api/v1/push", T.admin)).body.devices;
  if (left.length) fail(`signing out left ${left.length} device(s)`);
  if (await p.evaluate(() => localStorage.getItem("md_e2e_push_sub"))) fail("the browser kept its subscription");
  await c.close();
});

if (chromium) {
  await step("blocked", async () => {
    const { c, p } = await pushCtx("reader", device("blocked"), { grant: false });
    await c.addInitScript(() => {
      try { Object.defineProperty(Notification, "permission", { get: () => "denied" }); } catch {}
    });
    await openSettings(p);
    await p.getByText("Blocked in this browser.", { exact: false }).waitFor({ timeout: 10000 });
    if (await p.getByRole("button", { name: "Turn on" }).count()) fail("Turn on offered while blocked");
    await c.close();
  });
}

/* ── ios ──────────────────────────────────────────────────────────────── */
await step("ios", async () => {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, userAgent: IPHONE_UA, hasTouch: true, colorScheme: "light", ...(chromium ? { isMobile: true } : {}) });
  await c.addInitScript((t) => {
    try {
      localStorage.setItem("markdrop_token", t);
      localStorage.setItem("md_theme", "light");
      localStorage.setItem("md_consent", "denied");
    } catch {}
    // Safari in a tab on iOS: no PushManager (it exists only in the installed app).
    try { delete window.PushManager; } catch {}
  }, T.reader);
  const p = await c.newPage();
  await p.goto(`${APP}/settings/account#notifications`, { waitUntil: "networkidle" });
  await p.locator('[data-testid="push-card"]').waitFor({ timeout: 30000 });
  await p.getByText("On iPhone and iPad, notifications work in the installed app.", { exact: false }).waitFor({ timeout: 10000 });
  const install = p.locator('[data-testid="push-this-device"]').getByRole("button", { name: "Install app" });
  await install.waitFor({ timeout: 10000 });
  if (await p.getByRole("button", { name: "Turn on" }).count()) fail("Turn on offered in a Safari tab");
  const sideways = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (sideways > 1) fail(`scrolls sideways by ${sideways}px`);
  await p.locator("#notifications").scrollIntoViewIfNeeded();
  await shot(p, `push-ios-tab-${BROWSER}`);
  await install.click();
  await p.locator('[data-testid="pwa-ios-steps"]').waitFor({ timeout: 10000 });
  await c.close();
});

await browser.close();
console.log("\n" + results.map(([n, r, ms]) => `${r === "ok" ? "✓" : "✗"} ${n.padEnd(10)} ${r === "ok" ? "" : r} (${(ms / 1000).toFixed(1)} s)`).join("\n"));
process.exit(results.some(([, r]) => r !== "ok") ? 1 : 0);
