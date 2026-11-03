/** Probe: run.mjs's reader step exactly, until the reader sticks; then what the page did. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API, APP, context, launch, newPage } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const content = fs.readFileSync(path.resolve(here, "../../../src/components/docs-editor/test/fixtures/pages.md"), "utf8");
const browser = await launch();
for (let run = 0; run < Number(process.env.RUNS ?? 4); run++) {
  const slug = await newPage("All of round 2", content);
  for (const width of [1280, 390]) {
    const { p, c } = await context(browser, { width, height: width < 500 ? 844 : 900 });
    const log = [];
    const t0 = Date.now();
    p.on("console", (m) => log.push(`${Date.now() - t0}ms console.${m.type()}: ${m.text().slice(0, 160)}`));
    p.on("response", (r) => r.url().startsWith(API) && log.push(`${Date.now() - t0}ms ${r.status()} ${r.request().method()} ${r.url().slice(API.length, API.length + 100)}`));
    p.on("framenavigated", (f) => f === p.mainFrame() && log.push(`${Date.now() - t0}ms navigated ${f.url()}`));
    await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
    const ok = await p.locator(".pb-columns").first().waitFor({ timeout: 15000 }).then(() => true, () => false);
    console.log(`run ${run} ${width}: ${ok ? "ok" : "STUCK"}`);
    if (!ok) {
      console.log(log.join("\n"));
      console.log("body:", (await p.locator("body").innerText()).slice(0, 300).replace(/\n+/g, " | "));
      console.log("hydrated:", await p.evaluate(() => !!document.querySelector("[data-reactroot], #__next") || typeof window.next));
    } else if (width === 1280) await p.screenshot({ path: path.join(here, ".probe.png"), fullPage: true });
    await c.close();
  }
}
await browser.close();
