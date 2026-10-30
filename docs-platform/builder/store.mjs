/**
 * The object store a site is published to, and the publish step.
 *
 * Layout (the same keys in R2, in a local folder, or in Miniflare's emulated R2):
 *
 *   objects/<sha256>                 immutable bodies (pages, payloads, assets, chunks, MCP input)
 *   manifests/<sha256>.json          immutable build manifests
 *   sites/<site>/current.json        the pointer: {"manifest": "<sha256>", ...}; publishing = rewriting it
 *   hosts/<hostname>.json            {"site": "<site>"}: which site a hostname serves
 *
 * Publishing uploads only objects the store doesn't have (a HEAD per object not referenced by the
 * site's current manifest), then the manifest, then flips the pointer. Readers see the old build
 * until that last single-object write, then the new one: the switch is atomic and nothing is purged
 * (no key is ever overwritten except the pointer).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** A folder used as a bucket (self-host, local tests). */
export class FsStore {
  constructor(root) {
    this.root = path.resolve(root);
  }
  file(key) {
    const f = path.join(this.root, key);
    if (!f.startsWith(this.root + path.sep)) throw new Error(`bad key ${key}`);
    return f;
  }
  async has(key) {
    return fs.existsSync(this.file(key));
  }
  async put(key, body) {
    const f = this.file(key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    // Write then rename: a reader never sees half a pointer.
    const tmp = `${f}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, f);
  }
  async getText(key) {
    try {
      return fs.readFileSync(this.file(key), "utf8");
    } catch {
      return null;
    }
  }
  async getBytes(key) {
    try {
      return fs.readFileSync(this.file(key));
    } catch {
      return null;
    }
  }
  /** Keys under a prefix ending in "/" (recursive). */
  async list(prefix) {
    const out = [];
    const walk = (dir, rel) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.endsWith(".tmp")) continue;
        if (e.isDirectory()) walk(path.join(dir, e.name), `${rel}${e.name}/`);
        else if (e.isFile()) out.push(`${rel}${e.name}`);
      }
    };
    walk(path.join(this.root, prefix), prefix);
    return out;
  }
}

/** An R2 bucket binding (Worker, or Miniflare's getR2Bucket) behind the same three calls. */
export class R2Store {
  constructor(bucket) {
    this.bucket = bucket;
  }
  async has(key) {
    return (await this.bucket.head(key)) !== null;
  }
  async put(key, body) {
    await this.bucket.put(key, body);
  }
  async getText(key) {
    const o = await this.bucket.get(key);
    return o ? await o.text() : null;
  }
  async getBytes(key) {
    const o = await this.bucket.get(key);
    return o ? Buffer.from(await o.arrayBuffer()) : null;
  }
  async list(prefix) {
    const out = [];
    let cursor;
    do {
      const page = await this.bucket.list({ prefix, cursor });
      for (const o of page.objects) out.push(o.key);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return out;
  }
}

/**
 * An R2 bucket over its S3 API, for publishing from a laptop or CI (the Worker reads the same keys
 * through its binding). Credentials: an R2 API token's access key pair; endpoint from the account id.
 */
export class S3Store {
  constructor({ accountId, accessKeyId, secretAccessKey, bucket }) {
    if (!accountId || !accessKeyId || !secretAccessKey || !bucket) throw new Error("S3Store needs accountId, accessKeyId, secretAccessKey and bucket");
    this.base = `https://${accountId}.r2.cloudflarestorage.com/${bucket}`;
    this.keys = { accessKeyId, secretAccessKey };
  }
  async client() {
    if (!this.aws) {
      const { AwsClient } = await import("aws4fetch");
      this.aws = new AwsClient({ ...this.keys, service: "s3", region: "auto" });
    }
    return this.aws;
  }
  url(key) {
    return `${this.base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }
  async has(key) {
    const r = await (await this.client()).fetch(this.url(key), { method: "HEAD" });
    if (r.status === 404) return false;
    if (!r.ok) throw new Error(`R2 HEAD ${key}: ${r.status}`);
    return true;
  }
  async put(key, body) {
    const r = await (await this.client()).fetch(this.url(key), { method: "PUT", body });
    if (!r.ok) throw new Error(`R2 PUT ${key}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  async getText(key) {
    const r = await (await this.client()).fetch(this.url(key));
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`R2 GET ${key}: ${r.status}`);
    return await r.text();
  }
  async getBytes(key) {
    const r = await (await this.client()).fetch(this.url(key));
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`R2 GET ${key}: ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  /** Keys under a prefix (ListObjectsV2, paged). */
  async list(prefix) {
    const out = [];
    const unxml = (t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
    let token;
    do {
      const q = new URLSearchParams({ "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) });
      const r = await (await this.client()).fetch(`${this.base}?${q}`);
      if (!r.ok) throw new Error(`R2 LIST ${prefix}: ${r.status}`);
      const xml = await r.text();
      for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) out.push(unxml(m[1]));
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unxml(/<NextContinuationToken>([^<]*)</.exec(xml)?.[1] || "") || undefined : undefined;
    } while (token);
    return out;
  }
}

/** Every object hash a manifest references. */
export function manifestObjects(m) {
  const out = new Map();
  const add = (e) => e && out.set(e.o, e.s ?? 0);
  for (const r of Object.values(m.routes)) {
    add(r);
    add(r.rsc);
    add(r.prefetch);
  }
  for (const f of Object.values(m.files)) add(f);
  add(m.notFound);
  add(m.mcp);
  return out;
}

/**
 * Upload dist/ to `store` for `site` and flip the pointer. `hosts` (optional) are pointed at the
 * site. Returns counts for the report.
 */
export async function publish({ distDir, store, site, hosts = [], concurrency = 16, dryRun = false }) {
  const manifestJson = fs.readFileSync(path.join(distDir, "manifest.json"));
  const manifest = JSON.parse(manifestJson);
  const siteId = site || manifest.site.id;
  const manifestHash = crypto.createHash("sha256").update(manifestJson).digest("hex");

  // What the store already has for this site: everything its current manifest references.
  const known = new Set();
  const pointer = await store.getText(`sites/${siteId}/current.json`).then((t) => (t ? JSON.parse(t) : null)).catch(() => null);
  if (pointer?.manifest === manifestHash) return { site: siteId, manifest: manifestHash, uploaded: 0, uploadedBytes: 0, checked: 0, unchanged: true };
  if (pointer?.manifest) {
    const prev = await store.getText(`manifests/${pointer.manifest}.json`);
    if (prev) for (const h of manifestObjects(JSON.parse(prev)).keys()) known.add(h);
  }

  const wanted = [...manifestObjects(manifest)];
  let uploaded = 0;
  let uploadedBytes = 0;
  let checked = 0;
  const queue = wanted.filter(([h]) => !known.has(h));
  const knownFromPrevious = wanted.length - queue.length;
  const uploadedKeys = [];
  const work = async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      const [hash, size] = next;
      const key = `objects/${hash}`;
      checked++;
      if (await store.has(key)) continue; // another site (or an earlier publish) already has it
      uploaded++;
      uploadedBytes += size;
      uploadedKeys.push(key);
      if (!dryRun) await store.put(key, fs.readFileSync(path.join(distDir, "objects", hash)));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, work));
  if (!dryRun) {
    await store.put(`manifests/${manifestHash}.json`, manifestJson);
    await store.put(`sites/${siteId}/current.json`, JSON.stringify({ manifest: manifestHash, engine: manifest.engine, publishedAt: new Date().toISOString(), previous: pointer?.manifest ?? null }));
    for (const h of hosts) await store.put(`hosts/${h.toLowerCase()}.json`, JSON.stringify({ site: siteId }));
  }
  return { site: siteId, manifest: manifestHash, objects: wanted.length, knownFromPrevious, checked, uploaded, uploadedBytes, uploadedKeys, unchanged: false };
}

/**
 * The Worker's static assets folder from what is live: the shared engine files of every site's
 * current and previous manifest (the rollback) in `store`. Files the folder lacks are fetched from
 * the store's objects (a fresh CI machine rebuilds the folder this way); with `prune`, engine files
 * no live manifest references are deleted. Deploy the Worker afterwards. Pruning never breaks a
 * page: an older page still open in a tab that asks for a pruned chunk gets it from R2 through the
 * Worker (objects are never deleted there).
 */
export async function syncEngineAssets({ store, dir, prune = false, dryRun = false }) {
  const pointers = (await store.list("sites/")).filter((k) => /^sites\/[^/]+\/current\.json$/.test(k));
  const wanted = new Map();
  const manifests = new Set();
  for (const key of pointers) {
    const ptr = JSON.parse((await store.getText(key)) || "null");
    for (const h of [ptr?.manifest, ptr?.previous]) {
      if (!h || manifests.has(h)) continue;
      const raw = await store.getText(`manifests/${h}.json`);
      if (!raw) continue;
      manifests.add(h);
      for (const [p, f] of Object.entries(JSON.parse(raw).files)) if (f.shared) wanted.set(p, f.o);
    }
  }
  let fetched = 0;
  for (const [p, hash] of wanted) {
    const out = path.join(dir, ...p.split("/").filter(Boolean));
    if (fs.existsSync(out)) continue;
    fetched++;
    if (dryRun) continue;
    const body = await store.getBytes(`objects/${hash}`);
    if (!body) throw new Error(`object ${hash} (${p}) missing from the store`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body);
  }
  if (!dryRun) {
    const { writeAssetHeaders } = await import("./build.mjs");
    writeAssetHeaders(dir);
  }
  const removed = [];
  if (prune) {
    const walk = (d) => {
      for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) {
          walk(abs);
          if (!dryRun && fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
          continue;
        }
        const p = `/${path.relative(dir, abs).split(path.sep).join("/")}`;
        if (wanted.has(p)) continue;
        removed.push(p);
        if (!dryRun) fs.rmSync(abs);
      }
    };
    walk(path.join(dir, "_next", "static"));
  }
  return { sites: pointers.length, manifests: manifests.size, shared: wanted.size, fetched, removed: removed.length, removedExamples: removed.slice(0, 5) };
}
