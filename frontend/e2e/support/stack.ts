/**
 * The local stack the smoke suite talks to, and the data it creates there.
 *
 * Every test makes its own documents through the sandbox API (anonymous, password, private,
 * encrypted). Users can't be created through the API locally (email OTP returns 503 without
 * Resend), so tests that need a signed-in user read them from a seeded fixtures file
 * (`E2E_FIXTURES`) and mint fresh access tokens with the sandbox secret.
 *
 * Node crypto only: no dependency beyond @playwright/test.
 */
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export const BASE_URL = (process.env.E2E_BASE_URL || "http://localhost:3150").replace(/\/$/, "");
export const API_URL = (process.env.E2E_API_URL || "http://127.0.0.1:8091").replace(/\/$/, "");
export const AUTH_SECRET = process.env.E2E_AUTH_SECRET || "sandbox-auth-secret-not-for-production";
export const ONLINE = process.env.E2E_ONLINE === "1";
/** Production, for the read-only SAMPLE_SLUGS check only. */
export const PROD_URL = (process.env.E2E_PROD_URL || "https://markdrop.in").replace(/\/$/, "");

// Never write to production. Every create below goes to API_URL, so refuse to start if it (or the
// app, which would read production data) points anywhere but a local host.
for (const [name, url] of [["E2E_BASE_URL", BASE_URL], ["E2E_API_URL", API_URL]] as const) {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`${name}=${url}: the smoke suite only runs against a local stack (REVAMP_BUILD §8.2).`);
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

export interface FixtureUser {
  id: string;
  email: string;
}
interface Fixtures {
  users?: Record<string, FixtureUser & { token?: string }>;
  admin?: { username: string; password: string };
}

function loadFixtures(): Fixtures | null {
  const file = process.env.E2E_FIXTURES;
  if (!file || !existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as Fixtures;
}
const fixtures = loadFixtures();

/** Two distinct seeded users (owner + someone else), or null when no fixtures were given. */
export function fixtureUsers(): { owner: FixtureUser; other: FixtureUser } | null {
  const u = fixtures?.users;
  if (!u?.owner || !u?.other) return null;
  return { owner: { id: u.owner.id, email: u.owner.email }, other: { id: u.other.id, email: u.other.email } };
}

export function adminCredentials(): { username: string; password: string } | null {
  if (process.env.E2E_ADMIN_USER && process.env.E2E_ADMIN_PASSWORD) {
    return { username: process.env.E2E_ADMIN_USER, password: process.env.E2E_ADMIN_PASSWORD };
  }
  return fixtures?.admin ?? null;
}

// ── Tokens ────────────────────────────────────────────────────────────────────

const b64url = (v: Buffer | string) => Buffer.from(v).toString("base64url");

/** An HS256 access token exactly like `app.utils.auth.create_access_token`. */
export function mintAccessToken(user: FixtureUser, ttlSeconds = 2 * 3600): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ sub: user.id, email: user.email, typ: "access", exp: Math.floor(Date.now() / 1000) + ttlSeconds })
  );
  const sig = createHmac("sha256", AUTH_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

// ── Sealing (mirrors frontend/src/lib/e2e.ts) ─────────────────────────────────

/**
 * AES-GCM-256 with a fresh 12-byte IV; envelope `mdx1.<b64url iv>.<b64url ciphertext‖tag>` of the
 * JSON `{t, c}`. WebCrypto appends the 16-byte tag to the ciphertext, so node's tag goes on the end.
 */
export function seal(title: string | null, content: string): { envelope: string; key: string } {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify({ t: title ?? null, c: content }), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { envelope: `mdx1.${b64url(iv)}.${b64url(ct)}`, key: b64url(key) };
}

// ── API ───────────────────────────────────────────────────────────────────────

export interface CreatedDoc {
  slug: string;
  url: string;
  edit_secret: string;
  title: string | null;
  content: string;
}

export function uniq(prefix = "e2e"): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export async function createDoc(
  body: {
    title?: string | null;
    content: string;
    encrypted?: boolean;
    read_password?: string;
    access_level?: "link" | "private";
  },
  token?: string
): Promise<CreatedDoc> {
  const res = await fetch(`${API_URL}/api/v1/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({
      title: body.title ?? null,
      content: body.content,
      encrypted: body.encrypted ?? false,
      read_password: body.read_password ?? null,
      access_level: body.access_level ?? "link",
      expires_in: "never",
    }),
  });
  if (!res.ok) throw new Error(`create document: ${res.status} ${await res.text()}`);
  return (await res.json()) as CreatedDoc;
}

/** An encrypted document sealed the way the browser seals it. Returns the key for `#k=`. */
export async function createEncryptedDoc(title: string, content: string): Promise<CreatedDoc & { key: string }> {
  const { envelope, key } = seal(title, content);
  const doc = await createDoc({ title: null, content: envelope, encrypted: true });
  return { ...doc, key };
}

/** Raw API read, as an anonymous reader unless headers say otherwise. */
export async function readDoc(slug: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetch(`${API_URL}/api/v1/documents/${slug}`, { headers });
  const body = res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  return { status: res.status, body };
}

export async function adminToken(): Promise<string | null> {
  const creds = adminCredentials();
  if (!creds) return null;
  const res = await fetch(`${API_URL}/api/v1/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
  if (!res.ok) throw new Error(`admin login: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

/** A long-ish markdown body with enough headings for Contents/TocTicks (3+ h2). */
export function longMarkdown(marker: string): string {
  const para = "Token buckets let bursts through while keeping the long-run rate fixed. ".repeat(12);
  return [
    `# ${marker}`,
    "",
    `Intro paragraph with **bold**, \`inline code\` and a [jump to the third section](#third-section).`,
    "",
    "## First section",
    "",
    para,
    "",
    "| Column | Value |",
    "| --- | --- |",
    "| alpha | 1 |",
    "",
    "## Second section",
    "",
    para,
    "",
    "- [x] done item",
    "- [ ] open item",
    "",
    "## Third section",
    "",
    para,
    "",
    "### A deeper heading",
    "",
    para,
    "",
    "## Fourth section",
    "",
    para,
  ].join("\n");
}
