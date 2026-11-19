/** lib/railKeys.mjs: the sidebar's URL → row mapping (nav redesign 2026-11-18). Old links keep landing on a row. */
import test from "node:test";
import assert from "node:assert/strict";
import { ALL_DEALS_KEY, railKeyFor, resolveRailKey, workspaceOfKey, askLinkFor, wsTeamRowKey } from "./railKeys.mjs";

const W = "ws1";
const teams = {
  teams: [
    { id: "g", slug: "general", general: true },
    { id: "s", slug: "sales", hubspot: true },
    { id: "p", slug: "product" },
  ],
  projects: [{ id: "pr", slug: "q4-launch", team_ids: ["p"] }],
};
const folders = [
  { id: "f1", parent_id: null, team_ids: ["s"] },
  { id: "f2", parent_id: "f1" },
  { id: "f3", parent_id: null },
];
const at = (path, search = "") => resolveRailKey(railKeyFor(path, search), teams, folders);

test("a team's pages land on its sections", () => {
  assert.deepEqual(at(`/w/${W}/teams/sales`), { key: wsTeamRowKey(W, "s", "overview"), open: [wsTeamRowKey(W, "s")] });
  assert.equal(at(`/w/${W}/teams/sales/settings`).key, wsTeamRowKey(W, "s", "overview"));
  assert.equal(at(`/w/${W}/teams/sales/pages`).key, wsTeamRowKey(W, "s", "files"));
  assert.equal(at("/meetings/ws1", "?space=team:s").key, wsTeamRowKey(W, "s", "meetings"));
  assert.equal(at("/deals/ws1", "space=team:s").key, wsTeamRowKey(W, "s", "deals"));
  assert.equal(at("/team/ws1", "space=team:p").key, wsTeamRowKey(W, "p", "memory"));
  assert.equal(at(`/w/${W}/projects/q4-launch`).key, wsTeamRowKey(W, "p", "overview"));
});

test("cross-team Meetings and Deals are top-level rows", () => {
  assert.equal(at("/meetings/ws1", "?space=all").key, "ws:ws1:meetings");
  assert.equal(at("/meetings/ws1", "?space=all&team=s&tab=review").key, "ws:ws1:meetings");
  assert.equal(at("/meetings/ws1").key, "ws:ws1:meetings");
  assert.equal(railKeyFor("/deals", ""), ALL_DEALS_KEY);
  assert.equal(railKeyFor("/meetings/start", ""), null);
});

test("old links still land: company meetings, the Team board, the workspace root, deal pages", () => {
  assert.equal(at("/meetings/ws1", "?space=company").key, wsTeamRowKey(W, "g", "meetings"));
  assert.equal(at("/team/ws1").key, wsTeamRowKey(W, "g", "memory"));
  assert.equal(at(`/w/${W}`).key, wsTeamRowKey(W, "g", "files"));
  assert.equal(at(`/w/${W}/home`).key, wsTeamRowKey(W, "g", "files"));
  assert.equal(at("/deals/ws1/9100").key, wsTeamRowKey(W, "s", "deals"));
  assert.equal(at("/deals/ws1").key, wsTeamRowKey(W, "s", "deals"));
  assert.equal(at("/dashboard", "ws=ws1&folder=f2").key, wsTeamRowKey(W, "s", "files"));
});

test("a folder page is its team's Files & pages (General's when it's in no team)", () => {
  assert.equal(at(`/w/${W}/f/f2`).key, wsTeamRowKey(W, "s", "files"));
  assert.equal(at(`/w/${W}/f/f3`).key, wsTeamRowKey(W, "g", "files"));
  assert.equal(at(`/w/${W}/f/unknown`).key, wsTeamRowKey(W, "g", "files"));
});

test("unknown teams and no teams yet", () => {
  assert.equal(at(`/w/${W}/teams/gone`).key, "ws:ws1:browse");
  assert.deepEqual(resolveRailKey("ws:ws1:tslug:sales", null), { key: "ws:ws1:tslug:sales", open: [] });
  assert.equal(resolveRailKey("ws:ws1:deals", { teams: [{ id: "g", slug: "general", general: true }], projects: [] }).key, ALL_DEALS_KEY);
});

test("the rest of the rail and the Ask link", () => {
  assert.equal(railKeyFor("/dashboard", ""), "home");
  assert.equal(railKeyFor("/dashboard", "q=x"), "files");
  assert.equal(railKeyFor("/shared", ""), "shared");
  assert.equal(railKeyFor("/todos", ""), "todos");
  assert.equal(railKeyFor("/settings/workspaces/ws1/x", ""), "ws:ws1:settings");
  assert.equal(workspaceOfKey("ws:new"), null);
  assert.equal(workspaceOfKey(wsTeamRowKey(W, "s", "meetings")), W);
  assert.equal(askLinkFor(wsTeamRowKey(W, "s", "meetings")), "/ask?workspace=ws1&team=s");
  assert.equal(askLinkFor("home", "ws2"), "/ask?workspace=ws2");
});

test("a team's backlog page keeps its Backlog row active", () => {
  assert.deepEqual(at("/sales-backlog", "space=team:s&ws=ws1&category=bug"), { key: wsTeamRowKey(W, "s", "backlog"), open: [wsTeamRowKey(W, "s")] });
  assert.equal(railKeyFor("/sales-backlog", ""), null);
  assert.equal(railKeyFor("/sales-backlog", "space=team:s"), null);
});
