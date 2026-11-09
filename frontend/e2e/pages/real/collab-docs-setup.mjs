/**
 * The world for the Collaboration docs media (scripts/docs-media/shots/m-collab.mjs): comments, suggested
 * edits, notifications, Home "waiting on you", Jira in pages. Realistic demo content, no real people:
 * Riya Sharma (owner), Alex Chen (member), Sam Lee (admin), Maya Patel (workspace viewer) at Acme.
 *
 *   PB_DOCS_WORLD=1 PB_FAKE_COMMENTS_AI=1 PB_FAKE_JIRA=1 PB_STACK_ID=45 PB_WORK=… zsh up.sh start
 *   PB_STACK_ID=45 PB_WORK=… node collab-docs-setup.mjs
 *   STACK_ID=45 DOCS_MEDIA_DATA=$PB_WORK/stack/data npm run docs:media -- <collab-… ids>
 *
 * Reseeds (seed.py), renames the people, connects the fake Jira for Riya and Alex, makes the pages and
 * threads (all marked demo_seed so capture.mjs's per-shot cleanup keeps them) and writes
 * $PB_WORK/stack/data/<PB_STACK_ID>/fixtures.json for capture.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { API, STACK, STACK_ID, api, fail, log, reseed } from "./lib.mjs";

const S = reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const ID = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.id]));
const WS = S.ws;
const ok = (r, what) => { if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };

const NAMES = { owner: "Riya Sharma", member: "Alex Chen", admin: "Sam Lee", reader: "Maya Patel", stranger: "Jordan Blake" };
const PY = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../backend/.venv/bin/python");
const DB = STACK_ID ? `markdrop_docs_demo_${STACK_ID}` : "markdrop_docs_demo";
const mongo = (code) => execFileSync(PY, ["-c", `import pymongo, json\nfrom bson import ObjectId\nc=pymongo.MongoClient("mongodb://127.0.0.1:27019")["${DB}"]\n${code}`], { encoding: "utf8" });

// People: the demo cast's names everywhere Markdrop shows them.
mongo(`names=json.loads('${JSON.stringify(Object.fromEntries(Object.entries(NAMES).map(([k, n]) => [ID[k], n])))}')
for uid, n in names.items():
    c["users"].update_one({"_id": ObjectId(uid)}, {"$set": {"name": n}})
    c["memberships"].update_many({"user_id": uid}, {"$set": {"name": n}})
c["workspaces"].update_one({"_id": ObjectId("${WS}")}, {"$set": {"name": "Acme"}})`);
log("renamed", Object.values(NAMES).join(", "));

// Jira: the fake site (PB_FAKE_JIRA=1, PB_DOCS_WORLD=1 names), Riya and Alex connected.
ok(await api("POST", "/__sandbox/jira/reset"), "reset the fake Jira");
const ACC = { owner: "acc-ada", member: "acc-ben", admin: "acc-wes", reader: "acc-vic" };
async function connect(who) {
  const { url } = ok(await api("POST", "/api/v1/jira/connect/start", T[who], { kind: "me", workspace_id: WS }), `start ${who}`);
  const state = new URL(url).searchParams.get("state");
  ok(await api("POST", "/api/v1/jira/connect/finish", T[who], { code: `code-${ACC[who]}`, state }), `finish ${who}`);
}
await connect("owner");
ok(await api("PUT", "/api/v1/jira/site", T.owner, { workspace_id: WS, cloud_id: "cloud-acme", projects: ["PAY", "WEB"], default_project: "PAY", default_issue_type: "Task" }), "site");
await connect("member");

// The pages.
const PLAN = `We launch the new checkout on Tuesday 18 November, once QA signs off on the payment flows. The old checkout stays available as a fallback for one week.

## Rollout

Rollout happens in three waves: our own team first, then 10% of customers, then everyone. Each wave runs for two days before the next one starts.

- Card retries ship with :jira[PAY-1] before the first wave
- The refund flow for annual plans follows in the second wave
- Apple Pay joins in the second wave

## Risks

The billing webhooks still point at the old service. If they fail, invoices stop until someone switches them back by hand.

::jira{key=PAY-2}

## Open work

::jira-list{project=PAY cols="status,assignee,priority,due" title="Payments work"}

## Support

Support gets the new help article two days before the first wave, with screenshots of every step.
`;

const NOTES = `The new pricing page shows three plans side by side, with the annual price first. Every plan lists what's included in plain words, without footnotes.

## Copy

Our headline says what the product does in one sentence. The plan names stay the same so existing customers recognise them.

## Launch

We publish the new page with the checkout launch, and keep the old one at its address for a week.
`;

async function page(title, content, who = "owner") {
  const r = ok(await api("POST", "/api/v1/pages", T[who], { title, workspace: WS, folder: S.folder, content, auto_cover: false }), `page ${title}`);
  return r.document.slug;
}
const plan = await page("Checkout redesign: launch plan", PLAN);
const pricing = await page("Pricing page refresh", NOTES);

const C = (slug) => `/api/v1/documents/${slug}/comments`;
const text = (exact) => ({ type: "text", quote: { exact } });
async function threadId(slug, who, anchor, body, extra = {}) {
  const r = ok(await api("POST", C(slug), T[who], { anchor, body, ...extra }), `thread ${body.slice(0, 20)}`);
  return (r.thread || r).id;
}
async function reply(slug, tid, who, body, extra = {}) {
  return ok(await api("POST", `${C(slug)}/${tid}/replies`, T[who], { body, ...extra }), `reply ${body.slice(0, 20)}`);
}

// 1. Alex asks who signs off, mentioning Riya; Riya answers; Alex thanks with a reaction.
const t1 = await threadId(plan, "member", text("once QA signs off on the payment flows"),
  "@Riya Sharma can we name who signs off? Otherwise this could slip.", { mentions: [ID.owner] });
const r1 = await reply(plan, t1, "owner", "Sam owns the QA sign-off. @Sam Lee can you confirm Monday works?", { mentions: [ID.admin] });
await reply(plan, t1, "admin", "Monday works. I'll post the results here.");
const firstMsg = ok(await api("GET", `${C(plan)}/${t1}`, T.member), "t1").messages?.[1] ?? r1.message;
if (firstMsg?.id) ok(await api("POST", `${C(plan)}/${t1}/messages/${firstMsg.id}/reactions`, T.member, { emoji: "👍" }), "react");

// 2. Sam suggests two waves instead of three; Alex asks Riya to accept (waiting on Riya).
const t2 = await threadId(plan, "admin", text("three waves: our own team first, then 10% of customers, then everyone"),
  "Two waves is enough for a change this size.", { suggestion: "two waves: our own team first, then everyone" });
await reply(plan, t2, "member", "Agreed. @Riya Sharma can you accept this one?", { mentions: [ID.owner] });

// 3. Maya on the risks paragraph, assigned to Alex.
const t3 = await threadId(plan, "reader", { type: "block", block_text: "The billing webhooks still point at the old service." },
  "Do we have a runbook for switching the webhooks back?", { assignee: ID.member });

// 4. A comment on the page as a whole.
await threadId(plan, "owner", { type: "page" }, "Reads well overall. Let's lock this by Friday so support has time to prepare.");

// 5. On the pricing page: Riya asks Alex, assigned to Riya (her Home's action items).
await threadId(pricing, "member", text("with the annual price first"), "Should monthly come first for new visitors?", { assignee: ID.owner });
await threadId(pricing, "admin", text("without footnotes"), "Legal asked for one footnote about taxes. @Riya Sharma okay with that?", { mentions: [ID.owner] });

// Keep everything through capture.mjs's per-shot cleanup.
mongo(`print(c["documents"].update_many({}, {"$set": {"demo_seed": True}}).modified_count, "documents kept")`);

const users = {
  riya: { email: "ada@acme.test", name: NAMES.owner, id: ID.owner },
  member: { email: "ben@acme.test", name: NAMES.member, id: ID.member },
  admin: { email: "wes@acme.test", name: NAMES.admin, id: ID.admin },
  reader: { email: "vic@acme.test", name: NAMES.reader, id: ID.reader },
  stranger: { email: "cy@else.test", name: NAMES.stranger, id: ID.stranger },
};
const dir = path.join(STACK, "data", String(STACK_ID));
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "fixtures.json"), JSON.stringify({
  demo_now: new Date().toISOString(), users, workspace: { id: WS, name: "Acme", folder: S.folder },
  collab: { plan, pricing, threads: { signoff: t1, waves: t2, runbook: t3 } },
}, null, 1));
log("fixtures", path.join(dir, "fixtures.json"), "API", API, "plan", plan, "pricing", pricing);
