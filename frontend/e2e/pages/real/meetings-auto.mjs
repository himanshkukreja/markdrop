/**
 * Meetings auto-import ("Connect Google Meet") on the REAL stack (up.sh, with PB_FAKE_MEETINGS_AI=1):
 *
 *   connect     the hub's empty state shows Import and Connect Google Meet side by side → the dialog →
 *               past meetings: last 7 days → Make my script → the manifest + Code.gs (valid JavaScript, the endpoint and a
 *               meetings:import token filled in) with Copy buttons and the four steps → Done → the
 *               connection line ("waiting for the script's first run")
 *   scoped      the script's token works on the inbox and nowhere else (401 on /auth/me, documents,
 *               MCP), and can't be used for another workspace
 *   inbox       the transcript, posted as the script does → a meeting marked Auto; Gemini's notes for the
 *               same call, in a later run → attached to it (one meeting); a replay → duplicate;
 *               the connection line counts it; the meeting's Details say where it came from
 *   manual      a meeting imported by hand, then sent by the script → duplicate (no second meeting)
 *   folder      the Meetings folder's banner shows the connection; a member sees "Also importing here"
 *               and their own Connect Google Meet
 *   disconnect  Disconnect → the line goes, the token gets 401
 *   shots       light/dark × desktop/phone of the dialog, the script and the connected hub
 *
 *   PB_FAKE_MEETINGS_AI=1 PB_STACK_ID=42 PB_WORK=… BROWSER=chromium|webkit [ONLY=connect,inbox] node meetings-auto.mjs
 *
 * Screenshots go to $MEETINGS_SHOTS (default <PB_WORK>/../auto-shots). DOCS_MEDIA=1 also writes the
 * docs page's screenshots (2×, cropped, WebP via cwebp) to public/docs-assets/workspaces/meetings-auto-import/.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { APP, BROWSER, WORK, here, log, fail, reseed, seedNow, api, mcp, launch, ctx, stepper } from "./lib.mjs";

const browser = await launch();
const { step, results } = stepper(browser);
const S = process.env.NO_RESEED ? seedNow() : reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = S.ws;
const OUT = process.env.MEETINGS_SHOTS || path.resolve(WORK, "..", "auto-shots");
fs.mkdirSync(OUT, { recursive: true });
const FRONTEND = path.resolve(here, "../../..");
const FIX = path.resolve(FRONTEND, "../backend/tests/fixtures/meetings");
const DOCS_DIR = path.join(FRONTEND, "public/docs-assets/workspaces/meetings-auto-import");
const ok = (r, what) => { if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const HUB = `${APP}/meetings/${WS}`;

const TRANSCRIPT_TITLE = "Weekly product sync (2026-11-04 10:00 GMT+05:30) - Transcript";
const NOTES_TITLE = "Weekly product sync - 2026/11/04 10:00 GMT+05:30 - Notes by Gemini";
const FID_T = "1E2eTranscriptAbcdefghijklm";
const FID_N = "1E2eNotesAbcdefghijklmnopqr";
const transcriptText = fs.readFileSync(path.join(FIX, "google_meet_transcript.txt"), "utf8");
const notesText = fs.readFileSync(path.join(FIX, "gemini_notes.txt"), "utf8");

async function snap(p, name, full = false) {
  await p.waitForTimeout(500);
  const file = path.join(OUT, `${BROWSER}-${name}.png`);
  await p.screenshot({ path: file, fullPage: full });
  log("shot", path.basename(file));
}

/** What the Apps Script sends for one Doc. */
const delivery = (fileId, title, text, kind) => ({
  source: "google-meet-script", file_id: fileId, title, created: "2026-11-04T05:20:00.000Z", kind_hint: kind, text,
  doc_url: `https://docs.google.com/document/d/${fileId}/edit`,
});
const send = (token, body) => api("POST", "/api/v1/meetings/inbox", token, body);

async function meetings(token = T.owner, qs = "") {
  return ok(await api("GET", `/api/v1/meetings?workspace=${WS}${qs}`, token), "list").meetings;
}

async function aiDone(id) {
  const deadline = Date.now() + 40000;
  for (;;) {
    const m = ok(await api("GET", `/api/v1/meetings/${id}`, T.owner), "meeting");
    if (m.ai.state === "done") return m;
    if (Date.now() > deadline) fail(`summary not written: ${JSON.stringify(m.ai)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

let token = null;     // the script's
let script = null;
let meeting = null;   // the auto-imported one

await step("connect", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(HUB);
  await p.getByText("Turn your calls into team memory").waitFor({ timeout: 20000 });
  // Manual and automatic side by side, in the header and the empty state.
  await p.getByTestId("import-meeting").waitFor();
  if ((await p.getByTestId("connect-meet").count()) !== 2) fail("Connect Google Meet isn't next to both Import buttons");
  if ((await p.getByTestId("meet-connection").count()) !== 0) fail("a connection line before connecting");
  await snap(p, "hub-empty");
  await p.getByTestId("connect-meet").first().click();
  const dlg = p.getByRole("dialog");
  await dlg.getByText("Connect Google Meet").first().waitFor();
  await dlg.getByText("Read-only: it never edits, moves or deletes anything in your Drive.").waitFor();
  await snap(p, "connect-dialog");
  if ((await dlg.getByTestId("meet-past").inputValue()) !== "30") fail("past meetings: not 30 days by default");
  await dlg.getByTestId("meet-past").selectOption("7");
  await dlg.getByTestId("meet-create").click();
  await dlg.getByTestId("meet-script").waitFor({ timeout: 15000 });
  script = await dlg.getByTestId("meet-code").locator("pre").innerText();
  const manifest = await dlg.getByTestId("meet-manifest").locator("pre").innerText();
  token = (/var MARKDROP_TOKEN = "(mdk_[A-Za-z0-9_-]+)";/.exec(script) || [])[1];
  if (!token) fail("no token in the script");
  if (!/var MARKDROP_ENDPOINT = "https?:\/\/[^"]+\/api\/v1\/meetings\/inbox";/.test(script)) fail("no endpoint in the script");
  if (!script.includes("var BACKFILL_DAYS = 7;")) fail("the past-meetings choice isn't in the script");
  await dlg.getByText("It imports your last 7 days of meetings now").waitFor();
  try { new vm.Script(script, { filename: "Code.gs" }); } catch (e) { fail(`the script isn't valid JavaScript: ${e.message}`); }
  const man = JSON.parse(manifest);
  if (!man.oauthScopes.includes("https://www.googleapis.com/auth/drive.readonly") || man.oauthScopes.some((s) => s.endsWith("/drive")))
    fail(`manifest scopes: ${man.oauthScopes}`);
  for (const s of ["Open Apps Script.", "Paste the manifest.", "Paste the script.", "Run setup once and allow."]) await dlg.getByText(s).waitFor();
  // Copy (the clipboard may be denied in a headless browser; the button still answers).
  await p.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: APP }).catch(() => {});
  await dlg.getByRole("button", { name: "Copy Code.gs" }).click();
  await dlg.getByText("Copied").first().waitFor({ timeout: 5000 }).catch(() => log("(copy feedback not shown: clipboard denied)"));
  await snap(p, "connect-script");
  await dlg.getByTestId("meet-done").click();
  await p.getByTestId("meet-connection").getByText("Google Meet connected").waitFor({ timeout: 10000 });
  await p.getByTestId("meet-connection").getByText("waiting for the script's first run").waitFor();
  if ((await p.getByTestId("connect-meet").count()) !== 0) fail("Connect Google Meet still shown once connected");
  const c = ok(await api("GET", `/api/v1/meetings/connection?workspace=${WS}`, T.owner), "connection");
  if (!c.connection || c.connection.workspace_id !== WS || JSON.stringify(c).includes(token)) fail(`connection view ${JSON.stringify(c)}`);
});

await step("scoped", async () => {
  if (!token) fail("no token");
  for (const [m, u] of [["GET", "/api/v1/auth/me"], ["GET", `/api/v1/meetings?workspace=${WS}`], ["GET", `/api/v1/workspaces/${WS}`],
    ["GET", "/api/v1/me/tokens"], ["POST", "/api/v1/meetings/connection"]]) {
    const r = await api(m, u, token, m === "POST" ? { workspace: WS } : undefined);
    if (r.status !== 401) fail(`${m} ${u} with the script's token → ${r.status}`);
  }
  const m = await mcp(token, "list_meetings", { workspace: WS });
  if (m.status !== 401) fail(`MCP with the script's token → ${m.status}`);
  // Not in the person's API tokens.
  const mine = ok(await api("GET", "/api/v1/me/tokens", T.owner), "tokens");
  if (JSON.stringify(mine).includes("meetings:import")) fail("the script's token is listed with API tokens");
});

await step("inbox", async () => {
  if (!token) fail("no token");
  const r1 = ok(await send(token, delivery(FID_T, TRANSCRIPT_TITLE, transcriptText, "transcript")), "transcript");
  if (r1.status !== "imported" || !r1.url) fail(`transcript → ${JSON.stringify(r1)}`);
  meeting = await aiDone(r1.meeting_id);
  if (meeting.source !== "auto") fail(`source ${meeting.source}`);
  // Gemini's notes, in a later run: the same meeting, now with Google's notes.
  const r2 = ok(await send(token, delivery(FID_N, NOTES_TITLE, notesText, "notes")), "notes");
  if (r2.status !== "attached" || r2.meeting_id !== r1.meeting_id) fail(`notes → ${JSON.stringify(r2)}`);
  meeting = await aiDone(r1.meeting_id);
  if (!meeting.has_notes || !meeting.has_transcript) fail("not paired");
  const replay = ok(await send(token, delivery(FID_N, NOTES_TITLE, notesText, "notes")), "replay");
  if (replay.status !== "duplicate") fail(`replay → ${JSON.stringify(replay)}`);
  const all = await meetings();
  if (all.length !== 1) fail(`${all.length} meetings`);
  if ((await meetings(T.owner, "&source=auto")).length !== 1 || (await meetings(T.owner, "&source=manual")).length !== 0) fail("source filter");
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(HUB);
  const card = p.getByTestId("meeting-card").first();
  await card.waitFor({ timeout: 20000 });
  await card.getByText("Auto", { exact: true }).waitFor();
  const line = p.getByTestId("meet-connection");
  await line.getByText(/last import (just now|\d+ (second|minute)s? ago)/).waitFor({ timeout: 10000 });
  await line.getByText(/· 1 meeting\b/).waitFor();
  await snap(p, "hub-connected");
  await p.goto(`${APP}/${meeting.slug}`);
  await p.getByTestId("meeting-pill").click();
  await p.getByTestId("meeting-details-tab").click();
  await p.getByTestId("meeting-via").getByText("Imported automatically by Connect Google Meet").waitFor({ timeout: 10000 });
  await snap(p, "details-via");
});

await step("manual", async () => {
  if (!token) fail("no token");
  const text = "Design review (2026-11-03 15:00 GMT+05:30) - Transcript\nAda Owner: Let's review the new editor.\nBen Member: The toolbar is ready.\n";
  const made = ok(await api("POST", "/api/v1/meetings/import", T.owner, { workspace: WS, sources: [{ name: "Design review - Transcript", text }] }), "manual import");
  const r = ok(await send(token, delivery("1E2eDesignReviewAbcdefghij", "Design review (2026-11-03 15:00 GMT+05:30) - Transcript", text, "transcript")), "script");
  if (r.status !== "duplicate" || r.meeting_id !== made.meetings[0].id) fail(`script after manual → ${JSON.stringify(r)}`);
  if ((await meetings()).length !== 2) fail("a second Design review");
});

await step("folder", async () => {
  const tree = ok(await api("GET", `/api/v1/workspaces/${WS}/tree`, T.owner), "tree");
  const folder = (tree.folders || []).find((f) => f.meetings);
  if (!folder) fail("no Meetings folder");
  {
    const { p } = await ctx(browser, { token: T.owner });
    await p.goto(`${APP}/w/${WS}/f/${folder.id}`);
    const bar = p.getByTestId("meetings-folderbar");
    await bar.waitFor({ timeout: 20000 });
    await bar.getByText("Google Meet connected").waitFor({ timeout: 10000 });
    await snap(p, "folder-connected");
  }
  {
    const { p } = await ctx(browser, { token: T.member });
    await p.goto(`${APP}/w/${WS}/f/${folder.id}`);
    const bar = p.getByTestId("meetings-folderbar");
    await bar.getByTestId("folder-connect-meet").waitFor({ timeout: 20000 });
    await bar.getByText("Also importing here: Ada Owner").waitFor();
    await bar.getByTestId("folder-connect-meet").click();
    await p.waitForURL((u) => u.pathname.startsWith("/meetings/") && u.search.includes("connect=1"));
    await p.getByRole("dialog").getByTestId("meet-create").waitFor({ timeout: 20000 });
    await snap(p, "member-connect");
  }
  {
    // A viewer can't import: no Connect.
    const { p } = await ctx(browser, { token: T.reader });
    await p.goto(HUB);
    await p.getByTestId("meetings-list").waitFor({ timeout: 20000 });
    if ((await p.getByTestId("connect-meet").count()) !== 0) fail("a viewer sees Connect Google Meet");
  }
});

await step("shots", async () => {
  for (const theme of ["light", "dark"]) {
    for (const [w, h, tag] of [[1440, 900, "desk"], [390, 844, "phone"]]) {
      const mobile = tag === "phone";
      const { p } = await ctx(browser, { token: T.admin, theme, width: w, height: h, mobile });
      await p.goto(`${HUB}?connect=1`);
      const dlg = p.getByRole("dialog");
      await dlg.getByTestId("meet-create").waitFor({ timeout: 20000 });
      await snap(p, `connect-dialog-${theme}-${tag}`);
      await dlg.getByTestId("meet-create").click();
      await dlg.getByTestId("meet-script").waitFor({ timeout: 15000 });
      if (mobile) {
        const box = await dlg.getByRole("button", { name: "Copy Code.gs" }).boundingBox();
        if (!box || box.height < 32) fail(`Copy is ${box?.height}px tall on a phone`);
        const over = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        if (over) fail("the page scrolls sideways on a phone");
      }
      await snap(p, `connect-script-${theme}-${tag}`);
      await dlg.getByTestId("meet-done").click();
      await p.getByTestId("meet-connection").waitFor();
      await snap(p, `hub-connected-${theme}-${tag}`);
    }
  }
});

await step("docs-media", async () => {
  if (!process.env.DOCS_MEDIA) return log("(DOCS_MEDIA unset: docs screenshots skipped)");
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
    await api("DELETE", "/api/v1/meetings/connection", T.admin);   // the dialog as a first-timer sees it
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
    await c.addInitScript(([t, th]) => {
      localStorage.setItem("markdrop_token", t); localStorage.setItem("md_theme", th);
      localStorage.setItem("md_theme_beta", "1"); localStorage.setItem("md_consent", "denied");
    }, [T.admin, theme]);
    let p = await c.newPage();
    await p.goto(`${HUB}?connect=1`);
    const panel = p.locator(".md-dialog").filter({ has: p.getByTestId("meet-create") });
    await panel.getByTestId("meet-create").waitFor({ timeout: 20000 });
    await p.waitForTimeout(800);
    await p.evaluate(() => document.activeElement?.blur());
    await panel.screenshot({ path: path.join(raw, `connect-dialog${suffix}.png`) });
    webp(path.join(raw, `connect-dialog${suffix}.png`), `connect-dialog${suffix}`);
    await panel.getByTestId("meet-create").click();
    const made = p.locator(".md-dialog").filter({ has: p.getByTestId("meet-script") });
    await made.waitFor({ timeout: 15000 });
    await p.waitForTimeout(800);
    await p.evaluate(() => document.activeElement?.blur());
    await made.screenshot({ path: path.join(raw, `connect-script${suffix}.png`) });
    webp(path.join(raw, `connect-script${suffix}.png`), `connect-script${suffix}`);
    await made.getByTestId("meet-done").click();
    await c.close();
    // The Meetings page of the owner, whose script has imported a call.
    const c2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
    await c2.addInitScript(([t, th]) => {
      localStorage.setItem("markdrop_token", t); localStorage.setItem("md_theme", th);
      localStorage.setItem("md_theme_beta", "1"); localStorage.setItem("md_consent", "denied");
    }, [T.owner, theme]);
    p = await c2.newPage();
    await p.goto(HUB);
    await p.getByTestId("meet-connection").getByText(/last import/).waitFor({ timeout: 20000 });
    await p.getByTestId("meeting-card").first().waitFor();
    await p.waitForTimeout(800);
    // The header, the connection line and the first meetings.
    const head = await p.locator(".mt-hub__head").boundingBox();
    const list = await p.getByTestId("meetings-list").boundingBox();
    const box = { x: Math.max(0, head.x - 24), y: Math.max(0, head.y - 6), width: Math.min(1440, head.width + 48) };
    box.height = Math.min(list.y + list.height + 16, 900) - box.y;
    await p.screenshot({ path: path.join(raw, `connected${suffix}.png`), clip: box });
    webp(path.join(raw, `connected${suffix}.png`), `connected${suffix}`);
    await c2.close();
  }
});

await step("disconnect", async () => {
  if (!token) fail("no token");
  // The admin's connection (made by the shots) stays; the owner disconnects theirs.
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(HUB);
  await p.getByTestId("meet-disconnect").click();
  await p.getByRole("dialog").getByRole("button", { name: "Disconnect" }).click();
  await p.getByText("Google Meet disconnected.").waitFor({ timeout: 10000 });
  await p.getByTestId("connect-meet").first().waitFor();
  const r = await send(token, delivery("1E2eAfterDisconnectAbcdefg", TRANSCRIPT_TITLE, transcriptText, "transcript"));
  if (r.status !== 401) fail(`inbox after Disconnect → ${r.status}`);
  const c = ok(await api("GET", `/api/v1/meetings/connection?workspace=${WS}`, T.owner), "connection");
  if (c.connection) fail("still connected");
  if ((await meetings()).length !== 2) fail("meetings changed on Disconnect");
});

console.log("\nRESULTS", BROWSER);
for (const [n, s, ms] of results) console.log(`  ${s === "ok" ? "✓" : "✗"} ${n} ${s === "ok" ? "" : s} (${(ms / 1000).toFixed(1)} s)`);
await browser.close();
process.exit(results.some(([, s]) => s !== "ok") ? 1 : 0);
