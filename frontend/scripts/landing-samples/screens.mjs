#!/usr/bin/env node
/**
 * The landing page's screenshots (public/landing-desk/hero and screens): every one is a capture of
 * Markdrop's REAL render of a sample file, taken from a running app (next dev or next start of this
 * checkout, with NEXT_PUBLIC_LIGHT_THEME=true and build-demo.mjs run first):
 *
 *   BASE=http://localhost:3456 node frontend/scripts/landing-samples/screens.mjs [hero] [screens]
 *
 * hero      hero/<id>(.phone)(.dark).webp  the hero laptop's screen with each file's live render, at
 *                                 the screen's own size (desktop 456 wide, phone 306), light and dark:
 *                                 what the laptop shows until the real renderer is ready, the phone
 *                                 and the paper note on the desk, and the "what renders" cards
 * screens   launch-notes-doc(.dark)  the stamped document (Sharing): notes.md through MarkdownPreview,
 *                                 laid out whole in a 560px column
 *
 * PNG screenshots are converted to WebP with ffmpeg (libwebp). Nothing here touches the API.
 */
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "../../public/landing-desk");
const BASE = process.env.BASE || "http://localhost:3456";
const FFMPEG = process.env.FFMPEG || (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg");
const TMP = path.join(os.tmpdir(), `landing-screens-${process.pid}`);
mkdirSync(TMP, { recursive: true });
mkdirSync(path.join(OUT, "screens"), { recursive: true });

const want = process.argv.slice(2);
const doScreens = !want.length || want.includes("screens");
const doHero = !want.length || want.includes("hero");

function webp(png, out, quality = 80) {
  execFileSync(FFMPEG, ["-v", "error", "-y", "-i", png, "-c:v", "libwebp", "-quality", String(quality), "-compression_level", "6", out]);
  console.log("wrote", path.relative(process.cwd(), out));
}

const browser = await chromium.launch();
async function context(theme, viewport, scale) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: scale, reducedMotion: "reduce" });
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem("md_theme", t);
      localStorage.setItem("md_notrack", "1");
      localStorage.setItem("md_consent", JSON.stringify({ analytics: false }));
    } catch {}
  }, theme);
  // Analytics and third parties never leave this machine.
  await ctx.route(/posthog|google|vercel-scripts|api\.markdrop\.in/, (r) => r.abort());
  // next dev's corner badge is not part of the page.
  await ctx.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "nextjs-portal{display:none!important}";
      document.head.appendChild(st);
    });
  });
  return ctx;
}

if (doScreens) {
  for (const theme of ["light", "dark"]) {
    const suffix = theme === "dark" ? ".dark" : "";
    // The stamped document: notes.md dropped on the hero, its render lifted out into a plain 560px
    // column, so it is captured whole.
    const ctx = await context(theme, { width: 1280, height: 1400 }, 2);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.locator('#hero [data-file="md"]:visible').first().click();
    const live = page.locator("#hero [data-screen] [data-ready]");
    await live.waitFor({ timeout: 30000 });
    await page.waitForTimeout(800);
    await live.locator(":scope > div").first().evaluate((el) => {
      const holder = document.createElement("div");
      holder.id = "capture";
      holder.style.cssText = "position:absolute;left:0;top:0;width:560px;z-index:2147483646;background:var(--surface-raised)";
      const clone = el.cloneNode(true);
      clone.style.cssText = "position:static;overflow:visible;height:auto;inset:auto";
      holder.appendChild(clone);
      document.body.appendChild(holder);
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(300);
    const png = path.join(TMP, `doc${suffix}.png`);
    await page.locator("#capture").screenshot({ path: png });
    webp(png, path.join(OUT, `screens/launch-notes-doc${suffix}.webp`));
    await ctx.close();
  }
}

if (doHero) {
  mkdirSync(path.join(OUT, "hero"), { recursive: true });
  const IDS = ["html", "md", "pdf", "video", "sheet"];
  const LAYOUTS = [
    // The desktop artboard at 1280 × 720 draws the hero at its own pixels; the screen is 456 wide.
    { name: "", viewport: { width: 1280, height: 720 }, scale: 2, h: 420 },
    // The phone artboard: the screen is 306 wide.
    { name: ".phone", viewport: { width: 390, height: 844 }, scale: 3, h: 300 },
  ];
  for (const L of LAYOUTS) {
    for (const theme of ["light", "dark"]) {
      const ctx = await context(theme, L.viewport, L.scale);
      for (const id of IDS) {
        const page = await ctx.newPage();
        await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
        // Drop the file with its visible button (the desk object or, on a phone, its chip).
        await page.locator(`#hero [data-file="${id}"]:visible`).first().click();
        const view = page.locator("#hero [data-screen]");
        await view.locator("[data-ready]").waitFor({ timeout: 30000 });
        // The screen alone: taller (the poster is cropped to the screen's height), the laptop
        // straightened, and nothing else on the desk drawn over it.
        await view.evaluate((el, h) => {
          el.style.height = `${h}px`;
          const laptop = el.parentElement?.parentElement?.parentElement;
          if (laptop) {
            laptop.style.transform = "none";
            laptop.style.filter = "none";
          }
          const st = document.createElement("style");
          st.textContent = "#hero *{visibility:hidden!important} #hero [data-screen], #hero [data-screen] *{visibility:visible!important} #hero [data-screen] [role=status]{display:none!important}";
          document.head.appendChild(st);
        }, L.h);
        await page.waitForTimeout(id === "pdf" ? 1800 : 1000);
        const png = path.join(TMP, `hero-${id}${L.name}-${theme}.png`);
        await view.screenshot({ path: png });
        webp(png, path.join(OUT, `hero/${id}${L.name}${theme === "dark" ? ".dark" : ""}.webp`), 80);
        await page.close();
      }
      await ctx.close();
    }
  }
}

await browser.close();
rmSync(TMP, { recursive: true, force: true });
