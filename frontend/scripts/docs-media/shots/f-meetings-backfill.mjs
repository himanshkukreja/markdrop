/**
 * Docs media, group F: Meetings — Import past meetings (/workspaces/meetings-import#import-past-meetings)
 * and the organised Meetings page (/workspaces/meetings#how-meetings-are-organised). Shot format:
 * ../shots.mjs. The same files are also written by the real-stack e2e
 * (frontend/e2e/pages/real/meetings-backfill.mjs with DOCS_MEDIA=1).
 *
 *   review     the review of a batch: two standups (notes + transcript paired), one already imported,
 *              one file without a date (flagged)
 *   organised  the Meetings page's list: series chips and the meetings by month
 */
const PAGE = "/workspaces/meetings-import";

async function api(h, method, p, body) {
  const token = (await h.sandbox("/__sandbox/mint", { email: h.fx.users.riya.email })).token;
  const res = await fetch(`${h.API}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${await res.text()}`);
  return res.json();
}

const hub = (fx) => `/meetings/${fx.workspace.id}`;
const standup = (n) => `Ada Lovelace: Morning all, quick standup.\nBo Chen: I will finish the billing migration today (${n}).\nPriya Sharma: Then we agree to ship the billing API on Friday.\n`;
const NOTES = "# Daily Standup\nSummary\nThe team synced on the billing migration.\n\nDetails\n- Billing migration is on track.\n\nSuggested next steps\n- Bo Chen will finish the billing migration.\n";
const name = (d, kind = "Transcript") => `Daily Standup – 2026_${d} 10_00 IST – ${kind}.txt`;

/** Imports the October standups (and a one-off) once, through Import past meetings. */
async function history(h) {
  const ws = h.fx.workspace.id;
  const have = await api(h, "GET", `/api/v1/meetings?workspace=${ws}&series=Daily%20Standup`);
  if (have.meetings.length >= 2) return;
  const job = await api(h, "POST", "/api/v1/meetings/backfill", { workspace: ws });
  await api(h, "POST", `/api/v1/meetings/backfill/${job.id}/sources`, { sources: [
    { name: name("10_14"), text: standup("one"), origin: "upload" },
    { name: name("10_14", "Notes by Gemini"), text: NOTES, origin: "upload" },
    { name: name("10_21"), text: standup("two"), origin: "upload" },
    { name: "Design sync – 2026_09_30 15_00 IST – Transcript.txt", text: "Ada Lovelace: The onboarding screens are ready.\nBo Chen: I will ship the copy next week.\n", origin: "upload" },
  ] });
  await api(h, "POST", `/api/v1/meetings/backfill/${job.id}/start`);
  for (let i = 0; i < 120; i++) {
    const j = await api(h, "GET", `/api/v1/meetings/backfill/${job.id}`);
    if (j.state === "done") break;
    await h.sleep(500);
  }
  await api(h, "DELETE", `/api/v1/meetings/backfill/${job.id}`);
}

export default [
  {
    id: "meetings-backfill-review",
    page: PAGE,
    name: "review",
    kind: "screenshot",
    auth: "owner",
    url: (fx) => hub(fx),
    prepare: async (h) => {
      await history(h);
      const ws = h.fx.workspace.id;
      const job = await api(h, "POST", "/api/v1/meetings/backfill", { workspace: ws });
      if (!job.rows.length) {
        await api(h, "POST", `/api/v1/meetings/backfill/${job.id}/sources`, { sources: [
          { name: name("10_28"), text: standup("three"), origin: "upload" },
          { name: name("10_28", "Notes by Gemini"), text: NOTES.replace("synced", "synced again"), origin: "upload" },
          { name: name("10_29"), text: standup("four"), origin: "upload" },
          { name: name("10_14"), text: standup("one"), origin: "upload" },
          { name: "retro-notes.txt", text: "Ada Lovelace: What went well this sprint?\nBo Chen: The billing rollout went smoothly.\n", origin: "upload" },
        ] });
      }
      await h.page.goto(`${h.APP}${hub(h.fx)}?import=past`);
      await h.loc("[data-testid='bulk-review']").waitFor({ timeout: 20000 });
      await h.sleep(700);
      await h.page.mouse.move(5, 5);
    },
    crop: { selector: ".md-dialog", pad: 0 },
  },
  {
    id: "meetings-backfill-organised",
    page: PAGE,
    name: "organised",
    kind: "screenshot",
    auth: "owner",
    url: (fx) => hub(fx),
    prepare: async (h) => {
      await history(h);
      await h.page.reload();
      await h.loc("[data-testid='month-header']").first().waitFor({ timeout: 20000 });
      await h.sleep(600);
      await h.page.mouse.move(5, 5);
    },
    crop: { selector: "section[aria-labelledby='mt-list-title']", pad: 0 },
  },
];
