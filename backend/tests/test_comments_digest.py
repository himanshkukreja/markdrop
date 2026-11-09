"""The daily comments digest (Track C, services/comments/digest.py): what's in it (waiting on you, open threads
on your items, access-checked), only on a day with something new, once a day at 08:00 local, the off switch and
its signed link."""

from __future__ import annotations

import html
import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from tests._comments_reach import ReachWorld, now, timedelta

from bson import ObjectId

from app.services.comments import digest

API = "https://api.markdrop.in"


def morning_zone() -> str:
    """A timezone where it's past 08:00 (and before 23:00) right now."""
    for tz in ("UTC", "Asia/Kolkata", "Pacific/Kiritimati", "America/Los_Angeles", "Pacific/Pago_Pago",
               "Asia/Tokyo", "Europe/London", "America/New_York"):
        h = datetime.now(timezone.utc).astimezone(ZoneInfo(tz)).hour
        if 8 <= h < 23:
            return tz
    return "UTC"


class Digest(ReachWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await digest.ensure_indexes(self.db)
        self.tz = morning_zone()
        await self.db["users"].update_many({}, {"$set": {"email_tz": self.tz}})

    async def user(self, who: str) -> dict:
        return await self.db["users"].find_one({"_id": ObjectId(self.uid[who])})

    async def world(self) -> dict:
        """wm: one thread assigned, one where the newest message mentions them, their own thread answered;
        owner: open threads on their item."""
        doc = await self.item(title="Launch plan")
        a = await self.thread(doc, "owner", assignee="wm", body="Please own the Friday date")
        b = await self.thread(doc, "owner", quote="payments API", body="Thoughts?")
        await self.message(b, "wa", "@WM can you load test it?", at=now() + timedelta(seconds=5), mentions=("wm",))
        c = await self.thread(doc, "wm", quote="one more hire", body="Which role?")
        await self.message(c, "owner", "A designer", at=now() + timedelta(seconds=6))
        # Not waiting on wm: they wrote last.
        d = await self.thread(doc, "owner", quote="Budget", mentions=("wm",))
        await self.message(d, "wm", "On it", at=now() + timedelta(seconds=7))
        # A private item wm can't open, where they're mentioned: never listed.
        priv = await self.item("P", title="Secret plan")
        await self.thread(priv, "owner", mentions=("wm",), body="@WM secret")
        return {"doc": doc, "a": a, "b": b, "c": c, "d": d, "priv": priv}

    async def test_waiting_on_you_and_your_items_access_checked(self):
        w = await self.world()
        data = await digest.build(self.db, await self.user("wm"))
        why = {r["thread_id"]: r["reason"] for r in data["waiting"]}
        self.assertEqual(why, {str(w["a"]["_id"]): "assigned", str(w["b"]["_id"]): "mentioned",
                               str(w["c"]["_id"]): "reply"})
        self.assertEqual(data["items"], [])            # wm owns nothing
        own = await digest.build(self.db, await self.user("owner"))
        items = {i["slug"]: i for i in own["items"]}
        self.assertEqual(set(items), {w["doc"]["slug"], w["priv"]["slug"]})   # the owner sees both of theirs
        self.assertEqual(items[w["doc"]["slug"]]["open"], 4)
        self.assertGreater(own["new"], 0)

    async def test_the_email_goes_once_a_day_with_the_threads(self):
        w = await self.world()
        out = await digest.run_due(self.db, now(), force=True)
        self.assertEqual(out.get("sent"), 2, out)                  # wm (waiting) and owner (their item)
        mails = {m["to"][0]: m for m in self.sent}
        wm = mails[self.email["wm"]]
        self.assertIn("3 comment threads are waiting on you", wm["subject"])
        self.assertIn(f"#c-{w['a']['_id']}", wm["html"])
        self.assertIn("Assigned to you", wm["html"])
        self.assertIn("@WM can you load test it?", html.unescape(wm["html"]))
        self.assertNotIn("Secret plan", wm["html"])
        self.assertNotIn("@WM secret", wm["html"])
        self.assertIn("/api/v1/comments/digest/off?t=", wm["html"])
        self.assertIn("comments/digest/off", wm["headers"]["List-Unsubscribe"])
        own = mails[self.email["owner"]]
        self.assertIn("Launch plan", own["html"])
        # Again the same day: nothing.
        self.sent.clear()
        out = await digest.run_due(self.db, now(), force=True)
        self.assertEqual(out.get("sent"), None)
        self.assertEqual(self.sent, [])

    async def test_nothing_new_sends_nothing_and_before_eight_waits(self):
        await self.world()
        u = await self.user("wm")
        # Before 08:00 their time: not yet.
        early = datetime.now(timezone.utc).astimezone(ZoneInfo(self.tz)).replace(hour=6, minute=0)
        self.assertEqual(await digest.send_one(self.db, u, early.astimezone(timezone.utc)), "early")
        # Their last digest was after all of it: nothing new, nothing sent.
        await self.db["users"].update_one({"_id": u["_id"]}, {"$set": {"comment_digest_at": now() + timedelta(minutes=1)}})
        self.assertEqual(await digest.send_one(self.db, await self.user("wm"), now()), "nothing")

    async def test_off_switch_and_its_signed_link(self):
        await self.world()
        r = await self.http.get("/api/v1/comments/digest/settings", headers=self.session("wm"))
        self.assertEqual(r.json(), {"on": True})
        r = await self.http.put("/api/v1/comments/digest/settings", json={"on": False}, headers=self.session("wm"))
        self.assertEqual(r.json(), {"on": False})
        self.assertEqual(await digest.send_one(self.db, await self.user("wm"), now()), "off")
        await self.http.put("/api/v1/comments/digest/settings", json={"on": True}, headers=self.session("wm"))
        # The email's link asks first (a mail scanner's GET changes nothing), the button turns it off.
        path = digest.off_url(self.uid["wm"]).split(API, 1)[1]
        r = await self.http.get(path)
        self.assertEqual(r.status_code, 200)
        self.assertIn("Turn off the daily comments digest?", r.text)
        self.assertTrue(digest.is_on(await self.user("wm")))
        r = await self.http.post(path)
        self.assertIn("The comments digest is off", r.text)
        self.assertFalse(digest.is_on(await self.user("wm")))
        bad = re.sub(r"\.[0-9a-f]+$", ".0000", path)
        self.assertEqual((await self.http.post(bad)).status_code, 400)
        self.assertEqual((await self.http.get("/api/v1/comments/digest/settings")).status_code, 401)

    async def test_a_pass_runs_at_most_every_few_minutes(self):
        await self.world()
        first = await digest.run_due(self.db, now())
        self.assertTrue(first)                                  # it looked
        self.assertEqual(await digest.run_due(self.db, now() + timedelta(minutes=1)), {})   # too soon: skipped
