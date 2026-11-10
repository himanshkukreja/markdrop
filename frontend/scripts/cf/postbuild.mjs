// Cloudflare build step, after `opennextjs-cloudflare build` and before deploy/preview (scripts/cf/build.sh):
// 1. Keep the Worker's script source one-byte in V8. A single character above U+00FF anywhere in the bundle makes V8
//    hold the whole (~33 M char) source as a two-byte string: the Workers audit (Nov 2026) measured a 145 MB peak in
//    a 128 MB isolate; escaped, 103 MB. Every non-ASCII character becomes \uXXXX (the same meaning in strings,
//    templates, regex literals and comments), then the result is checked to be pure ASCII.
// 2. Static assets never reach Next, so next.config.ts headers() for public files go in _headers.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

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
