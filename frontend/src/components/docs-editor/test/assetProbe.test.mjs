/** Dark-version lookups: once per address, a few at a time (core/assetProbe.mjs). */
import test from "node:test";
import assert from "node:assert/strict";
import { createProbe } from "../core/assetProbe.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test("an address is asked about once, and later calls share the answer", async () => {
  const asked = [];
  const p = createProbe(async (url) => { asked.push(url); return url.endsWith("yes.dark.png"); });
  const [a, b, c] = await Promise.all([p.probe("/x/yes.dark.png"), p.probe("/x/yes.dark.png"), p.probe("/x/no.dark.png")]);
  assert.deepEqual([a, b, c], [true, true, false]);
  assert.equal(await p.probe("/x/no.dark.png"), false);
  assert.deepEqual(asked, ["/x/yes.dark.png", "/x/no.dark.png"]);
});

test("at most `concurrency` loads run at once; the rest wait their turn", async () => {
  const waits = new Map();
  let live = 0, peak = 0;
  const p = createProbe((url) => {
    live++; peak = Math.max(peak, live);
    const d = deferred();
    waits.set(url, d);
    return d.promise.then((v) => { live--; return v; });
  }, { concurrency: 2 });
  const urls = Array.from({ length: 12 }, (_, i) => `/img/${i}.dark.png`);
  const all = Promise.all(urls.map((u) => p.probe(u)));
  for (let i = 0; i < urls.length; i++) {
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(live <= 2, `live ${live}`);
    waits.get(urls[i]).resolve(i % 3 === 0);
  }
  const res = await all;
  assert.equal(peak, 2);
  assert.deepEqual(res, urls.map((_, i) => i % 3 === 0));
  assert.equal(p.pending, 0);
});

test("a loader that throws counts as no dark version and doesn't stall the queue", async () => {
  const p = createProbe(async (url) => { if (url.includes("boom")) throw new Error("x"); return true; }, { concurrency: 1 });
  assert.deepEqual(await Promise.all([p.probe("/boom.dark.png"), p.probe("/ok.dark.png")]), [false, true]);
});

test("set() records what an upload just made, without asking", async () => {
  let asked = 0;
  const p = createProbe(async () => { asked++; return false; });
  assert.equal(await p.probe("/a.dark.png"), false);
  p.set("/a.dark.png", true);
  assert.equal(await p.probe("/a.dark.png"), true);
  assert.equal(asked, 1);
});
