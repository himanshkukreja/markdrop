"""Email calm (owner, 2026-11-06): notification emails don't flood people.

services/notifications.py: per-kind settings (Instant / Hourly bundle / Daily digest / Off), the
app and push first ("seen" / "pushed"), the daily cap with one morning catch-up, the hourly bundle
and daily digest emails, sign-off requests staying prompt, the old ``mention_emails`` switch
migrated, and the signed "Email me less" link.

The access-policy world (tests/_access_env.py), never backend/.env. Email is never sent:
``mailer._post`` records each payload (tests/test_notifications.NotifyWorld); push and Slack are
never called (outbox rows are written by hand).
"""

from __future__ import annotations

import html
import re
from datetime import datetime, timedelta, timezone
from datetime import time as dtime
from zoneinfo import ZoneInfo

from tests._access_env import now  # noqa: F401  (pins settings first)

from bson import ObjectId

from app.services import notifications, push, slack_notify
from tests.test_notifications import N, NotifyWorld, person

API = "https://api.markdrop.in"


def _less_link(mail: dict) -> str:
    m = re.search(r'href="([^"]*/api/v1/me/emails/less\?t=[^"]+)"', mail["html"])
    assert m, "no Email me less link"
    return html.unescape(m.group(1)).split(API, 1)[1]


class Calm(NotifyWorld):
    async def mention(self, who: str, page: dict | None = None, by: str = "owner", text: str = "frontend") -> dict:
        p = page or await self.page()
        await self.save(p["slug"], by, f"{person(self.uid[who], who.upper())} {text}")
        return p

    async def signoff(self, who: str, label: str = "Go live", by: str = "owner") -> dict:
        p = await self.page()
        await self.save(p["slug"], by, f':::signoff{{#b-so0001 person="{self.uid[who]}" label="{label}"}}\n:::\n')
        return p

    async def at(self, when, **_):
        return await notifications.flush_emails(self.db, when)

    async def user(self, who: str) -> dict:
        return await self.db["users"].find_one({"_id": ObjectId(self.uid[who])})

    async def seen_bell(self, who: str, tz: str | None = None) -> None:
        r = await self.http.get("/api/v1/notifications/unread-count", params={"tz": tz} if tz else None,
                                headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)


# ── Settings and the old switch ───────────────────────────────────────────────


class Settings(Calm):
    async def test_defaults_and_the_old_switch_migrated(self):
        me = (await self.http.get("/api/v1/auth/me", headers=self.session("wm"))).json()
        self.assertEqual(me["email_notify"], {"mention": "hourly", "signoff_requested": "instant"})
        self.assertTrue(me["mention_emails"])
        # Someone who had turned "Email me when someone mentions me" off: both kinds off, rows born off.
        await self.db["users"].update_one({"_id": ObjectId(self.uid["wa"])}, {"$set": {"mention_emails": False}})
        me = (await self.http.get("/api/v1/auth/me", headers=self.session("wa"))).json()
        self.assertEqual((me["email_notify"], me["mention_emails"]),
                         ({"mention": "off", "signoff_requested": "off"}, False))
        await self.mention("wa")
        await self.signoff("wa")
        self.assertEqual({r["email"] for r in await self.notes("wa")}, {"off"})
        # Choosing a setting per kind; the old switch follows (on while any kind is on).
        r = await self.http.patch("/api/v1/me/preferences", json={"email_notify": {"signoff_requested": "daily"},
                                                                  "tz": "Asia/Kolkata"}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["email_notify"], {"mention": "off", "signoff_requested": "daily"})
        self.assertTrue(r.json()["mention_emails"])
        self.assertEqual((await self.user("wa"))["email_tz"], "Asia/Kolkata")
        r = await self.http.patch("/api/v1/me/preferences", json={"email_notify": {"mention": "weekly"}},
                                  headers=self.session("wa"))
        self.assertEqual(r.status_code, 422)
        # The old switch back on: each kind that's off gets its default.
        r = await self.http.patch("/api/v1/me/preferences", json={"mention_emails": True}, headers=self.session("wa"))
        self.assertEqual(r.json()["email_notify"], {"mention": "hourly", "signoff_requested": "daily"})
        # A bad timezone is ignored.
        r = await self.http.patch("/api/v1/me/preferences", json={"tz": "Mars/Base"}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 200)
        self.assertEqual((await self.user("wa"))["email_tz"], "Asia/Kolkata")

    async def test_turning_a_kind_off_drops_whats_waiting_and_a_change_applies_at_once(self):
        await self.mention("wm")
        self.assertEqual(await self.flush(2), {})  # hourly: not due yet
        r = await self.http.patch("/api/v1/me/preferences", json={"email_notify": {"mention": "instant"}},
                                  headers=self.session("wm"))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(await self.flush(2.5), {"sent": 1})
        await self.mention("wm")
        await self.http.patch("/api/v1/me/preferences", json={"email_notify": {"mention": "off"}},
                              headers=self.session("wm"))
        self.assertEqual((await self.notes("wm"))[-1]["email"], "off")


# ── App and push first ────────────────────────────────────────────────────────


class AppFirst(Calm):
    async def test_pushed_or_slacked_means_no_email(self):
        await self.modes("wm")
        a, b = await self.mention("wm"), await self.mention("wm")
        ra, rb = await self.notes("wm")
        await self.db[push.OUTBOX].insert_one({"user_id": self.uid["wm"], "kind": "mention", "ref": str(ra["_id"]),
                                               "group": f"doc:{a['_id']}", "state": "sent", "created_at": now()})
        await self.db[slack_notify.OUTBOX].insert_one({"user_id": self.uid["wm"], "kind": "mention",
                                                       "ref": str(rb["_id"]), "state": "sent", "created_at": now()})
        self.assertEqual(await self.flush(2), {"pushed": 1, "slack": 1})
        self.assertEqual(self.sent, [])
        self.assertEqual([r["email"] for r in await self.notes("wm")], ["pushed", "slack"])

    async def test_a_push_on_its_way_holds_the_email_then_failing_it_sends(self):
        await self.modes("wm")
        await self.mention("wm")
        row = (await self.notes("wm"))[0]
        await self.db[push.OUTBOX].insert_one({"user_id": self.uid["wm"], "kind": "mention", "ref": str(row["_id"]),
                                               "group": "doc:x", "state": "pending", "created_at": now()})
        self.assertEqual(await self.flush(2), {})
        self.assertEqual(await self.flush(3), {})
        await self.db[push.OUTBOX].update_one({"ref": str(row["_id"])}, {"$set": {"state": "failed"}})
        self.assertEqual(await self.flush(4), {"sent": 1})

    async def test_the_bell_shown_after_it_arrived_means_seen(self):
        await self.modes("wm")
        await self.mention("wm")
        await self.seen_bell("wm")  # the app polled the unread count: the badge showed it
        self.assertEqual(await self.flush(2), {"seen": 1})
        self.assertEqual(self.sent, [])

    async def test_someone_around_in_the_app_gets_the_window_first(self):
        await self.modes("wm")
        await self.seen_bell("wm")
        await self.db["users"].update_one({"_id": ObjectId(self.uid["wm"])},
                                          {"$set": {"app_seen_at": now() - timedelta(minutes=2)}})
        await self.mention("wm")
        self.assertEqual(await self.flush(2), {})    # they were here two minutes ago: the bell first
        self.assertEqual(await self.flush(20), {})
        self.assertEqual(await self.flush(31), {"sent": 1})  # 30 minutes and they didn't come back

    async def test_someone_away_with_no_device_gets_instant_email_after_the_gather(self):
        await self.modes("wm")
        await self.mention("wm")
        self.assertEqual(await self.flush(0.5), {})
        self.assertEqual(await self.flush(1.5), {"sent": 1})


# ── Hourly bundle and daily digest ────────────────────────────────────────────


class Bundles(Calm):
    async def test_hourly_bundle_lists_every_page_and_respects_access_and_withdrawn(self):
        pages = [await self.page(title=f"Page {i}") for i in range(5)]
        for i, p in enumerate(pages):
            await self.mention("wm", p, text=f"line {i}")
        await self.save(pages[0]["slug"], "wa", f"{person(self.uid['wm'], 'WM')} line 0\n\n"
                        f"{person(self.uid['wm'], 'WM')} again {{#b-aaa001}}")
        # Page 3: the mention was taken out without a save that withdraws it (another path): send-time check.
        await self.db["documents"].update_one({"_id": pages[3]["_id"]}, {"$set": {"content": "# Plan\n"}})
        # Page 4: closed to them since.
        await self.db["documents"].update_one({"_id": pages[4]["_id"]}, {"$set": {"access_level": "private"}})
        # The bundle waits for its oldest to be 30 minutes old (what's settled is settled at once).
        self.assertEqual(await self.flush(2), {"withdrawn": 1})
        self.assertEqual(await self.flush(29), {})
        self.assertEqual(await self.flush(31), {"sent": 1, "no_access": 1})
        self.assertEqual(len(self.sent), 1)
        mail = self.sent[0]
        self.assertEqual(mail["subject"], "You were mentioned in 3 pages")
        for i in range(3):
            self.assertIn(f"line {i}", mail["html"])
            self.assertIn(f"line {i}", mail["text"])
        self.assertIn("WA", mail["html"])
        self.assertNotIn(pages[3]["slug"], mail["html"])
        self.assertNotIn(pages[4]["slug"], mail["html"])
        self.assertIn("This past hour", mail["html"])
        self.assertIn("Email me less", mail["html"])
        self.assertIn("List-Unsubscribe", mail["headers"])
        # A mention five minutes later waits for the next hour; then it's one page: the page email.
        later = await self.page()
        await self.db[N].delete_many({"user_id": self.uid["wm"], "email": {"$ne": "sent"}})
        await self.mention("wm", later)
        await self.db[N].update_many({"user_id": self.uid["wm"], "email": "pending"},
                                     {"$set": {"created_at": now() + timedelta(minutes=35)}})
        self.assertEqual(await self.flush(70), {})
        self.assertEqual(await self.flush(92), {"sent": 1})
        self.assertEqual(self.sent[1]["subject"], "OWNER mentioned you in “Launch plan”")
        self.assertIn("at most one email an hour", self.sent[1]["html"])

    async def test_mentions_withdrawn_by_a_save_never_appear(self):
        a, b = await self.mention("wm"), await self.mention("wm")
        await self.save(b["slug"], "owner", "Oops, wrong person")
        self.assertEqual(await self.flush(31), {"sent": 1})
        self.assertNotIn(b["slug"], self.sent[0]["html"])

    async def test_daily_digest_at_eight_their_time(self):
        await self.modes("wm", mention="daily", signoff="daily")
        await self.seen_bell("wm", tz="Asia/Kolkata")
        await self.db["users"].update_one({"_id": ObjectId(self.uid["wm"])},
                                          {"$set": {"app_seen_at": now() - timedelta(hours=1)}})
        await self.mention("wm")
        await self.signoff("wm")
        zone = ZoneInfo("Asia/Kolkata")
        _, eight, _ = notifications._slots(now() + timedelta(minutes=2), zone)
        self.assertEqual(eight.astimezone(zone).hour, 8)
        self.assertEqual(await self.at(eight - timedelta(minutes=1)), {})
        self.assertEqual(await self.at(eight + timedelta(minutes=1)), {"sent": 1})
        mail = self.sent[0]
        self.assertEqual(mail["subject"], "Daily digest: you were mentioned in 1 page and asked for 1 sign-off")
        self.assertIn("Go live", mail["html"])
        self.assertEqual(await self.at(eight + timedelta(minutes=30)), {})


# ── The daily cap and the morning catch-up ────────────────────────────────────


class Cap(Calm):
    async def test_three_a_day_then_one_catch_up_next_morning(self):
        await self.modes("wm")
        for i in range(5):
            await self.mention("wm", text=f"line {i}")
        self.assertEqual(await self.flush(2), {"sent": 3, "capped": 2})
        self.assertEqual(len(self.sent), 3)
        waiting = await self.notes("wm", email="pending")
        self.assertEqual([r.get("catchup") for r in waiting], [True, True])
        self.assertEqual(await self.flush(30), {})
        self.assertEqual(await self.flush(300), {})
        # The catch-up: 08:00 (UTC here: no timezone known) the next day, when the cap is new.
        tomorrow = (now() + timedelta(minutes=2)).astimezone(timezone.utc).date() + timedelta(days=1)
        eight = datetime.combine(tomorrow, dtime(8), tzinfo=timezone.utc)
        self.assertEqual(await self.at(eight - timedelta(minutes=1)), {})
        self.assertEqual(await self.at(eight + timedelta(minutes=1)), {"sent": 1})
        mail = self.sent[3]
        self.assertEqual(mail["subject"], "Catching up: you were mentioned in 2 pages")
        self.assertIn("waited for this morning", mail["html"])
        self.assertIn("line 3", mail["html"])
        self.assertIn("line 4", mail["html"])
        self.assertEqual(await self.notes("wm", email="pending"), [])
        self.assertEqual(await self.at(eight + timedelta(hours=2)), {})

    async def test_a_sign_off_request_may_be_the_fourth_once(self):
        day = (now() + timedelta(minutes=2)).astimezone(timezone.utc).date().isoformat()
        await self.db[notifications.DAYS].insert_one({"_id": f"{self.uid['wm']}:{day}", "n": 3, "at": now()})
        await self.signoff("wm")
        self.assertEqual(await self.flush(2), {"sent": 1})  # the only way it reaches them
        self.assertEqual(self.sent[0]["subject"], "OWNER asked you to sign off on “Go live”")
        await self.signoff("wm", label="Ship it")
        self.assertEqual(await self.flush(3), {"capped": 1})


# ── Sign-off requests stay prompt ─────────────────────────────────────────────


class Signoff(Calm):
    async def test_sign_off_requests_email_soon_while_mentions_bundle(self):
        p = await self.page()
        await self.save(p["slug"], "owner", f"{person(self.uid['wm'], 'WM')} see below\n\n"
                        f':::signoff{{#b-so0001 person="{self.uid["wm"]}" label="Go live"}}\n:::\n')
        self.assertEqual(await self.flush(2), {"sent": 1})
        self.assertEqual(self.sent[0]["subject"], "OWNER asked you to sign off on “Go live”")
        self.assertEqual([r["email"] for r in await self.notes("wm")], ["pending", "sent"])
        self.assertEqual(await self.flush(31), {"sent": 1})  # the mention, in the hourly bundle
        self.assertEqual(self.sent[1]["subject"], "OWNER mentioned you in “Launch plan”")

    async def test_someone_around_gets_ten_minutes_for_a_sign_off(self):
        await self.db["users"].update_one({"_id": ObjectId(self.uid["wm"])},
                                          {"$set": {"app_seen_at": now() - timedelta(minutes=1)}})
        await self.signoff("wm")
        self.assertEqual(await self.flush(2), {})
        self.assertEqual(await self.flush(9), {})
        self.assertEqual(await self.flush(11), {"sent": 1})


# ── Email me less ─────────────────────────────────────────────────────────────


class Less(Calm):
    async def test_email_me_less_steps_down_once_per_email(self):
        await self.modes("wm", mention="instant", signoff="instant")
        await self.mention("wm")
        await self.flush(2)
        mail = self.sent[0]
        self.assertIn("Email me less", mail["html"])
        self.assertIn("Email me less: https://api.markdrop.in/api/v1/me/emails/less?t=", mail["text"])
        path = _less_link(mail)
        r = await self.http.get(path)  # asks first: a link scanner changes nothing
        self.assertEqual(r.status_code, 200)
        self.assertIn("Email me less?", r.text)
        self.assertIn("Instant → <strong", r.text)
        self.assertIn("Hourly bundle", r.text)
        self.assertNotIn("Sign-off requests", r.text)  # only what this email was about
        self.assertEqual((await self.user("wm"))["email_notify"]["mention"], "instant")
        r = await self.http.post(path)
        self.assertEqual(r.status_code, 200)
        self.assertIn("Done: fewer emails", r.text)
        self.assertEqual((await self.user("wm"))["email_notify"], {"mention": "hourly", "signoff_requested": "instant"})
        r = await self.http.post(path)  # the same link again lowers nothing more
        self.assertIn("Already done", r.text)
        self.assertEqual((await self.user("wm"))["email_notify"]["mention"], "hourly")
        # Hourly → Daily → Off, each from its own email's link.
        for frm, to in (("hourly", "daily"), ("daily", "off")):
            link = notifications.less_url(self.uid["wm"], {"mention": frm}).split(API, 1)[1]
            await self.http.post(link)
            self.assertEqual((await self.user("wm"))["email_notify"]["mention"], to)
        self.assertIsNone(notifications.less_url(self.uid["wm"], {"mention": "off"}))

    async def test_the_link_is_signed(self):
        token = notifications.less_token(self.uid["wm"], {"mention": "hourly", "signoff_requested": "instant"})
        self.assertEqual(notifications.verify_less_token(token),
                         (self.uid["wm"], {"mention": "hourly", "signoff_requested": "instant"}))
        uid, spec, sig = token.split(".")
        for bad in (f"{uid}.m0.{sig}", f"{self.uid['wa']}.{spec}.{sig}", f"{uid}.{spec}.{'0' * 32}", "x", "",
                    f"{uid}.m9.{notifications._less_sig(uid + '.m9')}"):
            self.assertIsNone(notifications.verify_less_token(bad), bad)
            r = await self.http.post(f"/api/v1/me/emails/less?t={bad}")
            self.assertEqual(r.status_code, 400)
        self.assertEqual(notifications.step_down("instant"), "hourly")
        self.assertEqual(notifications.step_down("off"), "off")
