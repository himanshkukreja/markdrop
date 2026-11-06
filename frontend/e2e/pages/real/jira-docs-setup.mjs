/**
 * The world for the Jira docs media (scripts/docs-media/shots/l-jira.mjs), on top of what jira.mjs leaves
 * behind (the site connected with PAY and WEB on Team, Ben and Vic connected, "Payments planning" with its
 * issues, Team on):
 *
 *   - "Checkout launch sync": a meeting whose action items have no issue yet (the create and bulk dialogs);
 *   - every document marked demo_seed, so capture.mjs's per-shot cleanup keeps this world;
 *   - $PB_WORK/stack/data/$PB_STACK_ID/fixtures.json for capture.mjs (users by the names the shots use).
 *
 *   PB_FAKE_JIRA=1 PB_FAKE_MEETINGS_AI=1 PB_STACK_ID=67 PB_WORK=… zsh up.sh start
 *   PB_STACK_ID=67 PB_WORK=… node jira.mjs && PB_STACK_ID=67 PB_WORK=… node jira-docs-setup.mjs
 *   STACK_ID=67 DOCS_MEDIA_DATA=$PB_WORK/stack/data npm run docs:media -- jira-card-connected …
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { API, STACK, STACK_ID, api, fail, log, seedNow } from "./lib.mjs";

const S = seedNow();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = S.ws;
const ok = (r, what) => { if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

const st = ok(await api("GET", `/api/v1/jira/status?workspace_id=${WS}`, T.owner), "status");
if (!st.site?.projects?.length) fail("run jira.mjs first (no Jira site with Team projects)");

const title = "Checkout launch sync";
const have = ok(await api("GET", `/api/v1/meetings?workspace=${WS}&q=${encodeURIComponent(title)}`, T.owner), "list").meetings;
if (!have.length) {
  const lines = [
    "Ada Owner: Quick sync on the checkout launch.",
    "Ben Member: I will add retries to the card payment webhook due 2026-11-20.",
    "Wes Admin: I will update the refund policy page before launch.",
    "Ada Owner: We agree to keep the old checkout as a fallback for a week.",
    "Wes Admin: Do we need a status page entry for the launch?",
  ];
  ok(await api("POST", "/api/v1/meetings/import", T.owner, {
    workspace: WS, wait: true, date: day(0), title, restricted: false,
    sources: [{ name: `${title} - Transcript`, text: `${title} - Transcript\nAttendees\nAda Owner, Ben Member, Wes Admin\nTranscript\n${lines.join("\n")}\nTranscription ended after 00:11:00\n` }],
  }), "import");
  log("imported", title);
}

const PY = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../backend/.venv/bin/python");
const db = STACK_ID ? `markdrop_docs_demo_${STACK_ID}` : "markdrop_docs_demo";
execFileSync(PY, ["-c", `import pymongo; c=pymongo.MongoClient("mongodb://127.0.0.1:27019"); print(c["${db}"]["documents"].update_many({}, {"$set": {"demo_seed": True}}).modified_count, "documents kept")`], { stdio: "inherit" });

const users = {
  riya: { email: "ada@acme.test", name: "Ada Owner", id: S.users.owner.id },
  admin: { email: "wes@acme.test", name: "Wes Admin", id: S.users.admin.id },
  member: { email: "ben@acme.test", name: "Ben Member", id: S.users.member.id },
  reader: { email: "vic@acme.test", name: "Vic Viewer", id: S.users.reader.id },
};
const dir = path.join(STACK, "data", String(STACK_ID));
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "fixtures.json"), JSON.stringify({
  demo_now: new Date().toISOString(), users, workspace: { id: WS, name: "Acme" },
}, null, 1));
log("fixtures", path.join(dir, "fixtures.json"), "API", API);
