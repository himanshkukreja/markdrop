/**
 * The studio Changelog's pure rules (model.ts): dates as the engine writes them, month groups,
 * filters, the API's checks as you type, and the hub shape the preview draws.
 * Runs on node's TypeScript type stripping (node ≥ 22.18); skipped without it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

let mod = null;
try {
  mod = await import("./model.ts");
} catch (e) {
  if (!/Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION|strip/i.test(String(e?.message ?? e))) throw e;
}
const t = mod ? test : test.skip;

const entry = (over) => ({
  id: "x", slug: "x", date: "2026-11-01", title: "Dark mode", kind: "new", area: "Appearance", products: [], versions: {},
  summary: "Follows your system.", highlights: [], status: "new", created_at: "2026-11-01T10:00:00Z", ...over,
});

t("dates read the way the engine writes them", () => {
  const { longDate, shortDate, monthLabel, todayIso } = mod;
  assert.equal(longDate("2026-11-01"), "November 1, 2026");
  assert.equal(shortDate("2026-03-14"), "Mar 14");
  assert.equal(monthLabel("2026-03-14"), "March 2026");
  assert.equal(longDate("soon"), "soon");
  assert.equal(todayIso(new Date(2026, 0, 5, 23, 30)), "2026-01-05");
});

t("months newest first, entries newest first inside them", () => {
  const groups = mod.monthGroups([
    entry({ id: "a", date: "2026-10-03" }),
    entry({ id: "b", date: "2026-11-01", created_at: "2026-11-01T09:00:00Z" }),
    entry({ id: "c", date: "2026-11-01", created_at: "2026-11-01T11:00:00Z" }),
    entry({ id: "d", date: "2026-10-20" }),
  ]);
  assert.deepEqual(groups.map((g) => [g.label, g.items.map((e) => e.id)]), [["November 2026", ["c", "b"]], ["October 2026", ["d", "a"]]]);
});

t("filters: words, kind, not published yet", () => {
  const es = [
    entry({ id: "a", title: "Dark mode", status: "published" }),
    entry({ id: "b", title: "Faster exports", kind: "improved", area: "Exports", status: "changed" }),
    entry({ id: "c", title: "Invite links", kind: "fixed", summary: "Last seven days.", highlights: ["Members page"], status: "new" }),
  ];
  const ids = (f) => mod.filterEntries(es, { ...mod.NO_FILTER, ...f }).map((e) => e.id);
  assert.deepEqual(ids({}), ["a", "b", "c"]);
  assert.deepEqual(ids({ q: "EXPORTS" }), ["b"]);
  assert.deepEqual(ids({ q: "members seven" }), ["c"]);
  assert.deepEqual(ids({ kind: "fixed" }), ["c"]);
  assert.deepEqual(ids({ status: "unpublished" }), ["b", "c"]);
});

t("checks match the API's", () => {
  const ok = { title: "Dark mode", summary: "Follows your system.", date: "2026-11-01", slug: "dark-mode", area: "", versions: {}, highlights: [], tryLabel: "", tryHref: "", alt: "", body: "" };
  assert.deepEqual(mod.entryProblems(ok), {});
  const bad = mod.entryProblems({
    ...ok, title: " ", summary: "x".repeat(281), date: "2026-02-30", slug: "Dark Mode", area: "a".repeat(41),
    versions: { web: "three point one" }, highlights: Array(9).fill("h"), tryHref: "javascript:alert(1)", alt: "a".repeat(201), body: "b".repeat(50_001),
  });
  assert.deepEqual(Object.keys(bad).sort(), ["alt", "area", "body", "date", "highlights", "slug", "summary", "title", "tryHref", "versions"]);
  assert.equal(mod.entryProblems({ ...ok, tryHref: "/quickstart" }).tryHref, undefined);
  assert.equal(mod.entryProblems({ ...ok, tryHref: "https://app.example.com/x" }).tryHref, undefined);
  assert.ok(mod.entryProblems({ ...ok, tryHref: "//evil.example" }).tryHref);
  assert.ok(mod.entryProblems({ ...ok, tryHref: "http://plain.example" }).tryHref);
  assert.ok(mod.entryProblems({ ...ok, date: "1999-12-31" }).date);
  assert.equal(mod.entryProblems({ ...ok, slug: "" }).slug, undefined); // the API picks one
});

t("slugs like the API's", () => {
  assert.equal(mod.slugFromTitle("Dark mode, at last!"), "dark-mode-at-last");
  assert.equal(mod.slugFromTitle("Café exports"), "cafe-exports");
  assert.equal(mod.slugFromTitle("x".repeat(80)).length, 60);
});

t("the hub shape the preview draws", () => {
  const hub = mod.toHub(
    entry({ slug: "dark-mode", products: ["web"], versions: { web: "2.4", ios: "" }, docs: ["p1", "gone"], try: { label: "", href: "/settings" }, body: "Details" }),
    [{ id: "web", label: "Web app" }],
    [{ id: "p1", path: "/appearance", title: "Appearance" }],
  );
  assert.equal(hub.id, "dark-mode");
  assert.equal(hub.dateLabel, "November 1, 2026");
  assert.equal(hub.monthKey, "2026-11");
  assert.deepEqual(hub.products, [{ id: "web", label: "Web app" }]);
  assert.deepEqual(hub.versions, [{ product: "web", label: "Web app", version: "2.4" }]);
  assert.deepEqual(hub.docs, [{ path: "/appearance", title: "Appearance" }]);
  assert.deepEqual(hub.try, { label: "Try it", href: "/settings" });
  assert.equal(hub.hasBody, true);
  assert.deepEqual(mod.knownAreas([{ area: "B" }, { area: "A" }, { area: "B" }]), ["B", "A"]);
});

t("sample entries for the empty state are fictional and dated back from today", () => {
  const s = mod.sampleEntries("2026-11-01");
  assert.deepEqual(s.map((e) => e.date), ["2026-11-01", "2026-10-23", "2026-09-25"]);
  assert.deepEqual(s.map((e) => e.kind), ["new", "improved", "fixed"]);
});
