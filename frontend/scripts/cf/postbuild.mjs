// Cloudflare build step, after `opennextjs-cloudflare build` and before deploy/preview (scripts/cf/build.sh):
// 1. Keep the Worker's script source one-byte in V8. A single character above U+00FF anywhere in the bundle makes V8
//    hold the whole (~33 M char) source as a two-byte string: the Workers audit (Nov 2026) measured a 145 MB peak in
//    a 128 MB isolate; escaped, 103 MB. Every non-ASCII character becomes \uXXXX (the same meaning in strings,
//    templates, regex literals and comments), then the result is checked to be pure ASCII.
// 2. Static assets never reach Next, so next.config.ts headers() for public files go in _headers.
// 3. Prerendered pages that never revalidate go into the static assets too (cdn-cgi/_next_cache, Worker-only), where
//    cloudflare/prerendered-assets-cache.ts reads them instead of R2 + the tag cache.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const H = ".open-next/server-functions/default/handler.mjs";
const src = readFileSync(H, "utf8");
let n = 0;
const out = src.replace(/[^\x00-\x7f]/gu, (ch) => {
  n++;
  const cp = ch.codePointAt(0);
  if (cp < 0x10000) return "\\u" + cp.toString(16).padStart(4, "0");
  const v = cp - 0x10000;
  return "\\u" + (0xd800 + (v >> 10)).toString(16) + "\\u" + (0xdc00 + (v & 0x3ff)).toString(16);
});
if (/[^\x00-\x7f]/.test(out)) throw new Error("cf-postbuild: handler is still not ASCII");
writeFileSync(H, out);
copyFileSync("scripts/cf/_headers", ".open-next/assets/_headers");
console.log(`cf-postbuild: escaped ${n} non-ASCII characters (${(out.length / 1e6).toFixed(1)} M chars); wrote _headers`);

// 3. The cache entries (.open-next/cache/<buildId>/<key>.cache) of pages with revalidate false whose tags are all
// route tags: a data tag (fetch `next.tags`) could be expired by revalidateTag, and such a page must keep reading R2.
const ASSET_LIMIT = 24 * 1024 * 1024;
const routes = JSON.parse(readFileSync(".next/prerender-manifest.json", "utf8")).routes ?? {};
const cacheRoot = ".open-next/cache";
let copied = 0;
let bytes = 0;
const skipped = { revalidates: 0, dataTags: 0, size: 0 };
const unmatched = [];
const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
for (const buildId of readdirSync(cacheRoot)) {
  if (buildId === "__fetch" || !statSync(join(cacheRoot, buildId)).isDirectory()) continue;
  for (const file of walk(join(cacheRoot, buildId))) {
    if (!file.endsWith(".cache")) continue;
    const key = "/" + relative(join(cacheRoot, buildId), file).slice(0, -".cache".length).split("\\").join("/");
    // Next >= 15.5.27 keys: /route-cache/APP_PAGE/<sha256>/$/<page path> (OpenNext utils/routeCacheKey.js)
    const page = key.replace(/^\/route-cache\/(?:PAGES|APP_PAGE|APP_ROUTE)\/[0-9a-f]{64}\/\$(?=\/)/, "");
    const route = routes[page === "/index" ? "/" : page.startsWith("/index/") ? page.slice(6) : page];
    if (!route || route.initialRevalidateSeconds !== false) {
      skipped.revalidates++;
      if (!route && unmatched.length < 3) unmatched.push(key);
      continue;
    }
    const size = statSync(file).size;
    if (size > ASSET_LIMIT) {
      skipped.size++;
      continue;
    }
    const entry = JSON.parse(readFileSync(file, "utf8"));
    const tags = String(entry?.meta?.headers?.["x-next-cache-tags"] ?? "").split(",").filter(Boolean);
    if (entry?.type !== "app" || tags.some((t) => !t.startsWith("_N_T_/"))) {
      skipped.dataTags++;
      continue;
    }
    const out = join(".open-next/assets/cdn-cgi/_next_cache", buildId, relative(join(cacheRoot, buildId), file));
    mkdirSync(dirname(out), { recursive: true });
    copyFileSync(file, out);
    copied++;
    bytes += size;
  }
}
console.log(
  `cf-postbuild: ${copied} never-revalidating pages into static assets (${(bytes / 1e6).toFixed(1)} MB); kept in R2 only: ` +
    `${skipped.revalidates} ISR / not prerendered, ${skipped.dataTags} with data tags or not app pages, ${skipped.size} over 24 MiB`,
);
if (!copied) throw new Error(`cf-postbuild: no prerendered page copied into static assets (cache layout changed?) e.g. ${unmatched.join(" ")}`);
