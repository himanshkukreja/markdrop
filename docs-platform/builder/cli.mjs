#!/usr/bin/env node
/**
 * markdrop-docs — build a docs content folder into static output and publish it.
 *
 *   markdrop-docs build <content-dir> --out <dist> [--engine <frontend>] [--work <dir>]
 *                       [--assets <dir>=<url-prefix>]... [--port 3591] [--force]
 *   markdrop-docs publish <dist> --store <dir> [--site <id>] [--host <hostname>]... [--dry-run]
 *   markdrop-docs bundle            (build edge/dist/: the Worker and the Node handler)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "./build.mjs";
import { FsStore, publish } from "./store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

function parse(argv) {
  const pos = [];
  const opt = { assets: [], host: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const key = a.slice(2);
    if (key === "force" || key === "dry-run" || key === "quiet") {
      opt[key] = true;
      continue;
    }
    const v = argv[++i];
    if (v === undefined) throw new Error(`--${key} needs a value`);
    if (Array.isArray(opt[key])) opt[key].push(v);
    else opt[key] = v;
  }
  return { pos, opt };
}

const fmtBytes = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${(n / 1e3).toFixed(1)} KB` : `${n} B`);

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parse(rest);
  const log = opt.quiet ? () => {} : (m) => console.error(`[markdrop-docs] ${m}`);
  if (cmd === "build") {
    if (!pos[0] || !opt.out) throw new Error("usage: build <content-dir> --out <dist>");
    const assets = opt.assets.map((s) => {
      const [dir, prefix = "/"] = s.split("=");
      return { dir, prefix };
    });
    const res = await build({
      contentDir: pos[0],
      outDir: opt.out,
      engineDir: opt.engine || path.join(REPO, "frontend"),
      workDir: opt.work || path.join(path.resolve(opt.out), "..", ".markdrop-docs-work"),
      assets,
      port: opt.port ? Number(opt.port) : undefined,
      force: !!opt.force,
      log,
    });
    if (res.skipped) {
      console.log(JSON.stringify({ skipped: true, inputs: res.manifest.inputs, timings: res.timings }));
      return;
    }
    const m = res.manifest;
    const sizes = { html: 0, rsc: 0, other: 0, files: 0, chunks: 0 };
    for (const r of Object.values(m.routes)) {
      if (r.t.startsWith("text/html")) sizes.html += r.s;
      else sizes.other += r.s;
      if (r.rsc) sizes.rsc += r.rsc.s;
    }
    for (const [p, f] of Object.entries(m.files)) p.startsWith("/_next/static/") ? (sizes.chunks += f.s) : (sizes.files += f.s);
    console.log(JSON.stringify({ site: m.site.id, engine: m.engine, timings: res.timings, stats: res.stats, bytes: Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, fmtBytes(v)])) }, null, 2));
  } else if (cmd === "publish") {
    if (!pos[0] || !opt.store) throw new Error("usage: publish <dist> --store <dir>");
    const t = Date.now();
    const res = await publish({ distDir: pos[0], store: new FsStore(opt.store), site: opt.site, hosts: opt.host, dryRun: !!opt["dry-run"] });
    const { uploadedKeys, ...summary } = res;
    console.log(JSON.stringify({ ...summary, uploadedBytes: fmtBytes(res.uploadedBytes || 0), ms: Date.now() - t }, null, 2));
  } else if (cmd === "diff") {
    // What changed between two manifests (objects a publish of B over A would upload).
    const fs = await import("node:fs");
    const { manifestObjects } = await import("./store.mjs");
    const [A, B] = pos.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
    const byKind = {};
    const examples = [];
    const bump = (k, ex) => {
      byKind[k] = (byKind[k] || 0) + 1;
      if (examples.length < 12) examples.push(ex);
    };
    for (const [k, r] of Object.entries(B.routes)) {
      const o = A.routes[k];
      if (!o || o.o !== r.o) bump(r.t.split(";")[0], k);
      if (r.rsc && (!o?.rsc || o.rsc.o !== r.rsc.o)) bump("rsc", `${k} (rsc)`);
    }
    for (const [k, f] of Object.entries(B.files)) if (A.files[k]?.o !== f.o) bump(k.startsWith("/_next/") ? "chunk" : "file", k);
    if (A.notFound?.o !== B.notFound?.o) bump("404", "404");
    if (A.mcp?.o !== B.mcp?.o) bump("mcp", "mcp");
    const have = manifestObjects(A);
    const upload = [...manifestObjects(B)].filter(([h]) => !have.has(h));
    console.log(JSON.stringify({ changedByKind: byKind, newObjects: upload.length, newBytes: fmtBytes(upload.reduce((n, [, s]) => n + s, 0)), examples }, null, 2));
  } else if (cmd === "bundle") {
    const { bundle } = await import("./bundle.mjs");
    console.log(JSON.stringify(await bundle(), null, 2));
  } else {
    console.error("commands: build, publish, bundle (see the header of builder/cli.mjs)");
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
