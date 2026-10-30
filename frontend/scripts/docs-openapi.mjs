#!/usr/bin/env node
/**
 * docs:openapi — refreshes the API reference's source: content/docs/openapi.json.
 *
 *   npm run docs:openapi
 *
 * Runs backend/scripts/export_openapi.py (read-only: imports the FastAPI app and prints
 * `app.openapi()` plus auth and rate-limit hints) from a scratch directory with a bare
 * environment, so the backend's .env is never read and no real service is configured:
 * the reference describes the code, not a machine. Then writes the snapshot (stable key order,
 * two-space indent) and prints what changed. Commit the snapshot with the backend change.
 *
 * Python: backend/.venv/bin/python when it exists, else $PYTHON, else python3.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = path.resolve(ROOT, "..", "backend");
const OUT = path.join(process.env.DOCS_CONTENT_DIR || path.join(ROOT, "content", "docs"), "openapi.json");

const venv = path.join(BACKEND, ".venv", "bin", "python");
const python = fs.existsSync(venv) ? venv : process.env.PYTHON || "python3";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "markdrop-openapi-"));

const run = spawnSync(python, [path.join(BACKEND, "scripts", "export_openapi.py")], {
  cwd: scratch,
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? scratch,
    PYTHONPATH: BACKEND,
    PYTHONDONTWRITEBYTECODE: "1",
    MARKDROP_REDIS_URL: "memory://",
  },
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
fs.rmSync(scratch, { recursive: true, force: true });

if (run.status !== 0) {
  console.error(run.stderr || run.error?.message || "export failed");
  process.exit(1);
}

let spec;
try {
  spec = JSON.parse(run.stdout);
} catch (e) {
  console.error(`docs:openapi: the export didn't print JSON: ${e.message}`);
  process.exit(1);
}

const ops = (s) => {
  const out = new Set();
  for (const [p, item] of Object.entries(s?.paths ?? {})) for (const m of Object.keys(item)) out.add(`${m.toUpperCase()} ${p}`);
  return out;
};
let before = new Set();
let previous = null;
try {
  previous = JSON.parse(fs.readFileSync(OUT, "utf8"));
  before = ops(previous);
} catch {}

// The date the reference pages show as "Updated": kept while the description is unchanged, so
// re-running the export doesn't produce a diff.
const STAMP = "x-markdrop-exported";
const strip = (s) => JSON.stringify({ ...s, info: { ...(s?.info ?? {}), [STAMP]: undefined } });
const unchanged = previous && strip(previous) === strip(spec);
spec.info = { ...(spec.info ?? {}), [STAMP]: unchanged && previous.info?.[STAMP] ? previous.info[STAMP] : new Date().toISOString().slice(0, 10) };
const after = ops(spec);
const added = [...after].filter((x) => !before.has(x));
const removed = [...before].filter((x) => !after.has(x));

fs.writeFileSync(OUT, JSON.stringify(spec, null, 2) + "\n");
console.log(`docs:openapi: ${unchanged ? "no changes in" : "wrote"} ${path.relative(ROOT, OUT)} (${after.size} operations)`);
for (const x of added) console.log(`  + ${x}`);
for (const x of removed) console.log(`  - ${x}`);
if (added.length) console.log("New operations show in the reference automatically. Give them a title in content/docs/api-reference.json, or hide them there.");
