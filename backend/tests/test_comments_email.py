"""Comment emails (Track C): mentions and assignments right away, replies / new comments gathered 15 minutes
per person, the calm rules (app first, daily cap, Email me less, turn-off), the send-time checks, the settings.

services/comments/notify_email.py + the email engine in services/notifications.py.
"""

from __future__ import annotations

import html
import re

from tests._comments_reach import ReachWorld, T, now, timedelta

from bson import ObjectId

from app.config import get_settings
from app.services import notifications

API = "https://api.markdrop.in"


class Mentions(ReachWorld):
    async def test_a_comment_mention_emails_right_away_with_the_thread_link(self):
        doc = await self.item()
        th = await self.thread(doc, "owner", mentions=("wm",), body="@WM can you check Friday?")
        await self.bell("wm", "comment_mention", doc, th, excerpt="@WM can you check Friday?")
        self.assertEqual(await self.flush(0.5), {})          # still gathering (60 s)
        self.assertEqual(await self.flush(2), {"sent": 1})
        mail = self.sent[0]
        self.assertEqual(mail["to"], [self.email["wm"]])
        self.assertIn("OWNER mentioned you in a comment on", mail["subject"])
        self.assertIn(f"/{doc['slug']}#c-{th['_id']}", mail["html"])
        self.assertIn("@WM can you check Friday?", mail["html"])
        self.assertIn("On “frontend”", html.unescape(mail["html"]))
        self.assertIn("Open the comment", mail["html"])
        self.assertIn("List-Unsubscribe", mail["headers"])
        settings = get_settings()
        sender = settings.email_from_share or settings.email_from
        self.assertIn(sender, mail["from"])                  # notifications@ in production, never a login sender
        self.assertIn("Email me less", mail["html"])
        self.assertEqual((await self.notes("wm"))[0]["email"], "sent")

    async def test_assigned_follows_the_mention_setting(self):
        doc = await self.item()
        th = await self.thread(doc, "owner", assignee="wm")
        await self.bell("wm", "comment_assigned", doc, th)
        self.assertEqual(await self.flush(2), {"sent": 1})
        self.assertIn("OWNER assigned a comment to you", self.sent[0]["subject"])
        await self.set_email("wm", comment_mention="off")
        th2 = await self.thread(doc, "owner", assignee="wm")
        row = await self.bell("wm", "comment_assigned", doc, th2)
        self.assertEqual(row["email"], "off")

    async def test_in_the_app_lately_it_waits_for_the_bell(self):
        doc = await self.item()
        th = await self.thread(doc, mentions=("wm",))
        await self.db["users"].update_one({"_id": ObjectId(self.uid["wm"])}, {"$set": {"app_seen_at": now()}})
        await self.bell("wm", "comment_mention", doc, th, at=now() + timedelta(seconds=1))
        self.assertEqual(await self.flush(2), {})            # held: they're around, the bell may show it
        await self.db["users"].update_one({"_id": ObjectId(self.uid["wm"])},
                                          {"$set": {"app_seen_at": now() + timedelta(minutes=3)}})
        self.assertEqual(await self.flush(4), {})            # not due before the 10-minute window
        self.assertEqual(await self.flush(11), {"seen": 1})  # the bell showed it: no email
        self.assertEqual(self.sent, [])


class Gathered(ReachWorld):
    async def test_replies_and_new_comments_are_gathered_per_person_for_15_minutes(self):
        a, b = await self.item(), await self.item()
        ta = await self.thread(a, "wm")
        tb = await self.thread(b, "wa")
        await self.bell("wm", "comment_reply", a, ta, by="wa", excerpt="Friday works")
        await self.bell("owner", "comment_new", b, tb, by="wa", excerpt="Budget looks off")   # owner's item
        await self.bell("wm", "comment_new", b, tb, by="wa", at=now() + timedelta(minutes=3), excerpt="Second one")
        self.assertEqual(await self.flush(5), {})
        self.assertEqual(await self.flush(14), {})
        got = await self.flush(16)
        self.assertEqual(got, {"sent": 2})                   # wm (two pages, one email) + owner
        by_to = {m["to"][0]: m for m in self.sent}
        wm = by_to[self.email["wm"]]
        self.assertIn("2 comment updates on 2 pages", wm["subject"])
        self.assertIn("Friday works", wm["html"])
        self.assertIn("Second one", wm["html"])
        self.assertIn("at most one email every 15 minutes", wm["html"])
        own = by_to[self.email["owner"]]
        self.assertIn("WA commented on", own["subject"])
        # Another reply right after: waits for the 15-minute gap since the last one.
        await self.bell("wm", "comment_reply", a, ta, by="wa", at=now() + timedelta(minutes=17), excerpt="Third")
        self.assertEqual(await self.flush(20), {})
        self.assertEqual(await self.flush(32), {"sent": 1})
        self.assertIn("Third", self.sent[-1]["html"])

    async def test_a_coalesced_reply_row_counts_its_replies(self):
        a = await self.item()
        ta = await self.thread(a, "wm")
        await self.bell("wm", "comment_reply", a, ta, by="wa", count=3, excerpt="Latest reply")
        self.assertEqual(await self.flush(16), {"sent": 1})
        self.assertIn("3 new replies", html.unescape(self.sent[0]["html"]))

    async def test_hourly_and_off_apply_to_comment_activity(self):
        await self.set_email("wm", comment_activity="hourly")
        a = await self.item()
        ta = await self.thread(a, "wm")
        await self.bell("wm", "comment_reply", a, ta, by="wa")
        self.assertEqual(await self.flush(16), {})
        self.assertEqual(await self.flush(31), {"sent": 1})
        await self.set_email("wm", comment_activity="off")
        row = await self.bell("wm", "comment_reply", a, ta, by="wa")
        self.assertEqual(row["email"], "off")


class SendTimeChecks(ReachWorld):
    async def test_an_edited_out_mention_an_unassign_or_a_reopen_withdraws(self):
        doc = await self.item()
        t1 = await self.thread(doc, mentions=("wm",))
        t2 = await self.thread(doc, assignee="wm")
        t3 = await self.thread(doc, "wm", status="resolved")
        await self.bell("wm", "comment_mention", doc, t1)
        await self.bell("wm", "comment_assigned", doc, t2)
        await self.bell("wm", "comment_resolved", doc, t3)
        await self.db[T].update_one({"_id": t1["_id"]}, {"$set": {"mentions": []}})
        await self.db[T].update_one({"_id": t2["_id"]}, {"$set": {"assignee": None}})
        await self.db[T].update_one({"_id": t3["_id"]}, {"$set": {"status": "open"}})
        self.assertEqual(await self.flush(20), {"withdrawn": 3})
        self.assertEqual(self.sent, [])

    async def test_a_deleted_thread_lost_access_or_comments_turned_off_send_nothing(self):
        doc = await self.item()
        t1 = await self.thread(doc, mentions=("wm",))
        await self.bell("wm", "comment_mention", doc, t1)
        await self.db[T].update_one({"_id": t1["_id"]}, {"$set": {"deleted_at": now()}})
        self.assertEqual(await self.flush(2), {"withdrawn": 1})
        # Comments turned off on the item.
        t2 = await self.thread(doc, mentions=("wm",))
        await self.bell("wm", "comment_mention", doc, t2)
        await self.db["documents"].update_one({"_id": doc["_id"]}, {"$set": {"comments_off": True}})
        self.assertEqual(await self.flush(2), {"no_access": 1})
        # Lost access: a private item they're not on.
        priv = await self.item("P")
        t3 = await self.thread(priv, mentions=("wm",))
        await self.bell("wm", "comment_mention", priv, t3)
        self.assertEqual(await self.flush(2), {"no_access": 1})
        self.assertEqual(self.sent, [])


class Settings(ReachWorld):
    async def test_defaults_choices_and_the_less_link(self):
        me = (await self.http.get("/api/v1/auth/me", headers=self.session("wm"))).json()
        self.assertEqual((me["email_notify"]["comment_mention"], me["email_notify"]["comment_activity"]),
                         ("instant", "instant"))
        r = await self.http.patch("/api/v1/me/preferences", json={"email_notify": {"comment_activity": "daily"}},
                                  headers=self.session("wm"))
        self.assertEqual(r.json()["email_notify"]["comment_activity"], "daily")
        r = await self.http.patch("/api/v1/me/preferences", json={"email_notify": {"comment_mention": "weekly"}},
                                  headers=self.session("wm"))
        self.assertEqual(r.status_code, 422)
        # A mention email's "Email me less" steps comment mentions down, nothing else.
        doc = await self.item()
        th = await self.thread(doc, mentions=("wm",))
        await self.bell("wm", "comment_mention", doc, th)
        await self.flush(2)
        m = re.search(r'href="([^"]*/api/v1/me/emails/less\?t=[^"]+)"', self.sent[0]["html"])
        link = html.unescape(m.group(1)).split(API, 1)[1]
        r = await self.http.post(link)
        self.assertEqual(r.status_code, 200)
        modes = (await self.db["users"].find_one({"_id": ObjectId(self.uid["wm"])}))["email_notify"]
        self.assertEqual((modes["comment_mention"], modes["mention"], modes["comment_activity"]),
                         ("hourly", "hourly", "daily"))

    async def test_turn_off_link_turns_comment_emails_off_too_and_pending_rows_drop(self):
        doc = await self.item()
        th = await self.thread(doc, "wm")
        await self.bell("wm", "comment_reply", doc, th, by="wa")
        r = await self.http.patch("/api/v1/me/preferences", json={"mention_emails": False}, headers=self.session("wm"))
        self.assertEqual(set(r.json()["email_notify"].values()), {"off"})
        self.assertEqual((await self.notes("wm"))[0]["email"], "off")
        self.assertEqual(await self.flush(20), {})

    async def test_daily_cap_counts_comment_emails(self):
        await self.set_email("wm", comment_mention="instant")
        for _ in range(4):
            doc = await self.item()
            th = await self.thread(doc, mentions=("wm",))
            await self.bell("wm", "comment_mention", doc, th)
        got = await self.flush(2)
        self.assertEqual(got, {"sent": notifications.DAILY_CAP, "capped": 1})


class EndToEnd(ReachWorld):
    """Through Track A's real routes: a thread with a mention, replies, the bell rows, the emails."""

    async def post(self, who: str, path: str, body: dict):
        r = await self.http.post(path, json=body, headers=self.session(who))
        self.assertIn(r.status_code, (200, 201), r.text)
        return r.json()

    async def test_mention_then_replies_through_the_api(self):
        doc = await self.item()
        base = f"/api/v1/documents/{doc['slug']}/comments"
        th = await self.post("owner", base, {"anchor": {"type": "text", "quote": {"exact": "frontend"}},
                                             "body": "@WM is Friday real?", "mentions": [self.uid["wm"]]})
        self.assertEqual([r["kind"] for r in await self.notes("wm")], ["comment_mention"])
        self.assertEqual(await self.flush(2), {"sent": 1})
        self.assertIn("mentioned you in a comment", self.sent[-1]["subject"])
        self.assertIn(f"#c-{th['id']}", self.sent[-1]["html"])
        # wm replies: the owner (thread author) gets a reply row, gathered 15 minutes.
        await self.post("wm", f"{base}/{th['id']}/replies", {"body": "Yes, Friday holds"})
        self.assertEqual([r["kind"] for r in await self.notes("owner")], ["comment_reply"])
        self.assertEqual(await self.flush(5), {})
        self.assertEqual(await self.flush(16), {"sent": 1})
        self.assertIn("WM replied to a comment", self.sent[-1]["subject"])
        # Another reply while that row is unread: the same row, its email put back in line.
        await self.post("wm", f"{base}/{th['id']}/replies", {"body": "And QA signed off"})
        rows = await self.notes("owner")
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["email"], rows[0]["extra"]["count"]), ("pending", 2))
        self.assertEqual(await self.flush(40), {"sent": 1})
        self.assertIn("And QA signed off", self.sent[-1]["html"])
