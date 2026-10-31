/**
 * The object store a site is published to, and the publish step.
 *
 * Layout (the same keys in R2, in a local folder, or in Miniflare's emulated R2):
 *
 *   objects/<sha256>                 immutable bodies (pages, payloads, assets, chunks, MCP input)
 *   manifests/<sha256>.json          immutable build manifests
 *   sites/<site>/current.json        the pointer: {"manifest": "<sha256>", ...}; publishing = rewriting it
 *   hosts/<hostname>.json            {"site": "<site>"}: which site a hostname serves (a publish
 *                                    writes one only where none is, or where it is already its
 *                                    site's: a host is never taken from another site)
 *   sites/<site>/access.json         {"site", "level", "policy_version"}: a password or members-only
 *                                    site's policy (no object = public; no secrets in it). Never
 *                                    served: the edge serves only what a manifest lists. Written by
 *                                    the API's access job and by publish, never to a lower version
 *
 * Publishing uploads only objects the store doesn't have (a HEAD per object not referenced by the
 * site's current manifest), then the manifest, then flips the pointer. Readers see the old build
 * until that last single-object write, then the new one: the switch is atomic and nothing is purged
 * (no key is ever overwritten except the pointer and the access policy).
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
  /** Keys under a prefix with their size and an ETag (the MD5 of the bytes, as R2 gives for a single PUT). */
  async listObjects(prefix) {
    const out = [];
    for (const key of await this.list(prefix)) {
      const body = fs.readFileSync(this.file(key));
      out.push({ key, size: body.length, etag: crypto.createHash("md5").update(body).digest("hex") });
    }
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
  async listObjects(prefix) {
    const out = [];
    let cursor;
    do {
      const page = await this.bucket.list({ prefix, cursor });
      for (const o of page.objects) out.push({ key: o.key, size: o.size, etag: String(o.etag || "").replace(/"/g, "") });
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return out;
  }
}

/** R2's own error code and message from an S3 error body (no keys or signatures are in it). */
async function r2Error(r) {
  try {
    const t = await r.text();
    const code = /<Code>([^<]{1,80})<\/Code>/.exec(t)?.[1];
    const msg = /<Message>([^<]{1,200})<\/Message>/.exec(t)?.[1];
    return code ? ` ${code}${msg ? `: ${msg}` : ""}` : "";
  } catch {
    return "";
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
    if (!r.ok) throw new Error(`R2 HEAD ${key}: ${r.status}${await r2Error(r)}`);
    return true;
  }
  async put(key, body) {
    const r = await (await this.client()).fetch(this.url(key), { method: "PUT", body });
    if (!r.ok) throw new Error(`R2 PUT ${key}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  async getText(key) {
    const r = await (await this.client()).fetch(this.url(key));
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`R2 GET ${key}: ${r.status}${await r2Error(r)}`);
    return await r.text();
  }
  async getBytes(key) {
    const r = await (await this.client()).fetch(this.url(key));
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`R2 GET ${key}: ${r.status}${await r2Error(r)}`);
    return Buffer.from(await r.arrayBuffer());
  }
  /** Keys under a prefix (ListObjectsV2, paged). */
  async list(prefix) {
    return (await this.listObjects(prefix)).map((o) => o.key);
  }
  /** Keys under a prefix with their size and ETag (unquoted; the MD5 of the bytes for a single PUT). */
  async listObjects(prefix) {
    const out = [];
    const unxml = (t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
    let token;
    do {
      const q = new URLSearchParams({ "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) });
      const r = await (await this.client()).fetch(`${this.base}?${q}`);
      if (!r.ok) throw new Error(`R2 LIST ${prefix}: ${r.status}${await r2Error(r)}`);
      const xml = await r.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = /<Key>([^<]*)<\/Key>/.exec(m[1])?.[1];
        if (key === undefined) continue;
        const size = Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1] ?? 0);
        const etag = unxml(/<ETag>([^<]*)<\/ETag>/.exec(m[1])?.[1] ?? "").replace(/"/g, "");
        out.push({ key: unxml(key), size, etag });
      }
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

const ACCESS_LEVELS = new Set(["public", "password", "members"]);

/**
 * Write a site's access policy, `sites/<site>/access.json` = {site, level, policy_version} (the
 * edge gates a password or members-only site by it: edge/access.mjs). Never lowers the version
 * already there, so a newer policy written by the API meanwhile wins. Returns the policy in force.
 * An unreadable existing policy is overwritten (it would lock the site; the API's version is newer
 * or equal by construction).
 */
export async function writeAccess(store, site, access, { dryRun = false } = {}) {
  if (!access || !ACCESS_LEVELS.has(access.level) || !Number.isSafeInteger(access.policy_version) || access.policy_version < 0) {
    throw new Error(`bad access policy ${JSON.stringify(access)}`);
  }
  const key = `sites/${site}/access.json`;
  const raw = await store.getText(key);
  let cur = null;
  try {
    cur = raw ? JSON.parse(raw) : null;
  } catch {
    cur = null;
  }
  if (cur && Number.isSafeInteger(cur.policy_version) && ACCESS_LEVELS.has(cur.level)) {
    if (cur.policy_version > access.policy_version) return { level: cur.level, policy_version: cur.policy_version, written: false };
    if (cur.policy_version === access.policy_version && cur.level === access.level) return { level: cur.level, policy_version: cur.policy_version, written: false };
  }
  // A site that was never anything but public needs no object (no object = public).
  if (!raw && access.level === "public" && access.policy_version === 0) return { level: "public", policy_version: 0, written: false };
  if (!dryRun) await store.put(key, JSON.stringify({ site, level: access.level, policy_version: access.policy_version, updatedAt: new Date().toISOString() }));
  return { level: access.level, policy_version: access.policy_version, written: true };
}

/** Thrown by a store from withPointerGuard when the site is no longer wanted live. */
export class NotWanted extends Error {
  constructor(message = "the site was taken down while this version was building") {
    super(message);
    this.notWanted = true;
  }
}

/**
 * `store` with one check in front of the publish's last step: before `sites/<site>/current.json`
 * is written, `stillWanted()` (the API: is this build still to go live?) must answer true, else
 * the write is refused with NotWanted and nothing goes live. Every other call passes through.
 */
export function withPointerGuard(store, site, stillWanted) {
  const guarded = Object.create(store);
  guarded.put = async (key, body) => {
    if (key === `sites/${site}/current.json` && !(await stillWanted())) throw new NotWanted();
    return store.put(key, body);
  };
  return guarded;
}

/**
 * Point `hosts` at `site`: a mapping is written only when the host has none (one that already
 * serves this site is left as it is). A host that serves another site is never taken: the API
 * moves a host between sites, a build doesn't. Returns { written, kept: [hosts of another site] }.
 */
export async function claimHosts(store, site, hosts, { dryRun = false } = {}) {
  const written = [];
  const kept = [];
  for (const raw of hosts) {
    const h = String(raw).toLowerCase();
    const key = `hosts/${h}.json`;
    const cur = await store.getText(key);
    if (cur !== null) {
      let owner = null;
      try {
        owner = JSON.parse(cur)?.site ?? null;
      } catch {
        owner = null;
      }
      if (owner !== site) kept.push(h);
      continue;
    }
    if (!dryRun) await store.put(key, JSON.stringify({ site }));
    written.push(h);
  }
  return { written, kept };
}

/**
 * Upload dist/ to `store` for `site` and flip the pointer. `hosts` (optional) are pointed at the
 * site where free (claimHosts). `access` (optional, {level, policy_version}) is written before the pointer flips, so a
 * password or members-only site is never served without its policy. Returns counts for the report.
 */
export async function publish({ distDir, store, site, hosts = [], access = null, concurrency = 16, dryRun = false }) {
  const manifestJson = fs.readFileSync(path.join(distDir, "manifest.json"));
  const manifest = JSON.parse(manifestJson);
  const siteId = site || manifest.site.id;
  const manifestHash = crypto.createHash("sha256").update(manifestJson).digest("hex");
  // Before anything goes live (an error here stops the publish).
  const accessRes = access ? await writeAccess(store, siteId, access, { dryRun }) : undefined;

  // What the store already has for this site: everything its current manifest references.
  const known = new Set();
  const pointer = await store.getText(`sites/${siteId}/current.json`).then((t) => (t ? JSON.parse(t) : null)).catch(() => null);
  if (pointer?.manifest === manifestHash) return { site: siteId, manifest: manifestHash, uploaded: 0, uploadedBytes: 0, checked: 0, unchanged: true, access: accessRes };
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
  }
  const hostsRes = await claimHosts(store, siteId, hosts, { dryRun });
  return { site: siteId, manifest: manifestHash, objects: wanted.length, knownFromPrevious, checked, uploaded, uploadedBytes, uploadedKeys, unchanged: false, access: accessRes, hosts: hostsRes };
}

/**
 * Point a site at a manifest the store already has: the restore (an earlier build goes live again
 * with no rebuild and no upload; manifests and objects are never deleted). The pointer is the one
 * object a publish rewrites, so this is the same atomic switch, and `previous` keeps the build it
 * replaced (the assets sync keeps that one's engine files too). Refuses a manifest that isn't this
 * site's (another site's, or one that names no site) unless `force`.
 */
export async function pointSite({ store, site, manifest, force = false, dryRun = false }) {
  if (!site || !/^[A-Za-z0-9_-]{1,64}$/.test(site)) throw new Error(`bad site id ${site}`);
  if (!/^[0-9a-f]{64}$/.test(String(manifest))) throw new Error("the manifest must be a sha256 hex hash");
  const raw = await store.getText(`manifests/${manifest}.json`);
  if (!raw) throw new Error(`manifest ${manifest} is not in the store`);
  const m = JSON.parse(raw);
  if (!force && m.site?.id !== site) throw new Error(`manifest ${manifest.slice(0, 12)} belongs to site "${m.site?.id ?? "(none)"}", not "${site}"`);
  const pointer = await store.getText(`sites/${site}/current.json`).then((t) => (t ? JSON.parse(t) : null)).catch(() => null);
  if (pointer?.manifest === manifest) return { site, manifest, engine: m.engine, previous: pointer.previous ?? null, unchanged: true };
  const next = { manifest, engine: m.engine, publishedAt: new Date().toISOString(), previous: pointer?.manifest ?? null, restored: true };
  if (!dryRun) await store.put(`sites/${site}/current.json`, JSON.stringify(next));
  return { site, manifest, engine: m.engine, previous: next.previous, unchanged: false };
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
