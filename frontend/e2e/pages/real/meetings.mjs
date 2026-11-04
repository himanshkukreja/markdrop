/**
 * Meetings on the REAL stack (up.sh, with PB_FAKE_MEETINGS_AI=1 so Meetings AI runs against the fake
 * model in api_run.py):
 *
 *   paste      the hub's empty state → Import → paste a Google Meet transcript → the page opens, the
 *              summary fills in (Decisions, Action items with @mentions that notify, Topics, Sources)
 *   structure  the page's Markdown, the Meetings folder's properties, the anchored transcript sub-page
 *   ask        Ask this meeting streams an answer whose chip opens the transcript at that moment
 *   upload     Import → Upload a .vtt → a second meeting
 *   across     Ask across meetings (hub) cites meetings and moments
 *   restricted a meeting restricted to its attendees: hidden from a non-attendee everywhere (list, page,
 *              API, Ask across — never in an API response), open to an attendee; an admin sees it exists
 *   folder     the Meetings folder's banner
 *   shots      light/dark × desktop/phone screenshots of the hub, import, page and panel
 *
 *   PB_FAKE_MEETINGS_AI=1 PB_STACK_ID=37 PB_WORK=… BROWSER=chromium|webkit [ONLY=paste,ask] node meetings.mjs
 *
 * Screenshots go to $MEETINGS_SHOTS (default <PB_WORK>/../shots).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP, BROWSER, WORK, log, fail, reseed, seedNow, api, launch, ctx, captureApi, stepper } from "./lib.mjs";

const browser = await launch();
const { step, results } = stepper(browser);
const S = process.env.NO_RESEED ? seedNow() : reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = S.ws;
const OUT = process.env.MEETINGS_SHOTS || path.resolve(WORK, "..", "shots");
fs.mkdirSync(OUT, { recursive: true });
const ok = (r, what) => { if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const HUB = `${APP}/meetings/${WS}`;

async function snap(p, name, full = false) {
  await p.waitForTimeout(500);
  const file = path.join(OUT, `${BROWSER}-${name}.png`);
  await p.screenshot({ path: file, fullPage: full });
  log("shot", path.basename(file));
}

const TRANSCRIPT = `Sprint planning (2026-11-05 09:30 GMT+05:30) - Transcript
Attendees
Ada Owner, Ben Member, Vic Viewer
Transcript
This editable transcript was computer generated and might contain errors. People can also change the text after it was created.
Ada Owner: Morning. Two things today, the release date and the pricing page.
Ben Member: QA signed off last night, so we can ship the release on Friday.
Vic Viewer: Haan, theek hai, but the migration needs one more dry run on staging.
Ada Owner: Then we agree to ship the release on Friday if the staging dry run passes.
Ada Owner: Vic, can you run the dry run tomorrow morning?
Vic Viewer: Yes, I will run the staging dry run tomorrow morning.
00:05:00
Ben Member: I will update the onboarding docs with the new screenshots.
Ada Owner: Do we show the annual discount on the pricing page?
Ben Member: Not sure yet, finance has to confirm the numbers.
Transcription ended after 00:09:12
`;

const VTT = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
<v Ben Member>Quick standup. I fixed the export bug yesterday.

2
00:00:05.000 --> 00:00:09.000
<v Ada Owner>Great. Today I'm on the pricing page copy.
`;

const SECRET = "codename-zebra";
let meeting = null;   // the pasted one

await step("paste", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(HUB);
  await p.getByText("Turn your calls into team memory").waitFor({ timeout: 20000 });
  await snap(p, "hub-empty-light");
  await p.getByTestId("import-meeting").click();
  const dlg = p.getByRole("dialog");
  await dlg.getByText("Import a meeting").first().waitFor();
  await dlg.locator("#mt-paste").fill(TRANSCRIPT);
  await dlg.getByText("9 transcript lines").waitFor({ timeout: 15000 });
  if ((await dlg.locator("#mt-title").inputValue()) !== "Sprint planning") fail("title not detected");
  if ((await dlg.locator("#mt-date").inputValue()) !== "2026-11-05") fail("date not detected");
  await snap(p, "import-paste-light");
  await dlg.getByRole("button", { name: "Import meeting" }).click();
  await p.waitForURL((u) => !u.pathname.startsWith("/meetings/"), { timeout: 30000 });
  const slug = new URL(p.url()).pathname.slice(1);
  // The summary is written in the background; the page fills in through its socket (or a refresh).
  const deadline = Date.now() + 30000;
  for (;;) {
    const list = ok(await api("GET", `/api/v1/meetings?workspace=${WS}`, T.owner), "list");
    meeting = list.meetings.find((m) => m.slug === slug);
    if (meeting?.ai.state === "done") break;
    if (Date.now() > deadline) fail(`summary not written: ${JSON.stringify(meeting?.ai)}`);
    await p.waitForTimeout(500);
  }
  await p.getByRole("heading", { name: "Decisions" }).first().waitFor({ timeout: 20000 }).catch(async () => {
    await p.reload();
    await p.getByRole("heading", { name: "Decisions" }).first().waitFor({ timeout: 20000 });
  });
  await p.getByRole("heading", { name: "Action items" }).first().waitFor();
  await p.getByTestId("meeting-pill").waitFor();
  await snap(p, "page-light");
  await snap(p, "page-light-full", true);
});

await step("structure", async () => {
  if (!meeting) fail("no meeting from paste");
  const doc = ok(await api("GET", `/api/v1/documents/${meeting.slug}`, T.owner), "page");
  const c = doc.content;
  for (const want of [':::note[Summary]{icon="✨"}', "## Decisions", "## Action items", "## Open questions", "## Topics", "## Sources",
    `::page{src="${meeting.transcript_slug}"}`, 'date: "2026-11-05"', 'type: "Planning"']) {
    if (!c.includes(want)) fail(`page lacks ${want}`);
  }
  if (!/:person\[Vic Viewer\]\{id="[0-9a-f]{24}"\} run the staging dry run/.test(c)) fail("Vic's action item isn't a mention");
  if (!/:person\[Ben Member\]\{id="[0-9a-f]{24}"\} update the onboarding docs/.test(c)) fail("Ben's action item isn't a mention");
  if (!c.includes(`(/${meeting.transcript_slug}#b-t0004)`)) fail("decision doesn't cite the transcript");
  const tr = ok(await api("GET", `/api/v1/documents/${meeting.transcript_slug}`, T.owner), "transcript");
  if (!tr.content.includes("**0:00 · Ada Owner** Morning.")) fail("transcript line");
  if (!tr.content.includes("{#b-t0009}")) fail("transcript anchors");
  if (!tr.content.includes("Haan, theek hai")) fail("Hindi kept as spoken");
  const tree = ok(await api("GET", `/api/v1/workspaces/${WS}/tree`, T.owner), "tree");
  const folder = (tree.folders || []).find((f) => f.meetings);
  if (!folder || folder.name !== "Meetings") fail("no Meetings folder in the tree");
  // Ben was mentioned: a notification.
  const notes = ok(await api("GET", "/api/v1/notifications", T.member), "notifications");
  if (!(notes.items || []).some((n) => n.kind === "mention" && (n.page?.slug === meeting.slug))) fail("Ben wasn't notified");
});

await step("ask", async () => {
  if (!meeting) fail("no meeting");
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/${meeting.slug}`);
  await p.getByTestId("meeting-pill").click();
  const panel = p.locator(".mt-panel .pa-ask__panel");
  await panel.getByText("Ask this meeting").first().waitFor();
  await panel.locator("textarea").fill("When do we ship the release?");
  await panel.locator("textarea").press("Enter");
  const chip = panel.locator(".mt-cite[data-kind='segment']").first();
  await chip.waitFor({ timeout: 20000 });
  const label = await chip.innerText();
  if (!/,\s*\d+:\d{2}/.test(label)) fail(`chip label: ${label}`);
  await snap(p, "ask-meeting-light");
  const href = await chip.getAttribute("href");
  if (!href || !href.startsWith(`/${meeting.transcript_slug}#b-t`)) fail(`chip href ${href}`);
  await chip.click();
  await p.waitForURL((u) => u.pathname === `/${meeting.transcript_slug}`, { timeout: 20000 });
  const anchor = href.split("#")[1];
  // Blocks carry their anchor as data-bid (anchors.ts scrolls to it and flashes it).
  await p.locator(`[data-bid="${anchor}"]`).first().waitFor({ timeout: 15000 });
  await snap(p, "transcript-at-moment-light");
  // Details tab.
  await p.goto(`${APP}/${meeting.slug}`);
  await p.getByTestId("meeting-pill").click();
  await p.getByTestId("meeting-details-tab").click();
  await p.locator(".mt-details").getByText("Who was there").waitFor();
  await snap(p, "panel-details-light");
});

await step("upload", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(HUB);
  await p.getByTestId("meetings-list").waitFor({ timeout: 20000 });
  await p.getByTestId("import-meeting").click();
  const dlg = p.getByRole("dialog");
  await dlg.getByRole("tab", { name: "Upload" }).click();
  const file = path.join(os.tmpdir(), `standup-${Date.now()}.vtt`);
  fs.writeFileSync(file, VTT);
  await dlg.locator('input[type="file"]').setInputFiles(file);
  await dlg.getByText("2 transcript lines").waitFor({ timeout: 15000 });
  await dlg.locator("#mt-title").fill("Daily standup");
  await dlg.getByRole("button", { name: "Import meeting" }).click();
  await p.waitForURL((u) => !u.pathname.startsWith("/meetings/"), { timeout: 30000 });
  const list = ok(await api("GET", `/api/v1/meetings?workspace=${WS}`, T.member), "list");
  const m = list.meetings.find((x) => x.title === "Daily standup");
  if (!m || m.type !== "Standup" || m.sources[0].origin !== "upload") fail(`upload: ${JSON.stringify(m)?.slice(0, 300)}`);
});

await step("across", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(HUB);
  const box = p.locator(".mt-ask");
  await box.waitFor({ timeout: 20000 });
  await box.locator("textarea").fill("When do we ship the release?");
  await box.locator("textarea").press("Enter");
  const chip = box.locator(".mt-cite").first();
  await chip.waitFor({ timeout: 25000 });
  await box.locator(".pa-sources a.pa-chip").first().waitFor({ timeout: 10000 });
  await snap(p, "ask-across-light");
});

let secret = null;
await step("restricted", async () => {
  const r = ok(await api("POST", "/api/v1/meetings/import", T.owner, {
    workspace: WS, restricted: true, wait: true,
    sources: [{ name: "Board prep", text: `Ada Owner: The acquisition is ${SECRET}, keep it quiet.\nBen Member: Understood, I will draft the memo.` }],
  }), "restricted import");
  secret = r.meetings[0];
  if (!secret.restricted) fail("not restricted");
  // Vic (a viewer who wasn't there): not in the list, 404 everywhere, never in Ask across.
  const vl = ok(await api("GET", `/api/v1/meetings?workspace=${WS}`, T.reader), "vic list");
  if (vl.meetings.some((m) => m.id === secret.id) || vl.hidden.length) fail("Vic sees the restricted meeting");
  if ((await api("GET", `/api/v1/meetings/${secret.id}`, T.reader)).status !== 404) fail("Vic can GET it");
  if ((await api("GET", `/api/v1/documents/${secret.slug}`, T.reader)).status !== 404) fail("Vic can read the page");
  const { p } = await ctx(browser, { token: T.reader });
  const bodies = captureApi(p);
  await p.goto(HUB);
  await p.getByTestId("meetings-list").waitFor({ timeout: 20000 });
  if (await p.getByText("Board prep").count()) fail("Vic's hub lists it");
  const box = p.locator(".mt-ask");
  await box.locator("textarea").fill(`What is the acquisition codename zebra?`);
  await box.locator("textarea").press("Enter");
  await box.locator(".pa-a .pa-md, .pa-notice").first().waitFor({ timeout: 25000 });
  await p.waitForTimeout(1500);
  await snap(p, "restricted-hidden-light");
  await p.goto(`${APP}/${secret.slug}`);
  await p.waitForTimeout(2500);
  if (await p.getByText(SECRET).count()) fail("Vic sees the secret on the page");
  for (const b of bodies) if (b.body.includes(SECRET)) fail(`an API response to Vic carried the secret: ${b.url}`);
  // Ben (an attendee) can open it; Wes (an admin) sees that it exists, without its title.
  if ((await api("GET", `/api/v1/meetings/${secret.id}`, T.member)).status !== 200) fail("Ben can't open it");
  const wl = ok(await api("GET", `/api/v1/meetings?workspace=${WS}`, T.admin), "wes list");
  if (!wl.hidden.some((h) => h.id === secret.id) || JSON.stringify(wl).includes("Board prep")) fail("admin view of a restricted meeting");
  const { p: pa } = await ctx(browser, { token: T.admin });
  await pa.goto(HUB);
  await pa.getByText("A meeting restricted to its attendees").waitFor({ timeout: 20000 });
  await snap(pa, "hub-admin-hidden-light");
});

await step("folder", async () => {
  const tree = ok(await api("GET", `/api/v1/workspaces/${WS}/tree`, T.owner), "tree");
  const folder = (tree.folders || []).find((f) => f.meetings);
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/w/${WS}/f/${folder.id}`);
  await p.getByTestId("meetings-folderbar").waitFor({ timeout: 20000 });
  await snap(p, "folder-light");
});

await step("shots", async () => {
  if (!meeting) fail("no meeting");
  for (const theme of ["light", "dark"]) {
    for (const [w, h, tag] of [[1440, 900, "desk"], [390, 844, "phone"], [834, 1112, "tablet"]]) {
      if (theme === "light" && tag === "desk") continue; // taken above
      const mobile = tag !== "desk";
      const { p } = await ctx(browser, { token: T.owner, theme, width: w, height: h, mobile });
      await p.goto(HUB);
      await p.getByTestId("meetings-list").waitFor({ timeout: 20000 });
      await snap(p, `hub-${theme}-${tag}`);
      await p.getByTestId("import-meeting").first().click();
      await p.getByRole("dialog").getByText("Import a meeting").first().waitFor();
      await p.waitForTimeout(400);
      await snap(p, `import-${theme}-${tag}`);
      await p.keyboard.press("Escape");
      await p.goto(`${APP}/${meeting.slug}`);
      await p.getByTestId("meeting-pill").click();
      const panel = p.locator(".mt-panel .pa-ask__panel");
      await panel.locator("textarea").fill("What did we decide?");
      await panel.locator("textarea").press("Enter");
      await panel.locator(".mt-cite").first().waitFor({ timeout: 20000 });
      // A touch target check on phones: the pill, chips and tabs are at least 44px tall.
      if (tag === "phone") {
        const tab = await p.getByTestId("meeting-details-tab").boundingBox();
        if (!tab || tab.height < 43) fail(`tab is ${tab?.height}px tall on a phone`);
        const input = await panel.locator("textarea").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
        if (input < 16) fail(`the question box is ${input}px on a phone`);
      }
      await snap(p, `panel-${theme}-${tag}`);
    }
  }
});

console.log("\nRESULTS", BROWSER);
for (const [n, s, ms] of results) console.log(`  ${s === "ok" ? "✓" : "✗"} ${n} ${s === "ok" ? "" : s} (${(ms / 1000).toFixed(1)} s)`);
await browser.close();
process.exit(results.some(([, s]) => s !== "ok") ? 1 : 0);
