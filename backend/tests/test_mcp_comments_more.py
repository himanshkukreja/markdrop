"""More comment MCP tools: edit_comment, delete_comment, list_waiting_on_me (mcp/comment_tools.py),
reject_suggestion, withdraw_suggestion (mcp/comment_review_tools.py), thread_to_jira (mcp/jira_page_tools.py),
get_comment_notifications, set_comment_notifications (mcp/comment_notify_tools.py).

The access-policy world (tests/_access_env.py): the test MongoDB (or mongomock), the fake model, Jira through
tests._jira_fake.FakeJira — never backend/.env, never the network.

Run: cd backend && MARKDROP_TEST_MONGODB_URI=mongodb://127.0.0.1:27019 .venv/bin/python -m unittest tests.test_mcp_comments_more -v
"""

from __future__ import annotations

import unittest

from tests._access_env import now  # noqa: F401  (pins settings first)

from bson import ObjectId

from app.services import jira_pages
from app.services.comments import model
from tests.test_comments import CONTENT
from tests.test_comments_review import ReviewWorld
from tests.test_jira_pages import PagesWorld


class Calls:
    async def call(self, who, name, args, *, write=True) -> dict:
        status, res = await self.mcp_call(await self.mcp_token(who, write=write), name, args)
        self.assertEqual(status, 200, name)
        return res

    async def ok(self, who, name, args, *, write=True) -> tuple[dict, str]:
        res = await self.call(who, name, args, write=write)
        self.assertFalse(res["isError"], res["content"][0]["text"])
        return res["structuredContent"], res["content"][0]["text"]

    async def err(self, who, name, args, *, write=True) -> str:
        res = await self.call(who, name, args, write=write)
        self.assertTrue(res["isError"], res)
        return res["content"][0]["text"]

    async def read_only_refused(self, who, name, args):
        status, res = await self.mcp_call(await self.mcp_token(who, write=False), name, args)
        self.assertTrue(status == 403 or (res or {}).get("isError"), (name, status, res))


# ── edit_comment / delete_comment ─────────────────────────────────────────────


class EditDelete(Calls, ReviewWorld):
    async def test_edit_own_only(self):
        d = await self.item("W")
        t = await self.create(d, "wm", body="First take")
        mid = t["messages"][0]["id"]
        out, text = await self.ok("wm", "edit_comment", {"document": d["slug"], "thread_id": t["id"], "message_id": mid,
                                                         "body": "Second take", "mentions": [self.email["wv"]]})
        self.assertEqual(out["message"]["body"], "Second take")
        self.assertIsNotNone(out["message"]["edited_at"])
        self.assertEqual([p["name"] for p in out["message"]["mentions"]], ["WV"])
        self.assertTrue(out["thread_url"].endswith(f"#c-{t['id']}"))
        self.assertIn("Edited", text)
        row = await self.db[model.MESSAGES].find_one({"_id": ObjectId(mid)})
        self.assertEqual(row["body"], "Second take")
        # Someone else's: refused, even for the owner (REST PATCH is author-only).
        for who in ("wv", "owner"):
            msg = await self.err(who, "edit_comment", {"document": d["slug"], "thread_id": t["id"], "message_id": mid,
                                                       "body": "Hijack"})
            self.assertIn("your own", msg)
        self.assertEqual((await self.db[model.MESSAGES].find_one({"_id": ObjectId(mid)}))["body"], "Second take")
        # A stranger can't read the item: refused, nothing learned.
        await self.err("stranger", "edit_comment", {"document": d["slug"], "thread_id": t["id"], "message_id": mid,
                                                     "body": "x"})
        await self.read_only_refused("wm", "edit_comment", {"document": d["slug"], "thread_id": t["id"],
                                                            "message_id": mid, "body": "x"})
        self.assertEqual((await self.db[model.MESSAGES].find_one({"_id": ObjectId(mid)}))["body"], "Second take")

    async def test_delete_own_and_moderators(self):
        d = await self.item("W")
        t = await self.create(d, "wv", body="Question")
        r = await self.reply(d, t["id"], "wm", "Answer")
        first, answer = t["messages"][0]["id"], r["message"]["id"]
        # A member who isn't a moderator can't delete someone else's message.
        self.assertIn("your own", await self.err("wm", "delete_comment", {"document": d["slug"], "thread_id": t["id"],
                                                                           "message_id": first}))
        await self.err("stranger", "delete_comment", {"document": d["slug"], "thread_id": t["id"], "message_id": first})
        await self.read_only_refused("wv", "delete_comment", {"document": d["slug"], "thread_id": t["id"],
                                                              "message_id": first})
        self.assertIsNone((await self.db[model.MESSAGES].find_one({"_id": ObjectId(first)}))["deleted_at"])
        # Own message: deleted, the thread stays (the answer is left).
        out, text = await self.ok("wv", "delete_comment", {"document": d["slug"], "thread_id": t["id"], "message_id": first})
        self.assertEqual((out["deleted"], out["thread_deleted"]), (True, False))
        self.assertNotIn("whole thread", text)
        self.assertIsNotNone((await self.db[model.MESSAGES].find_one({"_id": ObjectId(first)}))["deleted_at"])
        # The item's owner deletes another person's last message: the whole thread goes.
        out, text = await self.ok("owner", "delete_comment", {"document": d["slug"], "thread_id": t["id"],
                                                              "message_id": answer})
        self.assertTrue(out["thread_deleted"])
        self.assertIn("whole thread", text)
        self.assertIsNotNone((await self.db[model.THREADS].find_one({"_id": ObjectId(t["id"])}))["deleted_at"])
        # A workspace admin may too.
        t2 = await self.create(d, "wm", body="Mine")
        out, _ = await self.ok("wa", "delete_comment", {"document": d["slug"], "thread_id": t2["id"],
                                                        "message_id": t2["messages"][0]["id"]})
        self.assertTrue(out["thread_deleted"])


# ── list_waiting_on_me ────────────────────────────────────────────────────────


class Waiting(Calls, ReviewWorld):
    async def test_assigned_and_mentioned_and_access_loss(self):
        d = await self.item("W")
        a = await self.create(d, "wm", body="Please take this", assignee=self.uid["wv"])
        m = await self.create(d, "wm", body="What do you think?", mentions=[self.uid["wv"]])
        await self.create(d, "wm", body="Not about wv")
        gone = await self.item("W")
        g = await self.create(gone, "wm", body="Soon unreadable", mentions=[self.uid["wv"]])
        out, text = await self.ok("wv", "list_waiting_on_me", {}, write=False)
        by = {it["thread_id"]: it for it in out["items"]}
        self.assertEqual(set(by), {a["id"], m["id"], g["id"]})
        self.assertEqual((by[a["id"]]["waiting_reason"], by[m["id"]]["waiting_reason"]), ("assigned", "mentioned"))
        self.assertTrue(by[a["id"]]["url"].endswith(f"/{d['slug']}#c-{a['id']}"))
        self.assertEqual(by[m["id"]]["excerpt"], "the new editor")
        self.assertEqual(by[m["id"]]["last"]["body"], "What do you think?")
        self.assertEqual(by[m["id"]]["last"]["author"]["name"], "WM")
        self.assertIn(by[a["id"]]["url"], text)
        # The second item turns private: wv (a workspace viewer without a grant) can't open it any more.
        await self.db["documents"].update_one({"_id": gone["_id"]}, {"$set": {"access_level": "private"},
                                                                     "$inc": {"access_epoch": 1}})
        out, text = await self.ok("wv", "list_waiting_on_me", {}, write=False)
        self.assertEqual({it["thread_id"] for it in out["items"]}, {a["id"], m["id"]})
        self.assertNotIn(gone["slug"], text)
        out, _ = await self.ok("wv", "list_waiting_on_me", {"view": "assigned"}, write=False)
        self.assertEqual([it["thread_id"] for it in out["items"]], [a["id"]])
        out, _ = await self.ok("wv", "list_waiting_on_me", {"view": "mentions", "limit": 5}, write=False)
        self.assertEqual([it["thread_id"] for it in out["items"]], [m["id"]])
        # Nothing waits on a stranger; bad arguments are refused.
        out, text = await self.ok("stranger", "list_waiting_on_me", {}, write=False)
        self.assertEqual(out["items"], [])
        self.assertIn("No open comment threads", text)
        await self.err("wv", "list_waiting_on_me", {"view": "everything"}, write=False)
        await self.err("wv", "list_waiting_on_me", {"limit": 51}, write=False)


# ── reject_suggestion / withdraw_suggestion ───────────────────────────────────


class Suggestions(Calls, ReviewWorld):
    async def state(self, tid) -> str:
        return (await self.db[model.THREADS].find_one({"_id": ObjectId(tid)}))["suggestion"]["state"]

    async def test_reject(self):
        d = await self.item("W")
        t = await self.thread(d, "wv", suggestion="a better editor")
        # A viewer who didn't suggest it can't reject it; a stranger learns nothing.
        await self.err("gv", "reject_suggestion", {"document": d["slug"], "thread": t["id"]})
        await self.err("stranger", "reject_suggestion", {"document": d["slug"], "thread": t["id"]})
        await self.read_only_refused("wm", "reject_suggestion", {"document": d["slug"], "thread": t["id"]})
        self.assertEqual(await self.state(t["id"]), "open")
        # An editor rejects it (by its link too); the page is unchanged and the thread stays open.
        out, text = await self.ok("wm", "reject_suggestion", {"document": d["slug"],
                                                              "thread": f"https://markdrop.in/{d['slug']}#c-{t['id']}"})
        self.assertFalse(out["withdrawn"])
        self.assertEqual(out["suggestion"]["state"], "rejected")
        self.assertIn("Rejected WV's", text)
        self.assertEqual(await self.state(t["id"]), "rejected")
        self.assertEqual((await self.db[model.THREADS].find_one({"_id": ObjectId(t["id"])}))["status"], "open")
        self.assertEqual(await self.content(d), CONTENT)
        # Nothing open any more.
        self.assertIn("no open suggestion", await self.err("wm", "reject_suggestion", {"document": d["slug"],
                                                                                         "thread": t["id"]}))
        # reject_suggestion on your own suggestion withdraws it.
        t2 = await self.thread(d, "gv", suggestion="our editor")
        out, text = await self.ok("gv", "reject_suggestion", {"document": d["slug"], "thread": t2["id"]})
        self.assertTrue(out["withdrawn"])
        self.assertIn("Withdrew", text)

    async def test_withdraw(self):
        d = await self.item("W")
        t = await self.thread(d, "wv", suggestion="a better editor")
        # Someone else's suggestion, even for an editor: refused, pointing at reject_suggestion.
        msg = await self.err("wm", "withdraw_suggestion", {"document": d["slug"], "thread": t["id"]})
        self.assertIn("reject_suggestion", msg)
        await self.err("stranger", "withdraw_suggestion", {"document": d["slug"], "thread": t["id"]})
        await self.read_only_refused("wv", "withdraw_suggestion", {"document": d["slug"], "thread": t["id"]})
        self.assertEqual(await self.state(t["id"]), "open")
        out, text = await self.ok("wv", "withdraw_suggestion", {"document": d["slug"], "thread": t["id"]})
        self.assertTrue(out["withdrawn"])
        self.assertIn("Withdrew your suggested edit", text)
        self.assertEqual(await self.state(t["id"]), "rejected")
        self.assertIn("no open suggestion", await self.err("wv", "withdraw_suggestion", {"document": d["slug"],
                                                                                          "thread": t["id"]}))
        self.assertIn("isn't a thread id", await self.err("wv", "withdraw_suggestion", {"document": d["slug"],
                                                                                         "thread": "nope"}))


# ── thread_to_jira ────────────────────────────────────────────────────────────

PAGE = "# Launch\n\nWe still need to migrate the billing webhooks before Friday.\n"
QUOTE = {"type": "text", "quote": {"exact": "the billing webhooks", "prefix": "migrate ", "suffix": " before"}}


class ThreadToJira(Calls, PagesWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await model.ensure_indexes(self.db)
        await self.connect("wm")
        await self.db["documents"].update_one({"slug": "launch"}, {"$set": {"content": PAGE}})
        r = await self.http.post("/api/v1/documents/launch/comments", json={"anchor": QUOTE, "body": "Should this be a ticket?"},
                                 headers=self.session("wm"))
        self.assertEqual(r.status_code, 201, r.text)
        self.tid = r.json()["id"]
        r = await self.http.post(f"/api/v1/documents/launch/comments/{self.tid}/replies",
                                 json={"body": "Yes, for the next sprint."}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 201, r.text)

    async def links(self) -> dict:
        r = await self.http.get("/api/v1/jira/pages/launch/threads", headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["threads"]

    async def test_draft_then_create_then_already_linked(self):
        before = set(self.fj.issues)
        out, text = await self.ok("wm", "thread_to_jira", {"document": "launch", "thread": self.tid})
        self.assertFalse(out["created"])
        self.assertEqual(out["draft"]["summary"], "Migrate billing webhooks to v2")
        self.assertEqual((out["draft"]["project"], out["draft"]["issue_type"]), ("PAY", "Task"))
        self.assertIn("Should this be a ticket?", out["draft"]["item"])
        self.assertIn("nothing was created", text)
        self.assertEqual(set(self.fj.issues), before)
        self.assertEqual(await self.db[jira_pages.THREADS].count_documents({}), 0)
        out, text = await self.ok("wm", "thread_to_jira", {"document": "launch", "thread": f"/launch#c-{self.tid}",
                                                           "draft": False, "summary": "Billing webhooks from the thread"})
        self.assertTrue(out["created"])
        key = out["key"]
        self.assertFalse(out["chip"])
        self.assertIn(key, text)
        self.assertEqual(self.fj.issues[key]["fields"]["summary"], "Billing webhooks from the thread")
        desc = str(self.fj.issues[key]["fields"]["description"])
        self.assertIn(f"/launch#c-{self.tid}", desc)
        self.assertIn("Yes, for the next sprint.", desc)
        row = (await self.links())[self.tid]
        self.assertEqual((row["key"], row["title"]), (key, "Billing webhooks from the thread"))
        self.assertEqual((await self.doc("launch"))["content"], PAGE)      # put_chip off: the page is untouched
        # A thread has one issue.
        for draft in (True, False):
            msg = await self.err("wm", "thread_to_jira", {"document": "launch", "thread": self.tid, "draft": draft,
                                                          "summary": "again"})
            self.assertIn("already has a Jira issue", msg)
        self.assertEqual(len(set(self.fj.issues) - before), 1)

    async def test_put_chip_after_the_quote(self):
        out, text = await self.ok("wm", "thread_to_jira", {"document": "launch", "thread": self.tid, "draft": False,
                                                           "summary": "Migrate billing webhooks", "put_chip": True})
        key = out["key"]
        self.assertTrue(out["chip"], text)
        doc = await self.doc("launch")
        self.assertIn(f"migrate the billing webhooks :jira[{key}] before Friday.", doc["content"])
        # The quote is still there, so the comment stays where it was.
        t = await self.db[model.THREADS].find_one({"_id": ObjectId(self.tid)})
        self.assertEqual(t["anchor_status"], "attached")
        self.assertEqual(t["anchor"]["quote"]["exact"], "the billing webhooks")
        self.assertEqual(t["anchor"].get("rev"), doc["rev"])               # re-anchored on that save, and held
        r = await self.http.get(f"/api/v1/documents/launch/comments/{self.tid}", headers=self.session("wm"))
        self.assertEqual(r.json()["anchor_status"], "attached")

    async def test_put_chip_without_edit_access_still_creates(self):
        # wv can comment on the page but not edit it: the issue is made, the page isn't touched.
        self.fj.add_account("acc-wv", "WV", self.email["wv"])            # this time wv's Jira can see PAY
        await self.connect("wv")
        await self.db["documents"].update_one({"slug": "launch"}, {"$set": {"access_level": "workspace"},
                                                                   "$inc": {"access_epoch": 1}})
        r = await self.http.post("/api/v1/documents/launch/comments", json={"anchor": QUOTE, "body": "Ticket?"},
                                 headers=self.session("wv"))
        self.assertEqual(r.status_code, 201, r.text)
        tid = r.json()["id"]
        out, text = await self.ok("wv", "thread_to_jira", {"document": "launch", "thread": tid, "draft": False,
                                                           "summary": "From a viewer", "put_chip": True})
        self.assertTrue(out["created"])
        self.assertFalse(out["chip"])
        self.assertIn("can't edit the page", text)
        self.assertEqual((await self.doc("launch"))["content"], PAGE)

    async def test_refused(self):
        await self.db["documents"].update_one({"slug": "launch"}, {"$set": {"access_level": "workspace"},
                                                                   "$inc": {"access_epoch": 1}})
        await self.err("stranger", "thread_to_jira", {"document": "launch", "thread": self.tid})
        await self.read_only_refused("wm", "thread_to_jira", {"document": "launch", "thread": self.tid, "draft": False})
        self.assertIn("isn't a thread id", await self.err("wm", "thread_to_jira", {"document": "launch", "thread": "x"}))
        await self.err("wm", "thread_to_jira", {"document": "launch", "thread": str(ObjectId())})
        self.assertEqual(await self.db[jira_pages.THREADS].count_documents({}), 0)


# ── get / set_comment_notifications ───────────────────────────────────────────


class Notifications(Calls, ReviewWorld):
    async def test_round_trip(self):
        out, text = await self.ok("wm", "get_comment_notifications", {}, write=False)
        self.assertEqual(out, {"email": {"comment_mention": "instant", "comment_activity": "instant"}, "digest": True,
                               "push": {"comment_mention": True, "comment_assigned": True},
                               "slack": {"on": False, "comment_mention": True, "comment_assigned": True}})
        self.assertIn("Comment mentions and assignments: Instant", text)
        self.assertIn("Daily comments digest: On", text)
        self.assertIn("Slack direct messages: Off", text)
        out, text = await self.ok("wm", "set_comment_notifications", {
            "email_mentions": "daily", "email_activity": "off", "digest": False, "push_assigned": False,
            "slack_mentions": False})
        want = {"email": {"comment_mention": "daily", "comment_activity": "off"}, "digest": False,
                "push": {"comment_mention": True, "comment_assigned": False},
                "slack": {"on": False, "comment_mention": False, "comment_assigned": True}}
        self.assertEqual(out, want)
        self.assertIn("Comment mentions and assignments: Daily digest", text)
        self.assertIn("Replies and new comments: Off", text)
        got, _ = await self.ok("wm", "get_comment_notifications", {}, write=False)
        self.assertEqual(got, want)
        row = await self.db["users"].find_one({"_id": ObjectId(self.uid["wm"])})
        self.assertEqual(row["comment_digest"], "off")
        self.assertEqual(row["email_notify"]["comment_mention"], "daily")
        # The rest of the email settings are untouched; other people's too.
        self.assertEqual(row["email_notify"]["mention"], "hourly")
        other, _ = await self.ok("wv", "get_comment_notifications", {}, write=False)
        self.assertTrue(other["digest"])
        # Turn the digest back on, alone.
        out, _ = await self.ok("wm", "set_comment_notifications", {"digest": True})
        self.assertTrue(out["digest"])
        self.assertEqual(out["email"]["comment_mention"], "daily")

    async def test_refusals(self):
        self.assertIn("must be one of", await self.err("wm", "set_comment_notifications", {"email_mentions": "weekly"}))
        self.assertIn("Nothing to change", await self.err("wm", "set_comment_notifications", {}))
        await self.read_only_refused("wm", "set_comment_notifications", {"digest": False})
        row = await self.db["users"].find_one({"_id": ObjectId(self.uid["wm"])})
        self.assertNotEqual(row.get("comment_digest"), "off")
        self.assertNotIn("email_notify", row)


if __name__ == "__main__":
    unittest.main()
