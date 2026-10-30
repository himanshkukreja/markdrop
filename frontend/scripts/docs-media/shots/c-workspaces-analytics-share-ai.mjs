/**
 * Docs media, group C: /workspaces/**, /analytics/**, /share/** (peer to peer) and the browser
 * parts of /ai/** (the OAuth approval screen, Connected apps, the docs site's Copy page menu and
 * Ask AI). Shot format: ../shots.mjs. Extra seed data: ../seed_extra_c.py (run it after seed.py).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEDIA = path.resolve(HERE, "..");
const REPO = path.resolve(MEDIA, "../../..");
const STACK_ID = Number(process.env.STACK_ID || 0);
const DATA = path.join(process.env.DOCS_MEDIA_DATA || path.join(MEDIA, ".data"), STACK_ID ? String(STACK_ID) : "");
const PY = process.env.DOCS_MEDIA_PYTHON || path.join(REPO, "backend/.venv/bin/python");
const EXTRA = path.join(MEDIA, "seed_extra_c.py");
const FIXTURES = path.join(MEDIA, ".data/fixtures");

/** Ids seed_extra_c.py adds (it runs seed_extra_c.py once when they're missing). */
function fxC() {
  const file = path.join(DATA, "fixtures_c.json");
  if (!existsSync(file)) extra();
  return JSON.parse(readFileSync(file, "utf8"));
}

function extra(...args) {
  const r = spawnSync(PY, [EXTRA, ...args], { env: { ...process.env, STACK_ID: String(STACK_ID) }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`seed_extra_c.py ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** Calls the sandbox API as a demo user. */
async function api(h, method, p, body, who = "riya") {
  const { token } = await h.sandbox("/__sandbox/mint", { email: h.fx.users[who].email });
  const res = await fetch(`${h.API}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const ws = (fx) => fx.workspace.id;
/** The first visible element with this text. */
const vis = (h, text) => h.page.getByText(text).filter({ visible: true }).first();
const folder = (fx, name) => fx.workspace.folders[name];
const settle = async (h, ms = 600) => {
  await h.settle(ms);
  await h.page.mouse.move(5, 5);
};
/** Mark an element (found in the page) so a crop can use it as a selector. */
async function mark(h, name, fn, arg) {
  const handle = await h.page.evaluateHandle(fn, arg);
  const el = handle.asElement();
  if (!el) throw new Error(`mark ${name}: not found`);
  await el.evaluate((e, n) => e.setAttribute("data-mdcap", n), name);
  return `[data-mdcap="${name}"]`;
}
/** The nearest card/section around the element matching a text. */
const cardOf = (text) => (args) => {
  const [t, s = "section, .md-card"] = args;
  const all = [...document.querySelectorAll("h1, h2, h3, h4")].filter((e) => e.textContent.trim() === t);
  return all.length ? all[0].closest(s) : null;
};

/** The seeded domain state (docs.acme.com live + default, help.acme.com awaiting DNS). */
async function restoreDomains(h) {
  const id = ws(h.fx);
  await h.sandbox("/__sandbox/domains/reset", { workspace_id: id, keep: [] });
  await h.sandbox("/__sandbox/domain", { workspace_id: id, host: "docs.acme.com", primary: true });
  await h.sandbox("/__sandbox/domain", { workspace_id: id, host: "help.acme.com", pending: true });
}

// ── Live presence: seed_extra_c.py --live in the background ───────────────────

let liveProc = null;
async function startLive(seconds = 240) {
  await stopLive();
  liveProc = spawn(PY, [EXTRA, "--live", String(seconds)], { env: { ...process.env, STACK_ID: String(STACK_ID) } });
  await new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`live simulator not ready: ${out}`)), 30_000);
    liveProc.stdout.on("data", (d) => {
      out += d;
      if (out.includes("live: ready")) {
        clearTimeout(t);
        resolve();
      }
    });
    liveProc.stderr.on("data", (d) => (out += d));
    liveProc.on("exit", (c) => reject(new Error(`live simulator exited ${c}: ${out}`)));
  });
}
async function stopLive() {
  if (!liveProc) return;
  const p = liveProc;
  liveProc = null;
  if (p.exitCode != null) return;
  await new Promise((r) => {
    p.on("exit", r);
    p.kill("SIGTERM"); // sends each visitor's final beacon, so nobody lingers on the board
    setTimeout(r, 5000);
  });
}

// ── P2P: receivers in their own browser contexts ──────────────────────────────

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/**
 * In the sender's page: pace each data channel at its own rate (bytes per second, in the order
 * the channels open), so a local transfer moves like one over a real network and the People
 * list shows progress. The page already waits while `bufferedAmount` is high; this adds a
 * virtual backlog that drains at the channel's rate.
 */
function paceChannels(rates) {
  let n = 0;
  const state = new WeakMap();
  const st = (ch) => {
    let s = state.get(ch);
    if (!s) state.set(ch, (s = { rate: rates[Math.min(n++, rates.length - 1)], backlog: 0, at: performance.now() }));
    const now = performance.now();
    s.backlog = Math.max(0, s.backlog - ((now - s.at) / 1000) * s.rate);
    s.at = now;
    return s;
  };
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (data) {
    const size = data?.byteLength ?? data?.size ?? 0;
    if (size > 1024) st(this).backlog += size;
    return send.call(this, data);
  };
  const desc = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, "bufferedAmount");
  Object.defineProperty(RTCDataChannel.prototype, "bufferedAmount", {
    configurable: true,
    get() { return desc.get.call(this) + Math.round(st(this).backlog); },
  });
}

const extraContexts = [];
async function newContext(h, opts, init) {
  const ctx = await h.context.browser().newContext({ locale: "en-US", ...opts });
  await ctx.route("**/*", (route) => {
    const u = new URL(route.request().url());
    return !/^https?:$/.test(u.protocol) || ["localhost", "127.0.0.1"].includes(u.hostname) ? route.continue() : route.abort();
  });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("md_consent", "denied");
    } catch {}
  });
  if (init) await ctx.addInitScript(...init);
  extraContexts.push(ctx);
  return ctx;
}
async function closeContexts() {
  for (const c of extraContexts.splice(0)) await c.close().catch(() => {});
}

const pdfBytes = (size) => {
  const pdf = readFileSync(path.join(FIXTURES, "q3-board-deck-v1.pdf"));
  return size > pdf.length ? Buffer.concat([pdf, Buffer.alloc(size - pdf.length)]) : pdf;
};
const NOTES = "Demo notes — Thursday\n\n1. Open on the Q3 dashboard\n2. Show the new alert rules\n3. Workflows beta: Slack approvals\n4. Questions\n".repeat(12);

/** The share link the sender's page shows (http://localhost:<port>/share/<id>). */
async function shareLink(page) {
  await page.getByRole("button", { name: "Copy link" }).first().waitFor({ timeout: 30_000 });
  const href = await page.evaluate(() => {
    const re = /\/share\/[A-Za-z0-9_-]{6,}/;
    for (const el of document.querySelectorAll("input, a, code, span")) {
      const v = el.value || el.getAttribute("href") || el.textContent || "";
      const m = v.match(re);
      if (m) return m[0];
    }
    return null;
  });
  if (!href) throw new Error("no share link on the page");
  return href;
}

/** The share link field is filled after the page's own scrub ran: show it as markdrop.in too. */
async function scrubLinkField(page) {
  await page.evaluate(() => {
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    const fix = (v) => String(v).replace(/^(https?:\/\/)?localhost:\d+/, "markdrop.in");
    for (const el of document.querySelectorAll("input")) {
      if (!/localhost:\d+/.test(el.value)) continue;
      // React writes the value again on every render: keep it rewritten.
      Object.defineProperty(el, "value", {
        configurable: true,
        get() { return desc.get.call(this); },
        set(v) { desc.set.call(this, fix(v)); },
      });
      el.value = desc.get.call(el);
    }
  });
}


// ── The send-files video: a laptop and a phone side by side ───────────────────

const FFMPEG = process.env.FFMPEG || (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg");

/** Three holiday "photos" (rendered once, ~0.6–1.3 MB JPEGs at 4032×3024). */
function ensurePhotos() {
  const dir = path.join(DATA, "c-photos");
  mkdirSync(dir, { recursive: true });
  const sun = "lt(hypot(X-0.6*W\\,Y-0.56*H)\\,0.065*W)";
  const glint = "(gte(Y\\,0.62*H)*lt(abs(X-0.6*W)\\,0.045*W*(1-(Y-0.62*H)/(0.38*H)))*(0.6+0.4*sin(Y/4)))";
  const ridge = "lt(Y,H*(0.5+0.1*sin(X/W*7)+0.04*sin(X/W*29)))";
  const photos = {
    "IMG_2041.JPG": [`geq=r='if(${sun},255,if(lt(Y,0.62*H),40+210*pow(Y/(0.62*H),1.6),25+150*${glint}))':g='if(${sun},215,if(lt(Y,0.62*H),35+110*pow(Y/(0.62*H),1.8),45+110*${glint}))':b='if(${sun},150,if(lt(Y,0.62*H),105-25*Y/(0.62*H),85+5*sin(Y/3)))'`, 6],
    "IMG_2042.JPG": [`geq=r='if(${ridge},120+100*Y/H,if(lt(Y,0.78*H),62+18*Y/H,105))':g='if(${ridge},170+70*Y/H,if(lt(Y,0.78*H),82+20*Y/H,148))':b='if(${ridge},232,if(lt(Y,0.78*H),92,68))'`, 10],
    "IMG_2043.JPG": [`geq=r='if(lt(Y,0.45*H),110+90*Y/(0.45*H),if(lt(Y,0.66*H),30+40*(Y-0.45*H)/(0.21*H),232-12*Y/H))':g='if(lt(Y,0.45*H),180+50*Y/(0.45*H),if(lt(Y,0.66*H),140+40*(Y-0.45*H)/(0.21*H),208-12*Y/H))':b='if(lt(Y,0.45*H),240,if(lt(Y,0.66*H),170+8*sin(X/11+Y/5),172-12*Y/H))'`, 12],
  };
  for (const [name, [geq, noise]] of Object.entries(photos)) {
    const out = path.join(dir, name);
    if (existsSync(out)) continue;
    const r = spawnSync(FFMPEG, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=black:s=2016x1512", "-vf",
      `${geq},noise=alls=${noise}:allf=t,gblur=sigma=1.2,scale=4032:3024`, "-frames:v", "1", "-q:v", "2", out]);
    if (r.status !== 0) throw new Error(`ffmpeg photo ${name}: ${r.stderr}`);
  }
  return Object.keys(photos).map((n) => path.join(dir, n));
}

/** In every frame of the stage: the frame named "phone" is an iPhone, the "laptop" sends at a home-broadband pace. */
function stageFrames({ ua, pace }) {
  // The share link field reads markdrop.in, like the rest of the scrubbed page.
  const val = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  Object.defineProperty(HTMLInputElement.prototype, "value", {
    configurable: true,
    get() { return val.get.call(this); },
    set(v) { val.set.call(this, typeof v === "string" ? v.replace(/^(https?:\/\/)?localhost:\d+/, "markdrop.in") : v); },
  });
  if (window.name === "phone") {
    Object.defineProperty(Navigator.prototype, "userAgent", { get: () => ua, configurable: true });
    Object.defineProperty(Navigator.prototype, "platform", { get: () => "iPhone", configurable: true });
    Object.defineProperty(Navigator.prototype, "maxTouchPoints", { get: () => 5, configurable: true });
    // The share sheet: "Save Image" for each photo, as a person would tap it.
    navigator.share = () => new Promise((r) => setTimeout(r, 900));
    navigator.canShare = () => true;
  }
  if (window.name === "laptop") {
    const state = new WeakMap();
    const st = (ch) => {
      let s = state.get(ch);
      if (!s) state.set(ch, (s = { backlog: 0, at: performance.now() }));
      const now = performance.now();
      s.backlog = Math.max(0, s.backlog - ((now - s.at) / 1000) * pace);
      s.at = now;
      return s;
    };
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (data) {
      const size = data?.byteLength ?? data?.size ?? 0;
      if (size > 1024) st(this).backlog += size;
      return send.call(this, data);
    };
    // The page pauses above 8 MB buffered and resumes at 2 MB: scale the backlog so that
    // a third of a second of it reads as "full", which holds small files to the pace too.
    const k = (8 * 1024 * 1024) / (pace * 0.3);
    const desc = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, "bufferedAmount");
    Object.defineProperty(RTCDataChannel.prototype, "bufferedAmount", {
      configurable: true,
      get() { return desc.get.call(this) + Math.round(st(this).backlog * k); },
    });
  }
}

const STAGE_SCALE = 0.78;
const STAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Send</title><style>
  html,body{margin:0;height:100%;overflow:hidden;font-family:Manrope,-apple-system,system-ui,sans-serif}
  body{background:radial-gradient(1200px 700px at 30% 20%,#f4f6fb,#e3e8f1)}
  .win{position:absolute;left:40px;top:38px;width:998px;border-radius:14px;overflow:hidden;background:#fff;
    box-shadow:0 30px 60px -20px rgba(15,23,42,.35),0 0 0 1px rgba(15,23,42,.08)}
  .bar{height:34px;background:#eef1f6;display:flex;align-items:center;gap:7px;padding:0 12px;border-bottom:1px solid #dde2ea}
  .dot{width:11px;height:11px;border-radius:50%;background:#d4d8e0}
  .url{margin-left:14px;flex:1;max-width:420px;height:22px;border-radius:7px;background:#fff;color:#475569;font-size:12px;
    display:flex;align-items:center;padding:0 10px;letter-spacing:.01em}
  .frame{position:relative;width:998px;height:624px;overflow:hidden}
  .frame iframe,.screen iframe{border:0;transform-origin:0 0;transform:scale(${STAGE_SCALE});position:absolute;left:0;top:0}
  #laptop{width:1280px;height:800px}
  .phone{position:absolute;left:1088px;top:26px;width:304px;height:658px;border-radius:46px;background:#0b0f19;padding:9px;
    box-shadow:0 30px 60px -20px rgba(15,23,42,.45)}
  .screen{position:relative;width:304px;height:658px;border-radius:38px;overflow:hidden;background:#000}
  #phone{width:390px;height:844px}
  .cam{position:absolute;inset:0;background:linear-gradient(#2a2f3a,#11141b);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;transition:opacity .4s}
  .finder{width:180px;height:180px;border-radius:22px;position:relative;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.06)}
  .finder:before,.finder:after{content:"";position:absolute;inset:-6px;border:3px solid #ffd60a;border-radius:24px;clip-path:polygon(0 0,30% 0,30% 6%,6% 6%,6% 30%,0 30%,0 70%,6% 70%,6% 94%,30% 94%,30% 100%,70% 100%,70% 94%,94% 94%,94% 70%,100% 70%,100% 30%,94% 30%,94% 6%,70% 6%,70% 0,100% 0,100% 100%,0 100%)}
  .finder .qr{width:150px;height:150px;background:transparent;border-radius:8px;padding:8px;box-sizing:border-box;color:#000;transform:rotate(-4deg)}
  .finder .qr svg{width:100%;height:100%}
  .finder .qr.on{background:#fff}
  .pill{opacity:0;transform:translateY(8px);transition:all .35s;background:#ffd60a;color:#111;font-weight:700;font-size:13px;
    border-radius:999px;padding:8px 14px;display:flex;align-items:center;gap:6px}
  .pill.on{opacity:1;transform:none}
  .hint{color:#cbd5e1;font-size:12px}
  .ghost{position:fixed;z-index:2147483640;pointer-events:none;display:none;gap:4px}
  .ghost img{width:54px;height:40px;object-fit:cover;border-radius:6px;box-shadow:0 6px 14px rgba(0,0,0,.3);border:2px solid #fff}
  .ghost b{position:absolute;right:-8px;top:-8px;background:#2563eb;color:#fff;font:700 11px system-ui;border-radius:10px;padding:2px 6px}
</style></head><body>
  <div class="win"><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="url">markdrop.in/share</span></div>
    <div class="frame"><iframe id="laptop" name="laptop" src="about:blank"></iframe></div></div>
  <div class="phone"><div class="screen">
    <iframe id="phone" name="phone" src="about:blank"></iframe>
    <div class="cam" id="cam"><div class="finder"><div class="qr" id="qr"></div></div>
      <div class="pill" id="pill">markdrop.in ›</div><div class="hint">Camera</div></div>
  </div></div>
  <div class="ghost" id="ghost"></div>
</body></html>`;

/** Center of an element inside a scaled stage iframe, in page coordinates. */
async function inFrame(h, frameSel, locator) {
  await locator.waitFor({ state: "visible", timeout: 30_000 });
  await locator.evaluate((el) => el.scrollIntoView({ block: "nearest", behavior: "instant" }));
  const fb = await h.page.locator(frameSel).boundingBox();
  const r = await locator.evaluate((el) => {
    const b = el.getBoundingClientRect();
    return [b.x + b.width / 2, b.y + b.height / 2];
  });
  return [fb.x + r[0] * STAGE_SCALE, fb.y + r[1] * STAGE_SCALE];
}

// ── OAuth: a fresh approval request ───────────────────────────────────────────

async function oauthRequest(h) {
  const reg = await fetch(`${h.API}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude", client_uri: "https://claude.ai", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
    }),
  }).then((r) => r.json());
  const q = new URLSearchParams({
    client_id: reg.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", response_type: "code",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256",
    scope: "documents:read documents:write", state: "mdcap",
  });
  const res = await fetch(`${h.API}/oauth/authorize?${q}`, { redirect: "manual" });
  const loc = res.headers.get("location") || "";
  const id = new URL(loc, "http://x").searchParams.get("request");
  if (!id) throw new Error(`no OAuth request id (${res.status} ${loc})`);
  return id;
}

// ── Ask AI (docs site): a scripted answer stream, no model call ───────────────

function stubAskAi() {
  const realFetch = window.fetch.bind(window);
  const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const answer = [
    "Add the domain on the **Look and domain** tab of your workspace's settings, then add two DNS records [S1]:\n\n",
    "1. Under **Your own domain**, choose **Add a domain**, type `docs.acme.com` and choose **Add domain**.\n",
    "2. Add the **Ownership record** (TXT) and the **Routing record** (a CNAME to `edge.markdrop.in`) where you manage DNS for `acme.com` [S1].\n",
    "3. Choose **Check DNS**. When both records are found, the domain goes live on its own [S1].\n\n",
    "DNS changes can take up to an hour to show up; each record shows **Found** or **Not found yet** [S2].",
  ];
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/api/v1/docs/ai/status")) {
      return new Response(JSON.stringify({ available: true }), { headers: { "content-type": "application/json" } });
    }
    if (url.includes("/api/v1/docs/ask") && !url.includes("feedback")) {
      const enc = new TextEncoder();
      const chunks = [];
      chunks.push([200, sse("status", { phase: "searching", label: "Searching the docs…" })]);
      chunks.push([450, sse("status", { phase: "reading", label: "Reading Put your workspace on your own domain…" })]);
      chunks.push([300, sse("citations", { sources: [
        { n: 1, id: "S1", title: "Add your domain", section: "Add your domain", page: "/workspaces/custom-domain", page_title: "Put your workspace on your own domain", url: "https://docs.markdrop.in/workspaces/custom-domain#add-your-domain" },
        { n: 2, id: "S2", title: "It can take a while", section: "It can take a while", page: "/workspaces/custom-domain", page_title: "Put your workspace on your own domain", url: "https://docs.markdrop.in/workspaces/custom-domain#it-can-take-a-while" },
      ] })]);
      for (const part of answer) {
        for (const w of part.match(/\S+\s*/g)) chunks.push([20, sse("delta", { text: w })]);
      }
      chunks.push([200, sse("done", { request_id: "req_demo", outcome: "answered", conversation_id: "conv_demo" })]);
      const body = new ReadableStream({
        async start(ctrl) {
          for (const [ms, c] of chunks) {
            await new Promise((r) => setTimeout(r, ms));
            ctrl.enqueue(enc.encode(c));
          }
          ctrl.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    return realFetch(input, init);
  };
}

export default [
  // ════════════════════════════════════════════════════════════════════════════
  // Workspaces
  // ════════════════════════════════════════════════════════════════════════════

  {
    id: "get-set-up",
    page: "/workspaces/create",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    prepare: async (h) => {
      const id = extra("--new-workspace", "Marketing").trim().split("\n").pop();
      await h.goto(`/w/${id}`);
      await h.loc("section[aria-labelledby='md-setup-h']").waitFor();
      await settle(h, 800);
    },
    crop: async (h) => {
      const sel = await mark(h, "setup-row", () => document.querySelector("section[aria-labelledby='md-setup-h']").parentElement);
      return { selector: sel, pad: 16 };
    },
    after: async () => extra("--drop-workspace", "Marketing"),
  },

  {
    id: "workspace-new-menu",
    page: "/workspaces/create",
    kind: "screenshot",
    auth: "owner",
    url: (fx) => `/w/${ws(fx)}`,
    prepare: async (h) => {
      await h.loc({ role: "button", name: "New", exact: true }).click();
      await h.loc({ role: "menu" }).waitFor();
      await h.sleep(500);
    },
    crop: async (h) => {
      const head = await h.loc("main h1").boundingBox();
      const menu = await h.loc({ role: "menu" }).boundingBox();
      const x = head.x - 90; // the workspace's logo sits left of the name
      return { box: { x, y: head.y - 60, width: menu.x + menu.width + 64 - x, height: menu.y + menu.height + 20 - (head.y - 60) } };
    },
  },

  {
    id: "folders-overview",
    page: "/workspaces/folders",
    kind: "screenshot",
    auth: "owner",
    url: (fx) => `/w/${ws(fx)}/f/${folder(fx, "Guides")}`,
    prepare: async (h) => {
      const guides = h.page.getByRole("treeitem", { name: /^Guides/ }).first();
      await guides.focus();
      await h.page.keyboard.press("ArrowRight");
      await h.page.getByRole("treeitem", { name: /^Setup/ }).first().waitFor({ timeout: 5000 }).catch(() => {});
      await h.page.evaluate(() => document.activeElement?.blur());
      await settle(h, 800);
    },
    crop: { box: { x: 0, y: 56, width: 1360, height: 640 } },
  },

  {
    id: "invite-dialog",
    page: "/workspaces/members-and-roles",
    kind: "screenshot",
    auth: "owner",
    url: (fx) => `/settings/workspaces/${ws(fx)}`,
    prepare: async (h) => {
      await h.loc({ role: "button", name: "Invite people" }).click();
      const dlg = h.loc(".md-dialog");
      await dlg.waitFor();
      await h.page.getByLabel("Email addresses").fill("lee@acme.com, nora@acme.com");
      const canEdit = h.page.locator(".md-dialog").getByText("Can edit", { exact: true }).first();
      await canEdit.click();
      await h.sleep(700);
      await h.page.mouse.move(5, 5);
    },
    crop: { selector: ".md-dialog", pad: 0 },
  },

  {
    id: "people-tab",
    page: "/workspaces/members-and-roles",
    kind: "screenshot",
    auth: "owner",
    url: (fx) => `/settings/workspaces/${ws(fx)}`,
    prepare: async (h) => {
      await h.loc({ role: "button", name: "Invite people" }).waitFor();
      await settle(h, 600);
    },
    crop: async (h) => ({ selector: await mark(h, "people-card", cardOf("People"), ["People"]), pad: 12 }),
  },

  {
    id: "privacy-presets",
    page: "/workspaces/privacy",
    kind: "screenshot",
    auth: "owner",
    url: (fx) => `/settings/workspaces/${ws(fx)}`,
    prepare: async (h) => {
      await h.loc("section[aria-labelledby='ws-privacy-h']").waitFor();
      await settle(h, 600);
    },
    crop: { selector: "section[aria-labelledby='ws-privacy-h']", pad: 12 },
  },

  {
    id: "folder-link-tab",
    page: "/workspaces/share-a-folder",
    kind: "screenshot",
    auth: "owner",
    url: (fx) => `/w/${ws(fx)}/f/${folder(fx, "Releases")}`,
    prepare: async (h) => {
      fxC(); // the Releases folder link exists (Anyone with the link)
      await h.page.reload({ waitUntil: "domcontentloaded" });
      await h.settle(600);
      await h.loc("main").getByRole("button", { name: "Share", exact: true }).first().click();
      await h.loc(".md-dialog").waitFor();
      await h.sleep(900);
      await h.page.mouse.move(5, 5);
    },
    crop: { selector: ".md-dialog", pad: 0 },
  },

  {
    id: "shared-folder-page",
    page: "/workspaces/share-a-folder",
    kind: "screenshot",
    auth: "anon",
    url: () => `/f/${fxC().releases_share_id}`,
    prepare: async (h) => settle(h, 1000),
    crop: { box: { x: 270, y: 80, width: 900, height: 600 } },
  },

  {
    id: "dns-check-partial",
    page: "/workspaces/custom-domain",
    kind: "screenshot",
    auth: "owner",
    url: (fx) => `/settings/workspaces/${ws(fx)}?tab=look`,
    prepare: async (h) => {
      await restoreDomains(h);
      extra("--dns-cname-only", "help.acme.com");
      await h.page.reload({ waitUntil: "domcontentloaded" });
      await h.settle(800);
      await h.scrollTo({ text: "help.acme.com", exact: true }, { block: "start" });
      await h.loc({ role: "button", name: "Check DNS" }).click();
      await h.loc({ text: /Not found yet/ }).waitFor({ timeout: 20_000 });
      await settle(h, 800);
    },
    // The two record blocks of help.acme.com, with their Found / Not found yet badges.
    crop: async (h) => {
      const sel = await mark(h, "records", () => {
        const label = [...document.querySelectorAll("span")].find((e) => /^Ownership record$/i.test(e.textContent.trim()));
        return label ? label.closest(".grid") : null;
      });
      return { selector: sel, pad: 2 };
    },
    after: restoreDomains,
  },

  {
    id: "branding-form",
    page: "/workspaces/branding",
    kind: "screenshot",
    auth: "owner",
    url: (fx) => `/settings/workspaces/${ws(fx)}?tab=look`,
    prepare: async (h) => {
      await h.loc({ role: "heading", name: "How your links look" }).waitFor();
      await settle(h, 1200);
    },
    crop: async (h) => {
      const a = await mark(h, "brand-a", cardOf("Logo, colours and favicon"), ["Logo, colours and favicon"]);
      const b = await mark(h, "brand-b", cardOf("How your links look"), ["How your links look"]);
      return { union: [a, b], pad: 12 };
    },
  },

  {
    id: "tenant-branded-page",
    page: "/workspaces/branding",
    kind: "screenshot",
    auth: "anon",
    url: null,
    prepare: async (h) => {
      await h.goto(h.tenant("docs.acme.com", "/guides/setup/getting-started#mdt-none=1"), { settle: 1200 });
      await h.page.keyboard.press("Escape");
      await settle(h, 900);
    },
    crop: { box: { x: 0, y: 0, width: 1440, height: 620 } },
  },

  {
    id: "tenant-sign-in",
    page: "/workspaces/sign-in-on-your-domain",
    kind: "screenshot",
    auth: "anon",
    url: null,
    viewport: { width: 960, height: 600 }, // a narrower window, so logo and button sit close together
    prepare: async (h) => {
      await h.goto(h.tenant("docs.acme.com", "/guides/setup#mdt-none=1"), { settle: 1200 });
      await settle(h, 600);
    },
    crop: { box: { x: 0, y: 0, width: 960, height: 62 } },
  },

  {
    id: "handoff-consent",
    page: "/workspaces/sign-in-on-your-domain",
    kind: "screenshot",
    auth: "dana",
    url: "/auth/handoff?host=docs.acme.com&next=/guides/setup/getting-started",
    prepare: async (h) => {
      fxC(); // Dana's display name: Dana Park
      await h.loc({ role: "button", name: "Continue" }).waitFor();
      await settle(h, 600);
    },
    crop: { selector: ".md-empty", pad: 24 },
  },


  // ── Clips (workspaces) ─────────────────────────────────────────────────────

  {
    id: "new-workspace",
    page: "/workspaces/create",
    kind: "clip",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1280, height: 800 },
    out: 1440,
    prepare: async (h) => {
      extra("--drop-workspace", "Marketing");
      await h.page.mouse.move(700, 500);
      // The browser's clock to the real now: the new workspace is dated by the server, and its
      // "Get set up" checklist shows only while the workspace is new.
      await h.page.clock.setSystemTime(new Date());
      await h.page.reload({ waitUntil: "domcontentloaded" });
      await settle(h, 800);
    },
    steps: async (h) => {
      await h.click({ role: "link", name: "New workspace" }, { after: 1200 });
      await h.loc("main").getByRole("button", { name: "New workspace" }).waitFor();
      await h.click(h.loc("main").getByRole("button", { name: "New workspace" }), { after: 700 });
      await h.type({ label: "Name" }, "Marketing", { speed: 1.2 });
      await h.sleep(400);
      await h.click({ role: "button", name: "Create workspace" }, { after: 600 });
      await h.loc("section[aria-labelledby='md-setup-h']").waitFor({ timeout: 20_000 });
      await h.move([900, 600]);
      await h.sleep(700);
    },
    tail: 300,
    poster: 9,
    after: async () => extra("--drop-workspace", "Marketing"),
  },

  {
    id: "folder-rename",
    page: "/workspaces/folders",
    kind: "clip",
    auth: "owner",
    url: (fx) => `/w/${ws(fx)}/f/${folder(fx, "Releases")}`,
    viewport: { width: 1280, height: 800 },
    out: 1440,
    prepare: async (h) => settle(h, 800),
    steps: async (h) => {
      await h.click({ role: "button", name: "More folder actions" }, { after: 700 });
      await h.click({ role: "menuitem", name: /Rename folder/ }, { after: 700 });
      const field = h.loc(".md-dialog input[type=text], .md-dialog input:not([type])");
      await field.waitFor();
      await h.type(field, "Release notes", { clear: true, speed: 0.8 });
      await h.sleep(2200);
      await h.click(h.loc(".md-dialog").getByRole("button", { name: "Cancel" }), { after: 500 });
    },
    tail: 300,
    poster: 6,
  },

  {
    id: "preview-as",
    page: "/workspaces/privacy",
    kind: "clip",
    auth: "owner",
    url: (fx) => `/w/${ws(fx)}/f/${folder(fx, "Sales")}`,
    viewport: { width: 1280, height: 800 },
    out: 1440,
    prepare: async (h) => {
      fxC(); // Pricing FAQ (password) is filed in Sales
      await h.page.reload({ waitUntil: "domcontentloaded" });
      await settle(h, 800);
    },
    steps: async (h) => {
      await h.click({ role: "button", name: "Preview as" }, { after: 800 });
      await h.click({ role: "radio", name: /Anyone with the link/ }, { after: 2600 });
      await h.click({ role: "radio", name: /member/ }, { after: 2400 });
      await h.click({ role: "button", name: /Exit preview/ }, { after: 700 });
    },
    tail: 300,
    poster: 4,
  },

  // ── Clip (AI): Ask AI on the docs site ─────────────────────────────────────

  {
    id: "docs-ask-ai",
    page: "/ai/use-these-docs",
    kind: "clip",
    auth: "anon",
    url: null,
    viewport: { width: 1280, height: 800 },
    out: 1440,
    prepare: async (h) => {
      await h.goto(`${h.DOCS}/workspaces/custom-domain`, { settle: 1200 });
      await h.page.evaluate(stubAskAi);
    },
    steps: async (h) => {
      await h.click({ role: "button", name: "Ask AI", exact: true }, { after: 700 });
      const box = h.page.getByRole("textbox").last();
      await h.type(box, "How do I put my workspace on docs.acme.com?", { speed: 2.6 });
      await h.press("Enter", 200);
      await h.sleep(3300); // the scripted answer streams in (~3 s)
      await h.click(h.loc(".dx-cite__btn").first(), { after: 1900 });
    },
    trim: { start: 0.8 },
    tail: 300,
    poster: 9,
  },


  // ════════════════════════════════════════════════════════════════════════════
  // Send files peer to peer (/share)
  // ════════════════════════════════════════════════════════════════════════════

  {
    id: "p2p-sender",
    page: "/share/send-files",
    kind: "screenshot",
    auth: "anon",
    url: "/share",
    prepare: async (h) => {
      // The phone on a slower network (3.4 MB/s), the laptop on a faster one (6.2 MB/s).
      await h.page.addInitScript(paceChannels, [3.4e6, 6.2e6]);
      await h.page.reload({ waitUntil: "domcontentloaded" });
      await h.settle(1500);
      await h.loc("input[type=file]").waitFor({ state: "attached" });
      await h.page.locator("input[type=file]").first().setInputFiles([
        { name: "product-walkthrough.mov", mimeType: "video/quicktime", buffer: Buffer.alloc(46 * 1024 * 1024, 7) },
        { name: "Q3 report.pdf", mimeType: "application/pdf", buffer: pdfBytes(2_400_000) },
      ]);
      const link = await shareLink(h.page);
      // Two people open the link: a phone that takes everything, a laptop that picks the video.
      const people = [
        [{ userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, /^(Download all|Save all)/],
        [{ userAgent: WINDOWS_UA, viewport: { width: 1280, height: 800 } }, "Download product-walkthrough.mov"],
      ];
      for (const [opts, pick] of people) {
        const ctx = await newContext(h, { ...opts, acceptDownloads: true });
        const p = await ctx.newPage();
        await p.goto(`${h.APP}${link}`, { waitUntil: "domcontentloaded" });
        const btn = p.getByRole("button", { name: pick }).first();
        await btn.waitFor({ timeout: 60_000 });
        await btn.click();
      }
      // Both well under way, at a steady rate (the ETA shows after 3 s of one).
      const panel = h.loc("section[aria-labelledby='share-people']");
      const t0 = Date.now();
      for (;;) {
        const pcts = ((await panel.innerText()).match(/(\d+)%/g) || []).map((x) => parseInt(x, 10));
        if (pcts.length >= 2 && Math.min(...pcts) >= 22) break;
        if (Date.now() - t0 > 60_000) throw new Error(`transfers stuck: ${pcts}`);
        await h.sleep(250);
      }
      await h.sleep(1200);
      await scrubLinkField(h.page);
      await h.page.mouse.move(5, 895);
    },
    crop: async (h) => {
      const a = await h.loc("section[aria-label='Share link and live transfer']").boundingBox();
      const b = await h.loc("section[aria-labelledby='share-people']").boundingBox();
      const t = await h.loc("main h1").boundingBox();
      const top = t.y - 36;
      return { box: { x: a.x - 16, y: top, width: a.width + 32, height: b.y + b.height + 48 - top } };
    },
    keepScroll: true,
    after: closeContexts,
  },


  {
    id: "send-files-p2p",
    page: "/share/send-files",
    kind: "video",
    videoId: "send-files-p2p",
    auth: "anon",
    url: null,
    prepare: async (h) => {
      const photos = ensurePhotos();
      await h.context.addInitScript(stageFrames, { ua: IPHONE_UA, pace: 0.5e6 });
      await h.page.route("**/__mdcap/stage", (route) => route.fulfill({ contentType: "text/html", body: STAGE_HTML }));
      await h.goto("/__mdcap/stage", { settle: 500 });
      // Load the laptop's page only now: its frame name is set, so the init script knows it.
      await h.page.evaluate(() => (document.getElementById("laptop").src = "/share"));
      await h.settle(2500);
      const laptop = h.page.frameLocator("#laptop");
      await laptop.locator("input[type=file]").first().waitFor({ state: "attached", timeout: 60_000 });
      await h.sleep(1500);
      // The thumbnails the cursor carries in.
      const thumbs = photos.map((f) => `data:image/jpeg;base64,${spawnSync(FFMPEG, ["-loglevel", "error", "-i", f, "-vf", "scale=160:-1", "-f", "mjpeg", "-"], { maxBuffer: 1 << 24 }).stdout.toString("base64")}`);
      await h.page.evaluate((srcs) => {
        const g = document.getElementById("ghost");
        g.innerHTML = srcs.map((s, i) => `<img src="${s}" style="margin-left:${i ? -34 : 0}px;transform:rotate(${(i - 1) * 6}deg)">`).join("") + "<b>3</b>";
      }, thumbs);
    },
    steps: async (h) => {
      const laptop = h.page.frameLocator("#laptop");
      const phone = h.page.frameLocator("#phone");
      const ghost = async (on) => h.page.evaluate((v) => (document.getElementById("ghost").style.display = v ? "flex" : "none"), on);
      const follow = async (x, y) => h.page.evaluate(([a, b]) => {
        const g = document.getElementById("ghost");
        g.style.left = `${a + 8}px`;
        g.style.top = `${b + 10}px`;
      }, [x, y]);

      // 1. Drop three photos on the laptop.
      await h.caption("Drop files on markdrop.in/share — no account needed", 1500);
      await h.move([140, 760], { duration: 1 });
      await follow(140, 760);
      await ghost(true);
      const drop = await inFrame(h, "#laptop", laptop.getByRole("group", { name: /Drop files/ }).first());
      const from = [140, 760];
      for (let i = 1; i <= 24; i++) {
        const t = i / 24, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const x = from[0] + (drop[0] - from[0]) * e, y = from[1] + (drop[1] - from[1]) * e;
        await h.move([x, y], { duration: 1 });
        await follow(x, y);
        await h.sleep(28);
      }
      await h.sleep(300);
      await ghost(false);
      await laptop.locator("input[type=file]").first().setInputFiles(ensurePhotos());
      await laptop.getByRole("button", { name: "Copy link" }).first().waitFor({ timeout: 30_000 });
      const link = await shareLink(h.page.frame({ name: "laptop" }));
      await h.sleep(800);
      await h.caption("Share the link, or let them scan the QR code", 2200);

      // 2. The phone's camera reads the QR code.
      await h.page.evaluate(() => {
        const q = document.getElementById("laptop").contentDocument.querySelector("[role=img][aria-label^='QR code'] svg");
        const box = document.getElementById("qr");
        if (q) box.innerHTML = q.outerHTML;
        box.classList.add("on");
      });
      await h.hover(await inFrame(h, "#laptop", laptop.locator("[role=img][aria-label^='QR code']").first()), 500);
      await h.caption("Point a phone camera at it", 900);
      await h.page.evaluate(() => document.getElementById("pill").classList.add("on"));
      await h.sleep(700);
      await h.click("#pill", { after: 200 });
      await h.page.evaluate((u) => {
        document.getElementById("phone").src = u;
        setTimeout(() => (document.getElementById("cam").style.opacity = "0"), 500);
        setTimeout(() => (document.getElementById("cam").style.display = "none"), 950);
      }, link);
      await h.caption("The phone connects straight to the laptop", 300);
      await phone.getByRole("button", { name: /^Download all/ }).first().waitFor({ timeout: 60_000 });
      await h.sleep(900);
      // The laptop's People list: who's connected, and the route.
      await laptop.locator("section[aria-labelledby='share-people']").first().evaluate((el) => el.scrollIntoView({ block: "center", behavior: "smooth" }));
      await h.sleep(900);

      // 3. Download on the phone, while the laptop shows its progress.
      await h.caption("Files stream device to device, encrypted", 300);
      await h.click(await inFrame(h, "#phone", phone.getByRole("button", { name: /^Download all/ }).first()), { after: 500 });
      await h.move(await inFrame(h, "#laptop", laptop.locator("section[aria-labelledby='share-people'] li").first()), { duration: 900 });
      await h.caption("People shows each device, how far it got, and Direct or Relayed", 3400);

      // 4. One tap saves them to Photos.
      const save = phone.getByRole("button", { name: /^Save \d+ photos/ }).first();
      await save.waitFor({ timeout: 60_000 });
      await h.caption("On an iPhone, one tap saves them to Photos", 600);
      await h.click(await inFrame(h, "#phone", save), { after: 2400 });

      // 5. End sharing.
      await h.caption("Done? End sharing and the link stops working", 400);
      const end = laptop.getByRole("button", { name: "End sharing" }).first();
      await end.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "smooth" }));
      await h.sleep(900);
      await h.click(await inFrame(h, "#laptop", end), { after: 2400 });
      await h.caption("The phone keeps what it saved", 2200);
    },
    poster: 18,
    tail: 600,
  },

  {
    id: "p2p-receiver",
    page: "/share/send-files",
    kind: "screenshot",
    auth: "anon",
    url: null,
    viewport: { width: 390, height: 844 },
    userAgent: IPHONE_UA,
    prepare: async (h) => {
      const ctx = await newContext(h, { viewport: { width: 1440, height: 900 }, userAgent: MAC_UA });
      const sender = await ctx.newPage();
      await sender.goto(`${h.APP}/share`, { waitUntil: "networkidle" });
      await sender.waitForTimeout(1500); // hydrated
      await sender.locator("input[type=file]").first().setInputFiles([
        { name: "Q3 report.pdf", mimeType: "application/pdf", buffer: pdfBytes(2_400_000) },
        { name: "demo-notes.txt", mimeType: "text/plain", buffer: Buffer.from(NOTES) },
      ]);
      const link = await shareLink(sender);
      await h.goto(link, { settle: 800 });
      await h.loc("section[aria-label='Files']").waitFor({ timeout: 60_000 });
      await h.loc({ text: /files are ready|ready/i }).waitFor({ timeout: 30_000 }).catch(() => {});
      await h.sleep(1500);
      await h.page.mouse.move(5, 5);
    },
    crop: "viewport",
    after: closeContexts,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // Analytics
  // ════════════════════════════════════════════════════════════════════════════

  {
    id: "analytics-home",
    page: "/analytics/overview",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard/analytics",
    prepare: async (h) => {
      await h.loc("#ah-links").waitFor().catch(() => {});
      await h.loc({ role: "table" }).first().waitFor();
      await settle(h, 1200);
    },
    // Title, tiles, the first rows of Your links and Worth a look.
    crop: { box: { x: 270, y: 72, width: 1150, height: 545 } },
  },

  {
    id: "link-analytics-overview",
    page: "/analytics/overview",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard/analytics/getting-started",
    prepare: async (h) => {
      await h.loc({ text: "Views per day" }).waitFor();
      await settle(h, 1200);
    },
    crop: { box: { x: 270, y: 110, width: 1150, height: 870 } },
  },

  {
    id: "content-tab",
    page: "/analytics/documents-and-pdfs",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard/analytics/getting-started?tab=content",
    prepare: async (h) => {
      await h.loc({ text: "How far people read, section by section" }).waitFor();
      await settle(h, 1000);
    },
    crop: { box: { x: 270, y: 250, width: 1150, height: 560 } },
  },

  {
    id: "pages-tab",
    page: "/analytics/documents-and-pdfs",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard/analytics/q3-board-deck?tab=pages",
    prepare: async (h) => {
      await h.loc({ text: "Viewers who reached each page" }).waitFor();
      await settle(h, 1000);
    },
    crop: { box: { x: 270, y: 250, width: 1150, height: 380 } },
  },

  {
    id: "playback-health",
    page: "/analytics/video-and-audio",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard/analytics/product-demo?tab=video",
    prepare: async (h) => {
      await h.loc("#md-qoe").waitFor();
      await settle(h, 1000);
    },
    crop: async (h) => ({ selector: await mark(h, "qoe", () => document.querySelector("#md-qoe").closest("section") || document.querySelector("#md-qoe")), pad: 0 }),
  },


  // ── Videos (analytics) ─────────────────────────────────────────────────────

  {
    id: "analytics-tour",
    page: "/analytics/overview",
    kind: "video",
    videoId: "analytics-tour",
    auth: "owner",
    url: "/dashboard/analytics",
    prepare: async (h) => {
      await startLive(300);
      await h.page.reload({ waitUntil: "domcontentloaded" });
      await h.loc({ role: "table" }).first().waitFor();
      await settle(h, 1200);
    },
    steps: async (h) => {
      await h.caption("Analytics: every link you own, in one place", 900);
      await h.hover({ text: "People", exact: true }, 700);
      await h.hover({ text: "Read to the end", exact: true }, 900);
      await h.caption("Pick the period: 7, 30 or 90 days, or All time", 200);
      await h.click({ role: "radio", name: "90 days" }, { after: 2200 });
      await h.caption("Your links: views, a trend line and how engaged people were", 300);
      await h.hover(h.loc({ role: "table" }).getByRole("row").nth(2), 1400);
      await h.hover(h.loc({ role: "table" }).getByRole("row").nth(4), 1200);
      await h.caption("Worth a look points out what stands out", 300);
      await h.hover({ text: "Worth a look" }, 2400);
      await h.caption("Open a link for its own page", 200);
      await h.click({ role: "link", name: "Getting started with Acme" }, { after: 1600 });
      await h.loc({ text: "Views per day" }).waitFor();
      await h.wheel(260, 14);
      await h.sleep(1600);
      await h.wheel(-260, 10);
      await h.caption("Content: how far people read, section by section", 200);
      await h.click({ role: "tab", name: "Content" }, { after: 1400 });
      await h.hover({ text: "Readers leave here" }, 2000);
      await h.caption("Audience: new and returning, devices, countries, channels", 200);
      await h.click({ role: "tab", name: "Audience" }, { after: 1400 });
      await h.wheel(420, 16);
      await h.sleep(2000);
      await h.wheel(-420, 10);
      await h.caption("For a video: who's still watching, second by second", 200);
      await h.click(h.loc("main").getByRole("link", { name: "Analytics", exact: true }), { after: 1200 });
      await h.click({ role: "link", name: "Product demo" }, { after: 1200 });
      await h.click({ role: "tab", name: "Video" }, { after: 1000 });
      const ret = await h.loc("#md-ret").boundingBox();
      for (let i = 0; i <= 8; i++) {
        await h.move([ret.x + ret.width * (0.04 + 0.11 * i), ret.y + ret.height * 0.5], { duration: 300 });
        await h.sleep(260);
      }
      await h.sleep(800);
      await h.caption("Live: who's on your links right now", 200);
      await h.click(h.loc("main").getByRole("link", { name: "Analytics", exact: true }), { after: 1000 });
      await h.click({ role: "link", name: /Live|people live/ }, { after: 3200 });
    },
    after: async () => stopLive(),
    poster: 3,
  },

  {
    id: "video-analytics",
    page: "/analytics/video-and-audio",
    kind: "video",
    videoId: "video-analytics",
    auth: "owner",
    url: "/dashboard/analytics/product-demo?tab=video",
    prepare: async (h) => {
      await h.loc("#md-ret").waitFor();
      await settle(h, 1500);
    },
    steps: async (h) => {
      await h.caption("A video's Video tab: who's still watching, second by second", 1600);
      const ret = await h.loc("#md-ret").boundingBox();
      for (let i = 0; i <= 10; i++) {
        await h.move([ret.x + ret.width * (0.03 + 0.094 * i), ret.y + ret.height * 0.45], { duration: 280 });
        await h.sleep(380);
      }
      await h.caption("Markdrop marks the moments worth a look", 300);
      await h.hover(vis(h, /still watching at 0:30/), 1600);
      await h.hover(vis(h, /Most viewers leave at/), 1800);
      await h.hover(vis(h, /Replayed most at/), 1600);
      await h.caption("Rewatched and skipped: darker means more rewatching", 300);
      await h.hover(vis(h, "Rewatched and skipped"), 600);
      const strip = await vis(h, "Rewatched and skipped").boundingBox();
      await h.move([strip.x + 300, strip.y + 18], { duration: 500 });
      await h.move([strip.x + 700, strip.y + 18], { duration: 900 });
      await h.sleep(1200);
      await h.caption("How they watch: speeds, fullscreen and muted", 300);
      await h.scrollTo(vis(h, "How they watch"), { block: "center" });
      await h.hover(vis(h, "How they watch"), 2200);
      await h.caption("Could people actually watch it? Startup, stalls and failed plays", 300);
      await h.scrollTo("#md-qoe", { block: "center" });
      await h.hover("#md-qoe", 1200);
      await h.hover(vis(h, "Suggestion"), 2600);
      await h.caption("Each version keeps its own curve", 300);
      await h.scrollTo("#md-ret", { block: "center" });
      await h.sleep(400);
      await h.click({ role: "combobox", name: "Version" }, { after: 200 });
      await h.page.keyboard.press("Escape");
      await h.loc({ role: "combobox", name: "Version" }).selectOption({ label: "Version 1" });
      await h.sleep(2600);
      await h.loc({ role: "combobox", name: "Version" }).selectOption({ label: "Version 2" });
      await h.sleep(1200);
      await h.caption("Versions compares every version of the file", 200);
      await h.click({ role: "tab", name: /^Versions/ }, { after: 3200 });
    },
    poster: 5,
  },

  {
    id: "live-now",
    page: "/analytics/live",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard/analytics",
    prepare: async (h) => {
      await startLive(240);
      await h.goto("/dashboard/live");
      await h.loc({ text: /people across/ }).waitFor({ timeout: 20_000 });
      await settle(h, 1500);
    },
    crop: { box: { x: 270, y: 72, width: 1150, height: 604 } },
    after: async () => stopLive(),
  },

  {
    id: "audience-internal-toggle",
    page: "/analytics/what-gets-counted",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard/analytics/getting-started?tab=audience",
    prepare: async (h) => {
      await h.loc({ text: "Hide views from Acme members" }).waitFor();
      await settle(h, 1000);
    },
    crop: { box: { x: 270, y: 250, width: 1150, height: 496 } },
  },

  {
    id: "weekly-email-toggle",
    page: "/analytics/weekly-email",
    kind: "screenshot",
    auth: "owner",
    url: "/settings/account",
    prepare: async (h) => {
      await h.loc({ text: "Weekly analytics email" }).waitFor();
      await settle(h, 600);
    },
    crop: async (h) => ({ selector: await mark(h, "email-card", cardOf("Email"), ["Email"]), pad: 12 }),
  },

  // ════════════════════════════════════════════════════════════════════════════
  // AI (browser screens only)
  // ════════════════════════════════════════════════════════════════════════════

  {
    id: "oauth-consent",
    page: "/ai/hosted-mcp",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    prepare: async (h) => {
      const id = await oauthRequest(h);
      await h.goto(`/oauth/consent?request=${id}`);
      await h.loc({ role: "button", name: "Approve" }).waitFor();
      await settle(h, 600);
    },
    crop: { selector: ".md-card.ph-no-capture", pad: 24 },
  },

  {
    id: "connected-apps",
    page: "/ai/hosted-mcp",
    kind: "screenshot",
    auth: "owner",
    url: "/settings/connections",
    prepare: async (h) => {
      await h.loc({ text: "claude.ai" }).waitFor();
      await h.loc({ role: "button", name: "More actions for Claude" }).click();
      await h.loc({ role: "menuitem", name: /Disconnect/ }).waitFor();
      await h.sleep(500);
      await h.page.mouse.move(5, 895);
    },
    crop: { box: { x: 410, y: 80, width: 870, height: 400 } },
  },

  {
    id: "docs-copy-page-menu",
    page: "/ai/use-these-docs",
    kind: "screenshot",
    auth: "anon",
    url: null,
    prepare: async (h) => {
      await h.goto(`${h.DOCS}/workspaces/custom-domain`, { settle: 1000 });
      await h.loc({ role: "button", name: "More ways to use this page" }).click();
      await h.loc(".dx-pagemenu, [role=menu]").waitFor();
      await h.sleep(500);
      await h.page.mouse.move(5, 895);
    },
    crop: async (h) => {
      const t = await h.loc("main h1").boundingBox();
      const m = await h.loc("[role=menu]").boundingBox();
      const x = t.x - 20;
      return { box: { x, y: t.y - 10, width: m.x + m.width + 20 - x, height: m.y + m.height + 20 - (t.y - 10) } };
    },
  },
];
