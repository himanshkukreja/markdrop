"""What analytics an item collects (services/analytics_prefs.py, routers/analytics_settings.py).

Each of the nine types stops its collection at ingest (views, reads, engagement sessions and the
per-view rows), the levels and their precedence (workspace enforced > item > folder > workspace
default > account default), deleting what was already collected, who may change what, the
document's ``track`` for the viewer's page, and the MCP tools.
"""

from __future__ import annotations

from tests import _email_env  # noqa: F401  (pins settings first)

import json
import secrets
from unittest import mock

from bson import ObjectId

from tests._access_env import AccessWorld

from app.services import analytics_prefs as ap
from app.services import doc_views as dv
from app.services import engage, geo, presence

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/131.0.0.0 Safari/537.36")


def sid() -> str:
    return "s" + secrets.token_hex(8)


class World(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await engage.ensure_indexes(self.db)
        await dv.ensure_indexes(self.db)
        engage.clear_pending()
        presence.clear()
        ap.clear_cache()
        self.geo_calls = 0

        def lookup(ip):
            self.geo_calls += 1
            return {"country": "IN", "region": "Maharashtra", "city": "Mumbai"}

        p = mock.patch.object(geo, "lookup", lookup)
        p.start()
        self.addCleanup(p.stop)
        self.addCleanup(presence.clear)
        self.addCleanup(engage.clear_pending)
        self.addCleanup(ap.clear_cache)

    def tok(self, who: str) -> str:
        return self.session(who)["Authorization"].split()[1]

    async def full_view(self, doc: dict, *, who: str | None = None, kind: str = "doc") -> str:
        """A view with everything in it: system, source, activity, video, pages, a download."""
        s = sid()
        d: dict = {"active_s": 20, "depth": 80, "sec": {"user-content-a": 10}, "reached": ["user-content-a"]}
        if kind == "video":
            d["media"] = {"dur": 100, "segs": [[0, 30]], "plays": 1}
        if kind == "pdf":
            d.update(npages=10, pmax=4, pages={"1": 5, "2": 3})
        body = {"sid": s, "seq": 1, "final": True, "a": "b" + secrets.token_hex(8), "d": d,
                "first": {"ref": "https://www.linkedin.com/feed/", "utm": {"source": "news"},
                          "sys": {"vw": 1440, "vh": 900, "lang": "en-US", "tz": "Asia/Kolkata", "app": "tab"}},
                "ev": [{"t": 1, "k": "sec", "h": "user-content-a", "a": 5}, {"t": 2, "k": "depth", "v": 50},
                       {"t": 3, "k": "play", "s": 0}, {"t": 33, "k": "pause", "s": 30},
                       {"t": 40, "k": "pg", "p": 2, "a": 3}, {"t": 50, "k": "dl"}]}
        if who:
            body["u"] = self.tok(who)
        r = await self.http.post(f"/api/v1/documents/{doc['slug']}/engage", content=json.dumps(body),
                                 headers={"User-Agent": UA, "X-Real-IP": "10.0.0.9", "Content-Type": "text/plain"})
        self.assertEqual(r.status_code, 204)
        return s

    async def view_event(self, doc: dict, typ: str = "view"):
        return await self.http.post(f"/api/v1/documents/{doc['slug']}/events",
                                    json={"type": typ, "referrer": "https://www.linkedin.com/feed/", "utm": {"source": "x"}},
                                    headers={"User-Agent": UA, "X-Real-IP": "10.0.0.9"})

    async def row(self, s: str) -> dict | None:
        return await self.db[dv.COLL].find_one({"sid": s})

    async def put_item(self, doc: dict, body: dict, who: str = "owner"):
        return await self.http.put(f"/api/v1/me/documents/{doc['slug']}/analytics/settings", json=body,
                                   headers=self.session(who))


class Ingest(World):
    async def test_everything_on_by_default(self):
        d = await self.mkdoc("L", ws=None)
        s = await self.full_view(d, who="stranger")
        row = await self.row(s)
        self.assertEqual((row["viewer_id"], row["country"], row["device"], row["source"]),
                         (self.uid["stranger"], "IN", "Desktop", "LinkedIn"))
        self.assertEqual({e["k"] for e in row["tl"]}, {"sec", "depth", "play", "pause", "pg", "dl"})

    async def test_counts_off_records_nothing(self):
        d = await self.mkdoc("L", ws=None)
        self.assertEqual((await self.put_item(d, {"settings": {"counts": False}})).status_code, 200)
        await self.full_view(d)
        await self.view_event(d)
        await self.http.post(f"/api/v1/documents/{d['slug']}/read", content=json.dumps(
            {"rid": "r" + secrets.token_hex(6), "depth": 50, "seconds": 10}), headers={"User-Agent": UA})
        self.assertEqual(await self.db[dv.COLL].count_documents({}), 0)
        self.assertEqual(await self.db["engage_sessions"].count_documents({}), 0)
        self.assertEqual(await self.db["events"].count_documents({}), 0)
        self.assertEqual((await self.doc(d["slug"])).get("views", 0), 0)

    async def test_each_type_off(self):
        cases = {
            "identity": lambda r, e, ev: self.assertIsNone(r["viewer_id"]),
            "location": lambda r, e, ev: self.assertEqual((r["country"], e["country"], ev["country"], r["sys"].get("tz")),
                                                          (None, None, None, None)),
            "device": lambda r, e, ev: self.assertEqual((r["device"], r["browser"], e["device"], ev.get("device"),
                                                         r["sys"].get("vw")), (None, None, None, None, None)),
            "source": lambda r, e, ev: self.assertEqual((r["ref"], r["source"], e["ref"], ev["referrer"]),
                                                        (None, None, None, None)),
            "activity": lambda r, e, ev: (self.assertNotIn("depth", r), self.assertEqual(e["sec"], {}),
                                          self.assertFalse({"sec", "depth"} & {x["k"] for x in r["tl"]})),
            "video": lambda r, e, ev: (self.assertNotIn("segs", r),
                                       self.assertFalse({"play", "pause"} & {x["k"] for x in r["tl"]})),
            "pages": lambda r, e, ev: (self.assertNotIn("npages", r), self.assertEqual(e["pages"], {}),
                                       self.assertNotIn("pg", {x["k"] for x in r["tl"]})),
            "downloads": lambda r, e, ev: self.assertNotIn("dl", {x["k"] for x in r["tl"]}),
        }
        for key, check in cases.items():
            with self.subTest(key=key):
                kind = "video" if key == "video" else "pdf" if key == "pages" else "doc"
                extra = {"mime": "video/mp4"} if kind == "video" else {"mime": "application/pdf"} if kind == "pdf" else {}
                d = await self.mkdoc("L", ws=None, **({"kind": "artifact", **extra} if extra else {}))
                await self.put_item(d, {"settings": {key: False}})
                before = self.geo_calls
                s = await self.full_view(d, who="stranger", kind=kind)
                await self.view_event(d)
                r = await self.row(s)
                e = await self.db["engage_sessions"].find_one({"sid": s}) or {
                    "country": None, "device": None, "ref": None, "sec": {}, "pages": {}}
                ev = await self.db["events"].find_one({"doc_id": str(d["_id"]), "type": "view"})
                check(r, e, ev)
                if key == "location":
                    self.assertEqual(self.geo_calls, before, "no location lookup at all")

    async def test_downloads_off_drops_export_events(self):
        d = await self.mkdoc("L", ws=None)
        await self.put_item(d, {"settings": {"downloads": False}})
        await self.view_event(d, "export_pdf")
        self.assertEqual(await self.db["events"].count_documents({"type": "export_pdf"}), 0)
        await self.view_event(d, "view")
        self.assertEqual(await self.db["events"].count_documents({"type": "view"}), 1)

    async def test_activity_off_skips_ask_and_signoff_notes(self):
        d = await self.mkdoc("L", ws=None)
        await self.full_view(d, who="stranger")
        await self.put_item(d, {"settings": {"activity": False}})
        await dv.note_for_slug(self.db, d["slug"], self.uid["stranger"], {"k": "ask", "q": "hi"})
        row = await self.db[dv.COLL].find_one({"doc_id": str(d["_id"])})
        self.assertNotIn("ask", {e["k"] for e in row["tl"]})

    async def test_document_carries_track(self):
        d = await self.mkdoc("L", ws=None)
        await self.put_item(d, {"settings": {"video": False}})
        r = await self.http.get(f"/api/v1/documents/{d['slug']}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["track"], {**{k: True for k in ap.KEYS}, "video": False})


class Levels(World):
    async def test_precedence(self):
        d = await self.mkdoc("L")  # in W1
        fid = str((await self.db["folders"].insert_one({"workspace_id": self.ws["W1"], "name": "Reports",
                                                        "slug": "reports", "parent_id": None})).inserted_id)
        child = str((await self.db["folders"].insert_one({"workspace_id": self.ws["W1"], "name": "Q3",
                                                          "slug": "q3", "parent_id": fid})).inserted_id)
        await self.db["documents"].update_one({"_id": d["_id"]}, {"$set": {"folder_id": child}})
        h = self.session("owner")
        # Account default: location off.
        await self.http.put("/api/v1/me/analytics-settings", json={"settings": {"location": False}}, headers=h)
        got = (await self.http.get(f"/api/v1/me/documents/{d['slug']}/analytics/settings", headers=h)).json()
        loc = {t["key"]: t for t in got["types"]}["location"]
        self.assertEqual((loc["on"], loc["source"], loc["from"]), (False, "account", "Your defaults"))
        # The workspace's default beats the account; the parent folder beats the workspace.
        wa = self.session("wa")
        await self.http.put(f"/api/v1/workspaces/{self.ws['W1']}/analytics-settings",
                            json={"settings": {"location": True, "device": False}}, headers=wa)
        await self.http.put(f"/api/v1/workspaces/{self.ws['W1']}/folders/{fid}/analytics-settings",
                            json={"settings": {"device": True, "source": False}}, headers=wa)
        got = (await self.http.get(f"/api/v1/me/documents/{d['slug']}/analytics/settings", headers=h)).json()
        t = {x["key"]: x for x in got["types"]}
        self.assertEqual((t["location"]["on"], t["location"]["source"]), (True, "workspace"))
        self.assertEqual((t["device"]["on"], t["device"]["source"], t["device"]["from"]), (True, f"folder:{fid}", "Folder Reports"))
        self.assertEqual((t["source"]["on"]), False)
        self.assertIn("source off", got["summary"])
        # The item's own setting beats the folder.
        await self.put_item(d, {"settings": {"source": True}})
        got = (await self.http.get(f"/api/v1/me/documents/{d['slug']}/analytics/settings", headers=h)).json()
        t = {x["key"]: x for x in got["types"]}
        self.assertEqual((t["source"]["on"], t["source"]["source"], got["custom"]), (True, "item", True))
        # Enforced workspace "off" beats the item; an enforced "on" doesn't force it on.
        await self.http.put(f"/api/v1/workspaces/{self.ws['W1']}/analytics-settings",
                            json={"settings": {"source": False, "identity": True}, "enforce": True}, headers=wa)
        await self.put_item(d, {"settings": {"source": True, "identity": False}})
        got = (await self.http.get(f"/api/v1/me/documents/{d['slug']}/analytics/settings", headers=h)).json()
        t = {x["key"]: x for x in got["types"]}
        self.assertEqual((t["source"]["on"], t["source"]["locked"], t["source"]["source"]), (False, True, "workspace_enforced"))
        self.assertEqual((t["identity"]["on"], t["identity"]["locked"]), (False, False))
        # And ingest follows it.
        s = await self.full_view(d, who="stranger")
        row = await self.row(s)
        self.assertEqual((row["source"], row["viewer_id"]), (None, None))
        # Back to the defaults.
        await self.put_item(d, {"settings": None})
        self.assertIsNone((await self.doc(d["slug"]))["analytics_prefs"])

    async def test_who_may_change_what(self):
        d = await self.mkdoc("L")  # owner's, in W1
        for who, want in (("owner", 200), ("wa", 200), ("wo", 200), ("wm", 403), ("ge", 403), ("stranger", 403)):
            r = await self.put_item(d, {"settings": {"device": False}}, who=who)
            self.assertEqual(r.status_code, want, who)
        # Reading: the Viewers tab's full access (owner, admins, editors).
        for who, want in (("wm", 200), ("wv", 403), ("stranger", 403)):
            r = await self.http.get(f"/api/v1/me/documents/{d['slug']}/analytics/settings", headers=self.session(who))
            self.assertEqual(r.status_code, want, who)
        for who, want in (("wa", 200), ("wm", 403)):
            r = await self.http.put(f"/api/v1/workspaces/{self.ws['W1']}/analytics-settings",
                                    json={"settings": {"device": False}}, headers=self.session(who))
            self.assertEqual(r.status_code, want, who)
        r = await self.put_item(d, {"settings": {"nope": False}})
        self.assertEqual(r.status_code, 422)
        u = await self.mkdoc("L", ws=None)
        self.assertEqual((await self.put_item(u, {"settings": {"device": False}}, who="wa")).status_code, 403)

    async def test_bulk(self):
        a = await self.mkdoc("L", ws=None)
        b = await self.mkdoc("L", ws=None)
        theirs = await self.mkdoc("L", ws=None, owner="stranger")
        r = await self.http.post("/api/v1/me/analytics-settings/items", headers=self.session("owner"),
                                 json={"slugs": [a["slug"], b["slug"], theirs["slug"]], "settings": {"identity": False}})
        self.assertEqual(r.status_code, 200)
        self.assertEqual((sorted(r.json()["updated"]), r.json()["skipped"]), (sorted([a["slug"], b["slug"]]), [theirs["slug"]]))
        self.assertEqual((await self.doc(a["slug"]))["analytics_prefs"], {"identity": False})
        r = await self.http.post("/api/v1/me/analytics-settings/items", headers=self.session("owner"),
                                 json={"slugs": [a["slug"]], "use_defaults": True})
        self.assertIsNone((await self.doc(a["slug"]))["analytics_prefs"])


class Delete(World):
    async def test_delete_collected(self):
        d = await self.mkdoc("L", ws=None, kind="artifact", mime="video/mp4")
        s = await self.full_view(d, who="stranger", kind="video")
        await self.view_event(d)
        r = await self.put_item(d, {"settings": {"location": False, "identity": False, "video": False},
                                    "delete": ["location", "identity", "video"]})
        self.assertEqual(r.status_code, 200)
        row = await self.row(s)
        self.assertIsNone(row["viewer_id"])
        self.assertNotIn("country", row)
        self.assertNotIn("segs", row)
        self.assertFalse({"play", "pause"} & {e["k"] for e in row["tl"]})
        self.assertIsNone((await self.db["engage_sessions"].find_one({"sid": s}))["media"])
        self.assertIsNone((await self.db["events"].find_one({"doc_id": str(d["_id"])}))["country"])
        # Deleting a type that's still on does nothing.
        await self.put_item(d, {"settings": {"device": True}, "delete": ["device"]})
        self.assertEqual((await self.row(s))["device"], "Desktop")

    async def test_counts_delete_removes_everything(self):
        d = await self.mkdoc("L", ws=None)
        await self.full_view(d)
        await self.view_event(d)
        await self.put_item(d, {"settings": {"counts": False}, "delete": ["counts"]})
        for coll in (dv.COLL, "engage_sessions", "events"):
            self.assertEqual(await self.db[coll].count_documents({"doc_id": str(d["_id"])}), 0, coll)

    async def test_account_delete_respects_item_override(self):
        a = await self.mkdoc("L", ws=None)
        b = await self.mkdoc("L", ws=None)
        sa = await self.full_view(a)
        sb = await self.full_view(b)
        await self.put_item(b, {"settings": {"location": True}})
        r = await self.http.put("/api/v1/me/analytics-settings", headers=self.session("owner"),
                                json={"settings": {"location": False}, "delete": ["location"]})
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("country", await self.row(sa))
        self.assertEqual((await self.row(sb))["country"], "IN")


class Mcp(World):
    async def test_tools(self):
        d = await self.mkdoc("L")
        tok = await self.mcp_token("owner")
        status, res = await self.mcp_call(tok, "set_analytics_settings", {"document": d["slug"], "settings": {"device": False}})
        self.assertFalse(res["isError"], res)
        self.assertIn("device off", res["structuredContent"]["summary"])
        status, res = await self.mcp_call(tok, "get_analytics_settings", {"document": d["slug"]})
        t = {x["key"]: x for x in res["structuredContent"]["types"]}
        self.assertEqual((t["device"]["on"], t["device"]["source"]), (False, "item"))
        status, res = await self.mcp_call(tok, "set_analytics_settings", {"account": True, "settings": {"source": False}})
        self.assertEqual(res["structuredContent"]["settings"]["source"], False)
        # A folder needs a workspace admin; the owner is a member of W1.
        fid = str((await self.db["folders"].insert_one({"workspace_id": self.ws["W1"], "name": "F", "slug": "f",
                                                        "parent_id": None})).inserted_id)
        status, res = await self.mcp_call(tok, "set_analytics_settings",
                                          {"workspace": self.ws["W1"], "folder": fid, "settings": {"pages": False}})
        self.assertTrue(res["isError"])
        wtok = await self.mcp_token("wa")
        status, res = await self.mcp_call(wtok, "set_analytics_settings",
                                          {"workspace": self.ws["W1"], "folder": fid, "settings": {"pages": False}})
        self.assertFalse(res["isError"], res)
        self.assertEqual(ap.clean((await self.db["folders"].find_one({"_id": ObjectId(fid)}))["analytics_prefs"]),
                         {"pages": False})
        status, res = await self.mcp_call(tok, "set_analytics_settings", {"document": d["slug"], "account": True})
        self.assertTrue(res["isError"])
