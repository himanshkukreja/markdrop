"""Comments (services/comments, routers/comments.py, mcp/comment_tools.py): the access matrix, threads and
messages, re-anchoring on save, the bell, live fan-out (signed-in viewers only), Home / Team, MCP, rate
limits and account anonymising.

The access-policy world (tests/_access_env.py): the test MongoDB (or mongomock), never backend/.env.
"""

from __future__ import annotations

import asyncio
from unittest import mock

from tests._access_env import PASSWORD, now  # noqa: F401  (pins settings first)

from bson import ObjectId

from app.routers import live as live_router
from app.services import live, tickets, viewers
from app.services.comments import events, model, service
from tests.test_page_history import HistoryWorld
from tests.test_viewers import FakeSocket, settle

CONTENT = ("# Launch plan {#b-h1aaaa}\n\nWe will ship the new editor on Monday. {#b-p1aaaa}\n\n"
           "- first item {#b-li1aaa}\n- second task here {#b-li2aaa}\n\nClosing words. {#b-endaaa}\n")


class CommentsWorld(HistoryWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await model.ensure_indexes(self.db)
        from app.services import notifications

        await notifications.ensure_indexes(self.db)

    async def item(self, state: str = "W", **extra) -> dict:
        extra.setdefault("content", CONTENT)
        return await self.page(state, **extra)

    def url(self, doc, tail=""):
        return f"/api/v1/documents/{doc['slug']}/comments{tail}"

    async def hdr(self, who: str | None) -> dict:
        return self.session(who) if who else {}

    async def create(self, doc, who="wm", *, anchor=None, body="Looks good?", mentions=None, assignee=None,
                     status=201, headers=None):
        anchor = anchor or {"type": "text", "block_id": "b-p1aaaa",
                            "quote": {"exact": "the new editor", "prefix": "ship ", "suffix": " on"}}
        payload = {"anchor": anchor, "body": body}
        if mentions is not None:
            payload["mentions"] = mentions
        if assignee is not None:
            payload["assignee"] = assignee
        r = await self.http.post(self.url(doc), json=payload, headers=headers if headers is not None else await self.hdr(who))
        self.assertEqual(r.status_code, status, r.text)
        return r.json()

    async def listing(self, doc, who="wm", code=200, headers=None, **params):
        r = await self.http.get(self.url(doc), params=params, headers=headers if headers is not None else await self.hdr(who))
        self.assertEqual(r.status_code, code, r.text)
        return r.json()

    async def reply(self, doc, tid, who="owner", body="Yes", mentions=None, status=201):
        r = await self.http.post(self.url(doc, f"/{tid}/replies"), json={"body": body, "mentions": mentions or []},
                                 headers=await self.hdr(who))
        self.assertEqual(r.status_code, status, r.text)
        return r.json()

    async def bell(self, who) -> list[dict]:
        r = await self.http.get("/api/v1/notifications", headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["items"]


# ── Access ────────────────────────────────────────────────────────────────────


class Access(CommentsWorld):
    async def test_link_item_signed_in_readers_comment_anonymous_see_nothing(self):
        d = await self.item("UL")
        # Anonymous: nothing (clean page), and can't write.
        r = await self.http.get(self.url(d))
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json()["code"], "signin")
        r = await self.http.post(self.url(d), json={"anchor": {"type": "page"}, "body": "hi"})
        self.assertEqual(r.status_code, 401)
        # The read says so, without counts.
        body = (await self.get(d["slug"])).json()
        self.assertEqual(body["comments"]["can_view"], False)
        self.assertIsNone(body["comments"]["open"])
        # A signed-in stranger who can read the link comments.
        t = await self.create(d, "stranger")
        self.assertEqual(t["status"], "open")
        self.assertEqual(t["created_by"]["name"], "STRANGER")
        self.assertNotIn("email", t["created_by"])
        lst = await self.listing(d, "stranger")
        self.assertEqual(len(lst["threads"]), 1)
        self.assertTrue(lst["can"]["comment"])
        self.assertFalse(lst["can"]["resolve_any"])
        # The stranger can resolve their own; another stranger-level reader can't resolve theirs.
        t2 = await self.create(d, "owner", body="Owner's note")
        r = await self.http.post(self.url(d, f"/{t2['id']}/resolve"), headers=self.session("stranger"))
        self.assertEqual(r.status_code, 403)
        r = await self.http.post(self.url(d, f"/{t['id']}/resolve"), headers=self.session("stranger"))
        self.assertEqual(r.status_code, 200, r.text)
        # The owner sees the count on the read.
        body = (await self.get(d["slug"], self.session("owner"))).json()
        self.assertEqual(body["comments"]["open"], 1)
        self.assertTrue(body["comments"]["settings"])

    async def test_workspace_item_roles(self):
        d = await self.item("W")
        # A stranger can't read it: comments answer as the read does.
        r = await self.http.get(self.url(d), headers=self.session("stranger"))
        self.assertEqual(r.status_code, 404)
        r = await self.http.post(self.url(d), json={"anchor": {"type": "page"}, "body": "x"},
                                 headers=self.session("stranger"))
        self.assertEqual(r.status_code, 404)
        # Viewer member / viewer grant: comment, not resolve others'.
        for who in ("wv", "gv"):
            lst = await self.listing(d, who)
            self.assertTrue(lst["can"]["comment"], who)
            self.assertFalse(lst["can"]["resolve_any"], who)
        # Editors: resolve any, accept, assign.
        for who in ("wm", "ge", "owner", "wa"):
            lst = await self.listing(d, who)
            self.assertTrue(lst["can"]["resolve_any"], who)
            self.assertTrue(lst["can"]["accept"], who)
        self.assertTrue((await self.listing(d, "wa"))["can"]["moderate"])
        self.assertFalse((await self.listing(d, "wm"))["can"]["moderate"])
        self.assertTrue((await self.listing(d, "owner"))["can"]["settings"])
        self.assertFalse((await self.listing(d, "wa"))["can"]["settings"])
        t = await self.create(d, "wv")
        r = await self.http.post(self.url(d, f"/{t['id']}/resolve"), headers=self.session("ge"))
        self.assertEqual(r.status_code, 200, r.text)

    async def test_private_item(self):
        d = await self.item("P")
        self.assertEqual((await self.http.get(self.url(d), headers=self.session("wm"))).status_code, 404)
        await self.create(d, "gv")
        self.assertEqual(len((await self.listing(d, "owner"))["threads"]), 1)

    async def test_ineligible_items(self):
        enc = await self.mkdoc("UL", encrypted=True, content="ENC")
        r = await self.http.get(self.url(enc), headers=self.session("owner"))
        self.assertEqual((r.status_code, r.json()["code"]), (404, "comments_unavailable"))
        self.assertIsNone((await self.get(enc["slug"], self.session("owner"))).json()["comments"])
        ownerless = await self.mkdoc("UL", owner=None, content="# x")
        r = await self.http.post(self.url(ownerless), json={"anchor": {"type": "page"}, "body": "hi"},
                                 headers=self.session("stranger"))
        self.assertEqual((r.status_code, r.json()["code"]), (404, "comments_unavailable"))
        art = await self.mkdoc("UL", kind="artifact")
        r = await self.http.get(self.url(art), headers=self.session("owner"))
        self.assertEqual(r.status_code, 404)
        # An unreadable ineligible item still answers as its read does (no existence oracle).
        enc_ws = await self.mkdoc("W", encrypted=True, content="ENC")
        r = await self.http.get(self.url(enc_ws), headers=self.session("stranger"))
        self.assertEqual(r.status_code, 404)
        self.assertNotEqual(r.json().get("code"), "comments_unavailable")

    async def test_switches(self):
        d = await self.item("UL")
        t = await self.create(d, "gv")
        # The owner turns comments off: nobody sees or writes; the owner can still turn them back on.
        r = await self.http.put(self.url(d, "/settings"), json={"enabled": False}, headers=self.session("gv"))
        self.assertEqual(r.status_code, 403)
        r = await self.http.put(self.url(d, "/settings"), json={"enabled": False}, headers=self.session("owner"))
        self.assertEqual(r.json(), {"enabled": False, "public": False, "workspace_enabled": True})
        r = await self.http.get(self.url(d), headers=self.session("gv"))
        self.assertEqual((r.status_code, r.json()["code"]), (403, "comments_off"))
        r = await self.http.post(self.url(d, f"/{t['id']}/replies"), json={"body": "x"}, headers=self.session("gv"))
        self.assertEqual(r.status_code, 403)
        self.assertFalse((await self.get(d["slug"], self.session("gv"))).json()["comments"]["enabled"])
        await self.http.put(self.url(d, "/settings"), json={"enabled": True}, headers=self.session("owner"))
        # Show publicly: anonymous readers see (read only).
        r = await self.http.put(self.url(d, "/settings"), json={"public": True}, headers=self.session("owner"))
        self.assertTrue(r.json()["public"])
        anon = await self.listing(d, None)
        self.assertEqual(len(anon["threads"]), 1)
        self.assertFalse(anon["can"]["comment"])
        self.assertEqual((await self.get(d["slug"])).json()["comments"]["open"], 1)
        r = await self.http.post(self.url(d), json={"anchor": {"type": "page"}, "body": "hi"})
        self.assertEqual(r.status_code, 401)

    async def test_workspace_switch(self):
        d = await self.item("W")
        await self.db["workspaces"].update_one({"_id": ObjectId(self.ws["W1"])},
                                               {"$set": {"settings.comments_enabled": False}})
        r = await self.http.get(self.url(d), headers=self.session("wm"))
        self.assertEqual((r.status_code, r.json()["code"]), (403, "comments_off"))
        self.assertEqual((await self.get(d["slug"], self.session("wm"))).json()["comments"]["reason"], "workspace_off")
        # The admin's settings API carries it.
        r = await self.http.put(f"/api/v1/workspaces/{self.ws['W1']}", json={"settings": {"comments_enabled": True}},
                                headers=self.session("wo"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["settings"]["comments_enabled"])
        await self.listing(d, "wm")

    async def test_password_item(self):
        d = await self.item("ULP")
        r = await self.http.get(self.url(d), headers=self.session("stranger"))
        self.assertEqual(r.status_code, 401)
        r = await self.http.get(self.url(d), headers={**self.session("stranger"), "X-Read-Password": PASSWORD})
        self.assertEqual(r.status_code, 200, r.text)

    async def test_tenant_session_comments(self):
        d = await self.item("W")
        t = await self.create(d, headers=self.tenant("wm", "W1"))
        self.assertEqual(t["created_by"]["name"], "WM")
        r = await self.http.put(self.url(d, "/settings"), json={"public": True}, headers=self.tenant("owner", "W1"))
        self.assertIn(r.status_code, (401, 403))


# ── Threads ───────────────────────────────────────────────────────────────────


class Threads(CommentsWorld):
    async def test_full_flow(self):
        d = await self.item("W")
        t = await self.create(d, "wv", mentions=[self.uid["wm"], self.uid["stranger"]])
        self.assertEqual(t["anchor"]["quote"]["exact"], "the new editor")
        self.assertEqual(t["anchor"]["block_id"], "b-p1aaaa")
        self.assertEqual(t["anchor_status"], "attached")
        # The stranger can't read the item: not mentioned.
        self.assertEqual([p["name"] for p in t["messages"][0]["mentions"]], ["WM"])
        out = await self.reply(d, t["id"], "wm", "Agreed")
        self.assertEqual(out["thread"]["message_count"], 2)
        mid = out["message"]["id"]
        self.assertTrue(out["message"]["can"]["edit"])
        # Edit own; not someone else's.
        r = await self.http.patch(self.url(d, f"/{t['id']}/messages/{mid}"), json={"body": "Agreed!"},
                                  headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIsNotNone(r.json()["edited_at"])
        r = await self.http.patch(self.url(d, f"/{t['id']}/messages/{mid}"), json={"body": "hack"},
                                  headers=self.session("owner"))
        self.assertEqual(r.status_code, 403)
        # React (toggle).
        r = await self.http.post(self.url(d, f"/{t['id']}/messages/{mid}/reactions"), json={"emoji": "👍"},
                                 headers=self.session("wv"))
        self.assertEqual(r.json()["reactions"], [{"emoji": "👍", "count": 1, "mine": True, "names": ["WV"]}])
        r = await self.http.post(self.url(d, f"/{t['id']}/messages/{mid}/reactions"), json={"emoji": "👍"},
                                 headers=self.session("wv"))
        self.assertEqual(r.json()["reactions"], [])
        for bad in ("abc", "<b>", "👍" * 17):
            r = await self.http.post(self.url(d, f"/{t['id']}/messages/{mid}/reactions"), json={"emoji": bad},
                                     headers=self.session("wv"))
            self.assertEqual(r.status_code, 422, bad)
        # Resolve, reply reopens, resolve again, reopen.
        r = await self.http.post(self.url(d, f"/{t['id']}/resolve"), headers=self.session("wm"))
        self.assertEqual(r.json()["status"], "resolved")
        self.assertEqual(r.json()["resolved_by"]["name"], "WM")
        self.assertEqual((await self.listing(d, "wm", status="open"))["threads"], [])
        out = await self.reply(d, t["id"], "wv", "One more thing")
        self.assertEqual(out["thread"]["status"], "open")
        self.assertEqual([h["action"] for h in out["thread"]["history"]], ["resolved", "reopened"])
        r = await self.http.post(self.url(d, f"/{t['id']}/resolve"), headers=self.session("wv"))
        self.assertEqual(r.status_code, 200)
        r = await self.http.post(self.url(d, f"/{t['id']}/reopen"), headers=self.session("wv"))
        self.assertEqual(r.json()["status"], "open")
        counts = (await self.doc(d["slug"]))["comment_counts"]
        self.assertEqual(counts, {"open": 1, "resolved": 0})
        # Delete: own reply; the owner moderates (no, wm isn't moderator; owner is).
        r = await self.http.delete(self.url(d, f"/{t['id']}/messages/{mid}"), headers=self.session("wv"))
        self.assertEqual(r.status_code, 403)
        r = await self.http.delete(self.url(d, f"/{t['id']}/messages/{mid}"), headers=self.session("owner"))
        self.assertEqual(r.status_code, 204)
        got = (await self.http.get(self.url(d, f"/{t['id']}"), headers=self.session("wm"))).json()
        self.assertEqual(got["message_count"], 2)
        self.assertNotIn(mid, [m["id"] for m in got["messages"]])
        # Deleting every message deletes the thread.
        for m in got["messages"]:
            await self.http.delete(self.url(d, f"/{t['id']}/messages/{m['id']}"), headers=self.session("owner"))
        r = await self.http.get(self.url(d, f"/{t['id']}"), headers=self.session("wm"))
        self.assertEqual(r.status_code, 404)
        self.assertEqual((await self.doc(d["slug"]))["comment_counts"], {"open": 0, "resolved": 0})

    async def test_deleted_first_message_keeps_the_thread(self):
        d = await self.item("W")
        t = await self.create(d, "wv")
        await self.reply(d, t["id"], "wm", "Reply stays")
        r = await self.http.delete(self.url(d, f"/{t['id']}/messages/{t['messages'][0]['id']}"),
                                   headers=self.session("wv"))
        self.assertEqual(r.status_code, 204)
        got = (await self.http.get(self.url(d, f"/{t['id']}"), headers=self.session("wm"))).json()
        self.assertTrue(got["messages"][0]["deleted"])
        self.assertEqual(got["messages"][0]["body"], "")
        self.assertEqual(got["messages"][1]["body"], "Reply stays")

    async def test_anchors_block_page_and_bad(self):
        d = await self.item("W")
        b = await self.create(d, anchor={"type": "block", "block_id": "b-li2aaa"})
        self.assertEqual(b["anchor"]["block_text"], "second task here")
        p = await self.create(d, anchor={"type": "page"})
        self.assertEqual(p["anchor"]["type"], "page")
        r = await self.http.post(self.url(d), json={"anchor": {"type": "text", "quote": {"exact": "not on the page"}},
                                                    "body": "x"}, headers=self.session("wm"))
        self.assertEqual((r.status_code, r.json()["code"]), (422, "anchor_not_found"))
        r = await self.http.post(self.url(d), json={"anchor": {"type": "page"}, "body": "x" * 5001},
                                 headers=self.session("wm"))
        self.assertEqual(r.status_code, 422)
        r = await self.http.post(self.url(d), json={"anchor": {"type": "page"}, "body": "   "},
                                 headers=self.session("wm"))
        self.assertEqual(r.status_code, 422)

    async def test_reanchor_on_save(self):
        d = await self.item("W")
        t = await self.create(d, "wv")
        b = await self.create(d, "wv", anchor={"type": "block", "block_id": "b-li2aaa"})
        # An edit around the quote keeps it; the editor's save path re-anchors at once.
        r = await self.save(d["slug"], "owner", CONTENT.replace("We will ship", "Next week we will ship"))
        self.assertEqual(r.status_code, 200, r.text)
        row = await self.db[model.THREADS].find_one({"_id": ObjectId(t["id"])})
        self.assertEqual(row["anchor_status"], "attached")
        self.assertEqual(row["anchor"]["rev"], (await self.doc(d["slug"]))["rev"])
        # Removing the quoted text marks it changed (the original quote stays); removing the block too.
        new = CONTENT.replace("We will ship the new editor on Monday.", "Plans changed.").replace(
            "- second task here {#b-li2aaa}\n", "")
        await self.save(d["slug"], "owner", new)
        lst = await self.listing(d, "wm")
        by = {x["id"]: x for x in lst["threads"]}
        self.assertEqual(by[t["id"]]["anchor_status"], "changed")
        self.assertEqual(by[t["id"]]["original"]["exact"], "the new editor")
        self.assertEqual(by[b["id"]]["anchor_status"], "changed")
        self.assertIn("anchor_changed", [h["action"] for h in by[t["id"]]["history"]])
        # Put back: attached again.
        await self.save(d["slug"], "owner", CONTENT)
        lst = await self.listing(d, "wm")
        self.assertEqual({x["anchor_status"] for x in lst["threads"]}, {"attached"})

    async def test_lazy_reanchor_for_other_writers(self):
        d = await self.item("W")
        t = await self.create(d, "wv")
        # A writer that bypasses the hooks: the list re-anchors.
        await self.db["documents"].update_one({"_id": d["_id"]}, {"$set": {"content": "# Gone\n"}, "$inc": {"rev": 1}})
        lst = await self.listing(d, "wm")
        self.assertEqual(lst["threads"][0]["anchor_status"], "changed")
        self.assertEqual(lst["threads"][0]["id"], t["id"])

    async def test_assign(self):
        d = await self.item("W")
        t = await self.create(d, "wv", assignee=self.uid["wm"])
        self.assertEqual(t["assignee"]["name"], "WM")
        # Someone who can't open the item can't be assigned.
        r = await self.http.put(self.url(d, f"/{t['id']}/assignee"), json={"user_id": self.uid["stranger"]},
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 422)
        # A viewer can't assign someone else's thread.
        t2 = await self.create(d, "owner")
        r = await self.http.put(self.url(d, f"/{t2['id']}/assignee"), json={"user_id": self.uid["wv"]},
                                headers=self.session("gv"))
        self.assertEqual(r.status_code, 403)
        r = await self.http.put(self.url(d, f"/{t2['id']}/assignee"), json={"user_id": self.uid["wv"]},
                                headers=self.session("owner"))
        self.assertEqual(r.json()["assignee"]["name"], "WV")
        # Home: waiting on you + action items; resolving completes it.
        home = (await self.http.get("/api/v1/home", headers=self.session("wm"))).json()
        self.assertEqual([x["thread_id"] for x in home["comments"]["waiting"]], [t["id"]])
        self.assertEqual(home["comments"]["waiting"][0]["waiting_reason"], "assigned")
        acts = [a for a in home["actions"]["items"] if a.get("kind") == "comment"]
        self.assertEqual([a["thread_id"] for a in acts], [t["id"]])
        self.assertTrue(acts[0]["url"].endswith(f"#c-{t['id']}"))
        mine = (await self.http.get("/api/v1/comments/mine?view=assigned", headers=self.session("wm"))).json()
        self.assertEqual(len(mine["items"]), 1)
        await self.http.post(self.url(d, f"/{t['id']}/resolve"), headers=self.session("wm"))
        home = (await self.http.get("/api/v1/home", headers=self.session("wm"))).json()
        self.assertEqual(home["comments"]["waiting"], [])
        # Unassign.
        r = await self.http.put(self.url(d, f"/{t2['id']}/assignee"), json={"user_id": None},
                                headers=self.session("owner"))
        self.assertIsNone(r.json()["assignee"])

    async def test_waiting_reply_and_access_loss(self):
        d = await self.item("W")
        t = await self.create(d, "wv")
        await self.reply(d, t["id"], "wm", "Answer for you")
        waiting = (await self.http.get("/api/v1/comments/mine", headers=self.session("wv"))).json()["items"]
        self.assertEqual([(x["thread_id"], x["waiting_reason"]) for x in waiting], [(t["id"], "reply")])
        # Removed from the workspace: the thread is gone from their lists.
        await self.remove_member("W1", "wv")
        self.assertEqual((await self.http.get("/api/v1/comments/mine", headers=self.session("wv"))).json()["items"], [])

    async def test_people_picker(self):
        d = await self.item("W")
        r = await self.http.get(self.url(d, "/people"), headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        names = {p["name"]: p for p in r.json()["people"]}
        self.assertIn("WV", names)
        self.assertTrue(names["WV"]["has_access"])
        self.assertIn("email", names["WV"])
        r = await self.http.get(self.url(d, "/people"), params={"q": "nobody@else.test"}, headers=self.session("owner"))
        self.assertEqual(r.json()["invite"], {"email": "nobody@else.test", "has_access": False, "can_share": True})
        # A member of a filed item that doesn't allow re-sharing is told they can't share.
        r = await self.http.get(self.url(d, "/people"), params={"q": "nobody@else.test"}, headers=self.session("wm"))
        self.assertFalse(r.json()["invite"]["can_share"])
        # A link reader without a relationship sees no emails.
        lk = await self.item("UL")
        r = await self.http.get(self.url(lk, "/people"), headers=self.session("stranger"))
        self.assertTrue(all("email" not in p for p in r.json()["people"]))
        r = await self.http.get(self.url(lk, "/people"), params={"q": self.email["gv"]}, headers=self.session("stranger"))
        self.assertEqual(r.json()["people"], [])
        self.assertIsNotNone(r.json()["invite"])

    async def test_thread_cap(self):
        d = await self.item("W")
        with mock.patch.object(service, "MAX_THREADS_PER_ITEM", 2):
            await self.create(d)
            await self.create(d)
            await self.create(d, status=422)


# ── Notifications ─────────────────────────────────────────────────────────────


class Bell(CommentsWorld):
    async def test_who_hears(self):
        d = await self.item("W")
        t = await self.create(d, "wv", mentions=[self.uid["wm"]])
        mine = await self.bell("wm")
        self.assertEqual([(n["kind"], n["thread_id"]) for n in mine], [("comment_mention", t["id"])])
        self.assertTrue(mine[0]["href"].endswith(f"#c-{t['id']}"))
        self.assertIn("mentioned you in a comment", mine[0]["text"])
        self.assertEqual(mine[0]["excerpt"], "Looks good?")
        own = await self.bell("owner")
        self.assertEqual([n["kind"] for n in own], ["comment_new"])
        self.assertEqual(await self.bell("wv"), [])  # never the actor
        # Replies: participants hear; repeated unread replies bump one row.
        await self.reply(d, t["id"], "ge", "First reply")
        await self.reply(d, t["id"], "ge", "Second reply")
        rows = [n for n in await self.bell("wv") if n["kind"] == "comment_reply"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["count"], 2)
        self.assertEqual(rows[0]["excerpt"], "Second reply")
        # Opening it goes to the thread.
        r = await self.http.post(f"/api/v1/notifications/{rows[0]['id']}/open", headers=self.session("wv"))
        self.assertEqual(r.json()["href"], f"/{d['slug']}#c-{t['id']}")
        # Resolved: the author hears.
        await self.http.post(self.url(d, f"/{t['id']}/resolve"), headers=self.session("wm"))
        self.assertIn("comment_resolved", [n["kind"] for n in await self.bell("wv")])
        # Assigned.
        await self.http.put(self.url(d, f"/{t['id']}/assignee"), json={"user_id": self.uid["gv"]},
                            headers=self.session("owner"))
        self.assertIn("comment_assigned", [n["kind"] for n in await self.bell("gv")])

    async def test_no_bell_for_people_who_lost_access(self):
        d = await self.item("W")
        await self.remove_member("W1", "wv")
        await self.create(d, "wm", mentions=[self.uid["wv"]])
        self.assertEqual(await self.bell("wv"), [])

    async def test_plugins_get_events_and_failures_are_isolated(self):
        seen: list[str] = []

        async def ok(db, ev):
            seen.append(ev.kind)

        async def boom(db, ev):
            raise RuntimeError("plugin broke")

        events.on(ok, name="test-ok")
        events.on(boom, kinds=["thread_created"], name="test-boom")
        self.addCleanup(events.off, "test-ok")
        self.addCleanup(events.off, "test-boom")
        d = await self.item("W")
        t = await self.create(d, "wv")
        await self.reply(d, t["id"], "wm")
        self.assertEqual(seen[:2], ["thread_created", "replied"])
        with self.assertRaises(ValueError):
            events.on(ok, kinds=["nope"], name="bad")


# ── Live ──────────────────────────────────────────────────────────────────────


class Live(CommentsWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        viewers.clear()
        self.tasks: list[asyncio.Task] = []
        self.addAsyncCleanup(self._close)

    async def _close(self):
        for t in self.tasks:
            t.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        viewers.clear()

    async def open(self, d, who=None):
        ws = FakeSocket(tickets.mint(str(d["_id"]), int(d.get("access_epoch") or 0)))
        self.tasks.append(asyncio.create_task(live_router.serve(ws, d["slug"])))
        await settle(2)
        msg = {"type": "hello", "n": f"tab{len(self.tasks):04d}xyz", "anon": False, "state": "active"}
        if who:
            msg["pt"] = tickets.mint_presence(str(d["_id"]), self.uid[who])
        ws.say(**msg)
        await settle()
        return ws

    def comments_events(self, ws):
        return [m for m in ws.sent if m.get("type") == "comments"]

    async def test_signed_in_viewers_only(self):
        d = await self.item("UL")
        signed = await self.open(d, "gv")
        anon = await self.open(d)
        await self.create(d, "wm")
        await settle()
        got = self.comments_events(signed)
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["op"], "thread_created")
        self.assertNotIn("pub", got[0])
        self.assertNotIn("body", str(got[0]))
        self.assertEqual(self.comments_events(anon), [])
        # Public comments: anonymous readers get the signal too.
        await self.http.put(self.url(d, "/settings"), json={"public": True}, headers=self.session("owner"))
        await settle()
        before = len(self.comments_events(anon))
        await self.create(d, "wm")
        await settle()
        self.assertGreater(len(self.comments_events(anon)), before)

    async def test_bus_carries_comment_events(self):
        d = await self.item("UL")
        sent = []
        with mock.patch.object(live, "_publish", lambda msg: sent.append(msg)):
            await self.create(d, "wm")
        self.assertTrue(any(m.get("e", {}).get("type") == "comments" for m in sent))


# ── MCP ───────────────────────────────────────────────────────────────────────


class Mcp(CommentsWorld):
    async def ok(self, who, name, args, *, write=True):
        res = await self.mcp(who, name, args, write=write)
        self.assertFalse(res["isError"], res["content"][0]["text"])
        return res["structuredContent"]

    async def err(self, who, name, args, *, write=True) -> str:
        res = await self.mcp(who, name, args, write=write)
        self.assertTrue(res["isError"], res)
        return res["content"][0]["text"]

    async def test_tools(self):
        d = await self.item("W")
        out = await self.ok("wm", "add_comment", {"document": d["slug"], "body": "Is Monday right?",
                                                   "quote": "new editor", "mentions": [self.email["wv"]]})
        tid = out["thread"]["id"]
        self.assertEqual(out["thread"]["quote"], "new editor")
        self.assertTrue(out["thread_url"].endswith(f"#c-{tid}"))
        msg = await self.db[model.MESSAGES].find_one({"thread_id": ObjectId(tid)})
        self.assertEqual(msg["via"], "mcp")
        self.assertEqual(msg["mentions"], [self.uid["wv"]])
        blk = await self.ok("wm", "add_comment", {"document": d["slug"], "body": "Block", "block": "b-li1aaa"})
        self.assertEqual(blk["thread"]["anchor"]["block_id"], "b-li1aaa")
        page = await self.ok("wm", "add_comment", {"document": d["slug"], "body": "Overall fine"})
        self.assertEqual(page["thread"]["anchor"]["type"], "page")
        self.assertIn("isn't on the page", await self.err("wm", "add_comment", {"document": d["slug"], "body": "x",
                                                                                 "quote": "missing words here"}))
        lst = await self.ok("wv", "list_comments", {"document": d["slug"]}, write=False)
        self.assertEqual(len(lst["threads"]), 3)
        await self.ok("wv", "reply_comment", {"document": d["slug"], "thread_id": tid, "body": "Yes"})
        got = await self.ok("wv", "get_thread", {"document": d["slug"], "thread_id": tid}, write=False)
        self.assertEqual([m["body"] for m in got["thread"]["messages"]], ["Is Monday right?", "Yes"])
        mid = got["thread"]["messages"][0]["id"]
        r = await self.ok("wv", "react_comment", {"document": d["slug"], "thread_id": tid, "message_id": mid,
                                                   "emoji": "🎉"})
        self.assertEqual(r["reactions"][0]["count"], 1)
        await self.ok("wm", "assign_thread", {"document": d["slug"], "thread_id": tid, "assignee": self.email["wv"]})
        res = await self.ok("wm", "resolve_comment", {"document": d["slug"], "thread_id": tid})
        self.assertEqual(res["thread"]["status"], "resolved")
        res = await self.ok("wm", "reopen_comment", {"document": d["slug"], "thread_id": tid})
        self.assertEqual(res["thread"]["status"], "open")
        # Viewers can't resolve others' threads; only the owner sets switches.
        self.assertIn("resolve", await self.err("wv", "resolve_comment", {"document": d["slug"], "thread_id": tid}))
        self.assertIn("owner", await self.err("wm", "set_comment_settings", {"document": d["slug"], "public": True}))
        s = await self.ok("owner", "set_comment_settings", {"document": d["slug"], "public": True})
        self.assertTrue(s["public"])
        # Strangers learn nothing.
        await self.err("stranger", "list_comments", {"document": d["slug"]}, write=False)
        enc = await self.mkdoc("W", encrypted=True, content="ENC")
        self.assertIn("encrypted", await self.err("owner", "list_comments", {"document": enc["slug"]}, write=False))

    async def test_read_only_token_refused(self):
        d = await self.item("W")
        status, res = await self.mcp_call(await self.mcp_token("wm", write=False), "add_comment",
                                          {"document": d["slug"], "body": "x"})
        self.assertTrue(status == 403 or (res or {}).get("isError"), (status, res))
        self.assertEqual(await self.db[model.THREADS].count_documents({}), 0)


# ── Limits, deletion, anonymising ─────────────────────────────────────────────


class Housekeeping(CommentsWorld):
    async def test_rate_limit(self):
        from app.limiter import limiter

        limiter.enabled = True
        limiter.reset()
        d = await self.item("W")
        codes = []
        for _ in range(32):
            r = await self.http.post(self.url(d), json={"anchor": {"type": "page"}, "body": "spam"},
                                     headers=self.session("wm"))
            codes.append(r.status_code)
        self.assertIn(429, codes)
        self.assertEqual(codes.count(201), 30)

    async def test_purge_removes_threads(self):
        from app.services import lifecycle

        d = await self.item("W")
        await self.create(d)
        await lifecycle.destroy(self.db, await self.doc(d["slug"]))
        self.assertEqual(await self.db[model.THREADS].count_documents({}), 0)
        self.assertEqual(await self.db[model.MESSAGES].count_documents({}), 0)

    async def test_trashed_item_has_no_comments(self):
        d = await self.item("W")
        await self.create(d)
        await self.db["documents"].update_one({"_id": d["_id"]}, {"$set": {"deleted_at": now()}})
        r = await self.http.get(self.url(d), headers=self.session("wm"))
        self.assertEqual(r.status_code, 404)

    async def test_anonymise(self):
        d = await self.item("W")
        t = await self.create(d, "wv", mentions=[self.uid["wm"]], assignee=self.uid["wv"])
        m = t["messages"][0]["id"]
        await self.http.post(self.url(d, f"/{t['id']}/messages/{m}/reactions"), json={"emoji": "👍"},
                             headers=self.session("wv"))
        await service.anonymise_user(self.db, self.uid["wv"])
        await self.db["users"].delete_one({"_id": ObjectId(self.uid["wv"])})
        got = (await self.http.get(self.url(d, f"/{t['id']}"), headers=self.session("wm"))).json()
        self.assertEqual(got["created_by"]["name"], "Deleted account")
        self.assertIsNone(got["created_by"]["id"])
        self.assertEqual(got["messages"][0]["author"]["name"], "Deleted account")
        self.assertEqual(got["messages"][0]["body"], "Looks good?")  # words stay
        self.assertEqual(got["messages"][0]["reactions"], [])
        self.assertIsNone(got["assignee"])
        row = await self.db[model.THREADS].find_one({"_id": ObjectId(t["id"])})
        self.assertNotIn(self.uid["wv"], row["participants"])

    async def test_deleted_account_without_anonymising_reads_as_deleted(self):
        d = await self.item("W")
        t = await self.create(d, "wv")
        await self.db["users"].delete_one({"_id": ObjectId(self.uid["wv"])})
        got = (await self.http.get(self.url(d, f"/{t['id']}"), headers=self.session("wm"))).json()
        self.assertEqual(got["messages"][0]["author"]["name"], "Deleted account")
