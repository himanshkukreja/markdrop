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

const VIEWERS = new Set(["pdf", "sheet", "text", "docx"]);

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
]);

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

  const obj = await env.ARTIFACTS.get(blobKey);
  if (!obj) return notFound();

  const isPrivate = obj.customMetadata?.private === "1";
  const token = url.searchParams.get("t");
  if (isPrivate) {
    if (!token || !(await verifyToken(token, env.ARTIFACT_SIGNING_KEY, blobKey))) {
      return new Response("This artifact requires an unlock link.", {
        status: 403,
        headers: baseHeaders(),
      });
    }
  }

  const type = obj.httpMetadata?.contentType || "application/octet-stream";
  const headers = new Headers({ ...baseHeaders(), ...corsHeaders(request) });
  headers.set("content-type", type);
  headers.set("etag", obj.httpEtag);

  if (INLINE_TYPES.has(type)) {
    headers.set("content-disposition", "inline");
  } else {
    // Unknown type: never render it, hand it over as a download.
    headers.set("content-disposition", "attachment");
  }

  if (isPrivate) {
    // Token-gated: must not sit in a shared cache.
    headers.set("cache-control", "private, no-store");
  } else {
    // Keys are random and never reused, so the bytes at a key never change.
    headers.set("cache-control", "public, max-age=31536000, immutable");
  }

  if (request.method === "HEAD") return new Response(null, { headers });
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
  // plugin content outright — the browser's built-in PDF viewer is a plugin, so
  // <embed> silently fails here with "the frame into which the plugin is
  // loading is sandboxed". Canvas rendering is plain JS and works inside the
  // sandbox, which is non-negotiable for user-supplied files.
  return `<!doctype html><meta charset="utf-8"><title>PDF</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${SHELL_CSS}
  .pdf{display:flex;flex-direction:column;align-items:center;gap:14px;padding:16px}
  .pdf canvas{max-width:100%;height:auto;border-radius:6px;box-shadow:0 4px 24px rgba(0,0,0,.45);background:#fff}
  .bar{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:12px;
       padding:.55rem .9rem;background:#111c33;border-bottom:1px solid rgba(255,255,255,.06);
       font-size:12px;color:#94a3b8}
  .bar a{margin-left:auto;color:#60a5fa;text-decoration:none}
</style>
<div class="bar"><span id="status">Loading PDF…</span><a id="dl" download>Download</a></div>
<div class="wrap"><div id="out" class="pdf"></div></div>
<script type="module">
const SRC = ${JSON.stringify(src)};
document.getElementById('dl').href = SRC;
const status = document.getElementById('status'), out = document.getElementById('out');
try {
  const pdfjs = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs');
  // The pdf.js worker lives on another origin and a cross-origin new Worker()
  // is forbidden, so fetch it and hand pdf.js a same-origin blob URL instead.
  const workerCode = await fetch('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs').then(r => r.text());
  pdfjs.GlobalWorkerOptions.workerSrc =
    URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));

  const doc = await pdfjs.getDocument({ url: SRC }).promise;
  status.textContent = doc.numPages + (doc.numPages === 1 ? ' page' : ' pages');
  // Cap the work: a huge PDF shouldn't lock the tab up rendering every page.
  const limit = Math.min(doc.numPages, 50);
  for (let n = 1; n <= limit; n++) {
    const page = await doc.getPage(n);
    const scale = Math.min(2, (Math.min(window.innerWidth, 1100) - 40) / page.getViewport({ scale: 1 }).width);
    const viewport = page.getViewport({ scale: Math.max(scale, 0.5) * (window.devicePixelRatio || 1) });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width; canvas.height = viewport.height;
    canvas.style.width = Math.round(viewport.width / (window.devicePixelRatio || 1)) + 'px';
    out.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
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
