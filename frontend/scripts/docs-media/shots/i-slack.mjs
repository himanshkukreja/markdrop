/**
 * Docs media, group I: Markdrop for Slack (/integrations/slack). Shot format: ../shots.mjs.
 *
 * Two kinds of image:
 *   - the real settings card (Workspace settings › Integrations › Slack) on the sandbox stack, connected
 *     (the API started with PB_FAKE_SLACK=1: a fake Slack in process, see e2e/pages/real/api_run.py) and
 *     "Not set up yet" (the card's status answer says the server has no Slack app, as production did);
 *   - ILLUSTRATIONS of the messages Markdrop sends in Slack: the Block Kit that Markdrop's own builders
 *     make (slack/payloads.py → slack/payloads.json), drawn on a plain card with Markdrop's fonts and
 *     colours and labelled "Illustration". Deliberately not Slack's interface: no Slack chrome, logo,
 *     colours or fonts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P = JSON.parse(readFileSync(path.resolve(HERE, "../slack/payloads.json"), "utf8"));
const PAGE = "/integrations/slack";

// ── Block Kit → HTML (the subset Markdrop's messages use) ─────────────────────

const EMOJI = { spiral_note_pad: "🗒️", white_large_square: "⬜", white_check_mark: "✅" };
const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const html = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Slack mrkdwn (as Markdrop writes it) → HTML. */
function mrkdwn(text) {
  const tokens = [];
  const keep = (h) => `\u0000${tokens.push(h) - 1}\u0000`;
  let t = text.replace(/<(@[A-Z0-9]+|https?:[^|>]+)(?:\|([^>]+))?>/g, (_m, target, label) => {
    if (target.startsWith("@")) return keep(`<span class="men">@${html(P.users[target.slice(1)] || "someone")}</span>`);
    return keep(`<a href="#">${html(unesc(label || target))}</a>`);
  });
  t = html(unesc(t));
  t = t.replace(/:([a-z_]+):/g, (m, n) => EMOJI[n] || m);
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/(^|[\s(>])\*([^*\n]+)\*/g, "$1<b>$2</b>");
  t = t.replace(/(^|[\s(>])_([^_\n]+)_/g, "$1<i>$2</i>");
  t = t.replace(/(^|[\s(>])~([^~\n]+)~/g, "$1<s>$2</s>");
  t = t.split("\n").map((line) => (line.startsWith("&gt;") ? `<span class="q">${line.slice(4)}</span>` : line)).join("<br>");
  return t.replace(/\u0000(\d+)\u0000/g, (_m, i) => tokens[Number(i)]);
}

const button = (b) => `<span class="btn ${b.style || ""}">${html(b.text.text)}</span>`;

function blocks(list) {
  return list.map((b) => {
    if (b.type === "section") {
      const acc = b.accessory?.type === "button" ? `<div class="acc">${button(b.accessory)}</div>` : "";
      return `<div class="sec"><div class="txt">${mrkdwn(b.text.text)}</div>${acc}</div>`;
    }
    if (b.type === "context") return `<div class="ctx">${b.elements.map((e) => mrkdwn(e.text)).join(" ")}</div>`;
    if (b.type === "actions") return `<div class="acts">${b.elements.map(button).join("")}</div>`;
    return "";
  }).join("");
}

const CSS = `
:root { --bg:#f6f7f9; --card:#fff; --ink:#111827; --mute:#6b7280; --line:#e5e7eb; --link:#2563eb; --accent:#2563eb;
  --men-bg:#eff6ff; --men:#1d4ed8; --btn:#fff; --btn-line:#d1d5db; --danger:#b91c1c; --tag:#f3f4f6; --q:#d1d5db; }
:root.dark { --bg:#0b0f17; --card:#111827; --ink:#e5e7eb; --mute:#9ca3af; --line:#1f2937; --link:#60a5fa; --accent:#3b82f6;
  --men-bg:#1e293b; --men:#93c5fd; --btn:#111827; --btn-line:#374151; --danger:#f87171; --tag:#1f2937; --q:#374151; }
* { box-sizing:border-box; }
html, body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 Manrope, Inter, -apple-system, system-ui, sans-serif; }
.wrap { padding:28px; display:inline-block; }
.illus { width:640px; background:var(--card); border:1px solid var(--line); border-radius:14px; overflow:hidden;
  box-shadow:0 1px 2px rgba(0,0,0,.04), 0 8px 24px rgba(15,23,42,.06); }
.bar { display:flex; align-items:center; gap:10px; padding:10px 16px; border-bottom:1px solid var(--line); font-size:12.5px; color:var(--mute); }
.tag { text-transform:uppercase; letter-spacing:.06em; font-weight:700; font-size:10.5px; padding:3px 8px; border-radius:999px;
  background:var(--tag); color:var(--mute); }
.where { margin-left:auto; font-weight:600; }
.msg { display:flex; gap:12px; padding:16px 18px 18px; }
.av { flex:none; width:36px; height:36px; border-radius:9px; display:grid; place-items:center; font-weight:800; color:#fff; background:var(--accent); }
.av.person { background:#7c3aed; }
.body { min-width:0; flex:1; }
.who { font-weight:700; } .who small { font-weight:500; color:var(--mute); margin-left:6px; font-size:12px; }
.sec { display:flex; gap:12px; align-items:flex-start; margin-top:6px; }
.txt { flex:1; min-width:0; overflow-wrap:anywhere; }
.acc { flex:none; }
.ctx { margin-top:6px; font-size:12.5px; color:var(--mute); }
.acts { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
.btn { display:inline-block; padding:5px 12px; border:1px solid var(--btn-line); border-radius:8px; background:var(--btn);
  font-weight:600; font-size:13px; color:var(--ink); }
.btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
.btn.danger { color:var(--danger); border-color:var(--danger); }
a { color:var(--link); text-decoration:none; }
.men { background:var(--men-bg); color:var(--men); border-radius:4px; padding:0 3px; font-weight:600; }
code { font:12.5px ui-monospace, SFMono-Regular, Menlo, monospace; background:var(--tag); padding:1px 4px; border-radius:4px; }
.q { display:block; border-left:3px solid var(--q); padding-left:10px; color:var(--mute); }
.card { margin-top:10px; border-left:3px solid var(--line); padding:2px 0 2px 12px; }
.text { margin-top:2px; }
.after { border-top:1px dashed var(--line); }
.after .lbl { padding:8px 18px 0; font-size:12px; color:var(--mute); }
`;

/** One message (or unfurls under a person's message) on a neutral card, labelled as an illustration. */
function page({ where, from, ephemeral, message, text, unfurls, after, afterLabel }, theme) {
  const person = from !== "Markdrop";
  const head = `<div class="who">${html(from)}<small>${ephemeral ? "only you can see this" : person ? "" : "app"}</small></div>`;
  let body;
  if (unfurls) {
    body = `<div class="text">${text.split(/\s+/).map((u) => `<a href="#">${html(u)}</a>`).join("<br>")}</div>` + unfurls.map((u) => `<div class="card">${blocks(u.blocks)}</div>`).join("");
  } else body = blocks(message.blocks);
  const msg = (inner, h = head, pers = person) =>
    `<div class="msg"><div class="av ${pers ? "person" : ""}">${pers ? html(from[0]) : "M"}</div><div class="body">${h}${inner}</div></div>`;
  const extra = after
    ? `<div class="after"><div class="lbl">${html(afterLabel || "After a click, the message becomes:")}</div>${msg(blocks(after.blocks))}</div>`
    : "";
  return `<!doctype html><html class="${theme === "dark" ? "dark" : ""}"><head><meta charset="utf-8"><style>${CSS}</style></head>
<body><div class="wrap"><div class="illus"><div class="bar"><span class="tag">Illustration</span><span>How Markdrop's message reads in Slack</span>
<span class="where">${html(where)}</span></div>${msg(body)}${extra}</div></div></body></html>`;
}

const illustration = (id, key, opts = {}) => ({
  id: `slack-illus-${id}`,
  page: PAGE,
  name: `illustration-${id}`,
  kind: "screenshot",
  auth: "anon",
  url: "/robots.txt",
  viewport: { width: 760, height: 900 },
  prepare: async (h) => {
    const theme = await h.page.evaluate(() => localStorage.getItem("md_theme") || "light");
    await h.page.setContent(page({ ...P[key], ...opts }, theme), { waitUntil: "load" });
    await h.page.evaluate(() => document.fonts && document.fonts.ready);
    await h.sleep(200);
  },
  crop: { selector: ".illus", pad: 0 },
});

// ── The settings card ─────────────────────────────────────────────────────────

async function api(h, method, p, body, who = "riya") {
  const { token } = await h.sandbox("/__sandbox/mint", { email: h.fx.users[who].email });
  const res = await fetch(`${h.API}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Riya connects Acme to the fake Slack (as Add to Slack does), links her account and picks #meetings. */
async function connectSlack(h) {
  const ws = h.fx.workspace.id;
  const st = await api(h, "GET", `/api/v1/slack/status?workspace_id=${ws}`);
  if (st.status !== 200 || !st.body.configured) throw new Error("start the API with PB_FAKE_SLACK=1 (e2e/pages/real/api_run.py)");
  if (!st.body.install) {
    const { body } = await api(h, "POST", "/api/v1/slack/install", { workspace_id: ws });
    const state = new URL(body.url).searchParams.get("state");
    const r = await api(h, "POST", "/api/v1/slack/connect", { code: "docs-install", state });
    if (r.status !== 200) throw new Error(`connect → ${r.status} ${JSON.stringify(r.body)}`);
  }
  await api(h, "PATCH", "/api/v1/slack/settings", { workspace_id: ws, meetings_channel_id: "C2", post_meetings: true });
  const me = await api(h, "GET", `/api/v1/slack/status?workspace_id=${ws}`);
  if (!me.body.me.linked) {
    const { body } = await api(h, "POST", "/api/v1/slack/link/start", { workspace_id: ws });
    const state = new URL(body.url).searchParams.get("state");
    await api(h, "POST", "/api/v1/slack/link/finish", { code: "riya", state });
  }
}

const settingsUrl = (fx) => `/settings/workspaces/${fx.workspace.id}?tab=integrations`;

export default [
  {
    id: "slack-card-connected",
    page: PAGE,
    name: "card-connected",
    kind: "screenshot",
    auth: "owner",
    url: settingsUrl,
    prepare: async (h) => {
      await connectSlack(h);
      await h.page.reload();
      await h.loc("[data-testid='slack-card']").waitFor({ timeout: 30000 });
      await h.loc("[data-testid='slack-me']").waitFor({ timeout: 30000 });
      await h.settle(500);
      await h.page.mouse.move(5, 5);
    },
    crop: { selector: "[data-testid='slack-card']", pad: 12 },
  },
  {
    id: "slack-card-not-set-up",
    page: PAGE,
    name: "card-not-set-up",
    kind: "screenshot",
    auth: "owner",
    url: settingsUrl,
    prepare: async (h) => {
      // The card as production showed it before the Slack app existed: the status route says so.
      await h.page.route(/\/api\/v1\/slack\/status\?/, async (route) => {
        const r = await route.fetch();
        const b = await r.json();
        await route.fulfill({ response: r, json: { ...b, configured: false, install: null, me: { ...b.me, linked: false } } });
      });
      await h.page.reload();
      await h.loc("[data-testid='slack-card']").waitFor({ timeout: 30000 });
      await h.loc({ text: "Not set up yet" }).waitFor({ timeout: 30000 });
      await h.settle(500);
      await h.page.mouse.move(5, 5);
    },
    crop: { selector: "[data-testid='slack-card']", pad: 12 },
  },
  illustration("meeting-post", "meeting_post"),
  illustration("search", "search"),
  illustration("ask", "ask"),
  illustration("meetings-ask", "meetings_ask"),
  illustration("unfurl", "unfurl"),
  illustration("dm-mention", "dm_mention"),
  illustration("dm-access-request", "dm_access_request", { afterLabel: "After Approve, the message says who decided:" }),
];
