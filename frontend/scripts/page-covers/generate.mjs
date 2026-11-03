// The page cover gallery (public/page-covers): 12 calm covers drawn in code (noise fields, SVG
// lines and shapes, grain), rendered to 1500x480 WebP at <= 60 KB each, with a 384x123 thumbnail
// for the picker and manifest.json (ids, names, categories, and the old gradient ids' aliases).
//
//   node scripts/page-covers/generate.mjs [outDir] [--png] [id...]
//
// The backend keeps the same ids (backend/app/services/page_props.py GALLERY); its tests check
// the two lists agree.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../package.json"));
const sharp = require("sharp");

const W = 1500, H = 480, N = W * H;
const args = process.argv.slice(2);
const PNG = args.includes("--png");
const rest = args.filter((a) => a !== "--png");
const OUT = rest[0] || path.join(here, "../../public/page-covers");
const ONLY = rest.slice(1);
const MAX_BYTES = 60_000;

// ---------- helpers ----------
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
function gauss(r) { let u = 0; for (let i = 0; i < 4; i++) u += r(); return (u - 2) / 0.577; }
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// Perlin noise (seeded)
function perlin(seed) {
  const r = rng(seed), p = new Uint8Array(512), perm = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
  const g = (h, x, y) => { switch (h & 7) { case 0: return x + y; case 1: return -x + y; case 2: return x - y; case 3: return -x - y; case 4: return x; case 5: return -x; case 6: return y; default: return -y; } };
  const f = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y) => {
    const X = Math.floor(x), Y = Math.floor(y), xf = x - X, yf = y - Y, xi = X & 255, yi = Y & 255;
    const u = f(xf), v = f(yf);
    const aa = p[p[xi] + yi], ab = p[p[xi] + yi + 1], ba = p[p[xi + 1] + yi], bb = p[p[xi + 1] + yi + 1];
    const x1 = g(aa, xf, yf) + u * (g(ba, xf - 1, yf) - g(aa, xf, yf));
    const x2 = g(ab, xf, yf - 1) + u * (g(bb, xf - 1, yf - 1) - g(ab, xf, yf - 1));
    return (x1 + v * (x2 - x1)) * 0.7; // ~[-1,1]
  };
}
function fbm(noise, oct = 5, lac = 2, gain = 0.5) {
  return (x, y) => { let a = 1, f = 1, s = 0, n = 0; for (let i = 0; i < oct; i++) { s += a * noise(x * f + i * 17.3, y * f - i * 9.1); n += a; a *= gain; f *= lac; } return s / n; };
}

// A canvas of linear-light floats.
class Canvas {
  constructor() { this.d = new Float32Array(N * 3); }
  fill(h) { const c = hex(h).map(toLin); for (let i = 0; i < N; i++) { this.d[i * 3] = c[0]; this.d[i * 3 + 1] = c[1]; this.d[i * 3 + 2] = c[2]; } return this; }
  // per-pixel colour function returning [weight, linear rgb] to mix in
  each(fn) { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; fn(x, y, i, this.d); } return this; }
  mix(h, wfn) { const c = hex(h).map(toLin); return this.each((x, y, i, d) => { const w = wfn(x, y); if (w <= 0) return; d[i] += (c[0] - d[i]) * w; d[i + 1] += (c[1] - d[i + 1]) * w; d[i + 2] += (c[2] - d[i + 2]) * w; }); }
  add(h, wfn) { const c = hex(h).map(toLin); return this.each((x, y, i, d) => { const w = wfn(x, y); d[i] += c[0] * w; d[i + 1] += c[1] * w; d[i + 2] += c[2] * w; }); }
  scale(fn) { return this.each((x, y, i, d) => { const k = fn(x, y); d[i] *= k; d[i + 1] *= k; d[i + 2] *= k; }); }
  // soft elliptical blob weight
  static blob(cx, cy, rx, ry, rot = 0, pow = 1) {
    const c = Math.cos(rot), s = Math.sin(rot);
    return (x, y) => { const dx = x - cx, dy = y - cy; const u = (dx * c + dy * s) / rx, v = (-dx * s + dy * c) / ry; return Math.exp(-(u * u + v * v) * pow); };
  }
  // composite an SVG (sRGB, straight alpha) over the canvas
  async svg(svgText) {
    const { data } = await sharp(Buffer.from(svgText), { density: 72 }).resize(W, H).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let p = 0; p < N; p++) {
      const a = data[p * 4 + 3] / 255; if (!a) continue;
      for (let k = 0; k < 3; k++) {
        const base = toSrgb(clamp(this.d[p * 3 + k]));
        this.d[p * 3 + k] = toLin(base + (data[p * 4 + k] / 255 - base) * a);
      }
    }
    return this;
  }
  // out: sRGB 8-bit with grain + dither
  bytes({ grain = 0, grainScale = 1, seed = 7, chroma = 0, dither = 0.9 } = {}) {
    const r = rng(seed);
    let gw = Math.ceil(W / grainScale) + 2, gh = Math.ceil(H / grainScale) + 2, gr = null;
    if (grain) { gr = new Float32Array(gw * gh * 3); for (let i = 0; i < gr.length; i++) gr[i] = gauss(r); }
    const out = Buffer.alloc(N * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = y * W + x;
      let g = 0, gc = [0, 0, 0];
      if (gr) {
        const fx = x / grainScale, fy = y / grainScale, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
        const at = (cx, cy, k) => gr[((cy * gw + cx) * 3) + k];
        const bil = (k) => at(ix, iy, k) * (1 - tx) * (1 - ty) + at(ix + 1, iy, k) * tx * (1 - ty) + at(ix, iy + 1, k) * (1 - tx) * ty + at(ix + 1, iy + 1, k) * tx * ty;
        g = bil(0); if (chroma) gc = [bil(1) * chroma, bil(2) * chroma, -(bil(1) + bil(2)) * chroma * 0.5];
      }
      for (let k = 0; k < 3; k++) {
        let v = toSrgb(clamp(this.d[p * 3 + k])) * 255;
        v += (g + gc[k]) * grain * 255 + (r() - r()) * dither; // grain + triangular dither
        out[p * 3 + k] = clamp(Math.round(v), 0, 255);
      }
    }
    return out;
  }
}

async function save(id, raw) {
  const img = () => sharp(raw, { raw: { width: W, height: H, channels: 3 } });
  let lo = 20, hi = 92, best = null;
  while (lo <= hi) {
    const q = (lo + hi) >> 1;
    const buf = await img().webp({ quality: q, effort: 6, smartSubsample: true }).toBuffer();
    if (buf.length <= MAX_BYTES) { best = { q, buf }; lo = q + 1; } else hi = q - 1;
  }
  if (!best) throw new Error(`${id}: can't fit in ${MAX_BYTES} bytes`);
  fs.writeFileSync(path.join(OUT, `${id}.webp`), best.buf);
  const thumb = await img().resize(384, 123, { kernel: "lanczos3" }).webp({ quality: 82, effort: 6 }).toBuffer();
  fs.writeFileSync(path.join(OUT, "thumbs", `${id}.webp`), thumb);
  if (PNG) fs.writeFileSync(path.join(OUT, `${id}.png`), await img().png().toBuffer());
  console.log(id.padEnd(10), `q=${best.q}`, `${(best.buf.length / 1024).toFixed(1)} KB`, `thumb ${(thumb.length / 1024).toFixed(1)} KB`);
}

// ---------- the covers ----------
// Mist (the app's light theme): #E3E7ED / #EBEEF2, ink #111A2C, accent #2150D8.
const CATEGORIES = ["Paper", "Duotone", "Lines", "Calm"];
const META = {
  mist: ["Mist paper", "Paper"], linen: ["Linen", "Paper"], graphite: ["Graphite", "Paper"],
  fold: ["Fold", "Duotone"], halftone: ["Halftone", "Duotone"], dusk: ["Dusk", "Duotone"],
  contour: ["Contour", "Lines"], blueprint: ["Blueprint", "Lines"], strata: ["Strata", "Lines"],
  dawn: ["Dawn", "Calm"], sage: ["Sage", "Calm"], moonlit: ["Moonlit", "Calm"],
};
// The first gallery's gradients, still on existing pages: each shows the nearest new cover.
const ALIASES = { aurora: "dusk", ocean: "dusk", sunset: "dawn", peach: "dawn", sand: "linen", slate: "graphite", forest: "sage", mint: "sage" };

const covers = {
  // ---- Paper ----
  async mist() {
    // Handmade cool paper: cloudy formation, a few fibres and specks, light from the top-left.
    const c = new Canvas().fill("#E6EAEF");
    const n = fbm(perlin(11), 5), m = fbm(perlin(13), 3);
    c.mix("#F4F6F9", Canvas.blob(260, -40, 980, 440));
    c.mix("#D3D9E2", (x, y) => 0.6 * smooth(0.25, 1.15, (x / W) * 0.6 + (y / H) * 0.6));
    c.scale((x, y) => 1 + 0.045 * m(x / 60, y / 60) + 0.03 * n(x / 300, y / 300)); // formation
    const r = rng(101), fib = [];
    for (let i = 0; i < 60; i++) {
      const x = r() * W, y = r() * H, a = r() * Math.PI, len = 14 + r() * 46, bend = (r() - 0.5) * 18;
      const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len, mx = (x + x2) / 2 - Math.sin(a) * bend, my = (y + y2) / 2 + Math.cos(a) * bend;
      fib.push(`<path d="M${x.toFixed(1)} ${y.toFixed(1)}Q${mx.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="${r() < 0.7 ? "#9AA6B8" : "#FFFFFF"}" stroke-opacity="${(0.14 + r() * 0.16).toFixed(2)}" stroke-width="${(0.6 + r() * 0.7).toFixed(2)}" fill="none" stroke-linecap="round"/>`);
    }
    for (let i = 0; i < 40; i++) fib.push(`<circle cx="${(r() * W).toFixed(1)}" cy="${(r() * H).toFixed(1)}" r="${(0.5 + r() * 0.9).toFixed(2)}" fill="#7E8BA0" fill-opacity="${(0.12 + r() * 0.15).toFixed(2)}"/>`);
    await c.svg(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${fib.join("")}</svg>`);
    return c.bytes({ grain: 0.018, grainScale: 1.2, seed: 3 });
  },
  async linen() {
    // Warm linen with a fine weave and a soft drape of light.
    const c = new Canvas().fill("#E9E3D8");
    const a = perlin(21), b = perlin(22), n = fbm(perlin(23), 4);
    c.mix("#F6F2EB", Canvas.blob(1080, 30, 980, 380));
    c.mix("#D6CCBC", (x, y) => 0.55 * smooth(0.3, 1.15, (1 - x / W) * 0.5 + (y / H) * 0.7));
    // folds: long diagonal swells of light and shade
    c.scale((x, y) => { const u = (x * 0.8 + y * 1.4) / 520 + 0.35 * n(x / 600, y / 600); return 1 + 0.035 * Math.sin(u * Math.PI * 2) * smooth(0, 1, x / W + 0.2); });
    c.scale((x, y) => {
      const h = Math.sin(y * 1.75 + a(x / 160, y / 3) * 3) * 0.5 + 0.5;
      const v = Math.sin(x * 1.75 + b(x / 3, y / 160) * 3) * 0.5 + 0.5;
      const slub = 1 + 0.6 * a(x / 420, y / 2.2);
      return 1 - 0.05 * (h * slub) - 0.04 * v;
    });
    return c.bytes({ grain: 0.008, grainScale: 1.1, seed: 5 });
  },
  async graphite() {
    // Charcoal laid paper: fine laid lines, soft chain lines, a little tooth.
    const c = new Canvas().fill("#1B212B");
    const n = fbm(perlin(31), 5), m = fbm(perlin(33), 3), f = perlin(32);
    c.mix("#2A3240", Canvas.blob(380, -60, 1050, 430));
    c.mix("#11161E", (x, y) => 0.7 * smooth(0.3, 1.15, (x / W) * 0.5 + (y / H) * 0.7));
    c.scale((x, y) => 1 + 0.08 * n(x / 260, y / 260) + 0.07 * m(x / 60, y / 60));
    c.scale((x, y) => {
      const laid = Math.sin((y + 1.2 * f(x / 300, y / 40)) * Math.PI * 2 / 3.2) * 0.5 + 0.5;  // every ~3px
      const cx = ((x + 6 * f(y / 200, 3)) % 118 + 118) % 118, chain = Math.exp(-(((cx - 59) / 2.2) ** 2)); // every 118px
      return 1 + 0.13 * laid + 0.16 * chain;
    });
    return c.bytes({ grain: 0.016, grainScale: 1.2, seed: 9 });
  },

  // ---- Duotone ----
  async fold() {
    // Folded paper: large planes in tints between mist and the accent, each softly shaded.
    const c = new Canvas().fill("#E4E9F1");
    c.mix("#F1F4F8", Canvas.blob(200, 0, 900, 500));
    const planes = [
      { pts: [[560, -20], [1520, -20], [1520, 300], [980, 500]], from: "#C9D5EE", to: "#DCE3F1", ax: [560, 0, 1300, 400] },
      { pts: [[980, 500], [1520, 300], [1520, 500]], from: "#9DB3E6", to: "#B8C8EC", ax: [1100, 500, 1500, 320] },
      { pts: [[860, -20], [1240, -20], [980, 500], [700, 500]], from: "#7E99E4", to: "#5679DF", ax: [860, 0, 900, 500] },
      { pts: [[1240, -20], [1520, -20], [1520, 120]], from: "#7F9BE3", to: "#A8BBEA", ax: [1240, 0, 1500, 100] },
    ];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>${planes.map((p, i) => `<linearGradient id="g${i}" gradientUnits="userSpaceOnUse" x1="${p.ax[0]}" y1="${p.ax[1]}" x2="${p.ax[2]}" y2="${p.ax[3]}"><stop offset="0" stop-color="${p.from}"/><stop offset="1" stop-color="${p.to}"/></linearGradient>`).join("")}
      <filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="18"/></filter></defs>
      <polygon points="${planes[2].pts.map((q) => q.join(",")).join(" ")}" fill="#1B2F6B" opacity=".22" filter="url(#sh)" transform="translate(-14 8)"/>
      ${planes.map((p, i) => `<polygon points="${p.pts.map((q) => q.join(",")).join(" ")}" fill="url(#g${i})"/>`).join("")}
      <polygon points="1240,-20 1262,-20 1002,500 980,500" fill="#2150D8"/>
      <polyline points="860,-20 700,500" stroke="#FFFFFF" stroke-opacity=".45" stroke-width="1.2" fill="none"/>
    </svg>`;
    await c.svg(svg);
    return c.bytes({ grain: 0.008, grainScale: 1.2, seed: 11 });
  },
  async halftone() {
    // An accent halftone of a soft glow, on mist: dense at its heart, dissolving to paper.
    const c = new Canvas().fill("#E8ECF2");
    c.mix("#F3F5F9", Canvas.blob(250, 380, 800, 400));
    const n = fbm(perlin(41), 3);
    const step = 17, dots = [];
    for (let row = 0, y = 2; y < H + step; y += step * 0.866, row++) {
      for (let x = (row % 2) * step / 2; x < W + step; x += step) {
        const d = Math.hypot((x - 1190) / 520, (y - 210) / 330) + 0.12 * n(x / 380, y / 380);
        const t = (1 - smooth(0.0, 1.0, d)) ** 1.25;
        const r = t * step * 0.34;
        if (r > 0.7) dots.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}"/>`);
      }
    }
    await c.svg(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><g fill="#3460DC">${dots.join("")}</g></svg>`);
    return c.bytes({ dither: 0, seed: 13 });
  },
  async dusk() {
    // Ink and accent: a stepped rising sun of soft bands, lower right.
    const c = new Canvas().fill("#0F1830");
    c.mix("#13204A", Canvas.blob(1150, 520, 1100, 600));
    const steps = ["#172760", "#1C3178", "#213B91", "#2746AA", "#3155C4", "#4467D6", "#6383E2"];
    const cx = 1180, cy = 640;
    const rings = steps.map((col, i) => `<circle cx="${cx}" cy="${cy}" r="${560 - i * 62}" fill="${col}"/>`).join("");
    await c.svg(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><filter id="b"><feGaussianBlur stdDeviation="1.4"/></filter></defs><g filter="url(#b)">${rings}</g></svg>`);
    c.add("#2150D8", (x, y) => 0.03 * Canvas.blob(cx, cy - 80, 600, 380)(x, y));
    return c.bytes({ grain: 0.012, grainScale: 1.4, seed: 17 });
  },

  // ---- Lines ----
  async contour() {
    const c = new Canvas().fill("#E9ECF0");
    c.mix("#F3F5F8", Canvas.blob(300, 0, 900, 420));
    c.mix("#DCE1E8", (x, y) => 0.5 * smooth(0.3, 1.1, (x / W) * 0.6 + (y / H) * 0.5));
    // topographic lines: marching squares over a smooth field, one path per level
    const n = fbm(perlin(51), 4, 2, 0.45), S = 5, gw = Math.ceil(W / S) + 2, gh = Math.ceil(H / S) + 2;
    const F = new Float32Array(gw * gh);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const x = i * S - S, y = j * S - S;
      F[j * gw + i] = n(x / 520, y / 520) + 0.35 * Math.exp(-(((x - 1080) / 380) ** 2 + ((y - 200) / 260) ** 2));
    }
    const levels = [];
    for (let l = -0.6; l <= 0.9; l += 0.045) levels.push(l);
    const paths = levels.map((L, li) => {
      let d = "";
      for (let j = 0; j < gh - 1; j++) for (let i = 0; i < gw - 1; i++) {
        const a = F[j * gw + i], b = F[j * gw + i + 1], cc = F[(j + 1) * gw + i + 1], dd = F[(j + 1) * gw + i];
        const code = (a > L ? 8 : 0) | (b > L ? 4 : 0) | (cc > L ? 2 : 0) | (dd > L ? 1 : 0);
        if (code === 0 || code === 15) continue;
        const x0 = i * S - S, y0 = j * S - S;
        const T = [x0 + S * (L - a) / (b - a), y0], R = [x0 + S, y0 + S * (L - b) / (cc - b)], B = [x0 + S * (L - dd) / (cc - dd), y0 + S], Lf = [x0, y0 + S * (L - a) / (dd - a)];
        const seg = { 1: [Lf, B], 2: [B, R], 3: [Lf, R], 4: [T, R], 5: [Lf, T, B, R], 6: [T, B], 7: [Lf, T], 8: [Lf, T], 9: [T, B], 10: [T, R, Lf, B], 11: [T, R], 12: [Lf, R], 13: [B, R], 14: [Lf, B] }[code];
        for (let k = 0; k < seg.length; k += 2) d += `M${seg[k][0].toFixed(1)} ${seg[k][1].toFixed(1)}L${seg[k + 1][0].toFixed(1)} ${seg[k + 1][1].toFixed(1)}`;
      }
      const major = li % 5 === 0;
      return `<path d="${d}" stroke="${major ? "#93A2B8" : "#B4BFCE"}" stroke-width="${major ? 1.25 : 0.9}" fill="none" stroke-linecap="round"/>`;
    });
    await c.svg(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${paths.join("")}</svg>`);
    return c.bytes({ grain: 0.004, seed: 19 });
  },
  async blueprint() {
    // A deep-accent drafting grid with one quiet construction circle.
    const c = new Canvas().fill("#152E6E");
    c.mix("#1C3D92", Canvas.blob(1050, 120, 1000, 420));
    c.mix("#0F2259", (x, y) => 0.65 * smooth(0.2, 1.1, (1 - x / W) * 0.5 + (y / H) * 0.7));
    let minor = "", major = "";
    for (let x = 0; x <= W; x += 24) (x % 120 === 0 ? (major += `M${x + 0.5} 0V${H}`) : (minor += `M${x + 0.5} 0V${H}`));
    for (let y = 0; y <= H; y += 24) (y % 120 === 0 ? (major += `M0 ${y + 0.5}H${W}`) : (minor += `M0 ${y + 0.5}H${W}`));
    await c.svg(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <path d="${minor}" stroke="#FFFFFF" stroke-opacity=".07" stroke-width="1"/>
      <path d="${major}" stroke="#FFFFFF" stroke-opacity=".14" stroke-width="1"/>
      <g fill="none" stroke="#FFFFFF" stroke-opacity=".3" stroke-width="1.1">
        <circle cx="1080" cy="240" r="168"/>
        <circle cx="1080" cy="240" r="96" stroke-dasharray="4 6" stroke-opacity=".2"/>
        <path d="M840 240H1320M1080 0V480" stroke-opacity=".16" stroke-dasharray="2 6"/>
        <path d="M1080 240L1199 121" stroke-opacity=".34"/>
      </g>
      <g fill="#FFFFFF" fill-opacity=".45"><circle cx="1080" cy="240" r="2.5"/><circle cx="1199" cy="121" r="2.5"/></g>
    </svg>`);
    return c.bytes({ grain: 0.008, grainScale: 1.3, seed: 23 });
  },
  async strata() {
    // Stacked lines on ink that bunch and spread like silk, one in the accent.
    const c = new Canvas().fill("#0E1524");
    c.mix("#172340", Canvas.blob(950, 180, 950, 380));
    const n = fbm(perlin(61), 3), lines = [];
    const count = 30;
    for (let k = 0; k < count; k++) {
      const y0 = -20 + k * (520 / (count - 1));
      let d = "";
      for (let x = -10; x <= W + 10; x += 5) {
        const env = 0.35 + 0.65 * Math.exp(-(((x - 1000) / 520) ** 2));
        const y = y0 + env * 70 * n(x / 520, y0 / 260 + 0.3) + 10 * Math.sin(x / 240 + y0 / 90);
        d += (x === -10 ? "M" : "L") + x + " " + y.toFixed(2);
      }
      const hi = k === 18, mid = Math.sin((k / (count - 1)) * Math.PI);
      lines.push(`<path d="${d}" fill="none" stroke="${hi ? "#5B7FE6" : "#C9D3E3"}" stroke-opacity="${hi ? 0.9 : (0.14 + 0.24 * mid).toFixed(3)}" stroke-width="${hi ? 1.6 : 1.05}"/>`);
    }
    await c.svg(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${lines.join("")}</svg>`);
    return c.bytes({ grain: 0.008, grainScale: 1.3, seed: 29 });
  },

  // ---- Calm ----
  async dawn() {
    // Fog over a warm horizon: mist above, peach and sand low on the right.
    const c = new Canvas().fill("#DDE3EB");
    c.mix("#E9EDF2", (x, y) => smooth(0, 1, 1 - y / H) * 0.6);
    c.mix("#F2D6C3", Canvas.blob(1120, 470, 820, 230));
    c.mix("#F6E6CF", Canvas.blob(760, 430, 620, 160));
    c.mix("#FBF1E6", Canvas.blob(1080, 400, 340, 120, 0, 1.4));
    c.mix("#D3DAE6", Canvas.blob(150, 60, 700, 300));
    const n = fbm(perlin(71), 4);
    c.scale((x, y) => 1 + 0.02 * n(x / 400, y / 140));
    return c.bytes({ grain: 0.008, grainScale: 1.5, seed: 31 });
  },
  async sage() {
    // A soft green-grey field with a pale bloom and cool shadow.
    const c = new Canvas().fill("#D7E0D8");
    c.mix("#EDF1EA", Canvas.blob(980, 120, 820, 330));
    c.mix("#C3D0C8", Canvas.blob(160, 420, 760, 300));
    c.mix("#CBD6DE", Canvas.blob(1450, 470, 600, 260));
    c.mix("#F6F7F1", Canvas.blob(1040, 90, 300, 140, -0.2, 1.3));
    const n = fbm(perlin(81), 4);
    c.scale((x, y) => 1 + 0.02 * n(x / 420, y / 160));
    return c.bytes({ grain: 0.008, grainScale: 1.5, seed: 37 });
  },
  async moonlit() {
    // Night ink over a still horizon: a cool band of light low on the right, a faint glow above.
    const c = new Canvas().fill("#0A0F1C");
    c.mix("#0D1426", (x, y) => smooth(0.2, 1, y / H) * 0.8);
    const across = (x) => Math.exp(-(((x - 1060) / 760) ** 2));
    c.add("#2150D8", (x, y) => 0.11 * across(x) * Math.exp(-(((y - 318) / 95) ** 2)));
    c.add("#8FA6EE", (x, y) => 0.06 * across(x) * Math.exp(-(((y - 318) / 22) ** 2)));
    c.add("#DDE5F8", (x, y) => 0.035 * Math.exp(-(((x - 1060) / 420) ** 2)) * Math.exp(-(((y - 318) / 4) ** 2)));
    c.add("#6F86CC", (x, y) => 0.025 * Canvas.blob(1180, -40, 700, 260)(x, y));
    c.mix("#070B15", (x, y) => 0.55 * smooth(325, 480, y));  // the water below is darker than the sky
    return c.bytes({ grain: 0.014, grainScale: 1.5, seed: 41 });
  },
};

fs.mkdirSync(path.join(OUT, "thumbs"), { recursive: true });
for (const [id, make] of Object.entries(covers)) {
  if (ONLY.length && !ONLY.includes(id)) continue;
  await save(id, await make());
}
if (!ONLY.length) {
  const manifest = {
    size: [W, H],
    categories: CATEGORIES,
    covers: Object.keys(covers).map((id) => ({ id, name: META[id][0], category: META[id][1] })),
    aliases: ALIASES,
  };
  // One cover per line: easy to read in a diff.
  const json = JSON.stringify(manifest, null, 2).replace(/\{\n\s+("id"[^}]*?)\n\s+\}/g, (_, body) => `{ ${body.replace(/\n\s+/g, " ")} }`).replace(/\[\n\s+(\d+),\n\s+(\d+)\n\s+\]/, "[$1, $2]");
  fs.writeFileSync(path.join(OUT, "manifest.json"), json + "\n");
}
