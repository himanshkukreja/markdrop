/**
 * End-to-end encryption for markdown documents.
 *
 * The browser generates a key, encrypts the document, and sends only the
 * encrypted text to the API. The key is never transmitted: it rides in the URL
 * **fragment** (`markdrop.in/slug#k=…`), which browsers do not put in the
 * request line and strip from `Referer`. nginx, Vercel, the API and MongoDB
 * therefore hold bytes nobody on our side can read.
 *
 * What that does and doesn't buy you is worth stating plainly: it means *we*
 * cannot read your document. It does not mean only authorised people can — the
 * link is the key, so anyone you forward it to can read it, and so can anyone
 * who finds it in your browser history. The page code that does the encrypting
 * is served by Markdrop, so you are trusting that code. What stays visible to us:
 * the link name, the size of the encrypted text, dates and view counts.
 *
 * Two envelope formats. Both open forever; only v2 is written.
 *
 *   mdx1.<b64url iv>.<b64url ciphertext‖tag>
 *     AES-256-GCM straight under the 32-byte link key. No AAD, no padding.
 *
 *   mdx2.<b64url header>.<b64url ciphertext‖tag>
 *     header (69 bytes):
 *       0      version   0x02
 *       1      mode      0 = link key, 1 = link key + password
 *       2      kdf       0 = none, 1 = PBKDF2-SHA256, 2 = Argon2id (reserved, not written)
 *       3..6   kdf param uint32 big-endian (PBKDF2 iterations; 0 when kdf = 0)
 *       7      flags     bit 0 = plaintext was deflate-raw compressed; other bits must be 0
 *       8      reserved  0
 *       9..24  salt      16 random bytes, fresh per seal
 *       25..36 nonce     12 random bytes, fresh per seal
 *       37..68 commitment HMAC-SHA256(commitKey, header[0..36])
 *     ikm       = linkKey                          (mode 0)
 *               = linkKey ‖ PBKDF2(password, salt) (mode 1; NFC, 32 bytes)
 *     encKey    = HKDF-SHA256(ikm, salt, "markdrop/doc/v2/enc")
 *     commitKey = HKDF-SHA256(ikm, salt, "markdrop/doc/v2/commit")
 *     The commitment is checked (in constant time) before decrypting, so a wrong
 *     key or password is told apart from altered bytes. AES-256-GCM's AAD is the
 *     whole 69-byte header.
 *     plaintext = frame(maybeDeflate(utf8(JSON {"v":2,"t":title|null,"c":markdown})))
 *     frame     = uint32 BE length ‖ bytes ‖ zeros, to the next 512-byte boundary,
 *                 so the stored size only says roughly how long a document is.
 *
 * The link key (the part after `#k=`) is the same 32 random bytes in both
 * formats, so re-saving a v1 document writes v2 under the same link.
 *
 * Title and body are sealed together and the server's `title` column is left
 * null.
 */

// Plain erasable TypeScript only: `node --test` runs this file directly (e2e.test.mjs).

const PREFIX_V1 = "mdx1.";
const PREFIX_V2 = "mdx2.";
const IV_BYTES = 12; // 96-bit nonce, the size AES-GCM is specified for
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const COMMIT_BYTES = 32;
const TAG_BYTES = 16;
/** Everything in the header before the commitment. */
const HEADER_PRE = 1 + 1 + 1 + 4 + 1 + 1 + SALT_BYTES + IV_BYTES; // 37
export const HEADER_BYTES = HEADER_PRE + COMMIT_BYTES; // 69
const PAD_BLOCK = 512;
/** OWASP's current figure for PBKDF2-HMAC-SHA256. */
export const PBKDF2_ITERATIONS = 600_000;
/** What a reader will run. Below: too weak to have come from us. Above: a stall someone forced on them. */
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 10_000_000;
/** A decompression bomb stops here; 500,000 characters of JSON-escaped UTF-8 is well under. */
const MAX_PLAINTEXT_BYTES = 8 * 1024 * 1024;
const FLAG_DEFLATE = 0x01;
const INFO_ENC = "markdrop/doc/v2/enc";
const INFO_COMMIT = "markdrop/doc/v2/commit";
/** Mirrors the API's max_content_chars — the envelope is what gets stored, not the text. */
const MAX_STORED_CHARS = 500_000;

export const MODE_KEY = 0;
export const MODE_PASSWORD = 1;
export const KDF_NONE = 0;
export const KDF_PBKDF2 = 1;
export const KDF_ARGON2ID = 2;

export interface Sealed {
  title: string | null;
  content: string;
}

/** The 32 random bytes behind `#k=`. Raw, because v2 derives its keys from them. */
export type DocKey = Uint8Array<ArrayBuffer>;

export interface Opened extends Sealed {
  version: 1 | 2;
  /** "password" when the document also needs a password (v2 mode 1). */
  mode: "key" | "password";
}

export interface EnvelopeInfo {
  version: 1 | 2;
  mode: "key" | "password";
  /** v2 only. */
  kdf: "none" | "pbkdf2" | "argon2id" | null;
  iterations: number | null;
  compressed: boolean;
  /** Characters the server stores. */
  storedLength: number;
}

/** WebCrypto needs a secure context; localhost counts, plain http on a LAN IP does not. */
export function isSupported(): boolean {
  return typeof crypto !== "undefined" && !!crypto.subtle && typeof crypto.getRandomValues === "function";
}

export function compressionSupported(): boolean {
  return typeof CompressionStream === "function" && typeof DecompressionStream === "function";
}

// ── Errors ────────────────────────────────────────────────────────────────────

/**
 * Why a document didn't open. The screens say different things for each, so the
 * reason has to be precise:
 * - "key": the key doesn't open this version (wrong, old, or rotated away). For
 *   v1 this also covers altered bytes — v1 can't tell the two apart.
 * - "password": the password (or, indistinguishably, the key) is wrong. Never
 *   reported as tampering.
 * - "password-required": a password document opened without one.
 * - "altered": the key is right (commitment verified) but the bytes were changed.
 * - "malformed": not an envelope we can parse.
 * - "unsupported": this browser, or this version of Markdrop, can't open it.
 */
export type DecryptReason = "key" | "password" | "password-required" | "altered" | "malformed" | "unsupported";

export class DecryptError extends Error {
  reason: DecryptReason;
  constructor(reason: DecryptReason, message: string) {
    super(message);
    this.name = "DecryptError";
    this.reason = reason;
  }
}

export class TooLargeError extends Error {}

// ── base64url, without padding ────────────────────────────────────────────────

function toB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new DecryptError("malformed", "Malformed envelope");
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  let bin: string;
  try {
    bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  } catch {
    throw new DecryptError("malformed", "Malformed envelope");
  }
  // Allocated from a real ArrayBuffer so the result is a BufferSource WebCrypto
  // accepts — a bare `new Uint8Array(n)` widens to ArrayBufferLike.
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytes(n: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(n));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = bytes(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

/** Length of base64url (unpadded) for n bytes. */
function b64Len(n: number): number {
  return Math.floor(n / 3) * 4 + [0, 2, 3][n % 3]!;
}

/** Same length, every byte compared: no early exit to time. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// ── Keys ──────────────────────────────────────────────────────────────────────

export function generateKey(): DocKey {
  return crypto.getRandomValues(bytes(KEY_BYTES));
}

export function exportKey(key: DocKey): string {
  return toB64Url(key);
}

/** Decode `#k=`. Throws DecryptError("key") for anything that isn't 32 bytes. */
export function importKey(encoded: string): DocKey {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromB64Url(encoded.trim());
  } catch {
    throw new DecryptError("key", "This isn't a valid key");
  }
  if (raw.byteLength !== KEY_BYTES) throw new DecryptError("key", "This isn't a valid key");
  return raw;
}

// ── Compression ───────────────────────────────────────────────────────────────

async function pump(input: Uint8Array, stream: CompressionStream | DecompressionStream, cap: number): Promise<Uint8Array<ArrayBuffer>> {
  const writer = stream.writable.getWriter();
  // Errors surface through the reader; a rejected write must not go unhandled.
  writer.write(input as Uint8Array<ArrayBuffer>).catch(() => {});
  writer.close().catch(() => {});
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      reader.cancel().catch(() => {});
      throw new DecryptError("malformed", "The document is larger than any Markdrop document can be");
    }
    chunks.push(value);
  }
  return concat(...chunks);
}

const deflate = (b: Uint8Array) => pump(b, new CompressionStream("deflate-raw"), Number.MAX_SAFE_INTEGER);
const inflate = (b: Uint8Array) => pump(b, new DecompressionStream("deflate-raw"), MAX_PLAINTEXT_BYTES);

// ── Padding ───────────────────────────────────────────────────────────────────

function frame(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const total = Math.ceil((4 + data.length) / PAD_BLOCK) * PAD_BLOCK;
  const out = bytes(total);
  new DataView(out.buffer).setUint32(0, data.length, false);
  out.set(data, 4);
  return out;
}

function unframe(padded: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  if (padded.length < 4) throw new DecryptError("malformed", "Malformed envelope");
  const len = new DataView(padded.buffer, padded.byteOffset).getUint32(0, false);
  if (len > padded.length - 4) throw new DecryptError("malformed", "Malformed envelope");
  return padded.slice(4, 4 + len);
}

// ── v2 key schedule ───────────────────────────────────────────────────────────

async function passwordBits(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array<ArrayBuffer>> {
  const base = await crypto.subtle.importKey("raw", utf8(password.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, 256));
}

async function schedule(ikm: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>): Promise<{ enc: CryptoKey; commit: CryptoKey }> {
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const derive = async (info: string) =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: utf8(info) }, base, 256));
  const [encRaw, commitRaw] = await Promise.all([derive(INFO_ENC), derive(INFO_COMMIT)]);
  const [enc, commit] = await Promise.all([
    crypto.subtle.importKey("raw", encRaw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
    crypto.subtle.importKey("raw", commitRaw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  ]);
  return { enc, commit };
}

async function inputKeyMaterial(key: DocKey, mode: number, salt: Uint8Array<ArrayBuffer>, iterations: number, password: string | null): Promise<Uint8Array<ArrayBuffer>> {
  if (mode === MODE_KEY) return key;
  return concat(key, await passwordBits(password ?? "", salt, iterations));
}

// ── Sealing ───────────────────────────────────────────────────────────────────

export interface SealOptions {
  /** Also require this password to open it (mode 1). Empty or missing = link key only. */
  password?: string | null;
  /** Compress when the browser can (default). False forces the uncompressed form. */
  compress?: boolean;
  /** PBKDF2 iterations; tests only. */
  iterations?: number;
}

function tooLarge(): TooLargeError {
  // base64 costs a third on top, so the readable limit is lower than the stored
  // one. Say so here rather than letting the API return a bare 422.
  return new TooLargeError(
    "This document is too long to encrypt. The encrypted form is larger than the text, " +
      "and it has to fit in 500,000 characters. Split it into two documents, or publish it without encryption."
  );
}

/**
 * Seal title + body into a v2 envelope.
 *
 * Fresh salt and nonce every call: every edit re-encrypts under the same link
 * key, and a new salt means new derived keys each time, so a nonce can never
 * repeat under one AES key.
 */
export async function seal(key: DocKey, value: Sealed, opts: SealOptions = {}): Promise<string> {
  if (key.byteLength !== KEY_BYTES) throw new DecryptError("key", "This isn't a valid key");
  const password = opts.password ? opts.password : null;
  const mode = password ? MODE_PASSWORD : MODE_KEY;
  const iterations = mode === MODE_PASSWORD ? (opts.iterations ?? PBKDF2_ITERATIONS) : 0;

  const json = utf8(JSON.stringify({ v: 2, t: value.title ?? null, c: value.content }));
  let body: Uint8Array = json;
  let flags = 0;
  if (opts.compress !== false && compressionSupported()) {
    const packed = await deflate(json);
    // Never store the bigger of the two (already-compressed text grows slightly).
    if (packed.length < json.length) {
      body = packed;
      flags |= FLAG_DEFLATE;
    }
  }
  const plaintext = frame(body);

  const salt = crypto.getRandomValues(bytes(SALT_BYTES));
  const nonce = crypto.getRandomValues(bytes(IV_BYTES));
  const pre = bytes(HEADER_PRE);
  const view = new DataView(pre.buffer);
  pre[0] = 0x02;
  pre[1] = mode;
  pre[2] = mode === MODE_PASSWORD ? KDF_PBKDF2 : KDF_NONE;
  view.setUint32(3, iterations, false);
  pre[7] = flags;
  pre[8] = 0;
  pre.set(salt, 9);
  pre.set(nonce, 9 + SALT_BYTES);

  const ikm = await inputKeyMaterial(key, mode, salt, iterations, password);
  const { enc, commit } = await schedule(ikm, salt);
  const commitment = new Uint8Array(await crypto.subtle.sign("HMAC", commit, pre));
  const header = concat(pre, commitment);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: header }, enc, plaintext)
  );
  const envelope = `${PREFIX_V2}${toB64Url(header)}.${toB64Url(cipher)}`;
  if (envelope.length > MAX_STORED_CHARS) throw tooLarge();
  return envelope;
}

/**
 * The longest envelope `seal` can produce for this text (uncompressed, padded) —
 * what the editor's meter counts. Compression usually makes the real one shorter.
 */
export function maxSealedLength(title: string | null, content: string): number {
  const json = utf8(JSON.stringify({ v: 2, t: title || null, c: content })).length;
  const padded = Math.ceil((4 + json) / PAD_BLOCK) * PAD_BLOCK;
  return PREFIX_V2.length + b64Len(HEADER_BYTES) + 1 + b64Len(padded + TAG_BYTES);
}

/**
 * The v1 writer, kept only so the tests can pin the legacy format with a
 * known-answer vector. Nothing in the app writes v1 any more.
 */
export async function sealV1ForTests(key: DocKey, value: Sealed, iv: Uint8Array<ArrayBuffer>): Promise<string> {
  const aes = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt"]);
  const plaintext = utf8(JSON.stringify({ t: value.title ?? null, c: value.content }));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, plaintext));
  return `${PREFIX_V1}${toB64Url(iv)}.${toB64Url(cipher)}`;
}

// ── Opening ───────────────────────────────────────────────────────────────────

export function isEnvelope(value: string): boolean {
  return value.startsWith(PREFIX_V1) || value.startsWith(PREFIX_V2);
}

interface ParsedV2 {
  pre: Uint8Array<ArrayBuffer>;
  header: Uint8Array<ArrayBuffer>;
  mode: number;
  kdf: number;
  iterations: number;
  flags: number;
  salt: Uint8Array<ArrayBuffer>;
  nonce: Uint8Array<ArrayBuffer>;
  commitment: Uint8Array<ArrayBuffer>;
  cipher: Uint8Array<ArrayBuffer>;
}

function parseV2(envelope: string): ParsedV2 {
  const parts = envelope.slice(PREFIX_V2.length).split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new DecryptError("malformed", "Malformed envelope");
  const header = fromB64Url(parts[0]);
  const cipher = fromB64Url(parts[1]);
  if (header.length !== HEADER_BYTES || cipher.length < TAG_BYTES) throw new DecryptError("malformed", "Malformed envelope");
  if (header[0] !== 0x02) throw new DecryptError("malformed", "Malformed envelope");
  const view = new DataView(header.buffer);
  const mode = header[1]!;
  const kdf = header[2]!;
  const iterations = view.getUint32(3, false);
  const flags = header[7]!;
  const newer = () => new DecryptError("unsupported", "This document was made by a newer version of Markdrop. Reload the page to update it.");
  if (kdf === KDF_ARGON2ID) throw newer();
  if (mode !== MODE_KEY && mode !== MODE_PASSWORD) throw newer();
  if ((flags & ~FLAG_DEFLATE) !== 0 || header[8] !== 0) throw newer();
  if (mode === MODE_KEY && (kdf !== KDF_NONE || iterations !== 0)) throw new DecryptError("malformed", "Malformed envelope");
  if (mode === MODE_PASSWORD && (kdf !== KDF_PBKDF2 || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS)) {
    throw new DecryptError("malformed", "Malformed envelope");
  }
  return {
    pre: header.slice(0, HEADER_PRE),
    header,
    mode,
    kdf,
    iterations,
    flags,
    salt: header.slice(9, 9 + SALT_BYTES),
    nonce: header.slice(9 + SALT_BYTES, HEADER_PRE),
    commitment: header.slice(HEADER_PRE),
    cipher,
  };
}

/** What the envelope says about itself, without a key. Null when it isn't one. */
export function inspect(envelope: string): EnvelopeInfo | null {
  try {
    if (envelope.startsWith(PREFIX_V1)) {
      return { version: 1, mode: "key", kdf: null, iterations: null, compressed: false, storedLength: envelope.length };
    }
    if (envelope.startsWith(PREFIX_V2)) {
      const p = parseV2(envelope);
      return {
        version: 2,
        mode: p.mode === MODE_PASSWORD ? "password" : "key",
        kdf: p.kdf === KDF_PBKDF2 ? "pbkdf2" : "none",
        iterations: p.kdf === KDF_PBKDF2 ? p.iterations : null,
        compressed: (p.flags & FLAG_DEFLATE) !== 0,
        storedLength: envelope.length,
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** True when opening this envelope also needs a password. */
export function requiresPassword(envelope: string): boolean {
  return inspect(envelope)?.mode === "password";
}

function parsePlaintext(json: Uint8Array): Sealed {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json));
  } catch {
    throw new DecryptError("malformed", "The document's contents couldn't be read");
  }
  const o = (parsed && typeof parsed === "object" ? parsed : {}) as { t?: unknown; c?: unknown };
  return { title: typeof o.t === "string" ? o.t : null, content: typeof o.c === "string" ? o.c : String(o.c ?? "") };
}

async function unsealV1(key: DocKey, envelope: string): Promise<Opened> {
  const [, ivPart, cipherPart, extra] = envelope.split(".");
  if (!ivPart || !cipherPart || extra !== undefined) throw new DecryptError("malformed", "Malformed envelope");
  const iv = fromB64Url(ivPart);
  if (iv.length !== IV_BYTES) throw new DecryptError("malformed", "Malformed envelope");
  const aes = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["decrypt"]);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aes, fromB64Url(cipherPart));
  } catch {
    // v1 has no key commitment: a wrong key and altered bytes look the same. The
    // likelier story by far is an old or wrong link, so that is what we say.
    throw new DecryptError("key", "This key doesn't open the current version");
  }
  return { ...parsePlaintext(new Uint8Array(plain)), version: 1, mode: "key" };
}

async function unsealV2(key: DocKey, envelope: string, password: string | null): Promise<Opened> {
  const p = parseV2(envelope);
  if (p.mode === MODE_PASSWORD && !password) throw new DecryptError("password-required", "This document needs a password");
  if ((p.flags & FLAG_DEFLATE) && !compressionSupported()) {
    throw new DecryptError("unsupported", "This browser can't open this document. Update it, or try another browser.");
  }
  const ikm = await inputKeyMaterial(key, p.mode, p.salt, p.iterations, password);
  const { enc, commit } = await schedule(ikm, p.salt);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", commit, p.pre));
  if (!constantTimeEqual(expected, p.commitment)) {
    // With a password the key and the password are mixed before this check, so
    // the two can't be told apart. Say "password" — the thing a reader can fix —
    // and never "tampered".
    if (p.mode === MODE_PASSWORD) throw new DecryptError("password", "Wrong password");
    throw new DecryptError("key", "This key doesn't open the current version");
  }
  let plain: Uint8Array<ArrayBuffer>;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: p.nonce, additionalData: p.header }, enc, p.cipher)
    );
  } catch {
    // The key is demonstrably right (the commitment matched), so these bytes are
    // not the ones that were sealed.
    throw new DecryptError("altered", "The stored document doesn't match what was encrypted");
  }
  let body: Uint8Array = unframe(plain);
  if (p.flags & FLAG_DEFLATE) {
    try {
      body = await inflate(body);
    } catch (e) {
      if (e instanceof DecryptError) throw e;
      throw new DecryptError("malformed", "The document's contents couldn't be read");
    }
  }
  return { ...parsePlaintext(body), version: 2, mode: p.mode === MODE_PASSWORD ? "password" : "key" };
}

export async function unseal(key: DocKey, envelope: string, opts: { password?: string | null } = {}): Promise<Opened> {
  if (!isSupported()) throw new DecryptError("unsupported", "This browser can't decrypt documents");
  if (key.byteLength !== KEY_BYTES) throw new DecryptError("key", "This isn't a valid key");
  if (envelope.startsWith(PREFIX_V1)) return unsealV1(key, envelope);
  if (envelope.startsWith(PREFIX_V2)) return unsealV2(key, envelope, opts.password ?? null);
  if (/^mdx\d+\./.test(envelope)) {
    throw new DecryptError("unsupported", "This document was made by a newer version of Markdrop. Reload the page to update it.");
  }
  throw new DecryptError("malformed", "Not an encrypted document");
}

// ── Passwords ─────────────────────────────────────────────────────────────────

/**
 * A rough strength reading for the password field. Not a gate: anyone holding
 * the link can try passwords offline at PBKDF2 speed, so this nudges toward
 * length, which is what actually helps.
 */
export function passwordStrength(password: string): { level: 0 | 1 | 2 | 3; label: string } {
  const p = password.normalize("NFC");
  if (!p) return { level: 0, label: "" };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  const words = p.trim().split(/[\s\-_.]+/).filter((w) => w.length >= 3).length;
  const unique = new Set(p).size;
  if (p.length < 8 || unique < 5) return { level: 1, label: "Weak — use 12 or more characters, or four random words" };
  if (p.length >= 16 || words >= 4 || (p.length >= 12 && classes >= 3)) return { level: 3, label: "Strong" };
  return { level: 2, label: "Fair — longer is stronger" };
}

// ── The key's only home: the URL fragment ─────────────────────────────────────

/** Read the key out of `#k=…`. Client-only — the server never sees a fragment. */
export function readKeyFromFragment(): string | null {
  if (typeof window === "undefined") return null;
  return keyFromHash(window.location.hash);
}

export function keyFromHash(hash: string): string | null {
  const h = hash.replace(/^#/, "");
  if (!h) return null;
  const value = new URLSearchParams(h).get("k");
  return value && value.trim() ? value.trim() : null;
}

/**
 * The key out of a pasted link (or a bare key). Parsed here, never sent
 * anywhere. Returns null when there's nothing that could be one.
 */
export function keyFromPastedLink(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const hashAt = t.indexOf("#");
  const candidate = hashAt >= 0 ? keyFromHash(t.slice(hashAt)) : /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null;
  if (!candidate) return null;
  try {
    importKey(candidate);
    return candidate;
  } catch {
    return null;
  }
}

export function withKey(url: string, encodedKey: string): string {
  return `${url.split("#")[0]}#k=${encodedKey}`;
}

// ── Keys remembered on this device ────────────────────────────────────────────
//
// The link is the only copy of the key, which makes losing the link absolute.
// The publisher's browser keeps a copy when it publishes; readers choose to
// ("Remember on this device"). It never leaves the browser, so the server's
// position is unchanged, and signing out offers to clear it.
//
// It does widen the blast radius of an XSS on markdrop.in from "this session"
// to "every key this browser has kept". That is the same exposure class as the
// session token already stored here, and the architecture that keeps it honest
// is the same one: user-authored HTML is served from a separate registrable
// site and can never run on this origin.

const KEY_STORE = "markdrop_doc_keys";
/** Old entries are evicted rather than grown forever; a lost key is recoverable from the link. */
const KEY_STORE_LIMIT = 200;

function readStore(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY_STORE) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, string>): void {
  try {
    if (Object.keys(store).length === 0) localStorage.removeItem(KEY_STORE);
    else localStorage.setItem(KEY_STORE, JSON.stringify(store));
  } catch {
    // A full or disabled localStorage costs us the convenience, nothing else.
  }
}

export function rememberKey(slug: string, encodedKey: string): void {
  const store = readStore();
  delete store[slug]; // re-insert so rotation moves it to the newest position
  store[slug] = encodedKey;
  const keys = Object.keys(store);
  for (const stale of keys.slice(0, Math.max(0, keys.length - KEY_STORE_LIMIT))) {
    delete store[stale];
  }
  writeStore(store);
}

export function recallKey(slug: string): string | null {
  const v = readStore()[slug];
  return typeof v === "string" ? v : null;
}

export function forgetKey(slug: string): void {
  const store = readStore();
  if (!(slug in store)) return;
  delete store[slug];
  writeStore(store);
}

export function hasRememberedKey(slug: string): boolean {
  return recallKey(slug) !== null;
}

/** A renamed document keeps the key this browser saved for it. */
export function moveRememberedKey(oldSlug: string, newSlug: string): void {
  if (!oldSlug || !newSlug || oldSlug === newSlug) return;
  const store = readStore();
  const key = store[oldSlug];
  if (typeof key !== "string") return;
  delete store[oldSlug];
  store[newSlug] = key;
  writeStore(store);
}

export function rememberedKeyCount(): number {
  return Object.keys(readStore()).length;
}

export function forgetAllKeys(): void {
  try {
    localStorage.removeItem(KEY_STORE);
  } catch {
    /* nothing to clear */
  }
}

// ── A key on its way through sign-in ──────────────────────────────────────────
//
// `/login?next=…` and the custom-domain handoff both drop the fragment. The key
// waits in this tab's sessionStorage (never a query string) and goes back into
// the address bar when the reader returns to the same page.

const PENDING_PREFIX = "md_pending_key:";

function pendingSlot(host: string, path: string): string {
  return `${PENDING_PREFIX}${host}${path}`;
}

/** Keep the current page's `#k=` for the trip through sign-in. */
export function stashPendingKey(): void {
  if (typeof window === "undefined") return;
  const key = readKeyFromFragment();
  if (!key) return;
  try {
    sessionStorage.setItem(pendingSlot(window.location.host, window.location.pathname), key);
  } catch {
    /* storage blocked: the reader pastes the link again */
  }
}

/**
 * Back from sign-in: put a stashed key back in the address bar (replaceState, so
 * no navigation and no request) and return it. Single use.
 */
export function restorePendingKey(): string | null {
  if (typeof window === "undefined") return null;
  const slot = pendingSlot(window.location.host, window.location.pathname);
  let key: string | null = null;
  try {
    key = sessionStorage.getItem(slot);
    if (key) sessionStorage.removeItem(slot);
  } catch {
    return null;
  }
  if (!key) return null;
  if (!readKeyFromFragment()) {
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#k=${key}`);
  }
  return key;
}
