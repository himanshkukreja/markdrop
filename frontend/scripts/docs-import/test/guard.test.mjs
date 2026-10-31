/**
 * The importers' network guard (lib/guard.mjs) and the fetcher over it (lib/fetch.mjs). DNS and the
 * connection are stand-ins: nothing here reaches a network.
 *   npm run docs:test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GuardError, blockedAddress, checkUrl, pinnedLookup, resolvePublic, safeGet, sniffExt } from "../lib/guard.mjs";
import { createFetcher } from "../lib/fetch.mjs";

/** A resolver from a table: host → [addresses]. */
const dnsOf = (table) => async (host) => {
  if (!(host in table)) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  return table[host].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

/** A transport from a table: url → { status, headers, body }; records each call. */
function transportOf(table) {
  const calls = [];
  const fn = async (url, { pin }) => {
    calls.push({ url: url.href, pin });
    const r = table[url.href];
    if (!r) return { status: 404, headers: {}, body: Buffer.from("missing") };
    return { status: r.status ?? 200, headers: r.headers ?? { "content-type": "text/plain" }, body: Buffer.from(r.body ?? "") };
  };
  fn.calls = calls;
  return fn;
}

const PUBLIC_DNS = { "docs.acme.test": ["93.184.216.34"], "files.gitbook.io": ["34.120.1.2"], "cdn.acme.test": ["2606:4700::6810:1"] };

test("private, reserved and special addresses are blocked in every spelling", () => {
  const blocked = [
    "127.0.0.1", "127.255.255.254", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "100.100.100.200", "0.0.0.0", "0.1.2.3", "192.0.0.192", "198.18.0.1", "224.0.0.1", "239.1.1.1", "240.0.0.1",
    "255.255.255.255", "::", "::1", "fe80::1", "fe80::1%en0", "febf::1", "fc00::1", "fd00:ec2::254", "ff02::1", "::ffff:127.0.0.1",
    "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:0:10.0.0.1", "::127.0.0.1", "64:ff9b::7f00:1",
    "64:ff9b::a9fe:a9fe", "2002:7f00:1::1", "2002:a00:1::", "2001::1", "2001:db8::1", "not-an-ip", "", undefined,
  ];
  for (const a of blocked) assert.equal(blockedAddress(a), true, String(a));
  const open = ["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "1.1.1.1", "2606:4700::6810:1", "2a00:1450:4001::200e",
    "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"];
  for (const a of open) assert.equal(blockedAddress(a), false, a);
});

test("only https names on the default port, without credentials; IP literals in any form are refused", () => {
  assert.equal(checkUrl("https://docs.acme.test/a?b=1#c").href, "https://docs.acme.test/a?b=1");
  const bad = [
    "http://docs.acme.test/", "ftp://docs.acme.test/", "file:///etc/passwd", "https://docs.acme.test:8443/", "https://u:p@docs.acme.test/",
    "https://127.0.0.1/", "https://0x7f.0.0.1/", "https://0x7f000001/", "https://2130706433/", "https://127.1/", "https://0177.0.0.1/",
    "https://[::1]/", "https://[::ffff:127.0.0.1]/", "https://[fd00:ec2::254]/", "https://localhost/", "https://a.localhost/", "not a url",
  ];
  for (const u of bad) assert.throws(() => checkUrl(u), GuardError, u);
  const onSite = (u) => u.origin === "https://docs.acme.test";
  assert.throws(() => checkUrl("https://elsewhere.test/page.md", onSite), /isn't one of the hosts/);
  assert.equal(checkUrl("https://docs.acme.test/page.md", onSite).pathname, "/page.md");
});

test("a name is used only when every address it has is public", async () => {
  const resolve = dnsOf({ ...PUBLIC_DNS, "127.0.0.1.nip.io": ["127.0.0.1"], "mixed.test": ["93.184.216.34", "10.0.0.5"], "v6.test": ["::ffff:169.254.169.254"] });
  assert.deepEqual(await resolvePublic("docs.acme.test", resolve), { address: "93.184.216.34", family: 4 });
  await assert.rejects(resolvePublic("127.0.0.1.nip.io", resolve), /private or reserved address \(127\.0\.0\.1\)/);
  await assert.rejects(resolvePublic("mixed.test", resolve), /10\.0\.0\.5/);
  await assert.rejects(resolvePublic("v6.test", resolve), GuardError);
  await assert.rejects(resolvePublic("nowhere.test", resolve), /doesn't resolve/);
});

test("the connection is pinned to the checked address (a second DNS answer can't move it)", async () => {
  const lookup = pinnedLookup({ address: "93.184.216.34", family: 4 });
  const one = await new Promise((r) => lookup("docs.acme.test", {}, (err, address, family) => r({ err, address, family })));
  assert.deepEqual(one, { err: null, address: "93.184.216.34", family: 4 });
  const all = await new Promise((r) => lookup("docs.acme.test", { all: true }, (err, list) => r(list)));
  assert.deepEqual(all, [{ address: "93.184.216.34", family: 4 }]);
  const noOpts = await new Promise((r) => lookup("other.test", (err, address) => r(address)));
  assert.equal(noOpts, "93.184.216.34");
  // Rebinding: the first answer is public, every later one private. One lookup per hop, and the
  // transport connects to that answer.
  let n = 0;
  const rebinding = async () => [{ address: n++ === 0 ? "93.184.216.34" : "127.0.0.1", family: 4 }];
  const transport = transportOf({ "https://docs.acme.test/llms.txt": { body: "ok" } });
  const res = await safeGet("https://docs.acme.test/llms.txt", { resolve: rebinding, transport });
  assert.equal(res.body.toString(), "ok");
  assert.deepEqual(transport.calls.map((c) => c.pin.address), ["93.184.216.34"]);
  assert.equal(n, 1);
});

test("redirects are followed by hand, each hop checked: private addresses, http, other hosts, too many", async () => {
  const resolve = dnsOf({ ...PUBLIC_DNS, "rebind.test": ["10.0.0.7"] });
  const onSite = (u) => u.origin === "https://docs.acme.test";
  const go = (to, opts = {}) =>
    safeGet("https://docs.acme.test/a", { resolve, allow: onSite, ...opts, transport: transportOf({ "https://docs.acme.test/a": { status: 302, headers: { location: to } }, "https://docs.acme.test/b": { body: "B" } }) });
  for (const to of ["https://127.0.0.1/", "https://169.254.169.254/latest/meta-data/", "https://[::ffff:7f00:1]/", "https://0x7f.1/", "http://docs.acme.test/b", "https://docs.acme.test:444/b", "https://elsewhere.test/b"])
    await assert.rejects(go(to), GuardError, to);
  // A name that resolves to a private address, with no origin policy at all.
  await assert.rejects(go("https://rebind.test/x", { allow: undefined }), /private or reserved/);
  // A relative redirect on the site: followed, and the final URL reported.
  const ok = await go("/b");
  assert.equal(ok.url, "https://docs.acme.test/b");
  assert.equal(ok.body.toString(), "B");
  // A loop: at most 5 hops.
  const loop = transportOf({ "https://docs.acme.test/a": { status: 301, headers: { location: "/a" } } });
  await assert.rejects(safeGet("https://docs.acme.test/a", { resolve, transport: loop }), /more than 5 redirects/);
  assert.equal(loop.calls.length, 6);
});

test("the fetcher: refused addresses fail at once, without a request, a retry or the cache", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
  const transport = transportOf({
    "https://docs.acme.test/llms.txt": { body: "- [A](https://docs.acme.test/a.md)" },
    "https://docs.acme.test/a.md": { body: "# A" },
    "https://docs.acme.test/moved": { status: 308, headers: { location: "https://metadata.test/" } },
    "https://files.gitbook.io/x.png": { body: "png" },
  });
  const resolve = dnsOf({ ...PUBLIC_DNS, "metadata.test": ["169.254.169.254"], "evil.test": ["93.184.216.35"] });
  const onSite = (u) => u.origin === "https://docs.acme.test";
  const http = createFetcher({ cacheDir: dir, minIntervalMs: 0, allow: onSite, resolve, transport });
  assert.equal((await http.text("https://docs.acme.test/llms.txt")).text.startsWith("- [A]"), true);
  // A page URL off the import's origin (say, from its llms.txt): refused.
  for (const u of ["https://evil.test/a.md", "http://docs.acme.test/a.md", "https://10.0.0.1/a.md", "https://docs.acme.test.evil.test/x"]) {
    const r = await http.get(u);
    assert.equal(r.ok, false, u);
    assert.equal(r.status, 0, u);
    assert.ok(r.error, u);
  }
  // A redirect off the site: refused by the origin policy; with any host allowed, by the address
  // check (a metadata address). Neither is retried.
  const before = transport.calls.length;
  assert.match((await http.get("https://docs.acme.test/moved")).error, /isn't one of the hosts/);
  const moved = await http.get("https://docs.acme.test/moved", { allow: () => true });
  assert.match(moved.error, /private or reserved address \(169\.254\.169\.254\)/);
  assert.equal(transport.calls.length, before + 2);
  // Images and files may come from GitBook's file hosts when the caller says so.
  assert.equal((await http.get("https://files.gitbook.io/x.png")).ok, false);
  assert.equal((await http.get("https://files.gitbook.io/x.png", { allow: (u) => onSite(u) || u.hostname === "files.gitbook.io" })).ok, true);
  // A cached answer obeys the same rules as a fetch.
  const strict = createFetcher({ cacheDir: dir, minIntervalMs: 0, allow: (u) => u.hostname === "elsewhere.test", resolve, transport });
  assert.equal((await strict.get("https://docs.acme.test/llms.txt")).ok, false);
  assert.equal(http.stats.refused >= 5, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("files an import keeps are named by their bytes", () => {
  const b = (s, pad = 16) => Buffer.concat([Buffer.from(s, "latin1"), Buffer.alloc(pad)]);
  assert.equal(sniffExt(b("\x89PNG\r\n\x1a\n")), "png");
  assert.equal(sniffExt(b("\xff\xd8\xff\xe0")), "jpg");
  assert.equal(sniffExt(b("GIF89a")), "gif");
  assert.equal(sniffExt(b("RIFF\0\0\0\0WEBPVP8 ")), "webp");
  assert.equal(sniffExt(b("\0\0\0\x1cftypavif")), "avif");
  assert.equal(sniffExt(b("\0\0\0\x18ftypisom")), "mp4");
  assert.equal(sniffExt(b("\x1a\x45\xdf\xa3")), "webm");
  assert.equal(sniffExt(b("%PDF-1.7")), "pdf");
  assert.equal(sniffExt(b("\0\0\x01\0\x01\0")), "ico");
  for (const s of ["<!doctype html><script>alert(1)</script>", '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', '<?xml version="1.0"?><x/>', "alert(1)//", "PK\x03\x04zip"])
    assert.equal(sniffExt(b(s)), null, s);
  assert.equal(sniffExt(Buffer.alloc(0)), null);
});
