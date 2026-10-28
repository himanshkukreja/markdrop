#!/usr/bin/env node
/**
 * A throwaway, in-memory stand-in for the workspaces API (specs/workspaces-v2-spec.md and the
 * simpler-UI additions in specs/simpler-ui-spec.md), so the drive, rail, dialogs, Preview as, request
 * access, Shared with me, Recent, ⌘K and the public folder page can be driven and screenshotted in
 * every state before (or without) the real backend. Development only: nothing in the app imports it,
 * and it is only used when NEXT_PUBLIC_API_URL points at it.
 *
 *   node e2e/support/mock-workspaces-api.mjs            # listens on 127.0.0.1:8097 (MOCK_PORT)
 *   NEXT_PUBLIC_API_URL=http://127.0.0.1:8097 npx next dev -p 3157
 *
 * The bearer token picks who you are: "mock-owner" | "mock-admin" | "mock-member" | "mock-viewer"
 * (their role in "Acme Docs"), or "mock-outsider" (Sam Ortiz, signed in, in no workspace: request
 * access). "Senseloaf AI" is a brand-new, empty workspace where everyone is admin (the setup
 * checklist), and "Flaky Co" fails every tree/items call with a 500. State resets on restart; POST
 * /__reset resets it while running. Uploads go to /__put/<key>, held for MOCK_UPLOAD_DELAY ms
 * (default 2500) so the progress list can be seen.
 */
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 8097);
const UPLOAD_DELAY = Number(process.env.MOCK_UPLOAD_DELAY || 2500);
const NOW = Date.now();
const ago = (h) => new Date(NOW - h * 3600_000).toISOString();

/* ── Fixtures ──────────────────────────────────────────────────────────── */

function fixtures() {
  const workspaces = {
    ws_acme: {
      name: "Acme Docs", site_name: "Acme", accent: "#6d5efc", member_count: 9, pending_invite_count: 1, domain_count: 1,
      primary_host: "docs.acme.com",
      settings: { viewer_chrome: "full", require_auth_to_view: false, members_can_share_folders: true, default_access: "workspace" },
    },
    ws_empty: {
      name: "Senseloaf AI", site_name: "Senseloaf", accent: null, member_count: 1, pending_invite_count: 0, domain_count: 0,
      created_h: 2, // made two hours ago: "Get set up" shows only on new workspaces
      primary_host: null,
      settings: { viewer_chrome: "full", require_auth_to_view: false, members_can_share_folders: true, default_access: "workspace" },
    },
    ws_broken: {
      name: "Flaky Co", site_name: null, accent: null, member_count: 3, pending_invite_count: 0, domain_count: 0, primary_host: null,
      settings: { viewer_chrome: "full", require_auth_to_view: false, members_can_share_folders: true, default_access: "workspace" },
    },
  };
  const folders = [
    { id: "f_handbook", ws: "ws_acme", name: "Handbook", slug: "handbook", parent_id: null, share: null, default_access: null },
    { id: "f_policies", ws: "ws_acme", name: "Policies", slug: "policies", parent_id: "f_handbook", share: null, default_access: null },
    { id: "f_roadmaps", ws: "ws_acme", name: "Roadmaps", slug: "roadmaps", parent_id: "f_handbook", share: null, default_access: "private" },
    { id: "f_guides", ws: "ws_acme", name: "Guides", slug: "guides", parent_id: null, share: { id: "gd7Kx2mQpL", level: "link" }, default_access: null },
    { id: "f_onboarding", ws: "ws_acme", name: "Onboarding", slug: "onboarding", parent_id: "f_guides", share: null, default_access: null },
    { id: "f_api", ws: "ws_acme", name: "API reference", slug: "api-reference", parent_id: "f_guides", share: null, default_access: null },
    { id: "f_releases", ws: "ws_acme", name: "Release notes", slug: "release-notes", parent_id: null, share: { id: "rl4Np8sWzA", level: "workspace" }, default_access: "link" },
  ];
  const D = (slug, title, folder, access, owner, extra = {}) => ({
    slug, title, folder, access, owner, kind: "markdown", mime: null, has_password: false, views: Math.floor((slug.length * 37) % 400),
    updated_at: ago((slug.length * 7) % 200), ws: "ws_acme", grantedToMe: false, ...extra,
  });
  const items = [
    D("getting-started", "Getting started with Acme", "f_guides", "link", "me", { views: 155, updated_at: ago(48) }),
    D("brand-kit", "Brand kit", "f_guides", "link", "dana", { kind: "artifact", mime: "image/png", renderer: "image", original_filename: "brand-kit.png", size_bytes: 2_400_000, views: 333, updated_at: ago(72) }),
    D("roadmap-q4", "Q4 roadmap (draft)", "f_guides", "workspace", "me", { views: 41, updated_at: ago(75) }),
    D("product-demo", "Product demo — full cut", "f_guides", "private", "lee", { kind: "artifact", mime: "video/mp4", renderer: "video", original_filename: "demo-full.mp4", size_bytes: 48_000_000, views: 2400, updated_at: ago(170), grantedToMe: true }),
    D("writing-style", "Writing style", "f_guides", "link", "dana", { updated_at: ago(190) }),
    D("press-photos", "Press photos", "f_guides", "link", "dana", { kind: "artifact", mime: "application/zip", renderer: "zip", original_filename: "press.zip", updated_at: ago(700) }),
    D("pricing-notes", "Pricing notes", "f_guides", "link", "me", { has_password: true, updated_at: ago(200) }),
    D("team-rituals", "Team rituals", "f_guides", "workspace", "dana", { updated_at: ago(220) }),
    D("salary-bands", "Salary bands 2026", "f_guides", "private", "lee", { updated_at: ago(30) }),
    D("welcome", "Welcome to the team", "f_onboarding", "workspace", "me"),
    D("laptop-setup", "Laptop setup checklist", "f_onboarding", "link", "lee"),
    D("first-pr", "Your first pull request", "f_onboarding", "workspace", "dana", { has_password: true }),
    D("auth-api", "Authentication API", "f_api", "workspace", "me"),
    D("webhooks", "Webhooks", "f_api", "workspace", "dana"),
    D("rate-limits", "Rate limits", "f_api", "workspace", "lee"),
    D("leave-policy", "Leave policy", "f_policies", "workspace", "lee"),
    D("expenses", "Expenses", "f_policies", "workspace", "me", { kind: "artifact", mime: "text/csv", renderer: "sheet", original_filename: "expenses.csv" }),
    D("roadmap-2027", "Roadmap 2027", "f_roadmaps", "private", "me"),
    D("team-faq", "Team FAQ", null, "workspace", "dana"),
    D("all-hands", "All-hands notes, October", null, "link", "me"),
    D("security-review", "Security review checklist", null, "private", "me"),
    D("board-deck", "Board deck", null, "private", "lee", { grantedToMe: true }),
  ];
  for (let i = 1; i <= 28; i++) {
    const v = `v2.${30 - i}.0`;
    items.push(D(`release-${30 - i}`, `Release ${v}`, "f_releases", i % 5 === 0 ? "workspace" : "link", i % 3 === 0 ? "me" : "dana"));
  }
  const personal = [
    { slug: "getting-started", ws: "ws_acme", folder: "f_guides" },
    { slug: "roadmap-q4", ws: "ws_acme", folder: "f_guides" },
    { slug: "pricing-notes", ws: "ws_acme", folder: "f_guides" },
    { slug: "welcome", ws: "ws_acme", folder: "f_onboarding" },
    { slug: "all-hands", ws: "ws_acme", folder: null },
    { slug: "security-review", ws: "ws_acme", folder: null },
    { slug: "trip-notes", ws: null, folder: null, title: "Trip notes: Lisbon", access: "link" },
    { slug: "resume-2026", ws: null, folder: null, title: "Résumé 2026", access: "private" },
    { slug: "pitch-v3", ws: null, folder: null, title: "Pitch v3", access: "link", kind: "artifact", mime: "text/html", renderer: "html", original_filename: "pitch.html" },
    { slug: "roadmap-review", ws: null, folder: null, title: "Roadmap review notes", access: "private" },
  ];
  // Shared with me by email, outside any workspace I'm in.
  const external = [
    { slug: "partner-pricing", title: "Partner pricing sheet", access: "private", ownerName: "Sam Ortiz", kind: "artifact", mime: "text/csv", renderer: "sheet", original_filename: "pricing.csv", role: "viewer", granted: ago(5), isNew: true },
    { slug: "interview-rubric", title: "Interview rubric", access: "private", ownerName: "Jo Lee", role: "editor", granted: ago(30), isNew: true },
    { slug: "offsite-agenda", title: "Offsite agenda", access: "link", ownerName: "Ravi Shah", role: "viewer", granted: ago(400), isNew: false },
  ];
  const domains = [
    { id: "d1", host: "docs.acme.com", kind: "app", status: "verified", attached: true, is_primary: true, verified_at: ago(400), last_checked_at: ago(3), txt_ok: true, routing_ok: true },
    { id: "d2", host: "help.acme.com", kind: "app", status: "pending", attached: false, is_primary: false, verified_at: null, last_checked_at: ago(1), txt_ok: true, routing_ok: false, last_error: "The routing record isn't there yet. DNS changes can take up to an hour." },
  ];
  const requests = [
    { id: "req_sam", slug: "roadmap-q4", requester_email: "sam@partner.io", requester_name: "Sam Ortiz", message: "Hi Priya, I need this for Thursday's review.", status: "pending", role_granted: null, created_at: ago(0.04), decided_at: null },
    { id: "req_jo", slug: "security-review", requester_email: "jo@contractor.dev", requester_name: "Jo Lee", message: null, status: "pending", role_granted: null, created_at: ago(26), decided_at: null },
    // Sam already asked for this one: the gate shows "pending".
    { id: "req_sam2", slug: "salary-bands", ownerKey: "lee", requester_email: "sam@partner.io", requester_name: "Sam Ortiz", message: null, status: "pending", role_granted: null, created_at: ago(3), decided_at: null },
  ];
  const recent = ["roadmap-q4", "product-demo", "getting-started", "partner-pricing", "trip-notes", "webhooks"];
  return { workspaces, folders, items, personal, external, domains, requests, recent, seq: 1 };
}

let db = fixtures();

const USERS = {
  owner: { id: "u_me", email: "priya@acme.test", name: "Priya Raman" },
  admin: { id: "u_me", email: "avery@acme.test", name: "Avery Admin" },
  member: { id: "u_me", email: "morgan@acme.test", name: "Morgan Member" },
  viewer: { id: "u_me", email: "vic@acme.test", name: "Vic Viewer" },
  outsider: { id: "u_sam", email: "sam@partner.io", name: "Sam Ortiz" },
};
const OWNERS = { dana: "Dana Kim", lee: "Lee Park", me: "Priya Raman" };
const RANK = { outsider: -1, viewer: 0, member: 1, admin: 2, owner: 3 };

function roleFrom(req) {
  const m = /^Bearer mock-(owner|admin|member|viewer|outsider)$/.exec(req.headers.authorization || "");
  return m ? m[1] : null;
}

/** The caller's role in a workspace (null: not a member). */
const roleIn = (role, ws) => {
  if (role === "outsider" || !role) return null;
  return ws === "ws_acme" ? role : ws === "ws_empty" ? "admin" : "member";
};

function wsOut(id, role) {
  const w = db.workspaces[id];
  const r = roleIn(role, id);
  return {
    id, name: w.name, owner_id: r === "owner" ? "u_me" : "u_other", created_at: ago(w.created_h ?? 2000), updated_at: ago(10),
    branding: { site_name: w.site_name, favicon_url: null, logo_url: null, accent_color: w.accent, hide_markdrop_branding: false, logo_well: null },
    settings: { ...w.settings },
    default_access: w.settings.default_access,
    privacy: !w.settings.require_auth_to_view && w.settings.default_access === "link" ? "open"
      : !w.settings.require_auth_to_view && w.settings.default_access === "workspace" ? "team"
        : w.settings.require_auth_to_view && w.settings.default_access === "workspace" ? "locked" : "custom",
    role: r, primary_host: w.primary_host, member_count: w.member_count, pending_invite_count: w.pending_invite_count,
    domain_count: id === "ws_acme" ? db.domains.length : w.domain_count,
    domains: w.primary_host ? [{ host: w.primary_host, verified: true, primary: true, live: true }] : [],
  };
}

const myWorkspaces = (role) => (role === "outsider" ? [] : Object.keys(db.workspaces).map((id) => wsOut(id, role)));

/** Can this caller open this item? (owner, a named grant, or the level admits them) */
function canRead(it, role) {
  if (!role) return it.access === "link" && !db.workspaces[it.ws]?.settings.require_auth_to_view;
  if (role === "outsider") return it.access === "link" && !db.workspaces[it.ws]?.settings.require_auth_to_view;
  if (it.owner === "me" || it.grantedToMe) return true;
  return it.access !== "private";
}

function pathOf(fid) {
  const out = [];
  let f = db.folders.find((x) => x.id === fid);
  let g = 0;
  while (f && g++ < 20) {
    out.unshift(f);
    f = db.folders.find((x) => x.id === f.parent_id);
  }
  return out;
}

function urlOf(it) {
  const fpath = it.folder ? pathOf(it.folder).map((f) => f.slug).join("/") : "";
  const host = db.workspaces[it.ws]?.primary_host;
  return host ? `https://${host}/${fpath ? fpath + "/" : ""}${it.slug}` : `https://markdrop.in/${it.slug}`;
}

function itemOut(it, role) {
  const r = RANK[roleIn(role, it.ws) ?? "outsider"];
  const mine = it.owner === "me";
  const path = it.folder ? pathOf(it.folder) : [];
  const fpath = path.map((f) => f.slug).join("/");
  return {
    id: `id_${it.slug}`, slug: it.slug, title: it.title, kind: it.kind, mime: it.mime, renderer: it.renderer ?? null,
    original_filename: it.original_filename ?? null,
    url: urlOf(it), markdrop_url: `https://markdrop.in/${it.slug}`,
    access: it.access, has_password: it.has_password,
    folder: it.folder ? { id: it.folder, name: path.at(-1)?.name, path: fpath } : null,
    owner: { name: mine ? USERS[role]?.name ?? OWNERS.me : OWNERS[it.owner], is_you: mine },
    size_bytes: it.size_bytes ?? null, updated_at: it.updated_at, views: it.views,
    can: {
      edit: mine || (r >= 1 && it.access !== "private"),
      move: r >= 1 && (mine || it.access !== "private"),
      unshare: mine || r >= 2,
      delete: mine,
      share: mine,
    },
  };
}

function effectiveDefault(f) {
  let cur = f;
  let g = 0;
  while (cur && g++ < 20) {
    if (cur.default_access) return cur.default_access;
    cur = db.folders.find((x) => x.id === cur.parent_id);
  }
  return db.workspaces[f.ws].settings.default_access;
}

function exposureOf(list) {
  const e = { link: 0, workspace: 0, private: 0, password: 0 };
  for (const it of list) {
    e[it.access] += 1;
    if (it.access === "link" && it.has_password) e.password += 1;
  }
  return e;
}

function tree(ws, role) {
  const visible = db.items.filter((i) => i.ws === ws && canRead(i, role));
  const folders = db.folders.filter((f) => f.ws === ws);
  const direct = (fid) => visible.filter((i) => i.folder === fid);
  const total = (fid) => direct(fid).length + folders.filter((f) => f.parent_id === fid).reduce((n, c) => n + total(c.id), 0);
  const w = db.workspaces[ws];
  return {
    workspace: { id: ws, name: w.name, role: roleIn(role, ws), primary_host: w.primary_host, default_access: w.settings.default_access },
    folders: folders.map((f) => {
      const p = pathOf(f.id);
      return {
        id: f.id, name: f.name, slug: f.slug, parent_id: f.parent_id, path: p.map((x) => x.slug).join("/"), depth: p.length,
        item_count: direct(f.id).length, total_count: total(f.id), share: f.share,
        default_access: f.default_access, effective_default_access: effectiveDefault(f), exposure: exposureOf(direct(f.id)),
      };
    }),
    unfiled_count: direct(null).length,
    root_exposure: exposureOf(direct(null)),
  };
}

function subtree(fid) {
  const out = [fid];
  for (const f of db.folders.filter((x) => x.parent_id === fid)) out.push(...subtree(f.id));
  return out;
}

function shareOut(f, role) {
  const ids = subtree(f.id);
  const hidden = f.share.level === "link" ? db.items.filter((i) => ids.includes(i.folder) && (i.access !== "link" || i.has_password)) : [];
  return {
    share_id: f.share.id, url: `https://markdrop.in/f/${f.share.id}`, level: f.share.level,
    hidden_count: hidden.length,
    hidden: hidden.map((i) => ({ slug: i.slug, title: canRead(i, role) ? i.title : "A private item", access: i.access, has_password: i.has_password, is_yours: i.owner === "me" })),
    total_count: db.items.filter((i) => ids.includes(i.folder)).length,
  };
}

/** Preview as: what `as` would see in a folder, and what is hidden from them that the caller can read. */
function preview(ws, folderId, as, email, role) {
  const w = db.workspaces[ws];
  const fid = folderId === "root" ? null : folderId;
  const folder = fid ? db.folders.find((f) => f.id === fid) : null;
  const asMember = as === "member" || (as === "email" && /@acme\.test$/.test(email || ""));
  const sees = (it) => {
    if (asMember) return it.access !== "private";
    if (w.settings.require_auth_to_view) return false;
    return it.access === "link" && !it.has_password;
  };
  const reason = (it) => {
    if (!asMember && w.settings.require_auth_to_view) return "signin";
    if (it.access === "private") return "people";
    if (it.access === "workspace") return "team";
    return "password";
  };
  const here = db.items.filter((i) => i.ws === ws && i.folder === fid);
  const kids = db.folders.filter((f) => f.ws === ws && f.parent_id === fid);
  const visibleItems = here.filter(sees);
  const visibleFolders = [];
  const hidden = [];
  for (const k of kids) {
    const n = db.items.filter((i) => subtree(k.id).includes(i.folder) && sees(i)).length;
    if (n) visibleFolders.push({ id: k.id, name: k.name, path: pathOf(k.id).map((x) => x.slug).join("/"), item_count: n });
    else hidden.push({ slug: null, title: k.name, kind: "folder", mime: null, reason: "folder_empty", yours: false, can_open_up: false, folder_id: k.id });
  }
  const isAdmin = RANK[roleIn(role, ws)] >= 2;
  for (const it of here.filter((i) => !sees(i))) {
    const readable = canRead(it, role);
    if (!readable && !isAdmin) continue; // never shown to someone who can't read it
    const r = readable ? reason(it) : "people";
    hidden.push({
      slug: readable ? it.slug : null, title: readable ? it.title : null, kind: it.kind, mime: readable ? it.mime : null, reason: r,
      yours: it.owner === "me", can_open_up: it.owner === "me" && r !== "password" && r !== "signin" && !asMember, folder_id: null,
    });
  }
  return {
    as, folder: { id: fid, name: folder?.name ?? w.name, path: folder ? pathOf(fid).map((x) => x.slug).join("/") : "" },
    visible: {
      folders: visibleFolders,
      items: visibleItems.map((i) => ({ slug: i.slug, title: i.title, kind: i.kind, mime: i.mime, redacted: false })),
    },
    hidden,
    counts: { visible: visibleItems.length, total: here.length, folders_visible: visibleFolders.length, folders_total: kids.length },
  };
}

function personalOut(p, role) {
  const it = db.items.find((i) => i.slug === p.slug);
  const src = it ?? p;
  return {
    id: `id_${p.slug}`, slug: p.slug, url: `https://markdrop.in/${p.slug}`, title: src.title, content_preview: "",
    created_at: ago(300), updated_at: src.updated_at ?? ago(20), expires_at: null, views: src.views ?? 12,
    export_pdf_count: 0, copy_url_count: 0, is_password_protected: !!src.has_password,
    kind: src.kind ?? "markdown", mime: src.mime ?? null, renderer: src.renderer ?? null, original_filename: src.original_filename ?? null,
    workspace_id: it ? it.ws : null, folder_id: it ? it.folder : null,
    folder_path: it && it.folder ? pathOf(it.folder).map((f) => f.slug) : [],
    access_level: src.access ?? "link", shared_with_count: p.slug === "roadmap-q4" ? 1 : 0, is_mine: true,
  };
}

/** A row of Shared with me / Recent / search, shaped like a workspace item. */
function anyItemOut(slug, role) {
  const it = db.items.find((i) => i.slug === slug);
  if (it) {
    if (!canRead(it, role)) return null;
    const o = itemOut(it, role);
    return { ...o, workspace: { id: it.ws, name: db.workspaces[it.ws].name } };
  }
  const p = db.personal.find((x) => x.slug === slug);
  if (p && role !== "outsider") {
    const o = personalOut(p, role);
    return {
      slug, title: o.title, kind: o.kind, mime: o.mime, renderer: o.renderer, original_filename: o.original_filename,
      url: o.url, markdrop_url: o.url, access: o.access_level, has_password: o.is_password_protected,
      folder: null, owner: { name: USERS[role].name, is_you: true }, updated_at: o.updated_at, views: o.views, workspace: null,
      can: { edit: true, move: false, unshare: false, delete: true, share: true },
    };
  }
  const x = db.external.find((e) => e.slug === slug);
  if (x && role !== "outsider") {
    return {
      slug, title: x.title, kind: x.kind ?? "markdown", mime: x.mime ?? null, renderer: x.renderer ?? null, original_filename: x.original_filename ?? null,
      url: `https://markdrop.in/${slug}`, markdrop_url: `https://markdrop.in/${slug}`, access: x.access, has_password: false,
      folder: null, owner: { name: x.ownerName, is_you: false }, updated_at: x.granted, views: 9, workspace: null,
      can: { edit: x.role === "editor", move: false, unshare: false, delete: false, share: false },
    };
  }
  return null;
}

function requestOut(r) {
  const it = db.items.find((i) => i.slug === r.slug) ?? db.personal.find((p) => p.slug === r.slug);
  return {
    id: r.id, status: r.status, message: r.message, created_at: r.created_at, decided_at: r.decided_at, role_granted: r.role_granted,
    requester: { email: r.requester_email, name: r.requester_name },
    document: {
      slug: r.slug, title: it?.title ?? r.slug, kind: it?.kind ?? "markdown", encrypted: false,
      access: it?.access ?? "private", url: it?.ws ? urlOf(it) : `https://markdrop.in/${r.slug}`,
    },
  };
}

/* ── Server ────────────────────────────────────────────────────────────── */

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, x-edit-secret, x-read-password, x-markdrop-workspace",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Expose-Headers": "X-Markdrop-Gate, Retry-After",
    ...headers,
  });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}

const readBody = (req) =>
  new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
  });

const drain = (req) => new Promise((resolve) => { req.on("data", () => {}); req.on("end", resolve); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slugify = (s) => String(s || "file").toLowerCase().replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "file";

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204);
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const role = roleFrom(req);

  // Presigned "R2" upload: hold it a while so the progress list can be seen.
  if (p.startsWith("/__put/")) {
    await drain(req);
    await sleep(UPLOAD_DELAY);
    return send(res, 200, {});
  }

  const body = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) ? await readBody(req) : {};
  const m = (re) => p.match(re);
  let mm;

  if (p === "/__reset") { db = fixtures(); return send(res, 200, { ok: true }); }
  if (p === "/health") return send(res, 200, { ok: true });

  // Public routes first.
  if ((mm = m(/^\/api\/v1\/folders\/shared\/([^/]+)$/))) {
    const f = db.folders.find((x) => x.share?.id === mm[1]);
    if (!f) return send(res, 404, { detail: "Not found" });
    if (f.share.level === "workspace" && !role) return send(res, 401, { detail: "Sign in to see this folder" }, { "X-Markdrop-Gate": "signin" });
    const sub = (url.searchParams.get("path") || "").split("/").filter(Boolean);
    let cur = f;
    for (const seg of sub) {
      cur = db.folders.find((x) => x.parent_id === cur.id && x.slug === seg);
      if (!cur) return send(res, 404, { detail: "Not found" });
    }
    const rel = (fid) => { const all = pathOf(fid); const i = all.findIndex((x) => x.id === f.id); return all.slice(i + 1).map((x) => x.slug).join("/"); };
    const readable = (i) => canRead(i, role);
    const crumbs = pathOf(cur.id);
    const start = crumbs.findIndex((x) => x.id === f.id);
    return send(res, 200, {
      workspace: { name: "Acme Docs", branding: { accent_color: "#6d5efc", logo_url: null } },
      folder: { name: cur.name, path: rel(cur.id), breadcrumbs: crumbs.slice(start).map((x) => ({ name: x.name, path: rel(x.id) })) },
      subfolders: db.folders.filter((x) => x.parent_id === cur.id).map((x) => ({
        name: x.name, path: rel(x.id), count: db.items.filter((i) => subtree(x.id).includes(i.folder) && readable(i)).length,
      })).filter((x) => x.count > 0 || role),
      items: db.items.filter((i) => i.folder === cur.id && readable(i)).map((i) => ({
        slug: i.slug, title: i.title, kind: i.kind, mime: i.mime, url: urlOf(i), size_bytes: i.size_bytes ?? null, updated_at: i.updated_at, poster_url: null,
      })),
    });
  }

  if ((mm = m(/^\/api\/v1\/documents\/([^/]+)$/)) && req.method === "GET") {
    if (mm[1] === "old-getting-started") {
      return send(res, 200, { moved: true, slug: "getting-started", url: "https://markdrop.in/getting-started", workspace_url: "https://docs.acme.com/guides/getting-started", folder_path: ["guides"] }, { "X-Markdrop-Moved": "getting-started" });
    }
    const it = db.items.find((i) => i.slug === mm[1]);
    const per = db.personal.find((x) => x.slug === mm[1]) ?? db.external.find((x) => x.slug === mm[1]);
    if (!it && !per) return send(res, 404, { detail: "Document not found" });
    if (it && !canRead(it, role)) {
      // Like the API: a stranger is asked to sign in; a signed-in reader without access gets the same
      // 404 as a missing document (whether they may ask comes from …/access-requests/mine).
      if (!role) return send(res, 401, { detail: "Sign in to view this document." }, { "X-Markdrop-Gate": "signin" });
      return send(res, 404, { detail: "Document not found" });
    }
    const src = it ?? per;
    if (role && src.slug && !db.recent.includes(src.slug)) db.recent.unshift(src.slug);
    const content = `# ${src.title}\n\nThis is a mock document used to preview the workspace UI.\n\n- One\n- Two\n`;
    return send(res, 200, {
      slug: src.slug, url: `https://markdrop.in/${src.slug}`, title: src.title, content, created_at: ago(100), updated_at: ago(2),
      expires_at: null, views: 3, is_password_protected: false, is_owner: role ? it?.owner === "me" : false, kind: "markdown",
      folder_path: it?.folder ? pathOf(it.folder).map((f) => f.slug) : [], access_level: src.access, workspace_id: it?.ws ?? null,
    });
  }

  if (!role) return send(res, 401, { detail: "Not signed in" });
  const user = USERS[role];

  if (p === "/api/v1/auth/me") return send(res, 200, { ...user, picture: null, providers: ["email"], created_at: ago(5000) });
  if (p === "/api/v1/me/tokens") return send(res, 200, { tokens: [] });
  if (p === "/api/v1/me/contacts") return send(res, 200, { contacts: [{ email: "dana@acme.test", name: "Dana Kim", source: "workspace" }] });
  if (p === "/api/v1/google/status") return send(res, 200, { configured: false, connected: false });
  if (p === "/api/v1/artifacts/status") return send(res, 200, { configured: true, origin_isolated: true, origin_separate_site: true, max_file_bytes: 50e6, quota_bytes: 1e9, used_bytes: 1e8, accepted_types: [] });
  if (p === "/api/v1/me/documents") {
    if (role === "outsider") return send(res, 200, { documents: [], total: 0, page: 1, pages: 1, count_all: 0, count_markdown: 0, count_artifact: 0 });
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const list = db.personal.map((x) => personalOut(x, role)).filter((d) => !q || d.title.toLowerCase().includes(q) || d.slug.includes(q));
    const kind = url.searchParams.get("kind");
    const shown = kind ? list.filter((d) => d.kind === kind) : list;
    return send(res, 200, {
      documents: shown, total: shown.length, page: 1, pages: 1,
      count_all: list.length, count_markdown: list.filter((d) => d.kind === "markdown").length, count_artifact: list.filter((d) => d.kind === "artifact").length,
    });
  }

  /* ── Simpler UI: Shared with me, Recent, quick search, access requests ── */
  if (p === "/api/v1/me/shared") {
    if (role === "outsider") return send(res, 200, { items: [], next_cursor: null, new_count: 0 });
    const granted = db.items.filter((i) => i.grantedToMe && i.owner !== "me").map((i) => ({ ...anyItemOut(i.slug, role), role: "viewer", granted_at: ago(i.slug === "product-demo" ? 2 : 50), new: i.slug === "product-demo", opened: i.slug !== "product-demo" }));
    const ext = db.external.map((x) => ({ ...anyItemOut(x.slug, role), role: x.role, granted_at: x.granted, new: x.isNew, opened: !x.isNew }));
    const items = [...granted, ...ext].sort((a, b) => b.granted_at.localeCompare(a.granted_at));
    return send(res, 200, { items, next_cursor: null, new_count: items.filter((i) => i.new).length });
  }
  if (p === "/api/v1/me/recent") {
    const items = db.recent.map((s, i) => { const o = anyItemOut(s, role); return o ? { ...o, viewed_at: ago(i * 5 + 0.2) } : null; }).filter(Boolean);
    return send(res, 200, { items });
  }
  if (p === "/api/v1/search/quick") {
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    if (q.length < 2) return send(res, 200, { files: [], folders: [], workspaces: [] });
    const limit = Number(url.searchParams.get("limit") || 8);
    const slugs = [...new Set([...db.items.map((i) => i.slug), ...db.personal.map((x) => x.slug), ...db.external.map((x) => x.slug)])];
    const files = [];
    for (const s of slugs) {
      const o = anyItemOut(s, role);
      if (!o || !(o.title || "").toLowerCase().includes(q)) continue;
      const it = db.items.find((i) => i.slug === s);
      files.push({
        slug: s, title: o.title, kind: o.kind, mime: o.mime, url: o.url, access: o.access,
        workspace: o.workspace ?? null, folder: it?.folder ? { id: it.folder, name: pathOf(it.folder).at(-1).name } : null,
        source: it ? "workspace" : db.external.some((x) => x.slug === s) ? "shared" : "mine",
      });
    }
    files.sort((a, b) => (a.source === "workspace" ? -1 : 0) - (b.source === "workspace" ? -1 : 0));
    const folders = role === "outsider" ? [] : db.folders.filter((f) => f.name.toLowerCase().includes(q)).map((f) => ({
      id: f.id, name: f.name, path: pathOf(f.id).map((x) => x.slug).join("/"), workspace: { id: f.ws, name: db.workspaces[f.ws].name },
    }));
    const wss = myWorkspaces(role).filter((w) => w.name.toLowerCase().includes(q)).map((w) => ({ id: w.id, name: w.name, role: w.role }));
    return send(res, 200, { files: files.slice(0, limit), folders: folders.slice(0, limit), workspaces: wss.slice(0, limit) });
  }
  if ((mm = m(/^\/api\/v1\/documents\/([^/]+)\/access-requests\/mine$/))) {
    const it = db.items.find((i) => i.slug === mm[1]);
    if (!it) return send(res, 404, { detail: "Document not found" });
    const latest = [...db.requests].reverse().find((r) => r.slug === it.slug && r.requester_email === user.email);
    const eligible = !canRead(it, role) && !it.has_password;
    return send(res, 200, {
      can_request_access: eligible && latest?.status !== "pending",
      request_pending: latest?.status === "pending",
      request: latest ? { id: latest.id, status: latest.status, created_at: latest.created_at, decided_at: latest.decided_at } : null,
    });
  }
  if ((mm = m(/^\/api\/v1\/documents\/([^/]+)\/access-requests$/)) && req.method === "POST") {
    const it = db.items.find((i) => i.slug === mm[1]);
    if (!it) return send(res, 404, { detail: "Document not found" });
    if (canRead(it, role)) return send(res, 409, { detail: "You can already open it." });
    if (db.requests.some((r) => r.slug === it.slug && r.status === "pending" && r.requester_email === user.email)) {
      return send(res, 409, { detail: "You've already asked for this." });
    }
    const r = { id: `req_${db.seq++}`, slug: it.slug, requester_email: user.email, requester_name: user.name, message: body.message ?? null, status: "pending", role_granted: null, created_at: new Date().toISOString(), decided_at: null };
    db.requests.push(r);
    return send(res, 201, { id: r.id, status: r.status });
  }
  const ownedRequests = () => db.requests.filter((r) => {
    const it = db.items.find((i) => i.slug === r.slug) ?? db.personal.find((x) => x.slug === r.slug);
    return role !== "outsider" && (it?.owner ?? "me") === "me" && !r.ownerKey;
  });
  if (p === "/api/v1/me/access-requests") {
    const status = url.searchParams.get("status") || "pending";
    const mine = ownedRequests();
    return send(res, 200, {
      requests: mine.filter((r) => status === "all" || r.status === status).map(requestOut),
      pending_count: mine.filter((r) => r.status === "pending").length,
    });
  }
  if ((mm = m(/^\/api\/v1\/access-requests\/([^/]+)$/)) && req.method === "GET") {
    const r = ownedRequests().find((x) => x.id === mm[1]);
    return r ? send(res, 200, requestOut(r)) : send(res, 404, { detail: "Request not found" });
  }
  if ((mm = m(/^\/api\/v1\/access-requests\/([^/]+)\/decision$/)) && req.method === "POST") {
    const r = ownedRequests().find((x) => x.id === mm[1]);
    if (!r) return send(res, 404, { detail: "Request not found" });
    const want = body.decision === "decline" ? "declined" : "approved";
    const role_granted = body.decision === "edit" ? "editor" : body.decision === "view" ? "viewer" : null;
    if (r.status !== "pending" && (r.status !== want || r.role_granted !== role_granted)) {
      return send(res, 409, { detail: "This request was already answered." });
    }
    if (r.status === "pending") {
      r.status = want;
      r.role_granted = role_granted;
      r.decided_at = new Date().toISOString();
    }
    return send(res, 200, { id: r.id, status: r.status, role_granted: r.role_granted, decided_at: r.decided_at });
  }

  /* ── Creating (drop to upload) ── */
  if (p === "/api/v1/artifacts/upload-url" && req.method === "POST") {
    const key = `k${db.seq++}`;
    return send(res, 200, { upload_url: `http://127.0.0.1:${PORT}/__put/${key}`, blob_key: key, required_content_type: body.content_type || "application/octet-stream", _filename: body.filename });
  }
  if ((p === "/api/v1/artifacts" || p === "/api/v1/documents") && req.method === "POST") {
    const isDoc = p === "/api/v1/documents";
    const base = slugify(isDoc ? body.title : body.filename || body.title);
    let slug = base;
    while (db.personal.some((x) => x.slug === slug) || db.items.some((x) => x.slug === slug)) slug = `${base}-${db.seq++}`;
    const title = body.title || body.filename || slug;
    const ext = (body.filename || "").split(".").pop().toLowerCase();
    const mime = isDoc ? null : ext === "pdf" ? "application/pdf" : ext === "mp4" ? "video/mp4" : ext === "png" ? "image/png" : "application/octet-stream";
    const renderer = isDoc ? null : ext === "pdf" ? "pdf" : ext === "mp4" ? "video" : ext === "png" ? "image" : null;
    // Created straight into a workspace folder: with no access_level, the folder's effective default.
    const wsId = body.workspace && db.workspaces[body.workspace] && roleIn(role, body.workspace) ? body.workspace : null;
    const folder = wsId && body.folder ? db.folders.find((f) => f.ws === wsId && (f.id === body.folder || pathOf(f.id).map((x) => x.slug).join("/") === body.folder)) : null;
    const access = body.access_level ?? (wsId ? (folder ? effectiveDefault(folder) : db.workspaces[wsId].settings.default_access) : "link");
    const workspace_error = body.workspace && !wsId ? "You're not in that workspace." : body.folder && wsId && !folder ? "That folder isn't there any more." : null;
    db.personal.unshift({ slug, ws: null, folder: null, title, access, kind: isDoc ? "markdown" : "artifact", mime, renderer, original_filename: body.filename ?? null });
    if (wsId && !workspace_error) {
      db.items.push({
        slug, title, folder: folder?.id ?? null, access, owner: "me", kind: isDoc ? "markdown" : "artifact", mime, renderer,
        original_filename: body.filename ?? null, has_password: false, views: 0, updated_at: new Date().toISOString(), ws: wsId, grantedToMe: false,
      });
      db.personal[0].ws = wsId;
      db.personal[0].folder = folder?.id ?? null;
    }
    return send(res, 201, {
      workspace_error,
      slug, id: `id_${slug}`, url: `https://markdrop.in/${slug}`, title, content: "", created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      expires_at: null, views: 0, is_password_protected: false, edit_secret: "mock-secret", artifact_url: null, mime, renderer, kind: isDoc ? "markdown" : "artifact",
    });
  }
  if ((mm = m(/^\/api\/v1\/artifacts\/([^/]+)$/)) && req.method === "PATCH") {
    const it = db.items.find((i) => i.slug === mm[1]);
    if (it && body.title) it.title = body.title;
    if (it && body.read_password) it.has_password = true;
    if (it && body.remove_password) it.has_password = false;
    return send(res, 200, { slug: mm[1], title: it?.title ?? body.title });
  }

  if ((mm = m(/^\/api\/v1\/documents\/([^/]+)\/access$/))) {
    const it = db.items.find((i) => i.slug === mm[1]);
    const per = db.personal.find((x) => x.slug === mm[1]);
    if (!it && !per) return send(res, 404, { detail: "Document not found" });
    const mine = it ? it.owner === "me" : true;
    return send(res, 200, {
      level: it ? it.access : per.access ?? "link", allow_resharing: false, is_password_protected: !!(it ?? per)?.has_password, encrypted: false,
      in_workspace: !!it, workspace_id: it ? it.ws : null, workspace_name: it ? db.workspaces[it.ws].name : null, folder_id: it ? it.folder : null,
      your_role: mine ? "owner" : RANK[role] >= 1 ? "editor" : "viewer",
      owner_name: mine ? user.name : OWNERS[it.owner], owner_email: mine ? user.email : `${it.owner}@acme.test`,
      your_email: user.email, can_manage: mine, can_share: mine,
      grants: mine && it?.slug === "roadmap-q4" ? [{ email: "sam@partner.io", role: "viewer", created_at: ago(30), granted_by_email: user.email, notified: true }] : [],
      url: `https://markdrop.in/${mm[1]}`, workspace_url: it && db.workspaces[it.ws]?.primary_host ? urlOf(it) : null,
      expires_at: (it ?? per).expires_at ?? null,
    });
  }
  // Password and expiry (share dialog "More options"): owner only, like can(edit_settings).
  if ((mm = m(/^\/api\/v1\/documents\/([^/]+)\/settings$/)) && req.method === "PATCH") {
    const it = db.items.find((i) => i.slug === mm[1]) ?? db.personal.find((x) => x.slug === mm[1]);
    if (!it) return send(res, 404, { detail: "Document not found" });
    if (!user) return send(res, 401, { detail: "Sign in to do that." });
    if ((it.owner ?? "me") !== "me") return send(res, 403, { detail: "Only the document's owner can change its password or expiry." });
    const HOURS = { "1h": 1, "1d": 24, "7d": 168, "30d": 720 };
    if (body.expires_in === "custom" || (!body.expires_in && body.custom_expires_at)) {
      const at = Date.parse(body.custom_expires_at ?? "");
      if (!at) return send(res, 422, { detail: "Choose a date for the custom expiry." });
      if (at < Date.now() + 60_000) return send(res, 422, { detail: "The expiry date must be in the future." });
      it.expires_at = new Date(at).toISOString();
    } else if (body.expires_in === "never") it.expires_at = null;
    else if (HOURS[body.expires_in]) it.expires_at = new Date(Date.now() + HOURS[body.expires_in] * 3600_000).toISOString();
    if (body.remove_password || body.read_password === "") it.has_password = false;
    else if (body.read_password) it.has_password = true;
    return send(res, 200, { slug: it.slug, title: it.title, is_password_protected: !!it.has_password, expires_at: it.expires_at ?? null });
  }
  if (p === "/api/v1/documents/access/level" && req.method === "POST") {
    const results = (body.slugs ?? []).map((slug) => {
      const it = db.items.find((i) => i.slug === slug);
      if (it && it.owner !== "me") return { slug, ok: false, error: "Only the owner can change who can open it.", status: 403 };
      if (it) it.access = body.level;
      return { slug, ok: true };
    });
    return send(res, 200, { results });
  }
  if ((mm = m(/^\/api\/v1\/documents\/([^/]+)\/access\/level$/)) && req.method === "PUT") {
    const it = db.items.find((i) => i.slug === mm[1]);
    if (it) {
      if (it.owner !== "me") return send(res, 403, { detail: "Only the owner can change who can open it." });
      it.access = body.level;
    } else {
      const per = db.personal.find((x) => x.slug === mm[1]);
      if (per) per.access = body.level;
    }
    return send(res, 204);
  }

  if (p === "/api/v1/workspaces" && req.method === "GET") return send(res, 200, { workspaces: myWorkspaces(role) });

  if ((mm = m(/^\/api\/v1\/workspaces\/([^/]+)(\/.*)?$/))) {
    const ws = mm[1];
    const rest = mm[2] || "";
    const w = db.workspaces[ws];
    const r = roleIn(role, ws);
    if (!w || !r) return send(res, 404, { detail: "Workspace not found" });
    if (ws === "ws_broken" && /^\/(tree|items)/.test(rest)) return send(res, 500, { detail: "The database didn't answer in time." });
    if (rest === "" && req.method === "PUT") {
      if (RANK[r] < 2) return send(res, 403, { detail: "Admins only" });
      if (body.name) w.name = body.name;
      if (body.branding) { w.site_name = body.branding.site_name ?? null; w.accent = body.branding.accent_color ?? null; }
      if (body.settings) w.settings = { ...w.settings, ...body.settings };
      return send(res, 200, wsOut(ws, role));
    }
    if (rest === "") return send(res, 200, wsOut(ws, role));
    if (rest === "/tree") return send(res, 200, tree(ws, role));
    if (rest === "/preview") {
      if (RANK[r] < 1) return send(res, 403, { detail: "Members only" });
      const as = url.searchParams.get("as") || "anyone";
      if (as === "email" && RANK[r] < 2) return send(res, 403, { detail: "Admins only" });
      return send(res, 200, preview(ws, url.searchParams.get("folder") || "root", as, url.searchParams.get("email"), role));
    }
    if (rest === "/items") {
      const folder = url.searchParams.get("folder") || "root";
      const q = (url.searchParams.get("q") || "").toLowerCase();
      const kind = url.searchParams.get("kind");
      let list = db.items.filter((i) => i.ws === ws && canRead(i, role));
      if (folder === "root" || folder === "unfiled") list = list.filter((i) => !i.folder);
      else if (folder !== "all") list = list.filter((i) => i.folder === folder);
      if (q) list = list.filter((i) => i.title.toLowerCase().includes(q) || i.slug.includes(q));
      if (kind) list = list.filter((i) => i.kind === kind);
      list = [...list].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      const limit = Math.min(Number(url.searchParams.get("limit") || 50), 100);
      const start = Number(url.searchParams.get("cursor") || 0);
      const page = list.slice(start, start + Math.min(limit, 20));
      const next = start + page.length < list.length ? String(start + page.length) : null;
      // Admins also get placeholders for other people's private documents filed here.
      let hiddenRows = [];
      if (RANK[r] >= 2 && start === 0 && !q) {
        let hidden = db.items.filter((i) => i.ws === ws && !canRead(i, role));
        if (folder === "root" || folder === "unfiled") hidden = hidden.filter((i) => !i.folder);
        else if (folder !== "all") hidden = hidden.filter((i) => i.folder === folder);
        hiddenRows = hidden.map((i) => ({
          redacted: true, slug: null, title: null, url: null, id_token: `tok_${i.slug}`, owner: { name: OWNERS[i.owner] },
          folder: i.folder ? { id: i.folder, name: pathOf(i.folder).at(-1)?.name, path: pathOf(i.folder).map((f) => f.slug).join("/") } : null,
          updated_at: i.updated_at, can: { unshare: true, edit: false, move: false, delete: false, share: false },
        }));
      }
      return send(res, 200, { items: [...page.map((i) => itemOut(i, role)), ...hiddenRows], next_cursor: next });
    }
    if (rest === "/folders" && req.method === "GET") {
      return send(res, 200, { folders: db.folders.filter((f) => f.ws === ws).map((f) => ({ id: f.id, workspace_id: ws, name: f.name, parent_id: f.parent_id, slug: f.slug, path: pathOf(f.id).map((x) => x.slug), created_at: ago(100), updated_at: ago(10) })) });
    }
    if (rest === "/folders" && req.method === "POST") {
      if (RANK[r] < 1) return send(res, 403, { detail: "Members and admins only" });
      const f = { id: `f_new${db.seq++}`, ws, name: body.name, slug: body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), parent_id: body.parent_id ?? null, share: null, default_access: null };
      db.folders.push(f);
      return send(res, 201, { id: f.id, workspace_id: ws, name: f.name, parent_id: f.parent_id, slug: f.slug, path: pathOf(f.id).map((x) => x.slug), created_at: ago(0), updated_at: ago(0) });
    }
    if ((mm = rest.match(/^\/folders\/([^/]+)\/share$/))) {
      const f = db.folders.find((x) => x.id === mm[1]);
      if (!f) return send(res, 404, { detail: "Folder not found" });
      if (req.method === "GET") return f.share ? send(res, 200, shareOut(f, role)) : send(res, 404, { detail: "This folder isn't shared." });
      if (RANK[r] < 1) return send(res, 403, { detail: "Only admins can share folders" });
      if (req.method === "DELETE") { f.share = null; return send(res, 204); }
      f.share = { id: f.share?.id ?? `sh${db.seq++}x9Kq2`, level: body.level };
      return send(res, 200, shareOut(f, role));
    }
    if ((mm = rest.match(/^\/folders\/([^/]+)$/))) {
      const f = db.folders.find((x) => x.id === mm[1]);
      if (!f) return send(res, 404, { detail: "Folder not found" });
      if (RANK[r] < 2) return send(res, 403, { detail: "Admins only" });
      if (req.method === "PATCH") {
        if (body.name) { f.name = body.name; f.slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"); }
        if ("parent_id" in body) {
          if (body.parent_id && subtree(f.id).includes(body.parent_id)) return send(res, 400, { detail: "A folder can't go inside itself." });
          f.parent_id = body.parent_id;
        }
        if ("default_access" in body) f.default_access = body.default_access;
        return send(res, 200, tree(ws, role).folders.find((x) => x.id === f.id));
      }
      if (req.method === "DELETE") {
        const mode = url.searchParams.get("mode") || "unfile";
        const n = db.items.filter((i) => i.folder === f.id).length;
        for (const i of db.items) if (i.folder === f.id) i.folder = mode === "move_up" ? f.parent_id : null;
        for (const c of db.folders) if (c.parent_id === f.id) c.parent_id = f.parent_id;
        db.folders = db.folders.filter((x) => x.id !== f.id);
        return send(res, 200, { unfiled_documents: n });
      }
    }
    if (rest === "/items/move") {
      if (RANK[r] < 1) return send(res, 403, { detail: "Members only" });
      const moved = [];
      for (const s of body.slugs || []) {
        const it = db.items.find((i) => i.slug === s && i.ws === ws);
        if (it && canRead(it, role)) { it.folder = body.folder_id ?? null; moved.push(itemOut(it, role)); }
      }
      return send(res, 200, { items: moved });
    }
    if (rest === "/items/add") {
      const out = [];
      for (const s of body.slugs || []) {
        const per = db.personal.find((x) => x.slug === s);
        if (!per) continue;
        let it = db.items.find((i) => i.slug === s);
        if (!it) {
          it = {
            slug: s, title: per.title, folder: body.folder_id ?? null, access: body.access ?? per.access ?? "link", owner: "me", kind: per.kind ?? "markdown",
            mime: per.mime ?? null, renderer: per.renderer ?? null, original_filename: per.original_filename ?? null, has_password: false, views: 0,
            updated_at: new Date().toISOString(), ws, grantedToMe: false,
          };
          db.items.push(it);
        } else {
          it.ws = ws; it.folder = body.folder_id ?? null; if (body.access) it.access = body.access;
        }
        per.ws = ws; per.folder = it.folder;
        out.push(itemOut(it, role));
      }
      return send(res, 200, { items: out });
    }
    if (rest === "/items/remove") {
      const out = [];
      for (const h of body.handles || []) {
        if (RANK[r] < 2) return send(res, 403, { detail: "Admins only" });
        const s = String(h).replace(/^tok_/, "");
        db.items = db.items.filter((x) => x.slug !== s);
        out.push({ slug: null, access_after: "private" });
      }
      for (const s of body.slugs || []) {
        const it = db.items.find((i) => i.slug === s && i.ws === ws);
        if (!it) continue;
        if (!(it.owner === "me" || RANK[r] >= 2)) return send(res, 403, { detail: "Only the owner or an admin can remove it." });
        const after = it.access === "workspace" ? "private" : it.access;
        db.items = db.items.filter((x) => x !== it);
        const per = db.personal.find((x) => x.slug === s);
        if (per) { per.ws = null; per.folder = null; per.title = it.title; per.access = after; }
        out.push({ slug: s, access_after: after });
      }
      return send(res, 200, { items: out });
    }
    if (rest === "/documents/counts") return send(res, 200, {});
    if (rest === "/members") {
      if (ws === "ws_empty") return send(res, 200, { members: [{ user_id: "u_me", role: "owner", email: user.email, name: user.name, created_at: ago(1) }] });
      const meRole = r;
      const others = [
        { user_id: "u_priya", role: "owner", email: "priya@acme.test", name: "Priya Raman" },
        { user_id: "u_dana", role: "admin", email: "dana@acme.test", name: "Dana Kim" },
        { user_id: "u_lee", role: "member", email: "lee@acme.test", name: "Lee Park" },
        { user_id: "u_sam", role: "viewer", email: "sam@partner.io", name: "Sam Ortiz" },
      ];
      const members = role === "owner"
        ? [{ user_id: "u_me", role: "owner", email: user.email, name: user.name, created_at: ago(900) }, ...others.slice(1)]
        : [{ user_id: "u_me", role: meRole, email: user.email, name: user.name, created_at: ago(900) }, ...others];
      return send(res, 200, { members: members.map((x) => ({ created_at: ago(800), ...x })) });
    }
    if (rest === "/invitations" && req.method === "GET") {
      if (RANK[r] < 2) return send(res, 403, { detail: "Admins only" });
      if (ws === "ws_empty") return send(res, 200, { invitations: [] });
      return send(res, 200, { invitations: [{ id: "inv1", email: "maya@acme.test", role: "member", status: "pending", created_at: ago(50), expires_at: ago(-120), invited_by_name: "Priya Raman", responded_at: null }] });
    }
    if (rest === "/invitations" && req.method === "POST") {
      if (RANK[r] < 2) return send(res, 403, { detail: "Admins only" });
      w.pending_invite_count += 1;
      return send(res, 201, { id: `inv${db.seq++}`, email: body.email, role: body.role, status: "pending", created_at: ago(0), expires_at: ago(-168), invited_by_name: user.name, responded_at: null });
    }
    if (rest === "/domains" && req.method === "GET") {
      return send(res, 200, { domains: (ws === "ws_acme" ? db.domains : []).map((d) => ({
        created_at: ago(500), last_error: null, warning: null,
        dns_record_name: `_markdrop-challenge.${d.host}`, dns_record_type: "TXT", dns_record_value: "md-verify=7f3a9c1e5b2d4086",
        dns_target_name: d.host, dns_target_type: "CNAME", dns_target_value: "edge.markdrop.in",
        live: d.status === "verified" && d.attached,
        ...d,
      })) });
    }
    if (rest === "/domains" && req.method === "POST") {
      if (body.host === "bad.example") return send(res, 501, { detail: "Not implemented" });
      const d = { id: `d${db.seq++}`, host: body.host, kind: body.kind, status: "pending", attached: false, is_primary: false, verified_at: null, last_checked_at: null, txt_ok: false, routing_ok: false };
      db.domains.push(d);
      return send(res, 201, d);
    }
    if ((mm = rest.match(/^\/domains\/([^/]+)\/(verify|attach|detach|primary|provider)$/))) {
      const d = db.domains.find((x) => x.id === mm[1]);
      if (!d) return send(res, 404, { detail: "Domain not found" });
      if (mm[2] === "provider") return send(res, 200, { detected: true, provider_id: "cloudflare", provider_name: "Cloudflare", panel_url: "https://dash.cloudflare.com", host_field: "Name", record_host: "_markdrop-challenge.help", target_host: "help", note: null, nameservers: [] });
      if (mm[2] === "verify") { d.last_checked_at = new Date().toISOString(); if (d.host.startsWith("help")) { d.routing_ok = true; d.status = "verified"; d.verified_at = d.last_checked_at; d.last_error = null; } }
      if (mm[2] === "attach") d.attached = true;
      if (mm[2] === "detach") d.attached = false;
      if (mm[2] === "primary") { for (const x of db.domains) x.is_primary = x.id === d.id; return send(res, 204); }
      return send(res, 200, { created_at: ago(500), last_error: null, warning: null, dns_record_name: `_markdrop-challenge.${d.host}`, dns_record_type: "TXT", dns_record_value: "md-verify=7f3a9c1e5b2d4086", dns_target_name: d.host, dns_target_type: "CNAME", dns_target_value: "edge.markdrop.in", ...d });
    }
    return send(res, 404, { detail: `Mock has no ${req.method} ${p}` });
  }

  return send(res, 404, { detail: `Mock has no ${req.method} ${p}` });
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock workspaces API on http://127.0.0.1:${PORT}`));
