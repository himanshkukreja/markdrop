/**
 * A streaming, store-only ZIP writer — used for exactly one thing: sending
 * several files to a version-1 peer (the Go CLI as released today), which can
 * only receive one file per connection but already unpacks a transfer marked
 * `isFolder`. So it gets one archive and extracts it to a folder; the person on
 * the other end sees their files, not a zip.
 *
 * Store-only (no compression) so the exact size is known before the first
 * byte — the v1 `meta` must state it — and so it costs no CPU beyond CRC-32.
 * Sizes and CRCs go in data descriptors after each file, which is what lets
 * this stream without reading every file twice.
 *
 * No ZIP64: refuses above 4 GiB or 65 535 entries rather than writing an
 * archive the CLI can't open.
 */

export const ZIP_FOLDER = "markdrop-files";
const LIMIT = 0xffffffff;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(crc: number, bytes: Uint8Array): number {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface Entry {
  file: File;
  name: Uint8Array; // UTF-8 path inside the archive
}

/** Archive paths: one top-level folder, unique names, nothing the CLI's
 *  path-traversal guard would refuse (it rejects any ".." substring). */
export function zipEntries(files: File[]): Entry[] {
  const seen = new Set<string>();
  const enc = new TextEncoder();
  return files.map((file) => {
    const clean = (file.name.replace(/[\\/]/g, "_").replace(/\.\.+/g, "_") || "file");
    let name = clean;
    const dot = clean.lastIndexOf(".");
    for (let i = 2; seen.has(name.toLowerCase()); i++) {
      name = dot > 0 ? `${clean.slice(0, dot)} (${i})${clean.slice(dot)}` : `${clean} (${i})`;
    }
    seen.add(name.toLowerCase());
    return { file, name: enc.encode(`${ZIP_FOLDER}/${name}`) };
  });
}

export function zipSize(entries: Entry[]): number | null {
  if (entries.length >= 0xffff) return null;
  let local = 0;
  let central = 0;
  for (const e of entries) {
    local += 30 + e.name.length + e.file.size + 16;
    central += 46 + e.name.length;
  }
  const total = local + central + 22;
  return local <= LIMIT && total <= LIMIT ? total : null;
}

function dosDateTime(d: Date): [number, number] {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [time, date];
}

const FLAGS = 0x0808; // bit 3: sizes in data descriptor · bit 11: UTF-8 names
const VERSION = 20;   // 2.0; "made by" FAT, so extractors default to 0666

/**
 * Yields the archive as a sequence of buffers. `onData(index, bytes)` reports
 * file payload as it passes, for per-file progress.
 */
export async function* zipStream(
  entries: Entry[],
  readSize: number,
  onData: (index: number, bytes: number) => void,
): AsyncGenerator<ArrayBuffer> {
  const [time, date] = dosDateTime(new Date());
  const records: { crc: number; size: number; offset: number }[] = [];
  let offset = 0;

  for (let i = 0; i < entries.length; i++) {
    const { file, name } = entries[i];
    const head = new DataView(new ArrayBuffer(30 + name.length));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, VERSION, true);
    head.setUint16(6, FLAGS, true);
    head.setUint16(8, 0, true); // stored
    head.setUint16(10, time, true);
    head.setUint16(12, date, true);
    // crc / sizes (14..25) zero: they follow in the data descriptor
    head.setUint16(26, name.length, true);
    new Uint8Array(head.buffer).set(name, 30);
    yield head.buffer;

    let crc = 0;
    for (let pos = 0; pos < file.size; pos += readSize) {
      const block = await file.slice(pos, Math.min(pos + readSize, file.size)).arrayBuffer();
      crc = crc32(crc, new Uint8Array(block));
      yield block;
      onData(i, block.byteLength);
    }

    const desc = new DataView(new ArrayBuffer(16));
    desc.setUint32(0, 0x08074b50, true);
    desc.setUint32(4, crc, true);
    desc.setUint32(8, file.size, true);
    desc.setUint32(12, file.size, true);
    yield desc.buffer;

    records.push({ crc, size: file.size, offset });
    offset += 30 + name.length + file.size + 16;
  }

  const cdStart = offset;
  for (let i = 0; i < entries.length; i++) {
    const { name } = entries[i];
    const r = records[i];
    const cd = new DataView(new ArrayBuffer(46 + name.length));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, VERSION, true);
    cd.setUint16(6, VERSION, true);
    cd.setUint16(8, FLAGS, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, r.crc, true);
    cd.setUint32(20, r.size, true);
    cd.setUint32(24, r.size, true);
    cd.setUint16(28, name.length, true);
    // extra, comment, disk, internal/external attrs (30..41) zero
    cd.setUint32(42, r.offset, true);
    new Uint8Array(cd.buffer).set(name, 46);
    yield cd.buffer;
    offset += 46 + name.length;
  }

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, offset - cdStart, true);
  end.setUint32(16, cdStart, true);
  yield end.buffer;
}
