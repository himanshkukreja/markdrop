/**
 * Private pages and sections at the edge: who may open what, the reader's session, the lock page.
 *
 * A build marks what is protected (builder/access.mjs): a route with `a: <rule>` (a page, its RSC
 * payload, `.md` twin, OG card), a page with private sections (`sec: [rules]`, served as the
 * variant route `x-access/<rules>/<page>` its reader may see, never at that address), a site file
 * with `a: [rules]`. Who each rule lets in is the site's access policy (sites/<site>/access.json,
 * written by the API's access job and by the runner before it flips the pointer):
 *
 *   readers: {version, rv, rules: {<id>: {kind: "members"|"people"|"password", emails, domains, pv}}}
 *
 * A rule the policy doesn't have (or doesn't understand) lets nobody in: fail closed.
 *
 * Who the reader is: the `__Host-docs_reader` cookie, signed by this Worker for this site and the
 * policy's `rv` (bumped by "Sign out every reader"): {e: verified email, m: team member, pw:
 * [[rule, pv]] the passwords given, exp}. It is set from a *reader grant* the API mints (the same
 * token format and secret as the site-wide sign-in, access.mjs), in the fragment of
 * /_access/callback: after "Sign in with Markdrop" (the reader's account: email + whether they're
 * on the guide's team), after a correct page password (that rule, at its password version), or
 * from an emailed sign-in link (a verified email; that link can be opened on another device, so its
 * grant isn't tied to this browser's state but is single-use at the API and lives two minutes).
 *
 * A team member opens everything. `people`: the email is listed, or its domain is. `password`: the
 * reader gave that rule's current password. Lists are read live from the policy, so removing
 * someone takes effect within seconds; a new password (pv) closes that rule to everyone.
 */
import { b64url, cookie, newState, parseCookies, readToken, safeNext, signToken, stateHash, validState, brandFiles } from "./access.mjs";

export const READER_COOKIE = "__Host-docs_reader";
export const READER_TTL = 7 * 24 * 3600;
export const READER_GRANT = "mdda-reader-grant-v1";
export const READER_SESSION = "mdda-reader-v1";
export const AI_TOKEN = "mdda-ai-v1";
export const AI_TTL = 600;
const KINDS = new Set(["members", "people", "password"]);
const EMAIL = /^[^\s@]{1,64}@[a-z0-9.-]{1,253}$/;

const now = () => Math.floor(Date.now() / 1000);

/** access.json `readers` → {version, rv, rules: Map}. Junk → no rules (every protected thing locked). */
export function parseReaders(raw) {
  const out = { version: 0, rv: 0, rules: new Map() };
  let p;
  try {
    p = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return out;
  }
  const r = p && typeof p === "object" ? p.readers : null;
  if (!r || typeof r !== "object") return out;
  out.version = Number.isSafeInteger(r.version) ? r.version : 0;
  out.rv = Number.isSafeInteger(r.rv) && r.rv >= 0 ? r.rv : 0;
  for (const [id, rule] of Object.entries(r.rules && typeof r.rules === "object" ? r.rules : {})) {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id) || !rule || !KINDS.has(rule.kind)) continue;
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x) => x.trim().toLowerCase()).filter(Boolean) : []);
    out.rules.set(id, {
      id,
      kind: rule.kind,
      name: typeof rule.name === "string" ? rule.name.slice(0, 60) : "",
      emails: new Set(list(rule.emails)),
      domains: new Set(list(rule.domains).map((d) => d.replace(/^@/, ""))),
      pv: Number.isSafeInteger(rule.pv) ? rule.pv : 0,
    });
  }
  return out;
}

/** The reader behind a request: {e, m, pw: Map<rule, pv>} (empty when signed out or the cookie is stale). */
export async function readerOf(secret, req, site, readers) {
  const none = { e: null, m: false, pw: new Map(), signedIn: false };
  if (!secret) return none;
  const raw = parseCookies(req.headers.get("cookie")).get(READER_COOKIE);
  if (!raw) return none;
  const p = await readToken(secret, READER_SESSION, raw);
  const t = now();
  if (!p || p.s !== site || p.rv !== readers.rv || !Number.isSafeInteger(p.exp) || p.exp <= t || p.exp > t + READER_TTL + 300) return none;
  const pw = new Map();
  for (const x of Array.isArray(p.pw) ? p.pw : []) if (Array.isArray(x) && typeof x[0] === "string" && Number.isSafeInteger(x[1])) pw.set(x[0], x[1]);
  const e = typeof p.e === "string" && EMAIL.test(p.e) ? p.e : null;
  return { e, m: p.m === true, pw, signedIn: !!(e || p.m || pw.size) };
}

export function mintReader(secret, site, readers, reader) {
  const pw = [...reader.pw].slice(0, 32);
  return signToken(secret, READER_SESSION, { s: site, rv: readers.rv, ...(reader.e ? { e: reader.e } : {}), ...(reader.m ? { m: true } : {}), ...(pw.length ? { pw } : {}), exp: now() + READER_TTL });
}

/** Whether the reader may open what `ruleId` protects. */
export function allowed(readers, reader, ruleId) {
  const rule = readers.rules.get(ruleId);
  if (!rule) return false;
  if (reader.m) return true;
  if (rule.kind === "people") {
    if (!reader.e) return false;
    const domain = reader.e.slice(reader.e.lastIndexOf("@") + 1);
    return rule.emails.has(reader.e) || rule.domains.has(domain);
  }
  if (rule.kind === "password") return reader.pw.has(ruleId) && reader.pw.get(ruleId) === rule.pv;
  return false;
}

/** The rules (of `ids`) this reader may open. */
export function allowedRules(readers, reader, ids) {
  return ids.filter((id) => allowed(readers, reader, id));
}

/**
 * A reader grant (/_access/callback → /_access/reader) checked for this site and host: the reader
 * it adds, or {problem}. Grants with a browser state hash must match this browser's state cookie;
 * an emailed link's grant (`x: "email"`) carries none.
 */
export async function readerGrant(secret, token, { site, host, readers, state }) {
  const g = await readToken(secret, READER_GRANT, token);
  if (!g) return { problem: "invalid" };
  const t = now();
  if (!Number.isSafeInteger(g.exp) || g.exp <= t || g.exp > t + 900) return { problem: "expired" };
  if (g.s !== site || g.h !== host) return { problem: "invalid" };
  if (g.rv !== readers.rv) return { problem: "changed" };
  if (g.x === "email") {
    if (g.exp > t + 180) return { problem: "invalid" };
  } else if (!validState(state) || g.sh !== (await stateHash(state))) return { problem: "cookies" };
  const pw = new Map();
  for (const x of Array.isArray(g.pw) ? g.pw : []) if (Array.isArray(x) && typeof x[0] === "string" && Number.isSafeInteger(x[1])) pw.set(x[0], x[1]);
  const e = typeof g.e === "string" && EMAIL.test(g.e) ? g.e : null;
  return { add: { e, m: g.m === true, pw } };
}

/** The reader after a grant: a new identity replaces the old one; passwords given add up. */
export function mergeReader(cur, add) {
  const pw = new Map(cur.pw);
  for (const [k, v] of add.pw) pw.set(k, v);
  const identity = add.e || add.m ? { e: add.e, m: add.m } : { e: cur.e, m: cur.m };
  return { ...identity, pw };
}

export function aiToken(secret, site, rules) {
  return signToken(secret, AI_TOKEN, { s: site, r: rules, exp: now() + AI_TTL });
}

/* ── the lock page ─────────────────────────────────────────────────────── */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const MESSAGES = {
  sent: ["ok", "Check your email. If that address can open this page, a sign-in link is on its way. It works once, for 15 minutes."],
  requested: ["ok", "Request sent. The guide's team will get an email; you'll hear back at the address you gave."],
  wrong: ["err", "That password isn't right. Try again."],
  rate: ["err", "Too many tries. Wait a few minutes, then try again."],
  expired: ["err", "That sign-in took too long, or the link was already used. Try again."],
  changed: ["err", "This guide's access settings just changed. Sign in again."],
  cookies: ["err", "Your browser didn't keep this site's sign-in cookie. Allow cookies for this site, then try again."],
  invalid: ["err", "That sign-in link isn't valid here. Try again."],
  unavailable: ["err", "Signing in isn't available right now. Try again in a few minutes."],
  denied: ["err", "That account can't open this page. Ask the guide's team for access."],
  email: ["err", "Enter a valid email address."],
};

const CSS = `:root{color-scheme:light dark;--bg:#f8fafc;--fg:#0f172a;--muted:#64748b;--line:#e2e8f0;--card:#fff;--soft:#f1f5f9}
@media (prefers-color-scheme:dark){:root{--bg:#0b1120;--fg:#e2e8f0;--muted:#94a3b8;--line:#1e293b;--card:#0f172a;--soft:#111c31}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px 16px}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px 26px;box-shadow:0 12px 32px rgba(15,23,42,.07)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:22px;font-weight:600}.brand img{height:26px;width:auto;max-width:180px}
.lock{display:inline-flex;width:40px;height:40px;border-radius:999px;align-items:center;justify-content:center;background:var(--soft);border:1px solid var(--line);margin-bottom:14px}
.lock svg{width:20px;height:20px;stroke:var(--muted)}
h1{font-size:20px;line-height:1.3;margin:0 0 6px}p{margin:0 0 18px;color:var(--muted);font-size:14px}
label{display:block;font-size:13px;font-weight:600;margin:0 0 6px}
input,textarea{width:100%;font:inherit;font-size:15px;padding:10px 12px;border-radius:9px;border:1px solid var(--line);background:transparent;color:inherit}
textarea{min-height:68px;resize:vertical}
input:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
.btn{display:block;width:100%;margin-top:12px;padding:11px 14px;border:0;border-radius:9px;background:var(--accent);color:#fff;font:inherit;font-weight:600;text-align:center;text-decoration:none;cursor:pointer}
.btn:hover{filter:brightness(1.08)}.btn.secondary{background:transparent;color:var(--fg);border:1px solid var(--line)}
.msg{border-radius:8px;padding:9px 12px;font-size:14px;margin:0 0 16px}.msg.err{background:rgba(220,38,38,.08);color:#dc2626}.msg.ok{background:rgba(22,163,74,.09);color:#15803d}
@media (prefers-color-scheme:dark){.msg.ok{color:#4ade80}.msg.err{color:#f87171}}
.who{font-size:13px;color:var(--muted);margin:0 0 16px;padding:8px 10px;border-radius:8px;background:var(--soft)}.who a{color:inherit}
details{margin-top:18px;border-top:1px solid var(--line);padding-top:14px}summary{cursor:pointer;font-size:14px;font-weight:600}
details[open] summary{margin-bottom:12px}.field{margin-bottom:10px}
.back{display:inline-block;margin-top:16px;font-size:13px;color:var(--muted)}
footer{margin-top:20px;font-size:12px;color:var(--muted);text-align:center}footer a{color:inherit}`;

const LOCK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 10h-1V7a6 6 0 0 0-12 0v3H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2zM8 10V7a4 4 0 0 1 8 0v3"/></svg>`;

/**
 * The branded lock page for one rule: why it's locked and the way in (Sign in with Markdrop,
 * Email me a sign-in link, Enter the password), plus Request access. Self-contained (inline CSS, no
 * scripts); forms post straight to the API, never through the edge.
 */
export function lockPage({ manifest, rule, ruleId, reader, site, host, next, state, message, apiOrigin, appOrigin, section = false }) {
  const s = manifest?.site || {};
  const b = s.brand || {};
  const name = (typeof s.name === "string" && s.name.trim()) || "Docs";
  const files = brandFiles(manifest);
  const src = (p) => (typeof p === "string" && (files.has(p) || (p.startsWith("https://") && p.length < 2048)) ? p : null);
  const light = src(b.logo?.light);
  const dark = src(b.logo?.dark);
  const accent = HEX.test(b.accent || "") ? b.accent : "#2563eb";
  const accentDark = HEX.test(b.accentDark || "") ? b.accentDark : accent;
  const logo = light ? `<picture>${dark ? `<source srcset="${esc(dark)}" media="(prefers-color-scheme: dark)">` : ""}<img src="${esc(light)}" alt="${esc(b.logo?.alt || name)}"></picture>` : "";
  const wordmark = !!(light && b.logo?.wordmark);
  const kind = rule?.kind || "unknown";
  const what = section ? "This section" : "This page";
  const msg = message && MESSAGES[message] ? `<p class="msg ${MESSAGES[message][0]}" role="${MESSAGES[message][0] === "err" ? "alert" : "status"}">${esc(MESSAGES[message][1])}</p>` : "";
  const hidden = (extra = {}) =>
    Object.entries({ host, next, sh: state, rule: ruleId, ...extra }).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("");
  const q = (path, extra = {}) => `${apiOrigin}${path}?${new URLSearchParams({ site, ...extra })}`;
  let title;
  let lede;
  let action = "";
  if (kind === "members") {
    title = `${what} is for the ${esc(name)} team`;
    lede = "Sign in with the Markdrop account the team invited.";
    const sq = new URLSearchParams({ site, host, next, sh: state, mode: "reader" });
    action = `<a class="btn" href="${esc(`${appOrigin}/auth/docs-access?${sq}`)}">Sign in with Markdrop</a>`;
  } else if (kind === "people") {
    title = `${what} is private`;
    lede = rule.name ? `Only people at ${esc(rule.name)} can open it. Sign in with your work email: we'll send you a link.` : "Only some people can open it. Sign in with your email: we'll send you a link.";
    action = `<form method="post" action="${esc(q("/api/v1/docs-access/email-link"))}">${hidden()}
<label for="em">Work email</label><input id="em" type="email" name="email" required maxlength="254" autocomplete="email" ${reader?.e ? `value="${esc(reader.e)}"` : "autofocus"}>
<button class="btn" type="submit">Email me a sign-in link</button></form>`;
  } else if (kind === "password") {
    title = `${what} is password protected`;
    lede = "Enter the password you were given to open it.";
    action = `<form method="post" action="${esc(q("/api/v1/docs-access/page-password"))}">${hidden()}
<label for="pw">Password</label><input id="pw" type="password" name="password" required maxlength="200" autocomplete="current-password" autofocus>
<button class="btn" type="submit">Continue</button></form>`;
  } else {
    title = `${what} isn't available`;
    lede = "Its access settings are being updated. Try again in a minute.";
  }
  const who = reader?.e
    ? `<p class="who">Signed in as <strong>${esc(reader.e)}</strong>${kind === "password" ? "" : ", which can't open this"}. <a href="/_access/logout?next=${encodeURIComponent(next)}">Sign out</a></p>`
    : "";
  const request = kind === "members" || kind === "people" || kind === "password"
    ? `<details${message === "requested" ? "" : ""}><summary>Request access</summary><form method="post" action="${esc(q("/api/v1/docs-access/request"))}">${hidden()}
<div class="field"><label for="rq-e">Your email</label><input id="rq-e" type="email" name="email" required maxlength="254" autocomplete="email" ${reader?.e ? `value="${esc(reader.e)}"` : ""}></div>
<div class="field"><label for="rq-n">Note for the team (optional)</label><textarea id="rq-n" name="note" maxlength="500" placeholder="Who you are and why you need it"></textarea></div>
<button class="btn secondary" type="submit">Send request</button></form></details>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Private · ${esc(name)}</title>${files.has(b.favicon) ? `<link rel="icon" href="${esc(b.favicon)}">` : ""}<style>${CSS}:root{--accent:${accent}}@media (prefers-color-scheme:dark){:root{--accent:${accentDark}}}</style></head>
<body><main><div class="brand">${logo}${wordmark ? "" : `<span>${esc(name)}</span>`}</div><span class="lock">${LOCK_SVG}</span>
<h1>${title}</h1><p>${lede}</p>${msg}${who}${action}${request}
<a class="back" href="/">Back to ${esc(name)}</a>
<footer>Published with <a href="https://markdrop.in" rel="noopener">Markdrop</a></footer></main></body></html>`;
}

export { b64url, cookie, newState, parseCookies, safeNext, stateHash, validState };
