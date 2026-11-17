"""Zoom: attendees' addresses (2026-11-17) and work a restart left half done.

* Zoom's past-meeting participants carry ``user_email``: it is kept on the meeting's attendee (as a
  Google Meet import keeps it), a member is matched by it, HubSpot finds contacts by it, and it is never
  shown where it wasn't before (the meetings API, the page). A one-off backfill fills it for meetings
  imported before (services/zoom.backfill_attendee_emails, scripts/zoom_backfill_attendee_emails.py).
* An import left ``processing`` (a deploy) goes back to waiting (tries + 1) and is imported by the zoom
  loop; past the cap it fails with a reason. A copy left ``copying`` is taken again, failed past its cap.

Run: cd backend && MARKDROP_TEST_MONGODB_URI=mongodb://127.0.0.1:27019 .venv/bin/python -m unittest tests.test_zoom_attendees -v
"""

from __future__ import annotations

import asyncio
import json
from datetime import timedelta

from bson import ObjectId

from app.services import meetings, zoom, zoom_media
from tests._zoom_fake import iso_days_ago
from tests.test_hubspot import HubSpotWorld
from tests.test_zoom import ZoomWorld
from tests.test_zoom_media import MediaWorld

EXT = "grace@acme.test"


async def settle() -> None:
    await zoom.drain()
    for t in list(meetings._bg):
        await asyncio.wait({t}, timeout=10)


class Emails(ZoomWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.assertEqual((await self.connect()).status_code, 200)

    def participants(self, uuid: str) -> None:
        self.fz.participants[uuid] = [
            {"name": "Ada Lovelace", "user_email": self.email["owner"]},
            {"name": "Grace Hopper", "user_email": "Grace@Acme.test"},
            {"name": "Grace Hopper", "user_email": "Grace@Acme.test"},          # rejoined: once
            {"name": "Bo T.", "user_email": self.email["wm"]},                   # a member under another name
            {"name": "Priya Raman", "user_email": ""},                           # Zoom left it out
            {"name": "Mallory", "user_email": "not an address"},
        ]

    async def test_addresses_are_kept_matched_and_never_shown(self):
        self.fz.add_meeting("em-1", "Acme discovery call", self.email["owner"], iso_days_ago(0, 6))
        self.participants("em-1")
        await self.hook(self.fz.event("recording.transcript_completed", "em-1"))
        await settle()
        row = await self.db["meetings"].find_one({"sources.file_id": "zoom:em-1"})
        by = {a["name"]: a for a in row["attendees"]}
        self.assertEqual(by["Grace Hopper"]["email"], EXT)
        self.assertIsNone(by["Grace Hopper"]["user_id"])
        self.assertIsNone(by["Priya Raman"]["email"])
        self.assertEqual(by["Mallory"]["email"], None)
        self.assertEqual(sum(1 for a in row["attendees"] if a["name"] == "Grace Hopper"), 1)
        self.assertEqual(by["Ada Lovelace"]["user_id"], self.uid["owner"])
        self.assertIn(self.uid["wm"], [a.get("user_id") for a in row["attendees"]])     # matched by the address
        # Never shown: the meetings API, the list, the page and its sub-pages.
        for path, params in ((f"/api/v1/meetings/{row['_id']}", None), ("/api/v1/meetings", {"workspace": self.W})):
            r = await self.http.get(path, headers=self.session("wm"), params=params)
            self.assertEqual(r.status_code, 200, r.text)
            self.assertNotIn(EXT, r.text.lower())
        async for d in self.db["documents"].find({"workspace_id": self.W}):
            self.assertNotIn(EXT, json.dumps(d, default=str).lower())
        self.assertNotIn(EXT, json.dumps(row.get("segments"), default=str).lower())

    async def test_backfill_fills_addresses_only(self):
        self.fz.add_meeting("em-2", "Renewal", self.email["owner"], iso_days_ago(1))
        await self.hook(self.fz.event("recording.transcript_completed", "em-2"))
        await settle()
        before = await self.db["meetings"].find_one({"sources.file_id": "zoom:em-2"})
        self.assertFalse(any(a.get("email") for a in before["attendees"] if not a.get("user_id")))
        self.fz.participants["em-2"] = [{"name": "Grace Hopper", "user_email": EXT},
                                        {"name": "Someone New", "user_email": "new@acme.test"}]
        seen: list[int] = []
        out = await zoom.backfill_attendee_emails(self.db, self.W, on_row=lambda r, s: seen.append(len(s)))
        self.assertEqual((out["meetings"], out["changed"], out["emails"]), (1, 1, 1))
        self.assertEqual(seen, [1])
        self.assertEqual(await self.db["meetings"].find_one({"_id": before["_id"]}), before)      # dry run
        out = await zoom.backfill_attendee_emails(self.db, self.W, apply=True)
        self.assertEqual(out["emails"], 1)
        after = await self.db["meetings"].find_one({"_id": before["_id"]})
        self.assertEqual([a["name"] for a in after["attendees"]], [a["name"] for a in before["attendees"]])
        self.assertEqual({a["name"]: a.get("email") for a in after["attendees"]}["Grace Hopper"], EXT)
        self.assertEqual({k: v for k, v in after.items() if k != "attendees"},
                         {k: v for k, v in before.items() if k != "attendees"})
        out = await zoom.backfill_attendee_emails(self.db, self.W, apply=True)
        self.assertEqual(out["emails"], 0)      # once
        with self.assertRaises(ValueError):
            await zoom.backfill_attendee_emails(self.db, self.ws["W2"])


class HubSpotByZoomEmail(HubSpotWorld):
    async def test_contacts_found_by_the_address_zoom_gave(self):
        self.assertEqual((await self.hs_connect()).status_code, 200)
        c = self.fh.add("contacts", email=EXT, firstname="Grace", lastname="Hopper")
        d = self.fh.add("deals", dealname="Acme expansion", dealstage="appointmentscheduled")
        self.fh.link("contacts", c, "deals", d)
        self.fz.add_meeting("hs-em", "Acme call", self.email["owner"], "2026-11-03T06:00:00Z",
                            participants=[{"name": "Ada Lovelace", "user_email": self.email["owner"]},
                                          {"name": "Grace Hopper", "user_email": EXT}])
        await self.hook(self.fz.event("recording.transcript_completed", "hs-em"))
        await settle()
        row = await self.db["meetings"].find_one({"zoom.uuid": "hs-em"})
        p = await self.panel(str(row["_id"]))
        self.assertEqual((p["match"]["how"], p["match"]["confidence"], p["deal"]["name"]),
                         ("contacts", "medium", "Acme expansion"))


class Reclaim(ZoomWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.assertEqual((await self.connect()).status_code, 200)

    async def stuck(self, uuid: str, *, ago: timedelta, tries: int | None = None) -> str:
        self.fz.add_meeting(uuid, f"Call {uuid}", self.email["owner"], iso_days_ago(1))
        key = f"{self.W}:{uuid}"
        row = {"_id": key, "workspace_id": self.W, "uuid": uuid, "topic": f"Call {uuid}", "state": "processing",
               "via": "backfill", "source": "transcript", "at": zoom.now_utc() - ago, "created_at": zoom.now_utc() - ago}
        if tries is not None:
            row["tries"] = tries
        await self.db[zoom.MEETINGS].insert_one(row)
        return key

    async def test_left_processing_is_imported_again(self):
        key = await self.stuck("rc-stuck", ago=timedelta(hours=3))
        fresh = await self.stuck("rc-fresh", ago=timedelta(minutes=2))
        await zoom_media.run_all(self.db)
        await settle()
        row = await self.db[zoom.MEETINGS].find_one({"_id": key})
        self.assertEqual((row["state"], row["tries"]), ("imported", 1))
        self.assertEqual(await self.db["meetings"].count_documents({"sources.file_id": "zoom:rc-stuck"}), 1)
        self.assertEqual((await self.db[zoom.MEETINGS].find_one({"_id": fresh}))["state"], "processing")   # still running

    async def test_a_poison_row_ends_failed_with_a_reason(self):
        key = await self.stuck("rc-poison", ago=timedelta(hours=1), tries=zoom_media.MAX_TRIES - 1)
        self.assertEqual(await zoom.reclaim(self.db), 1)
        row = await self.db[zoom.MEETINGS].find_one({"_id": key})
        self.assertEqual((row["state"], row["tries"], row["reason"]), ("failed", zoom_media.MAX_TRIES, zoom.INTERRUPTED))
        self.assertEqual(await zoom.reclaim(self.db), 0)
        self.assertEqual(await self.db["meetings"].count_documents({"sources.file_id": "zoom:rc-poison"}), 0)
        # Import past meetings can still bring it in.
        r = await self.http.post("/api/v1/zoom/import", headers=self.session("wa"),
                                 json={"workspace_id": self.W, "uuids": ["rc-poison"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["results"][0]["status"], "imported")

    async def test_a_running_import_keeps_its_lease(self):
        key = await self.stuck("rc-live", ago=timedelta(hours=1))
        await zoom._touch(self.db, key)
        self.assertEqual(await zoom.reclaim(self.db), 0)


class ReclaimCopies(MediaWorld):
    async def test_a_copy_left_running_is_taken_again_then_fails_past_the_cap(self):
        self.assertEqual((await self.switch()).status_code, 200)
        self.fz.add_meeting("cp-1", "Kickoff", self.email["owner"], iso_days_ago(1))
        self.fz.add_media("cp-1", audio=None, video=b"KICKOFF" * 20)
        self.fz.add_meeting("cp-2", "Review", self.email["owner"], iso_days_ago(1))
        self.fz.add_media("cp-2", audio=None, video=b"REVIEW" * 20)
        await self.import_("cp-1", "cp-2")
        old = zoom.now_utc() - timedelta(hours=1)
        k1, k2 = f"{self.W}:cp-1", f"{self.W}:cp-2"
        await self.db[zoom.MEETINGS].update_one({"_id": k1}, {"$set": {"rec_state": "copying", "rec_at": old, "rec_tries": 1}})
        await self.db[zoom.MEETINGS].update_one({"_id": k2}, {"$set": {"rec_state": "copying", "rec_at": old,
                                                                        "rec_tries": zoom_media.MAX_TRIES}})
        await zoom_media.run_all(self.db)
        self.assertEqual((await self.db[zoom.MEETINGS].find_one({"_id": k1}))["rec_state"], "ready")
        self.assertTrue((await self.meeting_of("cp-1"))["recording"]["key"])
        r2 = await self.db[zoom.MEETINGS].find_one({"_id": k2})
        self.assertEqual((r2["rec_state"], r2["rec_reason"]), ("failed", zoom_media.INTERRUPTED_COPY))
        self.assertIsNone((await self.meeting_of("cp-2")).get("recording"))


if __name__ == "__main__":
    import unittest

    unittest.main()
