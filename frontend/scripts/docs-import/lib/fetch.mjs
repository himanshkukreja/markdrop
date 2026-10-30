/**
 * A polite, disk-cached HTTP client for the importers.
 *
 * - Identifies itself (User-Agent) and keeps at most ~2 requests per second to the network.
 * - Every response (status, content type, final URL, body) is cached under `cacheDir`, keyed by
 *   URL, so a rerun refetches nothing. Delete the cache folder (or pass --refresh) to refetch.
 * - Retries 429 / 5xx and network errors a few times, honouring Retry-After.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const USER_AGENT = "MarkdropDocsImporter/0.1 (+https://markdrop.in)";

export function createFetcher({ cacheDir, minIntervalMs = 500, refresh = false, log = () => {} }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  let last = 0;
  const stats = { network: 0, cached: 0, failed: 0 };

  const keyOf = (url) => crypto.createHash("sha1").update(url).digest("hex");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function throttle() {
    const wait = last + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
  }

  /** → { ok, status, type, url, body: Buffer, cached } (never throws). */
  async function get(url) {
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
        const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "*/*" }, redirect: "follow" });
        if (res.status === 429 || res.status >= 500) {
          const ra = Number(res.headers.get("retry-after"));
          lastErr = `HTTP ${res.status}`;
          await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1500 * (attempt + 1));
          continue;
        }
        const body = Buffer.from(await res.arrayBuffer());
        const meta = { ok: res.ok, status: res.status, type: res.headers.get("content-type") || "", url: res.url || url };
        // Cache successes and definitive misses (404s), not transient failures.
        if (res.ok || res.status === 404 || res.status === 410) {
          fs.writeFileSync(bodyFile, body);
          fs.writeFileSync(metaFile, JSON.stringify(meta));
        }
        log(`${res.status} ${url}`);
        return { ...meta, body, cached: false };
      } catch (e) {
        lastErr = String(e?.message || e);
        await sleep(1000 * (attempt + 1));
      }
    }
    stats.failed++;
    log(`FAIL ${url}: ${lastErr}`);
    return { ok: false, status: 0, type: "", url, body: Buffer.alloc(0), cached: false, error: lastErr };
  }

  async function text(url) {
    const r = await get(url);
    return { ...r, text: r.body.toString("utf8") };
  }

  return { get, text, stats };
}
