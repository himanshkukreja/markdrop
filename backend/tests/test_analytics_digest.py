"""The weekly analytics digest (creator analytics build spec §6): who gets it,
never twice in a week, when it's due, what it says (escaped), the signed
turn-off link, the account preference, and that it's off by default.

Never reaches Resend: _email_env blanks the API key first and every test that
sends patches ``mailer._post`` to capture the payload.
"""

from __future__ import annotations

from tests import _email_env  # noqa: F401  (pins settings first)

from datetime import datetime, timedelta, timezone
from unittest import mock

from bson import ObjectId

from tests._access_env import AccessWorld

from app.config import Settings, get_settings
from app.services import analytics_digest as digest
from app.services import engage, mailer, md_outline

settings = get_settings()

# A Monday, 04:00 UTC: last week is the Monday 7 days earlier up to this one.
NOW = digest.monday_of(datetime.now(timezone.utc)) + timedelta(hours=4)
LAST_WEEK = NOW - timedelta(days=3)


class DigestWorld(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await digest.ensure_indexes(self.db)
        self.sent: list[dict] = []

        async def fake_post(payload):
            self.sent.append(payload)

        for p in (mock.patch.object(mailer, "_post", fake_post),
                  mock.patch.object(mailer, "is_configured", lambda: True)):
            p.start()
            self.addCleanup(p.stop)

    async def views(self, doc: dict, n: int, *, ts: datetime = LAST_WEEK, internal: bool = False,
                    channel: str = "Direct") -> None:
        await self.db["events"].insert_many([
            {"doc_id": str(doc["_id"]), "owner_id": doc.get("owner_id"), "type": "view", "ts": ts,
             "ip_hash": f"ip{i}-{ObjectId()}", "channel": channel, "internal": internal} for i in range(n)])

    async def sessions(self, doc: dict, rows: list[dict], *, ts: datetime = LAST_WEEK) -> None:
        base = {"doc_id": str(doc["_id"]), "owner_id": doc.get("owner_id"), "kind": engage.kind_for(doc),
                "ver": None, "internal": False, "started_at": ts, "updated_at": ts, "active_s": 40,
                "depth": 0, "reached": [], "sec": {}, "copies": {}, "links": {}, "npages": None, "pmax": 0,
                "media": None, "device": "Desktop", "channel": "Direct"}
        await self.db[engage.COLL].insert_many(
            [{**base, "sid": f"s{i}-{ObjectId()}", "ip_hash": f"ip{i}", **r} for i, r in enumerate(rows)])

    async def user(self, who: str) -> dict:
        return await self.db["users"].find_one({"_id": ObjectId(self.uid[who])})


class Recipients(DigestWorld):
    async def test_owners_with_views_only(self):
        d_owner = await self.mkdoc("UL", owner="owner")
        await self.views(d_owner, 3)
        # Workspace members' views only: not a reason to email.
        d_internal = await self.mkdoc("UL", owner="wa")
        await self.views(d_internal, 5, internal=True)
        # Views from before last week don't count.
        d_old = await self.mkdoc("UL", owner="wo")
        await self.views(d_old, 4, ts=NOW - timedelta(days=10))
        # Opted out of all bulk mail, or of this one, or a suppressed address.
        for who in ("stranger", "gv", "ge"):
            await self.views(await self.mkdoc("UL", owner=who), 2)
        await self.db["users"].update_one({"_id": ObjectId(self.uid["stranger"])},
                                          {"$set": {"unsubscribed_at": NOW}})
        await self.db["users"].update_one({"_id": ObjectId(self.uid["gv"])},
                                          {"$set": {"analytics_digest": "off"}})
        await self.db["email_suppressions"].insert_one({"_id": self.email["ge"], "reason": "bounced"})
        got = await digest.recipients(self.db, digest.report_window(NOW))
        self.assertEqual([str(u["_id"]) for u in got], [self.uid["owner"]])

    async def test_render_none_without_views(self):
        self.assertIsNone(await digest.render_digest(self.db, await self.user("owner"), NOW))


class Sending(DigestWorld):
    async def test_idempotent_across_runs_in_one_week(self):
        for who in ("owner", "wm"):
            await self.views(await self.mkdoc("UL", owner=who), 2)
        first = await digest.tick(self.db, owner="worker-a", now=NOW)
        self.assertEqual(first, {"sent": 2})
        self.assertEqual(sorted(p["to"][0] for p in self.sent),
                         sorted([self.email["owner"], self.email["wm"]]))
        # Later the same week (another worker, a restart): nothing more.
        self.assertIsNone(await digest.tick(self.db, owner="worker-b", now=NOW + timedelta(hours=3)))
        # Even a pass forced to run again skips everyone already claimed.
        again = await digest.run_pass(self.db, NOW + timedelta(hours=5))
        self.assertEqual(again, {"already": 2})
        self.assertEqual(len(self.sent), 2)
        rows = await self.db[digest.SENDS].find({}, {"_id": 0, "status": 1, "week": 1}).to_list(10)
        self.assertEqual([r["status"] for r in rows], ["sent", "sent"])
        self.assertEqual({r["week"] for r in rows}, {digest.week_key(NOW)})
        # Next week is a new week.
        await self.views(await self.mkdoc("UL", owner="owner"), 1, ts=NOW + timedelta(days=2))
        self.assertEqual(await digest.tick(self.db, owner="worker-a", now=NOW + timedelta(days=7)), {"sent": 1})

    async def test_crash_mid_pass_resumes_without_duplicates(self):
        for who in ("owner", "wm", "wa"):
            await self.views(await self.mkdoc("UL", owner=who), 1)
        # The pass died after claiming "owner" (sent or not, it isn't retried).
        await self.db[digest.SENDS].insert_one(
            {"user_id": self.uid["owner"], "week": digest.week_key(NOW), "status": "claimed", "at": NOW})
        out = await digest.tick(self.db, owner="worker-a", now=NOW)
        self.assertEqual(out, {"already": 1, "sent": 2})
        self.assertNotIn(self.email["owner"], [p["to"][0] for p in self.sent])

    async def test_failed_send_is_recorded_not_retried(self):
        await self.views(await self.mkdoc("UL", owner="owner"), 1)

        async def boom(payload):
            raise RuntimeError("resend down")

        with mock.patch.object(mailer, "_post", boom):
            self.assertEqual(await digest.run_pass(self.db, NOW), {"failed": 1})
        row = await self.db[digest.SENDS].find_one({"user_id": self.uid["owner"]})
        self.assertEqual(row["status"], "failed")

    async def test_lease_held_by_another_worker(self):
        await self.views(await self.mkdoc("UL", owner="owner"), 1)
        await self.db["job_leases"].insert_one(
            {"_id": digest.JOB_ID, "owner": "other", "lease_until": NOW + timedelta(minutes=10)})
        self.assertIsNone(await digest.tick(self.db, owner="worker-a", now=NOW))
        self.assertEqual(self.sent, [])

    async def test_not_configured_sends_nothing(self):
        await self.views(await self.mkdoc("UL", owner="owner"), 1)
        with mock.patch.object(mailer, "is_configured", lambda: False):
            self.assertIsNone(await digest.tick(self.db, owner="worker-a", now=NOW))
        self.assertEqual(self.sent, [])

    async def test_payload(self):
        await self.views(await self.mkdoc("UL", owner="owner", title="Launch notes"), 3)
        await digest.run_pass(self.db, NOW)
        (p,) = self.sent
        self.assertEqual(p["to"], [self.email["owner"]])
        self.assertTrue(p["subject"].startswith("Your Markdrop week: 3 views"))
        off = digest.off_url(self.uid["owner"])
        self.assertTrue(off.startswith("https://api.markdrop.in/api/v1/me/digest/off?t="))
        self.assertEqual(p["headers"], {"List-Unsubscribe": f"<{off}>",
                                        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"})
        self.assertIn("Launch notes", p["text"])
        self.assertIn(f"Turn off weekly emails: {off}", p["text"])
        self.assertIn("Open analytics: https://markdrop.in/dashboard/analytics", p["text"])


class Due(DigestWorld):
    def test_due_window(self):
        monday = digest.monday_of(NOW)
        self.assertFalse(digest.is_due_at(monday + timedelta(hours=3, minutes=29)))
        self.assertTrue(digest.is_due_at(monday + timedelta(hours=3, minutes=30)))
        self.assertTrue(digest.is_due_at(monday + timedelta(days=1, hours=12)))   # Tuesday catch-up
        self.assertFalse(digest.is_due_at(monday + timedelta(days=2)))            # Wednesday: skipped
        self.assertFalse(digest.is_due_at(monday + timedelta(days=6, hours=23)))  # Sunday
        self.assertEqual(digest.monday_of(monday + timedelta(days=6, hours=23)), monday)
        w = digest.report_window(monday + timedelta(hours=4))
        self.assertEqual((w.start, w.end, w.prev_start), (monday - timedelta(days=7), monday,
                                                           monday - timedelta(days=14)))

    async def test_tick_not_due_on_sunday(self):
        await self.views(await self.mkdoc("UL", owner="owner"), 1, ts=NOW + timedelta(days=2))
        self.assertIsNone(await digest.tick(self.db, owner="worker-a", now=NOW + timedelta(days=6)))
        self.assertEqual(self.sent, [])

    async def test_disabled_by_default(self):
        self.assertIs(Settings.model_fields["analytics_digest_enabled"].default, False)
        with mock.patch.object(settings, "analytics_digest_enabled", False):
            self.assertFalse(digest.start(lambda: self.db))
        with mock.patch.object(settings, "analytics_digest_enabled", True), \
                mock.patch.object(settings, "background_workers_enabled", False):
            self.assertFalse(digest.start(lambda: self.db))
        self.assertIsNone(digest._task)


class Content(DigestWorld):
    async def test_content_and_escaping(self):
        evil = '<script>alert(1)</script>"><img src=x onerror=alert(2)>'
        md = "# T\n\n## Install <b>now</b>\n\nx\n\n## Pricing & limits\n\ny\n"
        doc = await self.mkdoc("UL", owner="owner", title=evil, content=md)
        ids = [h["id"] for h in md_outline.extract_headings(md)]
        await self.views(doc, 30)
        await self.views(doc, 20, ts=NOW - timedelta(days=10))  # the week before: +50%
        await self.sessions(doc, [{"reached": ids[:2] if i < 18 else ids, "depth": 95 if i >= 18 else 30}
                                  for i in range(30)])
        video = await self.mkdoc("UL", owner="owner", kind="artifact", mime="video/mp4",
                                 title="Product demo", media={"duration_s": 200.0})
        await self.views(video, 10)
        await self.sessions(video, [{"media": {"plays": 1, "segs": [[0, 134]], "watched_s": 134, "dur": 200}}
                                    for _ in range(4)])
        subject, page = await digest.render_digest(self.db, await self.user("owner"), NOW)
        self.assertEqual(subject, "Your Markdrop week: 40 views, up 100%")
        self.assertIn("Your week: 40 views, up 100%", page)
        self.assertIn("your own views aren&#x27;t counted", page)
        # Escaped everywhere it appears; never raw markup from a title.
        self.assertNotIn("<script>alert", page)
        self.assertNotIn("<img src=x", page)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", page)
        for label in ("People", "Watch time", "Read to the end", "Top links", "Worth a look",
                      "Open analytics", "You get this every Monday.", "Turn off weekly emails"):
            self.assertIn(label, page)
        self.assertIn("9 min", page)      # 4 × 134 s watched
        self.assertIn("40%", page)        # 12 of 30 read to the end
        self.assertIn('href="https://markdrop.in/dashboard/analytics"', page)
        self.assertIn(f"https://markdrop.in/dashboard/analytics/{doc['slug']}", page)
        self.assertIn("40% read it all", page)
        self.assertIn("readers leave at “Install now”", page)
        self.assertIn("67% watched", page)
        self.assertNotIn("user-content-", page)
        self.assertIn(digest.off_url(self.uid["owner"]), page)

    def test_formatting(self):
        self.assertEqual(digest.fmt_watch(96 * 3600), "96 h")
        self.assertEqual(digest.fmt_watch(2.5 * 3600), "2.5 h")
        self.assertEqual(digest.fmt_watch(2 * 3600), "2 h")
        self.assertEqual(digest.fmt_watch(600), "10 min")
        self.assertEqual(digest.fmt_watch(12), "12 s")
        self.assertEqual(digest.headline(1912, 1620), "Your week: 1,912 views, up 18%")
        self.assertEqual(digest.headline(80, 100), "Your week: 80 views, down 20%")
        self.assertEqual(digest.headline(1, None), "Your week: 1 view")
        self.assertEqual(digest.headline(5, 0), "Your week: 5 views")


class Endpoints(DigestWorld):
    async def test_turn_off_link(self):
        uid = self.uid["owner"]
        t = digest.off_token(uid)
        # Bad or forged tokens.
        for bad in ("", "nope", f"{uid}.deadbeef", f"{self.uid['wm']}.{t.split('.')[1]}"):
            r = await self.http.get("/api/v1/me/digest/off", params={"t": bad})
            self.assertEqual(r.status_code, 400, bad)
            r = await self.http.post("/api/v1/me/digest/off", params={"t": bad})
            self.assertEqual(r.status_code, 400, bad)
        # A valid signature for an account that no longer exists.
        gone = str(ObjectId())
        r = await self.http.post("/api/v1/me/digest/off", params={"t": digest.off_token(gone)})
        self.assertEqual(r.status_code, 404)
        # GET only asks (mail scanners open links); it changes nothing.
        r = await self.http.get("/api/v1/me/digest/off", params={"t": t})
        self.assertEqual(r.status_code, 200)
        self.assertIn('<form method="post"', r.text)
        self.assertIn("Turn off weekly emails", r.text)
        self.assertEqual(r.headers["cache-control"], "no-store")
        self.assertNotIn("analytics_digest", await self.user("owner"))
        # The button / RFC 8058 one-click.
        r = await self.http.post("/api/v1/me/digest/off", params={"t": t},
                                 content="List-Unsubscribe=One-Click",
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(r.status_code, 200)
        self.assertIn("Weekly emails are off", r.text)
        self.assertEqual((await self.user("owner"))["analytics_digest"], "off")
        r = await self.http.get("/api/v1/me/digest/off", params={"t": t})
        self.assertIn("Weekly emails are off", r.text)
        me = await self.http.get("/api/v1/auth/me", headers=self.session("owner"))
        self.assertEqual(me.json()["analytics_digest"], "off")
        # And they're no longer a recipient.
        await self.views(await self.mkdoc("UL", owner="owner"), 2)
        self.assertEqual(await digest.recipients(self.db, digest.report_window(NOW)), [])

    async def test_preferences(self):
        me = await self.http.get("/api/v1/auth/me", headers=self.session("owner"))
        self.assertEqual(me.json()["analytics_digest"], "weekly")
        r = await self.http.patch("/api/v1/me/preferences", json={"analytics_digest": "off"})
        self.assertEqual(r.status_code, 401)
        r = await self.http.patch("/api/v1/me/preferences", json={"analytics_digest": "daily"},
                                  headers=self.session("owner"))
        self.assertEqual(r.status_code, 422)
        r = await self.http.patch("/api/v1/me/preferences", json={"analytics_digest": "off"},
                                  headers=self.session("owner"))
        self.assertEqual((r.status_code, r.json()), (200, {"analytics_digest": "off"}))
        me = await self.http.get("/api/v1/auth/me", headers=self.session("owner"))
        self.assertEqual(me.json()["analytics_digest"], "off")
        r = await self.http.patch("/api/v1/me/preferences", json={"analytics_digest": "weekly"},
                                  headers=self.session("owner"))
        self.assertEqual(r.json(), {"analytics_digest": "weekly"})
        self.assertEqual((await self.user("owner"))["analytics_digest"], "weekly")
        # A workspace domain's session can't change account settings.
        r = await self.http.patch("/api/v1/me/preferences", json={"analytics_digest": "off"},
                                  headers=self.tenant("wm", "W1"))
        self.assertIn(r.status_code, (401, 403))
        self.assertNotIn("analytics_digest", await self.user("wm"))
