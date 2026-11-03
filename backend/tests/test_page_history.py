"""Version history of pages and the clean-up of page images nothing references
(services/page_history.py, routers/page_history.py, app/mcp/history_tools.py).

Snapshots (coalescing, MCP writes, lock release), restore and the edit lock
(423), who may see and restore (the permission matrix; encrypted documents
have none), retention thinning, and the image clean-up against the in-memory
R2. The access-policy world (tests/_access_env.py): the test MongoDB (or
mongomock), never backend/.env, never real R2.
"""

from __future__ import annotations


import secrets
from datetime import timedelta

from tests._access_env import ES_SECRET, now  # noqa: F401  (pins settings first)

from bson import ObjectId

from app.services import live, page_assets, page_history
from tests.test_pages import PageWorld, png

V = page_history.COLL


class HistoryWorld(PageWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await page_history.ensure_indexes(self.db)
        await self.db["oauth_clients"].insert_one({"_id": "test-client", "client_name": "Claude"})

    async def page(self, state: str = "UP", **extra) -> dict:
        extra.setdefault("editor", "blocks")
        return await self.mkdoc(state, **extra)

    async def lock(self, slug, who):
        return await self.http.post(f"/api/v1/documents/{slug}/lock", headers=self.session(who))

    async def unlock(self, slug, who):
        return await self.http.delete(f"/api/v1/documents/{slug}/lock", headers=self.session(who))

    async def save(self, slug, who, content, title="T"):
        r = await self.http.put(f"/api/v1/documents/{slug}", json={"title": title, "content": content},
                                headers=self.session(who))
        return r

    async def versions(self, doc) -> list[dict]:
        return await self.db[V].find({"doc_id": str(doc["_id"])}).sort("n", 1).to_list(length=None)

    async def age_open_version(self, doc, minutes=11):
        top = (await self.versions(doc))[-1]
        await self.db[V].update_one({"_id": top["_id"]},
                                    {"$set": {"started_at": now() - timedelta(minutes=minutes)}})

    def url(self, doc, tail=""):
        return f"/api/v1/documents/{doc['slug']}/versions{tail}"

    async def mcp(self, who, name, args, *, write=True):
        status, res = await self.mcp_call(await self.mcp_token(who, write=write), name, args)
        self.assertEqual(status, 200, name)
        return res


# ── Snapshots ─────────────────────────────────────────────────────────────────


class Snapshots(HistoryWorld):
    async def test_saves_coalesce_per_session_per_10_minutes(self):
        p = await self.page()
        await self.lock(p["slug"], "owner")
        for i in range(4):
            self.assertEqual((await self.save(p["slug"], "owner", f"# v{i}")).status_code, 200)
        vs = await self.versions(p)
        # The state before the first save (written outside the editor), then one session version.
        self.assertEqual([v["author_kind"] for v in vs], ["system", "user"])
        self.assertEqual(vs[0]["markdown"], p["content"])
        self.assertEqual(vs[1]["markdown"], "# v3")
        self.assertEqual(vs[1]["author_id"], self.uid["owner"])
        self.assertFalse(vs[1]["sealed"])
        # Ten minutes on, the next save starts a new version.
        await self.age_open_version(p)
        await self.save(p["slug"], "owner", "# later")
        vs = await self.versions(p)
        self.assertEqual([v["markdown"] for v in vs], [p["content"], "# v3", "# later"])
        self.assertEqual([v["n"] for v in vs], [1, 2, 3])
        # Saving the same text again changes nothing.
        await self.save(p["slug"], "owner", "# later")
        self.assertEqual(len(await self.versions(p)), 3)

    async def test_release_seals_the_session(self):
        p = await self.page()
        await self.lock(p["slug"], "owner")
        await self.save(p["slug"], "owner", "# one")
        self.assertEqual((await self.unlock(p["slug"], "owner")).status_code, 204)
        self.assertTrue((await self.versions(p))[-1]["sealed"])
        await self.lock(p["slug"], "owner")
        await self.save(p["slug"], "owner", "# two")
        self.assertEqual([v["markdown"] for v in await self.versions(p)], [p["content"], "# one", "# two"])

    async def test_release_by_beacon_seals_too(self):
        p = await self.page()
        await self.lock(p["slug"], "owner")
        await self.save(p["slug"], "owner", "# one")
        token = self.session("owner")["Authorization"].removeprefix("Bearer ")
        r = await self.http.post(f"/api/v1/documents/{p['slug']}/lock/release", content=token,
                                 headers={"Content-Type": "text/plain"})
        self.assertEqual(r.status_code, 204)
        self.assertTrue((await self.versions(p))[-1]["sealed"])

    async def test_release_captures_a_change_made_elsewhere(self):
        p = await self.page()
        await self.lock(p["slug"], "owner")
        await self.save(p["slug"], "owner", "# one")
        await self.db["documents"].update_one({"_id": p["_id"]}, {"$set": {"content": "# pushed from VS Code"}})
        await self.unlock(p["slug"], "owner")
        self.assertEqual((await self.versions(p))[-1]["markdown"], "# pushed from VS Code")

    async def test_another_editor_starts_their_own_version(self):
        p = await self.page()
        await self.lock(p["slug"], "owner")
        await self.save(p["slug"], "owner", "# owner's")
        await self.unlock(p["slug"], "owner")
        await self.lock(p["slug"], "ge")
        await self.save(p["slug"], "ge", "# ge's")
        vs = await self.versions(p)
        self.assertEqual([(v["author_kind"], v["author_name"]) for v in vs[1:]], [("user", "OWNER"), ("user", "GE")])

    async def test_classic_documents_and_encrypted_ones_record_nothing(self):
        classic = await self.mkdoc("UP")
        await self.save(classic["slug"], "owner", "# changed")
        self.assertEqual(await self.versions(classic), [])

    async def test_mcp_writes_snapshot_before_and_after(self):
        p = await self.page()
        # Someone's open session first: an AI edit seals it.
        await self.lock(p["slug"], "owner")
        await self.save(p["slug"], "owner", "# mine")
        await self.unlock(p["slug"], "owner")
        await self.db[V].update_many({}, {"$set": {"sealed": False}})  # as if the release never came
        r = await self.mcp("owner", "update_page", {"document": p["slug"], "markdown": "# by the AI", "base_rev": 2})
        self.assertFalse(r["isError"], r)
        r = await self.mcp("owner", "append_blocks", {"document": p["slug"], "markdown": "More."})
        self.assertFalse(r["isError"], r)
        r = await self.mcp("owner", "replace_section", {"document": p["slug"], "heading": "by the AI",
                                                       "markdown": "Rewritten."})
        self.assertFalse(r["isError"], r)
        vs = await self.versions(p)
        self.assertEqual([v["author_kind"] for v in vs], ["system", "user", "mcp", "mcp", "mcp"])
        self.assertTrue(vs[1]["sealed"])
        self.assertEqual(vs[2]["markdown"], "# by the AI")
        self.assertIn("More.", vs[3]["markdown"])
        self.assertEqual({v["client"] for v in vs[2:]}, {"Claude"})
        # The next save in the editor is a new version, not merged into the AI's.
        await self.lock(p["slug"], "owner")
        cur = (await self.doc(p["slug"]))["content"]
        await self.save(p["slug"], "owner", cur + "\n\nTyped.")
        self.assertEqual((await self.versions(p))[-1]["author_kind"], "user")
        self.assertEqual(len(await self.versions(p)), 6)

    async def test_mcp_write_over_an_unrecorded_state_keeps_it(self):
        p = await self.page()
        r = await self.mcp("owner", "append_blocks", {"document": p["slug"], "markdown": "Added."})
        self.assertFalse(r["isError"], r)
        vs = await self.versions(p)
        self.assertEqual([v["author_kind"] for v in vs], ["system", "mcp"])
        self.assertEqual(vs[0]["markdown"], p["content"])

    async def test_mcp_client_name_falls_back(self):
        await self.db["oauth_clients"].delete_many({})
        p = await self.page()
        await self.mcp("owner", "append_blocks", {"document": p["slug"], "markdown": "Added."})
        r = await self.http.get(self.url(p), headers=self.session("owner"))
        self.assertEqual(r.json()["versions"][0]["author"]["label"], "AI app via MCP")

    async def test_delete_takes_the_history(self):
        p = await self.page()
        await self.lock(p["slug"], "owner")
        await self.save(p["slug"], "owner", "# x")
        r = await self.http.delete(f"/api/v1/documents/{p['slug']}", headers=self.session("owner"))
        self.assertEqual(r.status_code, 204)
        self.assertEqual(await self.db[V].count_documents({"doc_id": str(p["_id"])}), 0)

    async def test_cap_on_insert(self):
        p = await self.page()
        await self.db[V].insert_many([{"doc_id": str(p["_id"]), "n": i, "ts": now(), "sha": str(i),
                                       "markdown": "", "author_kind": "system", "sealed": True}
                                      for i in range(1, page_history.MAX_VERSIONS + 1)])
        await self.lock(p["slug"], "owner")
        await self.save(p["slug"], "owner", "# newest")
        vs = await self.versions(p)
        self.assertEqual(len(vs), page_history.MAX_VERSIONS)
        self.assertEqual(vs[-1]["markdown"], "# newest")
        self.assertNotIn(1, [v["n"] for v in vs])


# ── The API: list, read, restore, the lock ────────────────────────────────────


class Api(HistoryWorld):
    async def edited(self) -> dict:
        p = await self.page()
        await self.lock(p["slug"], "owner")
        await self.save(p["slug"], "owner", "# First\n\nhello", title="First")
        await self.unlock(p["slug"], "owner")
        await self.lock(p["slug"], "ge")
        await self.save(p["slug"], "ge", "# Second\n\nworld", title="Second")
        await self.unlock(p["slug"], "ge")
        return p

    async def test_list_and_read(self):
        p = await self.edited()
        r = await self.http.get(self.url(p), headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertTrue(body["available"])
        self.assertIsNone(body["next_cursor"])
        self.assertEqual([v["n"] for v in body["versions"]], [3, 2, 1])
        top = body["versions"][0]
        self.assertTrue(top["current"])
        self.assertEqual((top["title"], top["author"]["kind"], top["author"]["name"], top["author"]["label"]),
                         ("Second", "user", "GE", "GE"))
        self.assertFalse(body["versions"][1]["current"])
        self.assertEqual(body["versions"][2]["author"]["label"], "Earlier version")
        self.assertNotIn("markdown", top)
        r = await self.http.get(self.url(p, "/2"), headers=self.session("ge"))
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertEqual((d["n"], d["markdown"], d["title"]), (2, "# First\n\nhello", "First"))
        self.assertEqual(d["current_doc"]["markdown"], "# Second\n\nworld")
        self.assertEqual(d["current_doc"]["rev"], 3)
        self.assertEqual((await self.http.get(self.url(p, "/99"), headers=self.session("owner"))).status_code, 404)

    async def test_paging(self):
        p = await self.page()
        await self.db[V].insert_many([{"doc_id": str(p["_id"]), "n": i, "ts": now(), "sha": str(i),
                                       "markdown": "", "author_kind": "system"} for i in range(1, 8)])
        r = await self.http.get(self.url(p) + "?limit=3", headers=self.session("owner"))
        self.assertEqual([v["n"] for v in r.json()["versions"]], [7, 6, 5])
        self.assertEqual(r.json()["next_cursor"], 5)
        r = await self.http.get(self.url(p) + "?limit=3&cursor=5", headers=self.session("owner"))
        self.assertEqual([v["n"] for v in r.json()["versions"]], [4, 3, 2])
        r = await self.http.get(self.url(p) + "?limit=3&cursor=2", headers=self.session("owner"))
        self.assertEqual(([v["n"] for v in r.json()["versions"]], r.json()["next_cursor"]), ([1], None))

    async def test_restore_makes_a_new_undoable_version(self):
        p = await self.edited()
        q = live.subscribe(p["slug"])
        self.addCleanup(live.unsubscribe, p["slug"], q)
        r = await self.http.post(self.url(p, "/2/restore"), headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual((body["restored_from"], body["version"]), (2, 4))
        self.assertEqual(body["document"]["content"], "# First\n\nhello")
        raw = await self.doc(p["slug"])
        self.assertEqual((raw["content"], raw["title"], raw["rev"]), ("# First\n\nhello", "First", 4))
        vs = await self.versions(p)
        self.assertEqual(vs[-1]["author_kind"], "restore")
        self.assertEqual((vs[-1]["restored_from"], vs[-1]["author_id"]), (2, self.uid["owner"]))
        # The state it replaced is still there (version 3): the restore can be undone.
        self.assertEqual(vs[2]["markdown"], "# Second\n\nworld")
        events = []
        while not q.empty():
            events.append(q.get_nowait())
        self.assertIn({"type": "changed", "rev": 4, "restored": True}, events)
        listing = (await self.http.get(self.url(p), headers=self.session("owner"))).json()["versions"]
        self.assertEqual((listing[0]["author"]["kind"], listing[0]["restored_from"], listing[0]["current"]),
                         ("restore", 2, True))
        # Undo: restore the version the restore replaced.
        r = await self.http.post(self.url(p, "/3/restore"), headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self.doc(p["slug"]))["content"], "# Second\n\nworld")

    async def test_restore_respects_the_edit_lock(self):
        p = await self.edited()
        before = len(await self.versions(p))
        self.assertEqual((await self.lock(p["slug"], "ge")).status_code, 200)
        r = await self.http.post(self.url(p, "/2/restore"), headers=self.session("owner"))
        self.assertEqual(r.status_code, 423, r.text)
        self.assertEqual((r.json()["code"], r.json()["holder"]), ("locked", {"name": "GE"}))
        self.assertEqual((await self.doc(p["slug"]))["content"], "# Second\n\nworld")
        self.assertEqual(len(await self.versions(p)), before)
        # The holder may restore (their editor reloads on the "restored" event).
        r = await self.http.post(self.url(p, "/2/restore"), headers=self.session("ge"))
        self.assertEqual(r.status_code, 200, r.text)
        # A lapsed lock doesn't block.
        await self.db["documents"].update_one({"_id": p["_id"]}, {"$set": {
            "edit_lock.expires_at": now() - timedelta(seconds=1)}})
        self.assertEqual((await self.http.post(self.url(p, "/3/restore"), headers=self.session("owner"))).status_code, 200)

    async def test_restore_of_a_locked_page(self):
        p = await self.edited()
        await self.db["documents"].update_one({"_id": p["_id"]}, {"$set": {
            "content": "---\nlocked: true\n---\n# Locked"}})
        r = await self.http.post(self.url(p, "/2/restore"), headers=self.session("ge"))
        self.assertEqual(r.status_code, 423)
        self.assertEqual(r.json()["code"], "page_locked")
        self.assertEqual((await self.http.post(self.url(p, "/2/restore"), headers=self.session("owner"))).status_code, 200)

    async def test_restore_of_a_missing_version(self):
        p = await self.edited()
        self.assertEqual((await self.http.post(self.url(p, "/42/restore"), headers=self.session("owner"))).status_code, 404)


class Permissions(HistoryWorld):
    """Editors may list, read and restore; readers never; nobody else learns it exists."""

    async def test_matrix(self):
        p = await self.page("W")  # in workspace W1, workspace-visible; gv/ge granted
        await self.lock(p["slug"], "owner")
        await self.save(p["slug"], "owner", "# edited")
        await self.unlock(p["slug"], "owner")
        cases = {
            "owner": 200, "ge": 200,          # owner, an editor by grant
            "gv": 403, "wv": 403,             # readers (a viewer grant, a workspace viewer)
            "stranger": 404, "wm2": 404,      # not in the circle; another workspace's member
        }
        for who, code in cases.items():
            for method, tail in (("get", ""), ("get", "/1"), ("post", "/1/restore")):
                r = await getattr(self.http, method)(self.url(p, tail), headers=self.session(who))
                self.assertEqual(r.status_code, code, (who, method, tail, r.text))
        for method, tail in (("get", ""), ("get", "/1"), ("post", "/1/restore")):
            r = await getattr(self.http, method)(self.url(p, tail))
            self.assertEqual(r.status_code, 401, ("anonymous", tail))
            # The edit secret isn't a person: no history through it.
            r = await getattr(self.http, method)(self.url(p, tail), headers={"X-Edit-Secret": ES_SECRET})
            self.assertEqual(r.status_code, 401, ("edit secret", tail))
        # A tenant token (a workspace's own domain) is read-only: never history.
        r = await self.http.get(self.url(p), headers=self.tenant("wm", "W1"))
        self.assertIn(r.status_code, (401, 403))
        # Only the owner's and ge's restores happened.
        restores = [v for v in await self.versions(p) if v["author_kind"] == "restore"]
        self.assertEqual(sorted(v["author_id"] for v in restores), sorted([self.uid["owner"], self.uid["ge"]]))

    async def test_encrypted_documents_have_none(self):
        enc = await self.mkdoc("UP", encrypted=True, content="ENVELOPE")
        await self.db[V].insert_one({"doc_id": str(enc["_id"]), "n": 1, "ts": now(), "markdown": "x",
                                     "sha": "x", "author_kind": "system"})
        r = await self.http.get(self.url(enc), headers=self.session("owner"))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"versions": [], "next_cursor": None, "available": False, "reason": "encrypted"})
        self.assertEqual((await self.http.get(self.url(enc, "/1"), headers=self.session("owner"))).status_code, 404)
        self.assertEqual((await self.http.post(self.url(enc, "/1/restore"), headers=self.session("owner"))).status_code, 409)
        self.assertEqual((await self.doc(enc["slug"]))["content"], "ENVELOPE")

    async def test_files_have_their_own_versions(self):
        art = await self.mkdoc("UP", kind="artifact")
        r = await self.http.get(self.url(art), headers=self.session("owner"))
        self.assertEqual((r.status_code, r.json()["available"], r.json()["reason"]), (200, False, "file"))


# ── MCP ───────────────────────────────────────────────────────────────────────


class Mcp(HistoryWorld):
    async def test_list_get_restore(self):
        p = await self.page()
        await self.lock(p["slug"], "owner")
        await self.save(p["slug"], "owner", "# Old", title="Old")
        await self.unlock(p["slug"], "owner")
        await self.lock(p["slug"], "owner")
        await self.save(p["slug"], "owner", "# New", title="New")
        await self.unlock(p["slug"], "owner")
        res = await self.mcp("owner", "list_page_versions", {"document": p["slug"]}, write=False)
        self.assertFalse(res["isError"], res)
        out = res["structuredContent"]
        self.assertEqual([v["n"] for v in out["versions"]], [3, 2, 1])
        self.assertTrue(out["versions"][0]["current"])
        self.assertIn("v2", res["content"][0]["text"])
        res = await self.mcp("ge", "get_page_version", {"document": p["slug"], "version": 2}, write=False)
        self.assertFalse(res["isError"], res)
        self.assertEqual((res["structuredContent"]["markdown"], res["structuredContent"]["current"]), ("# Old", False))
        # A read-only token can't restore.
        status, _ = await self.mcp_call(await self.mcp_token("owner", write=False), "restore_page_version",
                                        {"document": p["slug"], "version": 2})
        self.assertEqual(status, 403)
        res = await self.mcp("owner", "restore_page_version", {"document": p["slug"], "version": 2})
        self.assertFalse(res["isError"], res)
        self.assertEqual(res["structuredContent"]["restored_from"], 2)
        self.assertEqual((await self.doc(p["slug"]))["content"], "# Old")
        self.assertEqual((await self.versions(p))[-1]["author_kind"], "restore")

    async def test_refusals(self):
        p = await self.page()
        await self.lock(p["slug"], "owner")
        await self.save(p["slug"], "owner", "# x")
        # Someone has it open: the restore is refused.
        res = await self.mcp("owner", "restore_page_version", {"document": p["slug"], "version": 1})
        self.assertTrue(res["isError"])
        self.assertIn("editing", res["content"][0]["text"])
        self.assertEqual((await self.doc(p["slug"]))["content"], "# x")
        # Readers and strangers.
        for who, name in (("gv", "list_page_versions"), ("gv", "get_page_version"), ("stranger", "list_page_versions")):
            args = {"document": p["slug"], **({"version": 1} if name == "get_page_version" else {})}
            res = await self.mcp(who, name, args)
            self.assertTrue(res["isError"], (who, name))
        res = await self.mcp("gv", "list_page_versions", {"document": p["slug"]})
        self.assertIn("can edit", res["content"][0]["text"])
        res = await self.mcp("owner", "get_page_version", {"document": p["slug"], "version": 99})
        self.assertTrue(res["isError"])
        enc = await self.mkdoc("UP", encrypted=True)
        res = await self.mcp("owner", "list_page_versions", {"document": enc["slug"]})
        self.assertTrue(res["isError"])
        self.assertIn("no version history", res["content"][0]["text"])
        art = await self.mkdoc("UP", kind="artifact")
        res = await self.mcp("owner", "list_page_versions", {"document": art["slug"]})
        self.assertTrue(res["isError"])
        self.assertIn("list_file_versions", res["content"][0]["text"])


# ── Retention ────────────────────────────────────────────────────────────────


class Retention(HistoryWorld):
    async def test_thinning(self):
        p = await self.page()
        d = str(p["_id"])
        t = now()
        day40 = (t - timedelta(days=40)).replace(hour=12, minute=0, second=0, microsecond=0)
        rows = [
            (1, t - timedelta(days=400)),                 # past a year: gone
            (2, day40 - timedelta(hours=3)),              # same day as 3 and 4: thinned
            (3, day40 - timedelta(hours=1)),
            (4, day40),                                   # the newest of that day: kept
            (5, day40 + timedelta(days=1)),               # alone on its day: kept
            (6, t - timedelta(days=10)),                  # within 30 days: all kept
            (7, t - timedelta(days=10) + timedelta(minutes=1)),
            (8, t),
        ]
        await self.db[V].insert_many([{"doc_id": d, "n": n, "ts": ts, "sha": str(n), "markdown": "",
                                       "author_kind": "system"} for n, ts in rows])
        # A page that no longer exists.
        gone = str(ObjectId())
        await self.db[V].insert_one({"doc_id": gone, "n": 1, "ts": t, "sha": "g", "markdown": "", "author_kind": "system"})
        dry = await page_history.thin(self.db, t, dry_run=True)
        self.assertEqual((dry["expired"], dry["thinned"], dry["orphaned"]), (1, 2, 1))
        self.assertEqual(await self.db[V].count_documents({}), 9)
        out = await page_history.thin(self.db, t)
        self.assertEqual((out["expired"], out["thinned"], out["orphaned"], out["capped"]), (1, 2, 1, 0))
        self.assertEqual([v["n"] for v in await self.versions(p)], [4, 5, 6, 7, 8])
        self.assertEqual(await self.db[V].count_documents({"doc_id": gone}), 0)

    async def test_cap(self):
        p = await self.page()
        await self.db[V].insert_many([{"doc_id": str(p["_id"]), "n": i, "ts": now(), "sha": str(i),
                                       "markdown": "", "author_kind": "system"} for i in range(1, 511)])
        out = await page_history.thin(self.db)
        self.assertEqual(out["capped"], 10)
        vs = await self.versions(p)
        self.assertEqual((len(vs), vs[0]["n"]), (500, 11))

    async def test_run_due_once_a_day(self):
        first = await page_history.run_due(self.db)
        self.assertIsNotNone(first)
        self.assertIsNone(await page_history.run_due(self.db))
        await self.db[page_history.RUNS].update_one({"_id": "page_history"}, {"$set": {"at": now() - timedelta(days=1)}})
        self.assertIsNotNone(await page_history.run_due(self.db))
        # Dry run: never records a run (the real one still happens).
        await self.db[page_history.RUNS].delete_many({})
        self.assertTrue((await page_history.run_due(self.db, dry_run=True))["images"]["dry_run"])
        self.assertIsNone(await self.db[page_history.RUNS].find_one({}))


# ── Page images nothing references ────────────────────────────────────────────


class ImageCleanup(HistoryWorld):
    async def asset(self, doc_id: str, **extra) -> str:
        aid = secrets.token_hex(12)
        key = page_assets.key_for(doc_id, aid, "png")
        self.r2.put_bytes(key, b"png", "image/png", False)
        await self.db[page_assets.COLL].insert_one({"_id": aid, "doc_id": doc_id, "key": key, "mime": "image/png",
                                                    "size": 3, "created_at": now(), **extra})
        return aid

    async def row(self, aid):
        return await self.db[page_assets.COLL].find_one({"_id": aid})

    def stored(self, aid, doc_id):
        return page_assets.key_for(doc_id, aid, "png") in self.r2.objects

    async def test_mark_clear_delete(self):
        p = await self.page()
        d = str(p["_id"])
        old = now() - timedelta(days=31)
        in_page = await self.asset(d)
        in_cover = await self.asset(d)
        in_old_version = await self.asset(d, unreferenced_since=old)  # re-referenced by a version: cleared
        fresh = await self.asset(d)                                    # unreferenced: marked, kept
        stale = await self.asset(d, unreferenced_since=old)            # unreferenced 31 days: deleted
        recent = await self.asset(d, unreferenced_since=now() - timedelta(days=29))  # not yet
        await self.db["documents"].update_one({"_id": p["_id"]}, {"$set": {
            "content": f"---\ncover: asset:{in_cover}\n---\n# P\n\n![a](asset:{in_page})"}})
        await self.db[V].insert_one({"doc_id": d, "n": 1, "ts": now() - timedelta(days=200), "sha": "s",
                                     "markdown": f"![b](asset:{in_old_version})", "assets": [in_old_version],
                                     "author_kind": "system"})
        # Dry run: counts only, nothing changes.
        dry = await page_history.cleanup_images(self.db, dry_run=True)
        self.assertEqual((dry["assets"], dry["referenced"], dry["marked"], dry["cleared"], dry["deleted"]),
                         (6, 3, 1, 1, 1))
        self.assertTrue(self.stored(stale, d))
        self.assertIsNone((await self.row(fresh)).get("unreferenced_since"))
        out = await page_history.cleanup_images(self.db)
        self.assertEqual((out["marked"], out["cleared"], out["deleted"], out["deleted_bytes"]), (1, 1, 1, 3))
        self.assertIsNone(await self.row(stale))
        self.assertFalse(self.stored(stale, d))
        for aid in (in_page, in_cover, in_old_version, fresh, recent):
            self.assertIsNotNone(await self.row(aid), aid)
            self.assertTrue(self.stored(aid, d), aid)
        self.assertIsNone((await self.row(in_old_version)).get("unreferenced_since"))
        self.assertIsNotNone((await self.row(fresh)).get("unreferenced_since"))
        # 31 days later the fresh one goes too; the referenced ones never do.
        later = await page_history.cleanup_images(self.db, now() + timedelta(days=31))
        self.assertEqual(later["deleted"], 2)  # fresh and recent
        self.assertIsNone(await self.row(fresh))
        self.assertIsNotNone(await self.row(in_old_version))

    async def test_a_version_dropped_by_retention_frees_its_images(self):
        p = await self.page()
        d = str(p["_id"])
        aid = await self.asset(d)
        await self.db[V].insert_one({"doc_id": d, "n": 1, "ts": now() - timedelta(days=400), "sha": "s",
                                     "markdown": f"![b](asset:{aid})", "assets": [aid], "author_kind": "system"})
        self.assertEqual((await page_history.cleanup_images(self.db))["referenced"], 1)
        await page_history.thin(self.db)
        self.assertEqual((await page_history.cleanup_images(self.db))["marked"], 1)

    async def test_through_the_editor(self):
        """Upload, use, remove: the image stays while a version still shows it."""
        p = await self.page()
        await self.lock(p["slug"], "owner")
        r = await self.upload(p["slug"], self.session("owner"), png())
        self.assertEqual(r.status_code, 201, r.text)
        aid = r.json()["id"]
        await self.save(p["slug"], "owner", f"# P\n\n![x](asset:{aid})")
        await self.age_open_version(p)
        await self.save(p["slug"], "owner", "# P\n\nno image now")
        out = await page_history.cleanup_images(self.db, now() + timedelta(days=60))
        self.assertEqual((out["referenced"], out["marked"]), (1, 0))
        self.assertIsNotNone(await self.row(aid))

    async def test_deleted_page_and_encrypted_page(self):
        gone = str(ObjectId())
        a = await self.asset(gone)
        b = await self.asset(gone, unreferenced_since=now() - timedelta(days=31))
        enc = await self.mkdoc("UP", encrypted=True)
        e = await self.asset(str(enc["_id"]), unreferenced_since=now() - timedelta(days=90))
        out = await page_history.cleanup_images(self.db)
        self.assertEqual((out["page_gone"], out["deleted"], out["kept_encrypted"]), (2, 1, 1))
        self.assertIsNone(await self.row(b))
        self.assertFalse(self.stored(b, gone))
        self.assertIsNotNone((await self.row(a)).get("unreferenced_since"))
        self.assertIsNotNone(await self.row(e))
        out = await page_history.cleanup_images(self.db, now() + timedelta(days=31))
        self.assertIsNone(await self.row(a))

    async def test_logs_counts_only(self):
        p = await self.page()
        aid = await self.asset(str(p["_id"]), unreferenced_since=now() - timedelta(days=40))
        with self.assertLogs("app.services.page_history", level="INFO") as logs:
            await page_history.cleanup_images(self.db)
        text = "\n".join(logs.output)
        self.assertNotIn(aid, text)
        self.assertNotIn("pa/", text)
        self.assertNotIn(p["content"], text)


if __name__ == "__main__":  # pragma: no cover
    import unittest

    unittest.main()


