/**
 * PowerPoint decks on the real stack (feat/pptx-crumbs): a .pptx uploaded through the app's upload
 * flow opens in the Worker's slide viewer inside the file page; `#slide=4` (how Ask and search link a
 * slide) opens it at slide 4; → moves on; Notes shows the speaker notes; the thumbnail strip is there
 * on a laptop and not on a phone. A macro deck renamed .pptx is refused (422) and nothing is made.
 *
 *   PB_STACK_ID=47 [BROWSER=chromium] node pptx.mjs        (after up.sh start; uses seed.json)
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { APP, api, ctx, fail, here, launch, log, seedNow, shot, uploadFile } from "./lib.mjs";

const { sampleDeck } = await import(pathToFileURL(path.resolve(here, "../../../../worker/test/pptx-fixture.mjs")).href);
const MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const S = seedNow();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const run = Date.now().toString(36).slice(-5);

const deck = sampleDeck();
const made = await uploadFile(T.owner, { bytes: deck, filename: "Q3 board review.pptx", mime: MIME, title: "Q3 board review", slug: `deck-${run}` });
if (made.renderer !== "pptx") fail(`renderer ${made.renderer}`);
if (!/\/v\/pptx\//.test(made.artifact_url)) fail(`artifact_url ${made.artifact_url}`);
log("uploaded", made.slug, made.renderer);

// A macro deck renamed .pptx: refused, and no document.
const macro = sampleDeck({ extra: { "ppt/vbaProject.bin": "Attribute VB_Name" } });
const u = await api("POST", "/api/v1/artifacts/upload-url", T.owner, { filename: "macro.pptx", content_type: MIME, size_bytes: macro.length });
await fetch(u.body.upload_url, { method: "PUT", body: macro, headers: { "Content-Type": u.body.required_content_type } });
const bad = await api("POST", "/api/v1/artifacts", T.owner, { blob_key: u.body.blob_key, filename: "macro.pptx", custom_slug: `macro-${run}` });
if (bad.status !== 422 || !/macros/.test(JSON.stringify(bad.body))) fail(`macro deck → ${bad.status} ${JSON.stringify(bad.body).slice(0, 200)}`);
if ((await api("GET", `/api/v1/documents/macro-${run}`, T.owner)).status !== 404) fail("macro deck made a document");
log("macro deck refused (422)");

const browser = await launch();
for (const [name, opts] of [["laptop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844, mobile: true }]]) {
  const { c, p } = await ctx(browser, { token: T.owner, ...opts });
  await p.goto(`${APP}/${made.slug}#slide=4`);
  const f = p.frameLocator('iframe[src*="/v/pptx/"]').first();
  await f.locator("body.ready").waitFor({ timeout: 30000 });
  const status = await f.locator("#status").textContent();
  if (status !== "Slide 4 of 6") fail(`${name}: opened at "${status}" (want Slide 4 of 6)`);
  const title = await f.locator(".stage .sl-title").first().textContent();
  if (!/Revenue by region/.test(title)) fail(`${name}: slide 4 title "${title}"`);
  if ((await f.locator(".stage table.sl-table").count()) !== 1) fail(`${name}: no table on slide 4`);
  const thumbs = await f.locator("#thumbs").isVisible();
  if (thumbs !== (name === "laptop")) fail(`${name}: thumbnails visible=${thumbs}`);
  await shot(p, `pptx-${name}-slide4`);
  await f.locator("#next").click();
  if ((await f.locator("#status").textContent()) !== "Slide 5 of 6") fail(`${name}: next didn't move`);
  await f.locator("#prev").click();
  await f.locator("#prev").click();
  await f.locator("#notesBtn").click();
  const notes = await f.locator("#notesText").textContent();
  if (!/walrus discount/.test(notes) && !/no speaker notes/.test(notes)) fail(`${name}: notes "${notes}"`);
  await shot(p, `pptx-${name}-notes`);
  const dl = await f.locator("#dl").getAttribute("href");
  if (!/dl=1/.test(dl) || !/fn=Q3%20board%20review\.pptx/.test(dl)) fail(`${name}: download ${dl}`);
  log(name, "ok:", status, "→ next/prev, notes, download", dl.split("?")[0]);
  await c.close();
}
await browser.close();
log("pptx: all checks passed");
