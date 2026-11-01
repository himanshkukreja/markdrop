// End-to-end envelope tests. Run: npm run e2e:crypto (also part of docs:test)
// Node >= 22.18 strips the types from e2e.ts; it has no imports. Node 22 has WebCrypto and CompressionStream.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DecryptError, HEADER_BYTES, PBKDF2_ITERATIONS, TooLargeError, constantTimeEqual, exportKey, generateKey, importKey,
  inspect, isEnvelope, keyFromPastedLink, maxSealedLength, passwordStrength, requiresPassword, seal, sealV1ForTests, unseal,
} from "./e2e.ts";

const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
const unb64u = (s) => new Uint8Array(Buffer.from(s, "base64url"));
const fixedKey = () => { const k = new Uint8Array(new ArrayBuffer(32)); for (let i = 0; i < 32; i++) k[i] = i; return k; };
const fixedIv = () => { const v = new Uint8Array(new ArrayBuffer(12)); for (let i = 0; i < 12; i++) v[i] = 100 + i; return v; };
// Fast iterations for the round trips that don't care; one test runs the real 600,000.
const FAST = { iterations: 100_000 };

async function rejectsWith(promise, reason) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof DecryptError, `expected DecryptError, got ${e?.constructor?.name}: ${e?.message}`);
    assert.equal(e.reason, reason, `expected reason ${reason}, got ${e.reason} (${e.message})`);
    return true;
  });
}

/** Flip one bit of the header (byte index) or the ciphertext, keeping it base64url. */
function flip(envelope, part, index, bit = 1) {
  const [prefix, h, c] = envelope.split(".");
  const header = unb64u(h);
  const cipher = unb64u(c);
  (part === "header" ? header : cipher)[index] ^= bit;
  return `${prefix}.${b64u(header)}.${b64u(cipher)}`;
}

// ── v1 (legacy) ───────────────────────────────────────────────────────────────

// Computed independently with Python's `cryptography` AESGCM: key = bytes 0..31,
// iv = bytes 100..111, plaintext = {"t":"Hello","c":"# Secret\n\nbody é"}.
const V1_KAT = "mdx1.ZGVmZ2hpamtsbW5v.MzmqREPLHvtSDjDK9kcJ33jgJSrYCZAAwqXwJqfNxyfwkGAD5TDm9favtFAPeOY7HA3reizUqA";
const V1_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

test("v1 known-answer vector: the legacy writer produces exactly the stored envelope", async () => {
  assert.equal(exportKey(fixedKey()), V1_KEY);
  const env = await sealV1ForTests(fixedKey(), { title: "Hello", content: "# Secret\n\nbody é" }, fixedIv());
  assert.equal(env, V1_KAT);
});

test("v1 documents still open with their #k= link", async () => {
  const opened = await unseal(importKey(V1_KEY), V1_KAT);
  assert.deepEqual(opened, { title: "Hello", content: "# Secret\n\nbody é", version: 1, mode: "key" });
  assert.deepEqual(inspect(V1_KAT), { version: 1, mode: "key", kdf: null, iterations: null, compressed: false, storedLength: V1_KAT.length });
});

test("v1 with the wrong key is a key problem, never 'altered'", async () => {
  await rejectsWith(unseal(generateKey(), V1_KAT), "key");
  // v1 has no commitment, so altered bytes can't be told from a wrong key either.
  const [p, iv, c] = V1_KAT.split(".");
  const bad = unb64u(c); bad[3] ^= 1;
  await rejectsWith(unseal(importKey(V1_KEY), `${p}.${iv}.${b64u(bad)}`), "key");
});

// ── v2 known answers, from an independent implementation ─────────────────────

// Sealed by a Python reference implementation (cryptography + hashlib + zlib) with
// salt = bytes 0..15 and nonce = bytes 16..27, key = bytes 0..31. If either side's
// reading of the format drifts, these stop opening.
const V2_KAT_KEY = "mdx2.AgAAAAAAAAEAAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaG3w04LEXbaqowCmQDpCI0C_rULf0sakUkJBRklonqhVA.Jw5DHJfnC5WS7jTME5MlaQIg4XEXWMyEzECOo9YLvFBBysSMLeeUwQ3fqkdvvqKNMusjzwbMFdaa3oCdIbqcrZGerqZ9nxvocqQ_NvbbMFgUtYrn_Iyhst33qEPQ9MMpZIpVoWd8orKi_wGktOR_9TtWeJV-yvU82c6WoiIka6s4qBiM_ga-E5ZMqS4fIEpKQ9Xypf8J8uW_rnT6ak9ohC3juGf8niH2rSLxAzDPwvpVBa33JOI2QpWMiYwtXHwsoMmCet5Mzz419nmkz8X7ukughq5_kR39QODjtT0Yf2qE0vQzMZkaXWxpWqrODWdKzGgvwf049KWD7HL56haAb6VQw8tZv7JHF5jRhFlTC3QygFcQKGOYophp0yDIDnK7LYN7CdpJX3jJs2qXO10UCvLhrB4wWrSrDnBqjJHopFe3qQydnkxs9KsgXlRasks6yrTutUerEN0iNPyuIVQ3H9BiCLwOBszMbwcZklscOwPY5rrDdDJHFHbmPqHE2s2typz0ITBbR9f6lV7FKjLEtbxmuYHK2FD-4MtK3aQAtKX1bPUo1QwjRiHpau_mBYR9RIMs7zNHfzQzrVU_rUKhy-FHLVzxLRArJnN6I0UtHs2IZBhKfKjXwh1q7ZnOEi7XUKOUG0iCndCSpZGIswNk9ABhjUXkGThYdgaSyQ6cDTXr4iBlh2eK6MvKk1tT3Q7w";
const V2_KAT_PASSWORD = "mdx2.AgEBAAknwAAAAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGz-cIkd-Rxl03y5FjfVMa9ItoUnaXzwCW7KkiGqu7m1U.puIsmaIXoK3AQmz0kfN8Qf2Go8iHbz5i0-cN1WjVLgovglMiRpNFjfZ6gfR4fcrAcnbbrPt5cnTYUW3d9K2xzPfB2Dcq6pCgyurTeu88V4OET15Ajucux27M1-atzxY_0tpFxwCRxwm27ZuGVXOmwL5YmolFaZre-q-GIg_s2xXJjUMopT21ams4V6BF3lcEQsDpBZ6gB5YPHxFjeh_M9v4sBwztkCFWpb_yyqjQ5MFv4zC6wfT-EUCIXs9OYoCBqeNBPdcySQ528NmEBjD2vSTHU6xPiEq0b6BSRLKS591NCME0nyG39S_la3UWeqVXy4HG0DO_R60nCYbIfWMo51UnNj7W1cEsV-XWr_PDQPxUFOfxtYd0vTYcfX6nYaW5rNHgKGkBiMmLtn6RxLAaSgpYcRqDqrrp6rBg4DhfhLWnL_JgT_ZQXhUA59xapY9C0BM4yPq4nDeaUhCut5yn9xZdU6AyTo-7Ch_bg_F0TlWaxMWxztzTcmC891RjA-Sn7WESGl7n5l_bzHDD2UxTK4YozFhyuWhKXba6vi22K-7x52yVIH7ttqqxZdakhBwfOExXzrXTftGqH-lIEkGPvVnPtdnqPNoZJhHVIwoIppg9o4YwHrX_w-N_vZg3Ba11IbvHHDDLOg602PaE0X6UsMh0Ul8gR8YvN85fxqAHMV9MFFnNQt_LybT-lkdeJShv";

test("v2 known-answer vector (link key, compressed) opens", async () => {
  const opened = await unseal(fixedKey(), V2_KAT_KEY);
  assert.equal(opened.title, "Hello");
  assert.equal(opened.content, "# Secret\n\nbody é ".repeat(20));
  assert.equal(opened.version, 2);
  assert.equal(opened.mode, "key");
  assert.equal(inspect(V2_KAT_KEY).compressed, true);
});

test("v2 known-answer vector (link key + password, 600,000 PBKDF2 rounds, uncompressed) opens", async () => {
  const info = inspect(V2_KAT_PASSWORD);
  assert.deepEqual(info, { version: 2, mode: "password", kdf: "pbkdf2", iterations: PBKDF2_ITERATIONS, compressed: false, storedLength: V2_KAT_PASSWORD.length });
  assert.equal(requiresPassword(V2_KAT_PASSWORD), true);
  const opened = await unseal(fixedKey(), V2_KAT_PASSWORD, { password: "correct horse" });
  assert.deepEqual(opened, { title: null, content: "pw doc", version: 2, mode: "password" });
  await rejectsWith(unseal(fixedKey(), V2_KAT_PASSWORD, { password: "correct hors" }), "password");
  await rejectsWith(unseal(fixedKey(), V2_KAT_PASSWORD), "password-required");
});

// ── v2 round trips ────────────────────────────────────────────────────────────

const DOC = { title: "Quarterly plan — draft", content: "# Plan\n\n" + "Ünïcödé text, emoji \u{1F512}, and lines.\n".repeat(200) };

test("v2 round trip, link key, compressed and not", async () => {
  const key = generateKey();
  for (const compress of [true, false]) {
    const env = await seal(key, DOC, { compress });
    assert.ok(env.startsWith("mdx2."));
    assert.ok(isEnvelope(env));
    const info = inspect(env);
    assert.equal(info.version, 2);
    assert.equal(info.mode, "key");
    assert.equal(info.compressed, compress);
    const opened = await unseal(key, env);
    assert.deepEqual(opened, { ...DOC, version: 2, mode: "key" });
  }
});

test("v2 round trip, link key + password, compressed and not", async () => {
  const key = generateKey();
  for (const compress of [true, false]) {
    const env = await seal(key, DOC, { password: "four random words here", compress, ...FAST });
    assert.equal(inspect(env).mode, "password");
    assert.equal(inspect(env).iterations, 100_000);
    const opened = await unseal(key, env, { password: "four random words here" });
    assert.deepEqual(opened, { ...DOC, version: 2, mode: "password" });
  }
});

test("the default password seal uses 600,000 PBKDF2 rounds", async () => {
  const env = await seal(generateKey(), { title: null, content: "x" }, { password: "pw" });
  assert.equal(inspect(env).iterations, PBKDF2_ITERATIONS);
});

test("passwords are NFC-normalised: the composed and decomposed forms are the same password", async () => {
  const key = generateKey();
  const env = await seal(key, DOC, { password: "café", ...FAST });
  const opened = await unseal(key, env, { password: "café" });
  assert.equal(opened.content, DOC.content);
});

test("title null and empty content survive", async () => {
  const key = generateKey();
  const opened = await unseal(key, await seal(key, { title: null, content: "" }));
  assert.equal(opened.title, null);
  assert.equal(opened.content, "");
});

test("fresh salt and nonce every seal", async () => {
  const key = generateKey();
  const a = await seal(key, DOC);
  const b = await seal(key, DOC);
  assert.notEqual(a, b);
  const ha = unb64u(a.split(".")[1]);
  const hb = unb64u(b.split(".")[1]);
  assert.equal(ha.length, HEADER_BYTES);
  assert.notDeepEqual(ha.slice(9, 25), hb.slice(9, 25), "salt repeated");
  assert.notDeepEqual(ha.slice(25, 37), hb.slice(25, 37), "nonce repeated");
});

test("padding: the stored size moves in 512-byte steps", async () => {
  const key = generateKey();
  const lens = new Set();
  for (const n of [1, 10, 100, 300]) {
    const env = await seal(key, { title: null, content: "a".repeat(n) }, { compress: false });
    lens.add(unb64u(env.split(".")[2]).length);
  }
  assert.deepEqual([...lens], [512 + 16]);
});

// ── Tampering and wrong secrets ───────────────────────────────────────────────

test("header tamper: a flipped iteration count fails the commitment, before any decryption", async () => {
  const key = generateKey();
  const env = await seal(key, DOC, { password: "pw-pw-pw-pw", ...FAST });
  // Byte 6 is the low byte of the big-endian iteration count (100,000 → 100,001).
  const tampered = flip(env, "header", 6);
  assert.equal(inspect(tampered).iterations, 100_001);
  // A password document can only say "password" for a commitment failure — never "tampered".
  await rejectsWith(unseal(key, tampered, { password: "pw-pw-pw-pw" }), "password");
});

test("header tamper on a link-key document fails the commitment (key), not GCM", async () => {
  const key = generateKey();
  const env = await seal(key, DOC);
  for (const i of [9, 20, 30, 40, 68]) await rejectsWith(unseal(key, flip(env, "header", i)), "key");
  // The compressed flag is covered too.
  await rejectsWith(unseal(key, flip(env, "header", 7)), "key");
});

test("unknown versions, modes and flags are 'unsupported', not 'altered'", async () => {
  const key = generateKey();
  const env = await seal(key, DOC);
  await rejectsWith(unseal(key, flip(env, "header", 7, 0x80)), "unsupported");
  await rejectsWith(unseal(key, flip(env, "header", 1, 0x04)), "unsupported");
  await rejectsWith(unseal(key, "mdx3.AAAA.BBBB"), "unsupported");
});

test("wrong password", async () => {
  const key = generateKey();
  const env = await seal(key, DOC, { password: "right one", ...FAST });
  await rejectsWith(unseal(key, env, { password: "wrong one" }), "password");
  await rejectsWith(unseal(key, env, { password: "" }), "password-required");
});

test("wrong key", async () => {
  const env = await seal(generateKey(), DOC);
  await rejectsWith(unseal(generateKey(), env), "key");
});

test("ciphertext tamper: the commitment verifies, GCM fails, so it is 'altered'", async () => {
  const key = generateKey();
  const env = await seal(key, DOC);
  await rejectsWith(unseal(key, flip(env, "cipher", 5)), "altered");
  const pw = await seal(key, DOC, { password: "pw", ...FAST });
  await rejectsWith(unseal(key, flip(pw, "cipher", 0), { password: "pw" }), "altered");
});

test("malformed envelopes", async () => {
  const key = generateKey();
  await rejectsWith(unseal(key, "mdx2.!!!.AAAA"), "malformed");
  await rejectsWith(unseal(key, "mdx2.AAAA"), "malformed");
  await rejectsWith(unseal(key, "mdx2.AAAA.AAAA"), "malformed");
  await rejectsWith(unseal(key, "plain markdown"), "malformed");
  assert.equal(inspect("plain"), null);
});

// ── Keys and links ────────────────────────────────────────────────────────────

test("re-saving a v1 document writes v2 under the same link key", async () => {
  const linkKey = importKey(V1_KEY);
  const old = await unseal(linkKey, V1_KAT);
  const resaved = await seal(linkKey, { title: old.title, content: old.content + "\n\nedited" });
  assert.ok(resaved.startsWith("mdx2."));
  const again = await unseal(importKey(V1_KEY), resaved); // the same #k= opens it
  assert.equal(again.content, "# Secret\n\nbody é\n\nedited");
  assert.equal(exportKey(linkKey), V1_KEY);
});

test("importKey refuses anything that isn't 32 bytes of base64url", () => {
  assert.throws(() => importKey("short"), (e) => e instanceof DecryptError && e.reason === "key");
  assert.throws(() => importKey("not base64!!"), (e) => e instanceof DecryptError && e.reason === "key");
  assert.equal(importKey(V1_KEY).length, 32);
});

test("pasted links: the key comes out locally, from a full link or a bare key", () => {
  assert.equal(keyFromPastedLink(`https://markdrop.in/abc#k=${V1_KEY}`), V1_KEY);
  assert.equal(keyFromPastedLink(`  markdrop.in/abc?x=1#k=${V1_KEY}  `), V1_KEY);
  assert.equal(keyFromPastedLink(V1_KEY), V1_KEY);
  assert.equal(keyFromPastedLink("https://markdrop.in/abc"), null);
  assert.equal(keyFromPastedLink("https://markdrop.in/abc#k=short"), null);
});

test("constant-time compare", () => {
  assert.equal(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
  assert.equal(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false);
  assert.equal(constantTimeEqual(new Uint8Array([1]), new Uint8Array([1, 2])), false);
});

// ── Size ──────────────────────────────────────────────────────────────────────

test("maxSealedLength is an upper bound of the real envelope", async () => {
  const key = generateKey();
  for (const content of ["", "x", "y".repeat(5000), DOC.content]) {
    const real = await seal(key, { title: "T", content }, { compress: false });
    assert.equal(real.length, maxSealedLength("T", content));
    const packed = await seal(key, { title: "T", content });
    assert.ok(packed.length <= maxSealedLength("T", content));
  }
});

test("too long to store after encryption is a TooLargeError", async () => {
  // Random-looking text doesn't compress, and base64 grows it by a third.
  const noise = Array.from({ length: 400_000 }, (_, i) => String.fromCharCode(33 + ((i * 7919) % 90))).join("");
  await assert.rejects(seal(generateKey(), { title: null, content: noise }, { compress: false }), TooLargeError);
});

test("password strength hint nudges toward length", () => {
  assert.equal(passwordStrength("").level, 0);
  assert.equal(passwordStrength("abc").level, 1);
  assert.equal(passwordStrength("Summer2024").level, 2);
  assert.equal(passwordStrength("correct horse battery staple").level, 3);
});
