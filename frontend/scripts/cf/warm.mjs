// After a deploy: request the main pages and every docs page once, so the first readers don't pay for the new
// deployment's empty edge copies and cold renders (each deploy changes the build id). Only the colo near the caller
// is warmed. Usage: node scripts/cf/warm.mjs <app origin> [docs origin]
//   before cutover: node scripts/cf/warm.mjs https://markdrop-web.<sub>.workers.dev   (docs via the x-md-host header)
//   after:          node scripts/cf/warm.mjs https://www.markdrop.in https://docs.markdrop.in
const [app, docsArg] = process.argv.slice(2);
if (!app) throw new Error("usage: warm.mjs <app origin> [docs origin]");
const test = /\.workers\.dev$|^https:\/\/next\.markdrop\.in/.test(new URL(app).host) || new URL(app).host === "next.markdrop.in";
const docs = docsArg || app;
const docsHeaders = docsArg ? {} : { "x-md-host": "docs.markdrop.in" };
const get = async (u, headers = {}) => {
  const t0 = Date.now();
  const r = await fetch(u, { headers: { "user-agent": "markdrop-warm/1.0", ...headers }, redirect: "manual" }).catch(() => null);
  if (r) await r.arrayBuffer().catch(() => {});
  return { u, s: r ? r.status : 0, ms: Date.now() - t0 };
};
const appPages = ["/", "/guides", "/privacy", "/enterprise", "/mcp", "/builder", "/new", "/dashboard", "/login", "/sitemap.xml", "/manifest.webmanifest", "/sw.js"];
const sm = await (await fetch(`${docs}/sitemap.xml`, { headers: { "user-agent": "markdrop-warm/1.0", ...docsHeaders } })).text();
const docPaths = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
const jobs = [...appPages.map((p) => [`${app}${p}`, {}]), ...[...new Set(["/", "/changelog", "/llms.txt", "/search-index.json", ...docPaths])].map((p) => [`${docs}${p}`, docsHeaders])];
const out = [];
async function worker() { while (jobs.length) { const [u, h] = jobs.shift(); out.push(await get(u, h)); } }
await Promise.all(Array.from({ length: 6 }, worker));
const bad = out.filter((r) => r.s >= 500 || r.s === 0);
const ms = out.map((r) => r.ms).sort((a, b) => a - b);
console.log(`warm${test ? " (test host)" : ""}: ${out.length} pages, p50 ${ms[ms.length >> 1]} ms, max ${ms.at(-1)} ms, ${bad.length} failed`);
for (const b of bad.slice(0, 10)) console.log(`  ${b.s} ${b.u}`);
if (bad.length) process.exit(1);
