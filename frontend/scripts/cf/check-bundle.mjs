// CI check on the bundle wrangler would upload (`wrangler deploy --dry-run --outdir <dir>`): pure ASCII (see
// postbuild.mjs) and under the size limits. Usage: node scripts/cf/check-bundle.mjs <outdir>
import { readFileSync, readdirSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("usage: check-bundle.mjs <wrangler --outdir>");
let raw = 0;
let gz = 0;
const bad = [];
for (const f of readdirSync(dir, { recursive: true })) {
  const p = path.join(dir, String(f));
  if (!statSync(p).isFile() || p.endsWith(".map")) continue;
  const buf = readFileSync(p);
  raw += buf.length;
  gz += gzipSync(buf, { level: 6 }).length;
  if (/\.(m?js|cjs)$/.test(p) && /[^\x00-\x7f]/.test(buf.toString("latin1"))) bad.push(p);
}
const mib = (b) => (b / 1048576).toFixed(2);
console.log(`worker bundle: ${mib(raw)} MiB raw, ${mib(gz)} MiB gzip (limits 64 MiB raw, 10 MiB gzip)`);
if (bad.length) throw new Error(`not ASCII (V8 would hold the source two-byte): ${bad.join(", ")}`);
if (gz > 9.5 * 1048576) throw new Error("worker over 9.5 MiB gzip (limit 10)");
if (raw > 60 * 1048576) throw new Error("worker over 60 MiB (limit 64)");
