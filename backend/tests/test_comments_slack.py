"""Comments in Slack (Track C, services/comments/slack.py): a DM on a comment mention or assignment with Reply
(a modal) and Resolve, as the clicker's linked account; DMs follow a thread resolved elsewhere.

Slack is :class:`tests.test_slack.FakeSlack` (never the network); Track A's ``service.reply`` / ``service.resolve``
are mocked (their own rules are A's tests), so these check the payloads, the buttons, who acts and what the
message says after.
"""

from __future__ import annotations

import json
import time
from unittest import mock
from urllib.parse import urlencode

from tests._comments_reach import ReachWorld, now, timedelta
from tests.test_slack import HOOK, TEAM, SlackWorld

from fastapi import HTTPException

from app.services import access, slack, slack_notify
from app.services.comments import events, service


def buttons(msg: dict) -> dict[str, dict]:
    return {e["action_id"]: e for b in msg["blocks"] if b["type"] == "actions" for e in b["elements"]}


class CommentDMs(ReachWorld, SlackWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.install()
        await self.link("wm", "U0WM")
        await self.link("wv", "U0WV")
        await self.opt_in("wm", "wv")
        self.doc = await self.item(title="Launch plan")

    async def dm_for(self, who: str, kind: str = "comment_mention", **kw) -> tuple[dict, dict]:
        th = await self.thread(self.doc, "owner", mentions=(who,) if kind == "comment_mention" else (),
                               assignee=who if kind == "comment_assigned" else None, **kw)
        row = await self.bell(who, kind, self.doc, th, excerpt="Can you confirm Friday?")
        await slack_notify.queue_notification(self.db, row)
        return th, row

    async def later(self, seconds: int = 90) -> int:
        return await slack_notify.flush(self.db, now=now() + timedelta(seconds=seconds))

    async def interact(self, payload: dict):
        body = urlencode({"payload": json.dumps(payload)}).encode()
        r = await self.post_signed("/api/v1/slack/interactivity", body, ctype="application/x-www-form-urlencoded")
        self.assertEqual(r.status_code, 200)
        await slack.drain()
        return r

    def action(self, action_id: str, value: str, slack_user: str = "U0WM") -> dict:
        return {"type": "block_actions", "team": {"id": TEAM}, "user": {"id": slack_user}, "trigger_id": "trig-1",
                "actions": [{"action_id": action_id, "value": value, "action_ts": str(time.time_ns())}],
                "response_url": HOOK, "container": {"channel_id": "D0WM", "message_ts": "9.0001"}}

    # ── The DM ──

    async def test_mention_dm_has_reply_resolve_and_the_thread_link(self):
        th, _ = await self.dm_for("wm")
        self.assertEqual(await slack_notify.flush(self.db), 0)       # a comment mention waits a minute
        self.assertEqual(await self.later(), 1)
        dm = self.sk.of("chat.postMessage")[-1]
        self.assertEqual(dm["channel"], "U0WM")
        text = json.dumps(dm)
        self.assertIn("mentioned you in a comment on", text)
        self.assertIn("Can you confirm Friday?", text)
        self.assertIn("frontend", text)                               # what the thread is about
        self.assertIn(f"/{self.doc['slug']}#c-{th['_id']}", text)
        b = buttons(dm)
        self.assertEqual(set(b), {"md_cm_reply", "md_cm_resolve", "md_open"})
        self.assertEqual(slack.read_value(TEAM, b["md_cm_reply"]["value"]), ["cm", str(self.doc["_id"]), str(th["_id"]), "r"])
        self.assertIsNone(slack.read_value("T0OTHER", b["md_cm_reply"]["value"]))   # bound to this team

    async def test_a_viewer_gets_reply_but_no_resolve_unless_assigned(self):
        await self.dm_for("wv")
        await self.later()
        dm = self.sk.of("chat.postMessage")[-1]
        self.assertEqual(set(buttons(dm)), {"md_cm_reply", "md_open"})     # someone else's thread
        await self.dm_for("wv", "comment_assigned")
        await self.later()
        dm = self.sk.of("chat.postMessage")[-1]
        self.assertIn("assigned you a comment on", json.dumps(dm))
        self.assertEqual(set(buttons(dm)), {"md_cm_reply", "md_cm_resolve", "md_open"})   # the assignee may resolve

    async def test_prefs_off_edited_out_or_no_access_send_nothing(self):
        r = await self.http.patch("/api/v1/slack/me/prefs", json={"comment_mention": False}, headers=self.session("wm"))
        self.assertFalse(r.json()["prefs"]["comment_mention"])
        await self.dm_for("wm")
        self.assertEqual(await self.db[slack_notify.OUTBOX].count_documents({}), 0)
        await self.http.patch("/api/v1/slack/me/prefs", json={"comment_mention": True}, headers=self.session("wm"))
        th, _ = await self.dm_for("wm")
        await self.db["comment_threads"].update_one({"_id": th["_id"]}, {"$set": {"mentions": []}})
        self.assertEqual(await self.later(), 0)
        th2, _ = await self.dm_for("wm")
        await self.db["documents"].update_one({"_id": self.doc["_id"]}, {"$set": {"comments_off": True}})
        self.assertEqual(await self.later(), 0)
        self.assertEqual(self.sk.of("chat.postMessage"), [])

    async def test_slack_settings_list_the_comment_kinds(self):
        r = await self.http.get("/api/v1/slack/me", headers=self.session("wm"))
        keys = [k["key"] for k in r.json()["kinds"]]
        self.assertIn("comment_mention", keys)
        self.assertIn("comment_assigned", keys)

    # ── Resolve ──

    async def test_resolve_click_resolves_as_the_linked_account_and_updates_the_dm(self):
        th, _ = await self.dm_for("wm")
        await self.later()
        value = buttons(self.sk.of("chat.postMessage")[-1])["md_cm_resolve"]["value"]
        calls = []

        async def fake_resolve(db, actor, raw, ctx, thread_id, **kw):
            calls.append((actor.user_id, actor.cred, raw["slug"], thread_id, ctx.surface))
            return {}

        with mock.patch.object(service, "resolve", fake_resolve):
            await self.interact(self.action("md_cm_resolve", value))
        self.assertEqual(calls, [(self.uid["wm"], "session", self.doc["slug"], str(th["_id"]), "slack")])
        upd = self.sk.of("chat.update")[-1]
        self.assertEqual((upd["channel"], upd["ts"]), ("D0WM", "9.0001"))
        self.assertIn("Resolved by you.", json.dumps(upd))

    async def test_resolve_refused_tells_them_why(self):
        _, _ = await self.dm_for("wm")
        await self.later()
        value = buttons(self.sk.of("chat.postMessage")[-1])["md_cm_resolve"]["value"]

        async def refuse(*a, **k):
            from app.services.pages import PageError

            raise PageError(403, {"detail": "Only the person who started this thread or an editor can resolve it.",
                                  "code": "forbidden"})

        with mock.patch.object(service, "resolve", refuse):
            await self.interact(self.action("md_cm_resolve", value))
        self.assertIn("Only the person who started this thread", json.dumps(self.sk.responds[-1]))
        self.assertEqual(self.sk.of("chat.update"), [])

    async def test_forged_value_and_unlinked_clicker(self):
        _, _ = await self.dm_for("wm")
        await self.later()
        value = buttons(self.sk.of("chat.postMessage")[-1])["md_cm_resolve"]["value"]
        forged = value.rsplit("|", 1)[0] + "|AAAAAAAAAAAAAAAA"
        with mock.patch.object(service, "resolve", mock.AsyncMock()) as res:
            await self.interact(self.action("md_cm_resolve", forged))
            self.assertIn("isn't valid", json.dumps(self.sk.responds[-1]))
            await self.interact(self.action("md_cm_resolve", value, slack_user="U0NOBODY"))
            self.assertIn("Link my Markdrop account", json.dumps(self.sk.responds[-1]))
            res.assert_not_called()

    # ── Reply ──

    async def test_reply_opens_a_modal_and_the_submission_replies_as_them(self):
        th, _ = await self.dm_for("wm")
        await self.later()
        value = buttons(self.sk.of("chat.postMessage")[-1])["md_cm_reply"]["value"]
        await self.interact(self.action("md_cm_reply", value))
        opened = self.sk.of("views.open")[-1]
        self.assertEqual(opened["trigger_id"], "trig-1")
        view = json.loads(opened["view"]) if isinstance(opened["view"], str) else opened["view"]
        self.assertEqual(view["callback_id"], "md_cm_reply")
        self.assertIn("Is Friday real?", json.dumps(view))              # the thread's latest message
        meta = slack.read_value(TEAM, view["private_metadata"])
        self.assertEqual(meta, ["cmr", str(self.doc["_id"]), str(th["_id"]), "D0WM", "9.0001"])
        calls = []

        async def fake_reply(db, actor, raw, ctx, thread_id, *, body, **kw):
            calls.append((actor.user_id, thread_id, body))
            return {}, {}

        sub = {"type": "view_submission", "team": {"id": TEAM}, "user": {"id": "U0WM"},
               "view": {**view, "state": {"values": {"reply": {"body": {"type": "plain_text_input",
                                                                         "value": "  Yes, Friday holds.  "}}}}}}
        with mock.patch.object(service, "reply", fake_reply):
            await self.interact(sub)
        self.assertEqual(calls, [(self.uid["wm"], str(th["_id"]), "Yes, Friday holds.")])
        upd = self.sk.of("chat.update")[-1]
        self.assertEqual((upd["channel"], upd["ts"]), ("D0WM", "9.0001"))
        self.assertIn("You replied", json.dumps(upd))
        # A forged modal (metadata from another team) does nothing.
        bad = {**sub, "view": {**sub["view"], "private_metadata": view["private_metadata"].rsplit("|", 1)[0] + "|AAAAAAAAAAAAAAAA"}}
        with mock.patch.object(service, "reply", fake_reply):
            await self.interact(bad)
        self.assertEqual(len(calls), 1)

    async def test_a_refused_reply_is_explained_in_the_dm(self):
        th, _ = await self.dm_for("wm")
        await self.later()
        value = buttons(self.sk.of("chat.postMessage")[-1])["md_cm_reply"]["value"]
        await self.interact(self.action("md_cm_reply", value))
        view = self.sk.of("views.open")[-1]["view"]
        view = json.loads(view) if isinstance(view, str) else view

        async def refuse(*a, **k):
            raise HTTPException(status_code=429, detail="You're commenting too fast.")

        sub = {"type": "view_submission", "team": {"id": TEAM}, "user": {"id": "U0WM"},
               "view": {**view, "state": {"values": {"reply": {"body": {"value": "hi"}}}}}}
        with mock.patch.object(service, "reply", refuse):
            await self.interact(sub)
        self.assertIn("Your reply wasn't posted: You're commenting too fast.", json.dumps(self.sk.of("chat.postMessage")[-1]))

    # ── Resolved elsewhere ──

    async def test_resolved_in_the_app_updates_the_sent_dm(self):
        th, _ = await self.dm_for("wm")
        await self.later()
        await self.db["comment_threads"].update_one({"_id": th["_id"]}, {"$set": {"status": "resolved"}})
        th = await self.db["comment_threads"].find_one({"_id": th["_id"]})
        from app.models.user import User

        owner = User(id=self.uid["owner"], email=self.email["owner"], name="Olive Owner", created_at=now(), updated_at=now())
        await events.emit(self.db, "resolved", doc=self.doc, thread=th, actor=access.Actor.of(owner))
        await slack.drain()
        upd = self.sk.of("chat.update")[-1]
        self.assertEqual(upd["channel"], "U0WM")
        self.assertIn("Resolved by Olive Owner.", json.dumps(upd))
        self.assertNotIn("md_cm_resolve", json.dumps(upd))
