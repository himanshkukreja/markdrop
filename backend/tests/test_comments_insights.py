"""Comment analytics (Track C, services/comments/analytics.py): an item's numbers (open / resolved, time to first
reply and to resolve, most-discussed sections, series, people), who may see them, the admin totals, and the MCP
tools (comment_insights; comments in get_document_analytics)."""

from __future__ import annotations

from tests._comments_reach import ReachWorld, T, now, timedelta

from app.services.comments import analytics


class Insights(ReachWorld):
    async def discussed(self) -> dict:
        doc = await self.item(title="Launch plan")
        t0 = now() - timedelta(hours=3)
        a = await self.thread(doc, "owner", quote="frontend", at=t0)                               # no reply, open
        b = await self.thread(doc, "owner", quote="payments API", block_id="b-risk01", at=t0)
        await self.message(b, "wa", "Load test it", at=t0 + timedelta(minutes=10))
        await self.message(b, "owner", "Will do", at=t0 + timedelta(minutes=12))
        c = await self.thread(doc, "wm", quote="still flaky", block_id=None, at=t0)
        await self.message(c, "owner", "Agreed", at=t0 + timedelta(minutes=30))
        await self.db[T].update_one({"_id": c["_id"]}, {"$set": {"status": "resolved", "resolved_by": self.uid["owner"],
                                                                 "resolved_at": t0 + timedelta(hours=2)}})
        await self.db["documents"].update_one({"_id": doc["_id"]}, {"$inc": {"comment_counts.open": -1,
                                                                             "comment_counts.resolved": 1}})
        d = await self.thread(doc, "wa", quote=None, block_id=None, kind="page", at=t0)            # page-level
        e = await self.thread(doc, "wa", quote="gone words", block_id=None, anchor_status="changed", at=t0)
        # An AI answer doesn't count as a first reply.
        m = await self.message(e, "owner", "AI says hi", at=t0 + timedelta(minutes=1))
        await self.db["comment_messages"].update_one({"_id": m["_id"]}, {"$set": {"ai": True, "author_id": None}})
        # A deleted thread isn't counted.
        x = await self.thread(doc, "wa", quote="Budget")
        await self.db[T].update_one({"_id": x["_id"]}, {"$set": {"deleted_at": now()}})
        return {"doc": doc, "a": a, "b": b, "c": c, "d": d, "e": e}

    async def test_the_numbers(self):
        w = await self.discussed()
        s = await analytics.item_stats(self.db, await self.doc(w["doc"]["slug"]), range_="7d")
        self.assertEqual(s["counts"], {"total": 5, "open": 4, "resolved": 1, "messages": 9, "participants": 3,
                                       "changed": 1})
        self.assertEqual(s["first_reply"]["replied"], 2)
        self.assertEqual(s["first_reply"]["median_s"], 20 * 60.0)        # 10 and 30 minutes
        self.assertEqual(s["first_reply"]["waiting"], 3)                 # a, d, e (the AI answer doesn't count)
        self.assertEqual(s["resolve"], {"median_s": 7200.0, "resolved": 1})
        secs = {x["title"]: x for x in s["sections"]}
        self.assertEqual(secs["Risks"]["threads"], 2)
        self.assertEqual(s["sections"][0]["title"], "Risks")
        self.assertEqual(secs["Launch plan"]["threads"], 1)
        self.assertEqual(secs["Whole page"]["threads"], 1)
        self.assertEqual(secs["Text that changed"]["threads"], 1)
        self.assertEqual(len(s["series"]), 7)
        self.assertEqual(sum(d["threads"] for d in s["series"]), 5)
        self.assertEqual(s["people"][0]["name"], "OWNER")
        self.assertNotIn("email", s["people"][0])
        line = analytics.summary_line(s, "Launch plan")
        self.assertIn("5 comment threads (4 open, 1 resolved", line)
        self.assertIn("Most discussed: “Risks”", line)

    async def test_who_may_see_them(self):
        w = await self.discussed()
        url = f"/api/v1/documents/{w['doc']['slug']}/comments/insights"
        r = await self.http.get(url, headers=self.session("wv"))                 # a workspace viewer
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["counts"]["open"], 4)
        self.assertIn("summary", r.json())
        self.assertEqual((await self.http.get(url)).status_code, 401)            # anonymous, not public
        self.assertEqual((await self.http.get(url, headers=self.session("stranger"))).status_code, 404)
        await self.db["documents"].update_one({"_id": w["doc"]["_id"]}, {"$set": {"comments_off": True}})
        self.assertEqual((await self.http.get(url, headers=self.session("wv"))).status_code, 403)
        art = await self.mkdoc("W", kind="artifact")
        r = await self.http.get(f"/api/v1/documents/{art['slug']}/comments/insights", headers=self.session("owner"))
        self.assertEqual((r.status_code, r.json().get("code")), (404, "comments_unavailable"))

    async def test_admin_totals(self):
        from tests._admin_session import admin_headers

        await self.discussed()
        r = await self.http.get("/api/v1/admin/analytics/comments", headers=self.session("owner"))
        self.assertIn(r.status_code, (401, 403, 404))
        r = await self.http.get("/api/v1/admin/analytics/comments?range=7d", headers=await admin_headers(self.db))
        self.assertEqual(r.status_code, 200, r.text)
        k = r.json()["kpis"]
        self.assertEqual((k["threads"], k["open_now"], k["resolved"], k["items"], k["ai_answers"]), (5, 4, 1, 1, 1))
        self.assertEqual(k["median_first_reply_s"], 20 * 60.0)
        self.assertEqual(r.json()["top_items"][0]["threads"], 5)

    async def test_mcp(self):
        w = await self.discussed()
        out = await self.mcp("wm", "comment_insights", {"document": w["doc"]["slug"]}, write=False)
        self.assertEqual(out["counts"]["open"], 4)
        self.assertEqual(out["sections"][0]["title"], "Risks")
        self.assertIn("comment threads", out["summary"])
        status, res = await self.mcp_call(await self.mcp_token("stranger", write=False), "comment_insights",
                                          {"document": w["doc"]["slug"]})
        self.assertTrue(res["isError"])
        ga = await self.mcp("owner", "get_document_analytics", {"document": w["doc"]["slug"]}, write=False)
        self.assertEqual((ga["comments"]["open"], ga["comments"]["resolved"]), (4, 1))
        self.assertEqual(ga["comments"]["median_first_reply_s"], 20 * 60.0)
