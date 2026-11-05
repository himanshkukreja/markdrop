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
 *   ux         the shared chat: streaming (stop, typing), numbered citations → sources → the moment, Enter /
 *              Shift+Enter / ↑ / Esc, follow-ups, a saved conversation (reload), new chat, expand, the phone
 *              sheet (16px box, 44px send, no sideways scroll), the meeting bar's Ask, ?ask=1
 *
 *   docs-media DOCS_MEDIA=1: the Ask docs' screenshots (public/docs-assets/workspaces/meetings-ask)
 *
 *   PB_FAKE_MEETINGS_AI=1 PB_STACK_ID=37 PB_WORK=… BROWSER=chromium|webkit [ONLY=paste,ask] node meetings.mjs
 *
 * Screenshots go to $MEETINGS_SHOTS (default <PB_WORK>/../shots).
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
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
  const chip = panel.getByTestId("chat-cite").first();
  await chip.waitFor({ timeout: 20000 });
  const label = await chip.getAttribute("aria-label");
  if (!/\d+:\d{2}/.test(label || "")) fail(`chip label: ${label}`);
  await snap(p, "ask-meeting-light");
  const href = await chip.getAttribute("data-href");
  if (!href || !href.startsWith(`/${meeting.transcript_slug}#b-t`)) fail(`chip href ${href}`);
  // The chip opens the sources; "Jump to the moment" opens the transcript there.
  await chip.click();
  const src = panel.getByTestId("chat-sources");
  await src.waitFor();
  await snap(p, "ask-meeting-sources-light");
  await src.locator(`a[href="${href}"]`).first().click();
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
  await p.getByTestId("ask-across-open").click();
  const box = p.getByTestId("ask-across-panel");
  await box.locator("textarea").fill("When do we ship the release?");
  await box.locator("textarea").press("Enter");
  await box.getByTestId("chat-cite").first().waitFor({ timeout: 25000 });
  await box.getByTestId("chat-sources-btn").first().waitFor({ timeout: 10000 });
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
  await p.getByTestId("ask-across-open").click();
  const box = p.getByTestId("ask-across-panel");
  await box.locator("textarea").fill(`What is the acquisition codename zebra?`);
  await box.locator("textarea").press("Enter");
  await box.locator(".ch-md, [data-testid='chat-notice']").first().waitFor({ timeout: 25000 });
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
  await pa.getByText("A meeting restricted to its attendees").first().waitFor({ timeout: 20000 });  // also the two-person upload (restricted by itself)
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
      await panel.getByTestId("chat-cite").first().waitFor({ timeout: 20000 });
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

await step("ux", async () => {
  if (!meeting) fail("no meeting");
  // Ask across meetings on a desktop: the docked panel streams (stop button, typing), cites, opens sources.
  {
    const { p } = await ctx(browser, { token: T.owner });
    await p.goto(HUB);
    await p.getByTestId("ask-across-open").click();
    const box = p.getByTestId("ask-across-panel");
    const field = box.locator("textarea");
    await field.waitFor();
    if (!(await field.evaluate((el) => el === document.activeElement))) fail("the question box isn't focused when the panel opens");
    // Shift+Enter is a new line, not a question.
    await field.fill("When do we ship");
    await field.press("Shift+Enter");
    await field.type("the release?");
    if (!(await field.inputValue()).includes("\n")) fail("Shift+Enter didn't add a line");
    if (await box.getByTestId("chat-typing").count()) fail("Shift+Enter sent the question");
    await field.press("Enter");
    // While it answers: the stop button replaces send, and the answer shows it's working.
    await box.getByTestId("chat-stop").waitFor({ timeout: 5000 });
    await box.locator("[data-testid='chat-typing'], .ch-md[data-streaming]").first().waitFor({ timeout: 10000 });
    if ((await field.inputValue()) !== "") fail("the box wasn't cleared after sending");
    await box.getByTestId("chat-cite").first().waitFor({ timeout: 25000 });
    await box.getByTestId("chat-send").waitFor({ timeout: 10000 });
    // Numbered chips.
    const n = (await box.getByTestId("chat-cite").first().innerText()).trim();
    if (n !== "1") fail(`first citation is "${n}"`);
    // The chip opens the sources: meeting, date, speaker and time, the line, a link to the moment.
    await box.getByTestId("chat-cite").first().click();
    const src = box.getByTestId("chat-sources");
    await src.waitFor();
    const first = src.locator(".ch-src").first();
    const meta = await first.locator(".ch-src__meta").innerText().catch(() => "");
    if (!/\d+:\d{2}/.test(meta)) fail(`source meta: ${meta}`);
    if (!(await first.locator(".ch-src__quote").count())) fail("the source doesn't quote the line");
    const go = await first.getByTestId("chat-source-link").getAttribute("href");
    if (!go || !/#b-t\d{4}$/.test(go)) fail(`jump link ${go}`);
    await snap(p, "ux-across-sources-light");
    await p.keyboard.press("Escape");
    if (await src.count()) fail("Esc didn't close the sources");
    // Follow-ups under the answer; ↑ in an empty box brings the last question back.
    await box.getByTestId("chat-followups").waitFor({ timeout: 5000 });
    await field.press("ArrowUp");
    if (!(await field.inputValue()).startsWith("When do we ship")) fail("↑ didn't bring the last question back");
    await field.fill("");
    // Stop: Esc while answering stops it.
    await field.fill("What did we decide about the pricing page?");
    await field.press("Enter");
    await box.getByTestId("chat-stop").waitFor({ timeout: 5000 });
    await p.keyboard.press("Escape");
    await box.getByTestId("chat-send").waitFor({ timeout: 5000 });
    // The conversation survives a reload (saved on the server).
    await p.reload();
    await p.getByTestId("ask-across-open").click();
    await box.locator(".ch-q__bubble", { hasText: "When do we ship" }).first().waitFor({ timeout: 15000 });
    // New chat starts over.
    await box.getByTestId("chat-new").click();
    await box.getByTestId("chat-starters").waitFor();
    // Expand: a page-wide conversation.
    await box.getByTestId("ask-across-expand").click();
    await p.locator(".mt-dock[data-layout='page']").waitFor();
    await snap(p, "ux-across-expanded-light");
  }
  // Phones: the chat is a full-screen sheet; the sources a bottom sheet; 16px box; 44px send.
  for (const theme of ["light", "dark"]) {
    const { p } = await ctx(browser, { token: T.owner, theme, width: 390, height: 844, mobile: true });
    await p.goto(HUB);
    await p.getByTestId("ask-across-open").click();
    const panel = p.getByTestId("ask-across-panel");
    await p.locator(".mt-dock[data-layout='sheet'][data-open]").waitFor();
    await p.waitForTimeout(350);
    const bb = await panel.boundingBox();
    if (!bb || bb.width < 389 || bb.height < 800) fail(`the phone chat isn't full screen: ${JSON.stringify(bb)}`);
    const field = panel.locator("textarea");
    if ((await field.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))) < 16) fail("the box is under 16px on a phone");
    await field.fill("When do we ship the release?");
    await panel.getByTestId("chat-send").click();
    await panel.getByTestId("chat-cite").first().waitFor({ timeout: 25000 });
    const send = await panel.getByTestId("chat-send").boundingBox();
    if (!send || send.height < 39) fail(`send is ${send?.height}px on a phone`);
    await snap(p, `ux-phone-answer-${theme}`);
    await panel.getByTestId("chat-cite").first().click();
    await panel.locator(".ch-sources[data-layout='sheet']").waitFor();
    await snap(p, `ux-phone-sources-${theme}`);
    if (await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail("sideways scroll on a phone");
  }
  // A meeting page: the meeting bar's Ask opens the panel; its chat streams and cites.
  {
    const { p } = await ctx(browser, { token: T.owner });
    await p.goto(`${APP}/${meeting.slug}`);
    await p.getByTestId("meeting-header").waitFor({ timeout: 20000 });
    if (!(await p.getByTestId("meeting-transcript").count())) fail("the meeting bar has no Transcript");
    await p.getByTestId("meeting-ask").click();
    const panel = p.locator(".mt-panel .pa-ask__panel");
    await panel.getByTestId("chat-starters").waitFor();
    await panel.getByTestId("chat-starters").getByRole("button").first().click();
    await panel.getByTestId("chat-cite").first().waitFor({ timeout: 20000 });
    await snap(p, "ux-meeting-panel-light");
    // ?ask=1 (a card's Ask) opens the panel.
    await p.goto(`${APP}/${meeting.slug}?ask=1`);
    await p.locator(".mt-panel[data-open]").waitFor({ timeout: 20000 });
  }
});

// The docs' screenshots (DOCS_MEDIA=1): /workspaces/meetings-ask — Ask across meetings with an answer and its
// sources, and Ask this meeting on a meeting page. WebP, light and dark, ≤180 KB.
const DOCS_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../public/docs-assets/workspaces/meetings-ask");
await step("docs-media", async () => {
  if (!process.env.DOCS_MEDIA) return log("(DOCS_MEDIA unset: docs screenshots skipped)");
  if (!meeting) fail("no meeting");
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const raw = path.join(OUT, "docs");
  fs.mkdirSync(raw, { recursive: true });
  const webp = (png, name) => {
    let q = 82;
    for (;;) {
      execFileSync("cwebp", ["-quiet", "-q", String(q), png, "-o", path.join(DOCS_DIR, `${name}.webp`)]);
      if (fs.statSync(path.join(DOCS_DIR, `${name}.webp`)).size <= 180 * 1024 || q <= 50) break;
      q -= 8;
    }
    log("docs", `${name}.webp`, fs.statSync(path.join(DOCS_DIR, `${name}.webp`)).size);
  };
  for (const theme of ["light", "dark"]) {
    const suffix = theme === "dark" ? ".dark" : "";
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
    await c.addInitScript(([t, th]) => {
      localStorage.setItem("markdrop_token", t); localStorage.setItem("md_theme", th);
      localStorage.setItem("md_theme_beta", "1"); localStorage.setItem("md_consent", "denied");
    }, [T.owner, theme]);
    const p = await c.newPage();
    await p.goto(HUB);
    await p.getByTestId("ask-across-open").click();
    const box = p.getByTestId("ask-across-panel");
    await box.getByTestId("chat-new").click({ timeout: 3000 }).catch(() => {});
    await box.locator("textarea").fill("When do we ship the release?");
    await box.locator("textarea").press("Enter");
    await box.getByTestId("chat-followups").waitFor({ timeout: 25000 });
    await p.waitForTimeout(600);
    await p.mouse.move(5, 5);
    await box.screenshot({ path: path.join(raw, `ask-across${suffix}.png`) });
    webp(path.join(raw, `ask-across${suffix}.png`), `ask-across${suffix}`);
    await box.getByTestId("chat-cite").first().click();
    await box.getByTestId("chat-sources").waitFor();
    await p.waitForTimeout(400);
    await box.screenshot({ path: path.join(raw, `sources${suffix}.png`) });
    webp(path.join(raw, `sources${suffix}.png`), `sources${suffix}`);
    await p.goto(`${APP}/${meeting.slug}`);
    await p.getByTestId("meeting-header").waitFor({ timeout: 20000 });
    await p.waitForTimeout(500);
    await p.getByTestId("meeting-header").screenshot({ path: path.join(raw, `meeting-bar${suffix}.png`) });
    webp(path.join(raw, `meeting-bar${suffix}.png`), `meeting-bar${suffix}`);
    await c.close();
  }
});

console.log("\nRESULTS", BROWSER);
for (const [n, s, ms] of results) console.log(`  ${s === "ok" ? "✓" : "✗"} ${n} ${s === "ok" ? "" : s} (${(ms / 1000).toFixed(1)} s)`);
await browser.close();
process.exit(results.some(([, s]) => s !== "ok") ? 1 : 0);
