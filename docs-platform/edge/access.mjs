/**
 * Password and members-only docs sites at the edge: the policy, the tokens, the sign-in pages.
 *
 * Policy: `sites/<site>/access.json` in the store, `{site, level, policy_version}` (written by the
 * API's access job and by the runner before it flips a site's pointer; no password, no hash). No
 * object = public (every site from before this existed). Anything unreadable or unknown = locked.
 *
 * Sign-in never shows the edge a password. The sign-in page (gatePage) posts the password straight
 * to the Markdrop API, or (members-only) links to markdrop.in, where the reader's own session shows
 * whether they may read the site. Either way the API answers with a two-minute *grant*, signed with
 * the secret it shares with this Worker (DOCS_ACCESS_SECRET), in the URL fragment of
 * /_access/callback (fragments never reach a server or a log). That page posts it to
 * /_access/session, which checks it — this site, this host, the current policy version, and this
 * browser (the hash of the random state the sign-in page left in an HttpOnly cookie) — and sets the
 * session cookie: HttpOnly, Secure, SameSite=Lax, host-only (`__Host-`), 12 hours, signed for this
 * site and policy version, so a new password or level signs everyone out.
 *
 * Token: base64url(JSON) "." base64url(HMAC-SHA256(secret, purpose "." base64url(JSON))), the
 * API's format (backend/app/services/docs_site_access.py).
 */

export const SESSION_COOKIE = "__Host-docs_access";
export const STATE_COOKIE = "__Host-docs_state";
export const SESSION_TTL = 12 * 3600;
export const STATE_TTL = 30 * 60;
export const GRANT_PURPOSE = "mdda-grant-v1";
export const SESSION_PURPOSE = "mdda-session-v1";
export const SECRET_MIN = 32;
const LEVELS = new Set(["public", "password", "members"]);
const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64url(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const keys = new Map();
function hmacKey(secret) {
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keys.set(secret, k);
  }
  return k;
}

export async function signToken(secret, purpose, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`${purpose}.${body}`)));
  return `${body}.${b64url(mac)}`;
}

/** The payload of a token signed for `purpose` (constant-time MAC check), or null. Expiry is the caller's. */
export async function readToken(secret, purpose, token) {
  if (typeof token !== "string" || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const mac = unb64url(parts[1]);
  if (!mac || mac.length !== 32) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), mac, enc.encode(`${purpose}.${parts[0]}`));
  if (!ok) return null;
  try {
    const data = JSON.parse(dec.decode(unb64url(parts[0]) || new Uint8Array()));
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

export async function stateHash(state) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(state))));
}

export function newState() {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export const validState = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{43}$/.test(s);

/** sites/<site>/access.json → {level, version}. null (no object) = public; anything odd = locked. */
export function parsePolicy(raw) {
  if (raw === null || raw === undefined) return { level: "public", version: 0 };
  try {
    const p = JSON.parse(raw);
    const v = p?.policy_version;
    if (LEVELS.has(p?.level) && Number.isSafeInteger(v) && v >= 0) return { level: p.level, version: v };
  } catch {
    /* locked */
  }
  return { level: "locked", version: -1 };
}

export function parseCookies(header) {
  const out = new Map();
  for (const part of (header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!out.has(k)) out.set(k, part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

/** A path on this host to land on after sign-in; anything else is "/". */
export function safeNext(p) {
  if (typeof p !== "string" || !p.startsWith("/") || p.startsWith("//") || p.startsWith("/\\") || p.length > 2000) return "/";
  if (/[\u0000-\u001f\u007f]/.test(p)) return "/";
  if (p.startsWith("/_access/")) return "/";
  return p;
}

const now = () => Math.floor(Date.now() / 1000);

/** A session cookie valid for this site and policy. */
export async function sessionValid(secret, value, site, policy) {
  if (!value) return false;
  const p = await readToken(secret, SESSION_PURPOSE, value);
  if (!p) return false;
  const t = now();
  return p.s === site && p.v === policy.version && p.k === policy.level && Number.isSafeInteger(p.exp) && p.exp > t && p.exp <= t + SESSION_TTL + 300;
}

export function mintSession(secret, site, policy) {
  return signToken(secret, SESSION_PURPOSE, { s: site, v: policy.version, k: policy.level, exp: now() + SESSION_TTL });
}

/** Why a grant can't be used here (a short code for the sign-in page), or null when it can. */
export async function grantProblem(secret, token, { site, host, policy, state }) {
  const g = await readToken(secret, GRANT_PURPOSE, token);
  if (!g) return "invalid";
  if (!Number.isSafeInteger(g.exp) || g.exp <= now() || g.exp > now() + 900) return "expired";
  if (g.s !== site || g.h !== host) return "invalid";
  if (g.k !== policy.level || g.v !== policy.version) return "changed";
  if (!validState(state) || g.sh !== (await stateHash(state))) return "cookies";
  return null;
}

/* ── pages ──────────────────────────────────────────────────────────── */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const ERRORS = {
  wrong: "That password isn't right. Try again.",
  rate: "Too many tries. Wait a few minutes, then try again.",
  expired: "That sign-in took too long. Try again.",
  changed: "This site's access settings just changed. Sign in again.",
  cookies: "Your browser didn't keep this site's sign-in cookie. Allow cookies for this site, then try again.",
  invalid: "That sign-in link isn't valid here. Try again.",
  unavailable: "Signing in isn't available right now. Try again in a few minutes.",
};

/** The brand files the sign-in page shows (logo, favicon), which stay readable on a private site. */
export function brandFiles(manifest) {
  const b = manifest?.site?.brand || {};
  const out = new Set();
  for (const p of [b.logo?.light, b.logo?.dark, b.favicon]) if (typeof p === "string" && p.startsWith("/docs-assets/") && manifest.files?.[p]) out.add(p);
  return out;
}

function brandSrc(p, files) {
  if (typeof p !== "string") return null;
  if (p.startsWith("https://") && p.length < 2048) return p;
  return files.has(p) ? p : null;
}

const CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#0f172a;--muted:#64748b;--line:#e2e8f0;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0b1120;--fg:#e2e8f0;--muted:#94a3b8;--line:#1e293b;--card:#0f172a}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px 16px}
main{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:32px 28px;box-shadow:0 10px 30px rgba(15,23,42,.06)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:24px;font-weight:600}.brand img{height:28px;width:auto;max-width:180px}
h1{font-size:20px;line-height:1.3;margin:0 0 6px}p{margin:0 0 20px;color:var(--muted);font-size:14px}
label{display:block;font-size:13px;font-weight:600;margin-bottom:6px}
input{width:100%;font:inherit;padding:10px 12px;border-radius:9px;border:1px solid var(--line);background:transparent;color:inherit}
input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
.btn{display:block;width:100%;margin-top:14px;padding:11px 14px;border:0;border-radius:9px;background:var(--accent);color:#fff;font:inherit;font-weight:600;text-align:center;text-decoration:none;cursor:pointer}
.btn:hover{filter:brightness(1.08)}.err{background:rgba(220,38,38,.08);color:#dc2626;border-radius:8px;padding:9px 12px;font-size:14px;margin:0 0 16px}
footer{margin-top:22px;font-size:12px;color:var(--muted);text-align:center}footer a{color:inherit}`;

/** The branded sign-in page (self-contained: inline CSS, no scripts). */
export function gatePage({ manifest, policy, site, host, next, state, error, apiOrigin, appOrigin }) {
  const s = manifest?.site || {};
  const b = s.brand || {};
  const name = (typeof s.name === "string" && s.name.trim()) || "Docs";
  const files = brandFiles(manifest);
  const light = brandSrc(b.logo?.light, files);
  const dark = brandSrc(b.logo?.dark, files);
  const accent = HEX.test(b.accent || "") ? b.accent : "#2563eb";
  const accentDark = HEX.test(b.accentDark || "") ? b.accentDark : accent;
  const wordmark = !!(light && b.logo?.wordmark);
  const logo = light
    ? `<picture>${dark ? `<source srcset="${esc(dark)}" media="(prefers-color-scheme: dark)">` : ""}<img src="${esc(light)}" alt="${esc(b.logo?.alt || name)}"></picture>`
    : "";
  const msg = error && ERRORS[error] ? `<p class="err" role="alert">${esc(ERRORS[error])}</p>` : "";
  let body;
  if (policy.level === "password") {
    const action = `${apiOrigin}/api/v1/docs-access/password?site=${encodeURIComponent(site)}`;
    body = `<h1>${esc(name)} is password protected</h1><p>Enter the password to read these docs.</p>${msg}
<form method="post" action="${esc(action)}"><input type="hidden" name="host" value="${esc(host)}"><input type="hidden" name="next" value="${esc(next)}"><input type="hidden" name="sh" value="${esc(state)}">
<label for="pw">Password</label><input id="pw" type="password" name="password" required maxlength="200" autocomplete="current-password" autofocus>
<button class="btn" type="submit">Continue</button></form>`;
  } else {
    const q = new URLSearchParams({ site, host, next, sh: state });
    body = `<h1>Sign in to read ${esc(name)}</h1><p>These docs are for members of the team that publishes them. Sign in with the Markdrop account they invited.</p>${msg}
<a class="btn" href="${esc(`${appOrigin}/auth/docs-access?${q}`)}">Sign in with Markdrop</a>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(name)} · Sign in</title>${files.has(b.favicon) ? `<link rel="icon" href="${esc(b.favicon)}">` : ""}<style>${CSS}:root{--accent:${accent}}@media (prefers-color-scheme:dark){:root{--accent:${accentDark}}}</style></head>
<body><main><div class="brand">${logo}${wordmark ? "" : `<span>${esc(name)}</span>`}</div>${body}
<footer>Published with <a href="https://markdrop.in" rel="noopener">Markdrop</a></footer></main></body></html>`;
}

/** /_access/callback: hands the grant from the URL fragment to /_access/session in a POST body. */
export function callbackPage(nonce) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Signing in…</title>
<style>body{font:16px/1.5 system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;color:#64748b}</style></head>
<body><p>Signing in…</p><form id="f" method="post" action="/_access/session"><input type="hidden" name="g"><input type="hidden" name="next"></form>
<noscript>Signing in needs JavaScript. Turn it on, then open this site again.</noscript>
<script nonce="${nonce}">(function(){var h=new URLSearchParams(location.hash.slice(1));history.replaceState(null,"",location.pathname);var g=h.get("g");if(!g){location.replace("/");return}var f=document.getElementById("f");f.g.value=g;f.next.value=h.get("next")||"/";f.submit()})();</script></body></html>`;
}

export function privatePage(name) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(name)}</title>
<style>${CSS}:root{--accent:#2563eb}</style></head><body><main><h1>${esc(name)} is private</h1><p>Signing in to this site isn't available right now. Try again later.</p></main></body></html>`;
}
