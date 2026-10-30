#!/usr/bin/env node
/**
 * markdrop-docs — build a docs content folder into static output and publish it.
 *
 *   markdrop-docs build <content-dir> --out <dist> [--engine <frontend>] [--work <dir>]
 *                       [--assets <dir>=<url-prefix>]... [--port 3591] [--force]
 *                       [--engine-assets <dir> | none]   (shared engine files for the Worker's
 *                                                         static assets; default edge/assets)
 *   markdrop-docs publish <dist> (--store <dir> | --r2 <bucket>) [--site <id>] [--host <hostname>]... [--dry-run]
 *                       [--access <public|password|members>:<policy_version>]   (the site's access policy)
 *   markdrop-docs assets <dir> (--store <dir> | --r2 <bucket>) [--prune] [--dry-run]
 *                                   (the Worker's static assets folder from every site's live
 *                                    manifests: fetch missing engine files, --prune unused ones)
 *   markdrop-docs point (--store <dir> | --r2 <bucket>) --site <id> --manifest <sha256> [--force] [--dry-run]
 *                                   (restore: point the site at a manifest the store already has;
 *                                    no rebuild, no upload)
 *   markdrop-docs media <content-dir> [--engine <frontend>]
 *                                   (write <content>/media.json from <content>/public/docs-assets:
 *                                    image sizes, clip lengths, dark variants)
 *   markdrop-docs bundle            (build edge/dist/: the Worker and the Node handler)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "./build.mjs";
import { FsStore, S3Store, publish } from "./store.mjs";

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
    if (key === "force" || key === "dry-run" || key === "quiet" || key === "prune") {
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

/** --store <dir>, or --r2 <bucket>: the account's R2 over S3 (CF_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in the env). */
function storeOf(opt) {
  return opt.r2
    ? new S3Store({ accountId: process.env.CF_ACCOUNT_ID, accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY, bucket: opt.r2 })
    : new FsStore(opt.store);
}

const fmtBytes =(n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${(n / 1e3).toFixed(1)} KB` : `${n} B`);

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
      engineAssetsDir: opt["engine-assets"] === "none" ? undefined : path.resolve(opt["engine-assets"] || path.join(HERE, "..", "edge", "assets")),
      log,
    });
    if (res.skipped) {
      console.log(JSON.stringify({ skipped: true, inputs: res.manifest.inputs, engineAssets: res.engineAssets, timings: res.timings }));
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
    if (!pos[0] || (!opt.store && !opt.r2)) throw new Error("usage: publish <dist> (--store <dir> | --r2 <bucket>)");
    const t = Date.now();
    // --access <level>:<policy_version> (e.g. password:3): the site's access policy, written before the pointer flips.
    const [level, ver] = String(opt.access || "").split(":");
    const access = opt.access ? { level, policy_version: Number(ver || 0) } : null;
    const res = await publish({ distDir: pos[0], store: storeOf(opt), site: opt.site, hosts: opt.host, access, dryRun: !!opt["dry-run"] });
    const { uploadedKeys, ...summary } = res;
    console.log(JSON.stringify({ ...summary, uploadedBytes: fmtBytes(res.uploadedBytes || 0), ms: Date.now() - t }, null, 2));
  } else if (cmd === "assets") {
    // The Worker's static assets folder from the live manifests: fetch missing engine files, --prune the rest.
    if (!pos[0] || (!opt.store && !opt.r2)) throw new Error("usage: assets <dir> (--store <dir> | --r2 <bucket>) [--prune] [--dry-run]");
    const { syncEngineAssets } = await import("./store.mjs");
    const res = await syncEngineAssets({ store: storeOf(opt), dir: path.resolve(pos[0]), prune: !!opt.prune, dryRun: !!opt["dry-run"] });
    console.log(JSON.stringify(res, null, 2));
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
  } else if (cmd === "point") {
    if ((!opt.store && !opt.r2) || !opt.site || !opt.manifest) throw new Error("usage: point (--store <dir> | --r2 <bucket>) --site <id> --manifest <sha256>");
    const { pointSite } = await import("./store.mjs");
    console.log(JSON.stringify(await pointSite({ store: storeOf(opt), site: opt.site, manifest: opt.manifest, force: !!opt.force, dryRun: !!opt["dry-run"] }), null, 2));
  } else if (cmd === "media") {
    if (!pos[0]) throw new Error("usage: media <content-dir> [--engine <frontend>]");
    const { writeMediaManifest } = await import("./media.mjs");
    console.log(JSON.stringify(await writeMediaManifest(pos[0], { engineDir: opt.engine || path.join(REPO, "frontend") }), null, 2));
  } else if (cmd === "bundle") {
    const { bundle } = await import("./bundle.mjs");
    console.log(JSON.stringify(await bundle(), null, 2));
  } else {
    console.error("commands: build, publish, point, assets, media, diff, bundle (see the header of builder/cli.mjs)");
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
