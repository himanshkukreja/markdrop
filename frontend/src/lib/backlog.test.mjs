/** lib/backlog.mjs: reading a backlog page's list and the filter bar's model. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  categoryCounts, choices, dateRange, filterFromQuery, groupItems, hideCss, isActive, matches, parseBacklog, parseDay, priorityCounts,
  queryWithFilter, splitMeta, toCsv, toText, EMPTY_FILTER,
} from "./backlog.mjs";

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
  assert.equal(csv.split("\n")[0], "Category,Priority,Status,Item,Company,Owner,Calls,First seen,Last mentioned,Source");
  assert.match(csv.split("\n")[1], /^Feature request,Medium,In progress,Export reports to CSV,Acme,Ada Lovelace,2,\d{4}-11-03,\d{4}-11-03,https:\/\/markdrop.in\/acme-call#b-t0001$/);
  assert.match(toText(items), /^Feature request \(2\)\n- \[ \] Export reports to CSV \(In progress, Acme, @Ada Lovelace\)/);
});

const TODAY = new Date(2026, 10, 26);   // Nov 26, 2026
const PRIO = `## The team's backlog

::::details{summary="Feature request · 3 open" heading="3" open="1"}
- [ ] SSO via Okta — **Urgent** · Globex · from [Globex call · Nov 24](/g#b-1) · 3 calls · first seen Jun 2 {#b-sso}
- [ ] Export to CSV — In progress · **High** · Acme · :person[Ada]{id="u1"} · from [Acme · Nov 3](/a) · first seen Nov 3 {#b-csv}
- [ ] Dark mode · Low — from [Standup · Jul 9](/s) · first seen Jul 9 {#b-dark}
:::details{summary="Done · 1"}
- [x] Bulk invite — Acme · from [Acme · Nov 20](/a) · first seen Nov 20 {#b-inv}
:::
::::

:::details{summary="Bug · 1 open" heading="3" open="1"}
- [ ] Login fails — Acme · from [Acme · Nov 21](/a) · first seen Nov 21 {#b-login}
:::

*Markdrop keeps this list up to date from the team's calls.*
`;

test("priorities and dates on the line; a category's Done group keeps its category", () => {
  const { items } = parseBacklog(PRIO, TODAY);
  assert.deepEqual(items.map((i) => [i.block, i.category, i.priority, i.status]), [
    ["b-sso", "feature", "urgent", "open"], ["b-csv", "feature", "high", "in_progress"], ["b-dark", "feature", "low", "open"],
    ["b-inv", "feature", "medium", "done"], ["b-login", "bug", "medium", "open"]]);
  assert.equal(items[2].text, "Dark mode");
  assert.deepEqual([items[0].firstDate, items[0].lastDate], ["2026-06-02", "2026-11-24"]);
  assert.equal(parseDay("Dec 30", new Date(2027, 0, 3)), "2026-12-30");
});

test("priority (any of) and date filters, on first seen or last mentioned; counts follow", () => {
  const { items } = parseBacklog(PRIO, TODAY);
  const ids = (f) => items.filter((i) => matches(i, f, null, TODAY)).map((i) => i.block);
  assert.deepEqual(ids({ ...EMPTY_FILTER, priority: ["urgent", "high"] }), ["b-sso", "b-csv"]);
  assert.deepEqual(ids({ ...EMPTY_FILTER, since: "7d" }), ["b-inv", "b-login"]);
  assert.deepEqual(ids({ ...EMPTY_FILTER, since: "7d", dateBy: "last" }), ["b-sso", "b-inv", "b-login"]);
  assert.deepEqual(ids({ ...EMPTY_FILTER, since: "custom", from: "2026-06-01", to: "2026-07-31" }), ["b-sso", "b-dark"]);
  assert.deepEqual(dateRange({ ...EMPTY_FILTER, since: "month" }, TODAY), ["2026-11-01", null]);
  assert.deepEqual(ids({ ...EMPTY_FILTER, items: ["b-csv", "b-login"] }), ["b-csv", "b-login"]);
  assert.deepEqual(priorityCounts(items, { ...EMPTY_FILTER, category: "feature" }), { urgent: 1, high: 1, medium: 1, low: 1 });
  assert.equal(isActive({ ...EMPTY_FILTER, group: "priority" }), false);   // grouping isn't filtering
});

test("the new filter keys round-trip through the URL", () => {
  const f = { ...EMPTY_FILTER, priority: ["urgent", "low"], since: "custom", from: "2026-11-01", to: "2026-11-15", dateBy: "last",
    group: "month", items: ["b-1", "b-2"] };
  const q = queryWithFilter("", f);
  assert.equal(q, "?priority=urgent%2Clow&since=custom&from=2026-11-01&to=2026-11-15&date_by=last&group=month&items=b-1%2Cb-2");
  assert.deepEqual(filterFromQuery(q), f);
  assert.deepEqual(filterFromQuery("?priority=nope,high&group=x&since=1y").priority, ["high"]);
  assert.equal(filterFromQuery("?group=x").group, "category");
  assert.equal(filterFromQuery("?since=1y").since, "");
});

test("group by priority, month, company, owner", () => {
  const { items } = parseBacklog(PRIO, TODAY);
  const g = (by, dateBy) => groupItems(items, by, dateBy).map((x) => [x.label, x.items.map((i) => i.block)]);
  assert.deepEqual(g("priority"), [["Urgent", ["b-sso"]], ["High", ["b-csv"]], ["Medium", ["b-login", "b-inv"]], ["Low", ["b-dark"]]]);
  assert.deepEqual(g("month").map((x) => x[0]), ["Nov 2026", "Jul 2026", "Jun 2026"]);
  assert.deepEqual(g("company").map((x) => x[0]), ["Acme", "Globex", "No company"]);
  assert.deepEqual(g("owner"), [["Ada", ["b-csv"]], ["No owner", ["b-sso", "b-login", "b-dark", "b-inv"]]]);
});

test("Hide done hides a category's Done group, not the category", () => {
  const { items } = parseBacklog(PRIO, TODAY);
  const css = hideCss(items, { ...EMPTY_FILTER, hideDone: true });
  assert.match(css, /details:has\(li\[data-bid="b-inv"\]\):not\(:has\(details li\[data-bid="b-inv"\]\)\)/);
  assert.doesNotMatch(css, /details:has\(li\[data-bid="b-sso"\]\)/);
});
