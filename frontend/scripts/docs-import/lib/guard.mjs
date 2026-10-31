/**
 * The importers' one way onto the network. An import reads whatever a third-party site (and its
 * llms.txt, its pages, its images) points at, on a machine that has a network of its own, so every
 * request goes through `safeGet`:
 *
 * - https only, on the default port, without credentials, and never to an IP address written as the
 *   host (in any spelling: Node's URL already turns "0x7f.1" or "2130706433" into "127.0.0.1").
 * - The name is resolved here and every address it has is checked (`blockedAddress`): loopback,
 *   private, link-local, CGNAT, unique-local, multicast, reserved and unspecified addresses, the
 *   IPv4-mapped / NAT64 / 6to4 spellings of those, and so the cloud metadata addresses
 *   (169.254.169.254, fd00:ec2::254, 100.100.100.200, 192.0.0.192) are refused.
 * - The connection goes to the address that was checked (a lookup pinned to it), so a DNS answer
 *   that changes between the check and the connect (rebinding) can't move it.
 * - Redirects aren't followed by the HTTP client: each hop (at most MAX_REDIRECTS) is checked like
 *   the first, the caller's `allow` policy (which origins it may read from) included.
 *
 * Also here: which files an import may keep (`IMPORT_EXTS`, by their bytes, `sniffExt`). The docs host
 * serves a site's files from the site's own origin with their extension's type, so nothing a browser
 * renders as a page or runs (HTML, XML, SVG, JavaScript) is kept.
 */
import dns from "node:dns";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";

export const MAX_REDIRECTS = 5;
export const MAX_BYTES = 200 * 1024 * 1024; // a GitBook screen-recording GIF can be 60 MB
const TIMEOUT_MS = 60_000;

export class GuardError extends Error {
  constructor(message) {
    super(message);
    this.name = "GuardError";
  }
}

/* ── addresses ───────────────────────────────────────────────────────────── */

const V4_BLOCKED = [
  ["0.0.0.0", 8], // "this network", 0.0.0.0
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT (Alibaba's metadata 100.100.100.200 too)
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local (AWS/GCP/Azure metadata 169.254.169.254)
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments (Oracle's metadata 192.0.0.192)
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, 255.255.255.255
].map(([a, bits]) => [v4Int(a), bits]);

function v4Int(a) {
  return a.split(".").reduce((n, x) => n * 256 + Number(x), 0);
}

function v4Blocked(a) {
  const n = v4Int(a);
  return V4_BLOCKED.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
}

/** "2001:db8::1" (or with a trailing dotted quad, or a %zone) → 16 bytes. */
function v6Bytes(a) {
  let s = a.split("%")[0];
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const n = v4Int(tail[1]);
    s = s.slice(0, -tail[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, rest] = s.split("::");
  const part = (x) => (x ? x.split(":") : []);
  const h = part(head);
  const r = rest === undefined ? [] : part(rest);
  const groups = rest === undefined ? h : [...h, ...Array(8 - h.length - r.length).fill("0"), ...r];
  return groups.flatMap((g) => {
    const v = parseInt(g, 16);
    return [v >> 8, v & 0xff];
  });
}

function v6Blocked(a) {
  const b = v6Bytes(a);
  const zeros = (from, to) => b.slice(from, to).every((x) => x === 0);
  const v4At = (i) => `${b[i]}.${b[i + 1]}.${b[i + 2]}.${b[i + 3]}`;
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4Blocked(v4At(12)); // ::ffff:a.b.c.d
  if (zeros(0, 8) && b[8] === 0xff && b[9] === 0xff && zeros(10, 12)) return v4Blocked(v4At(12)); // ::ffff:0:a.b.c.d
  if (zeros(0, 12)) return true; // ::, ::1, and the old ::a.b.c.d
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return zeros(4, 12) ? v4Blocked(v4At(12)) : true; // NAT64
  if ((b[0] & 0xe0) !== 0x20) return true; // not global unicast (2000::/3): link-local, unique-local, multicast, …
  if (b[0] === 0x20 && b[1] === 0x02) return v4Blocked(v4At(2)); // 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && ((b[2] === 0 && b[3] === 0) || (b[2] === 0x0d && b[3] === 0xb8))) return true; // Teredo, documentation
  return false;
}

/** True when an import must never connect to this address (anything not plainly public). */
export function blockedAddress(address) {
  const kind = net.isIP(String(address ?? ""));
  if (kind === 4) return v4Blocked(address);
  if (kind === 6) return v6Blocked(address);
  return true;
}

/* ── addresses (URLs) ────────────────────────────────────────────────────── */

/**
 * The URL, when an import may request it: https, the default port, no credentials, a DNS name
 * (not an IP address), and allowed by `allow(url)` (the caller's origin policy). Else GuardError.
 */
export function checkUrl(input, allow) {
  let u;
  try {
    u = input instanceof URL ? new URL(input.href) : new URL(String(input));
  } catch {
    throw new GuardError("not a valid address");
  }
  if (u.protocol !== "https:") throw new GuardError(`only https:// addresses are fetched (${u.protocol})`);
  if (u.username || u.password) throw new GuardError("addresses with credentials aren't fetched");
  if (u.port) throw new GuardError(`only the default https port is fetched (:${u.port})`);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host || net.isIP(host)) throw new GuardError(`${u.hostname} is an IP address, not a site name`);
  if (host === "localhost" || host.endsWith(".localhost")) throw new GuardError(`${host} is this machine`);
  if (allow && !allow(u)) throw new GuardError(`${u.origin} isn't one of the hosts this import reads from`);
  u.hash = "";
  return u;
}

function systemResolve(hostname) {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

/** The name's first address, when every address it has is public; else GuardError. */
export async function resolvePublic(hostname, resolve = systemResolve) {
  let addrs;
  try {
    addrs = await resolve(hostname);
  } catch (e) {
    throw new GuardError(`${hostname} doesn't resolve (${e?.code || e?.message || e})`);
  }
  if (!Array.isArray(addrs) || !addrs.length) throw new GuardError(`${hostname} doesn't resolve`);
  for (const a of addrs) if (blockedAddress(a?.address)) throw new GuardError(`${hostname} points at a private or reserved address (${a?.address})`);
  const a = addrs[0];
  return { address: a.address, family: a.family ?? net.isIP(a.address) };
}

/** A `lookup` for net.connect that answers with the one address already checked. */
export function pinnedLookup(pin) {
  return (hostname, options, cb) => {
    if (typeof options === "function") [cb, options] = [options, {}];
    if (options?.all) cb(null, [{ address: pin.address, family: pin.family }]);
    else cb(null, pin.address, pin.family);
  };
}

/* ── the request ─────────────────────────────────────────────────────────── */

const agent = new https.Agent({ keepAlive: true, maxSockets: 6 });

/** One GET to `url` at the pinned address: { status, headers, body }. No redirects followed. */
export function httpsGetPinned(url, { pin, headers = {}, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: "https:",
        hostname: url.hostname,
        servername: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: "GET",
        headers: { ...headers, host: url.host, "accept-encoding": "gzip, deflate, br" },
        lookup: pinnedLookup(pin),
        agent,
      },
      (res) => {
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        const stream =
          enc === "gzip" || enc === "x-gzip" ? res.pipe(zlib.createGunzip()) : enc === "deflate" ? res.pipe(zlib.createInflate()) : enc === "br" ? res.pipe(zlib.createBrotliDecompress()) : res;
        const chunks = [];
        let size = 0;
        stream.on("data", (c) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy(new GuardError(`larger than ${Math.round(maxBytes / 1e6)} MB`));
            return;
          }
          chunks.push(c);
        });
        stream.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        stream.on("error", reject);
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer in ${timeoutMs / 1000} s`)));
    req.on("error", reject);
    req.end();
  });
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * GET `input` the safe way (see the top of the file): → { ok, status, type, url (after redirects), headers, body }.
 * Throws GuardError when the address (or a redirect's) isn't allowed, Error on network failure.
 * `resolve` and `transport` stand in for DNS and the connection in tests.
 */
export async function safeGet(input, { allow, headers, maxRedirects = MAX_REDIRECTS, resolve, transport = httpsGetPinned, timeoutMs, maxBytes } = {}) {
  let url = checkUrl(input, allow);
  for (let hop = 0; ; hop++) {
    const pin = await resolvePublic(url.hostname, resolve);
    const res = await transport(url, { pin, headers, timeoutMs, maxBytes });
    const location = res.headers?.location;
    if (REDIRECTS.has(res.status) && location) {
      if (hop >= maxRedirects) throw new GuardError(`more than ${maxRedirects} redirects`);
      let next;
      try {
        next = new URL(Array.isArray(location) ? location[0] : location, url);
      } catch {
        throw new GuardError("a redirect to an invalid address");
      }
      url = checkUrl(next, allow);
      continue;
    }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, type: String(res.headers?.["content-type"] || ""), url: url.href, headers: res.headers ?? {}, body: res.body };
  }
}

/* ── files an import may keep ────────────────────────────────────────────── */

/** Extensions an import may leave in /docs-assets/ (backend: docs_import_job.IMPORT_ASSET_TYPES). */
export const IMPORT_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "pdf", "mp4", "webm"]);
export const IMAGE_EXTS = new Set(["png", "jpg", "gif", "webp", "avif"]);

/** The file type of these bytes, among IMPORT_EXTS ("jpg" for JPEG), or null. */
export function sniffExt(buf) {
  if (!buf || buf.length < 12) return null;
  const s = (a, b) => buf.toString("latin1", a, b);
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (s(0, 6) === "GIF87a" || s(0, 6) === "GIF89a") return "gif";
  if (s(0, 4) === "RIFF" && s(8, 12) === "WEBP") return "webp";
  if (s(4, 8) === "ftyp") return ["avif", "avis"].includes(s(8, 12)) ? "avif" : "mp4";
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return "webm";
  if (s(0, 5) === "%PDF-") return "pdf";
  if (buf.readUInt32BE(0) === 0x00000100) return "ico";
  return null;
}
