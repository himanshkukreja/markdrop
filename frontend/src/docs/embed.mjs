/**
 * `::markdrop{src=… title=… height=… aspect=… mode=… version=…}`: a Markdrop file as a live block
 * on a docs page (docs.markdrop.in and every Markdrop Guides site). The pure half, shared by the
 * renderer (render/plugins.ts, client/MarkdropEmbed.tsx), the studio editor and preview, and
 * `docs:check`, so the rules are written once and tested with node directly (embed.test.mjs).
 *
 *   ::markdrop{src="https://markdrop.in/acme-pricing" title="Pricing calculator" height=560}
 *   ::markdrop[Onboarding walkthrough]{src="https://markdrop.in/acme-tour" version=3}
 *   ::markdrop{src="https://markdrop.in/acme-handbook" mode=card}
 *   ::markdrop{src="https://markdrop.in/acme-pricing" summary="Pick a plan and seats; the total updates."}
 *
 * What renders live: interactive HTML (a page, or a zipped static site), PDFs and videos. Anything
 * else (a spreadsheet, a Word document, an image, a Markdrop document…) is a card that opens it on
 * Markdrop.
 *
 * src       a Markdrop link (https://markdrop.in/<slug>). The page keeps only the link: what the
 *           file is, its current bytes and whether readers may see it are asked of the API when a
 *           reader scrolls to it, so "Replace file" on Markdrop updates every guide at once, and a
 *           file made private stops showing everywhere at once.
 * title     the block's title (else the file's own title). `[label]` works too.
 * summary   the block's text version, written by the author: shown under the block (and to
 *           readers without JavaScript), and what search, Ask AI, llms.txt and the page's Markdown
 *           twin read instead of the file. A PDF's text and a video's captions are added to it.
 * height    the frame's height in px (160–2000) for pages, sites and PDFs.
 * aspect    W:H instead of a height ("16:9", "9:16" for a phone prototype).
 * mode      live (default): the file itself · preview: a cover until the reader asks for it ·
 *           card: a link card (title, type, size, Open on Markdrop).
 * version   pin a version of the file (its studio registers the pin; anywhere else the current
 *           version shows).
 * captions  a WebVTT file of the site (/docs-assets/…) for a video; chapters likewise.
 *
 * Security model (see the API's services/docs_embeds.py): the API answers only for files anyone
 * with the link may open (link access, no password, no sign-in-only workspace, not expired, not
 * end-to-end encrypted); everything else is a state with no title, no bytes and no address. Files
 * render on Markdrop's isolated artifact origin (workers.dev, a separate registrable site), never
 * the docs origin. Author HTML runs in a sandbox WITHOUT allow-same-origin (an opaque origin: no
 * storage, no cookies, no access to any other file on the artifact origin or to the page around
 * it, no top navigation), and the Worker repeats that sandbox as a CSP header (`?sb=1`), so one
 * customer's page can never reach another's. Markdrop's own PDF viewer runs in an opaque origin
 * too (scripts and downloads only): it parses a hostile file with PDF.js on that shared origin, so
 * a parser bug must never hand it the origin. It reads the file cross-origin (embedded files are
 * public: the Worker answers CORS `*`).
 */

/** Hosts a `src` may name. A guide's own site config may add its app host (local stacks). */
export const MARKDROP_HOSTS = ["markdrop.in", "www.markdrop.in"];
export const EMBED_MODES = ["live", "preview", "card"];
export const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * Author HTML (a page or a zipped site): scripts, forms, dialogs, popups (themselves sandboxed) and
 * downloads, in an OPAQUE origin: never allow-same-origin, allow-top-navigation or
 * allow-popups-to-escape-sandbox.
 */
export const SANDBOX = "allow-scripts allow-forms allow-popups allow-modals allow-downloads";
/**
 * Markdrop's own PDF viewer: trusted code, but it parses an untrusted file on the artifact origin
 * every customer shares, so it gets an opaque origin too (no allow-same-origin). Its bridge
 * messages then say origin "null" (client/embedTrack.ts accepts that from our own frame).
 */
export const SANDBOX_VIEWER = "allow-scripts allow-downloads";
/** Permissions no embedded file gets (most are off for cross-origin frames already; said anyway). */
export const FRAME_ALLOW = "camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'; serial 'none'; hid 'none'; bluetooth 'none'; display-capture 'none'; clipboard-read 'none'";
/** What renders live; every other renderer is a card. */
export const LIVE_RENDERERS = ["html", "bundle", "pdf", "video"];
/** The longest `summary` docs:check accepts without a warning. */
export const SUMMARY_MAX = 2000;
export const MIN_HEIGHT = 160;
export const MAX_HEIGHT = 2000;
/** A frame's height when the page names none, per renderer. */
export const DEFAULT_HEIGHT = { html: 560, bundle: 560, pdf: 720, sheet: 520, docx: 720, text: 480, image: 0, video: 0, audio: 0, doc: 0 };
/** The attributes the renderer carries over; anything else is dropped (and `docs:check` warns). */
export const EMBED_ATTRS = ["src", "title", "summary", "height", "aspect", "mode", "version", "captions", "chapters"];

const RENDERERS = new Set(["html", "bundle", "pdf", "sheet", "docx", "text", "image", "video", "audio", "doc"]);

/** What a reader sees for each renderer, for labels and the cover's icon. */
export const KIND = {
  html: { label: "Interactive page", icon: "code" },
  bundle: { label: "Website", icon: "globe" },
  pdf: { label: "PDF", icon: "doc" },
  sheet: { label: "Spreadsheet", icon: "table" },
  docx: { label: "Word document", icon: "doc" },
  text: { label: "Text file", icon: "lines" },
  image: { label: "Image", icon: "image" },
  video: { label: "Video", icon: "film" },
  audio: { label: "Audio", icon: "music" },
  doc: { label: "Markdrop document", icon: "doc" },
  file: { label: "Markdrop file", icon: "layers" },
};

/** The slug a Markdrop link names, or null (not a Markdrop link, a deeper path, a bad slug). */
export function parseMarkdropSrc(src, extraHosts = []) {
  if (typeof src !== "string") return null;
  const s = src.trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const host = u.host.toLowerCase();
  const known = MARKDROP_HOSTS.includes(host) && u.protocol === "https:";
  const extra = extraHosts.some((h) => typeof h === "string" && h.toLowerCase() === host) && (u.protocol === "https:" || u.protocol === "http:");
  if (!known && !extra) return null;
  if (u.username || u.password) return null;
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length !== 1) return null;
  let slug;
  try {
    slug = decodeURIComponent(segs[0]);
  } catch {
    return null;
  }
  return SLUG_RE.test(slug) ? slug : null;
}

/** The canonical link for a slug. */
export function markdropLink(slug, app = "https://markdrop.in") {
  return `${String(app).replace(/\/+$/, "")}/${encodeURIComponent(slug)}`;
}

/** "16:9" → 1.777…; anything outside 1:4 … 4:1, or not W:H, → null. */
export function parseAspect(v) {
  if (typeof v !== "string") return null;
  const m = /^\s*(\d{1,4}(?:\.\d{1,3})?)\s*[:/x]\s*(\d{1,4}(?:\.\d{1,3})?)\s*$/.exec(v);
  if (!m) return null;
  const w = Number(m[1]), h = Number(m[2]);
  if (!(w > 0 && h > 0)) return null;
  const r = w / h;
  return r >= 0.25 && r <= 4 ? r : null;
}

function intIn(v, lo, hi) {
  if (typeof v === "number" && Number.isInteger(v)) return v >= lo && v <= hi ? v : null;
  if (typeof v !== "string" || !/^\s*\d{1,6}\s*(?:px)?\s*$/.test(v)) return null;
  const n = Number(v.replace(/px/, "").trim());
  return n >= lo && n <= hi ? n : null;
}

/** A /docs-assets/ WebVTT path, or null. */
export function vttPath(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return /^\/docs-assets\/[^?#\s]+\.vtt$/i.test(s) && !s.includes("..") ? s : null;
}

/**
 * The directive's attributes, normalised: `{src, slug, title, height, aspect, mode, version,
 * captions, chapters}` with every invalid value dropped (null), and `problems`, what `docs:check`
 * reports (`errors` break the block, `warnings` are ignored values).
 */
export function embedAttrs(raw = {}, { label, extraHosts } = {}) {
  const a = raw && typeof raw === "object" ? raw : {};
  const errors = [];
  const warnings = [];
  const src = typeof a.src === "string" ? a.src.trim() : "";
  const slug = parseMarkdropSrc(src, extraHosts);
  if (!src) errors.push('::markdrop needs src="https://markdrop.in/<link>", the address of a Markdrop file');
  else if (!slug) errors.push(`::markdrop src "${src}" isn't a Markdrop link (https://markdrop.in/<link>)`);
  const title = (typeof a.title === "string" && a.title.trim()) || (typeof label === "string" && label.trim()) || null;
  const summary = typeof a.summary === "string" && a.summary.trim() ? a.summary.trim() : null;
  if (summary && summary.length > SUMMARY_MAX) warnings.push(`::markdrop summary is ${summary.length} characters; keep it under ${SUMMARY_MAX} (a few sentences)`);
  let height = null;
  if (a.height !== undefined && a.height !== null && a.height !== "") {
    height = intIn(a.height, MIN_HEIGHT, MAX_HEIGHT);
    if (height === null) warnings.push(`::markdrop height="${a.height}" must be a number of pixels from ${MIN_HEIGHT} to ${MAX_HEIGHT}; it's ignored`);
  }
  let aspect = null;
  if (a.aspect !== undefined && a.aspect !== null && a.aspect !== "") {
    aspect = parseAspect(String(a.aspect)) ? String(a.aspect).trim() : null;
    if (aspect === null) warnings.push(`::markdrop aspect="${a.aspect}" must be W:H between 1:4 and 4:1 (like 16:9); it's ignored`);
  }
  if (height !== null && aspect !== null) warnings.push("::markdrop has both height and aspect; aspect wins");
  let mode = "live";
  if (a.mode !== undefined && a.mode !== null && a.mode !== "") {
    if (EMBED_MODES.includes(String(a.mode).trim())) mode = String(a.mode).trim();
    else warnings.push(`::markdrop mode="${a.mode}" must be ${EMBED_MODES.join(", ")}; it shows live`);
  }
  let version = null;
  if (a.version !== undefined && a.version !== null && a.version !== "") {
    version = intIn(a.version, 1, 100000);
    if (version === null) warnings.push(`::markdrop version="${a.version}" must be a version number (1, 2, 3…); the current version shows`);
  }
  const media = {};
  for (const k of ["captions", "chapters"]) {
    if (a[k] === undefined || a[k] === null || a[k] === "") continue;
    media[k] = vttPath(a[k]);
    if (!media[k]) warnings.push(`::markdrop ${k}="${a[k]}" must be a .vtt file of this site (/docs-assets/…); it's ignored`);
  }
  for (const k of Object.keys(a)) if (!EMBED_ATTRS.includes(k)) warnings.push(`::markdrop doesn't know "${k}" (known: ${EMBED_ATTRS.join(", ")})`);
  return {
    src: slug ? src : null,
    slug,
    title,
    summary,
    height,
    aspect,
    mode,
    version,
    captions: media.captions ?? null,
    chapters: media.chapters ?? null,
    errors,
    warnings,
  };
}

/** The renderer an API answer names, or "file". */
export function rendererOf(res) {
  const r = res && typeof res.renderer === "string" ? res.renderer : "";
  return RENDERERS.has(r) ? r : "file";
}

/** The label and icon for a renderer. */
export function kindOf(renderer) {
  return KIND[renderer] ?? KIND.file;
}

/**
 * The viewer page's address with the reader's theme: Markdrop's PDF, sheet, Word and text viewers
 * (`/v/…` on the artifact origin) take `?theme=dark|light`; a raw page (`/r/…`) is left as it is.
 * Built with the URL API, so a signed `?t=` (a pinned version) survives.
 */
export function themedFrameSrc(url, theme) {
  try {
    const u = new URL(url);
    if (!u.pathname.startsWith("/v/")) return u.toString();
    if (theme === "dark" || theme === "light") u.searchParams.set("theme", theme);
    return u.toString();
  } catch {
    return null;
  }
}

/** Only https (or http on a loopback/dev stack) addresses on the artifact origin may be framed. */
export function safeFrameUrl(url, allowedOrigin) {
  if (typeof url !== "string") return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname))) return null;
  if (allowedOrigin) {
    try {
      if (new URL(allowedOrigin).origin !== u.origin) return null;
    } catch {
      return null;
    }
  }
  return u.toString();
}

/** 1536 → "1.5 KB". */
export function formatBytes(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/** Seconds → "2:05" / "1:02:05". */
export function clock(sec) {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec < 0) return "";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/**
 * Why a file can't be shown, as the reader reads it. Nothing in these names the file: a private
 * file's title is never sent, so the page can't leak it.
 */
export const STATES = {
  private: { title: "This file is private", body: "Its owner hasn't shared it with readers of these docs.", open: true },
  password: { title: "This file is password-protected", body: "Open it on Markdrop to enter the password.", open: true },
  signin: { title: "Only its workspace can open this file", body: "Members can sign in on Markdrop to see it.", open: true },
  encrypted: { title: "This document is end-to-end encrypted", body: "Its key is only in the link its author shares, so it can't be shown here.", open: false },
  unavailable: { title: "This file isn't available", body: "It may have been deleted, or its link may have expired.", open: false },
  unsupported: { title: "This file can't be shown here", body: "Open it on Markdrop to see or download it.", open: true },
  error: { title: "Couldn't load this file", body: "Check your connection and try again.", open: true, retry: true },
  invalid: { title: "This isn't a Markdrop file link", body: "Use the address of a file on markdrop.in.", open: false },
};

/** Frame height in px for a renderer, from the page's height/aspect, the file's media size or the default. */
export function frameHeight(attrs, renderer, width) {
  const r = attrs?.aspect ? parseAspect(attrs.aspect) : null;
  if (r && width > 0) return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(width / r)));
  if (attrs?.height) return attrs.height;
  return DEFAULT_HEIGHT[renderer] || 560;
}

/**
 * What to draw for an API answer (`res`, null while loading) and the page's attributes: one of
 *
 *   {type: "frame", src, sandbox, renderer, paper}   a page / zipped site (raw) or the PDF viewer
 *   {type: "video", src, poster, w, h, duration}     the docs' own player
 *   {type: "card", renderer}                         mode=card, or anything that doesn't render live
 *                                                    (a sheet, a Word file, an image, a document…)
 *   {type: "state", state}                           why it can't be shown (STATES)
 *
 * plus the chrome's `title`, `typeLabel`, `meta` (size, length, version) and `open` (the link on
 * Markdrop, or null when there's nothing a reader could do there). `theme` is the page's.
 */
export function embedView(res, attrs, { theme, artifactOrigin } = {}) {
  const slug = attrs?.slug ?? null;
  const app = (res && typeof res.app === "string" && res.app) || "https://markdrop.in";
  const openUrl = slug ? markdropLink(slug, app) : null;
  const base = { slug, title: attrs?.title || null, typeLabel: null, meta: [], open: null };
  if (!slug) return { ...base, type: "state", state: "invalid" };
  if (!res) return { ...base, type: "loading", open: openUrl };
  if (res.state !== "ok") {
    const state = STATES[res.state] ? res.state : "unavailable";
    return { ...base, type: "state", state, open: STATES[state].open ? openUrl : null };
  }
  const renderer = rendererOf(res);
  const k = kindOf(renderer);
  const title = attrs.title || res.title || res.filename || "Untitled";
  const meta = [];
  if (renderer === "video" || renderer === "audio") {
    const d = clock(res.media?.duration);
    if (d) meta.push(d);
  } else if (typeof res.size_bytes === "number" && renderer !== "doc") meta.push(formatBytes(res.size_bytes));
  if (res.pinned && res.version) meta.push(`Version ${res.version}`);
  const out = { ...base, title, typeLabel: res.type_label || k.label, icon: k.icon, renderer, meta, open: openUrl, updatedAt: res.updated_at ?? null };
  if (attrs.mode === "card" || !LIVE_RENDERERS.includes(renderer)) return { ...out, type: "card", excerpt: typeof res.excerpt === "string" ? res.excerpt : null };
  if (renderer === "video") {
    const src = safeFrameUrl(res.raw_url, artifactOrigin);
    if (!src) return { ...out, type: "state", state: "unsupported" };
    const poster = res.poster_url ? safeFrameUrl(res.poster_url, artifactOrigin) : null;
    return { ...out, type: "video", src, poster, w: res.media?.width ?? null, h: res.media?.height ?? null, duration: clock(res.media?.duration) || null };
  }
  const framed = safeFrameUrl(res.frame_url, artifactOrigin);
  const author = renderer === "html" || renderer === "bundle";
  const src = framed ? (author ? sandboxedUrl(framed) : themedFrameSrc(framed, theme)) : null;
  if (!src) return { ...out, type: "state", state: "unsupported" };
  // Author HTML is written for white paper; Markdrop's PDF viewer follows the page's theme.
  return { ...out, type: "frame", src, sandbox: author ? SANDBOX : SANDBOX_VIEWER, paper: author };
}

/** An author page's address with `sb=1`: the artifact Worker then sends the sandbox as a CSP header too. */
export function sandboxedUrl(url) {
  try {
    const u = new URL(url);
    u.searchParams.set("sb", "1");
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Stable ids for the blocks of one page, in order: the slug, and `<slug>~2`, `<slug>~3`… for the
 * same file again. What a guide's Insights (and its Fix list) key a block by, with the page path.
 */
export function embedIds(slugs) {
  const seen = new Map();
  return slugs.map((s) => {
    const n = (seen.get(s) ?? 0) + 1;
    seen.set(s, n);
    return n === 1 ? s : `${s}~${n}`;
  });
}

/** One line of text without Markdown syntax that would change its meaning in a quote. */
function oneLine(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

/**
 * The plain-Markdown twin (agents, llms-full.txt, search): `[Markdrop file: Acme price list](…)`.
 */
export function embedPlainLine(attrs) {
  const slug = parseMarkdropSrc(attrs?.src ?? "");
  if (!slug) return null;
  const title = String(attrs.title || attrs.label || slug).replace(/[[\]]/g, "");
  return `[Markdrop file: ${title}](${markdropLink(slug)})`;
}

/** How much of a file's own text (a PDF's, a video's transcript) the text version carries. */
export const TEXT_MAX = 6000;

/**
 * The block's text version, as Markdown lines: the link (with the kind, when known), the author's
 * summary, then what the build knows of the file (`info`, from the content's embeds.json: a PDF's
 * outline and text, a video's length), chapters and a transcript from the captions. What agents,
 * search, Ask AI and readers without JavaScript get instead of the file.
 *   info: { title?, type?, duration?, pages?, outline?: string[], text?: string }
 *   media: { chapters?: [{start, text}], transcript?: string }
 */
export function embedTextLines(attrs, info = null, media = null) {
  const slug = parseMarkdropSrc(attrs?.src ?? "");
  if (!slug) return [];
  const title = String(attrs.title || attrs.label || info?.title || slug).replace(/[[\]]/g, "");
  const kind = info?.type ? `${info.type}: ` : "Markdrop file: ";
  const facts = [];
  if (info?.duration) facts.push(clock(info.duration));
  if (info?.pages) facts.push(`${info.pages} ${info.pages === 1 ? "page" : "pages"}`);
  const out = [`[${kind}${title}](${markdropLink(slug)})${facts.length ? ` (${facts.join(", ")})` : ""}`];
  const summary = attrs.summary ? oneLine(attrs.summary) : "";
  if (summary) out.push("", summary);
  const chapters = Array.isArray(media?.chapters) ? media.chapters.filter((c) => c && typeof c.text === "string") : [];
  if (chapters.length) {
    out.push("", "Chapters:");
    for (const c of chapters.slice(0, 50)) out.push(`- ${clock(c.start)} ${oneLine(c.text)}`);
  }
  const outline = Array.isArray(info?.outline) ? info.outline.filter((x) => typeof x === "string" && x.trim()) : [];
  if (outline.length) {
    out.push("", "Contents:");
    for (const h of outline.slice(0, 40)) out.push(`- ${oneLine(h)}`);
  }
  let budget = TEXT_MAX;
  for (const [label, body] of [["Transcript", media?.transcript], ["Text", info?.text]]) {
    if (typeof body !== "string" || !body.trim() || budget <= 0) continue;
    const t = oneLine(body);
    const cut = t.length > budget ? `${t.slice(0, budget).replace(/\s+\S*$/, "")}…` : t;
    budget -= cut.length;
    out.push("", `${label}: ${cut}`);
  }
  return out;
}
