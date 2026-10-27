#!/usr/bin/env node
/**
 * A throwaway, in-memory stand-in for the workspaces v2 API (specs/workspaces-v2-spec.md), so the
 * folder view, rail, dialogs and public folder page can be driven and screenshotted in every state
 * before the real backend lands. Development only: nothing in the app imports it, and it is only
 * used when NEXT_PUBLIC_API_URL points at it.
 *
 *   node e2e/support/mock-workspaces-api.mjs            # listens on 127.0.0.1:8097 (MOCK_PORT)
 *   NEXT_PUBLIC_API_URL=http://127.0.0.1:8097 npx next dev -p 3157
 *
 * The bearer token picks who you are: "mock-owner" | "mock-admin" | "mock-member" | "mock-viewer".
 * The role applies to the "Acme Docs" workspace; "Side Project" (empty) is always admin and
 * "Flaky Co" fails every tree/items call with a 500. State resets on restart; POST /__reset resets
 * it while running.
 */
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 8097);
const NOW = Date.now();
const ago = (h) => new Date(NOW - h * 3600_000).toISOString();

/* ── Fixtures ──────────────────────────────────────────────────────────── */

function fixtures() {
  const folders = [
    { id: "f_guides", ws: "ws_acme", name: "Guides", slug: "guides", parent_id: null, share: { id: "gd7Kx2mQpL", level: "link" } },
    { id: "f_onboarding", ws: "ws_acme", name: "Onboarding", slug: "onboarding", parent_id: "f_guides", share: null },
    { id: "f_week1", ws: "ws_acme", name: "Week one", slug: "week-one", parent_id: "f_onboarding", share: null },
    { id: "f_api", ws: "ws_acme", name: "API reference", slug: "api-reference", parent_id: "f_guides", share: null },
    { id: "f_handbook", ws: "ws_acme", name: "Handbook", slug: "handbook", parent_id: null, share: null },
    { id: "f_policies", ws: "ws_acme", name: "Policies", slug: "policies", parent_id: "f_handbook", share: null },
    { id: "f_releases", ws: "ws_acme", name: "Release notes", slug: "release-notes", parent_id: null, share: { id: "rl4Np8sWzA", level: "workspace" } },
    { id: "f_videos", ws: "ws_acme", name: "Sia videos", slug: "sia-videos", parent_id: null, share: null },
    { id: "f_empty", ws: "ws_acme", name: "Drafts", slug: "drafts", parent_id: null, share: null },
  ];
  const D = (slug, title, folder, access, owner, extra = {}) => ({
    slug, title, folder, access, owner, kind: "markdown", mime: null, has_password: false, views: Math.floor(slug.length * 37 % 400),
    updated_at: ago((slug.length * 7) % 200), ws: "ws_acme", ...extra,
  });
  const items = [
    D("getting-started", "Getting started with Acme", "f_guides", "link", "me"),
    D("style-guide", "Writing style guide", "f_guides", "workspace", "dana"),
    D("roadmap-q4", "Q4 roadmap (draft)", "f_guides", "private", "me"),
    D("salary-bands", "Salary bands 2026", "f_guides", "private", "lee"),
    D("brand-kit", "Brand kit", "f_guides", "link", "dana", { kind: "artifact", mime: "application/pdf", renderer: "pdf", original_filename: "brand-kit.pdf", size_bytes: 2_400_000 }),
    D("welcome", "Welcome to the team", "f_onboarding", "workspace", "me"),
    D("laptop-setup", "Laptop setup checklist", "f_week1", "link", "lee"),
    D("first-pr", "Your first pull request", "f_week1", "workspace", "dana", { has_password: true }),
    D("auth-api", "Authentication API", "f_api", "link", "me"),
    D("webhooks", "Webhooks", "f_api", "link", "dana"),
    D("leave-policy", "Leave policy", "f_policies", "workspace", "lee"),
    D("expenses", "Expenses", "f_policies", "workspace", "me", { kind: "artifact", mime: "text/csv", renderer: "sheet", original_filename: "expenses.csv" }),
    D("demo-reel", "Product demo reel", "f_videos", "link", "dana", { kind: "artifact", mime: "video/mp4", renderer: "video", original_filename: "demo.mp4", size_bytes: 48_000_000 }),
    D("intro-video", "Intro to Sia", "f_videos", "workspace", "me", { kind: "artifact", mime: "video/mp4", renderer: "video", original_filename: "intro.mp4" }),
    D("team-faq", "Team FAQ", null, "workspace", "dana"),
    D("all-hands", "All-hands notes, October", null, "link", "me"),
    D("security-review", "Security review checklist", null, "private", "me"),
    D("board-deck", "Board deck", null, "private", "lee"),
  ];
  for (let i = 1; i <= 28; i++) {
    const v = `v2.${30 - i}.0`;
    items.push(D(`release-${30 - i}`, `Release ${v}`, "f_releases", i % 5 === 0 ? "workspace" : "link", i % 3 === 0 ? "me" : "dana"));
  }
  const personal = [
    { slug: "getting-started", ws: "ws_acme", folder: "f_guides" },
    { slug: "roadmap-q4", ws: "ws_acme", folder: "f_guides" },
    { slug: "welcome", ws: "ws_acme", folder: "f_onboarding" },
    { slug: "all-hands", ws: "ws_acme", folder: null },
    { slug: "security-review", ws: "ws_acme", folder: null },
    { slug: "trip-notes", ws: null, folder: null, title: "Trip notes: Lisbon", access: "link" },
    { slug: "resume-2026", ws: null, folder: null, title: "Résumé 2026", access: "private" },
    { slug: "pitch-v3", ws: null, folder: null, title: "Pitch v3", access: "link", kind: "artifact", mime: "text/html", renderer: "html", original_filename: "pitch.html" },
  ];
  const domains = [
    { id: "d1", host: "docs.acme.com", kind: "app", status: "verified", attached: true, is_primary: true, verified_at: ago(400), last_checked_at: ago(3), txt_ok: true, routing_ok: true },
    { id: "d2", host: "help.acme.com", kind: "app", status: "pending", attached: false, is_primary: false, verified_at: null, last_checked_at: ago(1), txt_ok: true, routing_ok: false, last_error: "The routing record isn't there yet. DNS changes can take up to an hour." },
    { id: "d3", host: "files.acme.com", kind: "cdn", status: "verified", attached: false, is_primary: false, verified_at: ago(30), last_checked_at: ago(2), txt_ok: true, routing_ok: true },
  ];
  return { folders, items, personal, domains, seq: 1 };
}

let db = fixtures();

const USERS = {
  owner: { id: "u_me", email: "owner@acme.test", name: "Olivia Owner" },
  admin: { id: "u_me", email: "admin@acme.test", name: "Avery Admin" },
  member: { id: "u_me", email: "member@acme.test", name: "Morgan Member" },
  viewer: { id: "u_me", email: "viewer@acme.test", name: "Vic Viewer" },
};
const OWNERS = { dana: "Dana Kim", lee: "Lee Park" };
const RANK = { viewer: 0, member: 1, admin: 2, owner: 3 };

function roleFrom(req) {
  const m = /^Bearer mock-(owner|admin|member|viewer)$/.exec(req.headers.authorization || "");
  return m ? m[1] : null;
}

function workspaces(role) {
  const base = (id, name, r, extra = {}) => ({
    id, name, owner_id: r === "owner" ? "u_me" : "u_other", created_at: ago(2000), updated_at: ago(10),
    branding: { site_name: name, favicon_url: null, logo_url: null, accent_color: id === "ws_acme" ? "#6d5efc" : null, hide_markdrop_branding: false },
    settings: { viewer_chrome: "full", require_auth_to_view: false, members_can_share_folders: true },
    role: r, primary_host: null, member_count: 6, pending_invite_count: 1, domain_count: 0, default_access: "workspace", domains: [], ...extra,
  });
  return [
    base("ws_acme", "Acme Docs", role, {
      primary_host: "docs.acme.com", domain_count: 3,
      domains: [{ host: "docs.acme.com", verified: true, primary: true, live: true }],
    }),
    base("ws_empty", "Side Project", "admin", { member_count: 1, pending_invite_count: 0 }),
    base("ws_broken", "Flaky Co", "member"),
  ];
}

const roleIn = (role, ws) => (ws === "ws_acme" ? role : ws === "ws_empty" ? "admin" : "member");

function canRead(it, role) {
  return it.owner === "me" || it.access !== "private";
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

function itemOut(it, role) {
  const r = RANK[role];
  const mine = it.owner === "me";
  const path = it.folder ? pathOf(it.folder) : [];
  const fpath = path.map((f) => f.slug).join("/");
  return {
    id: `id_${it.slug}`, slug: it.slug, title: it.title, kind: it.kind, mime: it.mime, renderer: it.renderer ?? null,
    original_filename: it.original_filename ?? null,
    url: `https://docs.acme.com/${fpath ? fpath + "/" : ""}${it.slug}`, markdrop_url: `https://markdrop.in/${it.slug}`,
    access: it.access, has_password: it.has_password,
    folder: it.folder ? { id: it.folder, name: path.at(-1)?.name, path: fpath } : null,
    owner: { name: mine ? USERS[role].name : OWNERS[it.owner], is_you: mine },
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

function tree(ws, role) {
  const visible = db.items.filter((i) => i.ws === ws && canRead(i, role));
  const folders = db.folders.filter((f) => f.ws === ws);
  const direct = (fid) => visible.filter((i) => i.folder === fid).length;
  const total = (fid) => direct(fid) + folders.filter((f) => f.parent_id === fid).reduce((n, c) => n + total(c.id), 0);
  const w = workspaces(role).find((x) => x.id === ws);
  return {
    workspace: { id: ws, name: w.name, role: roleIn(role, ws), primary_host: w.primary_host },
    folders: folders.map((f) => {
      const p = pathOf(f.id);
      return {
        id: f.id, name: f.name, slug: f.slug, parent_id: f.parent_id, path: p.map((x) => x.slug).join("/"), depth: p.length - 1,
        item_count: direct(f.id), total_count: total(f.id), share: f.share,
      };
    }),
    unfiled_count: direct(null),
  };
}

function subtree(fid) {
  const out = [fid];
  for (const f of db.folders.filter((x) => x.parent_id === fid)) out.push(...subtree(f.id));
  return out;
}

function shareOut(f, role) {
  const ids = subtree(f.id);
  const all = db.items.filter((i) => ids.includes(i.folder) && canRead(i, role));
  const hidden = f.share.level === "link" ? db.items.filter((i) => ids.includes(i.folder) && i.access !== "link") : [];
  return {
    share_id: f.share.id, url: `https://markdrop.in/f/${f.share.id}`, level: f.share.level,
    hidden_count: hidden.length,
    hidden: hidden.filter((i) => canRead(i, role) || true).map((i) => ({ slug: i.slug, title: canRead(i, role) ? i.title : "A private item", access: i.access, has_password: i.has_password })),
    total_count: db.items.filter((i) => ids.includes(i.folder)).length,
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
    access_level: src.access ?? "link", shared_with_count: 0, is_mine: true,
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

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204);
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const role = roleFrom(req);
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
    const readable = (i) => (role ? canRead(i, role) : i.access === "link");
    const crumbs = pathOf(cur.id);
    const start = crumbs.findIndex((x) => x.id === f.id);
    return send(res, 200, {
      workspace: { name: "Acme Docs", branding: { accent_color: "#6d5efc", logo_url: null } },
      folder: { name: cur.name, path: rel(cur.id), breadcrumbs: crumbs.slice(start).map((x) => ({ name: x.name, path: rel(x.id) })) },
      subfolders: db.folders.filter((x) => x.parent_id === cur.id).map((x) => ({
        name: x.name, path: rel(x.id), count: db.items.filter((i) => subtree(x.id).includes(i.folder) && readable(i)).length,
      })).filter((x) => x.count > 0 || role),
      items: db.items.filter((i) => i.folder === cur.id && readable(i)).map((i) => {
        const o = itemOut(i, role || "viewer");
        return { slug: i.slug, title: i.title, kind: i.kind, mime: i.mime, url: o.url, size_bytes: i.size_bytes ?? null, updated_at: i.updated_at, poster_url: null };
      }),
    });
  }

  if ((mm = m(/^\/api\/v1\/documents\/([^/]+)$/)) && req.method === "GET") {
    if (mm[1] === "old-getting-started") {
      return send(res, 200, { moved: true, slug: "getting-started", url: "https://markdrop.in/getting-started", workspace_url: "https://docs.acme.com/guides/getting-started", folder_path: ["guides"] }, { "X-Markdrop-Moved": "getting-started" });
    }
    const it = db.items.find((i) => i.slug === mm[1]) ?? db.personal.find((x) => x.slug === mm[1]);
    if (!it) return send(res, 404, { detail: "Document not found" });
    const content = `# ${it.title}\n\nThis is a mock document used to preview the workspace UI.\n\n- One\n- Two\n`;
    return send(res, 200, {
      slug: it.slug, url: `https://markdrop.in/${it.slug}`, title: it.title, content, created_at: ago(100), updated_at: ago(2),
      expires_at: null, views: 3, is_password_protected: false, is_owner: role ? it.owner === "me" : false, kind: "markdown",
      folder_path: it.folder ? pathOf(it.folder).map((f) => f.slug) : [],
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
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const list = db.personal.map((x) => personalOut(x, role)).filter((d) => !q || d.title.toLowerCase().includes(q) || d.slug.includes(q));
    const kind = url.searchParams.get("kind");
    const shown = kind ? list.filter((d) => d.kind === kind) : list;
    return send(res, 200, {
      documents: shown, total: shown.length, page: 1, pages: 1,
      count_all: list.length, count_markdown: list.filter((d) => d.kind === "markdown").length, count_artifact: list.filter((d) => d.kind === "artifact").length,
    });
  }

  if ((mm = m(/^\/api\/v1\/documents\/([^/]+)\/access$/))) {
    const it = db.items.find((i) => i.slug === mm[1]);
    const per = db.personal.find((x) => x.slug === mm[1]);
    if (!it && !per) return send(res, 404, { detail: "Document not found" });
    const mine = it ? it.owner === "me" : true;
    return send(res, 200, {
      level: it ? it.access : per.access ?? "link", allow_resharing: false, is_password_protected: !!it?.has_password, encrypted: false,
      in_workspace: !!it, workspace_id: it ? it.ws : null, folder_id: it ? it.folder : null,
      your_role: mine ? "owner" : RANK[role] >= 1 ? "editor" : "viewer",
      owner_name: mine ? user.name : OWNERS[it.owner], owner_email: mine ? user.email : `${it.owner}@acme.test`,
      your_email: user.email, can_manage: mine, can_share: mine, grants: mine ? [{ email: "dana@acme.test", role: "editor", created_at: ago(30), granted_by_email: user.email, notified: true }] : [],
    });
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

  if (p === "/api/v1/workspaces" && req.method === "GET") return send(res, 200, { workspaces: workspaces(role) });

  if ((mm = m(/^\/api\/v1\/workspaces\/([^/]+)(\/.*)?$/))) {
    const ws = mm[1];
    const rest = mm[2] || "";
    const w = workspaces(role).find((x) => x.id === ws);
    if (!w) return send(res, 404, { detail: "Workspace not found" });
    const r = roleIn(role, ws);
    if (ws === "ws_broken" && /^\/(tree|items)/.test(rest)) return send(res, 500, { detail: "The database didn't answer in time." });
    if (rest === "") return send(res, 200, w);
    if (rest === "/tree") return send(res, 200, tree(ws, role));
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
      const f = { id: `f_new${db.seq++}`, ws, name: body.name, slug: body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), parent_id: body.parent_id ?? null, share: null };
      db.folders.push(f);
      return send(res, 201, { id: f.id, workspace_id: ws, name: f.name, parent_id: f.parent_id, slug: f.slug, path: pathOf(f.id).map((x) => x.slug), created_at: ago(0), updated_at: ago(0) });
    }
    if ((mm = rest.match(/^\/folders\/([^/]+)\/share$/))) {
      const f = db.folders.find((x) => x.id === mm[1]);
      if (!f) return send(res, 404, { detail: "Folder not found" });
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
          it = { slug: s, title: per.title, folder: body.folder_id ?? null, access: body.access ?? per.access ?? "link", owner: "me", kind: per.kind ?? "markdown", mime: per.mime ?? null, has_password: false, views: 4, updated_at: ago(1), ws };
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
    if (rest === "/members") return send(res, 200, { members: [
      { user_id: "u_me", role: r, email: user.email, name: user.name, created_at: ago(900) },
      { user_id: "u_dana", role: "admin", email: "dana@acme.test", name: "Dana Kim", created_at: ago(800) },
      { user_id: "u_lee", role: "member", email: "lee@acme.test", name: "Lee Park", created_at: ago(700) },
    ] });
    if (rest === "/invitations") return send(res, 200, { invitations: [] });
    if (rest === "/domains" && req.method === "GET") {
      return send(res, 200, { domains: (ws === "ws_acme" ? db.domains : []).map((d) => ({
        created_at: ago(500), last_error: null, warning: null,
        dns_record_name: `_markdrop-challenge.${d.host}`, dns_record_type: "TXT", dns_record_value: "md-verify=7f3a9c1e5b2d4086",
        dns_target_name: d.host, dns_target_type: "CNAME", dns_target_value: "edge.markdrop.in",
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
