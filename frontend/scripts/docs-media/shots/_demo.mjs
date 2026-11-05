/**
 * Helpers for the shot files that need more of the demo world than seed.py makes (pages, meetings):
 * REST calls as a demo user, a demo meeting transcript with the demo people, and pages made on demand.
 * No shots here (capture.mjs reads every file in shots/; this one exports none).
 *
 * Meetings and the assistant need the AI fakes: start the sandbox API through
 * e2e/pages/real/api_run.py with PB_FAKE_MEETINGS_AI=1 PB_FAKE_ASK_AI=1 PB_FAKE_PAGES_AI=1
 * PB_FAKE_SEARCH_AI=1 (and PB_FAKE_SLACK=1 for the Slack card), as REPORT/notes describe.
 */

const tokens = new Map();

/** REST as a demo user (riya by default) → {status, body}. */
export async function api(h, method, p, body, who = "riya") {
  if (!tokens.has(who)) tokens.set(who, (await h.sandbox("/__sandbox/mint", { email: h.fx.users[who].email })).token);
  const res = await fetch(`${h.API}${p}`, {
    method,
    headers: { authorization: `Bearer ${tokens.get(who)}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

export async function ok(h, method, p, body, who) {
  const r = await api(h, method, p, body, who);
  if (r.status >= 300) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
}

/** A Google Meet transcript (the format the parser reads) with the demo world's people. */
export function transcript({ title = "Weekly product sync", date = "2026-11-04", time = "10:00", organizer = "Riya Sharma" } = {}) {
  return `${title} (${date} ${time} GMT+05:30) - Transcript
Attendees
Riya Sharma, Alex Chen, Maya Patel, Sam Lee
${organizer ? `Hosted by ${organizer}\n` : ""}Transcript
This editable transcript was computer generated and might contain errors. People can also change the text after it was created.
Riya Sharma: Okay, let's get started. Three things today: the release date, the onboarding checklist, and the pricing page.
Alex Chen: QA signed off on the 2.5 build last night, so I think we can ship on Friday.
Maya Patel: I agree, but the migration still needs one more dry run on staging. I'll do it tomorrow morning.
Riya Sharma: Great. Then let's decide: we ship 2.5 on Friday if the staging dry run passes tomorrow.
Sam Lee: One question, do we tell the Globex team before or after the release?
Riya Sharma: Before. Sam, can you email them by Thursday with the release notes?
Sam Lee: Yes, I'll do that.
00:05:00
Alex Chen: Next, the onboarding checklist. The screenshots in the guide are from the old UI.
Maya Patel: I can redo the screenshots this week.
Riya Sharma: Alex, can you update the onboarding guide with Maya's screenshots by next Wednesday?
Alex Chen: Sure, I'll take it.
00:10:00
Riya Sharma: Last thing, the pricing page. Do we show the annual discount or not?
Sam Lee: I'm not sure yet, finance hasn't confirmed the numbers. Let's park that until we hear back.
Riya Sharma: Agreed, we decide the annual discount next week.
`;
}

// Every shot starts with /__sandbox/cleanup (capture.mjs), which deletes what earlier shots made:
// nothing made here is kept between shots.

/** Imports a meeting (waits for the fake AI summary) → the meeting row from the API. */
export async function meeting(h, opts = {}) {
  const t = opts.title || "Weekly product sync";
  const name = `${t} (${opts.date || "2026-11-04"} ${opts.time || "10:00"} GMT+05:30) - Transcript`;
  const r = await ok(h, "POST", "/api/v1/meetings/import", {
    workspace: h.fx.workspace.id, wait: true, restricted: !!opts.restricted,
    sources: [{ name, text: transcript(opts) }],
  });
  return r.meetings[0];
}

/** A page in the Acme workspace (Guides folder unless told) → its slug. */
export async function demoPage(h, { title, content, folder = "Guides", parent = null, who = "riya" }) {
  const body = { title, content, auto_cover: false };
  if (parent) body.parent = parent;
  else Object.assign(body, { workspace: h.fx.workspace.id, folder: h.fx.workspace.folders[folder] });
  const r = await ok(h, "POST", "/api/v1/pages", body, who);
  return r.document.slug;
}

export default [];
