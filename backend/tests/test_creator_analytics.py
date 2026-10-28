"""Creator analytics v1 — backend (scratchpad specs/analytics-v1-build.md §1–§5).

Engagement ingest (clamps, seq idempotency, owner dropped, members internal,
bots, ticket admission, key encoding), the extended view beacon, presence,
link-preview share signals, every read endpoint's shape and access, the
retention / k-anonymity math on fixtures, the frame endpoint, and the insight
rules.
"""

from __future__ import annotations

from tests import _email_env  # noqa: F401  (pins settings first)

import json
import secrets
from datetime import datetime, timedelta, timezone
from unittest import mock

from tests._access_env import AccessWorld, now

from app.routers import og as og_router
from app.services import analytics, creator_analytics as ca, engage, geo, insights, presence

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Version/17.0 Safari/605.1.15")
PHONE_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
            "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
GEO = {"10.0.0.1": "DE", "10.0.0.2": "FR", "10.0.0.3": "US"}


def sid() -> str:
    return "s" + secrets.token_hex(8)


class World(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await engage.ensure_indexes(self.db)
        engage.clear_pending()
        presence.clear()
        p = mock.patch.object(geo, "lookup", lambda ip: {"country": GEO.get(ip), "region": None, "city": None})
        p.start()
        self.addCleanup(p.stop)
        self.addCleanup(presence.clear)
        self.addCleanup(engage.clear_pending)

    async def engage(self, slug: str, body: dict | bytes | str, *, ua: str = UA, ip: str = "10.0.0.1"):
        content = body if isinstance(body, (bytes, str)) else json.dumps(body)
        return await self.http.post(f"/api/v1/documents/{slug}/engage", content=content,
                                    headers={"User-Agent": ua, "X-Real-IP": ip, "Content-Type": "text/plain"})

    async def row(self, doc: dict, s: str) -> dict | None:
        return await self.db["engage_sessions"].find_one({"sid": s, "doc_id": str(doc["_id"])})

    async def view(self, slug: str, *, headers: dict | None = None, ua: str = UA, ip: str = "10.0.0.1", **body):
        return await self.http.post(f"/api/v1/documents/{slug}/events", json={"type": "view", **body},
                                    headers={"User-Agent": ua, "X-Real-IP": ip, **(headers or {})})

    async def video(self, **extra) -> dict:
        d = await self.mkdoc("L", ws=None, kind="artifact", **{
            "mime": "video/mp4", "media": {"duration_s": 100.0}, "size_bytes": 25_000_000, **extra})
        return d

    async def seed(self, doc: dict, n: int = 1, **fields) -> list[str]:
        """Insert ``n`` stored sessions straight into engage_sessions."""
        sids = []
        for i in range(n):
            s = sid()
            row = {
                "sid": s, "doc_id": str(doc["_id"]), "owner_id": doc.get("owner_id"),
                "kind": engage.kind_for(doc), "ver": None if doc.get("kind") != "artifact" else
                int(doc.get("file_version") or 1),
                "started_at": now() - timedelta(hours=1), "updated_at": now() - timedelta(minutes=50),
                "seq": 3, "ended": True, "ip_hash": f"ip{i}-{secrets.token_hex(3)}", "country": "DE", "region": None, "city": None,
                "device": "Desktop", "os": "macOS", "browser": "Safari", "channel": "Direct", "ref": None,
                "utm_source": None, "utm_medium": None, "utm_campaign": None, "internal": False,
                "active_s": 30, "depth": 0, "reached": [], "sec": {}, "copies": {}, "links": {},
                "prints": 0, "pages": {}, "npages": None, "pmax": 0, "rv": {}, "media": None,
            }
            row.update(fields)
            await self.db["engage_sessions"].insert_one(row)
            sids.append(s)
        return sids

    async def seed_views(self, doc: dict, rows: list[dict]) -> None:
        base = {"doc_id": str(doc["_id"]), "owner_id": doc.get("owner_id"), "type": "view",
                "ts": now() - timedelta(hours=2), "referrer": None, "internal": False}
        await self.db["events"].insert_many([{**base, **r} for r in rows])


# ── §1b engagement ingest ─────────────────────────────────────────────────────


class EngageIngest(World):
    async def test_doc_session_stored_with_attributes(self):
        d = await self.mkdoc("L", ws=None)
        s = sid()
        r = await self.engage(d["slug"], {
            "v": 1, "sid": s, "seq": 1, "k": "doc",
            "first": {"ref": "https://news.ycombinator.com/item?id=1", "utm": {"source": "Newsletter",
                                                                             "campaign": "Launch"}},
            "d": {"active_s": 10, "depth": 40, "reached": ["user-content-a.b", "user-content-c"],
                  "sec": {"user-content-a.b": 8, "$weird": 2},
                  "copies": {"deadbeef|user-content-a.b": 1},
                  "links": {"github.com/x/y.md|": 2}, "print": 1, "unknown": {"x": 1}},
        })
        self.assertEqual(r.status_code, 204)
        row = await self.row(d, s)
        self.assertIsNotNone(row)
        self.assertEqual((row["kind"], row["active_s"], row["depth"], row["prints"]), ("doc", 10, 40, 1))
        self.assertEqual(row["reached"], ["user-content-a.b", "user-content-c"])
        # '.' and '$' in keys are encoded, and decode back.
        self.assertIn("user-content-a．b", row["sec"])
        self.assertIn("＄weird", row["sec"])
        self.assertEqual(engage.decode_key("user-content-a．b"), "user-content-a.b")
        self.assertEqual(row["copies"], {"deadbeef|user-content-a．b": 1})
        self.assertEqual(row["links"], {"github．com/x/y．md|": 2})
        self.assertEqual(row["ref"], "https://news.ycombinator.com/item")
        self.assertEqual((row["utm_source"], row["utm_campaign"], row["channel"]), ("newsletter", "Launch", "Email"))
        self.assertEqual((row["device"], row["os"], row["browser"]), ("Desktop", "macOS", "Safari"))
        self.assertEqual(row["ip_hash"], analytics._hash_ip("10.0.0.1"))
        self.assertEqual(row["country"], "DE")
        self.assertFalse(row["internal"])
        self.assertNotIn("unknown", row)

    async def test_seq_idempotent_and_deltas(self):
        d = await self.mkdoc("L", ws=None)
        s = sid()
        await self.engage(d["slug"], {"sid": s, "seq": 1, "d": {"active_s": 10, "depth": 40,
                                                                "sec": {"h1": 5}}})
        body = {"sid": s, "seq": 2, "d": {"active_s": 6, "depth": 30, "sec": {"h1": 4}, "reached": ["h1"]}}
        await self.engage(d["slug"], body)
        await self.engage(d["slug"], body)  # a retry: ignored
        await self.engage(d["slug"], {"sid": s, "seq": 1, "d": {"active_s": 9}})  # stale
        row = await self.row(d, s)
        self.assertEqual((row["seq"], row["active_s"], row["depth"]), (2, 16, 40))
        self.assertEqual(row["sec"], {"h1": 9})
        self.assertEqual(row["reached"], ["h1"])
        await self.engage(d["slug"], {"sid": s, "seq": 3, "final": True, "d": {"reached": ["h1", "h2"]}})
        row = await self.row(d, s)
        self.assertEqual(row["reached"], ["h1", "h2"])
        self.assertTrue(row["ended"])

    async def test_plausibility_clamps(self):
        d = await self.mkdoc("L", ws=None)
        s = sid()
        await self.engage(d["slug"], {"sid": s, "seq": 1, "d": {"active_s": 5000, "depth": 250}})
        row = await self.row(d, s)
        self.assertEqual((row["active_s"], row["depth"]), (120, 100))
        # Right after: at most (seconds since the last update + 20).
        await self.engage(d["slug"], {"sid": s, "seq": 2, "d": {"active_s": 100}})
        row = await self.row(d, s)
        self.assertLessEqual(row["active_s"], 141)
        self.assertGreaterEqual(row["active_s"], 140)
        # Session totals stop at 4 h.
        await self.db["engage_sessions"].update_one(
            {"_id": row["_id"]}, {"$set": {"active_s": 14_390, "updated_at": now() - timedelta(minutes=10)}})
        await self.engage(d["slug"], {"sid": s, "seq": 3, "d": {"active_s": 120}})
        self.assertEqual((await self.row(d, s))["active_s"], 14_400)
        # Maps stop at 200 keys per session.
        await self.db["engage_sessions"].update_one(
            {"_id": row["_id"]}, {"$set": {"updated_at": now() - timedelta(minutes=10)}})
        await self.engage(d["slug"], {"sid": s, "seq": 4, "d": {"sec": {f"h{i}": 1 for i in range(150)}}})
        await self.engage(d["slug"], {"sid": s, "seq": 5, "d": {"sec": {f"x{i}": 1 for i in range(150)}}})
        self.assertEqual(len((await self.row(d, s))["sec"]), 200)

    async def test_pdf_pages_clamped(self):
        d = await self.mkdoc("L", ws=None, kind="artifact", mime="application/pdf")
        s = sid()
        await self.engage(d["slug"], {"sid": s, "seq": 1, "k": "doc", "d": {
            "active_s": 20, "pages": {"0": 3, "2001": 4, "abc": 1, "5": 12, "1": 5}, "npages": 12,
            "pmax": 40, "rv": {"5": 1}}})
        row = await self.row(d, s)
        self.assertEqual(row["kind"], "pdf")  # the document decides, not the client
        self.assertEqual(row["pages"], {"5": 12, "1": 5})
        self.assertEqual((row["npages"], row["pmax"], row["rv"]), (12, 12, {"5": 1}))
        self.assertEqual(row["ver"], 1)

    async def test_media_segments_union_and_clamps(self):
        d = await self.video()
        s = sid()
        segs = [[0, 31.5], [29, 60], [90, 500], [-5, 2], [70, 60]]
        await self.engage(d["slug"], {"sid": s, "seq": 1, "d": {"active_s": 1, "media": {
            "dur": 100, "segs": segs, "plays": 1, "speed": {"1": 20, "1.5": 8, "99": 3},
            "startup_ms": 1180, "rebuf_n": 1, "rebuf_ms": 2300, "err": "bogus", "fs_s": 4}}})
        row = await self.row(d, s)
        m = row["media"]
        self.assertEqual(m["dur"], 100)
        self.assertIn([90, 100], m["segs"])
        self.assertEqual(m["watched_s"], 70)  # [0,60] ∪ [90,100] (∪ [0,2], already in)
        self.assertEqual(m["speed"], {"1": 20, "1．5": 8})
        self.assertEqual((m["startup_ms"], m["rebuf_n"], m["rebuf_ms"], m["err"], m["fs_s"]),
                         (1180, 1, 2300, None, 4))
        # At most 400 stored ranges per session, 50 per send.
        for seq in range(2, 12):
            await self.db["engage_sessions"].update_one(
                {"sid": s}, {"$set": {"updated_at": now() - timedelta(minutes=5)}})
            await self.engage(d["slug"], {"sid": s, "seq": seq, "d": {"media": {
                "segs": [[i, i + 0.5] for i in range(60)]}}})
        self.assertEqual(len((await self.row(d, s))["media"]["segs"]), engage.MAX_SEGS)

    async def test_pending_until_two_active_seconds(self):
        d = await self.mkdoc("L", ws=None)
        s = sid()
        await self.engage(d["slug"], {"sid": s, "seq": 1, "first": {"utm": {"source": "x.com"}},
                                      "d": {"active_s": 1}})
        self.assertIsNone(await self.row(d, s))
        await self.engage(d["slug"], {"sid": s, "seq": 2, "d": {"active_s": 3}})
        row = await self.row(d, s)
        self.assertEqual((row["active_s"], row["utm_source"], row["channel"]), (4, "x.com", "Social"))

    async def test_owner_dropped(self):
        d = await self.mkdoc("L", ws=None)
        token = self.session("owner")["Authorization"].split()[1]
        s = sid()
        await self.engage(d["slug"], {"sid": s, "seq": 1, "u": token, "d": {"active_s": 30}})
        self.assertIsNone(await self.row(d, s))
        # A session that turns out to be the owner's is removed.
        s2 = sid()
        await self.engage(d["slug"], {"sid": s2, "seq": 1, "d": {"active_s": 30}})
        self.assertIsNotNone(await self.row(d, s2))
        await self.engage(d["slug"], {"sid": s2, "seq": 2, "u": token, "d": {"active_s": 3}})
        self.assertIsNone(await self.row(d, s2))
        self.assertEqual(presence.count(str(d["_id"])), 0)

    async def test_member_internal_stranger_not(self):
        d = await self.mkdoc("L")  # filed in W1
        s1, s2 = sid(), sid()
        wm = self.session("wm")["Authorization"].split()[1]
        st = self.session("stranger")["Authorization"].split()[1]
        await self.engage(d["slug"], {"sid": s1, "seq": 1, "u": wm, "d": {"active_s": 30}})
        await self.engage(d["slug"], {"sid": s2, "seq": 1, "u": st, "d": {"active_s": 30}})
        self.assertTrue((await self.row(d, s1))["internal"])
        self.assertFalse((await self.row(d, s2))["internal"])
        # An API token resolves the same way.
        s3 = sid()
        api = (await self.api_token("wm"))["Authorization"].split()[1]
        await self.engage(d["slug"], {"sid": s3, "seq": 1, "u": api, "d": {"active_s": 30}})
        self.assertTrue((await self.row(d, s3))["internal"])

    async def test_bots_ignored(self):
        d = await self.mkdoc("L", ws=None)
        s = sid()
        r = await self.engage(d["slug"], {"sid": s, "seq": 1, "d": {"active_s": 30}},
                              ua="Slackbot-LinkExpanding 1.0")
        self.assertEqual(r.status_code, 204)
        self.assertIsNone(await self.row(d, s))

    async def test_ticket_admission(self):
        d = await self.mkdoc("P", ws=None)
        s = sid()
        r = await self.engage(d["slug"], {"sid": s, "seq": 1, "d": {"active_s": 30}})
        self.assertEqual(r.status_code, 204)
        self.assertIsNone(await self.row(d, s))
        r = await self.engage("missing-doc-x", {"sid": s, "seq": 1, "d": {"active_s": 30}})
        self.assertEqual(r.status_code, 204)
        ticket = (await self.get(d["slug"], self.session("gv"))).json()["read_ticket"]
        await self.engage(d["slug"], {"sid": s, "seq": 1, "t": ticket, "d": {"active_s": 30}})
        self.assertIsNotNone(await self.row(d, s))
        self.assertEqual(await self.db["engage_sessions"].count_documents({}), 1)

    async def test_garbage_is_204_and_ignored(self):
        d = await self.mkdoc("L", ws=None)
        for body in (b"not json", b"[1,2]", json.dumps({"sid": "short", "seq": 1}),
                     json.dumps({"sid": sid(), "seq": 0, "d": {"active_s": 9}}),
                     json.dumps({"sid": sid(), "seq": 1, "d": {"active_s": 9, "pad": "x" * 9000}}),
                     json.dumps({"sid": sid(), "seq": 1, "d": "nope"})):
            r = await self.engage(d["slug"], body)
            self.assertEqual(r.status_code, 204)
        self.assertEqual(await self.db["engage_sessions"].count_documents({}), 0)

    async def test_encrypted_keeps_only_time_and_depth(self):
        d = await self.mkdoc("L", ws=None, encrypted=True)
        s = sid()
        await self.engage(d["slug"], {"sid": s, "seq": 1, "pos": {"h": "user-content-secret"}, "d": {
            "active_s": 9, "depth": 50, "reached": ["user-content-secret"], "sec": {"user-content-secret": 3},
            "copies": {"abc|x": 1}, "links": {"evil.com/x|": 1}}})
        row = await self.row(d, s)
        self.assertEqual((row["active_s"], row["depth"]), (9, 50))
        self.assertEqual((row["reached"], row["sec"], row["copies"], row["links"]), ([], {}, {}, {}))
        self.assertEqual(presence.snapshot([str(d["_id"])])[str(d["_id"])][0]["pos"], None)

    def test_key_codec_and_union(self):
        for k in ("a.b.c", "$x", "x$y.z", "plain"):
            enc = engage.encode_key(k)
            self.assertNotIn(".", enc)
            self.assertFalse(enc.startswith("$"))
            self.assertEqual(engage.decode_key(enc), k)
        self.assertEqual(engage.union_len([[0, 31.5], [29, 60], [70, 80]]), 70)
        self.assertEqual(engage.merge_segs([[5, 6], [0, 2], [1, 3]]), [[0, 3], [5, 6]])


# ── §1a view beacon ───────────────────────────────────────────────────────────


class ViewBeacon(World):
    async def test_owner_view_not_counted(self):
        d = await self.mkdoc("L", ws=None)
        r = await self.view(d["slug"], headers=self.session("owner"))
        self.assertEqual((r.status_code, r.json()), (202, {"status": "ok"}))
        self.assertEqual((await self.doc(d["slug"]))["views"], 0)
        self.assertEqual(await self.db["events"].count_documents({"doc_id": str(d["_id"])}), 0)

    async def test_member_view_internal(self):
        d = await self.mkdoc("L")
        await self.view(d["slug"], headers=self.session("wm"))
        await self.view(d["slug"], headers=self.session("stranger"))
        self.assertEqual((await self.doc(d["slug"]))["views"], 2)
        rows = await self.db["events"].find({"doc_id": str(d["_id"])}).to_list(10)
        self.assertEqual(sorted(r["internal"] for r in rows), [False, True])

    async def test_tenant_member_internal(self):
        d = await self.mkdoc("L")
        await self.view(d["slug"], headers=self.tenant("wm", "W1"))
        row = await self.db["events"].find_one({"doc_id": str(d["_id"])})
        self.assertTrue(row["internal"])

    async def test_utm_channel_device_ver(self):
        d = await self.mkdoc("L", ws=None, kind="artifact", file_version=3)
        r = await self.view(d["slug"], ua=PHONE_UA, referrer="https://www.linkedin.com/feed/?x=1",
                            utm={"source": "LinkedIn", "medium": "Social", "campaign": "Q4 launch" + "x" * 200},
                            ver=2)
        self.assertEqual(r.status_code, 202)
        row = await self.db["events"].find_one({"doc_id": str(d["_id"])})
        self.assertEqual((row["device"], row["os"], row["browser"]), ("Mobile", "iOS", "Safari"))
        self.assertEqual((row["channel"], row["utm_source"], row["utm_medium"]), ("Social", "linkedin", "social"))
        self.assertEqual(len(row["utm_campaign"]), 100)
        self.assertEqual((row["ver"], row["internal"]), (2, False))
        self.assertEqual(row["referrer"], "https://www.linkedin.com/feed/")
        # A version that doesn't exist is the current one.
        await self.view(d["slug"], ver=9, ip="10.0.0.2")
        rows = await self.db["events"].find({"doc_id": str(d["_id"])}).sort("ts", 1).to_list(5)
        self.assertEqual(rows[-1]["ver"], 3)
        self.assertEqual(rows[-1]["channel"], "Direct")

    async def test_bad_credential_still_counts_anonymously(self):
        d = await self.mkdoc("L", ws=None)
        r = await self.view(d["slug"], headers={"Authorization": "Bearer mdk_nonsense"})
        self.assertEqual(r.status_code, 202)
        self.assertEqual((await self.doc(d["slug"]))["views"], 1)

    async def test_document_response_file_version(self):
        a = await self.mkdoc("L", ws=None, kind="artifact", file_version=4)
        m = await self.mkdoc("L", ws=None)
        self.assertEqual((await self.get(a["slug"])).json()["file_version"], 4)
        self.assertIsNone((await self.get(m["slug"])).json()["file_version"])


# ── Presence ──────────────────────────────────────────────────────────────────


class Presence(World):
    async def test_live_entries_expire_and_final_removes(self):
        d = await self.mkdoc("L", ws=None)
        doc_id = str(d["_id"])
        s1, s2 = sid(), sid()
        await self.engage(d["slug"], {"sid": s1, "seq": 1, "pos": {"h": "intro"}, "d": {"active_s": 5}})
        await self.engage(d["slug"], {"sid": s2, "seq": 1, "pos": {"s": 12.34}, "d": {"active_s": 1}},
                          ua=PHONE_UA, ip="10.0.0.2")
        snap = presence.snapshot([doc_id])[doc_id]
        self.assertEqual(len(snap), 2)
        self.assertIn({"pos": {"s": 12.3}, "country": "FR", "device": "Mobile", "kind": "doc"}, snap)
        await self.engage(d["slug"], {"sid": s1, "seq": 2, "final": True, "d": {"active_s": 1}})
        self.assertEqual(presence.count(doc_id), 1)
        base = presence._now()
        with mock.patch.object(presence, "_now", lambda: base + presence.TTL_S + 1):
            self.assertEqual(presence.snapshot([doc_id]), {})

    async def test_internal_hidden_from_live_by_default(self):
        presence.touch("d1", "a", pos=None, country="DE", device="Desktop", kind="doc", internal=True)
        presence.touch("d1", "b", pos={"p": 2}, country="DE", device="Desktop", kind="pdf")
        self.assertEqual(presence.count("d1"), 1)
        self.assertEqual(presence.count("d1", include_internal=True), 2)


# ── Share signals ─────────────────────────────────────────────────────────────


class ShareSignals(World):
    async def test_preview_rows_deduped_never_views(self):
        d = await self.mkdoc("L", ws=None)
        for ua in ("Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
                   "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
                   "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
                   "facebookexternalhit/1.1 Facebot Twitterbot/1.0",
                   UA):
            r = await self.http.get(f"/api/v1/og/{d['slug']}.png", headers={"User-Agent": ua})
            self.assertEqual(r.status_code, 200)
        rows = await self.db["events"].find({"doc_id": str(d["_id"]), "type": "preview"}).to_list(10)
        self.assertEqual(sorted(r["platform"] for r in rows), ["Facebook", "LinkedIn", "Slack"])
        self.assertEqual((await self.doc(d["slug"]))["views"], 0)
        self.assertEqual(await self.db["events"].count_documents({"type": "view"}), 0)
        # After 10 minutes the same platform counts again.
        await self.db["events"].update_many({"type": "preview"}, {"$set": {"ts": now() - timedelta(minutes=11)}})
        await self.http.get(f"/api/v1/og/{d['slug']}.png", headers={"User-Agent": "Slackbot 1.0"})
        self.assertEqual(await self.db["events"].count_documents({"type": "preview", "platform": "Slack"}), 2)

    def test_platforms(self):
        cases = {"WhatsApp/2.23.20.0": "WhatsApp", "Twitterbot/1.0": "X",
                 "Mozilla/5.0 (compatible; Discordbot/2.0)": "Discord", "TelegramBot (like TwitterBot)": "Telegram",
                 "Mozilla/5.0 SkypeUriPreview Preview/0.5": "Teams", "redditbot/1.0": "Other", UA: None}
        for ua, want in cases.items():
            self.assertEqual(og_router.preview_platform(ua), want, ua)


# ── Read API: access ──────────────────────────────────────────────────────────

DOC_PATHS = ("analytics/overview", "analytics/media", "analytics/content", "analytics/pages",
             "analytics/audience", "analytics/versions", "analytics.csv", "analytics/frame?t=3")


class ReadAccess(World):
    async def test_owner_only(self):
        link = await self.mkdoc("L", ws=None)
        private = await self.mkdoc("P", ws=None, grants=False)
        for path in DOC_PATHS:
            url = f"/api/v1/me/documents/{link['slug']}/{path}"
            self.assertEqual((await self.http.get(url)).status_code, 401, path)
            self.assertEqual((await self.http.get(url, headers=self.session("stranger"))).status_code, 403, path)
            self.assertEqual((await self.http.get(url, headers=self.session("gv"))).status_code, 403, path)
            purl = f"/api/v1/me/documents/{private['slug']}/{path}"
            self.assertEqual((await self.http.get(purl, headers=self.session("stranger"))).status_code, 404, path)
            murl = f"/api/v1/me/documents/missing-doc-x/{path}"
            self.assertEqual((await self.http.get(murl, headers=self.session("stranger"))).status_code, 404, path)
            want = 404 if "frame" in path else 200
            self.assertEqual((await self.http.get(url, headers=self.session("owner"))).status_code, want, path)
        for path in ("/api/v1/me/analytics", "/api/v1/me/analytics/live", "/api/v1/me/analytics.csv"):
            self.assertEqual((await self.http.get(path)).status_code, 401, path)
            self.assertEqual((await self.http.get(path, headers=self.session("owner"))).status_code, 200, path)
        # Tenant tokens never reach these.
        r = await self.http.get(f"/api/v1/me/documents/{link['slug']}/analytics/overview",
                                headers=self.tenant("owner", "W1"))
        self.assertEqual(r.status_code, 401)

    async def test_bad_params_422(self):
        d = await self.mkdoc("L", ws=None)
        h = self.session("owner")
        for q in ("range=1y", "internal=2"):
            r = await self.http.get(f"/api/v1/me/documents/{d['slug']}/analytics/overview?{q}", headers=h)
            self.assertEqual(r.status_code, 422, q)

    async def test_old_endpoint_still_works(self):
        d = await self.mkdoc("L", ws=None)
        await self.view(d["slug"])
        r = await self.http.get(f"/api/v1/me/documents/{d['slug']}/analytics", headers=self.session("owner"))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["totals"]["views"], 1)


# ── Read API: shapes and math ─────────────────────────────────────────────────


class Overview(World):
    async def _get(self, d, path="analytics/overview", **params):
        r = await self.http.get(f"/api/v1/me/documents/{d['slug']}/{path}", params=params,
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def test_doc_overview_shape(self):
        d = await self.mkdoc("L")
        await self.seed_views(d, [{"ip_hash": "a", "channel": "Social"}, {"ip_hash": "a", "channel": "Social"},
                                  {"ip_hash": "b", "referrer": "https://www.google.com/"},
                                  {"ip_hash": "c", "internal": True},
                                  {"ip_hash": "z", "ts": now() - timedelta(days=40)}])
        await self.seed(d, 2, depth=95, active_s=40, copies={"h|": 2}, links={"a.com/x|": 1})
        await self.seed(d, 1, depth=20, active_s=10, started_at=now() - timedelta(days=35))
        out = await self._get(d)
        self.assertEqual(set(out) >= {"doc", "range", "has_engagement", "tracking_since", "live", "kpis",
                                      "daily", "versions_marks", "sources", "insights"}, True)
        self.assertEqual(out["doc"]["kind"], "doc")
        self.assertEqual(out["doc"]["workspace"]["name"], "Acme")
        self.assertTrue(out["doc"]["address"].startswith("https://docs.acme.test/"))
        self.assertTrue(out["has_engagement"])
        kp = {k["key"]: k for k in out["kpis"]}
        self.assertEqual(list(kp), ["views", "people", "read_all", "read_time", "copies_clicks"])
        self.assertEqual((kp["views"]["value"], kp["people"]["value"]), (3, 2))
        self.assertEqual((kp["read_all"]["value"], kp["read_time"]["value"], kp["copies_clicks"]["value"]),
                         (100.0, 40.0, 6))
        self.assertEqual(kp["views"]["prev"], 1)
        self.assertEqual(kp["read_all"]["prev"], 0.0)
        self.assertEqual(len(out["daily"]), 30)
        self.assertEqual(sum(x["views"] for x in out["daily"]), 3)
        self.assertEqual({s["channel"]: s["views"] for s in out["sources"]}, {"Social": 2, "Search": 1})
        # internal=1 includes members' views.
        out = await self._get(d, internal=1)
        self.assertEqual({k["key"]: k["value"] for k in out["kpis"]}["views"], 4)
        out = await self._get(d, range="all")
        self.assertNotIn("prev", out["kpis"][0])
        self.assertEqual(out["kpis"][0]["value"], 4)
        out = await self._get(d, range="7d")
        self.assertEqual(len(out["daily"]), 7)

    async def test_kpi_keys_by_kind(self):
        v = await self.video()
        a = await self.mkdoc("L", ws=None, kind="artifact", mime="audio/mpeg", media={"duration_s": 60})
        p = await self.mkdoc("L", ws=None, kind="artifact", mime="application/pdf")
        o = await self.mkdoc("L", ws=None, kind="artifact")
        await self.seed(v, 2, media={"dur": 100, "segs": [[0, 50]], "plays": 1, "watched_s": 50})
        await self.seed(p, 2, npages=10, pmax=10)
        for doc, keys in ((v, ["views", "people", "watch_time", "avg_watched", "played"]),
                          (a, ["views", "people", "watch_time", "avg_watched", "played"]),
                          (p, ["views", "people", "reached_end", "read_time", "pages_npages"]),
                          (o, ["views", "people", "time", "returning"])):
            out = await self._get(doc)
            self.assertEqual([k["key"] for k in out["kpis"]], keys)
        out = await self._get(v)
        kp = {k["key"]: k for k in out["kpis"]}
        self.assertEqual((kp["watch_time"]["value"], kp["avg_watched"]["value"], kp["played"]["value"]),
                         (100, 50.0, 100.0))
        self.assertEqual(out["doc"]["duration_s"], 100.0)
        self.assertEqual({k["key"]: k["label"] for k in (await self._get(a))["kpis"]}["watch_time"], "Listen time")
        out = await self._get(p)
        kp = {k["key"]: k for k in out["kpis"]}
        self.assertEqual((kp["reached_end"]["value"], kp["pages_npages"]["value"], kp["pages_npages"]["note"]),
                         (100.0, 10.0, "of 10"))
        self.assertEqual(out["doc"]["npages"], 10)

    async def test_versions_marks(self):
        v = await self.video(file_version=2)
        await self.db["file_versions"].insert_many([
            {"doc_id": str(v["_id"]), "version": 1, "blob_key": "k1", "created_at": now() - timedelta(days=60),
             "media": {"duration_s": 100}, "size_bytes": 1},
            {"doc_id": str(v["_id"]), "version": 2, "blob_key": v["blob_key"], "created_at": now() - timedelta(days=3),
             "media": {"duration_s": 100}, "size_bytes": 1}])
        out = await self._get(v)
        self.assertEqual(out["versions_marks"], [{"date": (now() - timedelta(days=3)).date().isoformat(),
                                                  "version": 2}])

    async def test_media_retention_fixture(self):
        v = await self.video()
        await self.seed(v, 1, media={"dur": 100, "segs": [[0, 50]], "plays": 1, "watched_s": 50,
                                     "startup_ms": 800, "speed": {"1": 50}, "fs_s": 3})
        await self.seed(v, 1, media={"dur": 100, "segs": [[0, 100]], "plays": 1, "ended": 1, "watched_s": 100,
                                     "startup_ms": 1200, "speed": {"1": 50, "1．5": 50}, "rebuf_n": 1},
                        device="Mobile")
        await self.seed(v, 1, media={"dur": 100, "segs": [[0, 10], [90, 100], [0, 10]], "plays": 1,
                                     "watched_s": 20, "startup_ms": 7000}, device="Mobile")
        await self.seed(v, 1, media={"dur": 100, "segs": [], "plays": 0, "err": "network", "watched_s": 0})
        out = await self._get(v, "analytics/media")
        self.assertEqual((out["ver"], out["dur"], out["sessions"], out["viewers"]), (1, 100.0, 4, 4))
        ret = out["retention"]
        self.assertEqual(len(ret), 100)
        at = {p["t"]: p["pct"] for p in ret}
        self.assertEqual((at[5], at[30], at[60], at[95]), (100.0, 66.7, 33.3, 66.7))
        self.assertEqual(len(out["rewatch"]), 60)
        self.assertEqual(max(out["rewatch"]), 1.0)
        self.assertEqual(out["rewatch"][0], 1.0)  # 0:00–0:01.6 watched 4× by 3 sessions
        self.assertEqual({m["kind"] for m in out["moments"]} >= {"hold"}, True)
        self.assertEqual(out["speeds"], [{"rate": "1", "pct": 66.7}, {"rate": "1.5", "pct": 33.3}])
        self.assertEqual((out["fullscreen_pct"], out["muted_pct"]), (33.3, 0.0))
        q = out["qoe"]
        self.assertEqual((q["startup_p50_ms"], q["startup_p95_ms"], q["failed_n"], q["failed_pct"]),
                         (1200, 7000, 1, 25.0))
        self.assertEqual(q["failed_by"], [{"reason": "network", "n": 1}])
        self.assertEqual((q["stalled_pct"], q["phone_slow_pct"]), (33.3, 50.0))
        self.assertEqual(q["phone_slow_by"], [])  # fewer than 5 phones per country
        self.assertEqual(q["bitrate_kbps"], 2000)
        self.assertEqual(out["versions"], [{"version": 1, "created_at": out["versions"][0]["created_at"],
                                            "sessions": 4}])

    def test_retention_pure(self):
        s = lambda segs: {"media": {"segs": segs, "plays": 1}}  # noqa: E731
        pts, playing = ca.retention([s([[0, 31.5], [29, 60]]), s([[30, 60]]), {"media": {"plays": 0}}], 60)
        self.assertEqual((playing, len(pts)), (2, 60))
        self.assertEqual((pts[0]["pct"], pts[30]["pct"], pts[59]["pct"]), (50.0, 100.0, 100.0))
        # Long media: 600 buckets of dur/600 seconds.
        pts, _ = ca.retention([s([[0, 3600]])], 3600)
        self.assertEqual((len(pts), pts[1]["t"]), (600, 6.0))
        self.assertEqual(ca.retention([s([[0, 1]])], 0), ([], 0))

    async def test_content_report(self):
        d = await self.mkdoc("L", ws=None)
        await self.seed(d, 3, depth=95, reached=["intro", "install"], sec={"intro": 5, "install": 20},
                        copies={"abc|install": 1}, links={"github．com/x|intro": 2}, prints=1)
        await self.seed(d, 1, depth=30, reached=["intro"], sec={"intro": 9})
        out = await self._get(d, "analytics/content")
        self.assertEqual((out["sessions"], out["read_all_pct"], out["prints"]), (4, 75.0, 3))
        self.assertEqual(out["sections"], [{"id": "intro", "reached_pct": 100.0, "median_s": 5.0},
                                           {"id": "install", "reached_pct": 75.0, "median_s": 20.0}])
        self.assertEqual(out["copies"], [{"hash": "abc", "section": "install", "n": 3}])
        self.assertEqual(out["links"], [{"href": "github.com/x", "section": "intro", "n": 6}])

    async def test_pages_report(self):
        p = await self.mkdoc("L", ws=None, kind="artifact", mime="application/pdf")
        await self.seed(p, 2, npages=4, pmax=4, pages={"1": 10, "2": 20, "3": 5, "4": 5}, rv={"2": 1})
        await self.seed(p, 2, npages=4, pmax=1, pages={"1": 4})
        out = await self._get(p, "analytics/pages")
        self.assertEqual((out["sessions"], out["npages"]), (4, 4))
        self.assertEqual([r["pct"] for r in out["reach"]], [100.0, 50.0, 50.0, 50.0])
        self.assertEqual(out["time"][0], {"page": 1, "median_s": 7.0})
        self.assertEqual(out["back"][1], {"page": 2, "pct": 100.0})
        self.assertEqual(out["biggest_drop"], {"after_page": 1, "pct": 50.0})

    async def test_audience_k_anonymity(self):
        d = await self.mkdoc("L")
        rows = [{"ip_hash": f"de{i}", "country": "DE", "device": "Desktop"} for i in range(6)]
        rows += [{"ip_hash": f"fr{i}", "country": "FR", "device": "Mobile"} for i in range(2)]
        rows += [{"ip_hash": "us0", "country": "US", "device": "Mobile"}]
        rows += [{"ip_hash": f"c{i}", "country": "DE", "utm_source": "newsletter", "utm_medium": "email",
                  "utm_campaign": "oct", "channel": "Email"} for i in range(5)]
        rows += [{"ip_hash": "c9", "utm_source": "x.com", "channel": "Social"}]
        rows += [{"ip_hash": "m1", "internal": True}, {"ip_hash": "m1", "internal": True}]
        # Returning: de0 was here on another day too.
        rows += [{"ip_hash": "de0", "ts": now() - timedelta(days=3)}]
        await self.seed_views(d, rows)
        await self.db["events"].insert_one({"doc_id": str(d["_id"]), "type": "preview", "platform": "Slack",
                                            "ts": now() - timedelta(hours=1)})
        await self.seed(d, 2, country="FR", depth=95)
        await self.seed(d, 2, country="US", depth=0)
        out = await self._get(d, "analytics/audience")
        self.assertEqual(out["countries"][0], {"country": "DE", "people": 11, "engaged_pct": None})
        self.assertEqual(out["countries"][1], {"country": "Other", "people": 3, "engaged_pct": 50.0})
        self.assertEqual(out["campaigns"][0]["source"], "newsletter")
        self.assertEqual(out["campaigns"][0]["people"], 5)
        self.assertEqual(out["campaigns"][-1]["source"], "Other")
        self.assertEqual((out["new"], out["returning"]), (14, 1))
        self.assertEqual(out["internal_hidden"], 2)
        self.assertEqual([s["platform"] for s in out["signals"]], ["Slack"])
        self.assertEqual(out["workspace"]["name"], "Acme")
        self.assertEqual({x["device"] for x in out["devices"]}, {"Desktop", "Mobile"})
        self.assertIn("channels", out)

    async def test_versions_report(self):
        v = await self.video(file_version=2)
        await self.db["file_versions"].insert_many([
            {"doc_id": str(v["_id"]), "version": 1, "blob_key": "k1", "created_at": now() - timedelta(days=60),
             "media": {"duration_s": 100}, "size_bytes": 1},
            {"doc_id": str(v["_id"]), "version": 2, "blob_key": v["blob_key"],
             "created_at": now() - timedelta(days=3), "media": {"duration_s": 100}, "size_bytes": 1}])
        await self.seed(v, 3, ver=1, media={"dur": 100, "segs": [[0, 20]], "plays": 1, "watched_s": 20})
        await self.seed(v, 1, ver=2, media={"dur": 100, "segs": [[0, 100]], "plays": 1, "watched_s": 100})
        await self.seed_views(v, [{"ver": 1}, {"ver": 2}, {"ver": 2}])
        out = await self._get(v, "analytics/versions")
        by = {x["version"]: x for x in out["versions"]}
        self.assertEqual((by[1]["sessions"], by[2]["sessions"], by[1]["views"], by[2]["views"]), (3, 1, 1, 2))
        self.assertEqual(by[1]["primary_metric"], {"label": "Avg watched", "value": 20.0})
        self.assertEqual(len(by[2]["first_minute"]), 31)
        self.assertEqual(by[1]["first_minute"][-1], {"t": 60, "pct": 0.0})
        media2 = await self._get(v, "analytics/media", ver=1)
        self.assertEqual((media2["ver"], media2["sessions"]), (1, 3))

    async def test_csv(self):
        d = await self.mkdoc("L", ws=None)
        await self.seed_views(d, [{"ip_hash": "a"}, {"ip_hash": "b"}])
        await self.seed(d, 1, active_s=12)
        r = await self.http.get(f"/api/v1/me/documents/{d['slug']}/analytics.csv?range=7d",
                                headers=self.session("owner"))
        self.assertTrue(r.headers["content-type"].startswith("text/csv"))
        lines = r.text.strip().splitlines()
        self.assertEqual(lines[0], "date,views,people,sessions,active_s,watched_s")
        self.assertEqual(len(lines), 8)
        today = [ln for ln in lines if ln.startswith((now() - timedelta(hours=2)).date().isoformat())]
        self.assertTrue(today and today[0].split(",")[1] == "2")
        r = await self.http.get("/api/v1/me/analytics.csv", headers=self.session("owner"))
        lines = r.text.strip().splitlines()
        self.assertEqual(lines[0], "slug,title,kind,views,people,engaged_metric,engaged_value")
        self.assertTrue(lines[1].startswith(d["slug"] + ","))


class Home(World):
    async def test_home_and_live(self):
        mine = await self.mkdoc("L", ws=None)
        vid = await self.video()
        other = await self.mkdoc("L", ws=None, owner="stranger")
        await self.seed_views(mine, [{"ip_hash": "a"}, {"ip_hash": "b"}, {"ip_hash": "b"}])
        await self.seed_views(vid, [{"ip_hash": "a"}])
        await self.seed_views(other, [{"ip_hash": "q"}] * 5)
        await self.seed(mine, 2, depth=95)
        await self.seed(vid, 1, media={"dur": 100, "segs": [[0, 60]], "plays": 1, "watched_s": 60})
        await self.engage(mine["slug"], {"sid": sid(), "seq": 1, "pos": {"h": "intro"}, "d": {"active_s": 5}})
        await self.engage(other["slug"], {"sid": sid(), "seq": 1, "d": {"active_s": 5}})
        r = await self.http.get("/api/v1/me/analytics", headers=self.session("owner"))
        out = r.json()
        self.assertEqual([k["key"] for k in out["kpis"]], ["views", "people", "watch_time", "read_end"])
        kp = {k["key"]: k["value"] for k in out["kpis"]}
        self.assertEqual((kp["views"], kp["people"], kp["watch_time"]), (4, 2, 60))
        # Two seeded reads to the end, plus the live beacon's session (depth 0).
        self.assertEqual(kp["read_end"], 66.7)
        self.assertEqual([x["slug"] for x in out["links"]], [mine["slug"], vid["slug"]])
        first = out["links"][0]
        self.assertEqual(set(first), {"slug", "title", "kind", "renderer", "icon", "views", "spark",
                                      "engage_label", "last_view", "live"})
        self.assertEqual((len(first["spark"]), sum(first["spark"]), first["live"]), (14, 3, True))
        self.assertEqual(first["engage_label"], "67% read to the end")
        self.assertEqual(out["links"][1]["engage_label"], "60% watched")
        self.assertEqual(out["live"], {"people": 1, "links": 1})
        self.assertLessEqual(len(out["insights"]), 4)

        r = await self.http.get("/api/v1/me/analytics/live", headers=self.session("owner"))
        live = r.json()
        self.assertEqual((live["people"], live["links"]), (1, 1))
        self.assertEqual(live["docs"][0]["slug"], mine["slug"])
        self.assertNotIn("dur", live["docs"][0])
        self.assertEqual(live["docs"][0]["entries"], [{"pos": {"h": "intro"}, "country": "DE",
                                                       "device": "Desktop"}])
        self.assertTrue(live["feed"])
        self.assertTrue(all(f["slug"] in (mine["slug"], vid["slug"]) for f in live["feed"]))
        self.assertLessEqual(len(live["feed"]), 30)


class LiveMedia(World):
    async def test_live_video_carries_duration(self):
        vid = await self.video()
        await self.engage(vid["slug"], {"sid": sid(), "seq": 1, "pos": {"s": 42}, "d": {"active_s": 5}})
        live = (await self.http.get("/api/v1/me/analytics/live", headers=self.session("owner"))).json()
        self.assertEqual(live["docs"][0]["dur"], 100.0)
        self.assertEqual(live["docs"][0]["entries"][0]["pos"], {"s": 42.0})


class Frames(World):
    async def test_frame_404_without_ffmpeg_and_cache_hit(self):
        v = await self.video()
        h = self.session("owner")
        r = await self.http.get(f"/api/v1/me/documents/{v['slug']}/analytics/frame?t=12.4", headers=h)
        self.assertEqual(r.status_code, 404)  # ffmpeg is /nonexistent in tests
        self.r2.put_bytes(f"{v['blob_key']}.f/12.jpg", b"\xff\xd8cached", "image/jpeg", False)
        r = await self.http.get(f"/api/v1/me/documents/{v['slug']}/analytics/frame?t=12.4", headers=h)
        self.assertEqual((r.status_code, r.content), (200, b"\xff\xd8cached"))
        self.assertEqual(r.headers["cache-control"], "private, max-age=86400")
        self.assertEqual(r.headers["content-type"], "image/jpeg")
        md = await self.mkdoc("L", ws=None)
        r = await self.http.get(f"/api/v1/me/documents/{md['slug']}/analytics/frame?t=1", headers=h)
        self.assertEqual(r.status_code, 404)

    async def test_frame_generated_and_cached(self):
        from app.services import media

        v = await self.video()
        calls = []

        async def fake_frame(url, mime, t, max_width=640):
            calls.append((url, mime, t))
            return b"\xff\xd8new"

        with mock.patch.object(media, "binary", lambda name: "/usr/bin/ffmpeg"), \
                mock.patch.object(media, "frame", fake_frame):
            r = await self.http.get(f"/api/v1/me/documents/{v['slug']}/analytics/frame?t=500",
                                    headers=self.session("owner"))
        self.assertEqual((r.status_code, r.content), (200, b"\xff\xd8new"))
        self.assertEqual(calls[0][2], 99)  # clamped inside the video
        obj = self.r2.objects[f"{v['blob_key']}.f/99.jpg"]
        self.assertFalse(obj["public"])

    async def test_frames_deleted_with_the_video(self):
        from app.services import lifecycle

        v = await self.video(blob_key=f"art/{self.uid['owner']}/vid.mp4")
        self.r2.put_bytes(v["blob_key"], b"v", "video/mp4", False)
        self.r2.put_bytes(f"{v['blob_key']}.f/3.jpg", b"\xff\xd8", "image/jpeg", False)
        await lifecycle._delete_objects(await self.doc(v["slug"]))
        self.assertNotIn(f"{v['blob_key']}.f/3.jpg", self.r2.objects)


# ── §5 insights ───────────────────────────────────────────────────────────────


def _curve(dur: int, cliff: int | None = None, drop: float = 30.0) -> list[dict]:
    return [{"t": float(t), "pct": 90.0 - (drop if cliff is not None and t >= cliff else 0.0)}
            for t in range(dur)]


class Insights(World):
    def test_video_drop_and_hold(self):
        out = insights.for_document({"kind": "video", "sessions": 40, "playing": 30, "dur": 300,
                                     "retention": _curve(300, cliff=134), "hold30": 90.0, "other_hold30": 60.0,
                                     "slug": "v"})
        keys = [i["key"] for i in out]
        self.assertEqual(keys[:2], ["media_drop", "hold_30s"])
        self.assertEqual(out[0]["title"], "Most viewers leave at 2:14")
        self.assertEqual((out[0]["thumb"], out[0]["severity"], out[0]["slug"]), ("2:14", "warning", "v"))
        self.assertEqual(out[1]["severity"], "success")
        # Too small a sample: nothing.
        self.assertEqual(insights.for_document({"kind": "video", "sessions": 5, "playing": 5, "dur": 300,
                                                "retention": _curve(300, cliff=134)}), [])
        # A cliff before 0:10 or at the very end doesn't count.
        self.assertEqual(insights.for_document({"kind": "video", "sessions": 40, "playing": 30, "dur": 300,
                                                "retention": _curve(300, cliff=5)}), [])

    def test_version_phone_trend_channel_signal(self):
        out = insights.for_document({
            "kind": "video", "sessions": 50, "views": 90, "prev_views": 40,
            "versions": [{"version": 4, "sessions": 25, "metric": 70.0},
                         {"version": 3, "sessions": 25, "metric": 50.0}], "metric_label": "Avg watched",
            "phone": {"n": 20, "slow_pct": 25.0},
            "channels": [{"channel": "Social", "views": 50, "engaged_pct": 60.0},
                         {"channel": "Direct", "views": 40, "engaged_pct": 10.0}], "engaged_pct": 30.0,
            "signals": [{"platform": "Slack", "n": 6}]})
        keys = [i["key"] for i in out]
        self.assertEqual(len(out), 4)  # never more than four
        self.assertEqual(keys[0], "phone_slow")  # warnings first
        self.assertIn("version_compare", keys)
        self.assertIn("trend_up", keys)
        full = insights.for_document({"kind": "doc", "sessions": 50, "channels": [
            {"channel": "Social", "views": 50, "engaged_pct": 60.0}], "engaged_pct": 30.0,
            "signals": [{"platform": "Slack", "n": 6}], "views": 10, "prev_views": 12})
        self.assertEqual([i["key"] for i in full], ["top_channel", "share_signal"])
        self.assertEqual(full[1]["title"], "Shared in Slack 6 times")
        down = insights.for_document({"kind": "doc", "sessions": 0, "views": 10, "prev_views": 40})
        self.assertEqual([i["key"] for i in down], ["trend_down"])
        self.assertEqual(insights.for_document({"kind": "doc", "views": 10, "prev_views": 15}), [])

    def test_section_and_page_drop(self):
        out = insights.for_document({"kind": "doc", "sessions": 30, "sections": [
            {"id": "intro", "reached_pct": 100.0}, {"id": "install", "reached_pct": 95.0},
            {"id": "usage", "reached_pct": 60.0}]})
        self.assertEqual((out[0]["key"], out[0]["section"]), ("section_drop", "install"))
        out = insights.for_document({"kind": "pdf", "sessions": 30, "pages": {"reach": [
            {"page": 1, "pct": 100.0}, {"page": 2, "pct": 90.0}, {"page": 3, "pct": 40.0}]}})
        self.assertEqual((out[0]["key"], out[0]["title"]), ("page_drop", "Readers stop after page 2"))
        self.assertEqual(insights.for_document({"kind": "pdf", "sessions": 10, "pages": {"reach": [
            {"page": 1, "pct": 100.0}, {"page": 2, "pct": 10.0}]}}), [])

    async def test_overview_insights_end_to_end(self):
        d = await self.mkdoc("L", ws=None)
        await self.seed(d, 25, depth=95, reached=["intro", "install"])
        await self.seed(d, 25, depth=10, reached=["intro"])
        r = await self.http.get(f"/api/v1/me/documents/{d['slug']}/analytics/overview",
                                headers=self.session("owner"))
        ins = r.json()["insights"]
        self.assertEqual(ins[0]["key"], "section_drop")
        self.assertEqual(ins[0]["section"], "intro")
        self.assertEqual(ins[0]["cta"], {"label": "See sections", "tab": "content"})
