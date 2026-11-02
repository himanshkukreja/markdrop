#!/usr/bin/env node
/**
 * The landing desk's screenshots (public/landing-desk/screens and posters): every one is a capture of
 * Markdrop's REAL render of a sample file, taken from a running app (next dev or next start of this
 * checkout, with build-demo.mjs run first):
 *
 *   BASE=http://localhost:3456 node frontend/scripts/landing-samples/screens.mjs [screens] [posters]
 *
 * screens   calculator.webp       the laptop's screen: the HTML sample, as its frame renders it
 *           deck-phone(.dark)     the phone's screen: the PDF viewer (artifact Worker) on the deck
 *           launch-notes-doc(.dark)  the stamped document: notes.md through MarkdownPreview
 * posters   <id>(.dark).webp      each link card's live render on the desk, once it is ready: what
 *                                 the card shows before (and while) the real renderer loads
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
mkdirSync(path.join(OUT, "posters"), { recursive: true });

const want = process.argv.slice(2);
const doScreens = !want.length || want.includes("screens");
const doPosters = !want.length || want.includes("posters");

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
  // The laptop: the calculator at a desktop-ish width (it is white paper in both themes).
  {
    const ctx = await context("light", { width: 800, height: 500 }, 1.2);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/landing-demo/acme-pricing-calculator.html`, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    const png = path.join(TMP, "calc.png");
    await page.screenshot({ path: png });
    webp(png, path.join(OUT, "screens/calculator.webp"));
    await ctx.close();
  }
  for (const theme of ["light", "dark"]) {
    const suffix = theme === "dark" ? ".dark" : "";
    // The phone: the PDF viewer on the deck at a phone's width.
    {
      const ctx = await context(theme, { width: 360, height: 720 }, 1);
      const page = await ctx.newPage();
      await page.goto(`${BASE}/landing-demo/pdf.${theme}.html`, { waitUntil: "networkidle" });
      await page.waitForFunction(() => document.querySelectorAll(".page canvas").length >= 2, null, { timeout: 30000 });
      await page.waitForTimeout(600);
      const png = path.join(TMP, `deck${suffix}.png`);
      await page.screenshot({ path: png });
      webp(png, path.join(OUT, `screens/deck-phone${suffix}.webp`));
      await ctx.close();
    }
    // The stamped document: the phone layout's first card (notes.md), its render laid out in full.
    {
      const ctx = await context(theme, { width: 594, height: 1400 }, 2);
      const page = await ctx.newPage();
      await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
      const card = page.locator('section[aria-label^="Link card"]').first();
      await card.scrollIntoViewIfNeeded();
      await card.locator("[data-ready]").waitFor({ timeout: 30000 });
      await page.waitForTimeout(800);
      // The render, lifted out of the card into a plain 560px column, so it is captured whole.
      await card.locator("[data-ready] > div").first().evaluate((el) => {
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
      const doc = page.locator("#capture");
      const png = path.join(TMP, `doc${suffix}.png`);
      await doc.screenshot({ path: png });
      webp(png, path.join(OUT, `screens/launch-notes-doc${suffix}.webp`));
      await ctx.close();
    }
  }
}

if (doPosters) {
  const FILES = [
    ["md", true],
    ["html", false],
    ["pdf", true],
    ["video", false],
    ["sheet", true],
  ];
  for (const theme of ["light", "dark"]) {
    const ctx = await context(theme, { width: 1440, height: 1000 }, 2);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    for (const [id, dark] of FILES) {
      if (theme === "dark" && !dark) continue;
      await page.locator(`button[data-file="${id}"]`).click();
      const card = page.locator('section[aria-label^="Link card"]').first();
      await card.locator("[data-ready]").waitFor({ timeout: 30000 });
      await page.waitForTimeout(id === "pdf" ? 1500 : 900);
      // Straighten the card (it lies tilted on the desk) so the capture is the render alone.
      await card.evaluate((el) => {
        el.style.transform = "none";
        el.style.animation = "none";
      });
      await page.waitForTimeout(200);
      const body = card.locator(":scope > div").nth(1);
      const png = path.join(TMP, `poster-${id}.png`);
      await body.screenshot({ path: png });
      webp(png, path.join(OUT, `posters/${id}${theme === "dark" ? ".dark" : ""}.webp`), 78);
    }
    await ctx.close();
  }
}

await browser.close();
rmSync(TMP, { recursive: true, force: true });
