#!/usr/bin/env node
/**
 * Demo files for the docs media seed (seed.py uploads them). Rendered with headless Chrome so they
 * look like real files, not test patterns:
 *
 *   q3-board-deck-v1.pdf / -v2.pdf    12 vector slides, 16:9 (page.pdf); v2 changes page 4
 *   product-demo-v1.mp4 / -v2.mp4     40 s, 1280×720 H.264: eight UI-like scenes with slow push-ins
 *                                     and cross-fades (stills rendered here, motion by ffmpeg);
 *                                     v2 has a different end card
 *   hevc-recording.mov                12 s HEVC (hvc1): the "can't play this here" case
 *   acme-architecture.png             a system diagram, 1600×1000
 *   team-photo.png                    an illustrated team portrait, 1600×1067
 *   acme-logo.png / acme-favicon.png  the Acme logo (wordmark, dark on transparent) and mark
 *
 * Output: .data/fixtures/ (skips files that exist unless --force). Needs ffmpeg on PATH.
 */
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(process.env.DOCS_MEDIA_DATA || path.join(here, ".data"), "fixtures");
const FORCE = process.argv.includes("--force");
const FFMPEG = process.env.FFMPEG || "ffmpeg";
mkdirSync(OUT, { recursive: true });

const ORANGE = "#0F766E"; // Acme brand (teal); the name is historical
const INK = "#16181D";
const FONT = `-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Arial, sans-serif`;

const LOGO_SVG = (size = 64, color = ORANGE, fg = "#fff") => `
<svg width="${size}" height="${size}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <rect x="2" y="2" width="60" height="60" rx="16" fill="${color}"/>
  <path d="M32 14 L49 50 H41.5 L38 42 H26 L22.5 50 H15 Z M28.6 35.5 H35.4 L32 27.5 Z" fill="${fg}"/>
</svg>`;

// ── Slides ────────────────────────────────────────────────────────────────────

const slideCss = `
  @page { size: 1280px 720px; margin: 0 }
  * { box-sizing: border-box; margin: 0; padding: 0 }
  body { font-family: ${FONT}; color: ${INK}; -webkit-print-color-adjust: exact; print-color-adjust: exact }
  .s { width: 1280px; height: 720px; position: relative; overflow: hidden; page-break-after: always; background: #fff; padding: 72px 88px }
  .s:last-child { page-break-after: auto }
  .brand { position: absolute; left: 88px; bottom: 36px; display: flex; gap: 10px; align-items: center; font-size: 15px; color: #6B7280; font-weight: 600 }
  .num { position: absolute; right: 88px; bottom: 36px; font-size: 15px; color: #9CA3AF }
  .eyebrow { color: ${ORANGE}; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; font-size: 16px; margin-bottom: 18px }
  h1 { font-size: 64px; line-height: 1.05; letter-spacing: -.02em; font-weight: 800 }
  h2 { font-size: 44px; line-height: 1.1; letter-spacing: -.015em; font-weight: 800; margin-bottom: 36px }
  p.lead { font-size: 24px; color: #4B5563; line-height: 1.5; max-width: 900px }
  .grid { display: grid; gap: 24px }
  .card { border: 1px solid #E5E7EB; border-radius: 18px; padding: 28px; background: #FAFAFA }
  .card h3 { font-size: 22px; margin-bottom: 10px }
  .card p { font-size: 18px; color: #4B5563; line-height: 1.45 }
  .big { font-size: 56px; font-weight: 800; color: ${ORANGE}; letter-spacing: -.02em }
  .muted { color: #6B7280 }
  ul.b { list-style: none; font-size: 24px; line-height: 1.5 }
  ul.b li { padding-left: 34px; position: relative; margin-bottom: 14px }
  ul.b li::before { content: ""; position: absolute; left: 0; top: 12px; width: 14px; height: 14px; border-radius: 4px; background: ${ORANGE} }
  table { border-collapse: collapse; width: 100%; font-size: 20px }
  th, td { text-align: left; padding: 16px 18px; border-bottom: 1px solid #E5E7EB }
  th { color: #6B7280; font-size: 15px; text-transform: uppercase; letter-spacing: .06em }
  .dark { background: ${INK}; color: #fff }
  .dark .brand, .dark .num { color: #9CA3AF }
`;

function slide(n, inner, cls = "") {
  return `<section class="s ${cls}">${inner}
    <div class="brand">${LOGO_SVG(22)} Acme · Q3 2026 board update</div><div class="num">${n} / 12</div></section>`;
}

function bars(values, labels, max) {
  const w = 1000, h = 300, bw = 70, gap = (w - values.length * bw) / (values.length - 1);
  const rects = values.map((v, i) => {
    const bh = (v / max) * (h - 30);
    const x = i * (bw + gap);
    const fill = i === values.length - 1 ? ORANGE : "#99F6E4";
    return `<rect x="${x}" y="${h - bh}" width="${bw}" height="${bh}" rx="8" fill="${fill}"/>
      <text x="${x + bw / 2}" y="${h - bh - 10}" text-anchor="middle" font-size="18" font-weight="700" fill="${INK}">${v}</text>
      <text x="${x + bw / 2}" y="${h + 28}" text-anchor="middle" font-size="16" fill="#6B7280">${labels[i]}</text>`;
  });
  return `<svg width="${w}" height="${h + 40}" style="overflow:visible">${rects.join("")}</svg>`;
}

// Page 4 is the one that changes between v1 and v2 of the deck (the "replace keeps the link" docs).
const mrrSlide = (v2) => slide(4, `<div class="eyebrow">Usage</div><h2>Monthly recurring revenue ($k)${v2 ? ` <span style="font-size:22px;color:${ORANGE};vertical-align:middle;border:2px solid ${ORANGE};border-radius:999px;padding:4px 14px;margin-left:10px">Updated Oct 29</span>` : ""}</h2>${bars(v2 ? [410, 455, 492, 540, 601, 702] : [410, 455, 492, 540, 601, 688], ["May", "Jun", "Jul", "Aug", "Sep", "Oct"], 720)}
    <p class="muted" style="margin-top:22px;font-size:18px">${v2 ? "October restated to include the Northwind expansion · NRR 126% · gross churn 1.3% / month" : "Net revenue retention 124% · gross churn 1.3% / month"}</p>`);

const SLIDES_TEMPLATE = [
  slide(1, `<div style="position:absolute;inset:0;background:linear-gradient(135deg,#F0FDFA 0%,#fff 55%)"></div>
    <div style="position:relative;margin-top:110px">${LOGO_SVG(84)}
      <div class="eyebrow" style="margin-top:36px">Board meeting · October 2026</div>
      <h1>Acme Cloud<br>Q3 2026 Board Update</h1>
      <p class="lead" style="margin-top:26px">Where we are, what shipped, and what we're building next.<br>Riya Sharma · Head of Product · October 2026</p></div>`),
  slide(2, `<div class="eyebrow">Agenda</div><h2>Today</h2>
    <div class="grid" style="grid-template-columns:1fr 1fr">
      ${["Highlights of the quarter", "Usage and revenue", "What customers told us", "Roadmap for Q1 2027", "Launch plan: Workflows", "Pricing changes", "Risks and asks", "Next steps"]
        .map((t, i) => `<div class="card" style="display:flex;gap:18px;align-items:center;padding:20px 26px"><span class="big" style="font-size:30px;width:44px">${String(i + 1).padStart(2, "0")}</span><h3 style="margin:0">${t}</h3></div>`).join("")}
    </div>`),
  slide(3, `<div class="eyebrow">Highlights</div><h2>A quarter of compounding wins</h2>
    <div class="grid" style="grid-template-columns:repeat(3,1fr)">
      <div class="card"><div class="big">+38%</div><h3>Weekly active teams</h3><p>From 4,120 to 5,690 teams, led by the new onboarding checklist.</p></div>
      <div class="card"><div class="big">1.9 s</div><h3>Median dashboard load</h3><p>Down from 4.4 s after moving queries to the columnar store.</p></div>
      <div class="card"><div class="big">62</div><h3>Enterprise logos</h3><p>Including our first two customers in the public sector.</p></div>
    </div>`),
  "MRR_SLIDE",
  slide(5, `<div style="position:absolute;inset:0;background:#F0FDFA"></div><div style="position:relative;margin-top:60px">
    <div class="eyebrow">Voice of the customer</div>
    <p style="font-size:44px;line-height:1.3;font-weight:700;letter-spacing:-.01em;max-width:1000px">“We replaced three reporting tools with Acme. Our Monday metrics review went from two hours to twenty minutes.”</p>
    <p class="lead" style="margin-top:30px">— Dana Whitfield, VP Operations, Northwind Logistics</p></div>`),
  slide(6, `<div class="eyebrow">Roadmap</div><h2>Q1 2027 at a glance</h2>
    <div style="position:relative;height:330px">
      <div style="position:absolute;left:0;right:0;top:40px;height:4px;background:#E5E7EB;border-radius:2px"></div>
      ${[["Jan", "Workflows beta", "Trigger actions from any metric"], ["Feb", "SSO for all plans", "SAML and SCIM on Team"], ["Mar", "Workflows GA", "Templates and audit log"], ["Mar", "EU data residency", "Frankfurt region"]]
        .map(([m, t, d], i) => `<div style="position:absolute;left:${i * 270}px;top:0;width:250px">
          <div style="width:22px;height:22px;border-radius:50%;background:${ORANGE};border:5px solid #CCFBF1;margin-top:31px"></div>
          <div class="eyebrow" style="margin:22px 0 6px">${m}</div><h3 style="font-size:24px">${t}</h3><p class="muted" style="font-size:18px;margin-top:6px">${d}</p></div>`).join("")}
    </div>`),
  slide(7, `<div class="eyebrow">Launch plan</div><h2>Workflows: from beta to GA</h2>
    <ul class="b"><li>Private beta with 40 design partners from January 12</li><li>Public beta at the February customer webinar</li><li>GA with 25 templates, an audit log and usage-based pricing</li><li>Docs, a 3-minute product video and in-app tours ready a week before GA</li></ul>`),
  slide(8, `<div class="eyebrow">Pricing</div><h2>Plans from January 2027</h2>
    <table><tr><th>Plan</th><th>Price</th><th>Seats</th><th>Workflows</th><th>SSO</th></tr>
    <tr><td><b>Starter</b></td><td>$0</td><td>Up to 3</td><td>100 runs / mo</td><td>—</td></tr>
    <tr><td><b>Team</b></td><td>$12 / seat</td><td>Unlimited</td><td>5,000 runs / mo</td><td>SAML</td></tr>
    <tr><td><b>Business</b></td><td>$29 / seat</td><td>Unlimited</td><td>50,000 runs / mo</td><td>SAML + SCIM</td></tr>
    <tr><td><b>Enterprise</b></td><td>Custom</td><td>Unlimited</td><td>Unlimited</td><td>Everything</td></tr></table>`),
  slide(9, `<div class="eyebrow">Team</div><h2>Who's building it</h2>
    <div class="grid" style="grid-template-columns:repeat(4,1fr)">
      ${[["RS", "Riya Sharma", "Head of Product"], ["AC", "Alex Chen", "Engineering Lead"], ["SL", "Sam Lee", "Design"], ["MO", "Maya Okafor", "Data Platform"]]
        .map(([i, n, r]) => `<div class="card" style="text-align:center"><div style="width:96px;height:96px;border-radius:50%;margin:6px auto 18px;background:#CCFBF1;color:${ORANGE};font-weight:800;font-size:34px;display:flex;align-items:center;justify-content:center">${i}</div><h3>${n}</h3><p>${r}</p></div>`).join("")}
    </div>`),
  slide(10, `<div class="eyebrow">Risks and asks</div><h2>What could slow us down</h2>
    <div class="grid" style="grid-template-columns:1fr 1fr">
      <div class="card"><h3>Hiring</h3><p>Two senior data engineers still open. Ask: prioritise referrals this month.</p></div>
      <div class="card"><h3>Query costs</h3><p>Columnar storage costs grew 22%. Ask: approve reserved capacity for 2027.</p></div>
      <div class="card"><h3>EU residency</h3><p>Depends on the Frankfurt region contract signing by December 15.</p></div>
      <div class="card"><h3>Support load</h3><p>Tickets up 18% with growth. Ask: one more support engineer in APAC.</p></div>
    </div>`),
  slide(11, `<div class="eyebrow">Next steps</div><h2>Decisions we need today</h2>
    <ul class="b"><li>Approve the January pricing change</li><li>Confirm the Workflows GA date: March 18</li><li>Sign off on the 2027 infrastructure budget</li></ul>`),
  slide(12, `<div style="text-align:center;margin-top:170px">${LOGO_SVG(96)}<h1 style="margin-top:34px">Thank you</h1>
    <p class="lead" style="margin:18px auto 0">Questions: riya@acme.com · #product-review</p></div>`, "dark"),
];

const slidesFor = (v2) => SLIDES_TEMPLATE.map((x) => (x === "MRR_SLIDE" ? mrrSlide(v2) : x));

// ── Video scenes (1280×720 stills) ────────────────────────────────────────────

const appChrome = (title, body, active = 0) => `
  <div style="position:absolute;inset:48px 64px 96px;border-radius:18px;background:#fff;box-shadow:0 30px 80px -20px rgba(0,0,0,.35);overflow:hidden;display:flex;flex-direction:column">
    <div style="height:44px;background:#F3F4F6;display:flex;align-items:center;gap:8px;padding:0 16px;border-bottom:1px solid #E5E7EB">
      <span style="width:12px;height:12px;border-radius:50%;background:#F87171"></span><span style="width:12px;height:12px;border-radius:50%;background:#FBBF24"></span><span style="width:12px;height:12px;border-radius:50%;background:#34D399"></span>
      <div style="margin-left:18px;background:#fff;border:1px solid #E5E7EB;border-radius:8px;padding:5px 14px;font-size:13px;color:#6B7280;width:420px">app.acme.com/${title.toLowerCase().replace(/\s+/g, "-")}</div></div>
    <div style="flex:1;display:flex">
      <div style="width:210px;background:#FAFAFA;border-right:1px solid #E5E7EB;padding:18px 14px;font-size:14px">
        <div style="display:flex;gap:9px;align-items:center;font-weight:800;font-size:16px;margin-bottom:22px">${LOGO_SVG(24)} Acme</div>
        ${["Home", "Dashboards", "Data sources", "Alerts", "Team"].map((n, i) => `<div style="padding:9px 12px;border-radius:8px;margin-bottom:4px;${i === active ? `background:#CCFBF1;color:${ORANGE};font-weight:700` : "color:#4B5563"}">${n}</div>`).join("")}
      </div>
      <div style="flex:1;padding:26px 30px;position:relative">${body}</div>
    </div>
  </div>`;

const caption = (t) => `<div style="position:absolute;left:0;right:0;bottom:30px;text-align:center;font-size:26px;font-weight:700;color:#fff;letter-spacing:-.01em">${t}</div>`;
const sceneBg = (inner, bg = `linear-gradient(135deg,${ORANGE} 0%,#115E59 100%)`) =>
  `<div style="position:absolute;inset:0;background:${bg}"></div>${inner}`;

function lineChart() {
  const pts = [30, 42, 38, 55, 61, 58, 72, 80, 77, 92, 104, 118];
  const d = pts.map((v, i) => `${i === 0 ? "M" : "L"}${20 + i * 64},${220 - v * 1.6}`).join(" ");
  return `<svg width="760" height="240"><path d="${d} L${20 + 11 * 64},230 L20,230 Z" fill="#CCFBF1"/><path d="${d}" stroke="${ORANGE}" stroke-width="4" fill="none" stroke-linejoin="round"/></svg>`;
}

const SCENES = [
  sceneBg(`<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;text-align:center">
    ${LOGO_SVG(110, "#fff", ORANGE)}
    <div style="font-size:76px;font-weight:800;letter-spacing:-.02em;margin-top:30px">Acme Cloud</div>
    <div style="font-size:30px;opacity:.9;margin-top:12px">A two-minute tour of your new metrics home</div></div>`),
  sceneBg(appChrome("Data sources", `<div style="font-size:26px;font-weight:800;margin-bottom:6px">Connect your data</div><div style="color:#6B7280;margin-bottom:22px">Pick a source. Acme syncs it every five minutes.</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px">${[["Postgres", "Connected", "#336791"], ["Stripe", "Connected", "#635BFF"], ["HubSpot", "Connect", "#FF7A59"], ["Snowflake", "Connect", "#29B5E8"], ["Google Sheets", "Connected", "#0F9D58"], ["Salesforce", "Connect", "#00A1E0"]]
      .map(([n, s, c]) => `<div style="border:1px solid #E5E7EB;border-radius:14px;padding:18px;display:flex;align-items:center;gap:14px"><div style="width:42px;height:42px;border-radius:10px;background:${c}"></div><div style="flex:1"><div style="font-weight:700">${n}</div><div style="font-size:13px;color:${s === "Connected" ? "#059669" : "#6B7280"}">${s === "Connected" ? "● Connected" : "Not connected"}</div></div>${s === "Connect" ? `<div style="background:${ORANGE};color:#fff;border-radius:8px;padding:7px 14px;font-size:13px;font-weight:700">Connect</div>` : ""}</div>`).join("")}</div>`, 2)
    + caption("1 · Connect Postgres, Stripe and Sheets in minutes")),
  sceneBg(appChrome("Dashboards", `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px"><div style="font-size:26px;font-weight:800">Revenue overview</div><div style="font-size:13px;color:#059669;font-weight:700">● Live</div></div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:18px">${[["MRR", "$688k", "+14.5%"], ["Active teams", "5,690", "+38%"], ["Churn", "1.3%", "−0.4 pt"]]
      .map(([k, v, d]) => `<div style="border:1px solid #E5E7EB;border-radius:14px;padding:16px"><div style="font-size:13px;color:#6B7280">${k}</div><div style="font-size:30px;font-weight:800;margin-top:4px">${v}</div><div style="font-size:13px;color:#059669;font-weight:700">${d}</div></div>`).join("")}</div>
    <div style="border:1px solid #E5E7EB;border-radius:14px;padding:12px 16px">${lineChart()}</div>`, 1)
    + caption("2 · Dashboards that update while you watch")),
  sceneBg(appChrome("Dashboards", `<div style="font-size:26px;font-weight:800;margin-bottom:18px">Revenue overview</div>
    <div style="position:absolute;right:40px;top:30px;width:420px;border-radius:16px;background:#fff;box-shadow:0 20px 50px -10px rgba(0,0,0,.25);border:1px solid #E5E7EB;padding:22px">
      <div style="font-size:20px;font-weight:800;margin-bottom:14px">Share “Revenue overview”</div>
      <div style="border:2px solid ${ORANGE};border-radius:10px;padding:10px 12px;color:#6B7280;margin-bottom:16px">alex@acme.com, sam@acme.com</div>
      ${[["Riya Sharma", "Owner"], ["Alex Chen", "Can edit"], ["Sam Lee", "Can view"]].map(([n, r]) => `<div style="display:flex;align-items:center;gap:12px;padding:8px 0"><div style="width:34px;height:34px;border-radius:50%;background:#CCFBF1;color:${ORANGE};font-weight:800;display:flex;align-items:center;justify-content:center;font-size:13px">${n.split(" ").map((x) => x[0]).join("")}</div><div style="flex:1;font-weight:600">${n}</div><div style="color:#6B7280;font-size:14px">${r}</div></div>`).join("")}
      <div style="margin-top:14px;background:${ORANGE};color:#fff;border-radius:10px;padding:11px;text-align:center;font-weight:800">Send invite</div></div>
    <div style="opacity:.35">${lineChart()}</div>`, 1)
    + caption("3 · Share a dashboard with the people who need it")),
  sceneBg(appChrome("Alerts", `<div style="font-size:26px;font-weight:800;margin-bottom:18px">Alerts</div>
    ${[["Churn above 2% this week", "Slack · #revenue", "Triggered 2 h ago", "#DC2626"], ["Daily signups below 150", "Email · growth team", "OK", "#059669"], ["Stripe sync failed", "PagerDuty · data on-call", "Resolved", "#6B7280"], ["MRR crossed $650k", "Slack · #wins", "Triggered yesterday", ORANGE]]
      .map(([t, c, s, col]) => `<div style="display:flex;align-items:center;gap:16px;border:1px solid #E5E7EB;border-radius:14px;padding:16px 18px;margin-bottom:12px"><div style="width:12px;height:12px;border-radius:50%;background:${col}"></div><div style="flex:1"><div style="font-weight:700">${t}</div><div style="font-size:13px;color:#6B7280">${c}</div></div><div style="font-size:13px;font-weight:700;color:${col}">${s}</div></div>`).join("")}`, 3)
    + caption("4 · Alerts in Slack, email or PagerDuty")),
  sceneBg(`<div style="position:absolute;left:50%;top:50px;transform:translateX(-50%);width:330px;height:600px;border-radius:44px;background:#111;padding:14px;box-shadow:0 30px 80px -20px rgba(0,0,0,.5)">
      <div style="width:100%;height:100%;border-radius:32px;background:#fff;padding:40px 20px 20px;overflow:hidden">
        <div style="display:flex;gap:8px;align-items:center;font-weight:800;margin-bottom:18px">${LOGO_SVG(22)} Revenue</div>
        ${[["MRR", "$688k"], ["Active teams", "5,690"]].map(([k, v]) => `<div style="border:1px solid #E5E7EB;border-radius:14px;padding:14px;margin-bottom:12px"><div style="font-size:12px;color:#6B7280">${k}</div><div style="font-size:28px;font-weight:800">${v}</div></div>`).join("")}
        <div style="transform:scale(.38);transform-origin:0 0">${lineChart()}</div></div></div>`)
    + caption("5 · Every dashboard works on your phone"),
  sceneBg(`<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:40px;color:#fff;text-align:center">
    ${[["3×", "faster weekly reporting"], ["20 min", "Monday review, down from 2 h"], ["124%", "net revenue retention"]].map(([b, s]) => `<div style="width:300px"><div style="font-size:84px;font-weight:800;letter-spacing:-.02em">${b}</div><div style="font-size:24px;opacity:.9">${s}</div></div>`).join("")}</div>`,
    `linear-gradient(135deg,${INK} 0%,#2B2F38 100%)`),
  "END_CARD",
];
const endCard = (v2) => sceneBg(`<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;text-align:center">
    <div style="font-size:64px;font-weight:800;letter-spacing:-.02em">${v2 ? "Now with Workflows" : "Start free today"}</div>
    <div style="font-size:30px;opacity:.95;margin-top:14px">${v2 ? "Beta from January 12 · acme.com/workflows" : "acme.com/start · no credit card"}</div>
    <div style="margin-top:36px;background:#fff;color:${ORANGE};font-weight:800;border-radius:14px;padding:16px 34px;font-size:24px">${v2 ? "Request beta access →" : "Create your workspace →"}</div></div>`);
const scenesFor = (v2) => SCENES.map((x) => (x === "END_CARD" ? endCard(v2) : x));

// ── Image + logo ──────────────────────────────────────────────────────────────

const box = (x, y, w, h, title, sub, fill = "#fff", stroke = "#E5E7EB") =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
   <text x="${x + w / 2}" y="${y + h / 2 - 4}" text-anchor="middle" font-size="24" font-weight="700" fill="${INK}">${title}</text>
   <text x="${x + w / 2}" y="${y + h / 2 + 26}" text-anchor="middle" font-size="17" fill="#6B7280">${sub}</text>`;
const arrow = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#9CA3AF" stroke-width="3" marker-end="url(#a)"/>`;
const DIAGRAM = `<div style="width:1600px;height:1000px;background:#F8FAFC;font-family:${FONT};padding:60px">
  <div style="font-size:40px;font-weight:800;color:${INK}">Acme Cloud — system architecture</div>
  <div style="font-size:22px;color:#6B7280;margin-top:8px">Data flow from sources to dashboards and alerts · v3, October 2026</div>
  <svg width="1480" height="780" style="margin-top:30px" font-family='${FONT}'>
    <defs><marker id="a" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#9CA3AF"/></marker></defs>
    ${box(0, 60, 280, 110, "Postgres", "CDC via Debezium")}${box(0, 230, 280, 110, "Stripe", "webhooks + backfill")}${box(0, 400, 280, 110, "HubSpot", "REST, every 5 min")}${box(0, 570, 280, 110, "Google Sheets", "push on edit")}
    ${box(420, 270, 300, 160, "Ingest", "Kafka · 6 partitions", "#F0FDFA", ORANGE)}
    ${box(840, 130, 300, 140, "Columnar store", "ClickHouse, 3 replicas")}${box(840, 430, 300, 140, "Metrics API", "Go · gRPC + REST")}
    ${box(1220, 60, 260, 120, "Dashboards", "web + mobile")}${box(1220, 300, 260, 120, "Alerts", "Slack · email · PD")}${box(1220, 540, 260, 120, "Workflows", "beta, Jan 2027")}
    ${arrow(280, 115, 420, 320)}${arrow(280, 285, 420, 340)}${arrow(280, 455, 420, 370)}${arrow(280, 625, 420, 400)}
    ${arrow(720, 330, 840, 210)}${arrow(990, 270, 990, 430)}${arrow(1140, 480, 1220, 130)}${arrow(1140, 500, 1220, 360)}${arrow(1140, 530, 1220, 590)}
  </svg></div>`;

// A "team photo": an illustrated group portrait (no real people), for image artifacts.
const PEOPLE = [["RS", "#0F766E"], ["AC", "#1D4ED8"], ["SL", "#B45309"], ["MP", "#7C3AED"], ["DK", "#BE185D"], ["JM", "#047857"]];
const TEAM_PHOTO = `<div style="width:1600px;height:1067px;position:relative;overflow:hidden;font-family:${FONT};
  background:linear-gradient(180deg,#E0F2FE 0%,#F0FDFA 55%,#D1FAE5 100%)">
  <div style="position:absolute;left:-100px;right:-100px;bottom:-260px;height:620px;border-radius:50%;background:#A7F3D0"></div>
  <div style="position:absolute;left:120px;top:120px;width:300px;height:180px;border-radius:999px;background:#fff;opacity:.7"></div>
  <div style="position:absolute;right:180px;top:90px;width:380px;height:200px;border-radius:999px;background:#fff;opacity:.6"></div>
  ${PEOPLE.map(([i, c], k) => {
    const x = 170 + k * 215, y = 430 + (k % 2) * 40;
    return `<div style="position:absolute;left:${x}px;top:${y}px;width:190px;text-align:center">
      <div style="width:150px;height:150px;margin:0 auto;border-radius:50%;background:#FDE7D3;border:8px solid #fff;display:flex;align-items:center;justify-content:center;font-size:44px;font-weight:800;color:${c}">${i}</div>
      <div style="width:190px;height:240px;margin-top:-10px;border-radius:95px 95px 20px 20px;background:${c}"></div></div>`;
  }).join("")}
  <div style="position:absolute;left:0;right:0;bottom:46px;text-align:center;color:#065F46;font-size:30px;font-weight:800">Acme product team · Lisbon offsite 2026</div></div>`;

// ── Render ────────────────────────────────────────────────────────────────────

function want(name) {
  const p = path.join(OUT, name);
  if (existsSync(p) && !FORCE) {
    console.log(`  · ${name} (exists)`);
    return null;
  }
  return p;
}

async function renderVideo(page, scenes, out) {
  const tmp = path.join(OUT, `scenes-${path.basename(out, ".mp4")}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const [i, html] of scenes.entries()) {
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box;margin:0;padding:0}body{width:1280px;height:720px;position:relative;overflow:hidden;font-family:${FONT};color:${INK}}</style></head><body>${html}</body></html>`);
    await page.screenshot({ path: path.join(tmp, `s${i}.png`) });
  }
  // Each still: a slow push-in (upscaled first so zoompan doesn't shimmer), then 0.6 s cross-fades.
  // 8 × 5.6 s − 7 × 0.6 s ≈ 40.6 s. One frame per input: zoompan emits d frames per input frame.
  const D = 5.6, X = 0.6, FPS = 30, N = scenes.length;
  const inputs = scenes.flatMap((_, i) => ["-i", path.join(tmp, `s${i}.png`)]);
  const parts = scenes.map((_, i) =>
    `[${i}:v]scale=2560:1440,zoompan=z='min(1.0+0.0009*on,1.05)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.round(D * FPS)}:s=1280x720:fps=${FPS},format=yuv420p,setpts=PTS-STARTPTS[v${i}]`);
  let last = "v0";
  for (let i = 1; i < N; i++) {
    const o = i === N - 1 ? "vout" : `x${i}`;
    parts.push(`[${last}][v${i}]xfade=transition=fade:duration=${X}:offset=${(i * (D - X)).toFixed(2)}[${o}]`);
    last = o;
  }
  execFileSync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", ...inputs, "-filter_complex", parts.join(";"),
    "-map", "[vout]", "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], { stdio: "inherit" });
  rmSync(tmp, { recursive: true, force: true });
  console.log(`  ✓ ${path.basename(out)}`);
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  for (const [name, v2] of [["q3-board-deck-v1.pdf", false], ["q3-board-deck-v2.pdf", true]]) {
    const pdf = want(name);
    if (!pdf) continue;
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><title>Acme Q3 2026 Board Update</title><style>${slideCss}</style></head><body>${slidesFor(v2).join("")}</body></html>`);
    await page.pdf({ path: pdf, width: "1280px", height: "720px", printBackground: true, preferCSSPageSize: true });
    console.log(`  ✓ ${name}`);
  }

  for (const [name, v2] of [["product-demo-v1.mp4", false], ["product-demo-v2.mp4", true]]) {
    const mp4 = want(name);
    if (!mp4) continue;
    await page.setViewportSize({ width: 1280, height: 720 });
    await renderVideo(page, scenesFor(v2), mp4);
  }

  // An HEVC .mov: what a phone screen recording often is, and what Chrome may refuse (error state).
  const mov = want("hevc-recording.mov");
  if (mov) {
    execFileSync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-i", path.join(OUT, "product-demo-v1.mp4"), "-t", "12",
      "-c:v", "libx265", "-tag:v", "hvc1", "-crf", "30", "-preset", "fast", "-pix_fmt", "yuv420p", "-x265-params", "log-level=error", mov], { stdio: "inherit" });
    console.log(`  ✓ ${path.basename(mov)}`);
  }

  const png = want("acme-architecture.png");
  if (png) {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.setContent(`<!doctype html><html><body style="margin:0">${DIAGRAM}</body></html>`);
    await page.screenshot({ path: png, clip: { x: 0, y: 0, width: 1600, height: 1000 } });
    console.log(`  ✓ ${path.basename(png)}`);
  }

  const photo = want("team-photo.png");
  if (photo) {
    await page.setViewportSize({ width: 1600, height: 1067 });
    await page.setContent(`<!doctype html><html><body style="margin:0">${TEAM_PHOTO}</body></html>`);
    await page.screenshot({ path: photo, clip: { x: 0, y: 0, width: 1600, height: 1067 } });
    console.log(`  ✓ ${path.basename(photo)}`);
  }

  // Workspace logo: the mark + "Acme" wordmark in dark ink, transparent (reads on light surfaces).
  const logo = want("acme-logo.png");
  if (logo) {
    await page.setViewportSize({ width: 720, height: 240 });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent"><div style="width:720px;height:240px;display:flex;align-items:center;gap:34px;padding-left:36px;font-family:${FONT}">${LOGO_SVG(168)}<span style="font-size:132px;font-weight:800;letter-spacing:-.03em;color:${INK}">Acme</span></div></body></html>`);
    await page.screenshot({ path: logo, omitBackground: true, clip: { x: 0, y: 0, width: 720, height: 240 } });
    console.log(`  ✓ ${path.basename(logo)}`);
  }
  const fav = want("acme-favicon.png");
  if (fav) {
    await page.setViewportSize({ width: 256, height: 256 });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${LOGO_SVG(256)}</body></html>`);
    await page.screenshot({ path: fav, omitBackground: true, clip: { x: 0, y: 0, width: 256, height: 256 } });
    console.log(`  ✓ ${path.basename(fav)}`);
  }
} finally {
  await browser.close();
}
writeFileSync(path.join(OUT, ".done"), new Date().toISOString());
