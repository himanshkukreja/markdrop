// GitHub Actions step for the Cloudflare deploy (.github/workflows/cf-deploy.yml): the production env pulled from
// Vercel (`vercel pull`) becomes
// 1. the build's process env ($GITHUB_ENV), never a .env file: OpenNext inlines .env* files into the Worker bundle;
// 2. the Worker's secrets (a JSON file for `wrangler secret bulk`): every server-side variable.
// Vercel never hands out "sensitive" variables (MARKDROP_INTERNAL_SECRET is one): those come from GitHub secrets
// passed in as EXTRA_<name>. A "[SENSITIVE]" placeholder or a missing REQUIRED variable stops the deploy (the
// portfolio shipped without its AI keys that way, Nov 2026). Every value is masked in the log.
// Usage: node scripts/cf/env-from-vercel.mjs <pulled env file> <secrets.json>
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { parseEnv } from "node:util";

/** Server-side variables the Worker can't run without (src/components/tenant/server.ts signs tenant SSR calls). */
const REQUIRED = ["MARKDROP_INTERNAL_SECRET"];

const [file, out] = process.argv.slice(2);
const env = parseEnv(readFileSync(file, "utf8"));
for (const [k, v] of Object.entries(process.env)) if (k.startsWith("EXTRA_") && v) env[k.slice(6)] = v;

// A NEXT_PUBLIC_* value the workflow sets itself (its env: block) wins over Vercel's copy.
const fromWorkflow = new Set(Object.keys(process.env).filter((k) => !k.startsWith("EXTRA_")));
const skip = (k) => /^(VERCEL|TURBO|NX_)/.test(k) || k === "NODE_ENV" || (k.startsWith("NEXT_PUBLIC_") && fromWorkflow.has(k));
const placeholders = Object.entries(env).filter(([k, v]) => !skip(k) && v === "[SENSITIVE]").map(([k]) => k);
if (placeholders.length) {
  console.error(`::error::Only Vercel's "[SENSITIVE]" placeholder for ${placeholders.join(", ")}: add each as a GitHub Actions secret of the same name (passed in as EXTRA_<name>)`);
  process.exit(1);
}
const missing = REQUIRED.filter((k) => !env[k]);
if (missing.length) {
  console.error(`::error::Missing ${missing.join(", ")}: set it in Vercel or as a GitHub Actions secret of the same name`);
  process.exit(1);
}
const ghEnv = process.env.GITHUB_ENV;
const secrets = {};
for (const [k, v] of Object.entries(env)) {
  if (skip(k) || v === "") continue;
  for (const line of v.split("\n")) if (line.trim().length > 3 && !k.startsWith("NEXT_PUBLIC_")) console.log(`::add-mask::${line}`);
  if (ghEnv) {
    const d = `EOF_${randomBytes(8).toString("hex")}`;
    appendFileSync(ghEnv, `${k}<<${d}\n${v}\n${d}\n`);
  }
  if (!k.startsWith("NEXT_PUBLIC_")) secrets[k] = v; // NEXT_PUBLIC_* are inlined at build time
}
writeFileSync(out, JSON.stringify(secrets));
console.log(`env-from-vercel: ${Object.keys(env).length} variables for the build (${Object.keys(env).filter((k) => k.startsWith("NEXT_PUBLIC_")).sort().join(", ")}), ${Object.keys(secrets).length} Worker secrets: ${Object.keys(secrets).sort().join(", ")}`);
