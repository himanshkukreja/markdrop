/**
 * Classic (Markdown) documents: one top bar, like pages. Screenshots of read (full screen), view
 * details (framed) and edit, on markdrop.in and on the workspace's domain, at 1440 and 390, and the
 * count of top bars on each screen (topBars: 1 in view details and edit, 0 in full screen).
 *   OUT=<dir> [THEMES=light,dark] node classic-onebar.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { APP, TENANT, log, reseed, api, docOf, launch, ctx, topBars } from "./lib.mjs";

const OUT = process.env.OUT || "/tmp/classic-onebar";
const THEMES = (process.env.THEMES || "light").split(",");
fs.mkdirSync(OUT, { recursive: true });
const S = reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const body = "# Release notes\n\nWhat changed this week, for everyone who reads the handbook.\n\n## Highlights\n\n- One top bar on every document\n- Faster search\n\n## Fixes\n\nMore notes follow here, with enough text to make the column feel like a real document.\n\n## Next\n\nThe docs and the videos.\n";
const r = await api("POST", "/api/v1/documents", T.owner, { content: body, title: "Release notes", expires_in: "never", access_level: "link", workspace: S.ws, folder: S.folder });
if (r.status !== 201) throw new Error(`create → ${r.status} ${JSON.stringify(r.body)}`);
const slug = r.body.slug;
const d = await docOf(slug, T.owner);
const tenantAddr = `${TENANT}/${[...(d.folder_path || []), slug].join("/")}`;
await fetch(`${APP}/api/revalidate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag: "host:acme.localhost" }) });
log("classic", slug, tenantAddr);

const browser = await launch();
const report = [];
const cases = [
  ["owner", T.owner, `${APP}/${slug}`],
  ["anon", null, `${APP}/${slug}`],
  ["tenant-anon", null, tenantAddr],
];
for (const [who, token, url] of cases) {
  for (const theme of THEMES) {
    for (const width of [1440, 390]) {
      const modes = ["read", "details", ...(who === "owner" ? ["edit"] : [])];
      for (const mode of modes) {
        const { c, p } = await ctx(browser, { token, theme, width, height: width < 500 ? 844 : 900, mobile: width < 500 });
        try {
          await p.goto(mode === "edit" ? `${url}?edit=1` : url, { waitUntil: "networkidle" });
          await p.locator("main").first().waitFor({ timeout: 25000 });
          await p.waitForTimeout(1200);
          if (mode === "details") {
            await p.getByRole("button", { name: "Show details" }).click();
            await p.waitForTimeout(900);
          }
          await p.mouse.wheel(0, 300);
          await p.waitForTimeout(500);
          const bars = await topBars(p);
          const file = path.join(OUT, `${who}-${mode}-${theme}-${width}.png`);
          await p.evaluate(() => window.scrollTo(0, 0));
          await p.waitForTimeout(300);
          await p.screenshot({ path: file });
          const sw = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          report.push({ who, mode, theme, width, bars: bars.length, which: bars, hscroll: sw });
          log(who, mode, theme, width, `bars=${bars.length}`, bars.join(" | "), sw > 0 ? `HSCROLL ${sw}` : "");
        } catch (e) {
          log("FAIL", who, mode, theme, width, e.message.slice(0, 200));
          report.push({ who, mode, theme, width, error: e.message.slice(0, 200) });
        }
        await c.close();
      }
    }
  }
}
fs.writeFileSync(path.join(OUT, "bars.json"), JSON.stringify(report, null, 1));
await browser.close();
