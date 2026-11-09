/**
 * No content overflows, on any page (owner 2026-11-09: "lines are overflowing the box … make sure no
 * content overflows in ANY page"). A real-stack sweep: seeds hostile content on top of seed.py (300-char
 * unbroken words and lines, long URLs, long emails and names, long workspace / folder / page / meeting
 * titles, long Jira keys and summaries, Team memory lines, focus notes and statuses, comments assigned as
 * tasks, many chips) and visits every app route at phone, tablet and desktop widths in light and dark.
 * Each state is measured in the page (overflow-measure.mjs):
 *
 *   hscroll   the page scrolls sideways (scrollWidth > innerWidth + 1)
 *   spill     text or a box (chip, button, card) runs past the bordered / backgrounded box around it
 *   cut       text sliced off sideways by overflow: hidden with no ellipsis
 *
 * Offenders print as "route · width · theme · rule · selector · text" and each gets a screenshot (the
 * offender outlined in magenta, its box in cyan) in $PB_WORK/overflow/<browser>/; the list goes to
 * findings-<browser>.json there. Exit code 1 when anything is flagged.
 *
 *   PB_FAKE_JIRA=1 PB_FAKE_MEETINGS_AI=1 PB_FAKE_TEAM_AI=1 PB_STACK_ID=41 PB_WORK=… zsh up.sh start
 *   PB_STACK_ID=41 PB_WORK=… BROWSER=chromium|webkit [ONLY=team,doc] [WIDTHS=320,1440] [THEMES=light]
 *     [NO_RESEED=1] [SHOTS=0] node overflow.mjs
 *
 * Widths: 320, 375, 768, 1024, 1440 everywhere (Team: also 414, 1280, 1920). Phones and tablets (≤ 768)
 * load with a touch screen (coarse pointer: the 44 px targets and 16 px text), wider ones with a mouse.
 * Each load is measured light, then dark (the theme flips in place; colours change which boxes have a
 * background, never the layout).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { APP, API, BROWSER, STACK, STACK_ID, TENANT, WORK, here, log, fail, reseed, seedNow, api, launch, ctx, editPage } from "./lib.mjs";
import { measureOverflow } from "./overflow-measure.mjs";

const want = (env, all) => (process.env[env] ? process.env[env].split(",").map((s) => s.trim()).filter(Boolean) : all);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const WIDTHS = want("WIDTHS", ["320", "375", "768", "1024", "1440"]).map(Number);
const TEAM_WIDTHS = process.env.WIDTHS ? WIDTHS : [320, 375, 414, 768, 1024, 1280, 1440, 1920];
const THEMES = want("THEMES", ["light", "dark"]);
const SHOOT = process.env.SHOTS !== "0";
const OUT = path.join(WORK, "overflow", BROWSER);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const ROOT = path.resolve(here, "../../../..").split("/.claude/worktrees/")[0];
const PY = path.join(ROOT, "backend", ".venv", "bin", "python");
const PYENV = { ...process.env, STACK_ID: String(STACK_ID), PB_STACK: STACK };
const DOCS = `http://docs.localhost:${new URL(APP).port}`;

/* ── Hostile content ─────────────────────────────────────────────────── */

const WORD = "Supercalifragilisticexpialidocious".repeat(6); // 204 chars, no break opportunity
const LINE = "ABCDEFGHIJ0123456789".repeat(15); // 300 chars
const URL_LONG = "https://github.com/acme-corporation/platform-infrastructure-monorepo/pull/48213/files#diff-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c";
// The fake Team AI reads up to the first "." of a line, so Team's hostile words have no dots.
const URL_NODOT = `http://localhost:3000/${"platform-infrastructure-".repeat(6)}pull/48213`;
const NAME = "Bartholomew Alexander Montgomery-Fitzgerald Wolfeschlegelsteinhausenberger";
const EMAIL = "bartholomew.alexander.montgomery-fitzgerald@extraordinarily-long-subdomain.acme-corporation.test";
const TITLE = `Quarterly ${WORD.slice(0, 120)} review ${URL_LONG}`.slice(0, 190);
const WS_NAME = `Acme ${WORD}`.slice(0, 80);
const FOLDER_NAME = `Folder ${WORD}`.slice(0, 80);
const MD = `# ${WORD}

A paragraph with a long link ${URL_LONG} and [a labelled one](${URL_LONG}), an email ${EMAIL}, and a word: ${WORD}.

Inline code: \`${LINE}\`

\`\`\`js
const veryLongLine = "${LINE}"; // ${URL_LONG}
\`\`\`

> ${WORD} ${URL_LONG}

- ${WORD}
- ${URL_LONG}
- [ ] a task ${LINE}

| Column ${WORD.slice(0, 40)} | ${URL_LONG} | Three | Four | Five | Six | Seven | Eight | Nine | Ten |
|---|---|---|---|---|---|---|---|---|---|
| ${LINE} | ${EMAIL} | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |

## ${URL_LONG}

The end ${LINE}
`;

/* ── Seed ─────────────────────────────────────────────────────────────── */

const FILE = path.join(STACK, "overflow.json");
const ok = (r, what) => {
  if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
};
const soft = (r, what) => {
  if (r.status >= 300) log(`(seed: ${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)})`);
  return r.body;
};
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

async function seed() {
  const S = reseed();
  execFileSync(PY, [path.join(here, "seed_mobile_guides.py")], { stdio: "pipe", env: PYENV });
  execFileSync(PY, [path.join(here, "seed_admin.py")], { stdio: "pipe", env: PYENV });
  const M = JSON.parse(fs.readFileSync(path.join(STACK, "mobile.json"), "utf8"));
  const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
  const U = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.id]));
  const WS = S.ws;
  const admin = ok(await api("POST", "/__sandbox/user", null, { email: process.env.E2E_ADMIN_EMAIL || "kukreja.him@gmail.com", name: "Site Admin" }), "site admin");
  // A member with a very long name and email.
  const L = ok(await api("POST", "/__sandbox/user", null, { email: EMAIL, name: NAME }), "long user");
  ok(await api("POST", "/__sandbox/team-memory/member", null, { workspace_id: WS, user_id: L.id, role: "member" }), "long member");
  // The workspace, a folder and its pages with long names; a board with many chips.
  const wsNow = ok(await api("GET", `/api/v1/workspaces/${WS}`, T.owner), "ws");
  ok(await api("PUT", `/api/v1/workspaces/${WS}`, T.owner, { name: WS_NAME, settings: { ...(wsNow.settings || {}), team_memory: true, timezone: "UTC" } }), "ws name + team on");
  const folder = ok(await api("POST", `/api/v1/workspaces/${WS}/folders`, T.owner, { name: FOLDER_NAME }), "folder");
  const folderId = folder.id ?? folder.folder?.id;
  const opts = Array.from({ length: 14 }, (_, i) => ({ name: i === 0 ? WORD.slice(0, 60) : `Label ${i} ${"x".repeat(i)}`, color: ["gray", "blue", "green", "red", "purple"][i % 5] }));
  soft(await api("PUT", `/api/v1/workspaces/${WS}/folders/${folderId}/properties`, T.owner, {
    properties: [
      { key: "status", name: `Status ${WORD.slice(0, 30)}`, type: "select", options: opts.slice(0, 3) },
      { key: "tags", name: "Tags", type: "multi_select", options: opts },
      { key: "owner", name: "Owner", type: "text" },
      { key: "link", name: "Link", type: "link" },
    ],
  }), "board schema");
  const page = ok(await api("POST", "/api/v1/pages", T.owner, { title: TITLE, workspace: WS, folder: folderId, content: MD, auto_cover: false }), "hostile page").document;
  for (const i of [1, 2]) {
    const pg = soft(await api("POST", "/api/v1/pages", T.owner, { title: `${i} ${WORD}`.slice(0, 190), workspace: WS, folder: folderId, content: `# ${i}\n\n${LINE}\n`, auto_cover: false }), `page ${i}`);
    if (pg?.document) soft(await api("PATCH", `/api/v1/documents/${pg.document.slug}/properties`, T.owner, { values: { status: opts[0].name, tags: opts.map((o) => o.name), owner: NAME, link: URL_LONG } }), "values");
  }
  soft(await api("PATCH", `/api/v1/documents/${page.slug}/properties`, T.owner, { values: { status: opts[0].name, tags: opts.map((o) => o.name), owner: `${NAME} ${EMAIL}`, link: URL_LONG } }), "values");
  // A classic markdown document and a private one Cy asks for (with a long message).
  const doc = ok(await api("POST", "/api/v1/documents", T.owner, { title: TITLE, content: MD, expires_in: "never", workspace: WS, folder: S.folder, access_level: "workspace" }), "hostile doc");
  const priv = ok(await api("POST", "/api/v1/documents", T.owner, { title: `Private ${WORD}`.slice(0, 190), content: MD, expires_in: "never", access_level: "private" }), "private doc");
  const reqr = soft(await api("POST", `/api/v1/documents/${priv.slug}/access-requests`, T.stranger, { message: `${WORD} ${URL_LONG}`.slice(0, 480), role: "viewer" }), "access request");
  // Comments on the page: long bodies, assigned as tasks (Team's comment cards), a mention for the bell.
  const threads = [];
  for (const [who, assignee, body] of [
    ["member", U.owner, `${WORD} ${URL_LONG} @Ada`],
    ["owner", L.id, `${LINE} ${EMAIL}`],
    ["owner", U.member, `${URL_LONG} ${WORD}`],
  ]) {
    const t = soft(await api("POST", `/api/v1/documents/${page.slug}/comments`, T[who], {
      anchor: { type: "page" }, body, assignee, mentions: who === "member" ? [U.owner] : [] }), "comment");
    if (t?.id) {
      threads.push(t.id);
      soft(await api("POST", `/api/v1/documents/${page.slug}/comments/${t.id}/replies`, T.owner, { body: `Reply ${LINE}` }), "reply");
    }
  }
  // Team memory: meetings with long words in every kind of line (the fake Team AI reads them).
  const meeting = (title, date, lines, extra = {}) => api("POST", "/api/v1/meetings/import", T.owner, {
    workspace: WS, wait: true, date, title, restricted: false, ...extra,
    sources: [{ name: `${title.slice(0, 150)} - Transcript`, text: `${title} - Transcript\nAttendees\n${[...new Set(lines.map((l) => l.split(":")[0]))].join(", ")}\nTranscript\n${lines.join("\n")}\nTranscription ended after 00:15:00\n` }],
  });
  const meetings = [];
  for (const [i, lines] of [
    [`${NAME}: Done: shipped ${WORD}. Working on: ${URL_NODOT} for sourcing. Target: ${LINE} by tomorrow.`,
      `Ben Member: Done: ${WORD} for billing. Working on: ${URL_NODOT}. Target: ${WORD} by Friday. Blocked: ${WORD} ${URL_NODOT} (waiting on Ada Owner).`,
      `Ada Owner: Status: ${WORD}. Decision: ${LINE} for onboarding. Working on: ${LINE}.`,
      `Wes Admin: Role: ${WORD}. Done: ${URL_NODOT} for mobile. Target: ${URL_NODOT} by yesterday.`],
    [`${NAME}: Blocked: ${LINE} (waiting on Ben Member). Done: ${URL_NODOT}. Target: ${WORD} by tomorrow. Target: ${LINE} by Friday. Target: ${URL_NODOT} by tomorrow.`,
      `Ben Member: Done: ${LINE} for sourcing. Target: ${URL_NODOT} by today.`],
  ].entries()) {
    const m = soft(await meeting((i === 0 ? TITLE : `Standup ${WORD}`).slice(0, 150), day(-1 - i), lines), `meeting ${i}`);
    if (m?.meetings?.[0]) meetings.push(m.meetings[0]);
  }
  soft(await api("POST", "/__sandbox/team-memory/run"), "team run");
  soft(await api("PUT", `/api/v1/team/${WS}/me/focus`, T.owner, { text: `${URL_LONG} ${WORD}`.slice(0, 280) }), "focus");
  soft(await api("PUT", `/api/v1/team/${WS}/me/status`, T.owner, { text: `${WORD}`.slice(0, 120), emoji: "🚧" }), "status");
  soft(await api("POST", `/api/v1/team/${WS}/groups`, T.owner, { name: WORD.slice(0, 60), member_ids: [U.owner, U.member, L.id] }), "group");
  // Jira: a long project key and name, long summaries, overdue and blocked; Ada and Ben connected.
  let jira = false;
  if ((await api("POST", "/__sandbox/jira/reset")).status === 200) {
    const acc = { id: "acc-long", name: NAME, email: EMAIL };
    const add = (b) => soft(api("POST", "/__sandbox/jira/add", null, b), "jira add");
    await add({ project: "PLATFORMOP", project_name: `Platform ${WORD}`.slice(0, 120), summary: `${WORD} ${URL_LONG}`, status: "In Progress", assignee: "acc-ben", due_in: -3, account: acc });
    await add({ project: "PLATFORMOP", summary: `${LINE}`, status: "Blocked", assignee: "acc-ada" });
    await add({ project: "PLATFORMOP", summary: `${URL_LONG}`, assignee: "acc-long", due_in: -1 });
    await add({ project: "PAY", summary: `${WORD}`, assignee: "acc-ben", due_in: 2 });
    for (const who of ["owner", "member"]) {
      const st = soft(await api("POST", "/api/v1/jira/connect/start", T[who], { kind: "me", workspace_id: WS }), "jira start");
      if (!st?.url) break;
      const state = new URL(st.url).searchParams.get("state");
      soft(await api("POST", "/api/v1/jira/connect/finish", T[who], { code: `code-${{ owner: "acc-ada", member: "acc-ben" }[who]}`, state }), "jira finish");
    }
    jira = !!soft(await api("PUT", "/api/v1/jira/site", T.owner, { workspace_id: WS, cloud_id: "cloud-acme", projects: ["PAY", "WEB", "PLATFORMOP"], default_project: "PAY", default_issue_type: "Task" }), "jira site");
  } else log("(no fake Jira on this stack: PB_FAKE_JIRA=1 for the Jira states)");
  const board = soft(await api("GET", `/api/v1/team/${WS}`, T.owner), "board");
  const project = board?.lanes?.[0]?.key ?? board?.projects?.[0]?.key ?? null;
  const out = { S, M, admin: admin.token, long: L.id, folder: folderId, page: page.slug, doc: doc.slug, priv: priv.slug,
    request: reqr?.id ?? null, threads, meetings: meetings.map((m) => m.slug), project, jira };
  fs.writeFileSync(FILE, JSON.stringify(out, null, 1));
  return out;
}

const X = process.env.NO_RESEED && fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : await seed();
const { S, M } = X;
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const U = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.id]));
const WS = encodeURIComponent(S.ws);
log("seeded", JSON.stringify({ page: X.page, doc: X.doc, meetings: X.meetings, project: X.project, jira: X.jira }));

/* ── Routes ───────────────────────────────────────────────────────────── */

const G = `${APP}/guides`;
const site = `${G}/${M.site}`;
const click = async (p, loc) => { await loc.first().click({ timeout: 8000 }); await p.waitForTimeout(700); };
/** [name, who ("anon" | "owner" | "member" | "admin"), url, action?(p) → "skip" | void, {team}] */
const ROUTES = [
  // Marketing and tools (signed out)
  ["landing", "anon", `${APP}/`],
  ["privacy", "anon", `${APP}/privacy`],
  ["enterprise", "anon", `${APP}/enterprise`],
  ["mcp", "anon", `${APP}/mcp`],
  ["login", "anon", `${APP}/login`],
  ["new", "anon", `${APP}/new`],
  ["upload", "anon", `${APP}/upload`],
  ["share", "anon", `${APP}/share`],
  ["builder", "anon", `${APP}/builder`],
  ["doc-anon", "anon", `${APP}/public-handbook`],
  // Home and lists
  ["home", "owner", `${APP}/dashboard`],
  ["files", "owner", `${APP}/dashboard/files`],
  ["shared", "owner", `${APP}/shared`],
  ["recent", "owner", `${APP}/recent`],
  ["trash", "owner", `${APP}/trash`],
  ["search", "owner", `${APP}/search?q=${encodeURIComponent("Supercalifragilistic")}`],
  ["ask", "owner", `${APP}/ask`],
  ["bell", "owner", `${APP}/dashboard`, async (p) => click(p, p.getByRole("button", { name: /^Notifications/ }))],
  ["workspace", "owner", `${APP}/w/${WS}`],
  ["folder", "owner", `${APP}/w/${WS}/f/${X.folder}`],
  ["folder-board", "owner", `${APP}/w/${WS}/f/${X.folder}`, async (p) => {
    const b = p.getByRole("radio", { name: /Board/ });
    if (!(await b.count())) return "skip";
    await click(p, b);
  }],
  ["folder-table", "owner", `${APP}/w/${WS}/f/${X.folder}`, async (p) => {
    const b = p.getByRole("radio", { name: /Table/ });
    if (!(await b.count())) return "skip";
    await click(p, b);
  }],
  // Reading and editing
  ["doc", "owner", `${APP}/${X.doc}`],
  ["page", "owner", `${APP}/${X.page}`],
  ["page-comments", "member", `${APP}/${X.page}${X.threads[0] ? `#c-${X.threads[0]}` : ""}`, async (p) => {
    if (await p.locator("aside.mdc-panel").count()) return;
    await click(p, p.getByRole("button", { name: /^Comments/ }));
  }],
  ["page-edit", "owner", `${APP}/${X.page}`, async (p) => { await editPage(p); await p.waitForTimeout(800); }],
  ["file-html", "owner", `${APP}/pricing-calc`],
  ["file-pdf", "owner", `${APP}/q3-report`],
  ["meetings", "owner", `${APP}/meetings/${WS}`],
  ["meeting", "owner", X.meetings[0] ? `${APP}/${X.meetings[0]}` : null],
  ["request", "owner", X.request ? `${APP}/requests/${X.request}` : null],
  ["new-page", "owner", `${APP}/pages/new`],
  ["meetings-start", "owner", `${APP}/meetings/start`],
  // Team
  ["team", "owner", `${APP}/team/${WS}`, null, { team: true }],
  ["team-member", "member", `${APP}/team/${WS}`, null, { team: true }],
  ["team-week-open", "owner", `${APP}/team/${WS}`, async (p) => {
    const more = p.locator(".tm-wk__more");
    for (let i = 0; i < (await more.count()); i++) await more.nth(i).click().catch(() => {});
    const rows = p.locator(".tm-wk__text, .tm-wk__ghead");
    for (let i = 0; i < Math.min(12, await rows.count()); i++) await rows.nth(i).click().catch(() => {});
    await p.waitForTimeout(400);
  }, { team: true }],
  ["team-projects", "owner", `${APP}/team/${WS}`, async (p) => click(p, p.getByRole("tab", { name: /Projects/ })), { team: true }],
  ["team-person-long", "owner", `${APP}/team/${WS}/people/${X.long}`, null, { team: true }],
  ["team-person-ben", "member", `${APP}/team/${WS}/people/${U.member}`, null, { team: true }],
  ["team-person-me", "owner", `${APP}/team/${WS}/people/${U.owner}`, null, { team: true }],
  ["team-project", "owner", X.project ? `${APP}/team/${WS}/projects/${encodeURIComponent(X.project)}` : null, null, { team: true }],
  // Settings
  ["settings", "owner", `${APP}/settings`],
  ["settings-account", "owner", `${APP}/settings/account`],
  ["settings-connections", "owner", `${APP}/settings/connections`],
  ["settings-tokens", "owner", `${APP}/settings/tokens`],
  ["settings-workspaces", "owner", `${APP}/settings/workspaces`],
  ...["people", "look", "integrations", "advanced"].map((t) => [`settings-ws-${t}`, "owner", `${APP}/settings/workspaces/${WS}?tab=${t}`]),
  // Analytics
  ["analytics", "owner", `${APP}/dashboard/analytics`],
  ["analytics-doc", "owner", `${APP}/dashboard/analytics/${X.doc}`],
  ["analytics-live", "owner", `${APP}/dashboard/live`],
  // Admin
  ...["", "live", "health", "journeys", "ai", "documents", "reports", "users", "feedback", "email"].map((t) => [`admin${t ? `-${t}` : ""}`, "admin", `${APP}/admin${t ? `?tab=${t}` : ""}`]),
  // Guides studio and the docs site
  ["guides", "owner", `${G}`],
  ["guides-home", "owner", `${G}/home`],
  ["guides-editor", "owner", `${site}?page=${M.long_page}`],
  ["guides-publish", "owner", `${site}/publish`],
  ["guides-insights", "owner", `${site}/insights`],
  ["guides-fixes", "owner", `${site}/fixes`],
  ["guides-settings", "owner", `${site}/settings/general`],
  ["guides-members", "owner", `${G}/members`],
  ["docs-home", "anon", `${DOCS}/`],
  ["docs-page", "anon", `${DOCS}/sharing/request-access`],
  ["docs-changelog", "anon", `${DOCS}/changelog`],
  // The workspace's own domain
  ["tenant-home", "owner", `${TENANT}/`],
];

/* ── Run ──────────────────────────────────────────────────────────────── */

const browser = await launch();
const findings = [];
const shots = [];
const tok = (who) => (who === "anon" ? null : who === "admin" ? X.admin : T[who]);

async function settle(p) {
  await p.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await p.evaluate(() => document.fonts?.ready).catch(() => {});
  await p.waitForTimeout(500);
}

async function flipTheme(p, theme) {
  await p.emulateMedia({ colorScheme: theme });
  await p.evaluate((t) => {
    try { localStorage.setItem("md_theme", t); } catch {}
    const d = document.documentElement;
    d.setAttribute("data-theme", t);
    d.classList.toggle("dark", t === "dark");
  }, theme);
  await p.waitForTimeout(250);
}

async function record(p, name, width, theme) {
  let got;
  try {
    got = await p.evaluate(measureOverflow, {});
  } catch (e) {
    findings.push({ route: name, width, theme, rule: "error", who: "", text: e.message.slice(0, 200) });
    return;
  }
  for (const f of got) {
    const row = { route: name, width, theme, ...f };
    findings.push(row);
    const key = `${name}|${f.rule}|${f.who}`;
    if (!SHOOT || shots.includes(key) || shots.length > 400) continue;
    shots.push(key);
    const file = path.join(OUT, `${String(shots.length).padStart(3, "0")}-${name}-${width}-${theme}-${f.rule}.png`);
    row.shot = file;
    try {
      await p.evaluate((n) => {
        const el = document.querySelector(`[data-ovf="${n}"]`);
        const box = document.querySelector(`[data-ovf-box="${n}"]`);
        if (!el) return;
        el.scrollIntoView({ block: "center", inline: "nearest" });
        el.style.outline = "2px solid #ff00ff";
        el.style.outlineOffset = "-1px";
        if (box) { box.style.outline = "2px dashed #00bcd4"; box.style.outlineOffset = "1px"; }
      }, f.n);
      await p.screenshot({ path: file });
      await p.evaluate((n) => {
        for (const e of document.querySelectorAll(`[data-ovf="${n}"], [data-ovf-box="${n}"]`)) { e.style.outline = ""; e.style.outlineOffset = ""; }
      }, f.n);
    } catch (e) {
      log(`(shot ${name}: ${e.message.slice(0, 120)})`);
    }
  }
}

const t0 = Date.now();
let states = 0;
for (const [name, who, url, action, opt = {}] of ROUTES) {
  if (ONLY && !ONLY.has(name) && !(ONLY.has("team") && name.startsWith("team")) && !(ONLY.has("admin") && name.startsWith("admin"))) continue;
  if (!url) { log(`- ${name}: skipped (nothing seeded)`); continue; }
  const widths = opt.team ? TEAM_WIDTHS : WIDTHS;
  const groups = [widths.filter((w) => w <= 768), widths.filter((w) => w > 768)].filter((g) => g.length);
  const before = findings.length;
  for (const group of groups) {
    const touch = group[0] <= 768;
    const { c, p } = await ctx(browser, { token: tok(who), theme: THEMES[0], width: group[0], height: touch ? 800 : 900, mobile: touch });
    try {
      await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await settle(p);
      if (action && (await action(p)) === "skip") { log(`- ${name}: skipped (no control)`); await c.close(); continue; }
      await settle(p);
      for (const [ti, theme] of THEMES.entries()) {
        if (ti > 0) await flipTheme(p, theme);
        for (const w of group) {
          await p.setViewportSize({ width: w, height: touch ? 800 : 900 });
          await p.waitForTimeout(350);
          await record(p, name, w, theme);
          states++;
        }
      }
    } catch (e) {
      findings.push({ route: name, width: group[0], theme: THEMES[0], rule: "error", who: "", text: e.message.split("\n")[0].slice(0, 200) });
      await p.screenshot({ path: path.join(OUT, `error-${name}-${group[0]}.png`) }).catch(() => {});
    }
    await c.close().catch(() => {});
  }
  const mine = findings.slice(before);
  log(`${mine.length ? "✗" : "✓"} ${name}${mine.length ? ` (${mine.length})` : ""}`);
}
await browser.close();

/* ── Report ───────────────────────────────────────────────────────────── */

fs.writeFileSync(path.join(OUT, `findings-${BROWSER}.json`), JSON.stringify(findings, null, 1));
// One line per (route, rule, selector), with every width and theme it showed at.
const grouped = new Map();
for (const f of findings) {
  const k = `${f.route}|${f.rule}|${f.who}`;
  const g = grouped.get(k) || { ...f, at: [] };
  g.at.push(`${f.width}${f.theme === "dark" ? "d" : ""}`);
  if (f.shot && !g.shot) g.shot = f.shot;
  grouped.set(k, g);
}
const lines = [...grouped.values()].map((g) => `${g.route} · ${g.rule} · ${g.who}${g.box ? ` (in ${g.box})` : ""} · by ${g.by ?? "?"}px · [${[...new Set(g.at)].join(" ")}] · "${g.text}"${g.shot ? `\n      ${g.shot}` : ""}`);
fs.writeFileSync(path.join(OUT, `findings-${BROWSER}.txt`), lines.join("\n") + "\n");
console.log(`\n${states} states in ${((Date.now() - t0) / 1000).toFixed(0)} s, ${BROWSER}: ${grouped.size} offender(s)`);
for (const l of lines) console.log("  ✗", l);
process.exit(grouped.size ? 1 : 0);
