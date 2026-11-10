// Cloudflare build step (after `next build`, before `opennextjs-cloudflare build --skipNextBuild`):
// empty the client reference manifests of route handlers (app/**/route_client-reference-manifest.js).
// Route handlers (API routes, OG images, feeds, sitemaps) never read them: Next's app-route module has
// no client references. Next still emits one per route (~80 KB each, the whole layout's client
// modules), and OpenNext bundles them verbatim into the Worker: 210 of them were 16.8 MB of a 70 MB
// Worker. Page manifests are kept (OpenNext factors those and pages need them).
import { readFileSync, writeFileSync } from "node:fs";
import { globSync } from "node:fs";

// both copies: .next/server and the standalone output OpenNext bundles from
const files = [...globSync(".next/server/app/**/route_client-reference-manifest.js"), ...globSync(".next/standalone/.next/server/app/**/route_client-reference-manifest.js")];
let before = 0;
let after = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const m = /globalThis\.__RSC_MANIFEST\[("(?:[^"\\]|\\.)*")\]\s*=/.exec(src);
  if (!m) throw new Error(`unexpected manifest shape: ${f}`);
  const empty = { moduleLoading: { prefix: "/_next/" }, ssrModuleMapping: {}, edgeSSRModuleMapping: {}, clientModules: {}, entryCSSFiles: {}, entryJSFiles: {}, rscModuleMapping: {}, edgeRscModuleMapping: {} };
  const out = `globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST[${m[1]}]=${JSON.stringify(empty)};`;
  before += src.length;
  after += out.length;
  writeFileSync(f, out);
}
console.log(`prune-route-manifests: ${files.length} route manifests, ${(before / 1e6).toFixed(1)} MB → ${(after / 1e6).toFixed(2)} MB`);
