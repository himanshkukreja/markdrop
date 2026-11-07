// My files type filter (lib/fileTypes.ts). Run: node --test src/lib/fileTypes.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  FILE_TYPES, TYPE_META, TYPE_REMEMBER_KEY, countFor, readRememberedType, readTypeFilter, rememberType,
  shouldRestoreType, typeQuery, typeUrlPatch, visibleTypeChips,
} from "./fileTypes.ts";

const P = (s) => new URLSearchParams(s);

test("the URL means one filter; ?type= wins over the old ?kind=", () => {
  assert.equal(readTypeFilter(P("")), "all");
  assert.equal(readTypeFilter(P("type=video")), "video");
  assert.equal(readTypeFilter(P("type=video&kind=document")), "video");
  assert.equal(readTypeFilter(P("kind=document")), "document");
  assert.equal(readTypeFilter(P("kind=markdown")), "document");
  assert.equal(readTypeFilter(P("kind=artifact")), "files");
  assert.equal(readTypeFilter(P("type=movies")), "all");
  assert.equal(readTypeFilter(P("type=movies&kind=artifact")), "files");
});

test("what the list endpoint is asked for, and the URL patch", () => {
  assert.deepEqual(typeQuery("all"), {});
  assert.deepEqual(typeQuery("files"), { kind: "artifact" });
  assert.deepEqual(typeQuery("pdf"), { type: "pdf" });
  assert.deepEqual(typeUrlPatch("all"), { type: null, kind: null });
  assert.deepEqual(typeUrlPatch("slides"), { type: "slides", kind: null });
  assert.deepEqual(typeUrlPatch("files"), { type: null, kind: "artifact" });
  for (const t of FILE_TYPES) assert.equal(readTypeFilter(P(new URLSearchParams(Object.entries(typeUrlPatch(t)).filter(([, v]) => v)).toString())), t);
});

test("chips: All and Documents always, a type once you have one, the selected one always", () => {
  assert.deepEqual(visibleTypeChips("all", null), ["all", "document"]);
  assert.deepEqual(visibleTypeChips("video", null), ["all", "document", "video"]);
  assert.deepEqual(visibleTypeChips("all", { document: 0, pdf: 2, video: 0, other: 1 }), ["all", "document", "pdf", "other"]);
  assert.deepEqual(visibleTypeChips("word", { pdf: 2 }), ["all", "document", "pdf", "word"]);
  assert.deepEqual(visibleTypeChips("files", { html: 1 }), ["all", "files", "document", "html"]);
  const every = Object.fromEntries(FILE_TYPES.map((t) => [t, 1]));
  assert.deepEqual(visibleTypeChips("all", every), ["all", ...FILE_TYPES]);
});

test("counts per chip", () => {
  const c = { all: 9, artifact: 6, byType: { document: 3, video: 2 } };
  assert.equal(countFor("all", c), 9);
  assert.equal(countFor("files", c), 6);
  assert.equal(countFor("video", c), 2);
  assert.equal(countFor("pdf", c), 0);
  assert.equal(countFor("video", null), undefined);
});

test("every filter has copy, and file types point at an upload", () => {
  for (const t of [...FILE_TYPES, "all", "files"]) {
    const m = TYPE_META[t];
    assert.ok(m.chip && m.title && m.icon && m.empty.title && m.empty.action && m.empty.href, t);
  }
  for (const t of FILE_TYPES.filter((t) => t !== "document")) assert.equal(TYPE_META[t].empty.href, "/upload", t);
  assert.equal(TYPE_META.video.empty.title, "No videos yet");
  assert.equal(TYPE_META.video.empty.action, "Upload a video");
});

test("remembered per view: a type is kept, All forgets, bad or blocked storage is harmless", () => {
  const m = new Map();
  const store = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  assert.equal(readRememberedType(store), null);
  rememberType(store, "pdf");
  assert.equal(m.get(TYPE_REMEMBER_KEY), "pdf");
  assert.equal(readRememberedType(store), "pdf");
  rememberType(store, "files");
  assert.equal(readRememberedType(store), null);
  rememberType(store, "video");
  rememberType(store, "all");
  assert.equal(readRememberedType(store), null);
  m.set(TYPE_REMEMBER_KEY, "<script>");
  assert.equal(readRememberedType(store), null);
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  assert.equal(readRememberedType(broken), null);
  assert.doesNotThrow(() => rememberType(broken, "pdf"));
  assert.equal(readRememberedType(null), null);
});

test("only a bare visit restores the remembered type", () => {
  assert.equal(shouldRestoreType(P("")), true);
  assert.equal(shouldRestoreType(P("gdocs=connected")), true);
  for (const s of ["type=pdf", "kind=artifact", "q=road", "page=2"]) assert.equal(shouldRestoreType(P(s)), false, s);
});
