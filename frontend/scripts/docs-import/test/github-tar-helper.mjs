/**
 * Builds small .tar.gz archives for the GitHub import tests (here and in docs-platform/test):
 * ustar headers written by hand, so a test can make the entries a real repo tarball never should
 * have (symlinks, `..`, absolute names, devices).
 */
import zlib from "node:zlib";

const octal = (h, value, at, len) => h.write(value.toString(8).padStart(len - 1, "0") + "\0", at, len, "latin1");

/** One entry: { name, type ("0" file, "2" symlink, "1" hard link, "3" device, "5" dir, "x"/"g" pax), body, linkname }. */
export function tarEntry({ name, type = "0", body = "", linkname = "", prefix = "" }) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  const h = Buffer.alloc(512);
  Buffer.from(name, "utf8").copy(h, 0, 0, Math.min(100, Buffer.byteLength(name)));
  octal(h, type === "5" ? 0o755 : 0o644, 100, 8);
  octal(h, 0, 108, 8);
  octal(h, 0, 116, 8);
  octal(h, data.length, 124, 12);
  octal(h, 1_700_000_000, 136, 12);
  h.fill(0x20, 148, 156);
  h.write(type, 156, 1, "latin1");
  h.write(linkname, 157, 100, "utf8");
  h.write("ustar\0", 257, 6, "latin1");
  h.write("00", 263, 2, "latin1");
  if (prefix) h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "latin1");
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([h, data, pad]);
}

/** pax records: { key: value } → "len key=value\n" lines (len counts itself). */
export function paxBody(obj) {
  let out = "";
  for (const [k, v] of Object.entries(obj)) {
    const rest = ` ${k}=${v}\n`;
    let len = Buffer.byteLength(rest) + 1;
    while (String(len).length + Buffer.byteLength(rest) !== len) len = String(len).length + Buffer.byteLength(rest);
    out += `${len}${rest}`;
  }
  return out;
}

/** Entries → a gzipped tar (with its two zero blocks). */
export function makeTarGz(entries) {
  return zlib.gzipSync(Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]));
}

/** A GitHub-style tarball: the pax global header with the commit, then `<top>/<path>` files. */
export function githubTarball(files, { sha = "0123456789abcdef0123456789abcdef01234567", top = "acme-docs-0123456" } = {}) {
  return makeTarGz([
    { name: "pax_global_header", type: "g", body: paxBody({ comment: sha }) },
    { name: `${top}/`, type: "5" },
    ...Object.entries(files).map(([p, body]) => ({ name: `${top}/${p}`, body })),
  ]);
}
