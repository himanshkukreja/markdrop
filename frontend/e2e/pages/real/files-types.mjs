/**
 * Filter by type (feat/files-type-filter) on the REAL stack: the type chips on My files, Shared with
 * me, Recent and a workspace folder — server-side filtering, counts, the URL (?type=), remembered per
 * view, search + type, the empty state per type, only what the viewer can open, and phones/tablets
 * (no page overflow, the chip row scrolls in its own box, 44 px chips) in light and dark.
 *
 *   PB_STACK_ID=N [BROWSER=webkit] [ONLY=myfiles,empty,phone,tablet,shared,recent,folder,stranger] node files-types.mjs
 *
 * Seeds on top of seed.py (Ada owns an image, a PDF, an HTML page and a document in Acme › Guides):
 * Ada uploads a video, a CSV, a Word document and a JSON file (unfiled, link access), shares the
 * video, the CSV and the Launch plan with Ben, and Ben opens a few things (Recent).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { APP, BROWSER, STACK_ID, here, log, fail, reseed, api, launch, ctx, shot, stepper, uploadFile } from "./lib.mjs";

const FIX = process.env.PB_FIXTURES || path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../scripts/docs-media/.data/fixtures");
const ROOT = path.resolve(here, "../../../..").split("/.claude/worktrees/")[0];
const PY = path.join(ROOT, "backend", ".venv", "bin", "python");
const S = reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = S.ws;
const browser = await launch();
const { step, results } = stepper(browser);

/* ── Seed ───────────────────────────────────────────────────────────── */

const video = fs.readFileSync(path.join(FIX, "product-demo-v1.mp4"));
await uploadFile(T.owner, { bytes: video, filename: "product-demo.mp4", mime: "video/mp4", title: "Product demo", slug: "product-demo" });
await uploadFile(T.owner, { bytes: Buffer.from("month,spend\nJan,120\nFeb,140\n"), filename: "budget.csv", mime: "text/csv", title: "Budget", slug: "budget-sheet" });
// A tiny .docx-shaped upload: the listing only needs the type (the Worker renders it later).
await uploadFile(T.owner, { bytes: Buffer.from("PK\u0003\u0004 not really a docx"), filename: "brief.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", title: "Design brief", slug: "design-brief" });
await uploadFile(T.owner, { bytes: Buffer.from('{"plan":"pro"}'), filename: "config.json", mime: "application/json", title: "Config", slug: "config-json" });
// Straight to the sandbox db: the seed's @*.test addresses are refused by the sharing route (seed_mobile_shell.py).
execFileSync(PY, [path.join(here, "seed_mobile_shell.py"), JSON.stringify(["product-demo", "budget-sheet", "launch-plan"].map((slug) => ({
  slug, from: S.users.owner.id, from_email: S.users.owner.email, from_name: "Ada", to: S.users.member.id, to_email: S.users.member.email,
})))], { stdio: "pipe", env: { ...process.env, STACK_ID: String(STACK_ID) } });
// Ben opens a PDF, the video and the Launch plan (Recent records signed-in reads).
for (const slug of ["q3-report", "product-demo", "launch-plan"]) {
  const r = await api("GET", `/api/v1/documents/${slug}`, T.member);
  if (r.status !== 200) fail(`Ben opens ${slug} → ${r.status}`);
}

const mine = await api("GET", "/api/v1/me/documents?per_page=50", T.owner);
const C = mine.body.count_by_type;
log("Ada's counts", JSON.stringify(C));
const want = { document: 1, pdf: 1, video: 1, image: 1, sheet: 1, word: 1, html: 1, other: 1, slides: 0 };
for (const [t, n] of Object.entries(want)) if ((C[t] ?? 0) < n || (n === 0 && C[t] !== 0)) fail(`count_by_type.${t} = ${C[t]}, wanted ${n}`);

/* ── Helpers ───────────────────────────────────────────────────────── */

const chips = (p) => p.getByRole("tablist", { name: "File type" });
const chip = (p, label) => chips(p).getByRole("tab", { name: new RegExp(`^${label.replace(/[&]/g, "\\$&")}\\b`) });
const typeParam = (p) => new URL(p.url()).searchParams.get("type");

async function waitUrl(p, pred, what) {
  for (let i = 0; i < 60; i++) {
    if (pred(new URL(p.url()))) return;
    await p.waitForTimeout(100);
  }
  fail(`URL never ${what}: ${p.url()}`);
}

/** Rows' titles in My files (the DocRow list). */
const fileTitles = (p) => p.locator('main ul[aria-label] > li').evaluateAll((lis) => lis.map((li) => (li.querySelector("a")?.textContent || li.textContent || "").trim()));

/** Layout checks for touch screens: no page overflow; the chip row scrolls in its own box; chips ≥ 44 px. */
async function touchLayout(p, label) {
  const m = await p.evaluate(() => {
    const row = document.querySelector('[role="tablist"][aria-label="File type"]');
    const tabs = row ? [...row.querySelectorAll('[role="tab"]')] : [];
    return {
      pageOver: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      rowW: row?.clientWidth ?? 0, rowSW: row?.scrollWidth ?? 0,
      rowRight: row ? row.getBoundingClientRect().right : 0, vw: window.innerWidth,
      minH: Math.min(...tabs.map((t) => t.getBoundingClientRect().height)),
      minW: Math.min(...tabs.map((t) => t.getBoundingClientRect().width)),
      font: Math.min(...tabs.map((t) => parseFloat(getComputedStyle(t).fontSize))),
      selVisible: (() => {
        const s = row?.querySelector('[aria-selected="true"]');
        if (!s || !row) return false;
        const a = s.getBoundingClientRect(), b = row.getBoundingClientRect();
        return a.left >= b.left - 1 && a.right <= b.right + 1;
      })(),
    };
  });
  log(label, JSON.stringify(m));
  if (m.pageOver > 0) fail(`${label}: the page scrolls sideways by ${m.pageOver}px`);
  if (m.rowRight > m.vw + 0.5) fail(`${label}: the chip row runs off the screen (${m.rowRight} > ${m.vw})`);
  if (m.minH < 44 || m.minW < 44) fail(`${label}: a chip is under 44px (${m.minW}×${m.minH})`);
  if (m.font < 12) fail(`${label}: chip text under 12px`);
  if (!m.selVisible) fail(`${label}: the selected chip is scrolled out of view`);
  return m;
}

/* ── My files ──────────────────────────────────────────────────────── */

await step("myfiles", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/dashboard/files`);
  await chips(p).waitFor();
  await chip(p, "Videos").waitFor();
  // Chips: All, Documents always; a type once Ada has one; none for Slides (she has none).
  const labels = await chips(p).getByRole("tab").allTextContents();
  log("chips", labels.join(" | "));
  for (const l of ["All", "Documents", "PDFs", "Videos", "Images", "Sheets", "Word", "HTML & sites", "Other"]) {
    if (!labels.some((x) => x.startsWith(l))) fail(`no ${l} chip`);
  }
  if (labels.some((x) => x.startsWith("Slides"))) fail("a Slides chip with nothing in it");
  if (!labels.some((x) => x === `Videos${C.video}`)) fail(`the Videos chip doesn't say ${C.video}: ${labels}`);
  await shot(p, "files-types-myfiles-light");

  // Server-side filter, in the URL.
  await chip(p, "Videos").click();
  await waitUrl(p, (u) => u.searchParams.get("type") === "video", "?type=video");
  await p.getByRole("heading", { name: "Videos", level: 1 }).waitFor();
  await p.waitForFunction(() => document.querySelectorAll("main ul[aria-label] > li").length === 1);
  const vids = await fileTitles(p);
  if (!vids[0]?.includes("Product demo")) fail(`Videos lists ${vids}`);
  await shot(p, "files-types-videos-light");

  // Remembered: a bare visit opens on Videos again.
  await p.goto(`${APP}/dashboard/files`);
  await waitUrl(p, (u) => u.searchParams.get("type") === "video", "restored to ?type=video");
  const stored = await p.evaluate(() => localStorage.getItem("md:files:type"));
  if (stored !== "video") fail(`remembered ${stored}`);
  // A link that says something else wins over the remembered type.
  await p.goto(`${APP}/dashboard/files?type=pdf`);
  await p.getByRole("heading", { name: "PDFs", level: 1 }).waitFor();
  if (typeParam(p) !== "pdf") fail(`?type=pdf became ${typeParam(p)}`);

  // Search + type: Documents + "launch" → the Launch plan; Documents + "budget" → nothing (it's a sheet).
  await chip(p, "Documents").click();
  await waitUrl(p, (u) => u.searchParams.get("type") === "document", "?type=document");
  const box = p.getByRole("searchbox").first();
  await box.fill("budget");
  await waitUrl(p, (u) => u.searchParams.get("q") === "budget", "?q=budget");
  await p.getByText("No documents match").waitFor();
  await p.getByRole("button", { name: "Show every type" }).click();
  await waitUrl(p, (u) => !u.searchParams.get("type") && u.searchParams.get("q") === "budget", "all types + q");
  await p.waitForFunction(() => [...document.querySelectorAll("main ul[aria-label] > li")].some((li) => li.textContent.includes("Budget")));

  // All forgets the remembered type.
  await p.goto(`${APP}/dashboard/files?type=image`);
  await chip(p, "All").click();
  await waitUrl(p, (u) => !u.searchParams.get("type"), "no type");
  if (await p.evaluate(() => localStorage.getItem("md:files:type"))) fail("All didn't forget the type");

  // The old ?kind=artifact link still works (an "All files" chip while it's on).
  await p.goto(`${APP}/dashboard/files?kind=artifact`);
  await chip(p, "All files").waitFor();
  await p.getByRole("heading", { name: "Files", level: 1 }).waitFor();
});

await step("empty", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/dashboard/files?type=slides`);
  await p.getByText("No slide decks yet").waitFor();
  const up = p.getByRole("link", { name: "Upload a deck" });
  if ((await up.getAttribute("href")) !== "/upload") fail("Upload a deck doesn't open /upload");
  if ((await chip(p, "Slides").getAttribute("aria-selected")) !== "true") fail("the Slides chip isn't shown selected");
  await shot(p, "files-types-empty-light");
});

await step("dark", async () => {
  const { p } = await ctx(browser, { token: T.owner, theme: "dark" });
  await p.goto(`${APP}/dashboard/files?type=pdf`);
  await chip(p, "PDFs").waitFor();
  await p.waitForFunction(() => document.querySelectorAll("main ul[aria-label] > li").length >= 1);
  await shot(p, "files-types-pdf-dark");
});

/* ── Phones and tablets ────────────────────────────────────────────── */

const DEVICES = [
  ["phone", 360, 780], ["phone", 393, 852], ["tablet", 744, 1133], ["tablet", 768, 1024], ["tablet", 1024, 768],
];
for (const [kind, w, h] of DEVICES) {
  await step(`${kind}-${w}`, async () => {
    for (const theme of ["light", "dark"]) {
      const { p } = await ctx(browser, { token: T.owner, width: w, height: h, mobile: true, theme });
      await p.goto(`${APP}/dashboard/files?type=other`);
      await chip(p, "Other").waitFor();
      await p.waitForTimeout(400);
      const m = await touchLayout(p, `${w}×${h} ${theme} My files`);
      if (w <= 400 && m.rowSW <= m.rowW) log(`(${w}: every chip fits, no sideways scroll needed)`);
      await shot(p, `files-types-${kind}-${w}-${theme}`);
      if (theme === "light") {
        // Tapping a chip filters; the row (not the page) scrolls.
        await chip(p, "Videos").tap();
        await waitUrl(p, (u) => u.searchParams.get("type") === "video", "tapped ?type=video");
        await touchLayout(p, `${w}×${h} after a tap`);
      }
      await p.context().close();
    }
  });
}

/* ── Shared with me, Recent, a folder (Ben) ────────────────────────── */

await step("shared", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/shared`);
  await chip(p, "Videos").waitFor();
  const labels = await chips(p).getByRole("tab").allTextContents();
  log("shared chips", labels.join(" | "));
  if (!labels.includes("All3") || !labels.includes("Videos1") || !labels.includes("Sheets1") || !labels.includes("Documents1")) fail(`shared chips ${labels}`);
  await shot(p, "files-types-shared-light");
  await chip(p, "Sheets").click();
  await waitUrl(p, (u) => u.searchParams.get("type") === "sheet", "?type=sheet");
  await p.waitForFunction(() => document.querySelector("main")?.innerText.includes("Budget"));
  await p.waitForFunction(() => !document.body.innerText.includes("Product demo"));
  await p.goto(`${APP}/shared`);
  await waitUrl(p, (u) => u.searchParams.get("type") === "sheet", "shared remembered sheet");
  await chip(p, "All").click();
  await waitUrl(p, (u) => !u.searchParams.get("type"), "shared all");
});

await step("recent", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/recent`);
  await chip(p, "PDFs").waitFor();
  await chip(p, "PDFs").click();
  await waitUrl(p, (u) => u.searchParams.get("type") === "pdf", "?type=pdf");
  await p.getByText("Q3 report").first().waitFor();
  await p.waitForFunction(() => !document.body.innerText.includes("Launch plan"));
  await shot(p, "files-types-recent-light");
});

await step("folder", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/w/${WS}/f/${S.folder}`);
  await chip(p, "PDFs").waitFor();
  const labels = await chips(p).getByRole("tab").allTextContents();
  log("folder chips", labels.join(" | "));
  for (const l of ["All4", "Documents1", "PDFs1", "Images1", "HTML & sites1"]) if (!labels.includes(l)) fail(`folder chips ${labels} (no ${l})`);
  if (labels.some((l) => l.startsWith("Videos"))) fail("a Videos chip in a folder with no video");
  await shot(p, "files-types-folder-light");
  await chip(p, "PDFs").click();
  await waitUrl(p, (u) => u.searchParams.get("type") === "pdf", "folder ?type=pdf");
  await p.waitForFunction(() => !document.querySelector("main")?.innerText.includes("Pricing calculator"));
  await p.getByText("Q3 report").first().waitFor();
  await shot(p, "files-types-folder-pdf-light");
  // Opening another place shows everything again (a folder's type isn't remembered).
  await p.goto(`${APP}/w/${WS}/f/${S.folder}`);
  await p.getByText("Pricing calculator").first().waitFor();
  if (typeParam(p)) fail(`folder restored ?type=${typeParam(p)}`);
});

await step("stranger", async () => {
  // Cy has nothing shared and no workspace: no chips, and the API counts are all zero.
  const r = await api("GET", "/api/v1/me/shared?counts=true", T.stranger);
  if (Object.values(r.body.count_by_type).some((n) => n)) fail(`stranger counts ${JSON.stringify(r.body.count_by_type)}`);
  const f = await api("GET", `/api/v1/workspaces/${WS}/items?folder=${S.folder}&type=pdf`, T.stranger);
  if (f.status < 400) fail(`stranger lists the folder → ${f.status}`);
  const { p } = await ctx(browser, { token: T.stranger });
  await p.goto(`${APP}/shared`);
  await p.getByText("Nothing shared with you yet").waitFor();
  if (await chips(p).count()) fail("chips on an empty Shared with me");
});

await browser.close();
const failed = results.filter((r) => r[1] !== "ok");
console.log(`\n${BROWSER}: ${results.length - failed.length}/${results.length} passed`);
for (const r of failed) console.log(`  ✗ ${r[0]}: ${r[1]}`);
process.exit(failed.length ? 1 : 0);
