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
 */

const VIEWERS = new Set(["pdf", "sheet", "text", "docx", "video"]);

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
      if (!VIEWERS.has(renderer)) return notFound();
      return serveViewer(renderer, parts.slice(2).join("/"), url, env);
    }
    if (parts[0] === "b") return serveBranding(parts.slice(1).join("/"), env, request);
    if (url.pathname === "/" || url.pathname === "/robots.txt") {
      // Nothing here should ever be indexed — it's all user content.
      return new Response("User-Agent: *\nDisallow: /\n", {
        headers: { "content-type": "text/plain", "x-robots-tag": "noindex, nofollow" },
      });
    }
    return notFound();
  },
};

function notFound() {
  return new Response("Not found", { status: 404, headers: baseHeaders() });
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

/** HS256 verify against the API's MARKDROP_ARTIFACT_SIGNING_KEY. */
async function verifyToken(token, key, expectedBlobKey) {
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
    // can't be replayed against another.
    return claims.k === expectedBlobKey;
  } catch {
    return false;
  }
}

async function serveRaw(blobKey, url, env, request) {
  if (!blobKey.startsWith("art/")) return notFound();

  // HEAD first: the size is needed to resolve a Range, and fetching the body to
  // find out how big it is would defeat the point of ranging in the first place.
  const head = await env.ARTIFACTS.head(blobKey);
  if (!head) return notFound();

  // FAIL CLOSED. Serve without a token only when the object is explicitly
  // marked public; anything unmarked — a partial write, a metadata update that
  // didn't land, a bug — requires a signed token rather than being readable.
  // The previous check was the other way round (private only when flagged), and
  // because nothing ever set that flag, password-protected artifacts were
  // served to anyone holding the URL.
  const isPublic = head.customMetadata?.public === "1";
  const token = url.searchParams.get("t");
  if (!isPublic) {
    if (!token || !(await verifyToken(token, env.ARTIFACT_SIGNING_KEY, blobKey))) {
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

  if (INLINE_TYPES.has(type)) {
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
  if (!blobKey.startsWith("art/")) return notFound();
  const token = url.searchParams.get("t");
  const src = `/r/${blobKey}${token ? `?t=${encodeURIComponent(token)}` : ""}`;
  const html =
    renderer === "pdf" ? pdfViewer(src)
    : renderer === "sheet" ? sheetViewer(src)
    : renderer === "docx" ? docxViewer(src)
    : renderer === "video" ? videoViewer(src)
    : textViewer(src);
  return new Response(html, {
    headers: {
      ...baseHeaders(),
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=600",
    },
  });
}

const SHELL_CSS = `
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:#0b1220;color:#e5e7eb;
    font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  .msg{padding:2rem;color:#94a3b8}
  table{border-collapse:collapse;width:max-content;min-width:100%}
  th,td{border:1px solid #1e293b;padding:6px 10px;white-space:pre;font-variant-numeric:tabular-nums}
  th{background:#111c33;position:sticky;top:0;font-weight:600;text-align:left}
  tr:nth-child(even) td{background:#0e1729}
  .tabs{display:flex;gap:.25rem;padding:.5rem;background:#111c33;position:sticky;top:0;z-index:2;overflow-x:auto}
  .tabs button{background:#1e293b;color:#cbd5e1;border:0;border-radius:6px;padding:.35rem .75rem;cursor:pointer;white-space:nowrap}
  .tabs button[aria-selected=true]{background:#3b82f6;color:#fff}
  .wrap{overflow:auto;height:100%}
  pre{margin:0;padding:1rem;white-space:pre-wrap;word-break:break-word}
`;

function pdfViewer(src) {
  // Rendered with PDF.js to <canvas>, NOT <embed>. A sandboxed iframe blocks
  // plugin content outright, so the browser's built-in PDF viewer silently
  // fails here. Sandboxing is non-negotiable for user files, so we draw.
  //
  // Canvas alone gives pixels with no selectable text, so each page also gets
  // PDF.js's text layer: transparent, absolutely-positioned spans aligned over
  // the render. That's what makes the content selectable and copyable.
  return `<!doctype html><meta charset="utf-8"><title>PDF</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${SHELL_CSS}
  .pdf{display:flex;flex-direction:column;align-items:center;gap:14px;padding:16px}
  .page{position:relative;border-radius:6px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.45);background:#fff}
  .page canvas{display:block;max-width:100%;height:auto}
  /* pdf.js text layer: invisible text sitting exactly over the drawn glyphs. */
  .textLayer{position:absolute;inset:0;overflow:hidden;line-height:1;
    text-size-adjust:none;forced-color-adjust:none;transform-origin:0 0;
    caret-color:#000;z-index:2}
  .textLayer span,.textLayer br{position:absolute;white-space:pre;cursor:text;
    transform-origin:0% 0%;color:transparent}
  .textLayer ::selection{background:rgba(59,130,246,.45)}
  .textLayer .endOfContent{position:absolute;inset:100% 0 0;display:block;
    cursor:default;user-select:none}
  .bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:12px;
       padding:.55rem .9rem;background:#111c33;border-bottom:1px solid rgba(255,255,255,.06);
       font-size:12px;color:#94a3b8}
  .bar a{margin-left:auto;color:#60a5fa;text-decoration:none}
</style>
<div class="bar"><span id="status">Loading PDF…</span><a id="dl" download>Download</a></div>
<div class="wrap"><div id="out" class="pdf"></div></div>
<script type="module">
const SRC = ${JSON.stringify(src)};
const V = "4.10.38";
document.getElementById('dl').href = SRC;
const status = document.getElementById('status'), out = document.getElementById('out');
try {
  const pdfjs = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + V + '/pdf.min.mjs');
  // The pdf.js worker lives on another origin and a cross-origin new Worker()
  // is forbidden, so fetch it and hand pdf.js a same-origin blob URL instead.
  const workerCode = await fetch('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + V + '/pdf.worker.min.mjs').then(r => r.text());
  pdfjs.GlobalWorkerOptions.workerSrc =
    URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));

  const doc = await pdfjs.getDocument({ url: SRC }).promise;
  status.textContent = doc.numPages + (doc.numPages === 1 ? ' page' : ' pages') + ' · select text to copy';
  const dpr = window.devicePixelRatio || 1;
  const limit = Math.min(doc.numPages, 50);

  for (let n = 1; n <= limit; n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const cssScale = Math.max(0.5, Math.min(2, (Math.min(window.innerWidth, 1100) - 40) / base.width));
    // CSS-space viewport drives layout AND the text layer; the canvas backing
    // store is scaled by DPR on top so the render stays sharp.
    const viewport = page.getViewport({ scale: cssScale });

    const wrap = document.createElement('div');
    wrap.className = 'page';
    wrap.style.width = viewport.width + 'px';
    wrap.style.height = viewport.height + 'px';

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    wrap.appendChild(canvas);

    const textDiv = document.createElement('div');
    textDiv.className = 'textLayer';
    wrap.appendChild(textDiv);
    out.appendChild(wrap);

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    await page.render({ canvasContext: ctx, viewport }).promise;

    // Text layer. pdf.js 4.x exposes the TextLayer class; fall back to the
    // older renderTextLayer helper so a CDN version bump can't blank it out.
    const textContent = await page.getTextContent();
    if (pdfjs.TextLayer) {
      await new pdfjs.TextLayer({ textContentSource: textContent, container: textDiv, viewport }).render();
    } else if (pdfjs.renderTextLayer) {
      await pdfjs.renderTextLayer({ textContentSource: textContent, container: textDiv, viewport }).promise;
    }
    const end = document.createElement('div');
    end.className = 'endOfContent';
    textDiv.appendChild(end);
  }

  if (doc.numPages > limit) {
    const more = document.createElement('p');
    more.className = 'msg';
    more.textContent = 'Showing the first ' + limit + ' of ' + doc.numPages + ' pages — download to see the rest.';
    out.appendChild(more);
  }
} catch (e) {
  status.textContent = 'Could not render this PDF';
  out.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'msg';
  p.textContent = String(e && e.message || e);
  out.appendChild(p);
}
</script>`;
}

function sheetViewer(src) {
  return `<!doctype html><meta charset="utf-8"><title>Spreadsheet</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${SHELL_CSS}</style>
<div id="tabs" class="tabs" hidden></div>
<div class="wrap"><div id="out" class="msg">Loading…</div></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"
        integrity="sha512-r22gChDnGvBylk90+2e/ycr3RVrDi8DIOkIGNhJlKfuyQM4tIRAI062MaV8sfjQKYVGjOBaZBOA87z+IhZE9DA=="
        crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script>
(async () => {
  const out = document.getElementById('out'), tabsEl = document.getElementById('tabs');
  try {
    const res = await fetch(${JSON.stringify(src)});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const wb = XLSX.read(await res.arrayBuffer(), { type: 'array' });
    const render = (name) => {
      out.innerHTML = XLSX.utils.sheet_to_html(wb.Sheets[name]);
      [...tabsEl.children].forEach(b =>
        b.setAttribute('aria-selected', String(b.textContent === name)));
    };
    if (wb.SheetNames.length > 1) {
      tabsEl.hidden = false;
      wb.SheetNames.forEach(n => {
        const b = document.createElement('button');
        b.textContent = n; b.onclick = () => render(n); tabsEl.appendChild(b);
      });
    }
    render(wb.SheetNames[0]);
  } catch (e) {
    out.textContent = 'Could not render this spreadsheet: ' + e.message;
  }
})();
</script>`;
}

function docxViewer(src) {
  // mammoth converts the docx body to semantic HTML. Fidelity is structural,
  // not pixel-exact — Word's layout model doesn't survive the trip — so the
  // page is styled as a clean document rather than pretending to be Word.
  return `<!doctype html><meta charset="utf-8"><title>Document</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${SHELL_CSS}
  .doc{max-width:46rem;margin:0 auto;padding:3rem 1.5rem;line-height:1.7}
  .doc h1,.doc h2,.doc h3{line-height:1.25;margin:1.6em 0 .5em;color:#f3f4f6}
  .doc h1{font-size:1.9rem}.doc h2{font-size:1.45rem}.doc h3{font-size:1.2rem}
  .doc p{margin:0 0 1em}
  .doc ul,.doc ol{margin:0 0 1em 1.4em}
  .doc img{max-width:100%;height:auto;border-radius:6px}
  .doc table{width:100%;margin:1.5em 0}
  .doc a{color:#60a5fa}
  .doc blockquote{margin:1em 0;padding-left:1em;border-left:3px solid #1e293b;color:#94a3b8}
</style>
<div class="wrap"><div id="out" class="doc"><p class="msg">Loading document…</p></div></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.12.1/mammoth.browser.min.js"
        integrity="sha512-Ri7OCzulIlV8Rp8BzgFbScplsAV4hqrES1iv1ure0AHE8IgZ39MT03jqpqsOZkP14STXplVFQwUHXetvXH87XQ=="
        crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script>
(async () => {
  const out = document.getElementById('out');
  try {
    const res = await fetch(${JSON.stringify(src)});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { value, messages } = await mammoth.convertToHtml({ arrayBuffer: await res.arrayBuffer() });
    // mammoth's output is generated from the docx, not raw user HTML, but this
    // page is sandboxed and cross-origin from the app regardless.
    out.innerHTML = value || '<p class="msg">This document appears to be empty.</p>';
    if (messages?.length) console.info('mammoth:', messages);
  } catch (e) {
    out.innerHTML = '';
    out.textContent = 'Could not render this document: ' + e.message;
  }
})();
</script>`;
}

function textViewer(src) {
  return `<!doctype html><meta charset="utf-8"><title>File</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${SHELL_CSS}</style>
<div class="wrap"><pre id="out">Loading…</pre></div>
<script>
fetch(${JSON.stringify(src)})
  .then(r => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
  .then(t => {
    // textContent, never innerHTML — this file is untrusted input.
    document.getElementById('out').textContent =
      t.length > 2000000 ? t.slice(0, 2000000) + '\\n\\n… truncated' : t;
  })
  .catch(e => { document.getElementById('out').textContent = 'Could not load: ' + e.message; });
</script>`;
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
function videoViewer(src) {
  return `<!doctype html><meta charset="utf-8"><title>Video</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:#08090c;color:#e5e7eb;
    font:13px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
  #stage{position:relative;height:100%;display:flex;align-items:center;justify-content:center;background:#08090c}
  video{max-width:100%;max-height:100%;display:block;background:#000}
  /* Controls fade out during playback and come back on any intent to interact. */
  #ui{position:absolute;left:0;right:0;bottom:0;padding:44px 14px 12px;
    background:linear-gradient(transparent,rgba(0,0,0,.82) 62%);
    opacity:0;transition:opacity .18s ease;pointer-events:none}
  #stage.show #ui,#stage:focus-within #ui{opacity:1;pointer-events:auto}
  #stage.idle{cursor:none}
  /* Scrubber: buffered under played under an oversized invisible hit area. */
  .bar{position:relative;height:16px;display:flex;align-items:center;cursor:pointer}
  .track{position:relative;height:4px;width:100%;border-radius:99px;background:rgba(255,255,255,.22);overflow:hidden;transition:height .12s}
  .bar:hover .track{height:7px}
  .buffered{position:absolute;inset:0 auto 0 0;background:rgba(255,255,255,.3);width:0}
  .played{position:absolute;inset:0 auto 0 0;background:#3b82f6;width:0}
  .knob{position:absolute;top:50%;width:12px;height:12px;margin-left:-6px;border-radius:50%;
    background:#fff;transform:translateY(-50%) scale(0);transition:transform .12s;pointer-events:none}
  .bar:hover .knob{transform:translateY(-50%) scale(1)}
  #hoverTime{position:absolute;bottom:22px;transform:translateX(-50%);background:#111827;
    border:1px solid #263043;padding:2px 6px;border-radius:5px;font-variant-numeric:tabular-nums;
    font-size:11px;display:none;pointer-events:none;white-space:nowrap}
  .row{display:flex;align-items:center;gap:6px;margin-top:8px}
  button{background:transparent;border:0;color:#e5e7eb;cursor:pointer;padding:6px;border-radius:7px;
    display:inline-flex;align-items:center;justify-content:center;line-height:0}
  button:hover{background:rgba(255,255,255,.12)}
  button:focus-visible{outline:2px solid #3b82f6;outline-offset:1px}
  .time{font-variant-numeric:tabular-nums;font-size:12px;color:#cbd5e1;padding:0 4px;white-space:nowrap}
  .spacer{flex:1}
  .vol{display:flex;align-items:center;gap:4px}
  .vol input{width:0;opacity:0;transition:width .16s,opacity .16s;accent-color:#3b82f6;cursor:pointer}
  .vol:hover input,.vol input:focus{width:72px;opacity:1}
  .menu{position:relative}
  .menu>div{position:absolute;bottom:38px;right:0;background:#0f1623;border:1px solid #263043;
    border-radius:9px;padding:4px;display:none;min-width:104px;box-shadow:0 8px 28px rgba(0,0,0,.5)}
  .menu.open>div{display:block}
  .menu div button{width:100%;justify-content:space-between;font-size:12px;padding:6px 9px;line-height:1.4}
  .menu div button[aria-checked=true]{color:#60a5fa}
  #big{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    background:transparent;border:0;cursor:pointer;padding:0}
  #big span{width:66px;height:66px;border-radius:50%;background:rgba(8,9,12,.62);backdrop-filter:blur(3px);
    display:flex;align-items:center;justify-content:center;transition:transform .16s,opacity .16s}
  #stage.playing #big span{opacity:0;transform:scale(.86)}
  #toast{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(8,9,12,.8);
    padding:9px 15px;border-radius:9px;font-size:13px;opacity:0;transition:opacity .18s;pointer-events:none}
  #toast.on{opacity:1}
  #err{padding:2rem;color:#94a3b8;text-align:center;max-width:32rem}
  #err code{color:#cbd5e1;font-size:12px}
</style>
<div id="stage" tabindex="0">
  <video id="v" playsinline preload="metadata" src="${src}"></video>
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
</script>`;
}
