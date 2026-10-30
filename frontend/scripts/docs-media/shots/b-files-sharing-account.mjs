/**
 * Docs media for /files, /sharing and /account (group B). Same format as ../shots.mjs.
 *
 * Needs the extra demo data of seed_extra_b.py (run it after seed.py on the same STACK_ID): the
 * files the upload shots choose (.data/<N>/b/), Riya's 1.2 GB of storage, and the per-shot states
 * (Dana's access request, share grants, API tokens) that shots switch in prepare() and put back
 * in after().
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEDIA = path.resolve(HERE, "..");
const REPO = path.resolve(MEDIA, "../../..");
const STACK_ID = Number(process.env.STACK_ID || 0);
const BASE_DATA = process.env.DOCS_MEDIA_DATA || path.join(MEDIA, ".data");
const DATA = STACK_ID ? path.join(BASE_DATA, String(STACK_ID)) : BASE_DATA;
const PY = process.env.DOCS_MEDIA_PYTHON || path.join(REPO, "backend/.venv/bin/python");

/** A file seed_extra_b.py wrote (.data/<N>/b/) or one of the shared rendered fixtures. */
const extraFile = (name) => path.join(DATA, "b", name);
const fixtureFile = (name) => path.join(BASE_DATA, "fixtures", name);

/** Switch a piece of the demo world (seed_extra_b.py --state …). */
const state = (name) => {
  const r = spawnSync(PY, [path.join(MEDIA, "seed_extra_b.py"), "--state", name], { encoding: "utf8", env: process.env });
  if (r.status !== 0) throw new Error(`seed_extra_b.py --state ${name}: ${r.stderr || r.stdout}`);
};

/** Call the sandbox's real API as one of the demo users. */
async function api(h, who, method, p, body) {
  const email = h.fx.users[who].email;
  const { token } = await h.sandbox("/__sandbox/mint", { email });
  const res = await fetch(`${h.API}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/** From now on, documents in this context load signed in as `who` ("anon": signed out). Added
 *  after the runner's own init script, so it wins on every navigation. */
async function signInAs(h, who) {
  const token = who === "anon" ? null : (await h.sandbox("/__sandbox/mint", { email: h.fx.users[who].email })).token;
  await h.context.addInitScript((t) => {
    try {
      if (t) localStorage.setItem("markdrop_token", t);
      else localStorage.removeItem("markdrop_token");
    } catch {}
  }, token);
}

/** For the rest of the take, hide the access gate: a signed-in reader with access sees it for a
 *  moment while the page checks their session (the server renders it signed out). */
const hideGateFlash = (h) =>
  h.context.addInitScript(() => {
    const add = () => {
      const st = document.createElement("style");
      st.textContent = "section[aria-labelledby='md-gate-title']{visibility:hidden!important}";
      (document.head || document.documentElement).appendChild(st);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add);
    else add();
  });

const escapeImmersive = async (h) => {
  // Document and file pages open full screen; Escape brings the top bar back.
  await h.page.keyboard.press("Escape");
  await h.sleep(600);
};

const parkMouse = (h) => h.page.mouse.move(5, 895);

/** Out of the immersive view of a video page: its own "Show details" button (Esc goes to the player). */
const showDetails = async (h) => {
  const btn = h.page.getByRole("button", { name: /Show details/ }).first();
  await btn.waitFor({ timeout: 30_000 });
  await btn.click();
  await h.sleep(900);
};

/** Put a file on the upload page's file input (name as the reader would have it). */
const chooseFile = (h, file, name, mimeType) =>
  h.page.locator("input[type=file]").first().setInputFiles({ name, mimeType, buffer: readFileSync(file) });

/** The artifact viewer frame (the Worker origin) of a file page. */
const viewerFrame = (h, kind) => h.page.frameLocator(`iframe[src*='/v/${kind}/']`);

/** Tag the smallest element that contains all `texts` (under `root`) so a crop can target it. */
async function tagSmallest(h, root, texts, tag) {
  const handle = await h.page.evaluateHandle(([r, t]) => {
    let best = null;
    for (const el of document.querySelectorAll(`${r} *`)) {
      const s = el.textContent || "";
      if (t.every((x) => s.includes(x)) && (!best || best.contains(el))) best = el;
    }
    return best;
  }, [root, texts]);
  await handle.evaluate((el, t) => el?.setAttribute("data-mdcap", t), tag);
  return `[data-mdcap=${tag}]`;
}

/**
 * Two windows side by side in one recording: a plain page holding two frames of the app. The left
 * one is signed in as the shot's user; the right one is a signed-out reader (its frame can't see
 * the session token in the shared storage). The cursor and captions live in the outer page, above
 * both. The outer page is on the app's own origin (Chrome blocks local frames in an opaque data:
 * page, and a second local origin in a frame).
 */
async function twoUp(h, left, right, { leftLabel, rightLabel }) {
  const port = new URL(h.APP).port;
  await h.context.addInitScript(() => {
    try {
      if (window.frameElement?.id !== "R") return;
      const { getItem, setItem, removeItem } = Storage.prototype;
      Storage.prototype.getItem = function (k) { return k === "markdrop_token" ? null : getItem.call(this, k); };
      Storage.prototype.setItem = function (k, v) { if (k !== "markdrop_token") setItem.call(this, k, v); };
      Storage.prototype.removeItem = function (k) { if (k !== "markdrop_token") removeItem.call(this, k); };
    } catch {}
  });
  const pane = (id, src, label) => `<section><header><span class="dot"></span>${label}</header>
    <iframe id="${id}" src="${src}" allow="clipboard-read; clipboard-write; fullscreen"></iframe></section>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Markdrop</title><style>
    html,body{margin:0;height:100%;background:#0b1220;font:600 15px/1 Manrope,-apple-system,system-ui,sans-serif}
    main{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:12px;height:100%;box-sizing:border-box}
    section{display:flex;flex-direction:column;border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 8px 30px rgba(0,0,0,.35)}
    header{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#1f2937;color:#e5e7eb;letter-spacing:-.005em}
    .dot{width:9px;height:9px;border-radius:50%;background:#34d399}
    iframe{border:0;flex:1;width:100%}</style></head>
    <body><main>${pane("L", `http://localhost:${port}${left}`, leftLabel)}${pane("R", `http://localhost:${port}${right}`, rightLabel)}</main></body></html>`;
  const url = `http://localhost:${port}/__mdcap-two-up`;
  await h.page.route(url, (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
  await h.page.goto(url, { waitUntil: "load" });
  await h.settle(1500);
  return { L: h.page.frameLocator("#L"), R: h.page.frameLocator("#R") };
}

/** The app's local origin as readers see it (the runner scrubs page text; captions are ours). */
const prodUrl = (h, u) => u.replace(new URL(h.APP).origin, "markdrop.in").replace(/^https?:\/\//, "");

export default [
  // ── /files/html-pages: an HTML file chosen, running in the Preview ─────────
  {
    id: "html-upload-preview",
    page: "/files/html-pages",
    kind: "screenshot",
    auth: "owner",
    url: "/upload",
    prepare: async (h) => {
      await chooseFile(h, extraFile("q3-dashboard.html"), "q3-dashboard.html", "text/html");
      await h.loc({ role: "region", name: "Preview" }).waitFor();
      await h.sleep(1500); // the page renders in the sandboxed frame
      await parkMouse(h);
    },
    // The chosen file, the running Preview, and the Title / Link it filled in.
    crop: async (h) => {
      const top = await h.loc({ text: "Your file", exact: true }).boundingBox();
      const prev = await h.loc({ role: "region", name: "Preview" }).boundingBox();
      // The page is centred: the Publish panel ends as far from the right edge as "Your file" starts from the left.
      const x = top.x - 16, y = top.y - 16;
      return { box: { x, y, width: h.shot.viewport.width - 2 * x, height: prev.y + prev.height + 16 - y } };
    },
  },

  // ── /files/large-uploads: the progress line of a long upload ───────────────
  {
    id: "upload-progress-large",
    page: "/files/large-uploads",
    kind: "screenshot",
    auth: "owner",
    url: "/upload",
    prepare: async (h) => {
      // A 1.6 GB recording, without 1.6 GB: the File reports that size, and the PUT to storage
      // reports a quarter of it sent and never finishes (nothing is uploaded or published).
      await h.page.evaluate(() => {
        const send = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function (body) {
          if (body instanceof Blob && body.size > 1e9) {
            const total = body.size;
            setTimeout(() => this.upload.onprogress?.(new ProgressEvent("progress", { lengthComputable: true, loaded: Math.round(total * 0.2515), total })), 80);
            return;
          }
          return send.call(this, body);
        };
        const input = document.querySelector("input[type=file]");
        const f = new File([new Uint8Array(2048)], "all-hands-recording.mp4", { type: "video/mp4" });
        Object.defineProperty(f, "size", { value: Math.round(1.6 * 1024 ** 3) });
        const list = { 0: f, length: 1, item: () => f, [Symbol.iterator]: function* () { yield f; } };
        Object.defineProperty(input, "files", { configurable: true, get: () => list });
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await h.loc({ role: "button", name: "Publish", exact: true }).waitFor();
      await h.sleep(600);
      await h.loc({ role: "button", name: "Publish", exact: true }).click();
      await h.loc({ text: /Keep this tab open until it finishes/ }).waitFor();
      await h.sleep(500);
      await parkMouse(h);
    },
    crop: async (h) => {
      const sel = await tagSmallest(h, "main", ["Uploading", "Keep this tab open"], "progress");
      const p = await h.loc(sel).boundingBox();
      const b = await h.loc({ role: "button", name: /Uploading/ }).boundingBox();
      return { box: { x: p.x - 20, y: p.y - 18, width: p.width + 40, height: b.y + b.height + 10 - (p.y - 18) } };
    },
    after: (h) => h.sandbox("/__sandbox/cleanup"),
  },

  // ── /files/limits: the per-file limit and the Storage meter ────────────────
  {
    id: "storage-meter",
    page: "/files/limits",
    kind: "screenshot",
    auth: "owner",
    url: "/upload",
    viewport: { width: 1440, height: 1200 },
    prepare: async (h) => {
      await h.loc({ role: "meter", name: "Storage" }).waitFor();
      await parkMouse(h);
    },
    // The bottom of the Publish panel: the Storage meter above the Publish button.
    crop: async (h) => {
      const pw = await h.loc({ text: "Password", exact: true }).boundingBox();
      const btn = await h.loc({ role: "button", name: /Publish$/ }).boundingBox();
      return { box: { x: btn.x - 20, y: pw.y - 20, width: btn.width + 40, height: btn.y + btn.height + 10 - (pw.y - 20) } };
    },
  },

  // ── /files/replace-and-versions: a new file picked in Artifact settings ────
  {
    id: "settings-file-tile",
    page: "/files/replace-and-versions",
    kind: "screenshot",
    auth: "owner",
    url: "/q3-board-deck",
    prepare: async (h) => {
      await escapeImmersive(h);
      await h.loc({ role: "button", name: "More artifact actions" }).click();
      await h.loc({ role: "menuitem", name: /Settings/ }).click();
      const drawer = h.page.getByRole("dialog", { name: "Artifact settings" });
      await drawer.waitFor();
      await drawer.locator("input[type=file]").setInputFiles({
        name: "Q3 Board Deck v2.pdf", mimeType: "application/pdf", buffer: readFileSync(fixtureFile("q3-board-deck-v2.pdf")),
      });
      await h.loc({ text: /Replaces the current file when you save/ }).waitFor();
      await h.sleep(800); // the drawer's slide-in
      await parkMouse(h);
    },
    // Title through the File tile and the Title field.
    crop: async (h) => {
      const d = await h.loc({ role: "dialog", name: "Artifact settings" }).boundingBox();
      const t = await h.loc({ text: "Shown in the browser tab and in link previews." }).boundingBox();
      return { box: { x: d.x, y: d.y, width: d.width, height: t.y + t.height + 20 - d.y } };
    },
  },

  // ── /files/replace-and-versions: replace a file, same link, open page updates (video) ─
  {
    id: "replace-a-file",
    page: "/files/replace-and-versions",
    kind: "video",
    videoId: "replace-a-file",
    auth: "owner",
    viewport: { width: 1920, height: 1080 },
    dpr: 1,
    prepare: async (h) => {
      state("deck-v1"); // the deck shows v1; the take replaces it with v2 (page 4 gains "Updated Oct 29")
      const { L, R } = await twoUp(h, "/q3-board-deck", "/q3-board-deck", {
        leftLabel: "Riya, the owner", rightLabel: "A reader with the link open: markdrop.in/q3-board-deck",
      });
      await L.frameLocator("iframe[src*='/v/pdf/']").getByText(/of 12/).first().waitFor({ timeout: 90_000 });
      await R.frameLocator("iframe[src*='/v/pdf/']").getByText(/of 12/).first().waitFor({ timeout: 90_000 });
      await h.sleep(1500);
      // The reader is on page 4.
      await R.frameLocator("iframe[src*='/v/pdf/']").locator(".page").nth(3).evaluate((el) => el.scrollIntoView({ block: "center" }));
      // The owner leaves full screen, so the top bar shows.
      await L.getByRole("button", { name: /Show details/ }).first().click();
      await h.sleep(1500);
    },
    steps: async (h) => {
      const L = h.page.frameLocator("#L"), R = h.page.frameLocator("#R");
      await h.caption("Riya found a mistake on page 4 of a deck she already shared", 3800);
      await h.caption("More artifact actions › Settings", 600);
      await h.click(L.getByRole("button", { name: "More artifact actions" }), { after: 700 });
      await h.click(L.getByRole("menuitem", { name: /Settings/ }), { after: 1200 });
      await h.caption("Under File, choose the corrected PDF", 500);
      const chooser = h.page.waitForEvent("filechooser");
      await h.click(L.getByRole("button", { name: /Q3 Board Deck\.pdf/ }), { after: 300 });
      await (await chooser).setFiles({ name: "Q3 Board Deck v2.pdf", mimeType: "application/pdf", buffer: readFileSync(fixtureFile("q3-board-deck-v2.pdf")) });
      await h.sleep(900);
      await h.hover(L.getByText(/Replaces the current file when you save/), 2500);
      await h.caption("Save changes: the link stays the same", 300);
      await h.click(L.getByRole("button", { name: "Save changes" }), { after: 400 });
      await L.getByRole("dialog", { name: "Artifact settings" }).waitFor({ state: "hidden", timeout: 30_000 }).catch(() => {});
      await h.caption("The reader's open page switches to the new version, no reload", 1500);
      const rpdf = R.frameLocator("iframe[src*='/v/pdf/']");
      await rpdf.getByText(/of 12/).first().waitFor({ timeout: 30_000 });
      await h.sleep(1200);
      await h.move([1440, 600]);
      await h.wheel(1, 1);
      await rpdf.locator(".page").nth(3).evaluate((el) => el.scrollIntoView({ block: "center", behavior: "smooth" }));
      await h.sleep(1500);
      await h.caption("Page 4 now shows the corrected figures", 600);
      await h.hover(rpdf.getByText("Updated Oct 29").first(), 3500);
    },
    after: async () => state("deck-reset"),
    poster: 9,
    tail: 1500,
  },

  // ── /files/supported-types: spreadsheet, Word, text viewers ────────────────
  {
    id: "viewer-sheet",
    page: "/files/supported-types",
    kind: "screenshot",
    auth: "owner", // q3-forecast is shared with the Acme team
    url: "/q3-forecast",
    prepare: async (h) => {
      await escapeImmersive(h);
      await viewerFrame(h, "sheet").getByRole("tablist").first().waitFor({ timeout: 60_000 });
      await h.sleep(1200);
      await parkMouse(h);
    },
    // Tabs and the grid (the workbook's first sheet is short).
    crop: async (h) => {
      const b = await h.loc("iframe[src*='/v/sheet/']").boundingBox();
      return { box: { x: b.x, y: b.y, width: b.width, height: 200 } };
    },
  },
  {
    id: "viewer-docx",
    page: "/files/supported-types",
    kind: "screenshot",
    auth: "owner", // shared with the Acme team
    url: "/onboarding-handbook",
    prepare: async (h) => {
      await escapeImmersive(h);
      await viewerFrame(h, "docx").locator("article").first().waitFor({ timeout: 60_000 });
      await h.sleep(1200);
      await parkMouse(h);
    },
    crop: { selector: "iframe[src*='/v/docx/']", pad: 0 },
  },
  {
    id: "viewer-text",
    page: "/files/supported-types",
    kind: "screenshot",
    auth: "anon",
    url: "/api-response",
    prepare: async (h) => {
      await escapeImmersive(h);
      await viewerFrame(h, "text").locator("#wrapBtn").waitFor({ timeout: 60_000 });
      await h.sleep(1000);
      await parkMouse(h);
    },
    crop: async (h) => {
      const b = await h.loc("iframe[src*='/v/text/']").boundingBox();
      return { box: { x: b.x, y: b.y, width: b.width, height: Math.min(b.height, 440) } };
    },
  },

  // ── /files/video-and-audio: the player's controls, and a codec it can't play ─
  {
    id: "video-player-controls",
    page: "/files/video-and-audio",
    kind: "screenshot",
    auth: "anon",
    url: "/product-demo",
    prepare: async (h) => {
      await showDetails(h);
      const f = viewerFrame(h, "video");
      await f.locator("#play").waitFor({ timeout: 60_000 });
      await f.locator("#play").click();
      await h.sleep(6000);
      await f.locator("#play").click(); // pause mid-video
      await h.sleep(400);
      const box = await h.loc("iframe[src*='/v/video/']").boundingBox();
      await h.page.mouse.move(box.x + box.width / 2, box.y + box.height - 40);
      await h.sleep(300);
      await f.locator("#speedBtn").click();
      await h.sleep(500);
    },
    crop: { selector: "iframe[src*='/v/video/']", pad: 0 },
  },
  {
    id: "video-cant-play",
    page: "/files/video-and-audio",
    kind: "screenshot",
    auth: "anon",
    url: "/screen-recording",
    prepare: async (h) => {
      // This Chrome decodes HEVC (macOS hardware), so stand in for one that can't: the video bytes
      // arrive undecodable, while the player's 1-byte status probe gets the real answer (206).
      await h.page.route(/\/r\/art\/.+\.mov(\?|$)/, (route) => {
        if (route.request().headers().range === "bytes=0-0") return route.continue();
        return route.fulfill({ status: 200, contentType: "video/quicktime", body: Buffer.alloc(8192, 7) });
      });
      await h.page.reload({ waitUntil: "domcontentloaded" });
      await h.settle(800);
      await showDetails(h);
      const f = viewerFrame(h, "video");
      await f.locator("#big").click({ timeout: 5000 }).catch(() => {});
      await f.locator("#err").waitFor({ timeout: 30_000 });
      await h.sleep(500);
      await parkMouse(h);
    },
    crop: { selector: "iframe[src*='/v/video/']", pad: 0 },
  },

  // ── /files/video-and-audio: upload a recording, share it, a reader plays it (video) ─
  {
    id: "video-player",
    page: "/files/video-and-audio",
    kind: "video",
    videoId: "video-player",
    auth: "owner",
    url: "/upload",
    prepare: async (h) => {
      await h.loc({ role: "button", name: "Choose a file" }).waitFor();
      await h.sleep(600);
    },
    steps: async (h) => {
      await h.caption("Upload a screen recording at markdrop.in/upload", 1200);
      const chooser = h.page.waitForEvent("filechooser");
      await h.click({ role: "button", name: "Choose a file" }, { after: 200 });
      await (await chooser).setFiles({ name: "acme-cloud-tour.mp4", mimeType: "video/mp4", buffer: readFileSync(fixtureFile("product-demo-v2.mp4")) });
      await h.loc({ text: /Will render as a playable video/ }).waitFor();
      await h.sleep(2200);
      await h.caption("Publish: the file goes straight to storage", 300);
      // A real connection, not localhost: about 5 s for the 1.5 MB recording.
      const cdp = await h.context.newCDPSession(h.page);
      await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 20, downloadThroughput: -1, uploadThroughput: 300 * 1024 });
      await h.click({ role: "button", name: "Publish", exact: true }, { after: 300 });
      await h.page.waitForURL(/\/acme-cloud-tour/, { timeout: 60_000 });
      await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await h.settle(1500);
      await h.caption("Copy the link and send it", 400);
      await h.click({ role: "button", name: "Copy link" }, { after: 1600 });
      await h.caption("A reader opens the link: it plays in place, no download", 300);
      await signInAs(h, "anon");
      await h.goto("/acme-cloud-tour", { settle: 1200 });
      await h.click({ role: "button", name: /Show details/ }, { after: 1000 }); // the page around the player
      const f = viewerFrame(h, "video");
      await f.locator("#big").waitFor({ timeout: 60_000 });
      await h.sleep(800);
      await h.click(f.locator("#big"), { after: 3500 });
      await h.caption("Jump anywhere: it starts playing straight away", 300);
      const bar = f.locator("#bar");
      const bb = await bar.boundingBox();
      await h.click([bb.x + bb.width * 0.6, bb.y + bb.height / 2], { after: 3000 });
      await h.caption("Playback speed", 300);
      await h.click(f.locator("#speedBtn"), { after: 700 });
      await h.click(f.getByText("1.5×", { exact: true }).first(), { after: 3000 });
      await h.caption("Picture in picture and full screen sit beside it", 300);
      await h.hover(f.locator("#fs").locator("xpath=preceding-sibling::*[1]"), 1400);
      await h.hover(f.locator("#fs"), 2400);
      await h.caption("");
    },
    after: async (h) => {
      await h.sandbox("/__sandbox/cleanup");
    },
    poster: 24,
    tail: 800,
  },

  // ── /files/websites: zip a site, upload, open it and click around (video) ──
  {
    id: "publish-zipped-site",
    page: "/files/websites",
    kind: "video",
    videoId: "publish-zipped-site",
    auth: "owner",
    url: "/upload",
    prepare: async (h) => {
      await h.loc({ role: "button", name: "Choose a file" }).waitFor();
      await h.sleep(600);
    },
    steps: async (h) => {
      await h.caption("A site folder (index.html, guides/, faq.html, css/, js/) zipped as site.zip", 3000);
      await h.caption("Drop site.zip on markdrop.in/upload", 300);
      const chooser = h.page.waitForEvent("filechooser");
      await h.click({ role: "button", name: "Choose a file" }, { after: 200 });
      await (await chooser).setFiles({ name: "site.zip", mimeType: "application/zip", buffer: readFileSync(extraFile("site.zip")) });
      await h.loc({ text: /Will render as a multi-page site/ }).waitFor();
      await h.sleep(600);
      await h.caption("Markdrop recognises it as a multi-page site", 300);
      await h.hover({ text: /Will render as a multi-page site/ }, 2400);
      await h.caption("Give it a title and a link", 300);
      await h.type({ role: "textbox", name: "Title" }, "Acme Help Center", { clear: true });
      await h.type({ role: "textbox", name: "Link" }, "acme-help-center", { clear: true });
      await h.sleep(800);
      await h.caption("Publish: Markdrop unpacks it and opens index.html", 300);
      await h.click({ role: "button", name: "Publish", exact: true }, { after: 300 });
      await h.page.waitForURL(/\/acme-help-center/, { timeout: 60_000 });
      await h.settle(2000);
      await h.press("Escape", 900);
      await h.caption("Links between the pages work, like on any website", 600);
      const site = h.page.frameLocator("iframe").first();
      await site.getByRole("link", { name: "Setup", exact: true }).waitFor({ timeout: 30_000 });
      await h.click(site.getByRole("link", { name: "Setup", exact: true }), { after: 2600 });
      await h.click(site.getByRole("link", { name: "FAQ", exact: true }), { after: 2600 });
      await h.click(site.getByRole("link", { name: "Acme Help", exact: true }), { after: 2400 });
      await h.caption("");
    },
    after: async (h) => {
      await h.sandbox("/__sandbox/cleanup");
    },
    poster: 9,
    tail: 600,
  },

  // ── /files/websites: a zip recognised as a site ────────────────────────────
  {
    id: "zip-detected",
    page: "/files/websites",
    kind: "screenshot",
    auth: "owner",
    url: "/upload",
    prepare: async (h) => {
      await chooseFile(h, extraFile("site.zip"), "site.zip", "application/zip");
      await h.loc({ text: /Will render as a multi-page site/ }).waitFor();
      await h.sleep(1200);
      await parkMouse(h);
    },
    crop: async (h) => {
      const row = await tagSmallest(h, "main", ["site.zip", "Will render as a multi-page site", "Remove"], "filerow");
      const t = await h.loc({ text: "Your file", exact: true }).boundingBox();
      const r = await h.loc(row).boundingBox();
      return { box: { x: r.x - 20, y: t.y - 16, width: r.width + 40, height: r.y + r.height + 20 - (t.y - 16) } };
    },
  },

  // ── /sharing/who-can-open: the private gate ────────────────────────────────
  {
    id: "gate-private",
    page: "/sharing/who-can-open",
    kind: "screenshot",
    auth: "anon",
    url: "/sales-playbook",
    prepare: async (h) => {
      await h.loc({ role: "heading", name: "This document is private" }).waitFor();
      await h.sleep(800);
      await parkMouse(h);
    },
    crop: { selector: "section[aria-labelledby='md-gate-title']", pad: 32 },
  },

  // ── /sharing/share-with-people: People with access ─────────────────────────
  {
    id: "share-people-section",
    page: "/sharing/share-with-people",
    kind: "screenshot",
    auth: "owner",
    url: "/onboarding-guide",
    prepare: async (h) => {
      state("shares-reset");
      await h.page.reload({ waitUntil: "domcontentloaded" });
      await h.settle(800);
      await escapeImmersive(h);
      await h.loc({ role: "button", name: "Share" }).click();
      const box = h.loc({ role: "combobox", name: "Add people by email" });
      await box.waitFor();
      await h.sleep(700);
      await box.click();
      await h.page.keyboard.type("dana@globex.com");
      await h.page.keyboard.press("Enter");
      await h.sleep(400);
      await h.loc(".md-dialog__title").click(); // out of the field: the suggestions close
      await h.sleep(500);
      await parkMouse(h);
    },
    crop: async (h) => {
      const top = await h.loc({ text: "People with access", exact: true }).boundingBox();
      const sw = await h.loc({ text: "They can never give more access than they have themselves." }).boundingBox();
      const d = await h.loc(".md-dialog").boundingBox();
      return { box: { x: d.x, y: top.y - 16, width: d.width, height: sw.y + sw.height + 16 - (top.y - 16) } };
    },
    after: async () => state("shares-reset"),
  },

  // ── /sharing/share-with-people: add a person, they find it (video) ─────────
  {
    id: "share-with-people",
    page: "/sharing/share-with-people",
    kind: "video",
    videoId: "share-with-people",
    auth: "owner",
    url: "/roadmap-2027",
    prepare: async (h) => {
      state("shares-reset"); // roadmap-2027 is Only people added, shared with nobody
      await h.page.reload({ waitUntil: "domcontentloaded" });
      await h.settle(1200);
      await escapeImmersive(h);
    },
    steps: async (h) => {
      await h.caption("A private document: Share › People with access", 900);
      await h.click({ role: "button", name: "Share" }, { after: 1200 });
      await h.caption("Type an address and press Enter", 300);
      await h.type({ role: "combobox", name: "Add people by email" }, "alex@acme.com");
      await h.press("Enter", 900);
      await h.caption("Choose Can view or Can edit", 300);
      await h.click({ role: "combobox", name: "Their access" }, { after: 400 });
      await h.page.getByRole("combobox", { name: "Their access" }).selectOption({ label: "Can edit" });
      await h.sleep(900);
      await h.caption("Email them, with a note", 300);
      await h.click({ role: "button", name: "Add a message" }, { after: 500 });
      await h.type(h.page.locator(".md-dialog textarea").first(), "Here's the 2027 roadmap draft for Thursday. Edits welcome.");
      await h.sleep(700);
      await h.click(h.page.locator(".md-dialog").getByRole("button", { name: "Share", exact: true }), { after: 600 });
      await h.caption("Shared and emailed: Alex can open it once signed in", 3200);
      await h.caption("Alex signs in with alex@acme.com: it's under Shared with me", 300);
      await signInAs(h, "alex");
      await h.goto("/shared", { settle: 1200 });
      await h.hover({ role: "link", name: /Roadmap 2027/ }, 2600);
      await h.caption("And it opens", 300);
      await hideGateFlash(h);
      await h.goto("/roadmap-2027", { settle: 1500 });
      await h.press("Escape", 1200);
      await h.wheel(400, 14);
      await h.sleep(1600);
    },
    after: async () => state("shares-reset"),
    poster: 9,
    tail: 600,
  },

  // ── /sharing/request-access: ask, answer, get in (video) ───────────────────
  {
    id: "request-access",
    page: "/sharing/request-access",
    kind: "video",
    videoId: "request-access",
    auth: "dana",
    url: "/q3-plan-internal",
    prepare: async (h) => {
      state("dana-no-request");
      await h.page.reload({ waitUntil: "domcontentloaded" });
      await h.settle(1200);
      await h.loc({ role: "heading", name: "You don't have access yet" }).waitFor();
    },
    steps: async (h) => {
      await h.caption("Dana opens a link that isn't shared with her", 3000);
      await h.caption("She adds a note and asks the owner", 300);
      await h.type({ label: "Message (optional)" }, "Hi Riya, I'm presenting the hiring numbers on Thursday.");
      await h.sleep(600);
      await h.click({ role: "button", name: "Request access" }, { after: 1200 });
      await h.loc({ role: "heading", name: "Request sent" }).waitFor();
      await h.hover({ text: /You'll get an email when/ }, 2500);
      await h.caption("Riya, the owner: Shared with me › Access requests", 300);
      await signInAs(h, "riya");
      await h.goto("/shared", { settle: 1200 });
      await h.hover({ role: "region", name: /Access requests/ }, 1800);
      await h.click({ role: "link", name: "Review" }, { after: 300 });
      await h.page.waitForURL(/\/requests\//);
      await h.settle(1200);
      await h.caption("Let them view, Let them edit, or Decline", 2400);
      await h.click({ role: "button", name: "Let them view" }, { after: 2600 });
      await h.caption("Dana opens the link again: she's in", 300);
      await signInAs(h, "dana");
      await hideGateFlash(h);
      await h.goto("/q3-plan-internal", { settle: 1500 });
      await h.press("Escape", 1200);
      await h.wheel(400, 14);
      await h.sleep(1800);
    },
    after: async () => state("dana-pending"),
    poster: 13,
    tail: 600,
  },

  // ── /sharing/request-access: the ask screen and the owner's review ─────────
  {
    id: "request-access-gate",
    page: "/sharing/request-access",
    kind: "screenshot",
    auth: "dana",
    url: "/q3-plan-internal",
    prepare: async (h) => {
      state("dana-no-request");
      await h.page.reload({ waitUntil: "domcontentloaded" });
      await h.settle(800);
      await h.loc({ role: "heading", name: "You don't have access yet" }).waitFor();
      await h.loc({ label: "Message (optional)" }).fill("Hi, I need this for Thursday's review.");
      await h.page.locator("body").click({ position: { x: 5, y: 600 } });
      await h.sleep(500);
      await parkMouse(h);
    },
    crop: { selector: "section[aria-labelledby='md-gate-title']", pad: 32 },
    after: async () => state("dana-pending"),
  },
  {
    id: "request-review",
    page: "/sharing/request-access",
    kind: "screenshot",
    auth: "owner",
    url: (fx) => `/requests/${fx.access_request}`,
    prepare: async (h) => {
      state("dana-pending");
      await h.page.reload({ waitUntil: "domcontentloaded" });
      await h.settle(800);
      await h.loc({ role: "region", name: "The request" }).waitFor();
      await parkMouse(h);
    },
    crop: { union: [{ text: "Access request", exact: true }, { role: "region", name: "The request" }], pad: 24 },
  },

  // ── /sharing/end-to-end-encryption: encrypt, publish, the key in the link (video) ─
  {
    id: "encrypt-a-document",
    page: "/sharing/end-to-end-encryption",
    kind: "video",
    videoId: "encrypt-a-document",
    auth: "anon",
    url: "/new",
    prepare: async (h) => {
      await h.page.evaluate(() => localStorage.removeItem("md_new_draft"));
      await h.loc({ role: "textbox", name: "Markdown" }).waitFor();
    },
    steps: async (h) => {
      await h.caption("Write the document as usual", 300);
      await h.type({ role: "textbox", name: "Title" }, "Board prep — private notes", { speed: 1.5 });
      await h.paste({ role: "textbox", name: "Markdown" },
        "## Before Thursday\n\n- Q3 bookings: $1.14M, 19% over plan\n- Ask: approve two senior hires for the Workflows team\n- Risk: Northwind renewal slips to January\n\n## Talking points\n\n1. Net revenue retention at 124%\n2. Workflows beta opens January 12\n");
      await h.sleep(1200);
      await h.caption("Encryption › Encrypt in this browser", 300);
      await h.click({ role: "button", name: /^Encryption: / }, { after: 700 });
      await h.click(".md-popover label.md-switch", { after: 1200 });
      await h.hover({ text: "The link is the key" }, 2600);
      await h.press("Escape", 600);
      // The edit secret is real (in the sandbox): the page only ever gets its start.
      await h.page.route(`${h.API}/api/v1/documents`, async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const res = await route.fetch();
        const body = await res.json();
        if (typeof body.edit_secret === "string") body.edit_secret = `${body.edit_secret.slice(0, 11)}${"•".repeat(24)}`;
        return route.fulfill({ response: res, json: body });
      });
      await h.caption("Publish: your browser encrypts it first", 300);
      const cdp = await h.context.newCDPSession(h.page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 8 });
      await h.click({ role: "button", name: "Publish", exact: true }, { after: 100 });
      await h.page.waitForURL((u) => !u.pathname.startsWith("/new"), { timeout: 60_000 });
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      await h.settle(1200);
      await h.caption("Published: the key is in the link, after #k=", 300);
      await h.hover({ text: "End-to-end encrypted. The key is in this link." }, 2400);
      await h.click({ role: "button", name: "Copy link" }, { after: 600 });
      const copied = await h.page.evaluate(() => navigator.clipboard.readText());
      // The app writes its public address (markdrop.in); open the same path on the sandbox.
      const link = copied.replace(/^https?:\/\/[^/]+/, h.APP);
      await h.caption(`Copied: ${prodUrl(h, link).replace(/(#k=.{6}).*/, "$1…")}`, 3000);
      // As another browser: forget the copy of the key this one keeps for documents it published.
      const forgetKeys = () => h.page.evaluate(() => localStorage.removeItem("markdrop_doc_keys"));
      await h.caption("Someone with the whole link: it opens", 300);
      await forgetKeys();
      await h.goto(link, { settle: 1500 });
      await h.press("Escape", 900);
      await h.sleep(2200);
      await h.caption("");
      await forgetKeys();
      await h.goto(link.split("#")[0], { settle: 1200 });
      await h.caption("The same link without the #k= part: nobody can read it, not even Markdrop", 300);
      await h.sleep(3500);
    },
    after: async (h) => {
      await h.sandbox("/__sandbox/cleanup");
    },
    poster: 10,
    tail: 600,
  },

  // ── /sharing/end-to-end-encryption: the Encryption popover ─────────────────
  {
    id: "encrypt-chip",
    page: "/sharing/end-to-end-encryption",
    kind: "screenshot",
    auth: "anon",
    url: "/new",
    prepare: async (h) => {
      await h.loc({ role: "button", name: /^Encryption: / }).click();
      await h.loc(".md-popover label.md-switch").click();
      await h.loc({ text: "The link is the key" }).waitFor();
      await h.sleep(600);
      await parkMouse(h);
    },
    crop: { union: [{ text: "Publish settings", exact: true }, "button:has-text('Random link')", ".md-popover"], pad: 16 },
  },

  // ── /account/api-tokens ────────────────────────────────────────────────────
  {
    id: "token-created",
    page: "/account/api-tokens",
    kind: "screenshot",
    auth: "owner",
    url: "/settings/tokens",
    prepare: async (h) => {
      state("tokens-reset");
      await h.loc({ role: "button", name: "Create token" }).click();
      const dialog = h.page.getByRole("dialog", { name: "Create token" });
      await dialog.getByRole("textbox", { name: "Name" }).fill("Work laptop");
      await dialog.getByRole("button", { name: "Create token" }).click();
      const tok = h.page.getByRole("textbox", { name: "Your new token" });
      await tok.waitFor();
      // The token is real (in the sandbox): show only its start.
      await tok.evaluate((el) => { el.value = `${el.value.slice(0, 12)}••••••••••••••••••••••••••••••`; });
      await h.sleep(700);
      await parkMouse(h);
    },
    crop: { selector: ".md-dialog", pad: 0 },
    after: async () => state("tokens-reset"),
  },
  {
    id: "tokens-list",
    page: "/account/api-tokens",
    kind: "screenshot",
    auth: "owner",
    url: "/settings/tokens",
    prepare: async (h) => {
      state("tokens-reset");
      await h.page.reload({ waitUntil: "domcontentloaded" });
      await h.settle(600);
      await h.loc({ role: "button", name: "More actions for Nightly report" }).click();
      await h.loc(".md-menu").waitFor();
      await h.sleep(400);
      await h.page.mouse.move(1000, 700);
    },
    crop: { union: [{ role: "table", name: "API tokens" }, ".md-menu"], pad: 16 },
  },

  // ── /account/connected-apps ────────────────────────────────────────────────
  {
    id: "connected-apps-list",
    page: "/account/connected-apps",
    kind: "screenshot",
    auth: "owner",
    url: "/settings/connections",
    prepare: async (h) => {
      await h.loc({ role: "region", name: "Your connected apps" }).waitFor();
      await h.sleep(500);
      await parkMouse(h);
    },
    crop: { selector: "section[aria-label='Your connected apps']", pad: 16 },
  },
];
