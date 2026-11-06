"""The Meetings list, a page at a time (services/meetings_list.py; owner 2026-11-06 "the meetings page took a
lot of time to load").

Cursor pagination in every order (same dates, times and titles across page boundaries: no meeting twice,
none skipped; meetings without a date last), access across pages (a restricted meeting is invisible to a
member who wasn't there on every page; an admin sees it only as a hidden entry, on the first page), filters
and search with paging, the card projection (no transcript, notes or AI sections), bounded queries per page,
the ETag, /series facets, and MCP ``list_meetings`` paging. The model is the fake client.
"""

from __future__ import annotations

import secrets
from copy import deepcopy
from datetime import timedelta

from tests.test_meetings import MeetingsWorld

from bson import ObjectId

from app.services import meetings_list

NAMES = ["Ada Lovelace", "Bo Chen", "Priya Sharma", "Ravi Kumar", "Lena Ortiz", "Sam Patel", "Kim Lee"]


class ListWorld(MeetingsWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        m = await self.imported()
        self.tpl_row = await self.db["meetings"].find_one({"_id": ObjectId(m["id"])})
        self.tpl_page = await self.db["documents"].find_one({"_id": ObjectId(self.tpl_row["doc_id"])})
        # The template restricted to attendees (Ada, Bo, Priya, Ravi get grants; wo, an admin, and ownv don't).
        r = await self.http.patch(f"/api/v1/meetings/{m['id']}", headers=self.session("owner"), json={"restricted": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.tpl_grants = await self.db["document_grants"].find({"document_id": str(self.tpl_page["_id"])}).to_list(20)
        self.assertTrue(self.tpl_grants)
        await self.db["meetings"].delete_one({"_id": self.tpl_row["_id"]})
        await self.db["documents"].delete_one({"_id": self.tpl_page["_id"]})
        await self.db["document_grants"].delete_many({"document_id": str(self.tpl_page["_id"])})
        self.base = self.tpl_row["created_at"]

    async def seed(self, specs: list[dict]) -> list[str]:
        """Meetings cloned from the imported one: each spec overrides row fields; ``restricted`` makes the
        page private with the attendees' grants (as Restrict to attendees does)."""
        rows, docs, grants, ids = [], [], [], []
        for i, spec in enumerate(specs):
            r, d = deepcopy(self.tpl_row), deepcopy(self.tpl_page)
            r["_id"], d["_id"] = ObjectId(), ObjectId()
            d["slug"] = f"m{i}-{secrets.token_hex(4)}"
            d["meeting_id"], r["doc_id"] = str(r["_id"]), str(d["_id"])
            r["created_at"] = self.base - timedelta(seconds=i)
            restricted = spec.pop("restricted", False)
            r.update(spec)
            r["restricted"] = restricted
            d["access_level"] = "private" if restricted else "workspace"
            if restricted:
                for g in self.tpl_grants:
                    grants.append({**{k: v for k, v in g.items() if k != "_id"}, "document_id": str(d["_id"])})
            rows.append(r)
            docs.append(d)
            ids.append(str(r["_id"]))
        await self.db["documents"].insert_many(docs)
        await self.db["meetings"].insert_many(rows)
        if grants:
            await self.db["document_grants"].insert_many(grants)
        return ids

    async def page(self, who: str, **params) -> dict:
        r = await self.http.get("/api/v1/meetings", headers=self.session(who), params={"workspace": self.W, **params})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def walk(self, who: str, **params) -> tuple[list[dict], list[dict]]:
        """Every page; returns (all meetings in order, the pages' answers)."""
        out, pages, cursor = [], [], None
        for _ in range(100):
            got = await self.page(who, **params, **({"cursor": cursor} if cursor else {}))
            pages.append(got)
            out += got["meetings"]
            cursor = got["next_cursor"]
            if not cursor:
                return out, pages
        self.fail("the cursor never ended")


class Paging(ListWorld):
    async def test_date_order_with_ties_no_dupes_no_gaps(self):
        # 37 meetings over 6 days: several on the same date, some at the same time, two without a date.
        specs = []
        for i in range(35):
            specs.append({"date": f"2026-10-{10 + i // 6:02d}", "time": ["09:00", "09:00", "14:30", None, "11:00", "09:00"][i % 6],
                          "title": f"Call {i}", "series": None})
        specs += [{"date": None, "time": None, "title": "Undated A"}, {"date": None, "time": "10:00", "title": "Undated B"}]
        ids = await self.seed(specs)
        expect = sorted(range(len(specs)), key=lambda i: (specs[i]["date"] is not None, specs[i]["date"] or "",
                                                           specs[i]["time"] is not None, specs[i]["time"] or "",
                                                           ids[i]), reverse=True)
        for limit in (1, 5, 7, 30):
            got, pages = await self.walk("wm", limit=limit)
            self.assertEqual([m["id"] for m in got], [ids[i] for i in expect], f"limit={limit}")
            self.assertTrue(all(len(p["meetings"]) <= limit for p in pages))
            self.assertEqual(pages[0]["total"], len(specs))
            self.assertTrue(all(p["total"] is None for p in pages[1:]))
        self.assertEqual([m["title"] for m in got[-2:]], ["Undated B", "Undated A"])

    async def test_oldest_first_keeps_undated_last(self):
        specs = [{"date": f"2026-09-{1 + i // 3:02d}", "time": ["10:00", None, "10:00"][i % 3], "title": f"C{i}"} for i in range(14)]
        specs += [{"date": None, "time": None, "title": "No date 1"}, {"date": None, "time": None, "title": "No date 2"}]
        ids = await self.seed(specs)
        got, _ = await self.walk("wm", limit=4, sort="date_asc")
        self.assertEqual(len(got), len(specs))
        self.assertEqual(len({m["id"] for m in got}), len(specs))
        dated = [m for m in got if m["date"]]
        self.assertEqual(got[:len(dated)], dated)
        self.assertEqual([(m["date"], m["time"] or "") for m in dated], sorted((m["date"], m["time"] or "") for m in dated))
        self.assertEqual({m["title"] for m in got[-2:]}, {"No date 1", "No date 2"})
        self.assertEqual(set(ids), {m["id"] for m in got})

    async def test_title_order_any_case_and_imported_order(self):
        titles = ["beta", "Alpha", "alpha", "Gamma", "BETA", "delta", "Alpha", "epsilon"]
        ids = await self.seed([{"title": t, "date": f"2026-08-{i + 1:02d}", "time": "10:00"} for i, t in enumerate(titles)])
        got, _ = await self.walk("wm", limit=3, sort="title")
        self.assertEqual([m["title"].casefold() for m in got], sorted(t.casefold() for t in titles))
        self.assertEqual(len({m["id"] for m in got}), len(titles))
        # Within one title (any case): newest first.
        alphas = [m["date"] for m in got if m["title"].casefold() == "alpha"]
        self.assertEqual(alphas, sorted(alphas, reverse=True))
        got, _ = await self.walk("wm", limit=3, sort="imported")
        self.assertEqual([m["id"] for m in got], ids)          # seeded newest import first

    async def test_cursor_from_another_order_or_garbage_is_refused(self):
        await self.seed([{"title": f"T{i}", "date": "2026-10-01"} for i in range(4)])
        first = await self.page("wm", limit=2)
        r = await self.http.get("/api/v1/meetings", headers=self.session("wm"),
                                params={"workspace": self.W, "limit": 2, "sort": "title", "cursor": first["next_cursor"]})
        self.assertEqual(r.status_code, 422)
        for bad in ("nope", "eyJzIjoiZGF0ZV9kZXNjIn0", "e30"):
            r = await self.http.get("/api/v1/meetings", headers=self.session("wm"),
                                    params={"workspace": self.W, "cursor": bad})
            self.assertEqual(r.status_code, 422, bad)
        r = await self.http.get("/api/v1/meetings", headers=self.session("wm"), params={"workspace": self.W, "limit": 101})
        self.assertEqual(r.status_code, 422)

    def test_after_builder(self):
        keys = (("date", -1), ("time", -1), ("_id", -1))
        q = meetings_list.after(keys, [None, None, ObjectId("0" * 24)])
        # Descending past a null date: only the same (null) date with a smaller _id.
        self.assertEqual(q, {"$or": [{"date": None, "time": None,
                                      "$or": [{"_id": {"$lt": ObjectId("0" * 24)}}, {"_id": None}]}]})
        self.assertEqual(meetings_list.after((("_id", -1),), [None]), {"_id": {"$exists": False}})


class Access(ListWorld):
    async def test_restricted_invisible_on_every_page(self):
        specs = []
        for i in range(40):
            specs.append({"title": f"{'Secret' if i % 3 == 0 else 'Open'} {i}", "date": f"2026-10-{1 + i // 4:02d}",
                          "time": "10:00", "restricted": i % 3 == 0})
        ids = await self.seed(specs)
        secret = {ids[i] for i in range(40) if i % 3 == 0}
        # ownv (a viewer who wasn't there): every open meeting, never a restricted one, across pages of 4.
        got, pages = await self.walk("ownv", limit=4)
        self.assertEqual(len(got), 40 - len(secret))
        self.assertFalse(secret & {m["id"] for m in got})
        self.assertTrue(all(len(p["meetings"]) == 4 for p in pages[:-1]))   # pages filled past skipped rows
        self.assertEqual(pages[0]["total"], 40 - len(secret))
        self.assertEqual(sum(len(p["hidden"]) for p in pages), 0)
        # Bo (an attendee with a grant): all of them.
        got, pages = await self.walk("wm", limit=4)
        self.assertEqual({m["id"] for m in got}, set(ids))
        self.assertEqual(pages[0]["total"], 40)
        # wo (the workspace's owner, not an attendee): the open ones, and the restricted ones as hidden
        # entries (no title) on the first page only — none with a filter.
        got, pages = await self.walk("wo", limit=4)
        self.assertFalse(secret & {m["id"] for m in got})
        self.assertEqual({h["id"] for h in pages[0]["hidden"]}, secret)
        self.assertTrue(all("title" not in h for h in pages[0]["hidden"]))
        self.assertTrue(all(p["hidden"] == [] for p in pages[1:]))
        self.assertTrue(all(m["can_delete"] for m in got))
        self.assertEqual((await self.page("wo", q="Secret"))["hidden"], [])
        # A stranger: no list at all.
        r = await self.http.get("/api/v1/meetings", headers=self.session("stranger"), params={"workspace": self.W})
        self.assertEqual(r.status_code, 404)

    async def test_all_restricted_run_longer_than_a_batch(self):
        # 45 restricted in a row, then 3 open: the scan goes past whole batches of unreadable rows.
        specs = [{"title": f"S{i}", "date": "2026-10-20", "time": f"{10 + i // 60:02d}:{i % 60:02d}", "restricted": True}
                 for i in range(45)]
        specs += [{"title": f"Open {i}", "date": "2026-10-01", "time": "09:00"} for i in range(3)]
        await self.seed(specs)
        got = await self.page("ownv", limit=2)
        self.assertEqual(len(got["meetings"]), 2)
        self.assertTrue(all(m["title"].startswith("Open") for m in got["meetings"]))
        rest = await self.page("ownv", limit=2, cursor=got["next_cursor"])
        self.assertEqual(len(rest["meetings"]), 1)
        self.assertIsNone(rest["next_cursor"])


class Filters(ListWorld):
    async def test_search_series_dates_with_paging(self):
        specs = []
        for i in range(24):
            specs.append({"title": "Daily Standup" if i % 2 == 0 else f"Pricing review {i}",
                          "series": "Daily Standup" if i % 2 == 0 else None, "date": f"2026-10-{1 + i:02d}", "time": "09:30",
                          "attendees": [{"name": NAMES[j % len(NAMES)], "user_id": None} for j in range(i % 4, i % 4 + 3)]})
        specs.append({"title": "Kickoff", "series": "Launch", "date": "2026-10-28", "attendees": [{"name": "Zara Quinn", "user_id": None}]})
        await self.seed(specs)
        # Series (any case), across pages.
        got, pages = await self.walk("wm", limit=5, series="daily standup")
        self.assertEqual(len(got), 12)
        self.assertEqual(pages[0]["total"], 12)
        self.assertTrue(all(m["series"] == "Daily Standup" for m in got))
        got, _ = await self.walk("wm", limit=5, series="none")
        self.assertEqual(len(got), 12)
        # Search: titles, series and people.
        got, _ = await self.walk("wm", limit=3, q="pricing")
        self.assertEqual(len(got), 12)
        got, _ = await self.walk("wm", limit=3, q="launch")
        self.assertEqual([m["title"] for m in got], ["Kickoff"])
        got, _ = await self.walk("wm", limit=3, q="zara")
        self.assertEqual([m["title"] for m in got], ["Kickoff"])
        lena = [i for i, s in enumerate(specs) if any(a["name"] == "Lena Ortiz" for a in s["attendees"])]
        got, _ = await self.walk("wm", limit=2, q="LENA")
        self.assertEqual(len(got), len(lena))
        # A regex character is just a character.
        self.assertEqual((await self.page("wm", q="(.*"))["meetings"], [])
        # Dates with paging.
        got, _ = await self.walk("wm", limit=4, since="2026-10-10", until="2026-10-19")
        self.assertEqual(len(got), 10)
        self.assertTrue(all("2026-10-10" <= m["date"] <= "2026-10-19" for m in got))
        # Series + search together.
        got, _ = await self.walk("wm", limit=2, series="Daily Standup", q="lena")
        self.assertTrue(got and all(m["series"] == "Daily Standup" for m in got))

    async def test_series_facets(self):
        await self.seed([{"series": "Daily Standup", "date": "2026-10-01"}, {"series": "Daily Standup", "date": "2026-10-03"},
                         {"series": "Design review", "date": "2026-10-02", "restricted": True},
                         {"series": None, "date": "2026-10-04"}, {"series": "", "date": "2026-10-05"}])
        r = await self.http.get("/api/v1/meetings/series", headers=self.session("ownv"), params={"workspace": self.W})
        self.assertEqual(r.json(), {"series": [{"name": "Daily Standup", "count": 2, "last": "2026-10-03"}],
                                    "total": 4, "one_offs": 2})
        r = await self.http.get("/api/v1/meetings/series", headers=self.session("wm"), params={"workspace": self.W})
        self.assertEqual(r.json()["total"], 5)
        self.assertEqual([s["name"] for s in r.json()["series"]], ["Daily Standup", "Design review"])


class Cards(ListWorld):
    async def test_card_is_light_and_counts_are_right(self):
        big = [{"t": i, "speaker": "Ada Lovelace", "text": "x" * 400} for i in range(500)]
        many = [{"name": n, "user_id": None} for n in NAMES]
        await self.seed([{"title": "Big one", "date": "2026-10-01", "segments": big, "attendees": many,
                          "notes": {"summary": "Notes summary " * 50, "details": ["d" * 2000] * 5}}])
        got = (await self.page("wm"))["meetings"][0]
        for heavy in ("notes", "generated", "sources", "organizer", "imported_by", "transcript"):
            self.assertNotIn(heavy, got)
        self.assertEqual((got["segments"], got["has_transcript"], got["has_notes"]), (500, True, True))
        self.assertEqual(len(got["attendees"]), 5)
        self.assertEqual(got["attendee_count"], len(NAMES))
        self.assertLessEqual(len(got["summary"]), meetings_list.SUMMARY_CHARS + 1)
        self.assertTrue(got["cover"])
        self.assertIn(got["ai"]["state"], ("done", "skipped", "pending", "failed"))
        self.assertLess(len(str(got)), 2500)
        # The detail endpoint still has everything.
        full = (await self.http.get(f"/api/v1/meetings/{got['id']}", headers=self.session("wm"))).json()
        self.assertEqual(len(full["attendees"]), len(NAMES))
        self.assertIn("sources", full)

    async def test_queries_per_page_are_bounded(self):
        await self.seed([{"title": f"M{i}", "date": f"2026-09-{1 + i % 28:02d}", "restricted": i % 5 == 0} for i in range(90)])
        counts = []
        for limit in (10, 40):
            await self.db.command({"profile": 0})
            await self.db["system.profile"].drop()
            await self.db.command({"profile": 2})
            got = await self.page("wm", limit=limit)
            await self.db.command({"profile": 0})
            self.assertEqual(len(got["meetings"]), limit)
            counts.append(await self.db["system.profile"].count_documents({"ns": {"$regex": r"\.(documents|meetings|memberships|users)$"}}))
        # Not one query per meeting: the same handful whether a page has 10 or 40.
        self.assertLessEqual(counts[1], counts[0] + 2)
        self.assertLess(counts[1], 20)

    async def test_etag_304(self):
        await self.seed([{"title": "One", "date": "2026-10-01"}])
        r = await self.http.get("/api/v1/meetings", headers=self.session("wm"), params={"workspace": self.W})
        tag = r.headers["etag"]
        self.assertIn("private", r.headers["cache-control"])
        r2 = await self.http.get("/api/v1/meetings", headers={**self.session("wm"), "If-None-Match": tag},
                                 params={"workspace": self.W})
        self.assertEqual(r2.status_code, 304)
        self.assertEqual(r2.content, b"")
        await self.seed([{"title": "Two", "date": "2026-10-02"}])
        r3 = await self.http.get("/api/v1/meetings", headers={**self.session("wm"), "If-None-Match": tag},
                                 params={"workspace": self.W})
        self.assertEqual(r3.status_code, 200)
        self.assertEqual(r3.json()["meetings"][0]["title"], "Two")


class MCPPaging(ListWorld):
    async def test_list_meetings_cursor(self):
        await self.seed([{"title": f"M{i}", "date": f"2026-10-{1 + i:02d}", "attendees": [{"name": n, "user_id": None} for n in NAMES]}
                         for i in range(7)])
        tok = await self.mcp_token("wm")
        seen, cursor = [], None
        for _ in range(10):
            code, res = await self.mcp_call(tok, "list_meetings", {"workspace": self.W, "limit": 3, **({"cursor": cursor} if cursor else {})})
            self.assertEqual(code, 200)
            self.assertFalse(res.get("isError"), res)
            sc = res["structuredContent"]
            seen += [m["id"] for m in sc["meetings"]]
            self.assertEqual(len(sc["meetings"][0]["attendees"]), len(NAMES))    # MCP gets every name
            cursor = sc["next_cursor"]
            if cursor:
                self.assertIn("cursor=", res["content"][0]["text"])
            else:
                break
        self.assertEqual(len(seen), 7)
        self.assertEqual(len(set(seen)), 7)
