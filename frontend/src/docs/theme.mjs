/**
 * Docs themes (site.json `theme`): the six presets, the font allow-list, corners, colour mode,
 * palettes built from brand colours, and custom CSS. Plain ESM with no imports, shared by the
 * engine (src/docs/themeSite.ts), docs:check and the tests.
 *
 *   "theme": {
 *     "preset": "clean" | "editorial" | "technical" | "minimal" | "playful" | "helpcenter",
 *     "fonts": { "heading": "newsreader", "body": "source-sans-3", "mono": "ibm-plex-mono" },
 *     "corners": "sharp" | "soft" | "round",          // overrides the preset's radius scale
 *     "mode": "both" | "light" | "dark",               // light-only / dark-only hide the switch
 *     "colors": ["#0f766e", "#13203a", "#e6f4f1"],     // Match my brand: accent, ink, soft tint
 *     "customCss": ".dx-title { letter-spacing: 0 }"   // sanitised, scoped under .dx-root
 *   }
 *
 * Every key is optional. No `theme` at all is today's docs.markdrop.in look, token for token: the
 * engine adds nothing (no attribute, no stylesheet).
 *
 * Colour maths: the same model as components/tenant/branding.ts (WCAG relative luminance, sRGB
 * mixing, the accent fill / on-accent / clamped accent-text split and its 14 % / 28 % washes).
 * It is restated here because docs:check and the tests run in plain Node; theme.test.mjs checks
 * that both give the same accent tokens on Markdrop's own grounds.
 */

/* ── presets ─────────────────────────────────────────────────────────────── */

/**
 * Radius scales (--radius-sm … --radius-3xl). `soft` is the design system's own scale (clean).
 * Presets name one of these, or carry their own.
 */
export const CORNERS = {
  sharp: { sm: 2, md: 3, lg: 3, xl: 4, "2xl": 6, "3xl": 8 },
  soft: { sm: 4, md: 6, lg: 8, xl: 12, "2xl": 16, "3xl": 24 },
  round: { sm: 8, md: 10, lg: 14, xl: 16, "2xl": 20, "3xl": 28 },
};

/**
 * A base palette per theme: page ground, header, cards, text, muted text, hairlines, code ground
 * and code text (board 5, "Design and themes"). Accent tokens are derived, never taken raw.
 */
const P = (bg, header, card, text, muted, line, code, codeText) => ({ bg, header, card, text, muted, line, code, codeText });

/**
 * layout: "sidebar" (left page tree, contents rail), "top" (no sidebar: section links under the
 * header, a centred column, contents in the page), "helpcenter" (search hero and category cards on
 * the home, articles with "In this category" beside them).
 */
export const PRESETS = {
  clean: {
    label: "Clean",
    blurb: "Sidebar docs. Calm and familiar.",
    layout: "sidebar",
    fonts: { heading: "manrope", body: "manrope", mono: "jetbrains-mono" },
    corners: "soft",
    headingWeight: 800,
    // Markdrop's own tokens: no palette of its own (brand colours still build one).
    palette: null,
  },
  editorial: {
    label: "Editorial",
    blurb: "Serif headings, centred reading.",
    layout: "top",
    fonts: { heading: "newsreader", body: "source-sans-3", mono: "jetbrains-mono" },
    corners: { sm: 2, md: 3, lg: 4, xl: 4, "2xl": 6, "3xl": 8 },
    headingWeight: 600,
    palette: {
      accent: "#9a3412",
      light: P("#fbf8f3", "#fbf8f3", "#fffdf9", "#2b2118", "#776655", "#ece2d4", "#f3ece1", "#2b2118"),
      dark: P("#1a1612", "#1a1612", "#221d18", "#f1e8dc", "#b3a491", "#3a3128", "#120f0c", "#f1e8dc"),
    },
  },
  technical: {
    label: "Technical",
    blurb: "Dense, mono accents, API-first.",
    layout: "sidebar",
    fonts: { heading: "ibm-plex-sans", body: "ibm-plex-sans", mono: "ibm-plex-mono" },
    corners: "sharp",
    headingWeight: 600,
    palette: {
      accent: "#0ea5e9",
      light: P("#ffffff", "#ffffff", "#fafbfc", "#0b1220", "#4b5565", "#e5e7eb", "#0b1220", "#e5f2ff"),
      dark: P("#0a0f17", "#0a0f17", "#0f1622", "#e6edf7", "#93a1b5", "#1e2a3b", "#05080d", "#bfe6ff"),
    },
  },
  minimal: {
    label: "Minimal",
    blurb: "No sidebar chrome, lots of air.",
    layout: "top",
    fonts: { heading: "geist", body: "geist", mono: "geist-mono" },
    corners: { sm: 6, md: 8, lg: 10, xl: 12, "2xl": 16, "3xl": 20 },
    headingWeight: 600,
    palette: {
      accent: "#111827",
      light: P("#ffffff", "#ffffff", "#ffffff", "#111827", "#6b7280", "#eeeeee", "#f6f6f6", "#111827"),
      dark: P("#0b0b0c", "#0b0b0c", "#111113", "#f4f4f5", "#a1a1aa", "#232326", "#141416", "#f4f4f5"),
    },
  },
  playful: {
    label: "Playful",
    blurb: "Round, bold and friendly.",
    layout: "sidebar",
    fonts: { heading: "nunito", body: "nunito", mono: "jetbrains-mono" },
    corners: "round",
    headingWeight: 800,
    palette: {
      accent: "#7c3aed",
      light: P("#faf7ff", "#ffffff", "#ffffff", "#24163f", "#6c5b8c", "#ece4fb", "#f3edff", "#24163f"),
      dark: P("#140e22", "#1a1230", "#1e1535", "#efe7ff", "#b6a5d8", "#33275a", "#0e0919", "#efe7ff"),
    },
  },
  helpcenter: {
    label: "Help center",
    blurb: "Search first, then categories.",
    layout: "helpcenter",
    fonts: { heading: "dm-sans", body: "dm-sans", mono: "jetbrains-mono" },
    corners: { sm: 6, md: 8, lg: 10, xl: 12, "2xl": 16, "3xl": 24 },
    headingWeight: 700,
    palette: {
      accent: "#c2410c",
      light: P("#ffffff", "#ffffff", "#ffffff", "#1c1917", "#6b625c", "#ebe5df", "#f6f2ee", "#1c1917"),
      dark: P("#121010", "#121010", "#1a1716", "#f5f0eb", "#ada39b", "#2e2826", "#0c0a0a", "#f5f0eb"),
    },
  },
};

/**
 * Markdrop's own neutrals (tokens.css), the base when the clean preset is given brand colours.
 * Mirrors styles/ds/tokens.css; only used to derive a brand palette, never written for clean alone.
 */
const MARKDROP_BASE = {
  accent: "#2150d8",
  light: P("#e3e7ed", "#ebeef2", "#ebeef2", "#111a2c", "#4a5567", "#cdd4de", "#ebeef2", "#111a2c"),
  dark: P("#030712", "#101828", "#101828", "#f3f4f6", "#99a1af", "#1e2939", "#0d1117", "#f3f4f6"),
};

/* ── fonts ───────────────────────────────────────────────────────────────── */

/**
 * The font allow-list. Each is self-hosted: a woff2 under src/docs/fonts (Latin subset, from
 * Google Fonts, OFL), loaded with next/font/local in src/docs/themeFonts.ts, so a reader's browser
 * never asks a third party. `system` is the platform's own UI face (no file).
 */
export const FONTS = {
  manrope: { label: "Manrope", kind: "sans" },
  inter: { label: "Inter", kind: "sans" },
  geist: { label: "Geist", kind: "sans" },
  "ibm-plex-sans": { label: "IBM Plex Sans", kind: "sans" },
  "source-sans-3": { label: "Source Sans 3", kind: "sans" },
  "dm-sans": { label: "DM Sans", kind: "sans" },
  nunito: { label: "Nunito", kind: "sans" },
  newsreader: { label: "Newsreader", kind: "serif" },
  "source-serif-4": { label: "Source Serif 4", kind: "serif" },
  lora: { label: "Lora", kind: "serif" },
  "jetbrains-mono": { label: "JetBrains Mono", kind: "mono" },
  "ibm-plex-mono": { label: "IBM Plex Mono", kind: "mono" },
  "geist-mono": { label: "Geist Mono", kind: "mono" },
  system: { label: "System UI", kind: "sans" },
};

/** The fallback stack after a font of each kind. */
export const FONT_STACKS = {
  sans: "ui-sans-serif, system-ui, sans-serif",
  serif: "ui-serif, Georgia, serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

export const MODES = ["both", "light", "dark"];
export const CUSTOM_CSS_MAX = 20 * 1024;

/* ── colour maths (as components/tenant/branding.ts) ─────────────────────── */

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function parseHex(v) {
  if (typeof v !== "string") return null;
  const m = HEX.exec(v.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function toHex([r, g, b]) {
  return "#" + [r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("");
}

function channel(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function luminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `amount` of `b` mixed into `a` (sRGB). */
export function mix(a, b, amount) {
  return [a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount];
}

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
/** gray-950: the dark text on a light accent. */
const INK = [3, 7, 18];
/** Wash strength of --accent-soft per theme (as branding.ts). */
export const WASH = { dark: 0.28, light: 0.14 };

/** Move `c` toward `toward` until it reaches `target` against every ground. */
function clampAgainst(c, grounds, toward, target) {
  let out = c;
  for (let i = 0; i <= 50; i++) {
    if (grounds.every((g) => contrast(out, g) >= target)) return out;
    out = mix(c, toward, i / 50);
  }
  return toward;
}

/** sRGB chroma (max − min channel), 0–1: how colourful, regardless of lightness. */
function chroma([r, g, b]) {
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
}

/**
 * Accent tokens for one theme over its grounds: the fill keeps the brand colour unless it would
 * vanish into a dark page (then it lightens to 3:1 against the page, the non-text minimum), the
 * label on it is white or ink (whichever contrasts more, fill nudged until 4.5:1), the hover moves
 * away from the label, and the accent *text* is clamped to 4.6:1 on every ground including its
 * own wash (6:1 for hover).
 */
export function accentFor(hex, theme, grounds) {
  const brand = parseHex(hex);
  if (!brand) return null;
  let base = brand;
  if (theme === "dark" && contrast(base, grounds[0]) < 3) base = clampAgainst(base, [grounds[0]], WHITE, 3);
  const lightText = contrast(WHITE, base) >= contrast(INK, base);
  const on = lightText ? WHITE : INK;
  let fill = base;
  for (let i = 1; contrast(on, fill) < 4.5 && i <= 40; i++) fill = mix(base, lightText ? BLACK : WHITE, i / 100);
  const hover = mix(fill, lightText ? BLACK : WHITE, 0.12);
  const washed = mix(grounds[0], brand, WASH[theme]);
  const all = [...grounds, washed];
  const toward = theme === "dark" ? WHITE : BLACK;
  return {
    accent: toHex(fill),
    accentHover: toHex(hover),
    onAccent: toHex(on),
    text: toHex(clampAgainst(brand, all, toward, 4.6)),
    textHover: toHex(clampAgainst(brand, all, toward, 6)),
  };
}

/* ── palettes ────────────────────────────────────────────────────────────── */

/**
 * Match my brand: the roles a list of brand colours plays. The accent is the first colour with
 * real colour in it (chroma ≥ 0.2), else the most colourful; the ink is the darkest colour dark
 * enough for body text (luminance < 0.04); the tint is the lightest one (luminance > 0.7), used as
 * the light theme's accent wash. Roles not found keep the preset's.
 */
export function brandRoles(colors) {
  const list = (Array.isArray(colors) ? colors : []).map((c) => ({ hex: c, rgb: parseHex(c) })).filter((c) => c.rgb);
  if (!list.length) return null;
  const chromatic = list.find((c) => chroma(c.rgb) >= 0.2 && luminance(c.rgb) > 0.02 && luminance(c.rgb) < 0.8);
  const accent = chromatic ?? [...list].sort((a, b) => chroma(b.rgb) - chroma(a.rgb))[0];
  const darks = list.filter((c) => c !== accent && luminance(c.rgb) < 0.04).sort((a, b) => luminance(a.rgb) - luminance(b.rgb));
  const tints = list.filter((c) => c !== accent && luminance(c.rgb) > 0.7).sort((a, b) => luminance(b.rgb) - luminance(a.rgb));
  return { accent: toHex(accent.rgb), ink: darks[0] ? toHex(darks[0].rgb) : undefined, tint: tints[0] ? toHex(tints[0].rgb) : undefined };
}

/**
 * The palette a site renders with, or null for Markdrop's own tokens (clean, no colours, no
 * accent). `accent` (site.json brand.accent) beats the colours' accent; `accentDark` sets dark's.
 */
export function buildPalette(presetId, { colors, accent, accentDark } = {}) {
  const preset = PRESETS[presetId] ?? PRESETS.clean;
  const roles = brandRoles(colors);
  if (!preset.palette && !roles) return null;
  const base = preset.palette ?? MARKDROP_BASE;
  const light = { ...base.light };
  const dark = { ...base.dark };
  if (roles?.ink) {
    // Text takes the brand's ink; the dark theme's grounds lean toward its hue.
    const ink = parseHex(roles.ink);
    light.text = roles.ink;
    light.muted = toHex(mix(ink, parseHex(light.bg), 0.42));
    for (const k of ["bg", "header", "card", "line", "code"]) dark[k] = toHex(mix(parseHex(dark[k]), ink, k === "line" ? 0.3 : 0.22));
  }
  return {
    accent: parseHex(accent) ? accent : roles?.accent ?? base.accent,
    accentDark: parseHex(accentDark) ? accentDark : undefined,
    tint: roles?.tint,
    light,
    dark,
  };
}

/** The design-system tokens for one theme of a palette, every text pair clamped to its minimum. */
export function paletteTokens(palette, theme) {
  const p = palette[theme];
  const toward = theme === "dark" ? WHITE : BLACK;
  const bg = parseHex(p.bg);
  const card = parseHex(p.card);
  const header = parseHex(p.header);
  const line = parseHex(p.line);
  let text = parseHex(p.text);
  const raised = theme === "light" ? mix(card, WHITE, 0.6) : mix(card, text, 0.05);
  const hover = mix(card, text, 0.05);
  const active = mix(card, text, 0.1);
  const inset = mix(bg, text, theme === "light" ? 0.04 : 0.03);
  const grounds = [bg, card, header, raised, hover, inset];
  text = clampAgainst(text, grounds, toward, 12);
  const muted = clampAgainst(parseHex(p.muted), grounds, toward, 4.6);
  const secondary = clampAgainst(mix(text, muted, 0.45), grounds, toward, 7);
  const subtle = mix(muted, bg, 0.25);
  const a = accentFor(theme === "dark" ? palette.accentDark ?? palette.accent : palette.accent, theme, [bg, card, raised, header, hover, inset]);
  const inlineBg = mix(bg, text, 0.06);
  const soft = theme === "light" && palette.tint ? palette.tint : `color-mix(in oklab, ${a.accent} ${Math.round(WASH[theme] * 100)}%, transparent)`;
  // With a light tint as the wash, accent text is re-clamped against it too.
  const accentText = theme === "light" && palette.tint ? toHex(clampAgainst(parseHex(a.text), [parseHex(palette.tint)], toward, 4.6)) : a.text;
  return {
    "--bg": toHex(bg),
    "--surface": toHex(card),
    "--surface-raised": toHex(raised),
    "--surface-hover": toHex(hover),
    "--surface-active": toHex(active),
    "--surface-inset": toHex(inset),
    "--border": toHex(line),
    "--border-strong": toHex(mix(line, text, 0.2)),
    "--border-focus": a.text,
    "--text": toHex(text),
    "--text-secondary": toHex(secondary),
    "--text-muted": toHex(muted),
    "--text-subtle": toHex(subtle),
    "--text-inverse": toHex(bg),
    "--surface-inverse": toHex(text),
    "--accent": a.accent,
    "--accent-hover": a.accentHover,
    "--on-accent": a.onAccent,
    "--accent-text": accentText,
    "--accent-text-hover": a.textHover,
    "--accent-soft": soft,
    "--accent-ring": `color-mix(in oklab, ${a.accent} 30%, transparent)`,
    "--code-bg": p.code,
    "--code-border": toHex(mix(parseHex(p.code), parseHex(p.codeText), 0.14)),
    "--code-inline-bg": toHex(inlineBg),
    "--code-inline": toHex(clampAgainst(secondary, [inlineBg], toward, 4.6)),
    "--dx-header-bg": toHex(header),
  };
}

/**
 * Contrast of what readers read, per theme (the minimum over the grounds each is drawn on): body
 * text, muted text, links (accent text, also on its wash) and a button's label on its fill.
 */
export function paletteReport(palette) {
  const out = {};
  for (const theme of ["light", "dark"]) {
    const t = paletteTokens(palette, theme);
    const g = ["--bg", "--surface", "--surface-raised", "--surface-inset"].map((k) => parseHex(t[k]));
    const min = (fg) => Math.min(...g.map((x) => contrast(parseHex(fg), x)));
    const round = (n) => Math.round(n * 10) / 10;
    out[theme] = {
      text: round(min(t["--text"])),
      muted: round(min(t["--text-muted"])),
      links: round(min(t["--accent-text"])),
      button: round(contrast(parseHex(t["--on-accent"]), parseHex(t["--accent"]))),
    };
  }
  return out;
}

/* ── custom CSS ──────────────────────────────────────────────────────────── */

const BANNED = [
  [/<\/?\s*style/i, "</style"],
  [/</, "<"],
  [/\\/, "backslash escapes"],
  [/expression\s*\(/i, "expression()"],
  [/javascript\s*:/i, "javascript:"],
  [/vbscript\s*:/i, "vbscript:"],
  [/-moz-binding/i, "-moz-binding"],
  [/\bbehaviou?r\s*:/i, "behavior:"],
  [/@import/i, "@import"],
  [/\bsrc\s*\(/i, "src()"],
  [/image-set\s*\(/i, "image-set()"],
];
/** At-rules whose block holds rules (scoped like the top level). */
const GROUPING = new Set(["media", "supports", "container", "layer"]);
/** At-rules whose block is kept as written (after the checks above and the url() rule). */
const VERBATIM = new Set(["keyframes", "-webkit-keyframes", "font-face", "property"]);

/** Splits on `sep` outside strings, (), []. */
function splitTop(s, sep) {
  const out = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === sep && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/**
 * One selector under the scope: `.x` → `.dx-root .x`; `:root`, `html` and `body` are the scope
 * itself (`html[data-theme="dark"] .x` keeps the theme switch in front: `html[data-theme="dark"]
 * .dx-root .x`); a selector already starting with the scope is left alone.
 */
function scopeSelector(sel, scope) {
  const s = sel.trim().replace(/\s+/g, " ");
  if (!s) return null;
  if (s === scope || s.startsWith(scope + " ") || s.startsWith(scope + ".") || s.startsWith(scope + "[") || s.startsWith(scope + ":")) return s;
  const m = /^(html|:root|body)((?:\[[^\]]*\])*)(?=$|[\s>+~:.#[])(.*)$/i.exec(s);
  if (m) {
    const [, el, attrs, rest] = m;
    if (el.toLowerCase() === "body" || !attrs) return `${scope}${rest}`;
    return `${el}${attrs} ${scope}${rest.startsWith(" ") || !rest ? rest : " " + rest}`.trim();
  }
  if (/^\[data-theme/i.test(s)) {
    const t = /^((?:\[[^\]]*\])+)(.*)$/.exec(s);
    return `${t[1]} ${scope}${t[2]}`;
  }
  return `${scope} ${s}`;
}

/** Every url() is https or a site file (/docs-assets/…). */
function checkUrls(text, errors) {
  const re = /url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
  let m;
  while ((m = re.exec(text))) {
    const u = m[2].trim();
    if (!(/^https:\/\/[^\s]+$/i.test(u) || /^\/docs-assets\/[^\s]*$/.test(u))) errors.push(`url(${u}) must be an https URL or a /docs-assets/ file`);
  }
  if (/url\s*\(/i.test(text.replace(re, ""))) errors.push("a url() that isn't a plain address");
}

/** Parses a run of rules; returns the scoped CSS. Throws a message on malformed input. */
function scopeRules(src, scope, errors, depth = 0) {
  let out = "";
  let i = 0;
  const n = src.length;
  const readBlock = (from) => {
    // from: index just after "{"; returns index of the matching "}"
    let d = 1;
    let quote = null;
    for (let j = from; j < n; j++) {
      const c = src[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "{") d++;
      else if (c === "}" && --d === 0) return j;
    }
    throw new Error("a { has no matching }");
  };
  while (i < n) {
    while (i < n && /\s/.test(src[i])) i++;
    if (i >= n) break;
    // Prelude: up to "{" or ";" (outside strings/parens).
    let j = i;
    let quote = null;
    let paren = 0;
    for (; j < n; j++) {
      const c = src[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "(") paren++;
      else if (c === ")") paren--;
      else if (paren === 0 && (c === "{" || c === ";" || c === "}")) break;
    }
    const prelude = src.slice(i, j).trim();
    if (j >= n) throw new Error(`"${prelude.slice(0, 40)}" has no { … } block`);
    if (src[j] === "}") throw new Error("a } has no matching {");
    if (src[j] === ";") {
      // Statement at-rules: only `@layer a, b;`.
      if (!/^@layer\s+[\w-]+(\s*,\s*[\w-]+)*$/i.test(prelude)) throw new Error(`"${prelude.slice(0, 40)}" is not allowed here`);
      out += prelude + ";";
      i = j + 1;
      continue;
    }
    const end = readBlock(j + 1);
    const body = src.slice(j + 1, end);
    if (prelude.startsWith("@")) {
      const name = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? "";
      if (GROUPING.has(name)) {
        if (depth > 3) throw new Error("at-rules nest too deep");
        out += `${prelude}{${scopeRules(body, scope, errors, depth + 1)}}`;
      } else if (VERBATIM.has(name)) {
        out += `${prelude}{${body.trim()}}`;
      } else throw new Error(`@${name} is not allowed (only @media, @supports, @container, @layer, @keyframes, @font-face, @property)`);
    } else {
      if (!prelude) throw new Error("a { … } block has no selector");
      if (body.replace(/"[^"]*"|'[^']*'/g, "").includes("{")) throw new Error(`"${prelude.slice(0, 40)}" has a nested block (CSS nesting isn't supported here)`);
      const sels = splitTop(prelude, ",").map((s) => scopeSelector(s, scope));
      if (sels.some((s) => !s)) throw new Error(`"${prelude.slice(0, 40)}" has an empty selector`);
      out += `${sels.join(",")}{${body.trim()}}`;
    }
    i = end + 1;
  }
  return out;
}

/**
 * Custom CSS made safe to inline in a <style>: comments dropped; no `<`, backslash escapes,
 * @import, expression(), javascript:, bindings, or url() other than https and /docs-assets/; every
 * selector scoped under `scope` (default the docs root). Returns the CSS, or errors and no CSS.
 */
export function sanitizeCss(input, scope = ".dx-root") {
  const errors = [];
  if (typeof input !== "string") return { css: "", errors: ["customCss must be a string"] };
  if (input.length > CUSTOM_CSS_MAX) return { css: "", errors: [`customCss is ${input.length} bytes; the limit is ${CUSTOM_CSS_MAX}`] };
  const src = input.replace(/\/\*[\s\S]*?\*\//g, " ");
  if (src.includes("/*")) errors.push("an unclosed /* comment");
  for (const [re, what] of BANNED) if (re.test(src)) errors.push(`${what} isn't allowed`);
  checkUrls(src, errors);
  if (errors.length) return { css: "", errors };
  try {
    return { css: scopeRules(src, scope, errors), errors };
  } catch (e) {
    return { css: "", errors: [e.message] };
  }
}

/* ── the site's theme ────────────────────────────────────────────────────── */

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * site.json `theme` (+ brand accent) → what the engine renders, or null when the site has no
 * theme key (today's look, nothing added). Bad values fall back to the preset's (docs:check
 * reports them).
 */
export function resolveTheme(theme, brand) {
  if (!isObj(theme)) return null;
  const presetId = Object.hasOwn(PRESETS, theme.preset) ? theme.preset : "clean";
  const preset = PRESETS[presetId];
  const font = (key, kinds) => {
    const id = theme.fonts?.[key];
    return Object.hasOwn(FONTS, id) && kinds.includes(FONTS[id].kind) ? id : preset.fonts[key];
  };
  const corners = Object.hasOwn(CORNERS, theme.corners) ? CORNERS[theme.corners] : typeof preset.corners === "string" ? CORNERS[preset.corners] : preset.corners;
  const mode = MODES.includes(theme.mode) ? theme.mode : "both";
  const custom = typeof theme.customCss === "string" && theme.customCss.trim() ? sanitizeCss(theme.customCss) : { css: "", errors: [] };
  return {
    preset: presetId,
    layout: preset.layout,
    fonts: { heading: font("heading", ["sans", "serif"]), body: font("body", ["sans", "serif"]), mono: font("mono", ["mono"]) },
    headingWeight: preset.headingWeight,
    radius: corners,
    mode,
    palette: buildPalette(presetId, { colors: theme.colors, accent: brand?.accent, accentDark: brand?.accentDark }),
    customCss: custom.css,
    customCssErrors: custom.errors,
  };
}

const decls = (o) =>
  Object.entries(o)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");

/**
 * The stylesheet for a resolved theme: fonts (`families`: font id → the CSS family next/font gave
 * it), the radius scale and the palette's tokens per theme, then the custom CSS. Specificity is
 * doubled like the accent stylesheet's (brand.ts), so it also wins in nested theme scopes.
 */
export function themeCss(t, families) {
  const fam = (id) => {
    const kind = FONTS[id]?.kind ?? "sans";
    const f = families[id];
    return f ? `${f}, ${FONT_STACKS[kind]}` : FONT_STACKS[kind];
  };
  const rootVars = {
    "--font-sans": fam(t.fonts.body),
    "--font-mono": fam(t.fonts.mono),
    "--dx-font-heading": fam(t.fonts.heading),
    "--dx-heading-weight": String(t.headingWeight),
    ...Object.fromEntries(Object.entries(t.radius).map(([k, v]) => [`--radius-${k}`, `${v}px`])),
  };
  const out = [`html:root{${decls(rootVars)}}`];
  if (t.palette) {
    const themes = t.mode === "light" ? ["light"] : t.mode === "dark" ? ["dark"] : ["dark", "light"];
    for (const theme of themes) {
      const sel = theme === "dark" ? `:root,[data-theme="dark"][data-theme]` : `[data-theme="light"][data-theme]`;
      // A forced mode paints its palette whatever the attribute says (before the script runs, too).
      out.push(`${t.mode === "both" ? sel : `:root,[data-theme][data-theme]`}{${decls(paletteTokens(t.palette, theme))}}`);
    }
  }
  if (t.customCss) out.push(t.customCss);
  return out.join("\n");
}

/* ── validation (docs:check) ─────────────────────────────────────────────── */

/** Problems with site.json `theme`: [{ level: "error" | "warn", msg }]. */
export function validateTheme(theme) {
  const out = [];
  const err = (msg) => out.push({ level: "error", msg });
  const warn = (msg) => out.push({ level: "warn", msg });
  if (theme === undefined) return out;
  if (!isObj(theme)) return [{ level: "error", msg: "theme must be an object" }];
  for (const k of Object.keys(theme)) if (!["preset", "fonts", "corners", "mode", "colors", "customCss"].includes(k)) warn(`theme.${k} is not a setting (ignored)`);
  if (theme.preset !== undefined && !Object.hasOwn(PRESETS, theme.preset)) err(`theme.preset "${theme.preset}" must be one of ${Object.keys(PRESETS).join(", ")}`);
  if (theme.fonts !== undefined) {
    if (!isObj(theme.fonts)) err("theme.fonts must be an object like { \"heading\": \"newsreader\", \"body\": \"inter\" }");
    else {
      for (const k of Object.keys(theme.fonts)) if (!["heading", "body", "mono"].includes(k)) warn(`theme.fonts.${k} is not a setting (ignored)`);
      for (const k of ["heading", "body", "mono"]) {
        const id = theme.fonts[k];
        if (id === undefined) continue;
        if (!Object.hasOwn(FONTS, id)) err(`theme.fonts.${k} "${id}" isn't an available font (${Object.keys(FONTS).join(", ")})`);
        else if (k === "mono" && FONTS[id].kind !== "mono") err(`theme.fonts.mono "${id}" isn't a monospaced font`);
        else if (k !== "mono" && FONTS[id].kind === "mono") err(`theme.fonts.${k} "${id}" is a code font; pick a sans or serif`);
      }
    }
  }
  if (theme.corners !== undefined && !Object.hasOwn(CORNERS, theme.corners)) err(`theme.corners "${theme.corners}" must be sharp, soft or round`);
  if (theme.mode !== undefined && !MODES.includes(theme.mode)) err(`theme.mode "${theme.mode}" must be both, light or dark`);
  if (theme.colors !== undefined) {
    if (!Array.isArray(theme.colors) || !theme.colors.length || theme.colors.length > 8) err("theme.colors must be a list of 1 to 8 hex colours");
    else {
      theme.colors.forEach((c, i) => {
        if (!parseHex(c)) err(`theme.colors[${i}] "${c}" must be a hex colour like #0f766e`);
      });
      if (theme.colors.every((c) => parseHex(c)) && !brandRoles(theme.colors)) err("theme.colors has no usable colour");
    }
  }
  if (theme.customCss !== undefined) {
    if (typeof theme.customCss !== "string") err("theme.customCss must be a string");
    else for (const e of sanitizeCss(theme.customCss).errors) err(`theme.customCss: ${e}`);
  }
  return out;
}
