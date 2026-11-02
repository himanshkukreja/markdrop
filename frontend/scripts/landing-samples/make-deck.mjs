#!/usr/bin/env node
/**
 * acme-deck.pdf: the landing page's sample PDF, five 16:9 vector slides with fictional Acme content,
 * printed by headless Chrome (so it is a real PDF with real text, like a deck exported from slides).
 *
 *   node frontend/scripts/landing-samples/make-deck.mjs
 */
import { chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEAL = "#0F766E";
const INK = "#16181D";
const FONT = `-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif`;
const LOGO = `<svg width="44" height="44" viewBox="0 0 64 64"><rect x="2" y="2" width="60" height="60" rx="16" fill="${TEAL}"/><path d="M32 14 L49 50 H41.5 L38 42 H26 L22.5 50 H15 Z M28.6 35.5 H35.4 L32 27.5 Z" fill="#fff"/></svg>`;

const foot = (n) => `<div class="foot"><span>Acme · Workflows launch</span><span>${n} / 5</span></div>`;
const slides = [
  `<section class="cover">${LOGO}<h1>Workflows</h1><p>Launch review · Acme deck</p><span class="date">Friday release</span></section>`,
  `<section><h2>Where we are</h2><div class="kpis">
     <div><b>412</b><span>beta workspaces</span></div><div><b>9,800</b><span>workflows run a day</span></div><div><b>97.6%</b><span>runs on schedule</span></div></div>
     <p class="note">Beta opened six weeks ago. Every number above is from the beta workspaces.</p>${foot(2)}</section>`,
  `<section><h2>What ships on Friday</h2><ol>
     <li><b>Chained steps</b> — run one step after another, with retries</li>
     <li><b>Schedules</b> — hourly, daily, or a cron line</li>
     <li><b>Run history</b> — every run, its input and its output</li>
     <li><b>Alerts</b> — Slack or email when a run fails</li></ol>${foot(3)}</section>`,
  `<section><h2>Runs a day in beta, in hundreds</h2><svg class="chart" viewBox="0 0 900 300">
     <g fill="${TEAL}">${[18, 26, 31, 44, 52, 61, 70, 86, 98].map((v, i) => `<rect x="${30 + i * 96}" y="${290 - v * 2.8}" width="60" height="${v * 2.8}" rx="6"/>`).join("")}</g>
     <g font-size="18" fill="#667085">${["W1", "", "W2", "", "W3", "", "W4", "", "W6"].map((t, i) => `<text x="${60 + i * 96}" y="300" text-anchor="middle" dy="0">${t}</text>`).join("")}</g></svg>
     <p class="note">From 1,800 to 9,800 runs a day in six weeks.</p>${foot(4)}</section>`,
  `<section><h2>What it costs</h2><table><tr><th>Plan</th><th>Runs a month</th><th>Price</th></tr>
     <tr><td>Starter</td><td>2,000</td><td>Included</td></tr><tr><td>Team</td><td>50,000</td><td>$8 a seat</td></tr><tr><td>Scale</td><td>Unlimited</td><td>$14 a seat</td></tr></table>
     <p class="note">Ask Maya for the pricing calculator.</p>${foot(5)}</section>`,
];

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Acme deck</title><style>
@page { size: 1280px 720px; margin: 0 }
* { box-sizing: border-box } body { margin: 0; font-family: ${FONT}; color: ${INK} }
section { position: relative; width: 1280px; height: 720px; padding: 80px 96px; page-break-after: always; overflow: hidden; background: #fff }
section.cover { display: flex; flex-direction: column; justify-content: center; gap: 18px; background: ${TEAL}; color: #fff }
section.cover svg rect { fill: #fff } section.cover svg path { fill: ${TEAL} }
.cover h1 { margin: 0; font-size: 104px; letter-spacing: -3px } .cover p { margin: 0; font-size: 30px; opacity: .9 }
.cover .date { margin-top: 30px; font-size: 22px; font-weight: 600; opacity: .8 }
h2 { margin: 0 0 44px; font-size: 54px; letter-spacing: -1.2px }
.kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 28px }
.kpis div { padding: 32px; border-radius: 18px; background: #F0F7F6 } .kpis b { display: block; font-size: 64px; color: ${TEAL}; letter-spacing: -2px } .kpis span { font-size: 22px; color: #475467 }
ol { margin: 0; padding-left: 36px; font-size: 32px; line-height: 1.9 } ol b { color: ${TEAL} }
.chart { width: 100%; height: 330px }
table { width: 100%; border-collapse: collapse; font-size: 28px } th { text-align: left; color: #667085; font-size: 20px; text-transform: uppercase; letter-spacing: 1px; padding: 0 0 14px }
td { padding: 22px 0; border-top: 2px solid #E4E7EC } td:first-child { font-weight: 700 }
.note { position: absolute; left: 96px; bottom: 96px; margin: 0; font-size: 22px; color: #667085 }
.foot { position: absolute; left: 96px; right: 96px; bottom: 40px; display: flex; justify-content: space-between; font-size: 16px; color: #98A2B3 }
</style></head><body>${slides.join("")}</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html);
await page.pdf({ path: path.join(HERE, "acme-deck.pdf"), width: "1280px", height: "720px", printBackground: true, preferCSSPageSize: true });
await browser.close();
console.log("wrote acme-deck.pdf");
