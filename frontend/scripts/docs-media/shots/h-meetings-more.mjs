/**
 * Docs media, group H: more Meetings screens (/workspaces/meetings*). Shot format: ../shots.mjs.
 *
 * The meeting bar (with its organizer), the Meeting details panel, the Import a meeting dialog
 * (Paste with its preview, and Drive link) and a short clip of Connect Google Meet. Meetings are
 * imported with the demo people (shots/_demo.mjs); the AI summary comes from the fake Meetings AI
 * (start the sandbox API through e2e/pages/real/api_run.py with PB_FAKE_MEETINGS_AI=1).
 * Organize meetings: the dialog's preview (the background-job version, main 15a0e09b+).
 * The Meeting details panel is shot in k-team-meetings.mjs now (a meeting with Attendees and Invited).
 */
import { api, meeting, transcript } from "./_demo.mjs";

const hub = (fx) => `/meetings/${fx.workspace.id}`;

async function openMeeting(h) {
  const m = await meeting(h);
  await h.goto(`/${m.slug}`);
  await h.loc("[data-testid='meeting-header']").waitFor({ timeout: 30000 });
  await h.settle(600);
  await h.page.mouse.move(5, 895);
  return m;
}

async function importDialog(h) {
  await h.goto(`${hub(h.fx)}?import=1`);
  await h.loc(".md-dialog").waitFor({ timeout: 30000 });
  await h.sleep(700); // the md-pop animation
}

export default [
  {
    id: "meetings-organize",
    page: "/workspaces/meetings",
    name: "organize",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    prepare: async (h) => {
      await meeting(h, { title: "Daily Standup", date: "2026-11-03", time: "09:30" });
      await meeting(h, { title: "Daily Standup", date: "2026-11-04", time: "09:30" });
      await meeting(h, { title: "Weekly product sync", date: "2026-11-04", time: "10:00" });
      await meeting(h, { title: "Pricing review", date: "2026-11-05", time: "15:00" });
      await h.goto(hub(h.fx));
      await h.loc("[data-testid='meeting-card']").first().waitFor({ timeout: 30000 });
      await h.page.getByTestId("meetings-more").click();
      await h.page.getByRole("menuitem", { name: /Organize meetings/ }).click();
      const dlg = h.page.getByTestId("organize-dialog");
      await dlg.getByText("in Other meetings").waitFor({ timeout: 30000 });
      await h.settle(700);
      await h.page.mouse.move(5, 5);
    },
    crop: { selector: ".md-dialog:has([data-testid='organize-dialog'])", pad: 0 },
  },
  {
    id: "meetings-meeting-bar",
    page: "/workspaces/meetings-ask",
    name: "meeting-bar",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    prepare: async (h) => {
      await openMeeting(h);
    },
    crop: { selector: "[data-testid='meeting-header']", pad: 12 },
  },
  {
    id: "meetings-import-paste",
    page: "/workspaces/meetings-import",
    name: "import-paste",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    prepare: async (h) => {
      await importDialog(h);
      await h.page.locator("#mt-paste").fill(transcript({ date: "2026-11-05", title: "Design review" }));
      await h.loc(".mt-detect").waitFor({ timeout: 15000 });
      await h.settle(500);
      await h.page.mouse.move(5, 5);
    },
    crop: { selector: ".md-dialog", pad: 0 },
  },
  {
    id: "meetings-import-link",
    page: "/workspaces/meetings-import",
    name: "import-link",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    prepare: async (h) => {
      await importDialog(h);
      await h.page.getByRole("tab", { name: "Drive link" }).click();
      await h.loc("[data-testid='import-link-input']").waitFor({ timeout: 10000 });
      await h.page.locator("[data-testid='import-link-input']").fill(
        "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit");
      await h.settle(400);
      await h.page.mouse.move(5, 5);
    },
    crop: { selector: ".md-dialog", pad: 0 },
  },
  {
    id: "meetings-connect-clip",
    page: "/workspaces/meetings-auto-import",
    name: "connect",
    kind: "clip",
    auth: "owner",
    url: (fx) => `${hub(fx)}?connect=1`,
    prepare: async (h) => {
      await api(h, "DELETE", "/api/v1/meetings/connection");
      await h.page.reload();
      await h.loc("[data-testid='meet-create']").waitFor({ timeout: 30000 });
      await h.sleep(800);
    },
    steps: async (h) => {
      await h.sleep(800);
      await h.hover("[data-testid='meet-shared']", 700);
      await h.click("[data-testid='meet-create']");
      await h.loc("[data-testid='meet-script']").waitFor({ timeout: 20000 });
      await h.sleep(1200);
      await h.hover("[data-testid='meet-code']", 1200);
    },
  },
];
