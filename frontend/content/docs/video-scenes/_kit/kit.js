/**
 * Scene kit: time helpers, a cursor, captions and window frames for the docs' animated scenes.
 *
 * A scene is a PURE function of time. It calls `scene({...meta}, render)`; the renderer
 * (frontend/scripts/docs-media/scenes/render.mjs) loads the page with ?render=1, waits for
 * `window.__ready`, then calls `window.__setTime(t)` for every frame at 30 fps and screenshots it.
 * Nothing may depend on the wall clock: no CSS transitions or animations, no timers, no
 * Math.random (use `rand(seed)`).
 *
 * Opened in a normal browser (without ?render), a scene plays itself with a scrubber, for previews.
 */

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, k) => a + (b - a) * k;
export const E = {
  linear: (x) => x,
  in: (x) => x * x * x,
  out: (x) => 1 - Math.pow(1 - x, 3),
  outQuart: (x) => 1 - Math.pow(1 - x, 4),
  inOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  outBack: (x) => {
    const c1 = 1.5, c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  },
  outExpo: (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x)),
};
/** Progress of t through [a, b], eased (0 before a, 1 after b). */
export const p = (t, a, b, ease = E.inOut) => (b <= a ? (t >= b ? 1 : 0) : ease(clamp((t - a) / (b - a))));
/** In over [a, a+fi], out over [b-fo, b]: 0 → 1 → 0. */
export const win = (t, a, b, fi = 0.35, fo = 0.35, ease = E.inOut) => Math.min(p(t, a, a + fi, ease), 1 - p(t, b - fo, b, ease));
/** Deterministic pseudo-random numbers (mulberry32). */
export function rand(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
/** An element from an HTML string. */
export function h(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
/** Set visual state: o(pacity), x, y, s(cale), r(otate deg), blur, show. */
export function set(el, st) {
  if (!el) return;
  const { o, x = 0, y = 0, s = 1, sx, sy, r = 0, blur, show, origin } = st;
  if (show !== undefined) el.style.display = show ? "" : "none";
  if (o !== undefined) el.style.opacity = String(Math.round(clamp(o) * 1000) / 1000);
  const sX = sx ?? s, sY = sy ?? s;
  el.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)${sX !== 1 || sY !== 1 ? ` scale(${sX.toFixed(4)}, ${sY.toFixed(4)})` : ""}${r ? ` rotate(${r.toFixed(2)}deg)` : ""}`;
  if (origin) el.style.transformOrigin = origin;
  if (blur !== undefined) el.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "";
}
/** Common entrance: fade + rise, eased. */
export function rise(el, t, a, d = 0.55, dist = 18, extra = {}) {
  const k = p(t, a, a + d, E.out);
  set(el, { o: k, y: (1 - k) * dist, ...extra });
  return k;
}
export const fmt = {
  mmss: (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`,
};

/* ── Icons (24×24 strokes) ─────────────────────────────────────────────── */
const P = {
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 7.6-1.7"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6"/>',
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3 19.5c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><path d="M15.5 5.6a3.2 3.2 0 0 1 0 6"/><path d="M17.5 14.7c1.9.6 3.1 2.2 3.5 4.8"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.4 2.4 3.6 5.2 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.2-3.6-8.5S9.6 5.9 12 3.5z"/>',
  doc: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/><path d="M9 12.5h6M9 16h4"/>',
  link: '<path d="M10 14a4.2 4.2 0 0 0 6 0l3-3a4.2 4.2 0 0 0-6-6l-1 1"/><path d="M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.2 4.2 0 0 0 6 6l1-1"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8.5-8.5M16.5 6.5l2.5 2.5M14.5 8.5l2 2"/>',
  server: '<rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M8 7.5h.01M8 16.5h.01"/>',
  laptop: '<rect x="5" y="5" width="14" height="10" rx="1.6"/><path d="M2.5 19h19"/>',
  phone: '<rect x="7" y="2.8" width="10" height="18.4" rx="2.4"/><path d="M11 18h2"/>',
  check: '<path d="M5 12.5l4.2 4.2L19 7"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  film: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7.5 4.5v15M16.5 4.5v15M3.5 9h4M3.5 15h4M16.5 9h4M16.5 15h4"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  upload: '<path d="M12 16V4.5M7 9.5l5-5 5 5"/><path d="M4.5 16.5v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2"/>',
  cloud: '<path d="M7 18.5a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 9a4.8 4.8 0 0 1-.5 9.5z"/>',
  sync: '<path d="M4.5 10a7.5 7.5 0 0 1 13.4-3.6L20 8.5"/><path d="M20 4v4.5h-4.5"/><path d="M19.5 14a7.5 7.5 0 0 1-13.4 3.6L4 15.5"/><path d="M4 20v-4.5h4.5"/>',
  warn: '<path d="M12 4l9 15.5H3z"/><path d="M12 10v4M12 17h.01"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  tool: '<path d="M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3l7.5-7.5"/><path d="M14.5 6.5L17 4l3 3-2.5 2.5"/>',
  building: '<path d="M5 20.5V5a1.5 1.5 0 0 1 1.5-1.5h7A1.5 1.5 0 0 1 15 5v15.5"/><path d="M15 9.5h3.5A1.5 1.5 0 0 1 20 11v9.5M3 20.5h18M8.5 7.5h3M8.5 11h3M8.5 14.5h3"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5M12 8v4l3 2"/>',
  dns: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M3.5 14.5h17M7 7h.01M7 12h.01M7 17h.01"/>',
  wall: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 9.3h18M3 14.7h18M9 4v5.3M15 4v5.3M6 9.3v5.4M12 9.3v5.4M18 9.3v5.4M9 14.7V20M15 14.7V20"/>',
  chart: '<path d="M4 19.5h16"/><path d="M5 15c3-1 4-8 7-8s3.5 5 7 6"/>',
  sparkle: '<path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  dots: '<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  fwd: '<path d="M9 6l6 6-6 6"/>',
  send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  branch: '<circle cx="7" cy="6" r="2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="8" r="2"/><path d="M7 8v8M17 10c0 4-10 2-10 6"/>',
  md: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M6.5 15V9l2.5 3 2.5-3v6M15.5 9v6M13.5 13l2 2 2-2"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4L18 18M6 18l1.6-1.6M16.4 7.6L18 6"/>',
};
export function icon(name, { size, cls = "", sw = 2 } = {}) {
  const st = size ? ` style="font-size:${size}px"` : "";
  const fill = name === "play" ? "currentColor" : "none";
  return `<span class="ico ${cls}"${st}><svg viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${P[name] || ""}</svg></span>`;
}

/* ── Scene registration ────────────────────────────────────────────────── */
const params = new URLSearchParams(location.search);
export const RENDER = params.has("render");

/**
 * meta: { duration (s), width, height, poster (s), chapters: [{t, title}], out: {...} } —
 * `out` tells the renderer where the result goes (see render.mjs).
 */
export function scene(meta, render) {
  const stage = document.getElementById("stage");
  const W = meta.width || 1600, H = meta.height || 900;
  stage.style.setProperty("--w", `${W}px`);
  stage.style.setProperty("--h", `${H}px`);
  document.documentElement.dataset.theme = params.get("theme") || meta.theme || "light";
  window.__scene = { fps: 30, ...meta, width: W, height: H };
  let last = -1;
  // render may return a Promise (a scene seeking a <video>): the renderer waits for it.
  window.__setTime = (t) => {
    last = t;
    return render(Math.max(0, Math.min(t, meta.duration)));
  };
  window.__ready = (async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((im) => (im.complete ? (im.decode ? im.decode().catch(() => {}) : 0) : new Promise((r) => { im.onload = im.onerror = r; }))));
    await Promise.all([...document.querySelectorAll("video")].map((v) => (v.readyState >= 2 ? 0 : new Promise((r) => { v.addEventListener("canplay", r, { once: true }); v.addEventListener("error", r, { once: true }); v.load(); }))));
    await render(0);
    await document.fonts.ready;
    return true;
  })();
  if (!RENDER) preview(meta, () => last);
  return stage;
}

function preview(meta) {
  const bar = h(`<div style="position:fixed;left:0;right:0;bottom:0;height:40px;background:#111a2ce6;color:#fff;display:flex;align-items:center;gap:12px;padding:0 14px;font:600 13px Manrope,system-ui;z-index:999">
    <button id="pv-play" style="font:inherit">❚❚</button><input id="pv-t" type="range" min="0" max="${meta.duration}" step="0.0333" style="flex:1"><span id="pv-l" style="width:90px;text-align:right"></span></div>`);
  document.body.appendChild(bar);
  document.documentElement.style.overflow = "auto";
  document.body.style.overflow = "auto";
  let playing = true, t = Number(params.get("t") || 0), t0 = performance.now() - t * 1000;
  const r = bar.querySelector("#pv-t"), l = bar.querySelector("#pv-l"), b = bar.querySelector("#pv-play");
  b.onclick = () => { playing = !playing; b.textContent = playing ? "❚❚" : "▶"; t0 = performance.now() - t * 1000; };
  r.oninput = () => { t = Number(r.value); t0 = performance.now() - t * 1000; window.__setTime(t); l.textContent = `${t.toFixed(2)} s`; };
  window.__ready.then(() => {
    const loop = () => {
      if (playing) {
        t = ((performance.now() - t0) / 1000) % meta.duration;
        window.__setTime(t);
        r.value = String(t);
        l.textContent = `${t.toFixed(2)} s`;
      }
      requestAnimationFrame(loop);
    };
    loop();
  });
}

/* ── Typing ────────────────────────────────────────────────────────────── */
/** Human-paced typing schedule: `at(t)` is the text typed by time t. */
export function typing(text, { start = 0, cps = 15, seed = 7, burst = 1 } = {}) {
  const r = rand(seed);
  const times = [];
  let tt = start;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    let d = (1 / cps) * (0.55 + r() * 0.9);
    if (/[\s]/.test(ch)) d *= 1.5;
    if (/[.,:;!?/]/.test(text[i - 1] || "")) d *= 1.6;
    tt += d / burst;
    times.push(tt);
  }
  return {
    start,
    end: times.length ? times[times.length - 1] : start,
    at(t) {
      let n = 0;
      while (n < times.length && times[n] <= t) n++;
      return text.slice(0, n);
    },
    done(t) { return !times.length || t >= times[times.length - 1]; },
  };
}

/* ── Cursor ────────────────────────────────────────────────────────────── */
/**
 * keys: [{t, x, y, click?, dur?, hide?}] — the cursor arrives at (x, y) at time t, moving over
 * the `dur` seconds before (default from distance). `click: true` ripples at t + 0.08.
 */
export function makeCursor(stage, keys, { start = [stage.clientWidth * 0.6, stage.clientHeight * 0.62], visible = null } = {}) {
  const el = h(`<div class="kit-cursor"><svg width="30" height="30" viewBox="0 0 26 26"><path d="M4 2.5 L4 21 L9.2 16.4 L12.6 24 L16 22.5 L12.7 15 L19.5 15 Z" fill="#fff" stroke="#111827" stroke-width="1.6" stroke-linejoin="round"/></svg></div>`);
  const rip = h(`<div class="kit-ripple"></div>`);
  stage.append(rip, el);
  const ks = keys.slice().sort((a, b) => a.t - b.t);
  return {
    el,
    at(t) {
      let x = start[0], y = start[1], hidden = false;
      let px = x, py = y;
      for (const k of ks) {
        const dist = Math.hypot(k.x - px, k.y - py);
        const dur = k.dur ?? Math.min(0.95, 0.3 + dist / 1400);
        if (t >= k.t) { x = k.x; y = k.y; hidden = !!k.hide; }
        else if (t > k.t - dur) {
          const e = E.inOut((t - (k.t - dur)) / dur);
          x = lerp(px, k.x, e); y = lerp(py, k.y, e);
          break;
        } else break;
        px = k.x; py = k.y;
      }
      // Click ripple and press.
      let press = 0, rk = null;
      for (const k of ks) if (k.click && t >= k.t && t < k.t + 0.6) rk = k;
      if (rk) {
        const q = (t - rk.t) / 0.6;
        rip.style.left = `${rk.x}px`; rip.style.top = `${rk.y}px`;
        set(rip, { o: 1 - q, s: 0.35 + q });
        press = Math.max(0, 1 - Math.abs(t - rk.t - 0.06) / 0.12);
      } else set(rip, { o: 0 });
      set(el, { o: (hidden ? 0 : 1) * (visible ? visible(t) : 1), x: x - 5, y: y - 3, s: 1 - press * 0.12, origin: "5px 3px" });
      return [x, y];
    },
  };
}

/* ── Captions ──────────────────────────────────────────────────────────── */
/** cues: [{t0, t1, text}] — one at a time, fading in and out. */
export function captions(stage, cues) {
  const el = h(`<div id="cap"></div>`);
  stage.appendChild(el);
  return {
    cues,
    at(t) {
      const c = cues.find((q) => t >= q.t0 && t < q.t1);
      if (!c) { el.style.opacity = "0"; return; }
      if (el.textContent !== c.text) el.textContent = c.text;
      const k = win(t, c.t0, c.t1, 0.3, 0.3);
      el.style.opacity = String(k);
      el.style.transform = `translateX(-50%) translateY(${((1 - k) * 8).toFixed(2)}px)`;
    },
  };
}

/* ── Frames ────────────────────────────────────────────────────────────── */
function place(el, { x = 0, y = 0, w, h: hh }) {
  Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hh}px` });
}

/** A browser window with an address bar. `url` like "markdrop.in/demo" (host part emphasised). */
export function browserFrame({ x, y, w, h: hh, url = "", secure = true }) {
  const el = h(`<div class="win bf">
    <div class="win-bar"><div class="win-dots"><i></i><i></i><i></i></div>
      <div class="bf-nav">${icon("back")}${icon("fwd")}${icon("refresh")}</div>
      <div class="bf-url">${secure ? icon("lock") : ""}<span class="u"></span></div></div>
    <div class="win-body bf-body"></div></div>`);
  place(el, { x, y, w, h: hh });
  const u = el.querySelector(".u");
  const api = {
    el,
    body: el.querySelector(".bf-body"),
    url(text) {
      if (api._u === text) return;
      api._u = text;
      const i = text.indexOf("/");
      const host = i < 0 ? text : text.slice(0, i), rest = i < 0 ? "" : text.slice(i);
      const h2 = rest.indexOf("#");
      const r1 = h2 < 0 ? rest : rest.slice(0, h2), r2 = h2 < 0 ? "" : rest.slice(h2);
      u.innerHTML = `<span class="host">${esc(host)}</span>${esc(r1)}${r2 ? `<span class="frag">${esc(r2)}</span>` : ""}`;
    },
  };
  api.url(url);
  return api;
}

/** A neutral terminal window. Its screen is driven by a Term (term.js). */
export function terminalFrame({ x, y, w, h: hh, title = "zsh", size = 18, lh = 1.36, snap = 1.25 }) {
  const el = h(`<div class="win tf"><div class="win-bar"><div class="win-dots"><i></i><i></i><i></i></div><div class="win-title"></div></div>
    <div class="win-body"><div class="tf-screen"></div></div></div>`);
  place(el, { x, y, w, h: hh });
  el.querySelector(".win-title").textContent = title;
  const screen = el.querySelector(".tf-screen");
  screen.style.setProperty("--tf-size", `${size}px`);
  // Line boxes on whole device pixels, so block characters (QR codes, bars) join without seams.
  screen.style.setProperty("--tf-line", `${Math.round(size * lh * snap) / snap}px`);
  return { el, screen, title: (s) => { el.querySelector(".win-title").textContent = s; } };
}

/** A neutral code editor window: file list, tabs, code, status bar. */
export function editorFrame({ x, y, w, h: hh, title = "", files = [], side = 250 }) {
  const el = h(`<div class="win ef"><div class="win-bar"><div class="win-dots"><i></i><i></i><i></i></div><div class="win-title"></div></div>
    <div class="win-body">
      <div class="ef-side"><div class="eyebrow">Files</div><div class="ef-files"></div></div>
      <div class="ef-main"><div class="ef-tabs"></div><div class="ef-code"></div></div>
      <div class="ef-status"></div>
    </div></div>`);
  place(el, { x, y, w, h: hh });
  el.style.setProperty("--ef-side", `${side}px`);
  el.querySelector(".win-title").textContent = title;
  el.querySelector(".ef-files").innerHTML = files.map((f) => `<div class="ef-file${f.on ? " on" : ""}" style="padding-left:${10 + (f.depth || 0) * 18}px">${icon(f.dir ? "folder" : f.name.endsWith(".md") ? "md" : "doc")}<span>${esc(f.name)}</span></div>`).join("");
  return {
    el,
    tabs: el.querySelector(".ef-tabs"),
    code: el.querySelector(".ef-code"),
    status: el.querySelector(".ef-status"),
    main: el.querySelector(".ef-main"),
  };
}

/** A neutral AI chat window. */
export function chatFrame({ x, y, w, h: hh, name = "Assistant", chip = "" }) {
  const el = h(`<div class="win cf"><div class="win-bar"><div class="win-dots"><i></i><i></i><i></i></div><div class="win-title"></div></div>
    <div class="win-body">
      <div class="cf-head"><div class="cf-av">AI</div><div class="name"></div><div class="sp"></div>${chip ? `<span class="pill ok"><span class="dot"></span>${esc(chip)}</span>` : ""}</div>
      <div class="cf-feed"><div class="cf-scroll"></div></div>
      <div class="cf-compose"><div class="txt"><span class="ph">Ask anything</span></div><div class="send">${icon("send")}</div></div>
    </div></div>`);
  place(el, { x, y, w, h: hh });
  el.querySelector(".name").textContent = name;
  return {
    el,
    feed: el.querySelector(".cf-feed"),
    scroll: el.querySelector(".cf-scroll"),
    compose: el.querySelector(".cf-compose .txt"),
    setCompose(text, caret, placeholder = "Ask anything") {
      const k = `${text}|${caret}`;
      if (this._k === k) return;
      this._k = k;
      this.compose.innerHTML = text ? `${esc(text)}${caret ? '<span class="caret"></span>' : ""}` : `<span class="ph">${esc(placeholder)}</span>`;
    },
  };
}

export function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/** A spinner glyph rotated for time t (a ring with an accent arc). */
export function spinner(el, t) {
  if (el) el.style.transform = `rotate(${((t * 400) % 360).toFixed(1)}deg)`;
}

/* ── Explainer header: a topic eyebrow and one headline per step ──────── */
/** steps: [{t, text}] (HTML allowed: <em> for the accent). `end` closes the last step. */
export function header(parent, { topic, steps, end }) {
  const el = h(`<div class="xh"><div class="eyebrow"><span class="n"></span><span>${esc(topic)}</span></div>
    <div class="lines">${steps.map((s) => `<div class="line">${s.text}</div>`).join("")}</div>
    <div class="progress">${steps.map(() => "<i><b></b></i>").join("")}</div></div>`);
  parent.appendChild(el);
  const lines = [...el.querySelectorAll(".line")];
  const bars = [...el.querySelectorAll(".progress b")];
  const n = el.querySelector(".n");
  return {
    el,
    at(t) {
      let cur = 0;
      steps.forEach((s, i) => { if (t >= s.t) cur = i; });
      n.textContent = `${cur + 1}/${steps.length}`;
      steps.forEach((s, i) => {
        const next = steps[i + 1]?.t ?? end;
        const k = Math.min(p(t, s.t, s.t + 0.5, E.out), 1 - p(t, next - 0.3, next, E.inOut));
        set(lines[i], { o: i === 0 && s.t === 0 ? Math.min(k, 1) : k, y: (1 - p(t, s.t, s.t + 0.5, E.out)) * 14 });
        const f = clamp((t - s.t) / Math.max(0.01, next - s.t));
        bars[i].style.transform = `scaleX(${f.toFixed(4)})`;
      });
    },
  };
}

/** A point at fraction k along an SVG path element. */
export function along(pathEl, k) {
  const L = pathEl.getTotalLength();
  const pt = pathEl.getPointAtLength(clamp(k) * L);
  return [pt.x, pt.y];
}

/** Text scrambled into cipher-looking characters for the first fraction k (deterministic). */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function scramble(text, k, t = 0, seed = 1) {
  const n = text.length;
  let out = "";
  const tick = Math.floor(t * 18);
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (ch === " " && k < 1) { out += i / n < k ? B64[(i * 7 + seed * 13) % 64] : " "; continue; }
    if (i / n < k) {
      const r = rand(seed * 1000 + i * 31 + (k < 1 ? tick : 0))();
      out += B64[Math.floor(r * 64)];
    } else out += ch;
  }
  return out;
}

/** Fade a scene's root in at the start and out at the end, so a loop restarts cleanly. */
export function loopFade(root, t, duration, { fin = 0.35, fout = 0.45 } = {}) {
  const k = Math.min(p(t, 0, fin, E.out), 1 - p(t, duration - fout, duration, E.inOut));
  root.style.opacity = String(Math.round(k * 1000) / 1000);
  return k;
}

/** Seek a <video> to `time` and resolve once that frame is shown (scenes return this from render). */
export function seekTo(v, time) {
  const d = Number.isFinite(v.duration) ? v.duration : time + 1;
  const tt = Math.max(0, Math.min(time, d - 0.04));
  if (Math.abs(v.currentTime - tt) < 0.0005 && v.readyState >= 2) return Promise.resolve();
  return new Promise((r) => {
    const done = () => { v.removeEventListener("seeked", done); requestAnimationFrame(() => r()); };
    v.addEventListener("seeked", done);
    v.currentTime = tt;
  });
}
