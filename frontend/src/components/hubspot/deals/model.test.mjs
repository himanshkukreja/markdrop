/** components/hubspot/deals/model.mjs: the Deals board / list model (nav redesign, owner 2026-11-18). */
import test from "node:test";
import assert from "node:assert/strict";
import {
  callsLabel, columnsOf, filterRows, minutes, pipelinesOf, rowsOf, signalOf, sortRows, stagesOf, summaryOf, visibleCount,
} from "./model.mjs";

const stage = (label, closed = false, pipeline = "Sales") => ({ id: label.toLowerCase(), label, pipeline, pipeline_id: pipeline, closed });
const deal = (name, stageLabel, extra = {}) => ({
  id: name, name, company: { id: name, name: `${name} Inc` }, stage: stageLabel, stage_id: stageLabel, pipeline: "Sales", closed: false,
  closed_label: null, amount: 1000, currency: "USD", owner: "Ana", calls: 1, days_quiet: 2, quiet: false, last_call: null, ...extra,
});
const board = (team, deals, stages = [stage("Discovery"), stage("Demo"), stage("Proposal"), stage("Won", true), stage("Lost", true)]) => ({
  team: { id: team, name: team, slug: team }, stages, pipelines: [{ id: "Sales", label: "Sales" }], deals, can_sync: false,
  sync: { at: null, state: "idle", last_error: null, deals: deals.length, next_at: null }, missing_scopes: [],
});

test("rows carry their workspace and team; stages merge by label across teams", () => {
  const entries = [
    { ws: "w1", wsName: "Acme", board: board("Sales", [deal("a", "Discovery")]) },
    { ws: "w2", wsName: "Beta", board: board("Revenue", [deal("b", "Demo")], [stage("Discovery"), stage("Demo"), stage("Pilot")]) },
  ];
  const rows = rowsOf(entries);
  assert.deepEqual(rows.map((r) => [r.id, r.ws, r.team]), [["a", "w1", "Sales"], ["b", "w2", "Revenue"]]);
  assert.deepEqual(stagesOf(entries).map((s) => s.label), ["Discovery", "Demo", "Proposal", "Won", "Lost", "Pilot"]);
  assert.deepEqual(pipelinesOf(entries), ["Sales"]);
  assert.deepEqual(filterRows(rows, { team: "w2" }).map((r) => r.id), ["b"]);
});

test("columns: every open stage (empty ones too), other stages, then Closed won / lost only with Show closed", () => {
  const rows = rowsOf([{ ws: "w", board: board("Sales", [
    deal("big", "Discovery", { amount: 9000 }), deal("small", "Discovery", { amount: 10 }), deal("odd", "Legacy"),
    deal("won", "Won", { closed: true, closed_label: "Closed won" }), deal("lost", "Lost", { closed: true, closed_label: "Closed lost" }),
  ]) }]);
  const stages = stagesOf([{ ws: "w", board: board("Sales", []) }]);
  const cols = columnsOf(stages, filterRows(rows, {}), false);
  assert.deepEqual(cols.map((c) => [c.label, c.deals.map((d) => d.id)]),
    [["Discovery", ["big", "small"]], ["Demo", []], ["Proposal", []], ["Other stages", ["odd"]]]);
  const all = columnsOf(stages, filterRows(rows, { closed: true }), true);
  assert.deepEqual(all.slice(-2).map((c) => [c.label, c.closed, c.deals.map((d) => d.id)]),
    [["Closed won", true, ["won"]], ["Closed lost", true, ["lost"]]]);
});

test("a column shows up to 5 cards, never hides just one", () => {
  assert.equal(visibleCount(3), 3);
  assert.equal(visibleCount(5), 5);
  assert.equal(visibleCount(6), 4);
  assert.equal(visibleCount(12), 4);
  assert.equal(visibleCount(12, true), 12);
});

test("a card says 'No calls yet' once, 'Quiet N days' only when it has calls", () => {
  assert.deepEqual(signalOf({ closed: false, calls: 0, days_quiet: null }), { kind: "none", label: "No calls yet" });
  assert.equal(callsLabel(0), null);                        // so no second "No calls" line
  assert.deepEqual(signalOf({ closed: false, calls: 2, days_quiet: 21 }), { kind: "quiet", label: "Quiet 21 days" });
  assert.equal(signalOf({ closed: false, calls: 2, days_quiet: 3 }), null);
  assert.equal(signalOf({ closed: true, calls: 0, days_quiet: null }), null);
  assert.equal(callsLabel(1), "1 call");
  assert.equal(callsLabel(4), "4 calls");
});

test("filters: owner, company, no call in 14 days, closed hidden by default", () => {
  const rows = rowsOf([{ ws: "w", board: board("Sales", [
    deal("a", "Demo", { owner: "Ana", quiet: true, calls: 0 }), deal("b", "Demo", { owner: "Bo" }),
    deal("c", "Won", { closed: true, closed_label: "Closed won", quiet: false }),
  ]) }]);
  assert.deepEqual(filterRows(rows, {}).map((r) => r.id), ["a", "b"]);
  assert.deepEqual(filterRows(rows, { closed: true }).map((r) => r.id), ["a", "b", "c"]);
  assert.deepEqual(filterRows(rows, { owner: "Bo" }).map((r) => r.id), ["b"]);
  assert.deepEqual(filterRows(rows, { company: "a Inc" }).map((r) => r.id), ["a"]);
  assert.deepEqual(filterRows(rows, { quiet: true, closed: true }).map((r) => r.id), ["a"]);
});

test("list sort: any column, both ways, empty values last", () => {
  const rows = rowsOf([{ ws: "w", board: board("Sales", [
    deal("m", "Demo", { amount: 50, close_date: "2026-12-01", owner: null }), deal("z", "Demo", { amount: null, close_date: "2026-11-20" }),
    deal("a", "Demo", { amount: 900, close_date: null, owner: "Cy" }),
  ]) }]);
  assert.deepEqual(sortRows(rows, "amount", "desc").map((r) => r.id), ["a", "m", "z"]);
  assert.deepEqual(sortRows(rows, "amount", "asc").map((r) => r.id), ["m", "a", "z"]);
  assert.deepEqual(sortRows(rows, "close", "asc").map((r) => r.id), ["z", "m", "a"]);
  assert.deepEqual(sortRows(rows, "name", "asc").map((r) => r.id), ["a", "m", "z"]);
  assert.deepEqual(sortRows(rows, "owner", "desc").map((r) => r.id), ["a", "z", "m"]);
});

test("summary: open deals and the pipeline in the main currency", () => {
  const rows = rowsOf([{ ws: "w", board: board("Sales", [
    deal("a", "Demo", { amount: 100 }), deal("b", "Demo", { amount: 250, quiet: true }), deal("e", "Demo", { amount: 7, currency: "EUR" }),
    deal("c", "Won", { closed: true, amount: 1e6 }),
  ]) }]);
  assert.deepEqual(summaryOf(rows), { open: 3, quiet: 1, amount: 350, currency: "USD", mixed: true });
});

test("call length", () => {
  assert.equal(minutes(null), null);
  assert.equal(minutes(30), null);
  assert.equal(minutes(54 * 60), "54 min");
  assert.equal(minutes(65 * 60), "1 h 05 min");
});
