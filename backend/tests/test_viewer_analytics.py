"""Viewer analytics (services/doc_views.py): every view, who it was, where from, on what, and the
activity timeline.

Ingest through the real engagement beacon (seq idempotency, caps, encrypted documents, the
owner's own views, tenant tokens), identity and access rules (owner, workspace admins / editors,
viewers get counts, strangers nothing), timeline assembly per kind, the system / location /
source parsing, retention (TTL, deleting a document, forgetting a person), the CSV, the person
rollup and the two MCP tools.
"""

from __future__ import annotations

from tests import _email_env  # noqa: F401  (pins settings first)

import csv
import io
import json
import secrets
from datetime import timedelta
from unittest import mock

from tests._access_env import AccessWorld, now

from app.services import doc_views as dv
from app.services import engage, geo, presence

MAC_CHROME = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/131.0.0.0 Safari/537.36")
IPHONE_SLACK = ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) "
                "Mobile/15E148 Slack/24.10.10 Safari/604.1")
ANDROID = ("Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) "
           "Chrome/130.0.0.0 Mobile Safari/537.36")
WIN_EDGE = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0")
GEO = {"10.0.0.1": {"country": "IN", "region": "Maharashtra", "city": "Mumbai"},
       "10.0.0.2": {"country": "DE", "region": "Berlin", "city": "Berlin"}}


def sid() -> str:
    return "s" + secrets.token_hex(8)


def bid() -> str:
    return "b" + secrets.token_hex(8)


class World(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await engage.ensure_indexes(self.db)
        await dv.ensure_indexes(self.db)
        engage.clear_pending()
        presence.clear()
        p = mock.patch.object(geo, "lookup", lambda ip: GEO.get(ip, {"country": None, "region": None, "city": None}))
        p.start()
        self.addCleanup(p.stop)
        self.addCleanup(presence.clear)
        self.addCleanup(engage.clear_pending)

    async def beacon(self, slug: str, body: dict | str, *, ua: str = MAC_CHROME, ip: str = "10.0.0.1",
                     headers: dict | None = None):
        content = body if isinstance(body, str) else json.dumps(body)
        return await self.http.post(f"/api/v1/documents/{slug}/engage", content=content,
                                    headers={"User-Agent": ua, "X-Real-IP": ip, "Content-Type": "text/plain",
                                             **(headers or {})})

    def token(self, who: str) -> str:
        return self.session(who)["Authorization"].split()[1]

    async def views(self, doc: dict) -> list[dict]:
        return await self.db[dv.COLL].find({"doc_id": str(doc["_id"])}).sort("started_at", 1).to_list(length=100)

    async def view_as(self, doc: dict, *, who: str | None = None, ua: str = MAC_CHROME, ip: str = "10.0.0.1",
                      browser: str | None = None, ev: list | None = None, d: dict | None = None,
                      first: dict | None = None, final: bool = True) -> str:
        s = sid()
        body: dict = {"v": 1, "sid": s, "seq": 1, "final": final, "a": browser or bid(),
                      "first": first or {"vw": 1440, "sys": {"vw": 1440, "vh": 900, "lang": "en-IN",
                                                             "tz": "Asia/Kolkata", "app": "tab"}},
                      "d": d or {"active_s": 20, "depth": 60}, "ev": ev or []}
        if who:
            body["u"] = self.token(who)
        r = await self.beacon(doc["slug"], body, ua=ua, ip=ip)
        self.assertEqual(r.status_code, 204)
        return s

    async def listing(self, doc: dict, as_: str = "owner", **params):
        return await self.http.get(f"/api/v1/me/documents/{doc['slug']}/analytics/viewers", params=params,
                                   headers=self.session(as_))


# ── Ingest ────────────────────────────────────────────────────────────────────


class Ingest(World):
    async def test_anonymous_view_row(self):
        d = await self.mkdoc("L", ws=None)
        s = sid()
        b = bid()
        r = await self.beacon(d["slug"], {
            "v": 1, "sid": s, "seq": 1, "a": b,
            "first": {"ref": "https://app.slack.com/client/T1/C2?x=1", "sys": {
                "vw": 390, "vh": 844, "sw": 390, "sh": 844, "dpr": 3, "lang": "en-US", "tz": "Asia/Kolkata",
                "app": "pwa", "junk": 1}},
            "d": {"active_s": 12, "depth": 40},
            "ev": [{"t": 1, "k": "sec", "h": "user-content-intro", "a": 9},
                   {"t": 9, "k": "depth", "v": 25}, {"t": 10, "k": "nope"}, {"k": "depth", "v": 50},
                   {"t": 11, "k": "depth", "v": 33}],
        }, ua=IPHONE_SLACK)
        self.assertEqual(r.status_code, 204)
        [row] = await self.views(d)
        self.assertIsNone(row["viewer_id"])
        self.assertEqual(row["anon"], dv.anon_id(d["owner_id"], b, None, ""))
        self.assertEqual((row["country"], row["region"], row["city"]), ("IN", "Maharashtra", "Mumbai"))
        self.assertEqual((row["device"], row["os"], row["os_ver"], row["inapp"]), ("Mobile", "iOS", "18.1", "Slack"))
        self.assertEqual(row["source"], "Slack")
        self.assertEqual(row["sys"], {"vw": 390, "vh": 844, "sw": 390, "sh": 844, "dpr": 3.0, "lang": "en-US",
                                      "tz": "Asia/Kolkata", "app": "pwa"})
        self.assertEqual(row["ref"], "https://app.slack.com/client/T1/C2")
        self.assertEqual([e["k"] for e in row["tl"]], ["sec", "depth"])
        self.assertEqual((row["active_s"], row["depth"], row["kind"], row["own"]), (12, 40, "doc", False))
        # Nothing about the IP itself is kept on the view.
        self.assertNotIn("ip", row)
        self.assertNotIn("10.0.0.1", json.dumps(row, default=str))

    async def test_seq_idempotent_and_accumulates(self):
        d = await self.mkdoc("L", ws=None)
        s = sid()
        base = {"sid": s, "a": bid()}
        await self.beacon(d["slug"], {**base, "seq": 1, "d": {"active_s": 10, "depth": 30},
                                      "ev": [{"t": 1, "k": "depth", "v": 25}]})
        second = {**base, "seq": 2, "d": {"active_s": 5, "depth": 80}, "ev": [{"t": 20, "k": "depth", "v": 75}]}
        await self.beacon(d["slug"], second)
        await self.beacon(d["slug"], second)  # a retry
        await self.beacon(d["slug"], {**base, "seq": 1, "d": {"active_s": 99}})  # stale
        [row] = await self.views(d)
        self.assertEqual((row["seq"], row["active_s"], row["depth"], len(row["tl"])), (2, 15, 80, 2))
        # The per-send active time is clamped.
        await self.beacon(d["slug"], {**base, "seq": 3, "final": True, "d": {"active_s": 5000}})
        [row] = await self.views(d)
        self.assertEqual(row["active_s"], 15 + dv.SEND_CAP_S)
        self.assertTrue(row["ended"])

    async def test_racing_first_beacons_both_apply(self):
        # Two beacons of a new view arrive together: both create-or-update; neither is lost.
        import asyncio

        d = await self.mkdoc("L", ws=None)
        s = sid()
        await asyncio.gather(
            self.beacon(d["slug"], {"sid": s, "seq": 1, "d": {"active_s": 3}, "ev": [{"t": 1, "k": "depth", "v": 25}]}),
            self.beacon(d["slug"], {"sid": s, "seq": 2, "d": {"active_s": 4}, "ev": [{"t": 2, "k": "depth", "v": 50}]}))
        [row] = await self.views(d)
        # Whatever the order, seq 2 is kept; seq 1 too when it came first.
        self.assertEqual(row["seq"], 2)
        self.assertIn(50, [e["v"] for e in row["tl"]])

    async def test_event_caps_and_body_limit(self):
        d = await self.mkdoc("L", ws=None)
        s = sid()
        evs = [{"t": i, "k": "depth", "v": 25} for i in range(200)]
        await self.beacon(d["slug"], {"sid": s, "seq": 1, "ev": evs})
        [row] = await self.views(d)
        self.assertEqual(len(row["tl"]), dv.EV_PER_SEND)
        with mock.patch.object(dv, "TL_MAX", 70):
            await self.beacon(d["slug"], {"sid": s, "seq": 2, "ev": evs})
        [row] = await self.views(d)
        self.assertEqual(len(row["tl"]), 70)
        self.assertEqual(row["n_ev"], 2 * dv.EV_PER_SEND)
        # Over 16 KB: dropped whole.
        s2 = sid()
        await self.beacon(d["slug"], {"sid": s2, "seq": 1, "pad": "x" * 17000})
        self.assertEqual(len(await self.views(d)), 1)

    async def test_encrypted_keeps_no_content_events(self):
        d = await self.mkdoc("L", ws=None, encrypted=True)
        await self.view_as(d, ev=[{"t": 1, "k": "sec", "h": "user-content-x", "a": 5},
                                  {"t": 2, "k": "link", "u": "github.com/a"}, {"t": 3, "k": "copy", "h": "x"},
                                  {"t": 4, "k": "depth", "v": 50}])
        [row] = await self.views(d)
        self.assertEqual([e["k"] for e in row["tl"]], ["depth"])

    async def test_owner_view_recorded_as_own_not_in_aggregates(self):
        d = await self.mkdoc("L", ws=None)
        s = await self.view_as(d, who="owner")
        [row] = await self.views(d)
        self.assertTrue(row["own"])
        self.assertEqual(row["viewer_id"], self.uid["owner"])
        self.assertIsNone(await self.db["engage_sessions"].find_one({"sid": s}))
        res = (await self.listing(d)).json()
        self.assertEqual(res["totals"]["views"], 0)
        self.assertEqual(res["totals"]["own_hidden"], 1)
        res = (await self.listing(d, own=1)).json()
        self.assertEqual(res["totals"]["views"], 1)
        self.assertTrue(res["views"][0]["own"])

    async def test_signed_in_viewer_identified(self):
        d = await self.mkdoc("L", ws=None)
        await self.view_as(d, who="stranger")
        await self.view_as(d)
        res = (await self.listing(d)).json()
        self.assertEqual(res["totals"], {**res["totals"], "views": 2, "signed_in": 1, "anonymous": 1, "people": 2})
        named = [v for v in res["views"] if v["viewer"]["type"] == "user"][0]
        self.assertEqual((named["viewer"]["name"], named["viewer"]["email"]), ("STRANGER", self.email["stranger"]))
        anon = [v for v in res["views"] if v["viewer"]["type"] == "anonymous"][0]
        self.assertIsNone(anon["viewer"]["email"])
        self.assertTrue(anon["viewer"]["name"].startswith("Visitor "))
        # Filters.
        only = (await self.listing(d, who="anonymous")).json()
        self.assertEqual([v["viewer"]["type"] for v in only["views"]], ["anonymous"])

    async def test_member_marked_internal_and_tenant_token_on_its_workspace(self):
        d = await self.mkdoc("L")  # filed in W1
        await self.view_as(d, who="wm")
        s = sid()
        tenant = self.tenant("wm", "W1")["Authorization"].split()[1]
        await self.beacon(d["slug"], {"sid": s, "seq": 1, "u": tenant, "d": {"active_s": 3}})
        other = await self.mkdoc("L", ws="W2", owner="wm2")
        s2 = sid()
        await self.beacon(other["slug"], {"sid": s2, "seq": 1, "u": tenant, "d": {"active_s": 3}})
        rows = await self.views(d)
        self.assertEqual([(r["viewer_id"], r["internal"]) for r in rows],
                         [(self.uid["wm"], True), (self.uid["wm"], True)])
        # A tenant token for another workspace names nobody.
        [row] = await self.views(other)
        self.assertIsNone(row["viewer_id"])

    async def test_anon_id_stable_per_browser_and_owner(self):
        a = await self.mkdoc("L", ws=None)
        b = await self.mkdoc("L", ws=None)
        c = await self.mkdoc("L", ws=None, owner="stranger")
        browser = bid()
        for doc in (a, a, b, c):
            await self.view_as(doc, browser=browser)
        ids = {str(doc["_id"]): {r["anon"] for r in await self.views(doc)} for doc in (a, b, c)}
        self.assertEqual(len(ids[str(a["_id"])]), 1)
        self.assertEqual(ids[str(a["_id"])], ids[str(b["_id"])])
        self.assertNotEqual(ids[str(a["_id"])], ids[str(c["_id"])])
        res = (await self.listing(a)).json()
        self.assertEqual(sorted(v["visit_n"] for v in res["views"]), [1, 2])
        self.assertEqual(res["totals"]["people"], 1)

    async def test_artifact_ticket_admission(self):
        # A private file needs the read ticket the app gets with the document.
        from app.services import tickets

        d = await self.mkdoc("P", ws=None, kind="artifact", mime="application/pdf", file_version=1)
        await self.beacon(d["slug"], {"sid": sid(), "seq": 1, "d": {"active_s": 4}})
        self.assertEqual(await self.views(d), [])
        t = tickets.mint(str(d["_id"]), int(d.get("access_epoch") or 0))
        await self.beacon(d["slug"], {"sid": sid(), "seq": 1, "t": t, "d": {"active_s": 4, "npages": 10, "pmax": 3},
                                      "ev": [{"t": 1, "k": "pg", "p": 1, "a": 3}]})
        [row] = await self.views(d)
        self.assertEqual((row["kind"], row["ver"], row["npages"], row["pmax"]), ("pdf", 1, 10, 3))
        self.assertEqual(dv.completion(row), 30.0)


# ── Access ────────────────────────────────────────────────────────────────────


class Access(World):
    async def test_who_sees_what(self):
        d = await self.mkdoc("L")  # filed in W1: wa admin, wm member, wv viewer
        await self.view_as(d, who="stranger")
        url = f"/api/v1/me/documents/{d['slug']}/analytics/viewers"
        for who in ("owner", "wa", "wm", "wo", "ge"):
            r = await self.http.get(url, headers=self.session(who))
            self.assertEqual(r.status_code, 200, who)
            self.assertEqual(r.json()["access"], "full", who)
            self.assertEqual(r.json()["views"][0]["viewer"]["email"], self.email["stranger"], who)
        for who in ("wv", "gv"):
            r = await self.http.get(url, headers=self.session(who))
            self.assertEqual(r.status_code, 200, who)
            body = r.json()
            self.assertEqual(body["access"], "counts", who)
            self.assertNotIn("views", body)
            self.assertNotIn("breakdowns", body)
            self.assertEqual(body["totals"]["views"], 1)
            vid = str((await self.views(d))[0]["_id"])
            self.assertEqual((await self.http.get(f"{url}/{vid}", headers=self.session(who))).status_code, 403)
            self.assertEqual((await self.http.get(f"{url}.csv", headers=self.session(who))).status_code, 403)
        self.assertIn((await self.http.get(url, headers=self.session("stranger"))).status_code, (403, 404))
        self.assertEqual((await self.http.get(url)).status_code, 401)
        self.assertIn((await self.http.get(url, headers=self.tenant("owner", "W1"))).status_code, (401, 403))

    async def test_unfiled_item_owner_only(self):
        d = await self.mkdoc("L", ws=None)
        url = f"/api/v1/me/documents/{d['slug']}/analytics/viewers"
        self.assertEqual((await self.http.get(url, headers=self.session("owner"))).status_code, 200)
        for who in ("ge", "gv", "wa"):
            self.assertEqual((await self.http.get(url, headers=self.session(who))).status_code, 403, who)

    async def test_private_doc_not_readable_is_404(self):
        d = await self.mkdoc("P", ws=None, grants=False)
        url = f"/api/v1/me/documents/{d['slug']}/analytics/viewers"
        self.assertEqual((await self.http.get(url, headers=self.session("stranger"))).status_code, 404)


# ── Timelines ─────────────────────────────────────────────────────────────────


class Timelines(World):
    async def timeline(self, doc: dict, s: str, who: str = "owner") -> dict:
        row = await self.db[dv.COLL].find_one({"sid": s})
        r = await self.http.get(f"/api/v1/me/documents/{doc['slug']}/analytics/viewers/{row['_id']}",
                                headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def test_markdown_sections_jumps_links(self):
        d = await self.mkdoc("L", ws=None, content="# Intro\n\nx\n\n## Setup\n\ny\n\n## Usage\n\nz\n\n## Pricing\n\nw\n")
        s = await self.view_as(d, ev=[
            {"t": 0.5, "k": "sec", "h": "user-content-intro", "a": 80},
            {"t": 90, "k": "depth", "v": 25},
            {"t": 95, "k": "sec", "h": "user-content-pricing", "a": 30},
            {"t": 100, "k": "link", "u": "example.com/buy", "h": "user-content-pricing"},
            {"t": 110, "k": "copy", "h": "user-content-setup"},
            {"t": 120, "k": "sec", "h": "user-content-setup", "a": 10},
            {"t": 125, "k": "sec", "h": "user-content-setup", "a": 5},
            {"t": 130, "k": "print"}, {"t": 131, "k": "dl", "f": "pdf"},
        ], d={"active_s": 120, "depth": 100})
        tl = await self.timeline(d, s)
        texts = [x["text"] for x in tl["steps"]]
        self.assertEqual(texts[0], "Opened")
        self.assertIn("Read Intro · 1m 20s", texts)
        self.assertIn("Jumped to Pricing · 30s", texts)
        self.assertIn("Opened a link: example.com/buy", texts)
        self.assertIn("Copied a code block in Setup", texts)
        # Two consecutive visits to one section merge.
        self.assertIn("Went back to Setup · 15s", texts)
        self.assertIn("Printed it", texts)
        self.assertIn("Downloaded it as PDF", texts)
        self.assertTrue(texts[-1].startswith("Left after 2m"))
        self.assertEqual(tl["completion"], 100.0)
        self.assertIn("Read Intro · 1m 20s", tl["text"])

    async def test_video_watch_pause_seek_end(self):
        d = await self.mkdoc("L", ws=None, kind="artifact", mime="video/mp4", media={"duration_s": 300.0})
        s = await self.view_as(d, d={"active_s": 200, "media": {"dur": 300, "segs": [[0, 190], [240, 300]],
                                                                 "plays": 2, "ended": 1}},
                               ev=[{"t": 1, "k": "play", "s": 0}, {"t": 191, "k": "pause", "s": 190},
                                   {"t": 195, "k": "play", "s": 190}, {"t": 196, "k": "seek", "f": 191, "s": 240},
                                   {"t": 197, "k": "rate", "r": 1.5}, {"t": 198, "k": "fs", "on": True},
                                   {"t": 240, "k": "end", "s": 300}])
        tl = await self.timeline(d, s)
        texts = [x["text"] for x in tl["steps"]]
        self.assertIn("Watched 0:00–3:10", texts)
        self.assertIn("Paused at 3:10", texts)
        self.assertIn("Skipped ahead from 3:11 to 4:00", texts)
        self.assertIn("Watched 4:00–5:00", texts)
        self.assertIn("Watched to the end", texts)
        self.assertIn("Changed speed to 1.5×", texts)
        self.assertIn("Went full screen", texts)
        self.assertEqual(tl["completion"], 83.3)
        self.assertEqual(tl["watched_s"], 250.0)

    async def test_open_watch_closes_at_last_position(self):
        d = await self.mkdoc("L", ws=None, kind="artifact", mime="video/mp4")
        s = sid()
        await self.beacon(d["slug"], {"sid": s, "seq": 1, "pos": {"s": 42.5}, "d": {"active_s": 40},
                                      "ev": [{"t": 2, "k": "play", "s": 0}]})
        tl = await self.timeline(d, s)
        self.assertIn("Watched 0:00–0:42", [x["text"] for x in tl["steps"]])

    async def test_pdf_slides_sheets(self):
        pdf = await self.mkdoc("L", ws=None, kind="artifact", mime="application/pdf")
        s = await self.view_as(pdf, d={"active_s": 30, "npages": 8, "pmax": 6},
                               ev=[{"t": 1, "k": "pg", "p": 1, "a": 10}, {"t": 11, "k": "pg", "p": 2, "a": 5},
                                   {"t": 16, "k": "pg", "p": 6, "a": 15}])
        texts = [x["text"] for x in (await self.timeline(pdf, s))["steps"]]
        self.assertEqual(texts[1:4], ["Read page 1 · 10s", "Read page 2 · 5s", "Jumped to page 6 · 15s"])
        deck = await self.mkdoc("L", ws=None, kind="artifact",
                                mime="application/vnd.openxmlformats-officedocument.presentationml.presentation")
        s = await self.view_as(deck, d={"active_s": 30, "nsl": 10, "smax": 4},
                               ev=[{"t": 1, "k": "sl", "n": 1, "a": 10}, {"t": 11, "k": "sl", "n": 4, "a": 20}])
        tl = await self.timeline(deck, s)
        self.assertEqual([x["text"] for x in tl["steps"]][1:3], ["Viewed slide 1 · 10s", "Jumped to slide 4 · 20s"])
        self.assertEqual(tl["completion"], 40.0)
        sheet = await self.mkdoc("L", ws=None, kind="artifact", mime="text/csv")
        s = await self.view_as(sheet, d={"active_s": 30, "ntab": 3, "tabs": [0, 2]},
                               ev=[{"t": 1, "k": "tab", "n": 0, "name": "Q3", "a": 10},
                                   {"t": 11, "k": "tab", "n": 2, "a": 4}])
        tl = await self.timeline(sheet, s)
        self.assertEqual([x["text"] for x in tl["steps"]][1:3], ["Viewed sheet “Q3” · 10s", "Jumped to sheet 3 · 4s"])
        self.assertEqual(tl["completion"], 66.7)

    async def test_ask_and_signoff_notes_join_the_view(self):
        d = await self.mkdoc("L", ws=None)
        s = await self.view_as(d, who="stranger", final=False)
        from app.routers.ask import _note_ask

        await _note_ask(self.db, d["slug"], self.uid["stranger"], "What's the price? mail me a@b.com", "t1")
        await dv.note_for_slug(self.db, d["slug"], self.uid["stranger"], {"k": "signoff", "o": "Approved"})
        # Nobody else's view is touched; a person with no recent view gets nothing.
        self.assertFalse(await dv.note(self.db, str(d["_id"]), self.uid["wm"], {"k": "ask", "q": "x"}))
        tl = await self.timeline(d, s)
        texts = [x["text"] for x in tl["steps"]]
        self.assertIn("Asked: “What's the price? mail me [email]”", texts)
        self.assertIn("Signed off: Approved", texts)
        self.assertEqual(tl["acts"], {"ask": 1, "signoff": 1})

    async def test_other_views_and_missing(self):
        d = await self.mkdoc("L", ws=None)
        b = bid()
        await self.view_as(d, browser=b)
        s = await self.view_as(d, browser=b)
        tl = await self.timeline(d, s)
        self.assertEqual((tl["visit_n"], len(tl["other_views"])), (2, 1))
        url = f"/api/v1/me/documents/{d['slug']}/analytics/viewers/"
        self.assertEqual((await self.http.get(url + "0" * 24, headers=self.session("owner"))).status_code, 404)
        self.assertEqual((await self.http.get(url + "nope", headers=self.session("owner"))).status_code, 404)
        # Another document's view isn't reachable through this one.
        other = await self.mkdoc("L", ws=None)
        row = await self.db[dv.COLL].find_one({"sid": s})
        r = await self.http.get(f"/api/v1/me/documents/{other['slug']}/analytics/viewers/{row['_id']}",
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 404)


# ── Parsing ───────────────────────────────────────────────────────────────────


class Parsing(World):
    async def test_ua_detail(self):
        u = dv.ua_detail(MAC_CHROME)
        self.assertEqual((u["device"], u["os"], u["os_ver"], u["browser"], u["browser_ver"]),
                         ("Desktop", "macOS", None, "Chrome", "131"))
        self.assertEqual(dv.ua_detail(MAC_CHROME, {"pv": "15.1.0"})["os_ver"], "15.1")
        self.assertEqual(dv.ua_detail(MAC_CHROME, {"touch": True})["os"], "iPadOS")
        a = dv.ua_detail(ANDROID)
        self.assertEqual((a["device"], a["os"], a["os_ver"], a["browser_ver"]), ("Mobile", "Android", "15", "130"))
        w = dv.ua_detail(WIN_EDGE, {"pv": "15.0.0"})
        self.assertEqual((w["os"], w["os_ver"], w["browser"], w["browser_ver"]), ("Windows", "11", "Edge", "131"))
        self.assertEqual(dv.ua_detail(WIN_EDGE)["os_ver"], "10/11")
        li = dv.ua_detail("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile/15E148 [LinkedInApp]")
        self.assertEqual((li["browser"], li["inapp"]), ("LinkedIn", "LinkedIn"))
        self.assertEqual(dv.system_line({**li}), "LinkedIn app on iOS 17.5")

    async def test_sources(self):
        self.assertEqual(dv.source_for("https://www.linkedin.com/feed", None, None, {}), "LinkedIn")
        self.assertEqual(dv.source_for("https://www.google.co.in/", None, None, {}), "Google")
        self.assertEqual(dv.source_for(None, "newsletter", None, {}), "Email")
        self.assertEqual(dv.source_for(None, None, None, {}), "Direct")
        self.assertEqual(dv.source_for(None, None, "WhatsApp", {}), "WhatsApp")
        self.assertEqual(dv.source_for(None, None, None, {"from": "/w/[workspace]"}), "Markdrop workspace")
        self.assertEqual(dv.source_for(None, "markdrop-guides", None, {}), "Markdrop Guide")
        self.assertEqual(dv.source_for(None, None, None, {"app": "embed", "emb": "acme.com"}), "Embedded on acme.com")
        self.assertEqual(dv.source_for("https://blog.acme.io/post", None, None, {}), "blog.acme.io")

    async def test_cloudflare_location_fallback(self):
        loc = dv.where("10.9.9.9", {"cf-ipcountry": "fr", "cf-ipcity": "Lyon", "cf-region": "Auvergne"})
        self.assertEqual(loc, {"country": "FR", "region": "Auvergne", "city": "Lyon"})
        self.assertEqual(dv.where("10.9.9.9", {"cf-ipcountry": "XX"})["country"], None)
        # MaxMind wins when it knows.
        self.assertEqual(dv.where("10.0.0.2", {"cf-ipcountry": "FR"})["country"], "DE")

    async def test_parse_sys_rejects_junk(self):
        self.assertEqual(dv.parse_sys({"vw": "x", "lang": "<script>", "tz": "../../etc", "app": "evil",
                                       "emb": "a b", "from": "javascript:1", "pv": "1.2.3.4.5.6"}), {})


# ── Lists, breakdowns, CSV, people ────────────────────────────────────────────


class Lists(World):
    async def test_breakdowns_filters_completion(self):
        d = await self.mkdoc("L", ws=None)
        await self.view_as(d, ua=MAC_CHROME, ip="10.0.0.1", d={"active_s": 30, "depth": 100})
        await self.view_as(d, ua=ANDROID, ip="10.0.0.2", d={"active_s": 10, "depth": 10},
                           first={"ref": "https://www.linkedin.com/feed/", "sys": {"vw": 400}})
        res = (await self.listing(d)).json()
        bd = res["breakdowns"]
        self.assertEqual({r["key"] for r in bd["country"]}, {"IN", "DE"})
        self.assertEqual({r["key"] for r in bd["device"]}, {"Desktop", "Mobile"})
        self.assertEqual({r["key"] for r in bd["source"]}, {"Direct", "LinkedIn"})
        self.assertIn("Mumbai, IN", {r["key"] for r in bd["city"]})
        self.assertEqual((await self.listing(d, country="DE")).json()["totals"]["views"], 1)
        self.assertEqual((await self.listing(d, device="Phone")).json()["totals"]["views"], 1)
        self.assertEqual((await self.listing(d, source="LinkedIn")).json()["totals"]["views"], 1)
        self.assertEqual((await self.listing(d, browser="Chrome")).json()["totals"]["views"], 2)
        done = (await self.listing(d, completion="done")).json()
        self.assertEqual([v["completion"] for v in done["views"]], [100.0])
        low = (await self.listing(d, completion="low")).json()
        self.assertEqual([v["completion"] for v in low["views"]], [10.0])
        v = res["views"][0]
        self.assertIn("Mumbai", v["location"]["label"] or "") if v["location"]["country"] == "IN" else None
        self.assertEqual(res["totals"]["avg_completion"], 55.0)

    async def test_range_and_paging(self):
        d = await self.mkdoc("L", ws=None)
        for _ in range(3):
            await self.view_as(d)
        rows = await self.views(d)
        await self.db[dv.COLL].update_one({"_id": rows[0]["_id"]}, {"$set": {"started_at": now() - timedelta(days=40)}})
        self.assertEqual((await self.listing(d)).json()["totals"]["views"], 2)
        self.assertEqual((await self.listing(d, range="90d")).json()["totals"]["views"], 3)
        page = (await self.listing(d, range="90d", limit=2)).json()
        self.assertEqual((len(page["views"]), page["next"]), (2, 2))
        page2 = (await self.listing(d, range="90d", limit=2, offset=2)).json()
        self.assertEqual((len(page2["views"]), page2["next"]), (1, None))

    async def test_csv(self):
        d = await self.mkdoc("L", ws=None)
        await self.db["users"].update_one({"_id": __import__("bson").ObjectId(self.uid["stranger"])},
                                          {"$set": {"name": "=HYPERLINK(1)"}})
        await self.view_as(d, who="stranger")
        await self.view_as(d)
        r = await self.http.get(f"/api/v1/me/documents/{d['slug']}/analytics/viewers.csv",
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 200)
        self.assertIn("text/csv", r.headers["content-type"])
        rows = list(csv.DictReader(io.StringIO(r.text)))
        self.assertEqual(len(rows), 2)
        self.assertEqual(set(rows[0]), set(dv.CSV_FIELDS))
        named = [x for x in rows if x["email"]][0]
        self.assertEqual(named["viewer"], "'=HYPERLINK(1)")
        self.assertEqual(named["city"], "Mumbai")
        self.assertEqual(named["timezone"], "Asia/Kolkata")
        self.assertEqual(named["browser_version"], "131")

    async def test_people_rollup(self):
        d = await self.mkdoc("L", ws=None)
        await self.view_as(d, who="stranger", d={"active_s": 30, "depth": 50})
        await self.view_as(d, who="stranger", d={"active_s": 20, "depth": 90})
        await self.view_as(d)
        r = await self.http.get(f"/api/v1/me/documents/{d['slug']}/analytics/viewers/people",
                                headers=self.session("owner"))
        people = r.json()["people"]
        self.assertEqual(len(people), 2)
        p = [x for x in people if x["viewer"]["type"] == "user"][0]
        self.assertEqual((p["views"], p["active_s"], p["best_completion"]), (2, 50, 90.0))


# ── Retention and forgetting ──────────────────────────────────────────────────


class Retention(World):
    async def test_ttl_index(self):
        info = await self.db[dv.COLL].index_information()
        self.assertEqual(info["doc_views_ttl"]["expireAfterSeconds"], 180 * 24 * 3600)
        with mock.patch.object(dv.settings, "view_detail_days", 30):
            self.assertEqual(dv.detail_days(), 30)
            try:
                await dv.ensure_indexes(self.db)
            except Exception:  # pragma: no cover - mongomock has no collMod
                self.skipTest("collMod needs a real MongoDB")
            info = await self.db[dv.COLL].index_information()
            self.assertEqual(info["doc_views_ttl"]["expireAfterSeconds"], 30 * 24 * 3600)
        with mock.patch.object(dv.settings, "view_detail_days", 1):
            self.assertEqual(dv.detail_days(), 7)

    async def test_forget_user_and_history(self):
        d = await self.mkdoc("L", ws=None)
        await self.view_as(d, who="stranger")
        h = (await self.http.get("/api/v1/me/view-history", headers=self.session("stranger"))).json()
        self.assertEqual((h["total"], h["views"][0]["slug"]), (1, d["slug"]))
        r = await self.http.delete("/api/v1/me/view-history", headers=self.session("stranger"))
        self.assertEqual(r.json(), {"forgotten": 1})
        res = (await self.listing(d)).json()
        self.assertEqual((res["totals"]["signed_in"], res["views"][0]["viewer"]["type"]), (0, "anonymous"))

    async def test_deleted_account_and_document(self):
        d = await self.mkdoc("L", ws=None)
        await self.view_as(d, who="stranger")
        await self.db["users"].delete_one({"_id": __import__("bson").ObjectId(self.uid["stranger"])})
        v = (await self.listing(d)).json()["views"][0]
        self.assertEqual((v["viewer"]["name"], v["viewer"]["email"]), ("Deleted account", None))
        from app.services import lifecycle

        await lifecycle.destroy(self.db, await self.doc(d["slug"]), reason="test")
        self.assertEqual(await self.views(d), [])


# ── MCP ───────────────────────────────────────────────────────────────────────


class Mcp(World):
    async def test_tools(self):
        d = await self.mkdoc("L")
        s = await self.view_as(d, who="stranger", ev=[{"t": 1, "k": "depth", "v": 50}])
        await self.view_as(d)
        tok = await self.mcp_token("owner", write=False)
        status, res = await self.mcp_call(tok, "get_document_viewers", {"document": d["slug"], "by_person": True})
        self.assertEqual(status, 200)
        out = res["structuredContent"]
        self.assertEqual((out["access"], out["totals"]["views"], len(out["views"]), len(out["people"])),
                         ("full", 2, 2, 2))
        text = res["content"][0]["text"]
        self.assertIn(self.email["stranger"], text)
        row = await self.db[dv.COLL].find_one({"sid": s})
        status, res = await self.mcp_call(tok, "get_view_timeline", {"document": d["slug"], "view_id": str(row["_id"])})
        out = res["structuredContent"]
        self.assertIn("Scrolled to 50%", [x["text"] for x in out["steps"]])
        # A workspace viewer gets counts; a stranger nothing.
        tok = await self.mcp_token("wv", write=False)
        status, res = await self.mcp_call(tok, "get_document_viewers", {"document": d["slug"]})
        out = res["structuredContent"]
        self.assertEqual((out["access"], out["views"], out["totals"]["views"]), ("counts", [], 2))
        status, res = await self.mcp_call(tok, "get_view_timeline", {"document": d["slug"], "view_id": str(row["_id"])})
        self.assertTrue(res["isError"])
        tok = await self.mcp_token("stranger", write=False)
        status, res = await self.mcp_call(tok, "get_document_viewers", {"document": d["slug"]})
        self.assertTrue(res["isError"])
