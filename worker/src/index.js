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

const VIEWERS = new Set(["pdf", "sheet", "text"]);

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
]);

export default {
  async fetch(request, env) {
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
  const headers = new Headers(baseHeaders());
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
  const html = renderer === "pdf" ? pdfViewer(src) : renderer === "sheet" ? sheetViewer(src) : textViewer(src);
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
  // The browser's built-in PDF viewer is used via <embed>; no external library,
  // so the strict CSP below can stay in place.
  return `<!doctype html><meta charset="utf-8"><title>PDF</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${SHELL_CSS} embed{width:100%;height:100%;border:0}</style>
<embed src="${src}" type="application/pdf">`;
}

function sheetViewer(src) {
  return `<!doctype html><meta charset="utf-8"><title>Spreadsheet</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${SHELL_CSS}</style>
<div id="tabs" class="tabs" hidden></div>
<div class="wrap"><div id="out" class="msg">Loading…</div></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"
        integrity="sha512-r22gChDnGvBylk90+2e/ycr3RVrDi8DIOkIGNhJlKfuyQM4tv7nnQrstkkJ4kVUS0Bmc+7Sm0OSpsQPcRJRerA=="
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
