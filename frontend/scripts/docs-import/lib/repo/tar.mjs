/**
 * A gzip tar reader for repository tarballs (GitHub's codeload .tar.gz), in plain JS: no system tar,
 * nothing a tarball says is trusted.
 *
 * - Regular files only. Symlinks, hard links, devices and FIFOs are refused (listed, never written).
 * - Names are normalised; an absolute name, a `..` segment, a backslash or a NUL refuses the entry.
 * - The first path segment (GitHub's `owner-repo-sha/` folder) is stripped (`strip`).
 * - Caps: files kept, bytes kept, bytes per file (a bigger file is skipped and listed), entries and
 *   bytes read in all (a bomb stops the read with TarError).
 * - The commit sha comes from the pax global header's `comment=` (GitHub writes it there).
 *
 * `readTarGz` streams: a file `keep(path)` refuses is skipped without buffering it.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";

export const TAR_LIMITS = Object.freeze({
  maxFiles: 20_000,
  maxBytes: 400 * 1024 * 1024,
  maxFileBytes: 100 * 1024 * 1024,
  maxEntries: 200_000,
  maxStreamBytes: 4 * 1024 * 1024 * 1024,
});

export class TarError extends Error {
  constructor(message) {
    super(message);
    this.name = "TarError";
  }
}

const zero = (b) => {
  for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false;
  return true;
};
const field = (b, at, len) => {
  const s = b.subarray(at, at + len);
  const end = s.indexOf(0);
  return s.subarray(0, end < 0 ? s.length : end).toString("utf8");
};
function numField(b, at, len) {
  // GNU base-256 for big values: the first byte's high bit set.
  if (b[at] & 0x80) {
    let n = b[at] & 0x7f;
    for (let i = 1; i < len; i++) n = n * 256 + b[at + i];
    return n;
  }
  const s = field(b, at, len).trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) throw new TarError("not a tar archive (bad number field)");
  return parseInt(s, 8);
}
function checksumOk(h) {
  const want = numField(h, 148, 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  return sum === want;
}

/** "len key=value\n" records → {key: value}. */
export function parsePax(buf) {
  const out = {};
  let i = 0;
  const s = buf;
  while (i < s.length) {
    const sp = s.indexOf(0x20, i);
    if (sp < 0) break;
    const len = Number(s.toString("utf8", i, sp));
    if (!Number.isInteger(len) || len <= 0 || i + len > s.length) break;
    const rec = s.toString("utf8", sp + 1, i + len - 1); // without the trailing \n
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * A tar member name → a clean repo path (after stripping `strip` leading segments), "" for the
 * stripped folder itself, or { refused: reason }.
 */
export function cleanTarPath(raw, strip = 1) {
  const s = String(raw);
  if (s.includes("\0")) return { refused: "NUL byte in the name" };
  if (s.includes("\\")) return { refused: "backslash in the name" };
  if (s.startsWith("/") || /^[A-Za-z]:/.test(s)) return { refused: "absolute path" };
  const segs = [];
  for (const seg of s.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") return { refused: "a .. segment" };
    segs.push(seg);
  }
  return { path: segs.slice(strip).join("/") };
}

const TYPE_NAMES = { 1: "hard link", 2: "symlink", 3: "character device", 4: "block device", 6: "FIFO" };

class TarParser {
  constructor({ keep, onFile, limits, strip }) {
    this.keep = keep;
    this.onFile = onFile;
    this.lim = limits;
    this.strip = strip;
    this.hdr = Buffer.alloc(512);
    this.hdrFill = 0;
    this.state = "header";
    this.remaining = 0;
    this.pad = 0;
    this.entry = null;
    this.parts = null;
    this.pax = {};
    this.longName = null;
    this.zeros = 0;
    this.ended = false;
    this.result = { commit: null, files: 0, bytes: 0, entries: 0, refused: [], skipped: 0 };
  }

  push(chunk) {
    let off = 0;
    while (off < chunk.length && !this.ended) {
      if (this.state === "header") {
        const n = Math.min(512 - this.hdrFill, chunk.length - off);
        chunk.copy(this.hdr, this.hdrFill, off, off + n);
        this.hdrFill += n;
        off += n;
        if (this.hdrFill === 512) {
          this.hdrFill = 0;
          this.header(this.hdr);
        }
      } else if (this.state === "data") {
        const n = Math.min(this.remaining, chunk.length - off);
        if (this.parts) this.parts.push(Buffer.from(chunk.subarray(off, off + n)));
        this.remaining -= n;
        off += n;
        if (!this.remaining) this.finishEntry();
      } else {
        const n = Math.min(this.pad, chunk.length - off);
        this.pad -= n;
        off += n;
        if (!this.pad) this.state = "header";
      }
    }
  }

  header(h) {
    if (zero(h)) {
      if (++this.zeros >= 2) this.ended = true;
      return;
    }
    this.zeros = 0;
    if (!checksumOk(h)) throw new TarError("not a tar archive (bad header checksum)");
    if (++this.result.entries > this.lim.maxEntries) throw new TarError(`more than ${this.lim.maxEntries} entries in the archive`);
    const type = String.fromCharCode(h[156] || 48);
    let size = numField(h, 124, 12);
    let name = field(h, 0, 100);
    const prefix = h.toString("latin1", 257, 262) === "ustar" ? field(h, 345, 155) : "";
    if (prefix) name = `${prefix}/${name}`;
    if (this.longName !== null) {
      name = this.longName;
      this.longName = null;
    }
    if (this.pax.path !== undefined) name = this.pax.path;
    if (this.pax.size !== undefined && /^\d+$/.test(this.pax.size)) size = Number(this.pax.size);
    const meta = type === "x" || type === "g" || type === "L" || type === "K";
    if (!meta) this.pax = {};
    if (size < 0 || !Number.isSafeInteger(size)) throw new TarError("not a tar archive (bad size)");
    this.entry = { type, name, size, collect: false };
    if (meta) {
      if (size > 1024 * 1024) throw new TarError("an oversized tar extension header");
      this.entry.collect = true;
    } else if (type === "0" || type === "7") {
      const c = cleanTarPath(name, this.strip);
      if (c.refused) this.result.refused.push({ path: name.slice(0, 300), reason: c.refused });
      else if (c.path && this.keep(c.path)) {
        if (size > this.lim.maxFileBytes) this.result.refused.push({ path: c.path, reason: `larger than ${Math.round(this.lim.maxFileBytes / 1048576)} MB` });
        else {
          if (++this.result.files > this.lim.maxFiles) throw new TarError(`more than ${this.lim.maxFiles} files`);
          this.result.bytes += size;
          if (this.result.bytes > this.lim.maxBytes) throw new TarError(`more than ${Math.round(this.lim.maxBytes / 1048576)} MB of files`);
          this.entry.collect = true;
          this.entry.path = c.path;
        }
      } else this.result.skipped++;
    } else if (type !== "5") {
      // Links, devices, FIFOs, and anything unknown: never extracted.
      this.result.refused.push({ path: name.slice(0, 300), reason: TYPE_NAMES[type] ?? `entry type ${JSON.stringify(type)}` });
    }
    this.parts = this.entry.collect ? [] : null;
    this.remaining = size;
    this.pad = (512 - (size % 512)) % 512;
    if (size === 0) this.finishEntry();
    else this.state = "data";
  }

  finishEntry() {
    const e = this.entry;
    const body = this.parts ? Buffer.concat(this.parts) : null;
    this.parts = null;
    this.state = this.pad ? "pad" : "header";
    if (!e || !body) return;
    if (e.type === "x") this.pax = parsePax(body);
    else if (e.type === "g") {
      const g = parsePax(body);
      if (/^[0-9a-f]{40}$/.test(g.comment ?? "")) this.result.commit = g.comment;
    } else if (e.type === "L") this.longName = body.toString("utf8").replace(/\0+$/, "");
    else if (e.type === "K") {
      /* a long link target: links are refused anyway */
    } else if (e.path) this.onFile(e.path, body);
  }
}

/**
 * Reads a .tar.gz (a Buffer or a readable stream of its bytes). Every kept regular file goes to
 * `onFile(path, bytes)`, or, without one, into `files` (a Map). Returns { files?, commit, files: n… }.
 */
export async function readTarGz(input, { keep = () => true, onFile, limits = {}, strip = 1, gzip = true } = {}) {
  const lim = { ...TAR_LIMITS, ...limits };
  const files = onFile ? null : new Map();
  const parser = new TarParser({ keep, onFile: onFile ?? ((p, b) => files.set(p, b)), limits: lim, strip });
  const source = Buffer.isBuffer(input) ? Readable.from([input]) : input;
  const stream = gzip ? source.pipe(zlib.createGunzip()) : source;
  let read = 0;
  try {
    for await (const chunk of stream) {
      read += chunk.length;
      if (read > lim.maxStreamBytes) throw new TarError(`the archive unpacks to more than ${Math.round(lim.maxStreamBytes / 1048576)} MB`);
      parser.push(chunk);
      if (parser.ended) break;
    }
  } catch (e) {
    stream.destroy?.();
    if (e instanceof TarError) throw e;
    throw new TarError(`not a readable .tar.gz (${e.code || e.message})`);
  }
  if (parser.state !== "header" && !parser.ended) throw new TarError("the archive ends in the middle of a file");
  const r = parser.result;
  return { ...(files ? { map: files } : {}), commit: r.commit, files: r.files, bytes: r.bytes, entries: r.entries, refused: r.refused, skipped: r.skipped };
}

/**
 * Extracts a .tar.gz into `dir` (created; it should be empty): every kept file written under it,
 * nothing outside it (each target is checked after joining). Returns readTarGz's summary.
 */
export async function extractTarGz(input, dir, opts = {}) {
  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true });
  const conflicts = [];
  const res = await readTarGz(input, {
    ...opts,
    onFile(rel, body) {
      const target = path.resolve(root, ...rel.split("/"));
      if (!target.startsWith(root + path.sep)) return conflicts.push({ path: rel, reason: "outside the folder" });
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const st = fs.lstatSync(target, { throwIfNoEntry: false });
        if (st && !st.isFile()) return conflicts.push({ path: rel, reason: "a folder of the same name" });
        fs.writeFileSync(target, body);
      } catch (e) {
        conflicts.push({ path: rel, reason: e.code || "not written" });
      }
    },
  });
  return { ...res, refused: [...res.refused, ...conflicts] };
}
