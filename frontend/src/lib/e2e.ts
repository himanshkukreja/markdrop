/**
 * End-to-end encryption for markdown documents.
 *
 * The browser generates a key, encrypts the document, and sends only ciphertext
 * to the API. The key is never transmitted: it rides in the URL **fragment**
 * (`markdrop.in/slug#k=…`), which browsers do not put in the request line and
 * strip from `Referer`. nginx, Vercel, the API and MongoDB therefore only ever
 * hold bytes nobody on our side can read.
 *
 * What that does and doesn't buy you is worth stating plainly: it means *we*
 * cannot read your document. It does not mean only authorised people can — the
 * link is the key, so anyone you forward it to can read it, and so can anyone
 * who finds it in your browser history.
 *
 * Title and body are sealed together in one envelope and the server's `title`
 * column is left null, so there is no metadata to leak either. Encrypting the
 * title into its own field wasn't an option anyway: the ciphertext of a long
 * title overflows that column's 200-character limit.
 */

/** Envelope: `mdx1.<base64url iv>.<base64url ciphertext>`. */
const PREFIX = "mdx1.";
const IV_BYTES = 12; // 96-bit nonce, the size AES-GCM is specified for
/** Mirrors the API's max_content_chars — the envelope is what gets stored, not the text. */
const MAX_STORED_CHARS = 500_000;

export interface Sealed {
  title: string | null;
  content: string;
}

/** WebCrypto needs a secure context; localhost counts, plain http on a LAN IP does not. */
export function isSupported(): boolean {
  return typeof crypto !== "undefined" && !!crypto.subtle;
}

export class DecryptError extends Error {}
export class TooLargeError extends Error {}

// ── base64url, without padding ────────────────────────────────────────────────

function toB64Url(bytes: Uint8Array<ArrayBuffer>): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  // Allocated from a real ArrayBuffer so the result is a BufferSource WebCrypto
  // accepts — a bare `new Uint8Array(n)` widens to ArrayBufferLike.
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Keys ──────────────────────────────────────────────────────────────────────

export async function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function exportKey(key: CryptoKey): Promise<string> {
  return toB64Url(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
}

export async function importKey(encoded: string): Promise<CryptoKey> {
  const raw = fromB64Url(encoded);
  if (raw.byteLength !== 32) throw new DecryptError("Key is the wrong length");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, [
    "encrypt",
    "decrypt",
  ]);
}

// ── Sealing ───────────────────────────────────────────────────────────────────

/**
 * Seal title + body into one envelope.
 *
 * A fresh random IV per call: AES-GCM loses all its guarantees if a nonce is
 * ever reused under the same key, and every edit re-encrypts under that key.
 */
export async function seal(key: CryptoKey, value: Sealed): Promise<string> {
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ t: value.title ?? null, c: value.content })
  );
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext)
  );
  const envelope = `${PREFIX}${toB64Url(iv)}.${toB64Url(cipher)}`;
  if (envelope.length > MAX_STORED_CHARS) {
    // base64 costs a third on top, so the readable limit is lower than the
    // stored one. Say so here rather than letting the API return a bare 422.
    throw new TooLargeError(
      "This document is too long to encrypt. Encrypted documents hold about " +
        "370,000 characters, because the encrypted form is larger than the text."
    );
  }
  return envelope;
}

export function isEnvelope(value: string): boolean {
  return value.startsWith(PREFIX);
}

export async function unseal(key: CryptoKey, envelope: string): Promise<Sealed> {
  if (!isEnvelope(envelope)) throw new DecryptError("Not an encrypted document");
  const [, ivPart, cipherPart] = envelope.split(".");
  if (!ivPart || !cipherPart) throw new DecryptError("Malformed envelope");
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64Url(ivPart) },
      key,
      fromB64Url(cipherPart)
    );
  } catch {
    // GCM authenticates as well as encrypts, so this is also what a tampered
    // ciphertext looks like — not only a wrong key.
    throw new DecryptError("Could not decrypt with this key");
  }
  const parsed = JSON.parse(new TextDecoder().decode(plain));
  return { title: parsed.t ?? null, content: String(parsed.c ?? "") };
}

// ── The key's only home: the URL fragment ─────────────────────────────────────

/** Read the key out of `#k=…`. Client-only — the server never sees a fragment. */
export function readKeyFromFragment(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return null;
  const value = new URLSearchParams(hash).get("k");
  return value && value.trim() ? value.trim() : null;
}

export function withKey(url: string, encodedKey: string): string {
  return `${url.split("#")[0]}#k=${encodedKey}`;
}
