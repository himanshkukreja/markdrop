/**
 * The world for the Team + Meetings docs media (scripts/docs-media/shots/k-team-meetings.mjs), on top of what
 * team.mjs leaves behind (ONLY=enable,board,own,groups,week):
 *
 *   - "Weekly product sync": Gemini's notes (Invited: seven people) + the transcript (Attendees: four), so the
 *     meeting's details show Attendees and "Invited · 7";
 *   - Ada connects Google Meet (script v4): one run reported (found 3, sent 2, 1 waiting for Gemini's notes),
 *     and Check now turned on (the fake web app: PB_FAKE_MEET_SCRIPT=1 in api_run.py);
 *   - every document marked demo_seed, so capture.mjs's per-shot cleanup keeps this world;
 *   - $PB_WORK/stack/data/$PB_STACK_ID/fixtures.json for capture.mjs (users by the names the shots use).
 *
 *   PB_STACK_ID=66 PB_WORK=… NO_RESEED=1 node team-meetings-docs-setup.mjs
 *   STACK_ID=66 DOCS_MEDIA_DATA=$PB_WORK/stack/data npm run docs:media -- team-board team-this-week …
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { API, STACK, STACK_ID, WORK, api, fail, log, seedNow } from "./lib.mjs";

const S = seedNow();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = S.ws;
const ok = (r, what) => { if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

// Team members team.mjs made (Priya, Raj, Mei).
const board = ok(await api("GET", `/api/v1/team/${WS}`, T.admin), "board");
const people = Object.fromEntries(board.people.map((p) => [p.name, p]));
for (const n of ["Priya Shah", "Raj Patel", "Mei Lin"]) if (!people[n]) fail(`run team.mjs first (${n} missing)`);

// ── Weekly product sync: Gemini's notes + transcript; invited ≠ attended ────────────────────────────
const sync = "Weekly product sync";
const have = ok(await api("GET", `/api/v1/meetings?workspace=${WS}&q=${encodeURIComponent(sync)}`, T.owner), "list").meetings;
if (!have.length) {
  const date = day(1);
  const notes = `# ${sync}
${date}
Invited Ada Owner <ada@acme.test>, Ben Member <ben@acme.test>, Priya Shah <priya@acme.test>, Raj Patel <raj@acme.test>, Mei Lin <mei@acme.test>, Wes Admin <wes@acme.test>, Vic Viewer <vic@acme.test>
Attachments ${sync}
Meeting records Transcript

## Summary
Ada Owner, Ben Member, Priya Shah and Raj Patel agreed to ship saved searches for sourcing on Friday if the staging dry run passes, and to hold the billing export until the API keys arrive.

## Details
- **Saved searches**: Ben Member showed saved searches behind a flag; QA signed off (00:01:10).
- **Billing export**: Priya Shah is still waiting on Raj Patel for the API keys (00:04:20).

## Suggested next steps
- [ ] Ben Member will turn on saved searches for the Senseloaf pilot on Friday.
- [ ] Raj Patel will send Priya Shah the new API keys by tomorrow.
- [ ] Mei Lin will share the onboarding checklist mockups by Thursday.
`;
  const tr = `${sync} (${date} 10:00 GMT+05:30) - Transcript
Attendees
Ada Owner, Ben Member, Priya Shah, Raj Patel
Transcript
00:00:00
Ada Owner: Two things today: saved searches and the billing export.
Ben Member: Saved searches are behind a flag and QA signed off, so I can turn them on for the Senseloaf pilot on Friday.
Priya Shah: The billing export is still blocked, I'm waiting on Raj Patel for the API keys.
Raj Patel: Sorry, I'll send you the new keys by tomorrow.
Ada Owner: Great. Mei couldn't join; she'll share the onboarding mockups by Thursday.
Transcription ended after 00:12:30
`;
  const r = ok(await api("POST", "/api/v1/meetings/import", T.owner, {
    workspace: WS, wait: true, restricted: false,
    sources: [{ name: `${sync} - ${date} - Notes by Gemini`, text: notes }, { name: `${sync} (${date} 10:00 GMT+05:30) - Transcript`, text: tr }],
  }), "weekly sync");
  log("weekly sync", r.meetings.map((m) => `${m.title} ${m.slug}`).join(", "));
} else log("weekly sync already there");

// ── Ada connects Google Meet: a v4 run with one meeting waiting, Check now on ───────────────────────
let conn = ok(await api("GET", `/api/v1/meetings/connection?workspace=${WS}`, T.owner), "connection");
if (!conn.connection) {
  const made = ok(await api("POST", "/api/v1/meetings/connection", T.owner, { workspace: WS, include_shared: true, backfill_days: 0, tz: "Asia/Kolkata" }), "connect");
  const token = made.token;
  if (!token) fail("no token in the script");
  fs.writeFileSync(path.join(STACK, "meet-token.txt"), token);
  const status = (body) => api("POST", "/api/v1/meetings/inbox/status", token, body);
  ok(await status({ phase: "start", version: 4 }), "status start");
  // One meeting the script brought in (so the line says when it last imported), marked Auto.
  const d = day(0);
  ok(await api("POST", "/api/v1/meetings/inbox", token, {
    source: "google-meet-script", version: 4, file_id: "docs-media-mobile-sync-auto", kind_hint: "transcript", created: `${d}T04:00:00Z`,
    title: `Mobile sync (${d} 09:30 GMT+05:30) - Transcript`,
    text: `Mobile sync (${d} 09:30 GMT+05:30) - Transcript\nAttendees\nAda Owner, Raj Patel, Ben Member\nTranscript\n00:00:00\nRaj Patel: Working on: push notifications for the mobile app.\nBen Member: Done: saved searches behind a flag.\nAda Owner: Thanks both.\nTranscription ended after 00:06:00\n`,
  }), "auto delivery");
  ok(await status({ phase: "done", version: 4, mode: "sync", include_shared: true, lookback_hours: 48, found: 3, sent: 2,
    results: { imported: 1, attached: 0, duplicate: 1, not_ready: 1 }, skipped: { already_sent: 4, title: 2 }, search: "drive",
    remaining: 0, shared_drives: "on" }), "status done");
}
conn = ok(await api("GET", `/api/v1/meetings/connection?workspace=${WS}`, T.owner), "connection");
log("connection", JSON.stringify({ script: conn.connection?.script?.results, check_now: conn.connection?.check_now }));

// ── Keep it all through capture.mjs's cleanup; fixtures for capture.mjs ────────────────────────────
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
  team: { raj: people["Raj Patel"].id, mei: people["Mei Lin"].id, priya: people["Priya Shah"].id },
}, null, 1));
log("fixtures", path.join(dir, "fixtures.json"), "API", API, "WORK", WORK);
