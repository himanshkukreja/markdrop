/**
 * Docs themes (site.json `theme`): the fourteen presets, the font allow-list, corners, colour mode,
 * palettes built from brand colours, and custom CSS. Plain ESM with no imports, shared by the
 * engine (src/docs/themeSite.ts), docs:check and the tests.
 *
 *   "theme": {
 *     "preset": "clean" | "editorial" | "technical" | "minimal" | "playful" | "helpcenter" | "midnight"
 *               | "paper" | "terminal" | "corporate" | "studio" | "academic" | "atlas" | "pastel",
 *     "fonts": { "heading": "newsreader", "body": "source-sans-3", "mono": "plex-mono" },
 *     "corners": "sharp" | "soft" | "round",          // overrides the preset's radius scale
 *     "mode": "both" | "light" | "dark",               // light-only / dark-only hide the switch
 *     "customCss": ".dx-title { letter-spacing: 0 }",  // sanitised, scoped under .dx-root
 *     "custom": { "light": { "bg": "#fbfaf7", "accent": "#0f766e" }, "dark": { … },
 *                 "baseSize": 17, "buttons": "pill", "sidebarStyle": "lines", "icons": "duotone", … }
 *                                                       // a custom theme: the preset, then these
 *   },
 *   "brand": { "colors": ["#0f766e", "#13203a", "#e6f4f1"], "accent": "#0f766e", … }
 *                                                       // Match my brand: accent, ink, soft tint
 *
 * Every key is optional, and null means "the preset's default" (what the API writes for "Theme
 * default"). Font ids are the API's (docs_sites settings.theme.fonts). No `theme` and no
 * `brand.colors` is today's docs.markdrop.in look, token for token: the engine adds nothing (no
 * attribute, no stylesheet).
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
 * home (optional): "categories" puts the help center's home (search, category cards) in front of
 * another layout's articles; by default it follows the layout ("categories" for helpcenter only).
 */
export const PRESETS = {
  clean: {
    label: "Clean",
    blurb: "Sidebar layout. Calm and familiar.",
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
    fonts: { heading: "plex", body: "plex", mono: "plex-mono" },
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
    fonts: { heading: "dmsans", body: "dmsans", mono: "jetbrains-mono" },
    corners: { sm: 6, md: 8, lg: 10, xl: 12, "2xl": 16, "3xl": 24 },
    headingWeight: 700,
    palette: {
      accent: "#c2410c",
      light: P("#ffffff", "#ffffff", "#ffffff", "#1c1917", "#6b625c", "#ebe5df", "#f6f2ee", "#1c1917"),
      dark: P("#121010", "#121010", "#1a1716", "#f5f0eb", "#ada39b", "#2e2826", "#0c0a0a", "#f5f0eb"),
    },
  },
  // The eight below (Themes board, "Choose a look") carry their own dark accent too: the light
  // one, lightened by the maths, would look washed out on their dark grounds. Brand colours replace
  // both (buildPalette). Every text colour here already passes on its grounds, before any clamping
  // (theme.test.mjs checks that the maths leaves them as designed).
  midnight: {
    label: "Midnight",
    blurb: "Deep navy, violet accent. Developer tools.",
    layout: "sidebar",
    fonts: { heading: "geist", body: "geist", mono: "geist-mono" },
    corners: { sm: 4, md: 6, lg: 8, xl: 10, "2xl": 14, "3xl": 20 },
    headingWeight: 700,
    palette: {
      accent: "#6d28d9",
      accentDark: "#a78bfa",
      light: P("#f7f8fc", "#ffffff", "#ffffff", "#0f1226", "#545a78", "#e2e4f0", "#f0f1f8", "#0f1226"),
      dark: P("#0b0e1c", "#0f1326", "#12162b", "#e7e9ff", "#a3a8cc", "#252a4a", "#070914", "#e7e9ff"),
    },
  },
  paper: {
    label: "Paper",
    blurb: "Warm paper, serif text, a quiet sidebar. Handbooks.",
    layout: "sidebar",
    fonts: { heading: "lora", body: "lora", mono: "jetbrains-mono" },
    corners: { sm: 3, md: 4, lg: 6, xl: 8, "2xl": 10, "3xl": 14 },
    headingWeight: 600,
    palette: {
      accent: "#9a3412",
      accentDark: "#fdba74",
      light: P("#fbf7ee", "#fbf7ee", "#fffdf8", "#2a2419", "#6b604c", "#e9dfcb", "#f4ecdc", "#2a2419"),
      dark: P("#1b1813", "#1b1813", "#221e17", "#f5eddf", "#b0a48c", "#3a3326", "#13110d", "#f5eddf"),
    },
  },
  terminal: {
    label: "Terminal",
    blurb: "Monospace headings, green on black. CLI tools.",
    layout: "sidebar",
    fonts: { heading: "jetbrains-mono", body: "plex", mono: "jetbrains-mono" },
    corners: "sharp",
    headingWeight: 700,
    palette: {
      accent: "#15803d",
      accentDark: "#4ade80",
      light: P("#fbfdfb", "#ffffff", "#f5f9f6", "#0c1a10", "#4a5e50", "#dce6de", "#eef4ef", "#0c1a10"),
      dark: P("#0a0f0b", "#0d140f", "#0f1711", "#d7f5df", "#8fb39a", "#1f3024", "#050805", "#c8f7d4"),
    },
  },
  corporate: {
    label: "Corporate",
    blurb: "Strict and compact, blue-grey. Enterprise.",
    layout: "sidebar",
    fonts: { heading: "source-sans-3", body: "source-sans-3", mono: "plex-mono" },
    corners: { sm: 2, md: 2, lg: 2, xl: 3, "2xl": 4, "3xl": 4 },
    headingWeight: 700,
    palette: {
      accent: "#1e40af",
      accentDark: "#93c5fd",
      light: P("#f4f6f9", "#ffffff", "#ffffff", "#111827", "#4b5563", "#d9dee6", "#eef1f5", "#111827"),
      dark: P("#0f141b", "#141b24", "#161e28", "#e5e9f0", "#9aa5b5", "#273241", "#0b0f15", "#e5e9f0"),
    },
  },
  studio: {
    label: "Studio",
    blurb: "Bold display type, big rounded cards. Launches.",
    layout: "sidebar",
    fonts: { heading: "dmsans", body: "inter", mono: "jetbrains-mono" },
    corners: { sm: 6, md: 8, lg: 12, xl: 12, "2xl": 16, "3xl": 24 },
    headingWeight: 800,
    palette: {
      accent: "#e11d48",
      accentDark: "#fb7185",
      light: P("#fffafb", "#ffffff", "#ffffff", "#1a0b10", "#6b5459", "#f3e1e4", "#fdf2f4", "#1a0b10"),
      dark: P("#140b0e", "#1a0f13", "#1f1217", "#fbeef1", "#c2a5ad", "#3a2129", "#0d0709", "#fbeef1"),
    },
  },
  academic: {
    label: "Academic",
    blurb: "Serif, numbered sections, footnote style. Knowledge bases.",
    layout: "sidebar",
    fonts: { heading: "source-serif-4", body: "source-serif-4", mono: "plex-mono" },
    corners: { sm: 2, md: 2, lg: 3, xl: 4, "2xl": 6, "3xl": 8 },
    headingWeight: 600,
    palette: {
      accent: "#047857",
      accentDark: "#34d399",
      light: P("#fdfdfb", "#fdfdfb", "#ffffff", "#161a18", "#535c57", "#e1e5e1", "#f3f5f2", "#161a18"),
      dark: P("#111513", "#111513", "#161b18", "#e9eee9", "#a0aca5", "#29312c", "#0b0e0c", "#e9eee9"),
    },
  },
  atlas: {
    label: "Atlas",
    blurb: "Top tabs and a card-grid home. Big help centers.",
    layout: "sidebar",
    home: "categories",
    sectionTabs: true,
    fonts: { heading: "inter", body: "inter", mono: "jetbrains-mono" },
    corners: { sm: 4, md: 6, lg: 8, xl: 10, "2xl": 14, "3xl": 20 },
    headingWeight: 700,
    palette: {
      accent: "#0369a1",
      accentDark: "#38bdf8",
      light: P("#f6fafd", "#ffffff", "#ffffff", "#0c1a26", "#4a5d6e", "#dbe7f0", "#eef4f9", "#0c1a26"),
      dark: P("#08131c", "#0c1924", "#0f1e2b", "#e3f0fa", "#93aabd", "#1d3242", "#050d13", "#e3f0fa"),
    },
  },
  pastel: {
    label: "Pastel",
    blurb: "Soft colours, friendly shapes. Education and community.",
    layout: "sidebar",
    fonts: { heading: "nunito", body: "dmsans", mono: "jetbrains-mono" },
    corners: { sm: 6, md: 8, lg: 10, xl: 10, "2xl": 14, "3xl": 20 },
    headingWeight: 800,
    palette: {
      accent: "#be185d",
      accentDark: "#f472b6",
      light: P("#fdf6fa", "#fffafd", "#ffffff", "#2a1424", "#6e5566", "#f3d9e8", "#fbeef5", "#2a1424"),
      dark: P("#1a1018", "#20141d", "#251722", "#fbeaf4", "#c9a9bd", "#40273a", "#120b11", "#fbeaf4"),
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
  plex: { label: "IBM Plex Sans", kind: "sans" },
  "source-sans-3": { label: "Source Sans 3", kind: "sans" },
  dmsans: { label: "DM Sans", kind: "sans" },
  nunito: { label: "Nunito", kind: "sans" },
  newsreader: { label: "Newsreader", kind: "serif" },
  "source-serif-4": { label: "Source Serif 4", kind: "serif" },
  lora: { label: "Lora", kind: "serif" },
  "jetbrains-mono": { label: "JetBrains Mono", kind: "mono" },
  "plex-mono": { label: "IBM Plex Mono", kind: "mono" },
  "geist-mono": { label: "Geist Mono", kind: "mono" },
  system: { label: "System UI", kind: "sans" },
  // Added with custom themes (the theme builder): two display sans, a humanist sans, two serifs, two code faces.
  "space-grotesk": { label: "Space Grotesk", kind: "sans" },
  "plus-jakarta-sans": { label: "Plus Jakarta Sans", kind: "sans" },
  figtree: { label: "Figtree", kind: "sans" },
  fraunces: { label: "Fraunces", kind: "serif" },
  "crimson-pro": { label: "Crimson Pro", kind: "serif" },
  "fira-code": { label: "Fira Code", kind: "mono" },
  "source-code-pro": { label: "Source Code Pro", kind: "mono" },
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
  // A brand accent replaces the preset's in both themes (its dark one too, unless brand.accentDark).
  const brandAccent = parseHex(accent) ? accent : roles?.accent;
  return {
    accent: brandAccent ?? base.accent,
    accentDark: parseHex(accentDark) ? accentDark : brandAccent ? undefined : base.accentDark,
    tint: roles?.tint,
    light,
    dark,
  };
}

/** Which way a colour on `ground` moves to gain contrast: toward black on a light ground, white on a dark one. */
function awayFrom(ground) {
  return luminance(ground) > 0.18 ? BLACK : WHITE;
}

/**
 * Minimum contrast the engine enforces. A preset's own colours are held to their designed ratios
 * (text 12:1); a custom theme's are held to WCAG AA (4.5:1), so what the owner picked is what
 * readers see whenever it is legible, and the nearest legible shade when it isn't.
 */
const MIN = { preset: { text: 12, muted: 4.6, secondary: 7 }, custom: { text: 4.5, muted: 4.5, secondary: 4.5 } };

/** The callout kinds a custom theme can colour. */
export const CALLOUT_KINDS = ["note", "tip", "warning", "danger"];

/** The design-system tokens for one theme of a palette, every text pair clamped to its minimum. */
export function paletteTokens(palette, theme) {
  const p = palette[theme];
  const custom = !!palette.custom;
  const min = custom ? MIN.custom : MIN.preset;
  const bg = parseHex(p.bg);
  // A custom palette may put a dark ground in the light theme (or the reverse): text moves away
  // from its own ground, whatever the theme is called.
  const toward = custom ? awayFrom(bg) : theme === "dark" ? WHITE : BLACK;
  const look = custom ? (toward === WHITE ? "dark" : "light") : theme;
  const card = parseHex(p.card);
  const header = parseHex(p.header);
  const line = parseHex(p.line);
  const sidebar = parseHex(p.sidebar);
  let text = parseHex(p.text);
  const raised = look === "light" ? mix(card, WHITE, 0.6) : mix(card, text, 0.05);
  const hover = mix(card, text, 0.05);
  const active = mix(card, text, 0.1);
  const inset = mix(bg, text, look === "light" ? 0.04 : 0.03);
  const grounds = [bg, card, header, raised, hover, inset, ...(sidebar ? [sidebar] : [])];
  text = clampAgainst(text, grounds, toward, min.text);
  const muted = clampAgainst(parseHex(p.muted), grounds, toward, min.muted);
  const secondary = clampAgainst(mix(text, muted, 0.45), grounds, toward, min.secondary);
  const subtle = mix(muted, bg, 0.25);
  const a = accentFor(theme === "dark" ? palette.accentDark ?? palette.accent : palette.accent, look, grounds);
  const inlineBg = mix(bg, text, 0.06);
  const soft = theme === "light" && palette.tint ? palette.tint : `color-mix(in oklab, ${a.accent} ${Math.round(WASH[look] * 100)}%, transparent)`;
  // With a light tint as the wash, accent text is re-clamped against it too.
  const accentText = theme === "light" && palette.tint ? toHex(clampAgainst(parseHex(a.text), [parseHex(palette.tint)], toward, 4.6)) : a.text;
  const out = {
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
  // Custom-theme colours: only written when set, so a preset's stylesheet is exactly what it was.
  if (palette.light.sidebar || palette.dark.sidebar) out["--dx-sidebar-bg"] = toHex(sidebar ?? bg);
  for (const kind of CALLOUT_KINDS) {
    const tone = parseHex(p[kind]);
    if (!tone) continue;
    const wash = mix(bg, tone, look === "light" ? 0.12 : 0.2);
    out[`--dx-${kind}`] = toHex(clampAgainst(tone, [bg, card, wash], toward, 4.6));
    out[`--dx-${kind}-soft`] = toHex(wash);
  }
  const sel = parseHex(p.selection);
  if (sel) out["--dx-selection"] = toHex(selectionFor(sel, text, bg));
  return out;
}

/** A selection colour text stays readable on (4.5:1): moved toward the page until it is. */
function selectionFor(sel, text, bg) {
  for (let i = 0; i <= 50; i++) {
    const c = mix(sel, bg, i / 50);
    if (contrast(text, c) >= 4.5) return c;
  }
  return bg;
}

/** GitHub's syntax colours, light and dark (as styles/ds/tokens.css): a forced code theme brings its own. */
const SYNTAX = {
  light: { keyword: "#c11f2b", string: "#0a3069", comment: "#57606a", number: "#0550ae", title: "#7340d0", attr: "#116329", builtin: "#953800", meta: "#0550ae", punct: "#1f2328", addition: "#116329", "addition-bg": "#dafbe1", deletion: "#82071e", "deletion-bg": "#ffebe9" },
  dark: { keyword: "#ff7b72", string: "#a5d6ff", comment: "#8b949e", number: "#79c0ff", title: "#d2a8ff", attr: "#7ee787", builtin: "#ffa657", meta: "#79c0ff", punct: "#c9d1d9", addition: "#aff5b4", "addition-bg": "#033a16", deletion: "#ffdcd7", "deletion-bg": "#67060c" },
};
const CODE_DEFAULT = { light: { bg: "#f6f8fa", text: "#1f2328" }, dark: { bg: "#0d1117", text: "#e6edf3" } };

/**
 * A custom theme's code blocks in one theme: the block's own tokens (ground, text, syntax), or
 * null when the theme leaves code to the preset (no code theme, no code colours). "auto" follows
 * the palette's code colours; "light" / "dark" use that look in both themes (the owner's code
 * ground is kept when it suits the look). Text is clamped to 4.5:1 on the block, and the syntax
 * colours follow how dark the block is.
 */
export function codeTokens(palette, theme, codeTheme) {
  const p = palette[theme];
  const forced = codeTheme === "light" || codeTheme === "dark" ? codeTheme : null;
  if (!palette.custom || (!p.codeSet && !forced)) return null;
  const ownBg = p.codeSet ? parseHex(p.code) : null;
  const bg = ownBg && (!forced || (luminance(ownBg) > 0.18) === (forced === "light")) ? ownBg : parseHex(forced ? CODE_DEFAULT[forced].bg : p.code);
  const dark = luminance(bg) <= 0.18;
  const ownText = p.codeSet ? parseHex(p.codeText) : null;
  const text = clampAgainst(ownText ?? parseHex(forced ? CODE_DEFAULT[forced].text : p.codeText), [bg], dark ? WHITE : BLACK, 4.5);
  const muted = clampAgainst(mix(text, bg, 0.35), [bg], dark ? WHITE : BLACK, 4.5);
  return {
    "color-scheme": dark ? "dark" : "light",
    "--code-bg": toHex(bg),
    "--code-border": toHex(mix(bg, text, 0.14)),
    "--text": toHex(text),
    "--text-secondary": toHex(muted),
    "--text-muted": toHex(muted),
    "--surface-hover": toHex(mix(bg, text, 0.07)),
    "--surface-active": toHex(mix(bg, text, 0.12)),
    ...Object.fromEntries(Object.entries(SYNTAX[dark ? "dark" : "light"]).map(([k, v]) => [`--syntax-${k}`, v])),
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

/* ── custom themes (the theme builder) ───────────────────────────────────── */

/**
 * A custom theme (site.json `theme.custom`): the preset, then the owner's choices. Every key is
 * optional and null keeps the preset's. Colours are per theme (light / dark); the rest applies to
 * both. The API stores the same block with snake_case keys (docs_site_settings.py Custom;
 * tests/test_docs_site_presets.py keeps the lists below equal to the API's).
 *
 *   light / dark   colours: CUSTOM_COLORS
 *   baseSize       reading size, px (14–20)        lineHeight     1.3–2
 *   headingWeight  400–900 by 100                  contentWidth   the article column, px (560–1040)
 *   radius, buttons, cards, headerAlign, headerStyle, tabStyle, sidebarStyle, callouts, codeTheme,
 *   links, icons   one of CUSTOM_OPTIONS
 *   sectionTabs    the header shows the nav groups as tabs (Atlas does by default)
 *   sidebarIcons   false hides the sidebar's page icons
 */
export const CUSTOM_COLORS = ["bg", "surface", "sidebar", "header", "text", "muted", "accent", "border", "codeBg", "codeText", "note", "tip", "warning", "danger", "selection"];

export const CUSTOM_OPTIONS = {
  radius: ["none", "small", "medium", "large", "xlarge"],
  buttons: ["square", "rounded", "pill"],
  cards: ["flat", "bordered", "raised"],
  headerAlign: ["left", "center"],
  headerStyle: ["solid", "transparent"],
  tabStyle: ["pills", "underline"],
  sidebarStyle: ["pills", "lines", "plain"],
  callouts: ["tinted", "bordered", "bar"],
  codeTheme: ["auto", "light", "dark"],
  links: ["underline", "accent", "plain"],
  icons: ["regular", "light", "bold", "duotone"],
};

export const CUSTOM_BOOLS = ["sectionTabs", "sidebarIcons"];

/** [min, max, step] of the numeric settings. */
export const CUSTOM_RANGES = {
  baseSize: [14, 20, 0.5],
  lineHeight: [1.3, 2, 0.05],
  headingWeight: [400, 900, 100],
  contentWidth: [560, 1040, 10],
};

/** The radius scales behind `radius` ("medium" is the design system's own, as corners "soft"). */
export const CUSTOM_RADIUS = {
  none: { sm: 0, md: 0, lg: 0, xl: 0, "2xl": 0, "3xl": 0 },
  small: CORNERS.sharp,
  medium: CORNERS.soft,
  large: CORNERS.round,
  xlarge: { sm: 10, md: 12, lg: 16, xl: 20, "2xl": 24, "3xl": 32 },
};

/** Where each custom colour lands in a base palette (theme.mjs P()). */
const COLOR_SLOT = { bg: "bg", surface: "card", sidebar: "sidebar", header: "header", text: "text", muted: "muted", border: "line", codeBg: "code", codeText: "codeText", note: "note", tip: "tip", warning: "warning", danger: "danger", selection: "selection" };

const onStep = (v, [lo, hi, step]) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi && Math.abs(Math.round((v - lo) / step) * step - (v - lo)) < 1e-6;

/**
 * `theme.custom` with every invalid or unset value dropped, or null when nothing is left (the
 * preset as it is). Colours are lower-case six-digit hex.
 */
export function normalizeCustom(raw) {
  if (!isObj(raw)) return null;
  const out = {};
  for (const mode of ["light", "dark"]) {
    if (!isObj(raw[mode])) continue;
    const colors = {};
    for (const k of CUSTOM_COLORS) {
      const c = parseHex(raw[mode][k]);
      if (c) colors[k] = toHex(c);
    }
    if (Object.keys(colors).length) out[mode] = colors;
  }
  for (const [k, allowed] of Object.entries(CUSTOM_OPTIONS)) if (allowed.includes(raw[k])) out[k] = raw[k];
  for (const k of CUSTOM_BOOLS) if (typeof raw[k] === "boolean") out[k] = raw[k];
  for (const [k, range] of Object.entries(CUSTOM_RANGES)) if (onStep(raw[k], range)) out[k] = raw[k];
  return Object.keys(out).length ? out : null;
}

/** Problems with site.json `theme.custom`, for docs:check (and the builder): messages. */
export function validateCustom(raw) {
  if (raw === undefined || raw === null) return [];
  if (!isObj(raw)) return ["theme.custom must be an object"];
  const out = [];
  const known = new Set(["light", "dark", ...Object.keys(CUSTOM_OPTIONS), ...CUSTOM_BOOLS, ...Object.keys(CUSTOM_RANGES)]);
  for (const k of Object.keys(raw)) if (!known.has(k)) out.push(`theme.custom.${k} is not a setting`);
  for (const mode of ["light", "dark"]) {
    const m = raw[mode];
    if (m === undefined || m === null) continue;
    if (!isObj(m)) {
      out.push(`theme.custom.${mode} must be an object of colours`);
      continue;
    }
    for (const [k, v] of Object.entries(m)) {
      if (!CUSTOM_COLORS.includes(k)) out.push(`theme.custom.${mode}.${k} is not a colour setting (${CUSTOM_COLORS.join(", ")})`);
      else if (v !== null && !parseHex(v)) out.push(`theme.custom.${mode}.${k} "${v}" must be a hex colour like #0f766e`);
    }
  }
  for (const [k, allowed] of Object.entries(CUSTOM_OPTIONS)) {
    if (raw[k] !== undefined && raw[k] !== null && !allowed.includes(raw[k])) out.push(`theme.custom.${k} "${raw[k]}" must be one of ${allowed.join(", ")}`);
  }
  for (const k of CUSTOM_BOOLS) if (raw[k] !== undefined && raw[k] !== null && typeof raw[k] !== "boolean") out.push(`theme.custom.${k} must be true or false`);
  for (const [k, range] of Object.entries(CUSTOM_RANGES)) {
    if (raw[k] !== undefined && raw[k] !== null && !onStep(raw[k], range)) out.push(`theme.custom.${k} must be a number from ${range[0]} to ${range[1]} in steps of ${range[2]}`);
  }
  return out;
}

/**
 * The palette with a custom theme's colours on top (they beat the preset's and Match my brand's),
 * or the palette unchanged when the theme sets no colour. Marks it `custom` (AA clamping) and
 * notes per theme whether code colours were set (codeTokens).
 */
export function applyCustomColors(palette, custom) {
  if (!custom?.light && !custom?.dark) return palette;
  const base = palette ?? { accent: MARKDROP_BASE.accent, light: { ...MARKDROP_BASE.light }, dark: { ...MARKDROP_BASE.dark } };
  const out = { ...base, light: { ...base.light }, dark: { ...base.dark }, custom: true };
  for (const mode of ["light", "dark"]) {
    const c = custom[mode] ?? {};
    // A page that changed side (a dark ground in the light theme, say): what the owner didn't set
    // is derived from their ground, not kept from the preset's opposite one.
    const bg = parseHex(c.bg);
    const lightSide = bg && luminance(bg) > 0.18;
    if (bg && lightSide !== luminance(parseHex(base[mode].bg)) > 0.18) {
      const text = parseHex(c.text) ?? (lightSide ? [17, 24, 39] : [243, 244, 246]);
      const card = lightSide ? mix(bg, WHITE, 0.55) : mix(bg, WHITE, 0.05);
      Object.assign(out[mode], {
        card: toHex(card),
        header: toHex(base[mode].header === base[mode].bg ? bg : card),
        text: toHex(text),
        muted: toHex(mix(text, bg, 0.38)),
        line: toHex(mix(bg, text, 0.14)),
        code: toHex(mix(bg, text, lightSide ? 0.05 : 0.04)),
        codeText: toHex(text),
      });
    }
    for (const [k, slot] of Object.entries(COLOR_SLOT)) if (c[k]) out[mode][slot] = c[k];
    if (c.codeBg || c.codeText) out[mode].codeSet = true;
  }
  if (custom.light?.accent) out.accent = custom.light.accent;
  if (custom.dark?.accent) out.accentDark = custom.dark.accent;
  else if (custom.light?.accent && !base.accentDark) out.accentDark = undefined;
  return out;
}

/**
 * The builder's contrast guard: every pair readers read, per theme, with the owner's colours as
 * picked (before the engine clamps them). `fix` is the nearest colour that passes, for "Fix"; the
 * published guide uses a passing shade either way (paletteTokens), so nothing illegible ships.
 *   [{ mode, key, label, fg, bg, ratio, min, ok, fix }]  key: the custom colour "Fix" replaces.
 */
export function contrastGuard(theme, brand) {
  const t = resolveTheme(isObj(theme) ? theme : {}, brand);
  const palette = t?.palette ?? applyCustomColors(null, { light: { bg: MARKDROP_BASE.light.bg }, dark: { bg: MARKDROP_BASE.dark.bg } });
  const out = [];
  const round = (n) => Math.round(n * 100) / 100;
  for (const mode of ["light", "dark"]) {
    const p = palette[mode];
    const bg = parseHex(p.bg);
    const toward = awayFrom(bg);
    const grounds = (keys) => keys.map((k) => p[k]).filter(Boolean).map(parseHex);
    const pair = (key, label, fgHex, onKeys, min, fixFn) => {
      const fg = parseHex(fgHex);
      const gs = grounds(onKeys);
      if (!fg || !gs.length) return;
      const ratio = Math.min(...gs.map((g) => contrast(fg, g)));
      const worst = gs.reduce((a, g) => (contrast(fg, g) < contrast(fg, a) ? g : a));
      const ok = ratio >= min;
      out.push({ mode, key, label, fg: toHex(fg), bg: toHex(worst), ratio: round(ratio), min, ok, fix: ok ? null : toHex(fixFn ? fixFn(fg, gs) : clampAgainst(fg, gs, awayFrom(worst), min)) });
    };
    pair("text", "Body text", p.text, ["bg", "card", "header", "sidebar"], 4.5);
    pair("muted", "Muted text", p.muted, ["bg", "card"], 4.5);
    const accent = mode === "dark" ? palette.accentDark ?? palette.accent : palette.accent;
    pair("accent", "Links", accent, ["bg", "card"], 4.5);
    // The button label: white or ink on the accent fill, whichever reads better.
    const fill = parseHex(accent);
    if (fill) {
      const on = contrast(WHITE, fill) >= contrast(INK, fill) ? WHITE : INK;
      const ratio = contrast(on, fill);
      let fixed = fill;
      for (let i = 1; contrast(on, fixed) < 4.5 && i <= 60; i++) fixed = mix(fill, on === WHITE ? BLACK : WHITE, i / 100);
      out.push({ mode, key: "accent", label: "Button label", fg: toHex(on), bg: toHex(fill), ratio: round(ratio), min: 4.5, ok: ratio >= 4.5, fix: ratio >= 4.5 ? null : toHex(fixed) });
    }
    if (p.codeSet) pair("codeText", "Code", p.codeText, ["code"], 4.5);
    for (const kind of CALLOUT_KINDS) {
      const tone = parseHex(p[kind]);
      if (!tone) continue;
      const strength = toward === BLACK ? 0.12 : 0.2;
      const wash = mix(bg, tone, strength);
      const ratio = Math.min(contrast(tone, wash), contrast(tone, bg));
      // The wash is made from the tone, so the fix is the first shade that passes on its own wash.
      let fix = toward;
      for (let i = 1; i <= 50; i++) {
        const c = mix(tone, toward, i / 50);
        const w = mix(bg, c, strength);
        if (contrast(c, w) >= 4.6 && contrast(c, bg) >= 4.6) {
          fix = c;
          break;
        }
      }
      out.push({ mode, key: kind, label: `${kind[0].toUpperCase()}${kind.slice(1)} callout`, fg: toHex(tone), bg: toHex(wash), ratio: round(ratio), min: 4.5, ok: ratio >= 4.5, fix: ratio >= 4.5 ? null : toHex(fix) });
    }
    const sel = parseHex(p.selection);
    if (sel) {
      const text = parseHex(p.text);
      const ratio = contrast(text, sel);
      out.push({ mode, key: "selection", label: "Selected text", fg: toHex(text), bg: toHex(sel), ratio: round(ratio), min: 4.5, ok: ratio >= 4.5, fix: ratio >= 4.5 ? null : toHex(selectionFor(sel, text, bg)) });
    }
  }
  return out;
}

/**
 * The docs root's attributes for a resolved theme: data-preset and data-layout, then one per
 * custom choice the stylesheet (themes.css) keys on. Only set choices get one, so a preset's root
 * is exactly what it was.
 */
export function themeAttrs(t) {
  if (!t) return {};
  const out = { "data-preset": t.preset, "data-layout": t.layout };
  const c = t.custom;
  if (!c) return out;
  out["data-custom"] = "";
  const attr = { buttons: "data-buttons", cards: "data-cards", headerAlign: "data-header-align", headerStyle: "data-header-style", tabStyle: "data-tab-style", sidebarStyle: "data-sidebar", callouts: "data-callouts", codeTheme: "data-code", links: "data-links", icons: "data-icons" };
  for (const [k, name] of Object.entries(attr)) if (c[k]) out[name] = c[k];
  if (c.sidebarIcons === false) out["data-sidebar-icons"] = "off";
  if (t.palette?.light.sidebar || t.palette?.dark.sidebar) out["data-sidebar-bg"] = "";
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
/**
 * A browser ends a string at a line break, so a string that runs across lines would be read
 * differently here and there (what looks like one rule to us could be several to the browser).
 */
const STRING_BREAK = "a string has a line break in it (close the quote on the same line)";
const isBreak = (c) => c === "\n" || c === "\r" || c === "\f";

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
      else if (isBreak(c)) throw new Error(STRING_BREAK);
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
 * What follows the scope in a scoped selector stays inside it: the rest of the scope's own compound
 * (`:hover`, `.x`, `[a]`), then a descendant or child combinator. `~` and `+` would reach the
 * scope's siblings, outside the docs root, so they are refused there.
 */
function checkAfterScope(rest, sel) {
  let i = 0;
  let depth = 0;
  let quote = null;
  for (; i < rest.length; i++) {
    const c = rest[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth <= 0 && (/\s/.test(c) || c === ">" || c === "+" || c === "~")) break;
  }
  while (i < rest.length && /\s/.test(rest[i])) i++;
  if (rest[i] === "~" || rest[i] === "+") throw new Error(`"${sel.slice(0, 40)}" reaches outside the docs root (~ or + can't follow the root itself)`);
}

/**
 * One selector under the scope: `.x` → `.dx-root .x`; `:root`, `html` and `body` are the scope
 * itself (`html[data-theme="dark"] .x` keeps the theme switch in front: `html[data-theme="dark"]
 * .dx-root .x`); a selector already starting with the scope is left alone. Throws when the
 * selector would reach the scope's siblings or has a [ without a ].
 */
function scopeSelector(sel, scope) {
  const s = sel.trim().replace(/\s+/g, " ");
  if (!s) return null;
  if (s === scope || s.startsWith(scope + " ") || s.startsWith(scope + ".") || s.startsWith(scope + "[") || s.startsWith(scope + ":") || s.startsWith(scope + ">") || s.startsWith(scope + "+") || s.startsWith(scope + "~")) {
    checkAfterScope(s.slice(scope.length), s);
    return s;
  }
  const m = /^(html|:root|body)((?:\[[^\]]*\])*)(?=$|[\s>+~:.#[])(.*)$/i.exec(s);
  if (m) {
    const [, el, attrs, rest] = m;
    if (el.toLowerCase() === "body" || !attrs) {
      checkAfterScope(rest, s);
      return `${scope}${rest}`;
    }
    const after = rest.startsWith(" ") || !rest ? rest : " " + rest;
    checkAfterScope(after, s);
    return `${el}${attrs} ${scope}${after}`.trim();
  }
  if (/^\[data-theme/i.test(s)) {
    const t = /^((?:\[[^\]]*\])+)(.*)$/.exec(s);
    if (!t) throw new Error(`"${s.slice(0, 40)}" has a [ without a matching ]`);
    checkAfterScope(t[2], s);
    return `${t[1]} ${scope}${t[2]}`;
  }
  return `${scope} ${s}`;
}

/** A site file's path stays in /docs-assets/: no `..` segment (also spelled %2e), `//` or backslash. */
function assetPathOk(u) {
  const path = u.split(/[?#]/)[0];
  return !path.includes("//") && !path.includes("\\") && !path.split("/").some((seg) => /^(?:\.|%2e){2}$/i.test(seg));
}

/** Every url() is https or a site file (/docs-assets/…). */
function checkUrls(text, errors) {
  const re = /url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
  let m;
  while ((m = re.exec(text))) {
    const u = m[2].trim();
    if (/^https:\/\/[^\s]+$/i.test(u)) continue;
    if (!/^\/docs-assets\/[^\s]*$/.test(u)) errors.push(`url(${u}) must be an https URL or a /docs-assets/ file`);
    else if (!assetPathOk(u)) errors.push(`url(${u}): a /docs-assets/ path can't have "..", "//" or a backslash in it`);
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
        else if (isBreak(c)) throw new Error(STRING_BREAK);
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
        else if (isBreak(c)) throw new Error(STRING_BREAK);
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
      // Strings never span a line break (readBlock refused those already).
      if (body.replace(/"[^"\n\r\f]*"|'[^'\n\r\f]*'/g, "").includes("{")) throw new Error(`"${prelude.slice(0, 40)}" has a nested block (CSS nesting isn't supported here)`);
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
 * @import, expression(), javascript:, bindings, or url() other than https and /docs-assets/ (with
 * no `..` or `//`); no string across a line break; every selector scoped under `scope` (default the
 * docs root) and none reaching its siblings with ~ or +. Returns the CSS, or errors and no CSS.
 * The API ports the accept/reject half (backend/app/services/docs_site_settings.py css_problem);
 * change both together and regenerate customCss.corpus.json, which both test suites run.
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
 * site.json `theme` (+ `brand`: colours and accent) → what the engine renders, or null when the
 * site has neither a theme nor brand colours (today's look, nothing added). Bad values fall back
 * to the preset's (docs:check reports them).
 */
export function resolveTheme(theme, brand) {
  const colors = Array.isArray(brand?.colors) && brand.colors.length ? brand.colors : undefined;
  if (!isObj(theme)) {
    if (!colors) return null;
    theme = {};
  }
  const presetId = Object.hasOwn(PRESETS, theme.preset) ? theme.preset : "clean";
  const preset = PRESETS[presetId];
  const font = (key, kinds) => {
    const id = theme.fonts?.[key];
    return Object.hasOwn(FONTS, id) && kinds.includes(FONTS[id].kind) ? id : preset.fonts[key];
  };
  const custom = normalizeCustom(theme.custom);
  const corners = custom?.radius
    ? CUSTOM_RADIUS[custom.radius]
    : Object.hasOwn(CORNERS, theme.corners)
      ? CORNERS[theme.corners]
      : typeof preset.corners === "string"
        ? CORNERS[preset.corners]
        : preset.corners;
  const mode = MODES.includes(theme.mode) ? theme.mode : "both";
  const css = typeof theme.customCss === "string" && theme.customCss.trim() ? sanitizeCss(theme.customCss) : { css: "", errors: [] };
  const palette = applyCustomColors(buildPalette(presetId, { colors, accent: brand?.accent, accentDark: brand?.accentDark }), custom);
  return {
    preset: presetId,
    layout: preset.layout,
    home: preset.home ?? (preset.layout === "helpcenter" ? "categories" : "hero"),
    sectionTabs: typeof custom?.sectionTabs === "boolean" ? custom.sectionTabs : !!preset.sectionTabs,
    // A code face can head a page (Terminal does), never be its body.
    fonts: { heading: font("heading", ["sans", "serif", "mono"]), body: font("body", ["sans", "serif"]), mono: font("mono", ["mono"]) },
    headingWeight: custom?.headingWeight ?? preset.headingWeight,
    radius: corners,
    mode,
    palette,
    custom,
    customCss: css.css,
    customCssErrors: css.errors,
  };
}

/**
 * The header's tabs: the site's own tabs; or, for a theme with section tabs (Atlas) and a site with
 * at most one tab, that tab's nav groups (two or more), each opening its first page, current when it
 * holds the page being read.
 * @param {Array<{id: string, label: string, href: string}>} tabs
 * @param {Array<{group: string, tab?: string, items: Array<{path: string, available?: boolean}>}>} groups
 * @param {{sections: boolean, activeTab?: string, current?: string}} opts
 */
export function headerTabs(tabs, groups, { sections, activeTab, current }) {
  const own = () => tabs.map((t) => ({ key: t.id, label: t.label, href: t.href, current: t.id === activeTab }));
  if (!sections || tabs.length > 1) return own();
  const out = [];
  for (const g of groups) {
    if (tabs.length && g.tab && g.tab !== tabs[0].id) continue;
    const first = g.items.find((it) => it.available);
    if (first) out.push({ key: `g-${g.group}`, label: g.group, href: first.path, current: !!current && g.items.some((it) => it.path === current) });
  }
  return out.length > 1 ? out : own();
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
  const c = t.custom;
  if (c?.contentWidth) rootVars["--dx-measure"] = `${c.contentWidth}px`;
  const out = [`html:root{${decls(rootVars)}}`];
  if (t.palette) {
    const themes = t.mode === "light" ? ["light"] : t.mode === "dark" ? ["dark"] : ["dark", "light"];
    for (const theme of themes) {
      const sel = theme === "dark" ? `:root,[data-theme="dark"][data-theme]` : `[data-theme="light"][data-theme]`;
      // A forced mode paints its palette whatever the attribute says (before the script runs, too).
      const at = t.mode === "both" ? sel : `:root,[data-theme][data-theme]`;
      out.push(`${at}{${decls(paletteTokens(t.palette, theme))}}`);
      const code = codeTokens(t.palette, theme, c?.codeTheme);
      if (code) out.push(`${at.split(",").map((s) => `${s} .dx-root.dx-root .md-codeblock`).join(",")}{${decls(code)}}`);
    }
  }
  if (c) out.push(...customRules(c));
  if (t.customCss) out.push(t.customCss);
  return out.join("\n");
}

/**
 * A custom theme's type and width as rules (doubled root specificity, like the palette, so they
 * beat every preset's own sizes in themes.css). Choices that are attributes (buttons, sidebar…)
 * are styled by themes.css itself.
 */
function customRules(c) {
  const R = ".dx-root.dx-root[data-custom]";
  const out = [];
  const prose = {};
  if (c.baseSize) prose["font-size"] = `${c.baseSize}px`;
  if (c.lineHeight) prose["line-height"] = String(c.lineHeight);
  if (Object.keys(prose).length) out.push(`${R} .dx-prose.md-prose--reading{${decls(prose)}}`);
  if (c.headingWeight) out.push(`${R} :is(.dx-title,.dx-hero__title,.dx-home__h),${R} .dx-prose :is(h1,h2,h3){font-weight:${c.headingWeight}}`);
  if (c.contentWidth) {
    const w = `${c.contentWidth}px`;
    out.push(
      `@media (min-width:1200px){${R} .dx-layout:not(.dx-layout--top,.dx-layout--hc,.dx-layout--api){grid-template-columns:236px minmax(0,${w}) 232px}${R} .dx-layout--hc{grid-template-columns:minmax(0,${w}) 248px}}`,
    );
  }
  return out;
}

/* ── validation (docs:check) ─────────────────────────────────────────────── */

/** Problems with site.json `theme`: [{ level: "error" | "warn", msg }]. */
export function validateTheme(theme) {
  const out = [];
  const err = (msg) => out.push({ level: "error", msg });
  const warn = (msg) => out.push({ level: "warn", msg });
  if (theme === undefined) return out;
  if (!isObj(theme)) return [{ level: "error", msg: "theme must be an object" }];
  for (const k of Object.keys(theme)) if (!["preset", "fonts", "corners", "mode", "customCss", "custom"].includes(k)) warn(`theme.${k} is not a setting (ignored)`);
  // null is "the preset's default" (the API's "Theme default").
  const set = (v) => v !== undefined && v !== null;
  if (set(theme.preset) && !Object.hasOwn(PRESETS, theme.preset)) err(`theme.preset "${theme.preset}" must be one of ${Object.keys(PRESETS).join(", ")}`);
  if (set(theme.fonts)) {
    if (!isObj(theme.fonts)) err("theme.fonts must be an object like { \"heading\": \"newsreader\", \"body\": \"inter\" }");
    else {
      for (const k of Object.keys(theme.fonts)) if (!["heading", "body", "mono"].includes(k)) warn(`theme.fonts.${k} is not a setting (ignored)`);
      for (const k of ["heading", "body", "mono"]) {
        const id = theme.fonts[k];
        if (!set(id)) continue;
        if (!Object.hasOwn(FONTS, id)) err(`theme.fonts.${k} "${id}" isn't an available font (${Object.keys(FONTS).join(", ")})`);
        else if (k === "mono" && FONTS[id].kind !== "mono") err(`theme.fonts.mono "${id}" isn't a monospaced font`);
        else if (k === "body" && FONTS[id].kind === "mono") err(`theme.fonts.body "${id}" is a code font; pick a sans or serif`);
      }
    }
  }
  if (set(theme.corners) && !Object.hasOwn(CORNERS, theme.corners)) err(`theme.corners "${theme.corners}" must be sharp, soft or round`);
  if (set(theme.mode) && !MODES.includes(theme.mode)) err(`theme.mode "${theme.mode}" must be both, light or dark`);
  if (set(theme.customCss)) {
    if (typeof theme.customCss !== "string") err("theme.customCss must be a string");
    else for (const e of sanitizeCss(theme.customCss).errors) err(`theme.customCss: ${e}`);
  }
  for (const e of validateCustom(theme.custom)) (/is not a( colour)? setting/.test(e) ? warn : err)(e);
  return out;
}

/** Problems with site.json `brand.colors` (Match my brand): error messages. */
export function validateBrandColors(colors) {
  if (colors === undefined || colors === null) return [];
  if (!Array.isArray(colors) || colors.length > 8) return ["brand.colors must be a list of up to 8 hex colours"];
  const out = colors.flatMap((c, i) => (parseHex(c) ? [] : [`brand.colors[${i}] "${c}" must be a hex colour like #0f766e`]));
  if (!out.length && colors.length && !brandRoles(colors)) out.push("brand.colors has no usable colour");
  return out;
}
