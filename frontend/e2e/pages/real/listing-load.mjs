/** What loading /w/<ws> costs under throttling: every request in the first N seconds, by kind
 *  (RSC prefetches of which routes, scripts, API). PB_STACK_ID=12 PROFILE=3g|4g node listing-load.mjs */
import fs from "node:fs";
import path from "node:path";
import { APP, API, STACK, launch, ctx } from "./lib.mjs";
const L = JSON.parse(fs.readFileSync(path.join(STACK, "seed-listing.json"), "utf8"));
const P = { "4g": { latency: 150, downloadThroughput: 524288, uploadThroughput: 393216 }, "3g": { latency: 562.5, downloadThroughput: 188743, uploadThroughput: 86400 } }[process.env.PROFILE || "3g"];
const browser = await launch();
const { c, p } = await ctx(browser, { token: L.users.member.token });
const cdp = await c.newCDPSession(p);
await cdp.send("Network.enable");
await cdp.send("Network.emulateNetworkConditions", { offline: false, ...P });
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
const reqs = new Map();
cdp.on("Network.requestWillBeSent", (e) => reqs.set(e.requestId, { url: e.request.url, type: e.type, t0: e.timestamp, bytes: 0, purpose: e.request.headers["Next-Router-Prefetch"] ? "prefetch" : "" }));
cdp.on("Network.loadingFinished", (e) => { const r = reqs.get(e.requestId); if (r) { r.t1 = e.timestamp; r.bytes = e.encodedDataLength; } });
await p.goto(`${APP}/w/${L.ws}`, { waitUntil: "load" });
await p.waitForTimeout(Number(process.env.SECS || 20) * 1000);
const list = [...reqs.values()];
const base = Math.min(...list.map((r) => r.t0));
const groups = {};
for (const r of list) {
  const u = r.url.replace(APP, "").replace(API, "API");
  const g = r.type === "Fetch" && u.includes("_rsc") ? `RSC ${u.startsWith("/w/") ? "/w/… (folder)" : /^\/(dashboard|shared|recent|trash|settings|pages|requests)?(\/|\?|$)/.test(u) ? "app page" : "/<slug> (document)"}` : r.type === "Script" ? (u.includes("%5Bslug%5D") ? "Script [slug] page" : "Script") : u.startsWith("API") ? "API" : r.type;
  groups[g] = groups[g] || { n: 0, kb: 0, lastEnd: 0 };
  groups[g].n++; groups[g].kb += r.bytes / 1024; groups[g].lastEnd = Math.max(groups[g].lastEnd, Math.round(((r.t1 || r.t0) - base) * 1000));
}
for (const [g, v] of Object.entries(groups)) console.log(g.padEnd(40), String(v.n).padStart(4), `${v.kb.toFixed(0)} KB`.padStart(8), `done by ${v.lastEnd} ms`);
console.log("RSC:", [...new Set(list.filter((r) => r.url.includes("_rsc")).map((r) => r.url.replace(APP, "").split("?")[0]))].join(" "));
console.log("rail links to documents:", await p.locator('nav a[href^="/"]:not([href^="/w/"]):not([href^="/settings"])').count(), "main links:", await p.locator("#main a").count());
await browser.close();
