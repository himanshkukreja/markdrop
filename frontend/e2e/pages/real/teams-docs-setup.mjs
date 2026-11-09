/**
 * The world for the Teams docs media (scripts/docs-media/shots/n-teams.mjs). Realistic demo content, no real people:
 * Riya Sharma (owner), Alex Chen (member), Sam Lee (admin), Maya Patel (viewer), plus Priya Nair, Diego Alvarez and
 * Hana Kim at Acme. Teams: Sales (private; Riya leads, Alex, Hana), Marketing (open; Diego leads, Maya, Riya) and
 * Engineering (open; Sam leads, Priya, Alex); a "Q4 launch" project shared by all three; pages in each team and
 * company-wide; two meetings routed from their attendees; Team memory on and read; a Sales brief.
 *
 *   PB_DOCS_WORLD=1 PB_FAKE_MEETINGS_AI=1 PB_FAKE_TEAM_AI=1 PB_FAKE_ASK_AI=1 PB_STACK_ID=17 PB_WORK=… zsh up.sh start
 *   PB_STACK_ID=17 PB_WORK=… node teams-docs-setup.mjs
 *   STACK_ID=17 DOCS_MEDIA_DATA=$PB_WORK/stack/data npm run docs:media -- <teams-… ids>
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { STACK, STACK_ID, api, fail, log, reseed } from "./lib.mjs";

const S = reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const ID = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.id]));
const WS = S.ws;
const base = `/api/v1/workspaces/${WS}`;
const ok = (r, what) => { if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

const NAMES = { owner: "Riya Sharma", member: "Alex Chen", admin: "Sam Lee", reader: "Maya Patel", stranger: "Jordan Blake" };
const PY = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../backend/.venv/bin/python");
const DB = STACK_ID ? `markdrop_docs_demo_${STACK_ID}` : "markdrop_docs_demo";
const mongo = (code) => execFileSync(PY, ["-c", `import pymongo, json\nfrom bson import ObjectId\nc=pymongo.MongoClient("mongodb://127.0.0.1:27019")["${DB}"]\n${code}`], { encoding: "utf8" });

mongo(`names=json.loads('${JSON.stringify(Object.fromEntries(Object.entries(NAMES).map(([k, n]) => [ID[k], n])))}')
for uid, n in names.items():
    c["users"].update_one({"_id": ObjectId(uid)}, {"$set": {"name": n}})
    c["memberships"].update_many({"user_id": uid}, {"$set": {"name": n}})
c["workspaces"].update_one({"_id": ObjectId("${WS}")}, {"$set": {"name": "Acme"}})`);
// More people.
for (const [k, email, name] of [["priya", "priya@acme.test", "Priya Nair"], ["diego", "diego@acme.test", "Diego Alvarez"], ["hana", "hana@acme.test", "Hana Kim"]]) {
  const u = ok(await api("POST", "/__sandbox/user", null, { email, name }), name);
  ok(await api("POST", "/__sandbox/team-memory/member", null, { workspace_id: WS, user_id: u.id, role: "member" }), "member");
  T[k] = u.token; ID[k] = u.id;
}
const wsNow = ok(await api("GET", base, T.owner), "ws");
ok(await api("PUT", base, T.owner, { name: "Acme", settings: { ...(wsNow.settings || {}), team_memory: true, timezone: "UTC" } }), "team memory on");

// The teams.
const team = async (body) => ok(await api("POST", `${base}/teams`, T.owner, body), body.name);
const sales = await team({ name: "Sales", icon: "💼", color: "green", visibility: "private", description: "Pipeline, renewals and customer calls.",
  lead_ids: [ID.owner], member_ids: [ID.owner, ID.member, ID.hana] });
const marketing = await team({ name: "Marketing", icon: "📣", color: "pink", visibility: "open", description: "Campaigns, launches and the website.",
  lead_ids: [ID.diego], member_ids: [ID.diego, ID.reader, ID.owner] });
const eng = await team({ name: "Engineering", icon: "🛠", color: "blue", visibility: "open", description: "Product, platform and on-call.",
  lead_ids: [ID.admin], member_ids: [ID.admin, ID.priya, ID.member] });

// Pages: each team's, and company-wide.
const page = async (who, title, content, teamId) => {
  const d = ok(await api("POST", "/api/v1/pages", T[who], { title, workspace: WS, content, auto_cover: false }), title).document;
  if (teamId) ok(await api("PUT", `${base}/items/${d.slug}/teams`, T[who], { team_ids: [teamId], project_ids: [] }), `${title} → team`);
  return d.slug;
};
const playbook = await page("owner", "Q4 pricing playbook", "How we price renewals and new deals this quarter.\n\n## Discounts\n\nUp to 15% for two-year renewals; anything more needs Riya's sign-off.\n", sales.id);
await page("member", "Northwind renewal notes", "Northwind renews on 1 December. They want SSO and a second workspace.\n", sales.id);
await page("hana", "Enterprise demo script", "The 20-minute demo: workspaces, Teams, then Ask.\n", sales.id);
await page("diego", "Launch campaign brief", "The Q4 launch campaign: one landing page, three emails, a webinar on 4 December.\n", marketing.id);
await page("diego", "Brand voice guide", "Short sentences. Say what it does. No jargon.\n", marketing.id);
await page("admin", "Checkout API runbook", "Deploys, rollbacks and who's on call for the checkout API.\n", eng.id);
await page("priya", "Q4 platform roadmap", "SSO for every plan, faster search, and the new importer.\n", eng.id);
const holidays = await page("member", "Company holidays 2026", "Everyone gets 24 December to 1 January off.\n");
await page("owner", "Expense policy", "Book travel through the portal. Meals up to $60 a day.\n");

// The cross-team project.
const q4 = ok(await api("POST", `${base}/projects`, T.owner, { name: "Q4 launch", icon: "🚀", color: "violet",
  team_ids: [sales.id, marketing.id, eng.id], description: "Everything for the 9 December launch." }), "q4");
await page("owner", "Q4 launch plan", "We launch on 9 December. Sales briefs customers, Marketing runs the campaign, Engineering ships SSO.\n");
const launchPlan = ok(await api("GET", `${base}/items?folder=all&q=Q4%20launch%20plan`, T.owner), "find plan").items?.[0]?.slug;
if (launchPlan) ok(await api("PUT", `${base}/items/${launchPlan}/teams`, T.owner, { team_ids: [], project_ids: [q4.id] }), "plan → project");

// Meetings, routed from their attendees (no team_ids: the suggestion is applied).
const meeting = (who, title, date, lines) => api("POST", "/api/v1/meetings/import", T[who], {
  workspace: WS, wait: true, date, title, restricted: false,
  sources: [{ name: `${title} - Transcript`, text: `${title} - Transcript\nAttendees\n${[...new Set(lines.map((l) => l.split(":")[0]))].join(", ")}\nTranscript\n${lines.join("\n")}\nTranscription ended after 00:25:00\n` }],
});
ok(await meeting("owner", "Sales pipeline review", day(2), [
  "Riya Sharma: Decision: two-year renewals get up to 15% off, no more.",
  "Alex Chen: Done: sent Northwind the SSO proposal. Working on: the Northwind renewal. Target: signed renewal by Friday.",
  "Hana Kim: Working on: the enterprise demo script. Blocked: the demo workspace needs SSO (waiting on Priya Nair).",
]), "sales meeting");
ok(await meeting("diego", "Q4 launch sync", day(1), [
  "Diego Alvarez: Working on: the launch landing page. Target: campaign emails ready by 2 December.",
  "Riya Sharma: Decision: Sales briefs the top 20 customers before the webinar.",
  "Sam Lee: Done: SSO behind a flag for all plans. Working on: the importer.",
  "Maya Patel: Working on: the webinar slides.",
]), "launch meeting");
ok(await api("POST", "/__sandbox/team-memory/run"), "team memory");

// The Sales brief: drafted, then a few lines the lead wrote.
const br = ok(await api("POST", `${base}/teams/${sales.id}/briefs/draft`, T.owner), "draft");
for (const [kind, text] of [["shipped", "Sent Northwind the SSO proposal; renewal due Friday."], ["decision", "Two-year renewals get up to 15% off, no more."],
  ["blocker", "The enterprise demo workspace needs SSO (waiting on Engineering)."], ["focus", "Brief the top 20 customers before the 4 December webinar."]]) {
  ok(await api("POST", `${base}/teams/${sales.id}/briefs/${br.id}/lines`, T.owner, { text, kind }), "brief line");
}
for (const t of [marketing, eng]) ok(await api("POST", `${base}/teams/${t.id}/briefs/draft`, T.admin), "brief");

mongo(`print(c["documents"].update_many({}, {"$set": {"demo_seed": True}}).modified_count, "documents kept")`);

const users = {
  riya: { email: "ada@acme.test", name: NAMES.owner, id: ID.owner },
  member: { email: "ben@acme.test", name: NAMES.member, id: ID.member },
  admin: { email: "wes@acme.test", name: NAMES.admin, id: ID.admin },
  reader: { email: "vic@acme.test", name: NAMES.reader, id: ID.reader },
  stranger: { email: "cy@else.test", name: NAMES.stranger, id: ID.stranger },
  priya: { email: "priya@acme.test", name: "Priya Nair", id: ID.priya },
};
const dir = path.join(STACK, "data", String(STACK_ID));
fs.mkdirSync(dir, { recursive: true });
const ref = (t) => ({ id: t.id, slug: t.slug });
fs.writeFileSync(path.join(dir, "fixtures.json"), JSON.stringify({
  demo_now: new Date().toISOString(), users, workspace: { id: WS, name: "Acme", folder: S.folder },
  teams: { sales: ref(sales), marketing: ref(marketing), eng: ref(eng), q4: ref(q4), playbook, holidays },
}, null, 1));
log("fixtures", path.join(dir, "fixtures.json"));
