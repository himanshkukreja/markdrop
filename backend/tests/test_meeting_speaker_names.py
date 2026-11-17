"""Name this speaker, and tidy attendees (owner, 2026-11-17): services/meeting_speakers.rename_speaker,
ask_to_name, speaker_stats; services/meetings.tidy_attendees / tidy_existing_attendees
(scripts/tidy_meeting_attendees.py); POST/GET /api/v1/meetings/{id}/speakers; MCP rename_meeting_speaker.

The world is tests/test_zoom_media.NamedFromWords (a transcribed Zoom call whose third voice stays
"Speaker 3"); Zoom, Deepgram, R2 and the model are fakes.

Run: cd backend && MARKDROP_TEST_MONGODB_URI=mongodb://127.0.0.1:27019 .venv/bin/python -m unittest tests.test_meeting_speaker_names -v
"""

from __future__ import annotations

import unittest
from datetime import timedelta

from app.services import meeting_speakers, meetings, notifications, zoom, zoom_media
from tests._zoom_fake import iso_days_ago
from tests import test_zoom_media as tzm
from tests.test_zoom_media import host_in, namer_script


class People:
    def __init__(self, names: list[str]):
        self.members = [{"id": f"u{i}", "name": n, "email": None} for i, n in enumerate(names)]


class TidyAttendees(unittest.TestCase):
    def names(self, rows, people=None):
        return [a["name"] for a in meetings.tidy_attendees(rows, people)]

    def test_speaker_labels_are_nobody(self):
        rows = [{"name": "Speaker 2"}, {"name": "Ada Lovelace"}, {"name": "Speaker 7"}]
        self.assertEqual(self.names(rows), ["Ada Lovelace"])

    def test_a_first_name_is_the_one_person_it_starts(self):
        rows = [{"name": "Mayuri", "email": "mayuri@rapids.test", "user_id": None},
                {"name": "Kartik Kaushal"}, {"name": "Mayuri Pillay", "user_id": "m1", "email": None}]
        got = meetings.tidy_attendees(rows)
        self.assertEqual([a["name"] for a in got], ["Mayuri Pillay", "Kartik Kaushal"])
        self.assertEqual((got[0]["email"], got[0]["user_id"]), ("mayuri@rapids.test", "m1"))

    def test_never_when_it_is_ambiguous(self):
        two = [{"name": "Jason"}, {"name": "Jason Chad"}, {"name": "Jason Lee"}]
        self.assertEqual(self.names(two), ["Jason", "Jason Chad", "Jason Lee"])
        # Another member it could be.
        one = [{"name": "Jason"}, {"name": "Jason Chad"}]
        self.assertEqual(self.names(one, People(["Jason Chad", "Jason Brody"])), ["Jason", "Jason Chad"])
        self.assertEqual(self.names(one, People(["Jason Chad"])), ["Jason Chad"])
        # Two different addresses are two people.
        diff = [{"name": "Mayuri", "email": "a@x.test"}, {"name": "Mayuri Pillay", "email": "b@x.test"}]
        self.assertEqual(self.names(diff), ["Mayuri", "Mayuri Pillay"])
        # Not a prefix of words: "Jas" is not "Jason Chad".
        self.assertEqual(self.names([{"name": "Jas"}, {"name": "Jason Chad"}]), ["Jas", "Jason Chad"])

    def test_relabel_an_edited_transcript_only_touches_the_leads(self):
        md = ("My own note about Speaker 2.\n\n**0:04 · Speaker 2** Hello. {#b-t0001}\n\n"
              "**0:09 · Speaker 21** Hi. {#b-t0002}\n\n**Speaker 2** No time. {#b-t0003}\n")
        out, n = meeting_speakers.relabel_transcript(md, "Speaker 2", "Mayuri Pillay")
        self.assertEqual(n, 2)
        self.assertIn("My own note about Speaker 2.", out)
        self.assertIn("**0:04 · Mayuri Pillay** Hello.", out)
        self.assertIn("**0:09 · Speaker 21** Hi.", out)
        self.assertIn("**Mayuri Pillay** No time.", out)


class SpeakerNames(tzm.NamedFromWords):
    # Its world, not its tests (they run in tests/test_zoom_media.py).
    for _n in [n for n in dir(tzm.NamedFromWords) if n.startswith("test")]:
        locals()[_n] = None
    del _n
    async def asyncSetUp(self):
        await super().asyncSetUp()
        # Speaker 3: Markdrop isn't sure (a guess, never applied).
        self.fake.script = namer_script(lambda p: [
            {"label": "Speaker 1", "name": host_in(p).split()[0], "confidence": "high", "evidence": "says Hi Phil"},
            {"label": "Speaker 2", "name": "Phil", "confidence": "high", "evidence": "addressed as Phil"},
            {"label": "Speaker 3", "name": "Grace Hopper", "confidence": "medium", "evidence": "maybe"}])

    async def live(self, uuid: str) -> dict:
        """A meeting that just happened, through the webhook (not a backfill)."""
        self.fz.add_meeting(uuid, "Phil / Ada", self.email["owner"], iso_days_ago(0, 6), transcript=False,
                            participants=["Phil Turner", "Ada Lovelace", "Phil", "Grace Hopper"])
        self.fz.add_media(uuid)
        await self.hook(self.fz.event("recording.completed", uuid))
        await self.db[zoom.MEETINGS].update_one({"uuid": uuid}, {"$set": {"due_at": zoom.now_utc() - timedelta(minutes=1)}})
        await zoom_media.run_all(self.db)
        row = await self.meeting_of(uuid)
        self.assertIsNotNone(row)
        return row

    async def speakers(self, mid: str, who: str = "owner"):
        return await self.http.get(f"/api/v1/meetings/{mid}/speakers", headers=self.session(who))

    async def rename(self, mid: str, body: dict, who: str = "owner"):
        return await self.http.post(f"/api/v1/meetings/{mid}/speakers", headers=self.session(who), json=body)

    async def test_attendees_have_no_labels_and_one_phil(self):
        row = await self.live("sn-1")
        names = [a["name"] for a in row["attendees"]]
        self.assertNotIn("Speaker 3", names)
        self.assertIn("Phil Turner", names)
        self.assertNotIn("Phil", names)                          # Zoom's "Phil" is Phil Turner
        self.assertEqual([s["speaker"] for s in row["segments"]][-1], "Speaker 3")
        self.assertEqual(row["speaker_guesses"], [{"label": "Speaker 3", "name": "Grace Hopper"}])

    async def test_name_a_speaker_everywhere(self):
        row = await self.live("sn-2")
        mid = str(row["_id"])
        fp_before = zoom_media.captions_fp(row)
        r = await self.http.get(f"/api/v1/meetings/{mid}", headers=self.session("owner"))
        self.assertEqual((r.json()["unnamed_speakers"], r.json()["speakers_dismissed"]), (1, False))
        r = await self.speakers(mid)
        self.assertEqual(r.status_code, 200, r.text)
        sp = {s["label"]: s for s in r.json()["speakers"]}
        self.assertTrue(sp["Speaker 3"]["generic"])
        self.assertEqual(sp["Speaker 3"]["guess"], "Grace Hopper")
        self.assertIn("Mallory", sp["Speaker 3"]["samples"][0]["text"])
        self.assertGreater(sp["Speaker 3"]["talk_s"], 0)
        self.assertEqual(r.json()["unnamed"], 1)
        # Not for someone who can't open it, nor someone who can't edit it.
        self.assertEqual((await self.speakers(mid, "wv")).status_code, 404)
        self.assertEqual((await self.rename(mid, {"from": "Speaker 3", "to": "X Y"}, "wv")).status_code, 404)
        # Bad requests.
        self.assertEqual((await self.rename(mid, {"from": "Speaker 9", "to": "Grace Hopper"})).status_code, 404)
        self.assertEqual((await self.rename(mid, {"from": "Speaker 3", "to": "Speaker 4"})).status_code, 400)
        self.assertEqual((await self.rename(mid, {"from": "Speaker 3"})).status_code, 422)
        r = await self.rename(mid, {"from": "Speaker 3", "to": "grace hopper"})
        self.assertEqual(r.status_code, 200, r.text)
        got = r.json()["renamed"]
        self.assertEqual((got["to"], got["lines"], got["transcript"], got["unnamed"]), ("Grace Hopper", 1, "rewritten", 0))
        self.assertEqual(r.json()["meeting"]["unnamed_speakers"], 0)
        after = await self.meeting_of("sn-2")
        self.assertEqual([s["speaker"] for s in after["segments"]][-1], "Grace Hopper")
        self.assertNotIn("Speaker 3", [a["name"] for a in after["attendees"]])
        self.assertIn("Grace Hopper", [a["name"] for a in after["attendees"]])
        self.assertEqual(after["speaker_renames"][-1]["by"], self.uid["owner"])
        self.assertEqual(after.get("speaker_guesses"), [])
        self.assertNotEqual(zoom_media.captions_fp(after), fp_before)    # captions are built again
        traw = await self.db["documents"].find_one({"_id": after["transcript_doc_id"]})
        self.assertIn("· Grace Hopper**", traw["content"])
        self.assertNotIn("Speaker 3", traw["content"])
        # Fixing a wrong name on a Transcript page someone edited: only its leads change.
        await self.db["documents"].update_one({"_id": traw["_id"]}, {"$set": {"content": "My note.\n\n" + traw["content"]}})
        r = await self.rename(mid, {"from": "Grace Hopper", "to": "Priya Raman"})
        self.assertEqual(r.json()["renamed"]["transcript"], "updated", r.text)
        traw = await self.db["documents"].find_one({"_id": after["transcript_doc_id"]})
        self.assertTrue(traw["content"].startswith("My note."))
        self.assertIn("· Priya Raman**", traw["content"])
        self.assertEqual([s["speaker"] for s in (await self.meeting_of("sn-2"))["segments"]][0], "Ada Lovelace")
        r = await self.speakers(mid)
        self.assertEqual([x["to"] for x in r.json()["renames"]], ["Priya Raman", "Grace Hopper"])
        self.assertTrue(r.json()["renames"][0]["by"])

    async def test_the_host_is_asked_once_and_never_for_a_backfill(self):
        row = await self.live("sn-3")
        rows = await self.db[notifications.COLL].find({"kind": "speakers_unnamed"}).to_list(10)
        self.assertEqual([(n["user_id"], n["doc_id"]) for n in rows], [(self.uid["owner"], str(row["doc_id"]))])
        self.assertFalse(await meeting_speakers.ask_to_name(self.db, row["_id"]))       # once
        listed = await notifications.listing(self.db, self.uid["owner"])
        items = [n for n in listed["items"] if n["kind"] == "speakers_unnamed"]
        self.assertTrue(items[0]["href"].endswith("?speakers=name"), items)
        self.assertEqual(items[0]["actor"]["name"], "Markdrop")
        self.assertIn("Name the speakers in", items[0]["text"])
        self.assertIn(": 1 speaker not named yet", items[0]["text"])
        # A backfill (Import past meetings) asks nobody.
        await self.transcribed("sn-4")
        self.assertEqual(await self.db[notifications.COLL].count_documents({"kind": "speakers_unnamed"}), 1)
        # Dismiss: per person.
        mid = str(row["_id"])
        r = await self.http.post(f"/api/v1/meetings/{mid}/speakers/dismiss", headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        r = await self.http.get(f"/api/v1/meetings/{mid}", headers=self.session("owner"))
        self.assertTrue(r.json()["speakers_dismissed"])
        r = await self.http.get(f"/api/v1/meetings/{mid}", headers=self.session("wm"))
        self.assertFalse(r.json()["speakers_dismissed"])

    async def test_mcp_lists_and_names(self):
        row = await self.live("sn-5")
        token = await self.mcp_token("owner")
        _c, res = await self.mcp_call(token, "rename_meeting_speaker", {"meeting": str(row["_id"])})
        self.assertFalse(res.get("isError"), res)
        self.assertEqual(res["structuredContent"]["unnamed"], 1)
        self.assertIn("Speaker 3", res["content"][0]["text"])
        _c, res = await self.mcp_call(token, "rename_meeting_speaker",
                                      {"meeting": str(row["_id"]), "from": "Speaker 3", "user_id": self.uid["wm"]})
        self.assertFalse(res.get("isError"), res)
        wm_name = res["structuredContent"]["to"]
        after = await self.meeting_of("sn-5")
        self.assertEqual(after["segments"][-1]["speaker"], wm_name)
        self.assertIn(self.uid["wm"], [a.get("user_id") for a in after["attendees"]])

    async def test_the_fixer_tidies_existing_meetings(self):
        row = await self.live("sn-6")
        dirty = [*row["attendees"], {"name": "Speaker 2", "user_id": None, "email": None},
                 {"name": "Speaker 7", "user_id": None, "email": None},
                 {"name": "Mayuri", "user_id": None, "email": "mayuri@rapids.test"},
                 {"name": "Mayuri Pillay", "user_id": None, "email": None}]
        await self.db["meetings"].update_one({"_id": row["_id"]}, {"$set": {"attendees": dirty}})
        seen = []
        out = await meetings.tidy_existing_attendees(self.db, workspace_id=self.W, on_row=lambda r, b, a: seen.append(a))
        self.assertEqual((out["changed"], out["dropped_labels"], out["merged"]), (1, 2, 1))
        self.assertEqual((await self.meeting_of("sn-6"))["attendees"], dirty)          # dry run
        await meetings.tidy_existing_attendees(self.db, workspace_id=self.W, apply=True)
        names = [a["name"] for a in (await self.meeting_of("sn-6"))["attendees"]]
        self.assertNotIn("Speaker 2", names)
        self.assertEqual(names.count("Mayuri Pillay") + names.count("Mayuri"), 1)
        self.assertIn("Mayuri Pillay", names)
        again = await meetings.tidy_existing_attendees(self.db, workspace_id=self.W, apply=True)
        self.assertEqual(again["changed"], 0)


if __name__ == "__main__":
    unittest.main()
