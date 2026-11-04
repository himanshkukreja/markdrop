/**
 * Opening an item from the workspace listing (fix/open-flash): what the new tab paints between the
 * click and the content. An init script samples the page from its first parse (a MutationObserver
 * plus a 30 ms timer) and keeps one entry per distinct look:
 *
 *   chrome  which top bars are on screen: "site" (the app header), "docbar" (a classic document's
 *           bar), "page" (a page's one bar), "artifact" (a file's bar), joined with "+"
 *   body    what the content area shows: "skeleton", "loader", "gate", "cover" (a file's frame
 *           cover), "frame" (the file), "content" (the document's text) or "empty"
 *   theme   the resolved theme (html[data-theme] or the body background)
 *
 * `foreign(timeline)` lists every entry whose chrome or theme differs from where the tab settled:
 * that is the flash this branch removes. A loading body is fine as long as it sits in the target's
 * chrome.
 */

export function probeScript() {
  if (window.top !== window || location.pathname.startsWith("/w/")) return;
  const t0 = performance.now();
  const out = (window.__open = []);
  // On screen and on top: not hidden, not transparent, and what the viewport shows at its centre
  // (a full-screen layer over the app hides the app under it).
  const onTop = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) return false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) < 0.05) return false;
    }
    const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1);
    const y = Math.min(Math.max(r.top + Math.min(r.height / 2, 24), 1), innerHeight - 1);
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
  };
  const any = (sel, root = document) => [...root.querySelectorAll(sel)].some(onTop);
  const COVER = "[data-frame-cover][aria-hidden='false'], .absolute.inset-0.z-10.bg-bg[aria-hidden='false']";
  const sig = () => {
    const d = document;
    if (!d.body || !d.body.firstElementChild) return { chrome: "", body: "blank", theme: "" };
    const chrome = [];
    if ([...d.querySelectorAll("header")].some((h) => !h.classList.contains("pb-barwrap") && !h.closest(".pb-barwrap") && onTop(h))) chrome.push("site");
    if (any("div.sticky.top-14")) chrome.push("docbar");
    if (any(".pb-barwrap")) chrome.push("page");
    if (any("[aria-label='More artifact actions']")) chrome.push("artifact");
    const opening = d.querySelector("[data-opening-cover]");
    const openingShown = opening && getComputedStyle(opening).display !== "none";
    let body = "empty";
    if (openingShown && any("[data-opening-cover] [class*='openingBar']")) { chrome.push("page"); body = "skeleton"; }
    else if (openingShown) body = any("[data-opening-cover] .md-loader") ? "loader" : "ground";
    else if (any("section[aria-labelledby='md-gate-title']")) body = "gate";
    else if (any(COVER)) body = any(`${COVER.split(",")[0]} .md-loader, .absolute.inset-0.z-10.bg-bg .md-loader`) ? "cover" : "ground";
    else if (any("iframe, video")) body = "frame";
    else if ([...d.querySelectorAll("p, li, td, h1")].some((e) => /Everything we agreed|Region 1|An HTML artifact/.test(e.textContent || "") && onTop(e))) body = "content";
    else if (any("[aria-busy='true'] .md-skeleton, .md-skeleton")) body = "skeleton";
    else if (any(".md-loader")) body = "loader";
    else if ((d.body.innerText || "").trim()) body = "text";
    const html = d.documentElement;
    const theme = html.dataset.theme || getComputedStyle(d.body).backgroundColor;
    return { chrome: [...new Set(chrome)].join("+"), body, theme };
  };
  let last = "";
  const take = () => {
    const s = sig();
    const k = `${s.chrome}|${s.body}|${s.theme}`;
    if (k === last) return;
    last = k;
    out.push({ t: Math.round(performance.now() - t0), ...s });
  };
  let queued = false;
  const soon = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; take(); });
  };
  new MutationObserver(soon).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  setInterval(take, 30);
  take();
}

/** Arm a context: every item tab it opens records its timeline in window.__open. */
export async function armOpenProbe(context) {
  await context.addInitScript(probeScript);
}

/** Read a tab's timeline once it has settled (no new entry for `quiet` ms and the body is content
 *  or a frame), or after `timeout`. */
export async function settledTimeline(p, { quiet = 1500, timeout = 60000 } = {}) {
  const until = Date.now() + timeout;
  let n = -1, since = Date.now();
  for (;;) {
    const tl = (await p.evaluate(() => window.__open || []).catch(() => [])) || [];
    if (tl.length !== n) { n = tl.length; since = Date.now(); }
    const end = tl[tl.length - 1];
    if (end && ["content", "frame"].includes(end.body) && Date.now() - since >= quiet) return tl;
    if (Date.now() > until) return tl;
    await p.waitForTimeout(100);
  }
}

/** Entries painted before the tab settled whose chrome or theme isn't the final one. The blank
 *  first paint (no body yet) is not a look. */
export function foreign(tl) {
  const end = tl[tl.length - 1];
  if (!end) return [];
  return tl.filter((e) => e.body !== "blank" && (e.chrome !== end.chrome || e.theme !== end.theme));
}

export const fmt = (tl) => tl.map((e) => `${e.t}ms ${e.chrome || "∅"}/${e.body}/${e.theme}`).join("  →  ");

/** Chrome DevTools' "Slow 3G" (2 s RTT, 400 kbit/s), per request, on both engines (a route: WebKit
 *  has no network emulation): `app` and `api` fetched and held back, `worker` delayed only (its
 *  ranges and streams pass through untouched). */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function slow3g(c, { app, api, worker }) {
  const LAT = 2000, BPS = 400_000 / 8;
  await c.route((u) => u.href.startsWith(app) || u.href.startsWith(api), async (r) => {
    try {
      const resp = await r.fetch();
      const body = await resp.body();
      await sleep(LAT / 2 + (body.length / BPS) * 1000);
      const headers = { ...resp.headers() };
      delete headers["content-encoding"];
      delete headers["content-length"];
      delete headers["transfer-encoding"];
      await r.fulfill({ status: resp.status(), headers, body });
    } catch {
      await r.continue().catch(() => {});
    }
  });
  await c.route((u) => u.href.startsWith(worker), async (r) => {
    await sleep(LAT / 2);
    await r.continue().catch(() => {});
  });
}

/** Where each kind settles for someone who can read it: a page in its own one bar; a document and
 *  a file full screen (no bar), the document's text or the file's frame. */
export const TARGET = {
  page: { chrome: "page", body: "content" },
  doc: { chrome: "", body: "content" },
  html: { chrome: "", body: "frame" }, pdf: { chrome: "", body: "frame" },
  sheet: { chrome: "", body: "frame" }, video: { chrome: "", body: "frame" },
};
