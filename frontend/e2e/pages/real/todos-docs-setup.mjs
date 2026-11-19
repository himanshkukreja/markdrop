/**
 * To-dos on top of the Teams docs world (teams-docs-setup.mjs; run that first): two customer calls in Sales with
 * action items for Alex Chen (Northwind, Globex: their attendees' email domains), and a Sales page whose task lines
 * @mention Alex. Alex's to-do page is made (Create my to-dos), then one more page task is written straight to the
 * store, so "Refresh to-dos" has something to add (the docs' refresh shot). Riya has none (todos.mjs makes it).
 *
 *   PB_STACK_ID=… PB_WORK=… node teams-docs-setup.mjs && PB_STACK_ID=… PB_WORK=… node todos-docs-setup.mjs
 *   STACK_ID=… DOCS_MEDIA_DATA=$PB_WORK/stack/data npm run docs:media -- todos-page todos-refresh
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { STACK, STACK_ID, api, fail, log, seedNow } from "./lib.mjs";

const S = seedNow();
const fxPath = path.join(STACK, "data", String(STACK_ID), "fixtures.json");
const fx = JSON.parse(fs.readFileSync(fxPath, "utf8"));
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = fx.workspace.id;
const SALES = fx.teams.sales.id;
const base = `/api/v1/workspaces/${WS}`;
const ALEX = fx.users.member.id;
const ok = (r, what) => { if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const PY = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../backend/.venv/bin/python");
const DB = STACK_ID ? `markdrop_docs_demo_${STACK_ID}` : "markdrop_docs_demo";
const mongo = (code) => execFileSync(PY, ["-c", `import pymongo, json\nfrom bson import ObjectId\nc=pymongo.MongoClient("mongodb://127.0.0.1:27019")["${DB}"]\n${code}`], { encoding: "utf8" });

// Customer calls in Sales: "will" lines become their speaker's action items (the fake meetings model).
const call = async (title, date, lines, domain, guest) => {
  const r = ok(await api("POST", "/api/v1/meetings/import", T.owner, {
    workspace: WS, wait: true, date, title, restricted: false, team_ids: [SALES],
    sources: [{ name: `${title} - Transcript`, text: `${title} - Transcript\nAttendees\n${[...new Set(lines.map((l) => l.split(":")[0]))].join(", ")}\nTranscript\n${lines.join("\n")}\nTranscription ended after 00:30:00\n` }],
  }), title);
  const m = r.meetings[0];
  mongo(`c["meetings"].update_one({"_id": ObjectId("${m.id}")}, {"$push": {"attendees": {"name": "${guest}", "email": "${guest.split(" ")[0].toLowerCase()}@${domain}"}}})`);
  return m;
};
await call("Northwind renewal call", day(3), [
  "Riya Sharma: Thanks for making time, Grace.",
  "Grace Lee: We need SSO and a second workspace before we sign.",
  "Alex Chen: I will send Northwind the SSO pricing by Friday.",
  "Alex Chen: I will book the security review with their IT team.",
  "Riya Sharma: Great, talk next week.",
], "northwind.com", "Grace Lee");
await call("Globex intro", day(1), [
  "Hana Kim: Welcome, Tom.",
  "Tom Reyes: Could you show us how Teams works?",
  "Alex Chen: I will share two customer references with Tom.",
  "Hana Kim: I will set up the demo workspace.",
], "globex.com", "Tom Reyes");

// A Sales page with tasks that @mention Alex (the editor anchors a block when a person is mentioned in it).
const who = (id, name) => `:person[${name}]{id="${id}"}`;
const content = [
  "The renewals we close before the 9 December launch, and who does what.",
  "",
  "## This week",
  "",
  `- [ ] Update the Q4 renewal forecast ${who(ALEX, "Alex Chen")} · due Friday {#b-td0001}`,
  `- [ ] Draft the Northwind order form ${who(ALEX, "Alex Chen")} {#b-td0002}`,
  `- [ ] Review the discount approvals ${who(fx.users.riya.id, "Riya Sharma")} {#b-td0003}`,
  "",
].join("\n");
const page = ok(await api("POST", "/api/v1/pages", T.owner, { title: "Q4 renewals tracker", workspace: WS, content, auto_cover: false }), "tracker").document;
ok(await api("PUT", `${base}/items/${page.slug}/teams`, T.owner, { team_ids: [SALES], project_ids: [] }), "tracker → Sales");

// Alex's to-do page (Create my to-dos), then one task the page's save never announced: Refresh picks it up.
const made = ok(await api("POST", `${base}/teams/${SALES}/todos/mine`, T.member), "create Alex's to-dos");
log("Alex's to-dos", made);
mongo(`d = c["documents"].find_one({"slug": "${page.slug}"})
c["documents"].update_one({"_id": d["_id"]}, {"$set": {"content": d["content"].rstrip("\\n") + "\\n- [ ] Send the renewal deck to Northwind :person[Alex Chen]{id=\\"${ALEX}\\"} · due Monday {#b-td0004}\\n"}})`);
// Riya (Sales' lead) has no to-do page yet: todos.mjs creates hers from the Overview.
mongo(`c["todo_pages"].delete_many({"user_id": "${fx.users.riya.id}", "team_id": "${SALES}"})`);
mongo(`print(c["documents"].update_many({}, {"$set": {"demo_seed": True}}).modified_count, "documents kept")`);

fx.todos = { page: page.slug, alex: made.slug };
fs.writeFileSync(fxPath, JSON.stringify(fx, null, 1));
log("fixtures", fxPath);
