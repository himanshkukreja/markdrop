// The landing's "Start with your team" routing (lib/meetingsStart.ts). Run: node --test src/lib/meetingsStart.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { MEETINGS_START_PATH, meetingsStartHref, meetingsStartLogin, meetingsStartTarget } from "./meetingsStart.ts";

test("the first workspace you can bring meetings into, with Connect Google Meet open", () => {
  const ws = [
    { id: "a1", role: "viewer" },
    { id: "b2", role: "member" },
    { id: "c3", role: "owner" },
  ];
  assert.equal(meetingsStartTarget(ws), "/meetings/b2?connect=1");
  assert.equal(meetingsStartTarget([{ id: "c3", role: "owner" }, { id: "b2", role: "admin" }]), "/meetings/c3?connect=1");
});

test("only a viewer: that workspace's Meetings, without Connect", () => {
  assert.equal(meetingsStartTarget([{ id: "v1", role: "viewer" }, { id: "v2", role: "viewer" }]), "/meetings/v1");
  assert.equal(meetingsStartTarget([{ id: "x9" }]), "/meetings/x9");
});

test("no workspace: the New workspace dialog, then Meetings", () => {
  assert.equal(meetingsStartTarget([]), "/settings/workspaces?new=1&then=meetings");
  assert.equal(meetingsStartTarget(null), "/settings/workspaces?new=1&then=meetings");
  assert.equal(meetingsStartTarget([{ id: "" }, null]), "/settings/workspaces?new=1&then=meetings");
});

test("ids are encoded; sign-in comes back to /meetings/start", () => {
  assert.equal(meetingsStartHref("a/b"), "/meetings/a%2Fb?connect=1");
  assert.equal(MEETINGS_START_PATH, "/meetings/start");
  assert.equal(meetingsStartLogin(), "/login?next=%2Fmeetings%2Fstart");
});
