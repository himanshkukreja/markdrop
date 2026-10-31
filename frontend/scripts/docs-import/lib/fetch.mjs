/**
 * A polite, disk-cached HTTP client for the importers.
 *
 * - Every request goes through lib/guard.mjs (`safeGet`): https only, public addresses only (checked
 *   after DNS, the connection pinned to the checked address), redirects followed by hand and checked
 *   hop by hop, and only to the origins `allow` accepts (the fetcher's, or one given per call).
 * - Identifies itself (User-Agent) and keeps at most ~2 requests per second to the network.
 * - Every response (status, content type, final URL, body) is cached under `cacheDir`, keyed by
 *   URL, so a rerun refetches nothing. Delete the cache folder (or pass --refresh) to refetch.
 * - Retries 429 / 5xx and network errors a few times, honouring Retry-After. An address the guard
 *   refuses isn't retried: it fails at once, with the reason in `error`.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { GuardError, checkUrl, safeGet } from "./guard.mjs";

export const USER_AGENT = "MarkdropDocsImporter/0.1 (+https://markdrop.in)";

/**
 * `allow(url)`: the origins requests may go to (default: any public https host). `resolve` and
 * `transport` stand in for DNS and the connection in tests (lib/guard.mjs safeGet).
 */
export function createFetcher({ cacheDir, minIntervalMs = 500, refresh = false, log = () => {}, allow, resolve, transport }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  let last = 0;
  const stats = { network: 0, cached: 0, failed: 0, refused: 0 };

  const keyOf = (url) => crypto.createHash("sha1").update(url).digest("hex");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function throttle() {
    const wait = last + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
  }

  const refused = (url, e) => {
    stats.refused++;
    log(`REFUSED ${url}: ${e.message}`);
    return { ok: false, status: 0, type: "", url, body: Buffer.alloc(0), cached: false, error: e.message };
  };

  /** → { ok, status, type, url, body: Buffer, cached, error? } (never throws). Options: { allow }. */
  async function get(url, opts = {}) {
    const policy = opts.allow ?? allow;
    try {
      checkUrl(url, policy); // a cached answer too: the same rules as a fetch
    } catch (e) {
      return refused(url, e);
    }
    const key = keyOf(url);
    const metaFile = path.join(cacheDir, `${key}.json`);
    const bodyFile = path.join(cacheDir, `${key}.bin`);
    if (!refresh && fs.existsSync(metaFile) && fs.existsSync(bodyFile)) {
      stats.cached++;
      const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
      return { ...meta, body: fs.readFileSync(bodyFile), cached: true };
    }
    let lastErr = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      await throttle();
      try {
        stats.network++;
        const res = await safeGet(url, { allow: policy, resolve, transport, headers: { "User-Agent": USER_AGENT, Accept: "*/*" } });
        if (res.status === 429 || res.status >= 500) {
          const ra = Number(res.headers["retry-after"]);
          lastErr = `HTTP ${res.status}`;
          await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : 1500 * (attempt + 1));
          continue;
        }
        const meta = { ok: res.ok, status: res.status, type: res.type, url: res.url || url };
        // Cache successes and definitive misses (404s), not transient failures.
        if (res.ok || res.status === 404 || res.status === 410) {
          fs.writeFileSync(bodyFile, res.body);
          fs.writeFileSync(metaFile, JSON.stringify(meta));
        }
        log(`${res.status} ${url}`);
        return { ...meta, body: res.body, cached: false };
      } catch (e) {
        if (e instanceof GuardError) return refused(url, e);
        lastErr = String(e?.message || e);
        await sleep(1000 * (attempt + 1));
      }
    }
    stats.failed++;
    log(`FAIL ${url}: ${lastErr}`);
    return { ok: false, status: 0, type: "", url, body: Buffer.alloc(0), cached: false, error: lastErr };
  }

  async function text(url, opts) {
    const r = await get(url, opts);
    return { ...r, text: r.body.toString("utf8") };
  }

  return { get, text, stats };
}
