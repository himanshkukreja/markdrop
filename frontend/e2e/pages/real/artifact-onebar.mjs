/**
 * Files (artifacts): one top bar, like documents and pages. Screenshots of the framed view ("Show
 * details") of an HTML page, a PDF, an image, a video and a sheet, as the owner and anonymously on
 * markdrop.in and anonymously on the workspace's domain, at 1440 and 390, with the layout of each
 * screen (fileLayout: the bars, the headers on screen, the gap between the lowest bar and the file).
 *   OUT=<dir> [THEMES=light,dark] [KINDS=html,pdf] node artifact-onebar.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { APP, TENANT, log, reseed, api, docOf, launch, ctx, uploadFile, fileLayout } from "./lib.mjs";

const OUT = process.env.OUT || "/tmp/artifact-onebar";
const THEMES = (process.env.THEMES || "light").split(",");
const FIX = process.env.PB_FIXTURES;
fs.mkdirSync(OUT, { recursive: true });
const S = reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const filing = { workspace: S.ws, folder: S.folder, access_level: "link" };
const CSV = "Region,Q1,Q2,Q3\nNorth,120,135,160\nSouth,98,110,121\nEast,143,150,171\nWest,87,95,104\n";

const kinds = {
  html: "pricing-calc",
  pdf: "q3-report",
  image: "team-photo",
  video: (await uploadFile(T.owner, { bytes: fs.readFileSync(path.join(FIX, "product-demo-v1.mp4")), filename: "product-demo.mp4", mime: "video/mp4", title: "Product demo", slug: "product-demo", ...filing })).slug,
  sheet: (await uploadFile(T.owner, { bytes: Buffer.from(CSV), filename: "regions.csv", mime: "text/csv", title: "Regional sales", slug: "regional-sales", ...filing })).slug,
};
for (const slug of Object.values(kinds)) await api("PUT", `/api/v1/documents/${slug}/access/level`, T.owner, { level: "link" });
await fetch(`${APP}/api/revalidate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag: "host:acme.localhost" }) });
const only = process.env.KINDS ? new Set(process.env.KINDS.split(",")) : null;

const browser = await launch();
const report = [];
for (const [kind, slug] of Object.entries(kinds)) {
  if (only && !only.has(kind)) continue;
  const d = await docOf(slug, T.owner);
  const cases = [
    ["owner", T.owner, `${APP}/${slug}`],
    ["anon", null, `${APP}/${slug}`],
    ["tenant-anon", null, `${TENANT}/${[...(d.folder_path || []), slug].join("/")}`],
  ];
  for (const [who, token, url] of cases) {
    for (const theme of THEMES) {
      for (const width of [1440, 390]) {
        const { c, p } = await ctx(browser, { token, theme, width, height: width < 500 ? 844 : 900, mobile: width < 500 });
        try {
          await p.goto(url, { waitUntil: "networkidle" });
          await p.getByRole("button", { name: "Show details" }).click({ timeout: 25000 });
          await p.locator("main iframe").first().waitFor({ timeout: 25000 });
          await p.waitForTimeout(2500);
          const layout = await fileLayout(p);
          const file = path.join(OUT, `${kind}-${who}-${theme}-${width}.png`);
          await p.screenshot({ path: file });
          const sw = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          report.push({ kind, who, theme, width, ...layout, hscroll: sw });
          log(kind, who, theme, width, `bars=${layout.bars.length}`, `headers=${layout.headers.join(",")}`, `gap=${layout.gap}`, sw > 0 ? `HSCROLL ${sw}` : "");
        } catch (e) {
          log("FAIL", kind, who, theme, width, e.message.slice(0, 200));
          report.push({ kind, who, theme, width, error: e.message.slice(0, 200) });
        }
        await c.close();
      }
    }
  }
}
fs.writeFileSync(path.join(OUT, "layout.json"), JSON.stringify(report, null, 1));
await browser.close();
