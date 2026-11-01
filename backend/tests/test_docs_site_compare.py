"""Comparing publishes, the publish history's change summaries, a running publish's progress,
the site bar's publish status and the setup checklist (services/docs_site_compare.py)."""

from __future__ import annotations

import unittest
from datetime import timedelta

from tests._docs_sites_env import BASE, DocsSitesCase, now

from bson import ObjectId

from app.services import docs_site_compare as compare


class DiffUnit(unittest.TestCase):
    def test_line_counts(self):
        self.assertEqual(compare.line_counts("a\nb\nc\n", "a\nB\nc\nd\n"), (2, 1))
        self.assertEqual(compare.line_counts("", "x\ny"), (2, 0))
        self.assertEqual(compare.line_counts("x", "x"), (0, 0))

    def test_page_diff_hunks_and_gaps(self):
        old = "\n".join(f"line {i}" for i in range(1, 21))
        new = old.replace("line 10", "line ten") + "\nline 21"
        d = compare.page_diff(old, new)
        ops = [r["op"] for r in d["rows"]]
        self.assertEqual(ops[0], "gap")
        self.assertEqual(d["rows"][0]["text"], "6")  # lines 1–6 skipped
        self.assertIn({"op": "del", "text": "line 10", "a": 10, "b": None}, d["rows"])
        self.assertIn({"op": "add", "text": "line ten", "a": None, "b": 10}, d["rows"])
        self.assertEqual(d["rows"][-1], {"op": "add", "text": "line 21", "a": None, "b": 21})
        self.assertFalse(d["truncated"])
        # A new page is all additions, a removed one all deletions, nothing is nothing.
        self.assertEqual([r["op"] for r in compare.page_diff("", "a\nb")["rows"]], ["add", "add"])
        self.assertEqual([r["op"] for r in compare.page_diff("a\nb", "")["rows"]], ["del", "del"])
        self.assertEqual(compare.page_diff("", "")["rows"], [])

    def test_page_diff_is_capped(self):
        d = compare.page_diff("", "\n".join(str(i) for i in range(compare.DIFF_MAX_ROWS + 50)))
        self.assertTrue(d["truncated"])
        self.assertEqual(len(d["rows"]), compare.DIFF_MAX_ROWS)

    def test_compare_summary(self):
        old = {"pages": [{"page_id": "a", "path": "/a", "title": "A", "markdown": "x", "hash": "1"},
                         {"page_id": "b", "path": "/b", "title": "B", "markdown": "y", "hash": "2"}],
               "settings": {"theme": {"preset": "clean"}, "redirects": []}, "site": {"name": "N", "slug": "n"}}
        new = {"pages": [{"page_id": "a", "path": "/a2", "title": "A", "markdown": "x\nz", "hash": "3"},
                         {"page_id": "c", "path": "/c", "title": "C", "markdown": "1\n2\n3", "hash": "4"}],
               "settings": {"theme": {"preset": "minimal"}, "redirects": [{"from": "/b", "to": "/c"}]},
               "site": {"name": "N", "slug": "n"}}
        res = compare.compare(old, new)
        self.assertEqual([(p["id"], p["change"], p.get("added_lines"), p.get("removed_lines")) for p in res["pages"]],
                         [("c", "added", 3, 0), ("a", "edited", 1, 0), ("b", "removed", 0, 1)])
        self.assertEqual(res["pages"][1]["moved_from"], "/a")
        self.assertEqual(res["pages"][1]["fields"], ["path"])
        s = res["summary"]
        self.assertEqual((s["added"], s["edited"], s["removed"], s["design"], s["redirects"], s["api"]),
                         (1, 1, 1, True, True, False))
        # A first publish: pages only, no settings "changed".
        first = compare.compare(None, new, lines=False)["summary"]
        self.assertEqual((first["added"], first["settings"]), (2, []))


class ProgressUnit(unittest.TestCase):
    def test_stages(self):
        t0 = now()
        b = {"status": "building", "started_at": t0 - timedelta(seconds=20), "created_at": t0}
        job = lambda step, done=0, total=0: {"progress": {"step": step, "done": done, "total": total}}  # noqa: E731
        p = compare.progress_view({"status": "queued", "created_at": t0}, None, pages_total=10, typical_ms=50_000, at=t0)
        self.assertEqual((p["stage"], p["percent"], p["eta_seconds"]), ("waiting", 2, 50))
        p = compare.progress_view(b, job("assets", 5, 10), pages_total=10, typical_ms=50_000, at=t0)
        self.assertEqual((p["stage"], p["percent"], p["pages_done"]), ("pages", 13, 0))
        # Compiling (no counts from Next): the bar creeps with the time against half the usual
        # publish (20 s of 25 s here), never past the next milestone.
        p = compare.progress_view(b, job("compile", 0, 3), pages_total=10, typical_ms=50_000, at=t0)
        self.assertEqual((p["stage"], p["percent"], p["pages_done"], p["step"]), ("pages", 27, 0, "compile"))
        p = compare.progress_view({**b, "started_at": t0 - timedelta(seconds=5)}, job("compile", 0, 3), pages_total=10,
                                  typical_ms=50_000, at=t0)
        self.assertEqual(p["percent"], 18 + round(30 * 5 / 25))
        p = compare.progress_view({**b, "started_at": t0 - timedelta(seconds=40)}, job("compile", 1, 3), pages_total=10,
                                  typical_ms=50_000, at=t0)
        self.assertEqual(p["percent"], 18 + round(30 * (2 / 3 - 0.04)))
        p = compare.progress_view({**b, "started_at": t0}, job("compile", 2, 3), pages_total=10, typical_ms=50_000, at=t0)
        self.assertEqual(p["percent"], 38)
        # Rendering: Next's page counts, scaled to the snapshot's pages.
        p = compare.progress_view(b, job("build", 26, 52), pages_total=10, typical_ms=50_000, at=t0)
        self.assertEqual((p["stage"], p["percent"], p["pages_done"], p["pages_total"]), ("pages", 60, 5, 10))
        p = compare.progress_view(b, job("build", 25, 25), pages_total=13, typical_ms=50_000, at=t0)
        self.assertEqual((p["percent"], p["pages_done"]), (72, 13))
        self.assertEqual(p["elapsed_seconds"], 20)
        self.assertTrue(3 <= p["eta_seconds"] <= 50)
        p = compare.progress_view(b, job("index", 1, 2), pages_total=10, typical_ms=None, at=t0)
        self.assertEqual((p["stage"], p["percent"], p["pages_done"]), ("extras", 80, 10))
        p = compare.progress_view(b, job("publish"), pages_total=10, typical_ms=None, at=t0)
        self.assertEqual((p["stage"], p["percent"]), ("live", 88))
        p = compare.progress_view({**b, "status": "publishing"}, job("done", 4, 4), pages_total=10, typical_ms=None, at=t0)
        self.assertEqual((p["stage"], p["percent"]), ("live", 97))
        # Garbage from a runner doesn't break it.
        p = compare.progress_view(b, {"progress": {"step": "build", "done": "x", "total": None}}, pages_total=3,
                                  typical_ms=None, at=t0)
        self.assertEqual((p["stage"], p["pages_done"]), ("pages", 0))


class CompareApi(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.site = await self.create("acme", source={"kind": "template", "template": "product"})
        self.sid = self.site["id"]

    async def test_drafts_against_nothing_then_against_live(self):
        r = await self.get(f"/{self.sid}/compare", "viewer")
        self.assertEqual((r["from"]["kind"], r["to"]["kind"]), ("none", "drafts"))
        self.assertEqual(r["summary"]["added"], 6)
        self.assertEqual({p["change"] for p in r["pages"]}, {"added"})
        self.assertEqual({row["op"] for row in r["page"]["rows"]}, {"add"})

        b1 = await self.call("POST", f"/{self.sid}/publish", json={"note": "First"}, expect=202)
        await self.mark_live(b1["id"])
        r = await self.get(f"/{self.sid}/compare")
        self.assertEqual((r["from"]["kind"], r["from"]["number"], r["from"]["live"]), ("publish", 1, True))
        self.assertEqual((r["pages"], r["page"]), ([], None))

        home = await self.home(self.sid)
        await self.call("PUT", f"/{self.sid}/pages/{home['id']}", json={
            "base_rev": home["rev"], "markdown": home["markdown"] + "One more line.\n"})
        new = await self.call("POST", f"/{self.sid}/pages", json={"path": "/guides/new", "title": "New"}, expect=201)
        listing = await self.get(f"/{self.sid}/pages")
        gone = next(p for p in listing["pages"] if p["path"] == "/help/faq")
        await self.call("DELETE", f"/{self.sid}/pages/{gone['id']}")
        await self.call("PATCH", f"/{self.sid}", json={"settings": {"theme": {"preset": "minimal"}}})

        r = await self.get(f"/{self.sid}/compare", params={"from": "live", "to": "drafts", "page": home["id"]})
        by_id = {p["id"]: p for p in r["pages"]}
        self.assertEqual(by_id[home["id"]]["change"], "edited")
        self.assertEqual((by_id[home["id"]]["added_lines"], by_id[home["id"]]["removed_lines"]), (1, 0))
        self.assertEqual(by_id[new["id"]]["change"], "added")
        self.assertEqual((by_id[gone["id"]]["change"], by_id[gone["id"]]["path"]), ("removed", "/help/faq"))
        s = r["summary"]
        self.assertEqual((s["added"], s["edited"], s["removed"], s["design"], s["redirects"]), (1, 1, 1, True, False))
        self.assertEqual(r["page"]["id"], home["id"])
        self.assertIn({"op": "add", "text": "One more line.", "a": None, "b": r["page"]["rows"][-1]["b"]},
                      r["page"]["rows"])

        # Two publishes.
        b2 = await self.call("POST", f"/{self.sid}/publish", expect=202)
        await self.mark_live(b2["id"])
        r = await self.get(f"/{self.sid}/compare", "viewer", params={"from": b1["id"], "to": b2["id"]})
        self.assertEqual((r["from"]["number"], r["to"]["number"], r["to"]["live"], r["from"]["live"]), (1, 2, True, False))
        self.assertEqual((r["summary"]["added"], r["summary"]["edited"], r["summary"]["removed"]), (1, 1, 1))
        # And backwards.
        r = await self.get(f"/{self.sid}/compare", params={"from": b2["id"], "to": b1["id"]})
        self.assertEqual((r["summary"]["added"], r["summary"]["removed"]), (1, 1))
        # The first publish against nothing: every page is new.
        r = await self.get(f"/{self.sid}/compare", params={"from": "none", "to": b1["id"]})
        self.assertEqual((r["from"]["kind"], r["summary"]["added"], r["summary"]["settings"]), ("none", 6, []))

    async def test_refusals(self):
        r = await self.http.get(f"{BASE}/{self.sid}/compare", headers=self.h["stranger"])
        self.assertIn(r.status_code, (403, 404))
        await self.get(f"/{self.sid}/compare", params={"from": "drafts"}, expect=422)
        await self.get(f"/{self.sid}/compare", params={"to": str(ObjectId())}, expect=404)
        await self.get(f"/{self.sid}/compare", params={"to": "nope"}, expect=404)
        # Another guide's publish isn't this one's.
        other = await self.create("other")
        b = await self.call("POST", f"/{other['id']}/publish", expect=202)
        await self.get(f"/{self.sid}/compare", params={"from": b["id"]}, expect=404)


class HistoryAndStatus(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.site = await self.create("acme", source={"kind": "template", "template": "product"})
        self.sid = self.site["id"]

    async def test_history_summaries_and_progress(self):
        st = await self.get(f"/{self.sid}/publish-status", "viewer")
        self.assertEqual((st["count"], st["ever_published"], st["running"], st["live"]), (6, False, None, None))
        self.assertEqual(st["summary"]["added"], 6)

        b1 = await self.call("POST", f"/{self.sid}/publish", expect=202)
        # Running: the job's progress becomes the build's.
        await self.db["docs_builds"].update_one({"_id": ObjectId(b1["id"])},
                                                {"$set": {"status": "building", "started_at": now()}})
        await self.db["docs_jobs"].update_one({"_id": ObjectId(b1["job"]["id"])}, {"$set": {
            "status": "running", "progress": {"step": "build", "done": 26, "total": 52, "message": ""}}})
        st = await self.get(f"/{self.sid}/publish-status")
        self.assertEqual((st["running"]["number"], st["running"]["progress"]["stage"],
                          st["running"]["progress"]["pages_done"], st["running"]["progress"]["pages_total"]),
                         (1, "pages", 3, 6))
        builds = await self.get(f"/{self.sid}/builds")
        self.assertEqual(builds[0]["progress"]["percent"], 60)  # rendering: 48 + half of 24
        self.assertEqual(builds[0]["changes"]["added"], 6)

        await self.db["docs_builds"].update_one({"_id": ObjectId(b1["id"])}, {"$set": {"stats": {"ms": 40_000}}})
        await self.mark_live(b1["id"])
        home = await self.home(self.sid)
        await self.call("PUT", f"/{self.sid}/pages/{home['id']}", json={
            "base_rev": home["rev"], "markdown": home["markdown"] + "More.\n"})
        await self.call("PATCH", f"/{self.sid}", json={"settings": {"theme": {"preset": "minimal"}}})
        st = await self.get(f"/{self.sid}/publish-status")
        self.assertEqual((st["count"], st["summary"]["edited"], st["summary"]["design"], st["live"]["number"]),
                         (2, 1, True, 1))
        b2 = await self.call("POST", f"/{self.sid}/publish", expect=202)
        # A failed publish in between doesn't count as the one before.
        await self.db["docs_builds"].update_one({"_id": ObjectId(b2["id"])}, {"$set": {"status": "failed"}})
        b3 = await self.call("POST", f"/{self.sid}/publish", expect=202)
        await self.mark_live(b3["id"])
        builds = {b["number"]: b for b in await self.get(f"/{self.sid}/builds", "viewer")}
        self.assertEqual((builds[3]["changes"]["edited"], builds[3]["changes"]["design"], builds[3]["changes"]["added"]),
                         (1, True, 0))
        self.assertEqual(builds[1]["changes"]["added"], 6)
        self.assertNotIn("progress", builds[3])
        # The history window can start after the publish it compares against.
        last = await self.get(f"/{self.sid}/builds", params={"limit": 1})
        self.assertEqual((last[0]["number"], last[0]["changes"]["edited"]), (3, 1))

    async def test_setup_checklist(self):
        s = await self.get(f"/{self.sid}/setup", "viewer")
        self.assertEqual((s["pages"], s["look_chosen"], s["published"], s["own_domain"], s["insights_data"]),
                         (6, False, False, False, False))
        # Owner, admin, editor and viewer have a Guides role on it.
        self.assertEqual(s["team"], 4)
        await self.call("PATCH", f"/{self.sid}", json={"settings": {"theme": {"preset": "clean"}}})
        b = await self.call("POST", f"/{self.sid}/publish", expect=202)
        await self.mark_live(b["id"])
        await self.db["guide_events"].insert_one({"site": self.sid, "k": "view", "ts": now(), "day": "2026-11-01", "p": "/"})
        s = await self.get(f"/{self.sid}/setup")
        self.assertEqual((s["look_chosen"], s["published"], s["insights_data"]), (True, True, True))
        personal = await self.create("mine", workspace=False)
        self.assertIsNone((await self.get(f"/{personal['id']}/setup"))["team"])


if __name__ == "__main__":
    unittest.main()
