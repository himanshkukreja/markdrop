/** lib/backlog.mjs: reading a backlog page's list and the filter bar's model. */
import test from "node:test";
import assert from "node:assert/strict";
import { categoryCounts, choices, filterFromQuery, hideCss, isActive, parseBacklog, queryWithFilter, splitMeta, toCsv, toText, EMPTY_FILTER } from "./backlog.mjs";

const PAGE = `Intro the team wrote.

## The team's backlog

:::details{summary="Feature request · 2 open" heading="3" open="1"}
- [ ] Export reports to CSV — In progress · Acme · :person[Ada Lovelace]{id="u1"} · from [Acme renewal · Nov 3](/acme-call#b-t0001) · 2 calls · first seen Nov 3 {#b-aaa}
- [ ] SSO with Okta — Globex · from [Globex intro · Nov 4](/globex#b-1) · first seen Nov 4 {#b-bbb}
:::

:::details{summary="Bug · 0 open" heading="3" open="1"}
- [x] Login fails on Safari — Acme · from [Acme renewal · Nov 3](/acme-call) · first seen Nov 3 {#b-ccc}
:::

:::details{summary="Improvement · 0 open" heading="3"}
_Nothing here yet._
:::

*Markdrop keeps this list up to date from the team's calls. Tick an item, edit it, move it under another heading or delete it, and the backlog follows. Write your own notes above or below it.*

- [ ] A task of our own, outside the list {#b-zzz}
`;

test("reads the items, their category, status and meta", () => {
  const { items, present } = parseBacklog(PAGE);
  assert.equal(present, true);
  assert.deepEqual(items.map((i) => [i.block, i.category, i.status]), [["b-aaa", "feature", "in_progress"], ["b-bbb", "feature", "open"], ["b-ccc", "bug", "done"]]);
  const [csv] = items;
  assert.equal(csv.text, "Export reports to CSV");
  assert.equal(csv.company, "Acme");
  assert.deepEqual(csv.owner, { id: "u1", name: "Ada Lovelace" });
  assert.deepEqual(csv.from, { title: "Acme renewal · Nov 3", href: "/acme-call#b-t0001" });
  assert.equal(csv.calls, 2);
  assert.equal(csv.firstSeen, "Nov 3");
  assert.equal(parseBacklog("no list here").present, false);
});

test("splits meta on dots outside links", () => {
  assert.deepEqual(splitMeta("Acme · from [A · B](/x) · 2 calls"), ["Acme", "from [A · B](/x)", "2 calls"]);
});

test("a status typed on the line counts", () => {
  const { items } = parseBacklog(PAGE.replace("SSO with Okta —", "SSO with Okta · In progress —"));
  assert.equal(items[1].status, "in_progress");
  assert.equal(items[1].text, "SSO with Okta");
});

test("the filter round-trips through the URL and keeps other keys", () => {
  const f = { ...EMPTY_FILTER, category: "bug", status: "open", company: "Acme", owner: "u1", search: "csv ", hideDone: true };
  const q = queryWithFilter("?edit=1", f);
  assert.equal(q, "?edit=1&category=bug&status=open&company=Acme&owner=u1&search=csv&hide_done=1");
  assert.deepEqual(filterFromQuery(q), { ...f, search: "csv" });
  assert.equal(queryWithFilter(q, EMPTY_FILTER), "?edit=1");
  assert.equal(filterFromQuery("?category=nope").category, "");
});

test("hides what doesn't match, and a category left empty", () => {
  const { items } = parseBacklog(PAGE);
  assert.equal(hideCss(items, EMPTY_FILTER), "");
  const css = hideCss(items, { ...EMPTY_FILTER, company: "Acme" });
  assert.match(css, /li\[data-bid="b-bbb"\], li:has\(> p\[data-bid="b-bbb"\]\)/);
  assert.doesNotMatch(css, /b-aaa"\]\)? \{/);
  const hideDone = hideCss(items, { ...EMPTY_FILTER, hideDone: true });
  assert.match(hideDone, /details:has\(li\[data-bid="b-ccc"\]\)/);   // Bug: all done
  assert.doesNotMatch(hideDone, /details:has\(li\[data-bid="b-aaa"\]\)/);
  assert.equal(isActive({ ...EMPTY_FILTER, search: "  " }), false);
});

test("counts per category follow the rest of the filter", () => {
  const { items } = parseBacklog(PAGE);
  assert.deepEqual(categoryCounts(items, { ...EMPTY_FILTER, category: "bug" }), { feature: 2, bug: 1, improvement: 0, task: 0, follow_up: 0, question: 0 });
  assert.deepEqual(categoryCounts(items, { ...EMPTY_FILTER, hideDone: true }).bug, 0);
  assert.deepEqual(choices(items), { companies: ["Acme", "Globex"], owners: [{ id: "u1", name: "Ada Lovelace" }] });
});

test("exports CSV and text", () => {
  const { items } = parseBacklog(PAGE);
  const csv = toCsv(items, "https://markdrop.in");
  assert.equal(csv.split("\n")[0], "Category,Status,Item,Company,Owner,Calls,First seen,Source");
  assert.equal(csv.split("\n")[1], "Feature request,In progress,Export reports to CSV,Acme,Ada Lovelace,2,Nov 3,https://markdrop.in/acme-call#b-t0001");
  assert.match(toText(items), /^Feature request \(2\)\n- \[ \] Export reports to CSV \(In progress, Acme, @Ada Lovelace\)/);
});
