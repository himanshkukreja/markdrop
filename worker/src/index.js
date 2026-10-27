/**
 * Markdrop artifact origin — serves user-authored files from a domain that is
 * deliberately separate from markdrop.in.
 *
 * Why this Worker exists at all: the app stores its session token in
 * localStorage and edit secrets in sessionStorage on the markdrop.in origin.
 * HTML served from that origin could read both. Serving it from here puts it in
 * a different origin, so the browser's same-origin policy does the enforcing —
 * and if someone hosts phishing, the blocklist lands on this throwaway domain
 * instead of the product.
 *
 * Routes
 *   GET /r/<key>              raw bytes (an HTML artifact IS the page)
 *   GET /v/<renderer>/<key>   viewer page that fetches /r/<key> and renders it
 *
 * Private (password-protected) artifacts carry ?t=<HS256 JWT> minted by the API;
 * public ones are unguessable capability URLs and cache immutably at the edge.
 *
 * Theme: viewer pages (and the "file isn't available" page) accept
 * ?theme=dark|light. The iframe cannot read the app's theme, so the app passes
 * it. Anything else (absent, misspelt, hostile) is ignored and the page follows
 * prefers-color-scheme instead. Only the token `t` is ever forwarded to /r/.
 */

const VIEWERS = new Set(["pdf", "sheet", "text", "docx", "video", "audio"]);

// A video's poster frame, as the API stores it: art/<owner>/<random>.poster.jpg.
// Anything else in ?poster= is ignored, so the parameter can only ever point
// the player at a poster image on this origin.
const POSTER_KEY = /^art\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.poster\.jpg$/;

// The only two strings that can ever reach the data-theme attribute.
const THEMES = new Set(["dark", "light"]);

/** "dark" | "light" | null. null means "follow the OS". */
function readTheme(url) {
  const t = url.searchParams.get("theme");
  return THEMES.has(t) ? t : null;
}

// Types we are willing to hand to the browser to *render*. Anything else is
// forced to download, so an unexpected upload can never execute as a page.
const INLINE_TYPES = new Set([
  "text/html",
  "application/pdf",
  "text/csv",
  "text/plain",
  "application/json",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/ogg",
]);

/**
 * Parse a Range header into an R2 range, or null.
 *
 * Video is unplayable without this. A browser asks for a few hundred kilobytes
 * at a time and expects 206 with Content-Range; handed the whole file with 200
 * it cannot seek at all, and on a large file some browsers refuse to start.
 *
 * Only the single-range form is handled. Multipart ranges exist, are vanishingly
 * rare from media elements, and answering them wrongly is worse than answering
 * the whole object — so anything else falls back to a normal 200.
 */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;

  let start, end;
  if (rawStart === "") {
    // "bytes=-500" means the final 500 bytes, not the first 500.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    end = Math.min(end, size - 1);
  }
  if (start > end || start >= size || start < 0) return { unsatisfiable: true };
  return { offset: start, length: end - start + 1, start, end };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(request),
          "access-control-allow-methods": "GET, HEAD, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "3600",
        },
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "r") return serveRaw(parts.slice(1).join("/"), url, env, request);
    if (parts[0] === "v") {
      const renderer = parts[1];
      // A viewer URL is always a page, so it always gets the page.
      if (!VIEWERS.has(renderer)) return unavailablePage(readTheme(url), 404);
      return serveViewer(renderer, parts.slice(2).join("/"), url, env);
    }
    if (parts[0] === "b") return serveBranding(parts.slice(1).join("/"), env, request);
    if (url.pathname === "/" || url.pathname === "/robots.txt") {
      // Nothing here should ever be indexed — it's all user content.
      return new Response("User-Agent: *\nDisallow: /\n", {
        headers: { "content-type": "text/plain", "x-robots-tag": "noindex, nofollow" },
      });
    }
    return notFound(request, url);
  },
};

/**
 * 404. A frame or a document navigation gets the themed "This file isn't
 * available" page; everything else (fetch() from a viewer or the app's blob
 * download, a <video> range request, an image loader) keeps the plain body, so
 * callers that check res.ok / res.status see exactly what they saw before.
 */
function notFound(request, url) {
  if (request && url && wantsPage(request)) return unavailablePage(readTheme(url), 404);
  return new Response("Not found", { status: 404, headers: baseHeaders() });
}

function wantsPage(request) {
  const dest = request.headers.get("sec-fetch-dest");
  if (dest) return dest === "document" || dest === "iframe" || dest === "frame";
  return (request.headers.get("accept") || "").includes("text/html");
}

/**
 * Workspace branding assets — uploaded favicons and logos.
 *
 * Unsigned, unlike every other route here, because a favicon is fetched by the
 * browser's icon loader and a logo by Slack's and LinkedIn's card scrapers.
 * None of them carry a token, and all of them are the point of the feature.
 *
 * That is safe only because of what the API guarantees about these bytes: every
 * object under `branding/` was produced by Pillow re-encoding a decoded pixel
 * buffer, so it is a PNG and nothing else. The content type is therefore pinned
 * here rather than read from R2 — the response cannot become HTML even if
 * something upstream one day stores the wrong metadata.
 *
 * Keys are content-addressed (the digest is in the filename), so a changed logo
 * is a changed URL and this can be cached immutably.
 */
async function serveBranding(key, env, request) {
  if (!key.startsWith("branding/") || key.includes("..")) return notFound();
  const object = await env.ARTIFACTS.get(key);
  if (!object) return notFound();
  const headers = {
    ...baseHeaders(),
    ...corsHeaders(request),
    "content-type": "image/png",
    "cache-control": "public, max-age=31536000, immutable",
    // Belt and braces: even served as an image, never let it act as a document.
    "content-security-policy": "default-src 'none'; sandbox",
    "content-disposition": "inline",
  };
  if (request.method === "HEAD") {
    return new Response(null, { headers: { ...headers, "content-length": String(object.size) } });
  }
  return new Response(object.body, { headers });
}

// The app may read artifact bytes with fetch() so it can hand the user a
// download without navigating here — a top-level visit to this domain trips
// Chrome's lookalike-domain interstitial, and there's nothing for a user to
// see at this origin anyway.
const APP_ORIGINS = new Set([
  "https://markdrop.in",
  "https://www.markdrop.in",
  "http://localhost:3000",
]);

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  if (!origin || !APP_ORIGINS.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "vary": "Origin",
  };
}

function baseHeaders() {
  return {
    // Never let the browser guess a type — a .txt must not become a page.
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow",
    // This origin never issues credentials, but say so explicitly.
    "permissions-policy": "interest-cohort=()",
  };
}

/**
 * Access epoch (access policy §5.3): the API bumps a document's epoch on every
 * narrowing (made private, password added or changed, require sign-in turned
 * on) and writes it onto the object as customMetadata.ae. Every signed token
 * carries the epoch it was minted under as claim `e`. When the object has an
 * `ae` and the token's `e` differs, the token predates the narrowing: refuse
 * it, so narrowing revokes every signed link already handed out. Objects with
 * no `ae` (never narrowed, or written before epochs existed) accept any valid
 * token, as before.
 */
function epochMatches(claims, objectEpoch) {
  if (objectEpoch === undefined || objectEpoch === null || objectEpoch === "") return true;
  return claims.e !== undefined && claims.e !== null && String(claims.e) === String(objectEpoch);
}

/** `attachment` with a sanitised filename (ASCII fallback + RFC 5987 UTF-8). */
function attachmentDisposition(name) {
  const raw = (name || "").slice(0, 200).replace(/[\u0000-\u001f\u007f"\\/]/g, "").trim();
  if (!raw) return "attachment";
  const ascii = raw.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}

/** HS256 verify against the API's MARKDROP_ARTIFACT_SIGNING_KEY. */
async function verifyToken(token, key, expectedBlobKey, objectEpoch) {
  try {
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) return false;
    const data = new TextEncoder().encode(`${h}.${p}`);
    const sig = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0)
    );
    const ck = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    if (!(await crypto.subtle.verify("HMAC", ck, sig, data))) return false;
    const claims = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
    if (!claims.exp || claims.exp * 1000 < Date.now()) return false;
    // Bind the token to this exact object, so one unlocked artifact's token
    // can't be replayed against another, and to the object's current access
    // epoch, so a narrowing revokes it.
    return claims.k === expectedBlobKey && epochMatches(claims, objectEpoch);
  } catch {
    return false;
  }
}

async function serveRaw(blobKey, url, env, request) {
  if (!blobKey.startsWith("art/")) return notFound(request, url);

  // HEAD first: the size is needed to resolve a Range, and fetching the body to
  // find out how big it is would defeat the point of ranging in the first place.
  const head = await env.ARTIFACTS.head(blobKey);
  if (!head) return notFound(request, url);

  // FAIL CLOSED. Serve without a token only when the object is explicitly
  // marked public; anything unmarked — a partial write, a metadata update that
  // didn't land, a bug — requires a signed token rather than being readable.
  // The previous check was the other way round (private only when flagged), and
  // because nothing ever set that flag, password-protected artifacts were
  // served to anyone holding the URL.
  const isPublic = head.customMetadata?.public === "1";
  const token = url.searchParams.get("t");
  if (!isPublic) {
    if (!token || !(await verifyToken(token, env.ARTIFACT_SIGNING_KEY, blobKey, head.customMetadata?.ae))) {
      // An HTML artifact's frame whose 15-minute token lapsed lands here on
      // reload: show the page, still with 403 and still without a byte of the
      // object. Non-page callers get the plain body exactly as before.
      if (wantsPage(request)) return unavailablePage(readTheme(url), 403);
      return new Response("This artifact is protected — open it on Markdrop.", {
        status: 403,
        headers: baseHeaders(),
      });
    }
  }

  const type = head.httpMetadata?.contentType || "application/octet-stream";
  const headers = new Headers({ ...baseHeaders(), ...corsHeaders(request) });
  headers.set("content-type", type);
  headers.set("etag", head.httpEtag);
  // Advertised unconditionally: a player checks for this before it will let
  // anyone drag the scrubber, whatever the current request asked for.
  headers.set("accept-ranges", "bytes");

  if (url.searchParams.get("dl") === "1") {
    // A download link (no fetch): on a workspace's own domain the app can't
    // read these bytes cross-origin (CORS here lists only the app's origins),
    // so it links here with ?dl=1 and the browser saves the file instead of
    // navigating. The name is the caller's suggestion, reduced to safe chars.
    headers.set("content-disposition", attachmentDisposition(url.searchParams.get("fn")));
  } else if (INLINE_TYPES.has(type)) {
    headers.set("content-disposition", "inline");
  } else {
    // Unknown type: never render it, hand it over as a download.
    headers.set("content-disposition", "attachment");
  }

  // An editor-synced artifact keeps a stable key while its bytes change, so it
  // must be revalidated on every request. Without this an edit stays invisible
  // for the life of the cache entry — and the key can't simply be rotated,
  // because already-rendered pages hold the old URL.
  const isLive = head.customMetadata?.live === "1";

  if (!isPublic) {
    // Token-gated: must not sit in a shared cache.
    headers.set("cache-control", "private, no-store");
  } else if (isLive) {
    headers.set("cache-control", "no-cache, must-revalidate");
  } else {
    // Deliberately minutes, not the year an immutable key would justify: adding
    // a password flips the object to private, and a long-lived edge copy would
    // keep serving the old public response well after that change.
    headers.set("cache-control", "public, max-age=300");
  }

  if (request.method === "HEAD") {
    headers.set("content-length", String(head.size));
    return new Response(null, { headers });
  }

  const range = parseRange(request.headers.get("range"), head.size);
  if (range?.unsatisfiable) {
    headers.set("content-range", `bytes */${head.size}`);
    return new Response(null, { status: 416, headers });
  }

  if (range) {
    const part = await env.ARTIFACTS.get(blobKey, {
      range: { offset: range.offset, length: range.length },
    });
    if (!part) return notFound();
    headers.set("content-range", `bytes ${range.start}-${range.end}/${head.size}`);
    headers.set("content-length", String(range.length));
    return new Response(part.body, { status: 206, headers });
  }

  const obj = await env.ARTIFACTS.get(blobKey);
  if (!obj) return notFound();
  headers.set("content-length", String(head.size));
  return new Response(obj.body, { headers });
}

function serveViewer(renderer, blobKey, url, env) {
  const theme = readTheme(url);
  if (!blobKey.startsWith("art/")) return unavailablePage(theme, 404);
  // Only `t` is forwarded to /r/. `theme` styles this page and goes no further.
  const token = url.searchParams.get("t");
  const src = `/r/${blobKey}${token ? `?t=${encodeURIComponent(token)}` : ""}`;
  // A video's poster frame: ?poster=<key> (+ ?pt=<its token> when guarded),
  // passed on by the app from the API's poster_url.
  const posterKey = url.searchParams.get("poster");
  const posterToken = url.searchParams.get("pt");
  const poster = posterKey && POSTER_KEY.test(posterKey)
    ? `/r/${posterKey}${posterToken ? `?t=${encodeURIComponent(posterToken)}` : ""}`
    : null;
  const html =
    renderer === "pdf" ? pdfViewer(src, theme)
    : renderer === "sheet" ? sheetViewer(src, theme)
    : renderer === "docx" ? docxViewer(src, theme)
    : renderer === "video" ? videoViewer(src, poster)
    : renderer === "audio" ? audioViewer(src, theme)
    : textViewer(src, theme);
  return new Response(html, {
    headers: {
      ...baseHeaders(),
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=600",
    },
  });
}

/*
 * Design tokens, mirrored from the app's design system
 * (frontend/src/styles/ds/tokens.css; dark = the shipped palette, light = Mist).
 * The values are resolved hex because this origin has no build step and must
 * not load the app's CSS. Keep the two in step by hand when the palette moves.
 *
 * Fonts: the app's Manrope is not served from this origin, so the viewers use
 * the platform's system stack instead of adding font files here.
 */
const TOKENS_DARK = `color-scheme:dark;
  --bg:#030712;--surface:#101828;--surface-raised:#1e2939;--surface-hover:#1e2939;
  --surface-active:#364153;--surface-inset:#0b1220;--border:#1e2939;--border-strong:#364153;
  --border-focus:#2b7fff;--text:#f3f4f6;--text-secondary:#d1d5dc;--text-muted:#99a1af;
  --accent:#155dfc;--accent-hover:#2b7fff;--accent-text:#51a2ff;--accent-soft:#2b7fff26;
  --on-accent:#ffffff;--danger:#ff6467;--code-bg:#0d1117;--code-inline-bg:#1e2939;--code-inline:#fda5d5;
  --shadow-page:0 4px 8px -2px rgb(0 0 0 / .5),0 2px 4px -2px rgb(0 0 0 / .4);`;
const TOKENS_LIGHT = `color-scheme:light;
  --bg:#E3E7ED;--surface:#EBEEF2;--surface-raised:#F2F4F7;--surface-hover:#E3E7EC;
  --surface-active:#D4DAE2;--surface-inset:#D9DEE6;--border:#CDD4DE;--border-strong:#B2BCCA;
  --border-focus:#2F6FEB;--text:#111A2C;--text-secondary:#2B3546;--text-muted:#4A5567;
  --accent:#2150D8;--accent-hover:#1C46C0;--accent-text:#1C46C0;--accent-soft:#2150D81F;
  --on-accent:#ffffff;--danger:#B41C1C;--code-bg:#E6EAEF;--code-inline-bg:#D9DEE6;--code-inline:#A3114F;
  --shadow-page:0 6px 16px -6px rgb(17 26 44 / .16),0 2px 4px -2px rgb(17 26 44 / .08);`;

const SHELL_CSS = `
  :root,[data-theme=dark]{${TOKENS_DARK}}
  @media (prefers-color-scheme:light){:root:not([data-theme]){${TOKENS_LIGHT}}}
  [data-theme=light]{${TOKENS_LIGHT}}
  :root{
    /* Paper is paper: a PDF page is white in either theme. */
    --paper:#ffffff;
    --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
    --r-md:6px;--r-lg:8px;--r-xl:12px;--r-full:9999px;
    --ease-out:cubic-bezier(.16,1,.3,1);--fast:150ms;
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{display:flex;flex-direction:column;background:var(--surface);color:var(--text);
    font:14px/1.5 var(--sans);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
  :focus-visible{outline:2px solid var(--border-focus);outline-offset:2px}
  .wrap{flex:1;min-height:0;overflow:auto;position:relative}
  .msg{margin:0;padding:24px;color:var(--text-muted)}
  .sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}

  /* Toolbar */
  .bar{flex:none;display:flex;align-items:center;gap:4px;min-height:48px;padding:4px 8px 4px 16px;
    background:var(--surface);border-bottom:1px solid var(--border);position:relative;z-index:20}
  .grow{flex:1;min-width:8px}
  .status{min-width:0;font-size:13px;line-height:20px;color:var(--text-secondary);
    font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .group{display:flex;align-items:center}
  .btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:40px;min-width:40px;
    padding:0 10px;border:0;border-radius:var(--r-md);background:transparent;color:var(--text-secondary);
    font:600 13px/1 var(--sans);text-decoration:none;white-space:nowrap;cursor:pointer;
    transition:background-color var(--fast) var(--ease-out),color var(--fast) var(--ease-out)}
  .btn svg{flex:none;width:18px;height:18px}
  .btn.icon{width:40px;padding:0}
  .btn:hover{background:var(--surface-hover);color:var(--text)}
  .btn:active{background:var(--surface-active)}
  .btn[aria-pressed=true]{background:var(--accent-soft);color:var(--accent-text)}
  .btn:disabled{opacity:.45;cursor:default;background:transparent;color:var(--text-secondary)}
  .pct{width:44px;text-align:center;font-size:13px;color:var(--text-secondary);font-variant-numeric:tabular-nums}
  @media (pointer:coarse),(max-width:600px){
    .btn{height:44px;min-width:44px}.btn.icon{width:44px}
  }
  @media (max-width:520px){
    .lbl{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
    .btn.has-lbl{width:44px;padding:0}
    .bar{padding-left:12px}
  }
  @media (max-width:359px){ .pct{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)} }

  /* "This file isn't available" — server-rendered, and swapped in by a viewer
     whose /r/ fetch answers 403 or 404. */
  .na-body{flex:1;display:flex;align-items:center;justify-content:center;padding:32px 16px;background:var(--surface)}
  .na{max-width:480px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px}
  .na-icon{display:grid;place-items:center;width:48px;height:48px;margin-bottom:8px;border-radius:var(--r-xl);
    background:var(--surface-inset);border:1px solid var(--border);color:var(--text-muted)}
  .na-icon svg{width:24px;height:24px}
  .na h1{margin:0;font-size:20px;line-height:28px;font-weight:700;letter-spacing:-.01em;color:var(--text)}
  .na p{margin:0;font-size:15px;line-height:24px;color:var(--text-secondary)}
  .na .na-host{margin-top:16px;font-size:12px;line-height:16px;font-weight:600;letter-spacing:.02em;color:var(--text-muted)}

  @media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}
`;

const ICONS = {
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  fit: '<path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  wrap: '<path d="M4 6h16M4 12h13a3 3 0 0 1 0 6h-4M15 16l-2 2 2 2M4 18h5"/>',
  gone: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="m10 12 4 4m0-4-4 4"/>',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

// Plain text, never a link: a top-level navigation from this origin is exactly
// what trips Chrome's lookalike-domain warning, and it isn't ours to send.
const NA_MARKUP = `<div class="na" role="status">
<span class="na-icon">${icon("gone")}</span>
<h1>This file isn't available</h1>
<p>It may have expired or been deleted.</p>
<p class="na-host">markdrop.in</p>
</div>`;

/**
 * Page skeleton. `theme` is null or one of THEMES — never request text — and
 * `title`/`css`/`body` are this file's own constants plus JSON-encoded values.
 */
function page({ title, theme, css = "", body }) {
  return `<!doctype html><html lang="en"${theme ? ` data-theme="${theme}"` : ""}><head><meta charset="utf-8">
<title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<style>${SHELL_CSS}${css}</style></head><body>
${body}
</body></html>`;
}

/** The Worker-origin "not found / expired" page (§7.22). No script at all. */
function unavailablePage(theme, status) {
  const html = page({
    title: "File unavailable",
    theme,
    body: `<main class="na-body">${NA_MARKUP}</main>`,
  });
  return new Response(html, {
    status,
    headers: {
      ...baseHeaders(),
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      // The body depends on how the request was made (page vs fetch).
      "vary": "Accept, Sec-Fetch-Dest",
    },
  });
}

// Shared by the viewers: swap the whole page for the unavailable state.
const NA_SCRIPT = `
function showUnavailable(){
  document.body.innerHTML = '<main class="na-body">' + ${JSON.stringify(NA_MARKUP)} + '</main>';
}`;

function pdfViewer(src, theme) {
  // Rendered with PDF.js to <canvas>, NOT <embed>. A sandboxed iframe blocks
  // plugin content outright, so the browser's built-in PDF viewer silently
  // fails here. Sandboxing is non-negotiable for user files, so we draw.
  //
  // Canvas alone gives pixels with no selectable text, so each page also gets
  // PDF.js's text layer: transparent, absolutely-positioned spans aligned over
  // the render. That's what makes the content selectable and copyable.
  //
  // Pages are laid out at once (sized boxes) and drawn lazily as they come near
  // the viewport, so zooming re-draws only what is on screen.
  const css = `
  .wrap{background:var(--surface-inset)}
  .pdf{display:flex;flex-direction:column;align-items:center;gap:16px;padding:16px;min-width:min-content}
  .page{position:relative;flex:none;border-radius:2px;overflow:hidden;background:var(--paper);box-shadow:var(--shadow-page)}
  .page canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
  /* pdf.js 4.x text layer: invisible text sitting exactly over the drawn glyphs. */
  .textLayer{position:absolute;text-align:initial;inset:0;overflow:clip;opacity:1;line-height:1;
    -webkit-text-size-adjust:none;text-size-adjust:none;forced-color-adjust:none;transform-origin:0 0;
    caret-color:#000;z-index:2;color-scheme:only light;
    --min-font-size:1;--text-scale-factor:calc(var(--scale-factor) * var(--min-font-size));
    --min-font-size-inv:calc(1 / var(--min-font-size))}
  .textLayer :is(span,br){color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0% 0%}
  .textLayer > :not(.markedContent),.textLayer .markedContent span:not(.markedContent){z-index:1;
    --font-height:0;font-size:calc(var(--text-scale-factor) * var(--font-height));--scale-x:1;--rotate:0deg;
    transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))}
  .textLayer .markedContent{display:contents}
  .textLayer ::selection{background:rgb(33 80 216 / .35)}
  .textLayer .endOfContent{display:block;position:absolute;inset:100% 0 0;z-index:0;cursor:default;user-select:none}
  .pdf .msg{text-align:center}
  @media (max-width:520px){.pdf{padding:12px;gap:12px}}`;
  const body = `<header class="bar" role="toolbar" aria-label="PDF controls">
<span id="status" class="status">Loading PDF…</span>
<span class="grow"></span>
<div class="group">
<button type="button" class="btn icon" id="zout" aria-label="Zoom out" disabled>${icon("minus")}</button>
<span id="pct" class="pct">100%</span>
<button type="button" class="btn icon" id="zin" aria-label="Zoom in" disabled>${icon("plus")}</button>
</div>
<button type="button" class="btn has-lbl" id="fit" aria-pressed="true" disabled>${icon("fit")}<span class="lbl">Fit width</span></button>
<a class="btn has-lbl" id="dl" download>${icon("download")}<span class="lbl">Download</span></a>
</header>
<main class="wrap" id="scroller"><div id="out" class="pdf"></div></main>
<div id="live" class="sr" aria-live="polite" aria-atomic="true"></div>
<script type="module">
const SRC = ${JSON.stringify(src)};
const V = "4.10.38";
${NA_SCRIPT}
const $ = (id) => document.getElementById(id);
const status = $('status'), out = $('out'), scroller = $('scroller'), live = $('live');
const pct = $('pct'), zin = $('zin'), zout = $('zout'), fitBtn = $('fit');
$('dl').href = SRC;

// 100% is the page's printed size: PDF points (1/72 in) to CSS px (1/96 in).
const CSS_UNITS = 96 / 72, LIMIT = 50, FIT_MAX_PX = 1100;
const STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
let pdfjs, doc, pages = [], fit = true, zoom = 1, busy = false, current = 0;
const visible = new Set();
const say = (m) => { live.textContent = m; };

function fitZoom() {
  const avail = Math.min(scroller.clientWidth - 32, FIT_MAX_PX);
  const widest = Math.max.apply(null, pages.map((p) => p.base.width));
  return Math.max(0.25, Math.min(3, avail / (widest * CSS_UNITS)));
}
const zoomNow = () => (fit ? fitZoom() : zoom);
const scaleNow = () => zoomNow() * CSS_UNITS;

function layout() {
  const ratio = scroller.scrollHeight ? scroller.scrollTop / scroller.scrollHeight : 0;
  const s = scaleNow();
  for (const p of pages) {
    p.wrap.style.width = Math.floor(p.base.width * s) + 'px';
    p.wrap.style.height = Math.floor(p.base.height * s) + 'px';
    // The text layer is sized in CSS from this, so an already-drawn page stays
    // selectable and aligned (canvas stretched) until its sharp re-draw lands.
    p.wrap.style.setProperty('--scale-factor', String(s));
    p.wrap.style.setProperty('--total-scale-factor', String(s));
  }
  const z = zoomNow();
  pct.textContent = Math.round(z * 100) + '%';
  zout.disabled = z <= STEPS[0] + 1e-3;
  zin.disabled = z >= STEPS[STEPS.length - 1] - 1e-3;
  fitBtn.setAttribute('aria-pressed', String(fit));
  scroller.scrollTop = ratio * scroller.scrollHeight;
  pump();
}

async function draw(p, s) {
  const viewport = p.page.getViewport({ scale: s });
  // Sharp on high-DPI screens, but capped: mobile Safari refuses canvases over
  // ~16.7M pixels and silently draws nothing.
  let dpr = window.devicePixelRatio || 1;
  const area = viewport.width * viewport.height;
  if (area * dpr * dpr > 16e6) dpr = Math.max(0.5, Math.sqrt(16e6 / area));
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  await p.page.render({ canvasContext: ctx, viewport }).promise;
  if (scaleNow() !== s) return;            // zoom moved on mid-draw; redo later

  const textDiv = document.createElement('div');
  textDiv.className = 'textLayer';
  p.wrap.replaceChildren(canvas, textDiv);
  // Text layer. pdf.js 4.x exposes the TextLayer class; fall back to the
  // older renderTextLayer helper so a CDN version bump can't blank it out.
  const textContent = await p.page.getTextContent();
  if (pdfjs.TextLayer) {
    await new pdfjs.TextLayer({ textContentSource: textContent, container: textDiv, viewport }).render();
  } else if (pdfjs.renderTextLayer) {
    await pdfjs.renderTextLayer({ textContentSource: textContent, container: textDiv, viewport }).promise;
  }
  const end = document.createElement('div');
  end.className = 'endOfContent';
  textDiv.appendChild(end);
  p.drawn = s;
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    for (;;) {
      const s = scaleNow();
      const next = [...visible].sort((a, b) => a.n - b.n).find((p) => p.drawn !== s);
      if (!next) break;
      await draw(next, s);
    }
  } finally {
    busy = false;
  }
}

function track() {
  const line = scroller.getBoundingClientRect().top + scroller.clientHeight * 0.3;
  let n = 1;
  for (const p of pages) {
    if (p.wrap.getBoundingClientRect().top <= line) n = p.n; else break;
  }
  if (n !== current) {
    current = n;
    status.textContent = 'Page ' + n + ' of ' + doc.numPages;
  }
}

function step(dir) {
  const z = zoomNow();
  const next = dir > 0
    ? STEPS.find((v) => v > z + 1e-3)
    : STEPS.slice().reverse().find((v) => v < z - 1e-3);
  if (next == null) return;
  fit = false;
  zoom = next;
  layout();
  say('Zoom ' + Math.round(next * 100) + '%');
}

try {
  pdfjs = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + V + '/pdf.min.mjs');
  // The pdf.js worker lives on another origin and a cross-origin new Worker()
  // is forbidden, so fetch it and hand pdf.js a same-origin blob URL instead.
  const workerCode = await fetch('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + V + '/pdf.worker.min.mjs').then(r => r.text());
  pdfjs.GlobalWorkerOptions.workerSrc =
    URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));

  doc = await pdfjs.getDocument({ url: SRC }).promise;
  const limit = Math.min(doc.numPages, LIMIT);
  for (let n = 1; n <= limit; n++) {
    const pg = await doc.getPage(n);
    const wrap = document.createElement('div');
    wrap.className = 'page';
    wrap.dataset.i = String(n - 1);
    out.appendChild(wrap);
    pages.push({ n, page: pg, base: pg.getViewport({ scale: 1 }), wrap, drawn: 0 });
  }
  if (doc.numPages > limit) {
    const more = document.createElement('p');
    more.className = 'msg';
    more.textContent = 'Showing the first ' + limit + ' of ' + doc.numPages + ' pages. Download to see the rest.';
    out.appendChild(more);
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const p = pages[+e.target.dataset.i];
      if (e.isIntersecting) visible.add(p); else visible.delete(p);
    }
    pump();
  }, { root: scroller, rootMargin: '800px 0px' });
  pages.forEach((p) => io.observe(p.wrap));

  zin.onclick = () => step(1);
  zout.onclick = () => step(-1);
  fitBtn.onclick = () => { fit = true; layout(); say('Fit width, zoom ' + pct.textContent); };
  fitBtn.disabled = false;
  layout();
  track();
  say(doc.numPages + (doc.numPages === 1 ? ' page' : ' pages'));

  let raf = 0;
  scroller.addEventListener('scroll', () => {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; track(); });
  }, { passive: true });
  let lastW = scroller.clientWidth;
  new ResizeObserver(() => {
    if (scroller.clientWidth === lastW) return;
    lastW = scroller.clientWidth;
    if (fit) layout();
  }).observe(scroller);
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); step(1); }
    else if (e.key === '-') { e.preventDefault(); step(-1); }
  });
} catch (e) {
  // Ask the source what happened: an expired token (403) or a deleted file
  // (404) is "isn't available", not "could not render".
  let gone = false;
  try {
    const r = await fetch(SRC, { headers: { Range: 'bytes=0-0' } });
    gone = r.status === 403 || r.status === 404;
  } catch (_) {}
  if (gone) {
    showUnavailable();
  } else {
    status.textContent = 'Could not render this PDF';
    out.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'msg';
    p.textContent = String(e && e.message || e);
    out.appendChild(p);
  }
}
</script>`;
  return page({ title: "PDF", theme, css, body });
}

function sheetViewer(src, theme) {
  const css = `
  .bar{gap:8px}
  .pills{display:flex;align-items:center;gap:2px;min-width:0;overflow-x:auto;scrollbar-width:thin}
  .pill{flex:none;height:40px;padding:0 2px;border:0;background:none;color:var(--text-secondary);
    font:500 13px/1 var(--sans);cursor:pointer;border-radius:var(--r-full)}
  .pill span{display:inline-flex;align-items:center;height:28px;padding:0 12px;border-radius:var(--r-full);
    transition:background-color var(--fast) var(--ease-out),color var(--fast) var(--ease-out)}
  .pill:hover span{background:var(--surface-hover);color:var(--text)}
  .pill[aria-selected=true]{color:var(--accent-text);font-weight:600}
  .pill[aria-selected=true] span{background:var(--accent-soft);color:var(--accent-text)}
  .pill:focus-visible{outline:none}
  .pill:focus-visible span{outline:2px solid var(--border-focus);outline-offset:1px}
  @media (pointer:coarse),(max-width:600px){.pill{height:44px}}
  .bar .status{flex:none}
  @media (max-width:520px){.bar.has-tabs .status{display:none}}
  table.grid{border-collapse:separate;border-spacing:0;width:max-content;min-width:100%;font-size:13px}
  .grid td,.grid th{height:26px;padding:3px 10px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);
    white-space:pre;vertical-align:middle;font-variant-numeric:tabular-nums;text-align:left}
  .grid td{color:var(--text-secondary);background:var(--surface)}
  .grid td[data-t=n]{text-align:right}
  .grid tbody tr:hover td{background:var(--surface-raised)}
  .grid thead th{position:sticky;top:0;z-index:2;height:24px;padding:0 10px;background:var(--surface-inset);
    color:var(--text-muted);font-size:11px;font-weight:600;letter-spacing:.02em}
  .grid th.rn{position:sticky;left:0;z-index:1;min-width:44px;padding:0 8px;text-align:center;
    background:var(--surface-inset);color:var(--text-muted);font-size:11px;font-weight:500}
  .grid thead th.rn{z-index:3}`;
  const body = `<header class="bar" id="bar">
<div id="tabs" class="pills" role="tablist" aria-label="Sheets" hidden></div>
<span class="grow"></span>
<span id="status" class="status">Loading spreadsheet…</span>
</header>
<main class="wrap" id="scroller"><div id="out" role="tabpanel"><p class="msg">Loading…</p></div></main>
<div id="live" class="sr" aria-live="polite" aria-atomic="true"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"
        integrity="sha512-r22gChDnGvBylk90+2e/ycr3RVrDi8DIOkIGNhJlKfuyQM4tIRAI062MaV8sfjQKYVGjOBaZBOA87z+IhZE9DA=="
        crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script>
${NA_SCRIPT}
(async () => {
  const $ = (id) => document.getElementById(id);
  const out = $('out'), tabsEl = $('tabs'), status = $('status'), scroller = $('scroller'), live = $('live');
  try {
    const res = await fetch(${JSON.stringify(src)});
    if (res.status === 403 || res.status === 404) return showUnavailable();
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const wb = XLSX.read(await res.arrayBuffer(), { type: 'array' });
    const names = wb.SheetNames, tabs = [];
    const plural = (n, one, many) => n.toLocaleString() + ' ' + (n === 1 ? one : many);

    const render = (i) => {
      const ws = wb.Sheets[names[i]];
      const ref = ws && ws['!ref'];
      out.replaceChildren();
      let summary = 'Empty sheet';
      if (!ref) {
        const p = document.createElement('p');
        p.className = 'msg';
        p.textContent = 'This sheet is empty.';
        out.appendChild(p);
      } else {
        const r = XLSX.utils.decode_range(ref);
        const holder = document.createElement('div');
        holder.innerHTML = XLSX.utils.sheet_to_html(ws, { header: '', footer: '' });
        const table = holder.querySelector('table');
        if (table) {
          table.className = 'grid';
          // Row-number gutter: SheetJS emits one <tr> per row of the range.
          [...table.rows].forEach((tr, k) => {
            const th = document.createElement('th');
            th.scope = 'row';
            th.className = 'rn';
            th.textContent = String(r.s.r + k + 1);
            tr.insertBefore(th, tr.firstChild);
          });
          // Column letters.
          const hr = table.createTHead().insertRow();
          const corner = document.createElement('th');
          corner.className = 'rn';
          corner.setAttribute('aria-hidden', 'true');
          hr.appendChild(corner);
          for (let c = r.s.c; c <= r.e.c; c++) {
            const th = document.createElement('th');
            th.scope = 'col';
            th.textContent = XLSX.utils.encode_col(c);
            hr.appendChild(th);
          }
          out.appendChild(table);
        }
        summary = plural(r.e.r - r.s.r + 1, 'row', 'rows') + ' · ' + plural(r.e.c - r.s.c + 1, 'column', 'columns');
      }
      status.textContent = summary;
      tabs.forEach((b, j) => {
        b.setAttribute('aria-selected', String(j === i));
        b.tabIndex = j === i ? 0 : -1;
      });
      if (tabs[i]) out.setAttribute('aria-labelledby', tabs[i].id);
      scroller.scrollTo(0, 0);
      return summary;
    };

    if (names.length > 1) {
      tabsEl.hidden = false;
      $('bar').classList.add('has-tabs');
      names.forEach((n, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pill';
        b.id = 'tab-' + i;
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-controls', 'out');
        const s = document.createElement('span');
        s.textContent = n;
        b.appendChild(s);
        b.onclick = () => { live.textContent = n + ', ' + render(i); };
        tabsEl.appendChild(b);
        tabs.push(b);
      });
      // Arrow keys move between sheets (roving tabindex).
      tabsEl.addEventListener('keydown', (e) => {
        const i = tabs.indexOf(document.activeElement);
        if (i < 0) return;
        const to = e.key === 'ArrowRight' ? (i + 1) % tabs.length
          : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length
          : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
        if (to < 0) return;
        e.preventDefault();
        tabs[to].focus();
        tabs[to].click();
      });
    } else {
      out.removeAttribute('role');
    }
    render(0);
  } catch (e) {
    status.textContent = 'Could not render';
    out.replaceChildren();
    const p = document.createElement('p');
    p.className = 'msg';
    p.textContent = 'Could not render this spreadsheet: ' + e.message;
    out.appendChild(p);
  }
})();
</script>`;
  return page({ title: "Spreadsheet", theme, css, body });
}

function docxViewer(src, theme) {
  // mammoth converts the docx body to semantic HTML. Fidelity is structural,
  // not pixel-exact — Word's layout model doesn't survive the trip — so the
  // page is styled as a clean document rather than pretending to be Word,
  // with the app's reading typography (17/28 on a 680px measure).
  const css = `
  .doc{max-width:680px;margin:0 auto;padding:48px 24px 96px;font-size:17px;line-height:28px;
    color:var(--text-secondary);overflow-wrap:break-word}
  .doc h1,.doc h2,.doc h3,.doc h4,.doc h5,.doc h6{color:var(--text)}
  .doc h1{font-size:32px;line-height:40px;font-weight:800;letter-spacing:-.02em;margin:0 0 24px}
  .doc h2{font-size:24px;line-height:32px;font-weight:700;letter-spacing:-.015em;margin:48px 0 16px}
  .doc h3{font-size:19px;line-height:28px;font-weight:600;margin:32px 0 12px}
  .doc h4,.doc h5,.doc h6{font-size:16px;line-height:24px;font-weight:600;margin:24px 0 8px}
  .doc p{margin:0 0 20px}
  .doc strong{color:var(--text)}
  .doc ul,.doc ol{margin:0 0 20px;padding-left:1.5em}
  .doc li{margin:4px 0}
  .doc img{max-width:100%;height:auto;border-radius:var(--r-lg)}
  .doc a{color:var(--accent-text);text-decoration:underline;text-underline-offset:3px}
  .doc blockquote{margin:24px 0;padding:2px 0 2px 20px;border-left:3px solid var(--border-strong);color:var(--text-secondary)}
  .doc table{border-collapse:collapse;width:100%;margin:24px 0;font-size:15px;line-height:24px;display:block;overflow-x:auto}
  .doc th,.doc td{border:1px solid var(--border);padding:8px 12px;text-align:left;vertical-align:top}
  .doc th{background:var(--surface-inset);color:var(--text)}
  .doc code{font-family:var(--mono);font-size:.875em;background:var(--code-inline-bg);color:var(--code-inline);padding:1px 5px;border-radius:var(--r-md)}
  .doc .msg{padding:0}
  @media (max-width:520px){.doc{padding:32px 16px 64px}.doc h1{font-size:28px;line-height:36px}}`;
  const body = `<main class="wrap"><article id="out" class="doc"><p class="msg">Loading document…</p></article></main>
<script src="https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.12.1/mammoth.browser.min.js"
        integrity="sha512-Ri7OCzulIlV8Rp8BzgFbScplsAV4hqrES1iv1ure0AHE8IgZ39MT03jqpqsOZkP14STXplVFQwUHXetvXH87XQ=="
        crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script>
${NA_SCRIPT}
(async () => {
  const out = document.getElementById('out');
  try {
    const res = await fetch(${JSON.stringify(src)});
    if (res.status === 403 || res.status === 404) return showUnavailable();
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { value, messages } = await mammoth.convertToHtml({ arrayBuffer: await res.arrayBuffer() });
    // mammoth's output is generated from the docx, not raw user HTML, but this
    // page is sandboxed and cross-origin from the app regardless.
    out.innerHTML = value || '<p class="msg">This document appears to be empty.</p>';
    if (messages?.length) console.info('mammoth:', messages);
  } catch (e) {
    out.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'msg';
    p.textContent = 'Could not render this document: ' + e.message;
    out.appendChild(p);
  }
})();
</script>`;
  return page({ title: "Document", theme, css, body });
}

function textViewer(src, theme) {
  // One element per line so the line numbers stay attached when long lines
  // wrap. The numbers are CSS counters: never selected, never copied.
  const css = `
  .code{font:13px/20px var(--mono);counter-reset:ln;width:max-content;min-width:100%;padding-bottom:16px}
  .code .l{display:flex;min-height:20px}
  .code .l::before{counter-increment:ln;content:counter(ln);content:counter(ln) / "";flex:none;
    position:sticky;left:0;width:calc(var(--gw, 3ch) + 28px);padding:0 12px 0 16px;margin-right:16px;
    text-align:right;color:var(--text-muted);background:var(--surface-inset);border-right:1px solid var(--border);
    user-select:none;box-shadow:12px 0 0 var(--surface)}
  .code .l>span{white-space:pre;padding-right:24px;color:var(--text)}
  .code .l:first-child::before,.code .l:first-child>span{padding-top:12px}
  .code.wrapped{width:auto}
  .code.wrapped .l>span{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}
  /* The gutter's colour runs on past the last line; same ch as the lines. */
  .wrap{font:13px/20px var(--mono);
    background:linear-gradient(to right,var(--surface-inset) calc(var(--gw, 3ch) + 27px),
      var(--border) 0 calc(var(--gw, 3ch) + 28px),transparent 0)}
  .wrap .msg{font-family:var(--sans);font-size:14px}
  .wrap.plain{background:none}`;
  const body = `<header class="bar" role="toolbar" aria-label="File controls">
<span id="status" class="status">Loading…</span>
<span class="grow"></span>
<button type="button" class="btn has-lbl" id="wrapBtn" aria-pressed="true" disabled>${icon("wrap")}<span class="lbl">Wrap lines</span></button>
</header>
<main class="wrap plain" id="scroller"><div id="out" class="code wrapped"><p class="msg">Loading…</p></div></main>
<div id="live" class="sr" aria-live="polite" aria-atomic="true"></div>
<script>
${NA_SCRIPT}
(function () {
  var out = document.getElementById('out'), status = document.getElementById('status');
  var btn = document.getElementById('wrapBtn'), scroller = document.getElementById('scroller');
  var MAX_CHARS = 2000000, MAX_LINES = 100000;
  fetch(${JSON.stringify(src)})
    .then(function (r) {
      if (r.status === 403 || r.status === 404) { showUnavailable(); return null; }
      return r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status));
    })
    .then(function (t) {
      if (t == null) return;
      var cut = t.length > MAX_CHARS;
      if (cut) t = t.slice(0, MAX_CHARS);
      var lines = t.split(/\\r\\n|\\r|\\n/);
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      if (lines.length > MAX_LINES) { lines = lines.slice(0, MAX_LINES); cut = true; }
      out.style.setProperty('--gw', String(lines.length).length + 'ch');
      scroller.style.setProperty('--gw', String(lines.length).length + 'ch');
      // textContent, never innerHTML — this file is untrusted input.
      var frag = document.createDocumentFragment();
      for (var i = 0; i < lines.length; i++) {
        var d = document.createElement('div');
        d.className = 'l';
        var s = document.createElement('span');
        s.textContent = lines[i];
        d.appendChild(s);
        frag.appendChild(d);
      }
      out.replaceChildren(frag);
      scroller.classList.remove('plain');
      status.textContent = lines.length.toLocaleString() + (lines.length === 1 ? ' line' : ' lines') +
        (cut ? ' · truncated, download to see the rest' : '');
      btn.disabled = false;
    })
    .catch(function (e) {
      status.textContent = 'Could not load';
      out.replaceChildren();
      var p = document.createElement('p');
      p.className = 'msg';
      p.textContent = 'Could not load: ' + e.message;
      out.appendChild(p);
    });
  btn.onclick = function () {
    var on = !out.classList.contains('wrapped');
    out.classList.toggle('wrapped', on);
    btn.setAttribute('aria-pressed', String(on));
    document.getElementById('live').textContent = on ? 'Lines wrap' : 'Lines do not wrap';
  };
})();
</script>`;
  return page({ title: "File", theme, css, body });
}

/**
 * Audio: the browser's own <audio controls>, centred on the page. Seeking uses
 * the same range requests /r/ already answers for video.
 */
function audioViewer(src, theme) {
  const css = `
  .stage{flex:1;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:var(--surface)}
  audio{width:100%;max-width:640px}
  .msg{text-align:center}`;
  const body = `<main class="stage" id="stage"><audio id="a" controls preload="metadata" src="${src}"></audio></main>
<script>
${NA_SCRIPT}
(function () {
  var a = document.getElementById('a');
  // Same diagnosis as the video player: a 403/404 and an unplayable codec
  // look identical to the element, so ask the source which it was.
  a.addEventListener('error', function () {
    fetch(a.currentSrc || a.src, { headers: { Range: 'bytes=0-0' } }).then(function (r) {
      if (r.status === 401 || r.status === 403 || r.status === 404) { showUnavailable(); return; }
      var p = document.createElement('p');
      p.className = 'msg';
      p.textContent = 'This audio file can\\u2019t be played in this browser. Download it to play it locally.';
      document.getElementById('stage').replaceChildren(p);
    }).catch(function () {});
  });
})();
</script>`;
  return page({ title: "Audio", theme, css, body });
}

/**
 * Custom video player.
 *
 * Not <video controls>: the native chrome differs on every browser, can't be
 * styled, and has no speed control worth the name on most of them. This is one
 * player that looks and behaves the same everywhere, and it earns its keep with
 * the things people actually want on a shared recording — scrubbing with a
 * buffered indicator, speed, frame stepping and keyboard control.
 *
 * Everything here is inline. The page renders inside a sandboxed iframe on a
 * throwaway origin with no build step and no network beyond the video itself.
 */
function videoViewer(src, poster = null) {
  // Dark in both app themes, on purpose: a light frame around moving pictures
  // fights the picture. It still takes the design tokens (dark set) and the
  // accent, so it reads as the same product as the other viewers.
  return `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><title>Video</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<style>
  :root{${TOKENS_DARK}
    --stage:#000000;--scrim:rgb(3 7 18 / .82);
    --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:var(--bg);color:var(--text);
    font:13px/1.5 var(--sans);overflow:hidden;-webkit-font-smoothing:antialiased}
  #stage{position:relative;height:100%;display:flex;align-items:center;justify-content:center;background:var(--bg)}
  /* The stage takes focus on load for keyboard control; its focus indicator
     is the controls appearing (focus-within below), not a ring round the frame. */
  #stage:focus{outline:none}
  video{max-width:100%;max-height:100%;display:block;background:var(--stage)}
  /* Controls fade out during playback and come back on any intent to interact. */
  #ui{position:absolute;left:0;right:0;bottom:0;padding:44px 14px 12px;
    background:linear-gradient(transparent,var(--scrim) 62%);
    opacity:0;transition:opacity .18s ease;pointer-events:none}
  #stage.show #ui,#stage:focus-within #ui{opacity:1;pointer-events:auto}
  #stage.idle{cursor:none}
  /* Scrubber: buffered under played under an oversized invisible hit area. */
  .bar{position:relative;height:16px;display:flex;align-items:center;cursor:pointer}
  .track{position:relative;height:4px;width:100%;border-radius:99px;background:rgb(255 255 255 / .22);overflow:hidden;transition:height .12s}
  .bar:hover .track{height:7px}
  .buffered{position:absolute;inset:0 auto 0 0;background:rgb(255 255 255 / .3);width:0}
  .played{position:absolute;inset:0 auto 0 0;background:var(--accent-hover);width:0}
  .knob{position:absolute;top:50%;width:12px;height:12px;margin-left:-6px;border-radius:50%;
    background:var(--text);transform:translateY(-50%) scale(0);transition:transform .12s;pointer-events:none}
  .bar:hover .knob{transform:translateY(-50%) scale(1)}
  #hoverTime{position:absolute;bottom:22px;transform:translateX(-50%);background:var(--surface);
    border:1px solid var(--border-strong);padding:2px 6px;border-radius:5px;font-variant-numeric:tabular-nums;
    font-size:11px;display:none;pointer-events:none;white-space:nowrap}
  .row{display:flex;align-items:center;gap:6px;margin-top:8px}
  button{background:transparent;border:0;color:var(--text);cursor:pointer;padding:6px;border-radius:7px;
    min-width:36px;min-height:36px;display:inline-flex;align-items:center;justify-content:center;line-height:0}
  button:hover{background:rgb(255 255 255 / .12)}
  button:focus-visible{outline:2px solid var(--border-focus);outline-offset:2px}
  .time{font-variant-numeric:tabular-nums;font-size:12px;color:var(--text-secondary);padding:0 4px;white-space:nowrap}
  .spacer{flex:1}
  .vol{display:flex;align-items:center;gap:4px}
  .vol input{width:0;opacity:0;transition:width .16s,opacity .16s;accent-color:var(--accent-hover);cursor:pointer}
  .vol:hover input,.vol input:focus{width:72px;opacity:1}
  .menu{position:relative}
  .menu>div{position:absolute;bottom:42px;right:0;background:var(--surface);border:1px solid var(--border-strong);
    border-radius:9px;padding:4px;display:none;min-width:104px;box-shadow:0 8px 28px rgb(0 0 0 / .5)}
  .menu.open>div{display:block}
  .menu div button{width:100%;justify-content:space-between;font-size:12px;padding:6px 9px;line-height:1.4}
  .menu div button[aria-checked=true]{color:var(--accent-text)}
  #big{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    background:transparent;border:0;cursor:pointer;padding:0}
  #big:hover{background:transparent}
  #big span{width:66px;height:66px;border-radius:50%;background:rgb(3 7 18 / .62);backdrop-filter:blur(3px);
    display:flex;align-items:center;justify-content:center;transition:transform .16s,opacity .16s,background-color .16s}
  #big:hover span{background:var(--accent)}
  #stage.playing #big span{opacity:0;transform:scale(.86)}
  #toast{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgb(3 7 18 / .8);
    padding:9px 15px;border-radius:9px;font-size:13px;opacity:0;transition:opacity .18s;pointer-events:none}
  #toast.on{opacity:1}
  #err{padding:2rem;color:var(--text-muted);text-align:center;max-width:32rem;font-size:14px}
  #err strong{color:var(--text)}
  #err code{color:var(--text-secondary);font-size:12px}
  @media (pointer:coarse),(max-width:600px){button{min-width:44px;min-height:44px}}
  /* Narrow frames: keep play, scrub, volume, time, speed and full screen; the
     ±10s and picture-in-picture buttons stay on the keyboard (← → j l). */
  @media (max-width:480px){#back,#fwd,#pip{display:none!important}.row{gap:2px}#ui{padding:40px 8px 8px}}
  @media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}
</style></head><body>
<div id="stage" tabindex="0">
  <video id="v" playsinline preload="metadata"${poster ? ` poster="${poster}"` : ""} src="${src}"></video>
  <button id="big" aria-label="Play"><span><svg width="26" height="26" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg></span></button>
  <div id="toast"></div>
  <div id="ui">
    <div class="bar" id="bar">
      <div class="track"><div class="buffered" id="buf"></div><div class="played" id="played"></div></div>
      <div class="knob" id="knob"></div>
      <div id="hoverTime"></div>
    </div>
    <div class="row">
      <button id="play" aria-label="Play"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
      <button id="back" aria-label="Back 10 seconds" title="Back 10s (←)"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 5 6 9l5 4"/><path d="M6 9h7a5 5 0 0 1 0 10h-2"/></svg></button>
      <button id="fwd" aria-label="Forward 10 seconds" title="Forward 10s (→)"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m13 5 5 4-5 4"/><path d="M18 9h-7a5 5 0 0 0 0 10h2"/></svg></button>
      <div class="vol">
        <button id="mute" aria-label="Mute"><svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path id="wave" d="M16.5 12a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg></button>
        <input id="vol" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume">
      </div>
      <span class="time" id="time">0:00 / 0:00</span>
      <span class="spacer"></span>
      <div class="menu" id="speedMenu">
        <button id="speedBtn" aria-label="Playback speed" title="Speed">1×</button>
        <div id="speedList"></div>
      </div>
      <button id="pip" aria-label="Picture in picture" title="Picture in picture"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="12" width="8" height="6" rx="1" fill="currentColor"/></svg></button>
      <button id="fs" aria-label="Full screen" title="Full screen (f)"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg></button>
    </div>
  </div>
</div>
<script>
(function(){
  var v=document.getElementById('v'),stage=document.getElementById('stage');
  var played=document.getElementById('played'),buf=document.getElementById('buf'),knob=document.getElementById('knob');
  var bar=document.getElementById('bar'),hoverTime=document.getElementById('hoverTime');
  var timeEl=document.getElementById('time'),toast=document.getElementById('toast');
  var SPEEDS=[0.25,0.5,0.75,1,1.25,1.5,1.75,2];

  function fmt(t){
    if(!isFinite(t)||t<0)t=0;
    var h=Math.floor(t/3600),m=Math.floor(t%3600/60),s=Math.floor(t%60);
    return (h?h+':'+String(m).padStart(2,'0'):m)+':'+String(s).padStart(2,'0');
  }
  function flash(msg){toast.textContent=msg;toast.classList.add('on');
    clearTimeout(flash.t);flash.t=setTimeout(function(){toast.classList.remove('on')},700)}

  // Controls hide while playing and return on movement or focus.
  var idleTimer;
  function wake(){
    stage.classList.add('show');stage.classList.remove('idle');
    clearTimeout(idleTimer);
    if(!v.paused)idleTimer=setTimeout(function(){
      stage.classList.remove('show');stage.classList.add('idle');},2200);
  }
  stage.addEventListener('mousemove',wake);
  stage.addEventListener('touchstart',wake,{passive:true});
  wake();

  function setIcon(el,playing){
    el.innerHTML = playing
      ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>'
      : '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  }
  function toggle(){ v.paused ? v.play().catch(function(){}) : v.pause(); }

  document.getElementById('play').onclick=toggle;
  document.getElementById('big').onclick=toggle;
  v.addEventListener('play',function(){stage.classList.add('playing');setIcon(document.getElementById('play'),true);wake()});
  v.addEventListener('pause',function(){stage.classList.remove('playing');setIcon(document.getElementById('play'),false);wake()});

  document.getElementById('back').onclick=function(){v.currentTime=Math.max(0,v.currentTime-10);flash('−10s')};
  document.getElementById('fwd').onclick=function(){v.currentTime=Math.min(v.duration||0,v.currentTime+10);flash('+10s')};

  function paint(){
    var d=v.duration||0,p=d?v.currentTime/d*100:0;
    played.style.width=p+'%';knob.style.left=p+'%';
    timeEl.textContent=fmt(v.currentTime)+' / '+fmt(d);
    if(v.buffered.length){
      // The range under the playhead, not range 0 — after a seek they differ.
      for(var i=0;i<v.buffered.length;i++){
        if(v.buffered.start(i)<=v.currentTime&&v.currentTime<=v.buffered.end(i)){
          buf.style.width=(d?v.buffered.end(i)/d*100:0)+'%';break;
        }
      }
    }
  }
  v.addEventListener('timeupdate',paint);
  v.addEventListener('progress',paint);
  v.addEventListener('loadedmetadata',paint);

  function seekFromEvent(e){
    var r=bar.getBoundingClientRect();
    var x=((e.touches?e.touches[0].clientX:e.clientX)-r.left)/r.width;
    return Math.max(0,Math.min(1,x))*(v.duration||0);
  }
  var scrubbing=false;
  bar.addEventListener('pointerdown',function(e){scrubbing=true;bar.setPointerCapture(e.pointerId);v.currentTime=seekFromEvent(e);paint()});
  bar.addEventListener('pointermove',function(e){
    var r=bar.getBoundingClientRect(),x=(e.clientX-r.left)/r.width;
    if(x>=0&&x<=1&&v.duration){hoverTime.style.display='block';hoverTime.style.left=(x*100)+'%';hoverTime.textContent=fmt(x*v.duration)}
    if(scrubbing){v.currentTime=seekFromEvent(e);paint()}
  });
  bar.addEventListener('pointerleave',function(){hoverTime.style.display='none'});
  bar.addEventListener('pointerup',function(e){scrubbing=false;try{bar.releasePointerCapture(e.pointerId)}catch(_){}} );

  var volEl=document.getElementById('vol'),wave=document.getElementById('wave');
  volEl.oninput=function(){v.volume=+volEl.value;v.muted=+volEl.value===0};
  document.getElementById('mute').onclick=function(){v.muted=!v.muted;flash(v.muted?'Muted':'Unmuted')};
  v.addEventListener('volumechange',function(){
    volEl.value=v.muted?0:v.volume; wave.style.opacity=(v.muted||!v.volume)?0.25:1;
  });

  var menu=document.getElementById('speedMenu'),list=document.getElementById('speedList'),sBtn=document.getElementById('speedBtn');
  SPEEDS.forEach(function(sp){
    var b=document.createElement('button');
    b.textContent=sp+'×';b.setAttribute('role','menuitemradio');
    b.setAttribute('aria-checked',sp===1?'true':'false');
    b.onclick=function(){
      v.playbackRate=sp;sBtn.textContent=sp+'×';menu.classList.remove('open');
      [].forEach.call(list.children,function(c){c.setAttribute('aria-checked',c===b?'true':'false')});
      flash(sp+'× speed');
    };
    list.appendChild(b);
  });
  sBtn.onclick=function(e){e.stopPropagation();menu.classList.toggle('open')};
  document.addEventListener('click',function(){menu.classList.remove('open')});

  var pip=document.getElementById('pip');
  if(!document.pictureInPictureEnabled)pip.style.display='none';
  pip.onclick=function(){
    (document.pictureInPictureElement?document.exitPictureInPicture():v.requestPictureInPicture()).catch(function(){});
  };
  document.getElementById('fs').onclick=function(){
    // The stage, not the video: fullscreening the element itself would take the
    // custom controls away and hand back the browser's.
    (document.fullscreenElement?document.exitFullscreen():stage.requestFullscreen()).catch(function(){});
  };

  stage.addEventListener('keydown',function(e){
    var k=e.key.toLowerCase();
    if(k===' '||k==='k'){e.preventDefault();toggle()}
    else if(k==='arrowleft'||k==='j'){e.preventDefault();v.currentTime=Math.max(0,v.currentTime-(k==='j'?10:5));flash('−'+(k==='j'?10:5)+'s')}
    else if(k==='arrowright'||k==='l'){e.preventDefault();v.currentTime=Math.min(v.duration||0,v.currentTime+(k==='l'?10:5));flash('+'+(k==='l'?10:5)+'s')}
    else if(k==='arrowup'){e.preventDefault();v.volume=Math.min(1,v.volume+.1);flash('Volume '+Math.round(v.volume*100)+'%')}
    else if(k==='arrowdown'){e.preventDefault();v.volume=Math.max(0,v.volume-.1);flash('Volume '+Math.round(v.volume*100)+'%')}
    else if(k==='f'){e.preventDefault();document.getElementById('fs').click()}
    else if(k==='m'){e.preventDefault();document.getElementById('mute').click()}
    else if(k===','){v.pause();v.currentTime=Math.max(0,v.currentTime-1/30);flash('Frame back')}
    else if(k==='.'){v.pause();v.currentTime=v.currentTime+1/30;flash('Frame forward')}
    else if(k>='0'&&k<='9'&&v.duration){v.currentTime=v.duration*(+k/10);flash(k*10+'%')}
  });
  stage.focus();

  // Two very different failures reach this handler looking identical: a codec
  // the browser cannot decode, and a file it was never allowed to fetch. A
  // guarded artifact answers /r/ with 403, the <video> element reports the same
  // generic error, and blaming the codec sends someone off to re-encode a file
  // that was never the problem. So ask the source what actually happened before
  // saying anything about it.
  v.addEventListener('error',function(){
    var say=function(h,b){
      stage.innerHTML='<div id="err"><p><strong>'+h+'</strong></p><p>'+b+'</p></div>';
    };
    var codec='The browser accepted the file but not the codec inside it \\u2014 common with '+
      '<code>.mov</code> recordings. Download it to play locally, or re-encode to H.264 MP4.';
    // One byte is enough to learn the status, and costs nothing if it succeeds.
    fetch(v.currentSrc||v.src,{headers:{Range:'bytes=0-0'}}).then(function(r){
      if(r.status===401||r.status===403)
        say('You don\\u2019t have access to this video.',
            'Open it from the document page while signed in with the address it was shared with.');
      else if(r.status===404)
        say('This video is no longer available.','The file may have been deleted.');
      else say('This video can\\u2019t be played here.',codec);
    }).catch(function(){
      say('This video can\\u2019t be played here.',codec);
    });
  });
})();
</script>
</body></html>`;
}
