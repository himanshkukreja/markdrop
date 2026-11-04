#!/usr/bin/env node
/**
 * docs:openapi — refreshes the API reference's source: content/docs/openapi.json.
 *
 *   npm run docs:openapi              write the snapshot from the backend's code
 *   npm run docs:openapi -- --check   change nothing; fail if the snapshot is stale or the
 *                                     reference has an operation without a title, a group or
 *                                     a description (runs at the end of `npm run docs:check`)
 *
 * KEEP THE REFERENCE CURRENT. Every release that adds, removes or changes an API route must ship
 * a fresh snapshot and a curated entry: run `npm run docs:openapi`, then give each new operation
 * a title, a group and a short description in content/docs/api-reference.json (or add it to
 * `hide.operations` there, with a reason, when only Markdrop's own pages call it; admin routes are
 * already left out of the schema by the backend). `npm run docs:check` runs the --check below, so
 * a stale snapshot or an undescribed operation fails the docs check the release runs.
 *
 * Runs backend/scripts/export_openapi.py (read-only: imports the FastAPI app and prints
 * `app.openapi()` plus auth and rate-limit hints) from a scratch directory with a bare
 * environment, so the backend's .env is never read and no real service is configured:
 * the reference describes the code, not a machine. Then writes the snapshot (stable key order,
 * two-space indent) and prints what changed. Commit the snapshot with the backend change.
 *
 * Python: $PYTHON when set, else backend/.venv/bin/python when it exists, else python3. With
 * --check, a Python that can't import the backend's dependencies (no venv on this machine, e.g.
 * a frontend-only build) skips the freshness half with a clear message; the overlay half
 * (titles, groups, descriptions) still runs, since it needs no Python.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApiReference } from "../src/docs/openapi.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = path.resolve(ROOT, "..", "backend");
const OUT = path.join(process.env.DOCS_CONTENT_DIR || path.join(ROOT, "content", "docs"), "openapi.json");

const CHECK = process.argv.includes("--check");
const venv = path.join(BACKEND, ".venv", "bin", "python");
const python = process.env.PYTHON ? (process.env.PYTHON.includes("/") ? path.resolve(process.env.PYTHON) : process.env.PYTHON) : fs.existsSync(venv) ? venv : "python3";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "markdrop-openapi-"));

const run = spawnSync(python, [path.join(BACKEND, "scripts", "export_openapi.py")], {
  cwd: scratch,
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? scratch,
    PYTHONPATH: BACKEND,
    PYTHONDONTWRITEBYTECODE: "1",
    MARKDROP_REDIS_URL: "memory://",
    // A route with methods=["GET", "HEAD"] keeps them in a set, and FastAPI names both operations
    // after the set's first method: a fixed hash seed makes that, and so the snapshot, the same
    // on every run (--check depends on it).
    PYTHONHASHSEED: "0",
  },
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
fs.rmSync(scratch, { recursive: true, force: true });

// --check without a Python that has the backend's packages (a frontend-only machine): skip the
// freshness half, loudly, but still check the overlay against the committed snapshot.
const noBackend = run.error || (run.status !== 0 && /ModuleNotFoundError|No module named/.test(run.stderr || ""));
if (CHECK && noBackend) {
  console.warn(`docs:openapi --check: SKIPPED the freshness check: ${python} can't import the backend (${(run.error?.message || run.stderr.trim().split("\n").pop() || "").slice(0, 160)}). Set PYTHON to the backend's venv Python to run it.`);
  process.exit(checkOverlay(JSON.parse(fs.readFileSync(OUT, "utf8"))) ? 0 : 1);
}
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

if (CHECK) {
  let ok = true;
  if (!previous) {
    console.error(`docs:openapi --check: ${path.relative(ROOT, OUT)} is missing. Run npm run docs:openapi.`);
    ok = false;
  } else if (!unchanged) {
    console.error(`docs:openapi --check: ${path.relative(ROOT, OUT)} is STALE: the backend's API differs from the snapshot.`);
    for (const x of added) console.error(`  + ${x}`);
    for (const x of removed) console.error(`  - ${x}`);
    if (!added.length && !removed.length) console.error("  (same operations; their parameters, bodies, answers or docstrings changed)");
    console.error("Run npm run docs:openapi, describe new operations in content/docs/api-reference.json, and commit both.");
    ok = false;
  }
  if (previous && !checkOverlay(previous)) ok = false;
  if (ok) console.log(`docs:openapi --check: the snapshot matches the backend and every operation is described (${after.size} operations).`);
  process.exit(ok ? 0 : 1);
}

fs.writeFileSync(OUT, JSON.stringify(spec, null, 2) + "\n");
console.log(`docs:openapi: ${unchanged ? "no changes in" : "wrote"} ${path.relative(ROOT, OUT)} (${after.size} operations)`);
for (const x of added) console.log(`  + ${x}`);
for (const x of removed) console.log(`  - ${x}`);
if (added.length) console.log("New operations show in the reference automatically. Give them a title in content/docs/api-reference.json, or hide them there.");

/**
 * Every operation the reference shows has a title, a group and a description in the overlay
 * (content/docs/api-reference.json, as site.json `openapi.overlay` names it), unless the overlay
 * hides it. The same builder docs:check and the site use, so the two can't disagree.
 */
function checkOverlay(snapshot) {
  const site = JSON.parse(fs.readFileSync(path.join(path.dirname(OUT), "site.json"), "utf8"));
  const cfg = site.openapi ?? {};
  const overlayPath = path.join(path.dirname(OUT), cfg.overlay || "api-reference.json");
  const overlay = fs.existsSync(overlayPath) ? JSON.parse(fs.readFileSync(overlayPath, "utf8")) : {};
  const ref = buildApiReference(snapshot, overlay, { server: cfg.server, base: cfg.base, extension: cfg.extension || "x-docs" });
  const missing = ref.problems.filter((m) => /no title|no group/.test(m));
  for (const op of ref.ops) if (!op.description) missing.push(`${op.key}: no description`);
  if (!missing.length) return true;
  console.error(`docs:openapi --check: ${missing.length} problem(s) in ${path.relative(ROOT, overlayPath)}:`);
  for (const m of missing) console.error(`  ${m}`);
  console.error("Give each operation a title, a group and a description there, or add it to hide.operations with a reason.");
  return false;
}
