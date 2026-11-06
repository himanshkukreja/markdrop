"""Mentions that notify (Senseloaf P2 item 9): services/notifications.py, the
REST routes (routers/notifications.py), the share dialog's "Notify people"
(routers/access.py), the batched email, the turn-off link and the MCP tools
(app/mcp/notify_tools.py).

The access-policy world (tests/_access_env.py): the test MongoDB (or
mongomock), never backend/.env. Email is never sent: ``mailer._post`` is
replaced by a list that records each payload.
"""

from __future__ import annotations

import json
from datetime import timedelta
from unittest import mock

from tests._access_env import now  # noqa: F401  (pins settings first)

from bson import ObjectId

from app.services import mailer, notifications, page_history
from tests.test_pages import PageWorld

N = notifications.COLL


def person(uid: str, name: str) -> str:
    return f':person[{name}]{{id="{uid}"}}'


class NotifyWorld(PageWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await notifications.ensure_indexes(self.db)
        await page_history.ensure_indexes(self.db)
        self.sent: list[dict] = []

        async def capture(payload):
            self.sent.append(payload)

        for p in (mock.patch.object(mailer, "is_configured", lambda: True),
                  mock.patch.object(mailer, "_post", capture)):
            p.start()
            self.addCleanup(p.stop)

    async def page(self, state: str = "W", content: str = "# Plan\n", **kw) -> dict:
        return await self.mkdoc(state, editor="blocks", content=content, **kw)

    async def save(self, slug: str, who: str, content: str, title: str = "Launch plan"):
        r = await self.http.put(f"/api/v1/documents/{slug}", json={"title": title, "content": content},
                                headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def notes(self, who: str, **q) -> list[dict]:
        return await self.db[N].find({"user_id": self.uid[who], **q}).sort("created_at", 1).to_list(length=None)

    async def listing(self, who: str, **params) -> dict:
        r = await self.http.get("/api/v1/notifications", params=params, headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def mcp(self, who: str, name: str, args: dict, *, write: bool = True) -> dict:
        status, res = await self.mcp_call(await self.mcp_token(who, write=write), name, args)
        self.assertEqual(status, 200, name)
        self.assertFalse(res["isError"], res["content"][0]["text"])
        return res["structuredContent"]

    async def flush(self, minutes: float = 2):
        return await notifications.flush_emails(self.db, now() + timedelta(minutes=minutes))


# ── Who is notified ───────────────────────────────────────────────────────────


class Who(NotifyWorld):
    async def test_a_new_mention_notifies_a_member_who_can_open_the_page(self):
        p = await self.page()
        await self.save(p["slug"], "owner", f"# Plan\n\nPing {person(self.uid['wm'], 'WM')} about QA. {{#b-qa0001}}\n")
        rows = await self.notes("wm")
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual((r["kind"], r["block_id"], r["actor_id"], r["actor_name"], r["email"]),
                         ("mention", "b-qa0001", self.uid["owner"], "OWNER", "pending"))
        self.assertEqual(r["extra"]["excerpt"], "Ping @WM about QA.")
        self.assertNotIn("title", r)  # titles are never stored
        self.assertNotIn("Launch plan", json.dumps(r, default=str))

    async def test_the_author_is_never_notified_of_their_own_mention(self):
        p = await self.page()
        await self.save(p["slug"], "owner", f"Note to self: {person(self.uid['owner'], 'OWNER')}\n")
        self.assertEqual(await self.notes("owner"), [])

    async def test_nobody_who_cant_open_the_page_is_notified(self):
        w = await self.page("W")  # workspace W1: members, plus gv / ge by grant
        await self.save(w["slug"], "owner", " ".join(person(self.uid[x], x) for x in ("stranger", "wm2", "gv")))
        self.assertEqual(await self.notes("stranger"), [])
        self.assertEqual(await self.notes("wm2"), [])  # a member of another workspace
        self.assertEqual(len(await self.notes("gv")), 1)  # shared with them by email
        priv = await self.page("P")  # private: the owner and the people it's shared with
        await self.save(priv["slug"], "owner", person(self.uid["wm"], "WM") + " " + person(self.uid["ge"], "GE"))
        self.assertEqual(len(await self.notes("wm")), 0)
        self.assertEqual(len(await self.notes("ge")), 1)
        pw = await self.page("ULP")  # anyone with the link AND the password: no password, no notification
        await self.save(pw["slug"], "owner", person(self.uid["stranger"], "ST"))
        self.assertEqual(await self.notes("stranger"), [])

    async def test_mentions_already_in_the_previous_version_dont_notify_again(self):
        p = await self.page()
        a = f"Hi {person(self.uid['wm'], 'WM')}"
        await self.save(p["slug"], "owner", a)
        await self.save(p["slug"], "owner", a + " and more text")
        await self.save(p["slug"], "owner", a + f" and {person(self.uid['wa'], 'WA')}")
        self.assertEqual(len(await self.notes("wm")), 1)
        self.assertEqual(len(await self.notes("wa")), 1)
        # Removed and added back while editing: still once (24 hours per person, page and block).
        await self.save(p["slug"], "owner", "gone")
        await self.save(p["slug"], "owner", a)
        self.assertEqual(len(await self.notes("wm")), 1)
        # The block got an anchor ("Copy link to block"), or the paragraph moved: not news.
        await self.save(p["slug"], "owner", "Intro\n\n" + a + " {#b-hi0001}")
        self.assertEqual(len(await self.notes("wm")), 1)
        # Mentioned again in another block: that is.
        await self.save(p["slug"], "owner", "Intro\n\n" + a + " {#b-hi0001}\n\nAlso " + person(self.uid["wm"], "WM")
                        + " {#b-hi0002}")
        self.assertEqual([r["block_id"] for r in await self.notes("wm")], [None, "b-hi0002"])

    async def test_mentions_in_code_and_classic_documents_dont_notify(self):
        p = await self.page()
        await self.save(p["slug"], "owner", f"```\n{person(self.uid['wm'], 'WM')}\n```\n`{person(self.uid['wa'], 'WA')}`")
        self.assertEqual(await self.notes("wm"), [])
        self.assertEqual(await self.notes("wa"), [])
        classic = await self.mkdoc("W", content="# Doc")
        await self.save(classic["slug"], "owner", person(self.uid["wm"], "WM"))
        self.assertEqual(await self.notes("wm"), [])

    async def test_an_anonymous_edit_secret_writer_notifies_nobody(self):
        p = await self.page("UL")
        r = await self.http.put(f"/api/v1/documents/{p['slug']}", json={"title": "T", "content": person(self.uid["wm"], "WM")},
                                headers={"X-Edit-Secret": "sk_test_edit_secret"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(await self.notes("wm"), [])

    async def test_block_anchor_from_the_paragraph_or_its_container(self):
        p = await self.page()
        md = (f"First line with {person(self.uid['wm'], 'WM')}\nsecond line. {{#b-para01}}\n\n"
              f":::callout{{#b-call01 color=\"blue\"}}\nInside {person(self.uid['wa'], 'WA')}\n:::\n\n"
              f"- item {person(self.uid['wv'], 'WV')}\n- next {{#b-next01}}\n")
        await self.save(p["slug"], "owner", md)
        self.assertEqual((await self.notes("wm"))[0]["block_id"], "b-para01")
        self.assertEqual((await self.notes("wa"))[0]["block_id"], "b-call01")
        self.assertIsNone((await self.notes("wv"))[0]["block_id"])  # the next item's anchor isn't its own

    async def test_excerpts_hide_other_peoples_names_outside_the_circle(self):
        p = await self.page()
        await self.save(p["slug"], "owner", f"{person(self.uid['gv'], 'GV')} and {person(self.uid['wm'], 'WM')} review")
        self.assertEqual((await self.notes("gv"))[0]["extra"]["excerpt"], "@GV and @someone review")
        self.assertEqual((await self.notes("wm"))[0]["extra"]["excerpt"], "@GV and @WM review")

    async def test_restore_notifies_people_it_brings_back(self):
        p = await self.page(content=f"# Plan\n\n{person(self.uid['wm'], 'WM')} owns it")  # written outside the hooks
        await self.save(p["slug"], "owner", "# Plan\n\nnobody")
        self.assertEqual(await self.notes("wm"), [])
        versions = await self.db[page_history.COLL].find({"doc_id": str(p["_id"])}).sort("n", 1).to_list(length=None)
        first = next(v for v in versions if "WM" in (v.get("markdown") or ""))
        r = await self.http.post(f"/api/v1/documents/{p['slug']}/versions/{first['n']}/restore",
                                 headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len(await self.notes("wm")), 1)

    async def test_signoff_blocks_notify_the_named_person_once(self):
        p = await self.page()
        await self.save(p["slug"], "owner", f'# Plan\n\n:::signoff{{#b-so1234 person="{self.uid["wm"]}" '
                                            'label="Release approval" options="Approved|Not approved"}\n:::\n')
        rows = await self.notes("wm")
        self.assertEqual([(r["kind"], r["block_id"], r["extra"]["label"]) for r in rows],
                         [("signoff_requested", "b-so1234", "Release approval")])
        # The sign-off service may call notify itself too: no second notification.
        raw = await self.doc(p["slug"])
        self.assertIsNone(await notifications.notify(self.db, self.uid["wm"], "signoff_requested", raw, "b-so1234",
                                                      self.uid["owner"], {"label": "Release approval"}))
        body = await self.listing("wm")
        self.assertEqual(body["items"][0]["text"],
                         "OWNER asked you to sign off on “Release approval” in “Launch plan”")

    async def test_notify_api(self):
        raw = await self.page()
        with self.assertRaises(ValueError):
            await notifications.notify(self.db, self.uid["wm"], "nope", raw, None, self.uid["owner"])
        self.assertIsNone(await notifications.notify(self.db, self.uid["wm"], "mention", raw, None, None))
        self.assertIsNone(await notifications.notify(self.db, self.uid["wm"], "mention", raw, None, self.uid["wm"]))
        self.assertIsNone(await notifications.notify(self.db, "not-an-id", "mention", raw, None, self.uid["owner"]))
        enc = await self.page(encrypted=True)
        self.assertIsNone(await notifications.notify(self.db, self.uid["wm"], "mention", enc, None, self.uid["owner"]))
        # By slug, a bad block id is dropped, a users row as the actor.
        actor = await self.db["users"].find_one({"_id": ObjectId(self.uid["wa"])})
        row = await notifications.notify(self.db, self.uid["wm"], "signoff_requested", raw["slug"], "nope!", actor,
                                         {"label": "x" * 300})
        self.assertEqual((row["block_id"], row["actor_name"], len(row["extra"]["label"])), (None, "WA", 120))


# ── Reading them (the bell) ───────────────────────────────────────────────────


class Bell(NotifyWorld):
    async def test_listing_count_and_open(self):
        p = await self.page()
        await self.save(p["slug"], "owner", f"Hey {person(self.uid['wm'], 'WM')} {{#b-hey001}}")
        body = await self.listing("wm")
        self.assertEqual(body["unread_count"], 1)
        item = body["items"][0]
        self.assertEqual((item["kind"], item["text"], item["href"], item["available"], item["read"]),
                         ("mention", "OWNER mentioned you in “Launch plan”", f"/{p['slug']}#b-hey001", True, False))
        self.assertEqual(item["page"], {"slug": p["slug"], "title": "Launch plan"})
        r = await self.http.get("/api/v1/notifications/unread-count", headers=self.session("wm"))
        self.assertEqual(r.json(), {"unread_count": 1})
        r = await self.http.post(f"/api/v1/notifications/{item['id']}/open", headers=self.session("wm"))
        self.assertEqual(r.json(), {"href": f"/{p['slug']}#b-hey001", "slug": p["slug"], "block": "b-hey001"})
        self.assertEqual((await self.listing("wm"))["unread_count"], 0)

    async def test_lost_access_hides_the_title_and_opening_is_refused(self):
        p = await self.page()
        await self.save(p["slug"], "owner", f"Hey {person(self.uid['wm'], 'WM')} about the secret merger {{#b-hey001}}")
        await self.remove_member("W1", "wm")
        r = await self.http.get("/api/v1/notifications", headers=self.session("wm"))
        self.assertNotIn("Launch plan", r.text)
        self.assertNotIn(p["slug"], r.text)
        self.assertNotIn("merger", r.text)
        item = r.json()["items"][0]
        self.assertEqual((item["available"], item["page"], item["href"], item["url"], item["excerpt"], item["block"]),
                         (False, None, None, None, None, None))
        self.assertEqual(item["text"], "OWNER mentioned you on a page you can't open")
        r = await self.http.post(f"/api/v1/notifications/{item['id']}/open", headers=self.session("wm"))
        self.assertEqual(r.status_code, 403)
        self.assertNotIn(p["slug"], r.text)

    async def test_only_your_own_and_signed_in_only(self):
        p = await self.page()
        await self.save(p["slug"], "owner", person(self.uid["wm"], "WM"))
        nid = str((await self.notes("wm"))[0]["_id"])
        self.assertEqual((await self.http.get("/api/v1/notifications")).status_code, 401)
        r = await self.http.post(f"/api/v1/notifications/{nid}/open", headers=self.session("wa"))
        self.assertEqual(r.status_code, 404)
        r = await self.http.post("/api/v1/notifications/read", json={"ids": [nid]}, headers=self.session("wa"))
        self.assertEqual(r.json()["marked"], 0)
        self.assertEqual((await self.listing("wa"))["items"], [])
        # Not on a workspace's own domain.
        r = await self.http.get("/api/v1/notifications", headers=self.tenant("wm", "W1"))
        self.assertIn(r.status_code, (401, 403))

    async def test_mark_read_by_id_and_all(self):
        p = await self.page()
        await self.save(p["slug"], "owner", person(self.uid["wm"], "WM") + " {#b-one001}")
        await self.save(p["slug"], "owner", person(self.uid["wm"], "WM") + " {#b-one001}\n\n"
                        + person(self.uid["wm"], "WM") + " again {#b-two001}")
        q = await self.page()
        await self.save(q["slug"], "wa", person(self.uid["wm"], "WM"))
        ids = [str(r["_id"]) for r in await self.notes("wm")]
        self.assertEqual(len(ids), 3)  # two blocks on p, one on q
        await self.http.post("/api/v1/notifications/read", json={"ids": ids[1:2]}, headers=self.session("wm"))
        ids = [ids[0], ids[2]]
        r = await self.http.post("/api/v1/notifications/read", json={"ids": ids[:1]}, headers=self.session("wm"))
        self.assertEqual(r.json(), {"marked": 1, "unread_count": 1})
        r = await self.http.post("/api/v1/notifications/read", json={}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 422)
        r = await self.http.post("/api/v1/notifications/read", json={"all": True}, headers=self.session("wm"))
        self.assertEqual(r.json(), {"marked": 1, "unread_count": 0})
        self.assertEqual((await self.listing("wm", unread_only=True))["items"], [])


# ── Email ─────────────────────────────────────────────────────────────────────


class Email(NotifyWorld):
    async def test_batched_one_email_per_person_per_page_per_10_minutes(self):
        p = await self.page()
        await self.save(p["slug"], "owner", f"{person(self.uid['wm'], 'WM')} frontend {{#b-aaa001}}")
        await self.save(p["slug"], "wa", f"{person(self.uid['wm'], 'WM')} frontend {{#b-aaa001}}\n\n"
                        f':::signoff{{#b-so0001 person="{self.uid["wm"]}" label="Go live"}}\n:::\n')
        self.assertEqual(await notifications.flush_emails(self.db, now() + timedelta(seconds=20)), {})
        self.assertEqual(self.sent, [])  # still gathering
        self.assertEqual(await self.flush(2), {"sent": 1})
        self.assertEqual(len(self.sent), 1)
        mail = self.sent[0]
        self.assertEqual(mail["to"], [self.email["wm"]])
        self.assertEqual(mail["subject"], "2 updates for you in “Launch plan”")
        self.assertIn("OWNER", mail["html"])
        self.assertIn("Go live", mail["html"])
        self.assertIn(f"/{p['slug']}#b-aaa001", mail["html"])
        self.assertIn("List-Unsubscribe", mail["headers"])
        self.assertTrue(all(r["email"] == "sent" for r in await self.notes("wm")))
        # Another mention 3 minutes later waits until 10 minutes after the last email.
        await self.save(p["slug"], "owner", f"{person(self.uid['wm'], 'WM')} frontend {{#b-aaa001}}\n\n"
                        f':::signoff{{#b-so0001 person="{self.uid["wm"]}" label="Go live"}}\n:::\n\n'
                        f"{person(self.uid['wm'], 'WM')} QA {{#b-bbb001}}")
        self.assertEqual(await self.flush(5), {"waiting": 1})
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(await self.flush(12.5), {"sent": 1})
        self.assertEqual(len(self.sent), 2)
        self.assertEqual(self.sent[1]["subject"], "OWNER mentioned you in “Launch plan”")

    async def test_two_pages_two_emails_and_read_in_app_means_no_email(self):
        a, b, c = await self.page(), await self.page(), await self.page()
        for x in (a, b, c):
            await self.save(x["slug"], "owner", person(self.uid["wm"], "WM"))
        seen = str((await self.notes("wm", doc_id=str(c["_id"])))[0]["_id"])
        await self.http.post("/api/v1/notifications/read", json={"ids": [seen]}, headers=self.session("wm"))
        self.assertEqual(await self.flush(), {"seen": 1, "sent": 2})
        self.assertEqual(len(self.sent), 2)

    async def test_access_lost_before_sending_means_no_email(self):
        p = await self.page()
        await self.save(p["slug"], "owner", person(self.uid["wm"], "WM"))
        await self.remove_member("W1", "wm")
        self.assertEqual(await self.flush(), {"no_access": 1})
        self.assertEqual(self.sent, [])

    async def test_the_preference_and_its_turn_off_link(self):
        r = await self.http.get("/api/v1/auth/me", headers=self.session("wm"))
        self.assertTrue(r.json()["mention_emails"])
        r = await self.http.patch("/api/v1/me/preferences", json={"mention_emails": False}, headers=self.session("wm"))
        self.assertEqual(r.json(), {"analytics_digest": "weekly", "mention_emails": False})
        self.assertFalse((await self.http.get("/api/v1/auth/me", headers=self.session("wm"))).json()["mention_emails"])
        p = await self.page()
        await self.save(p["slug"], "owner", person(self.uid["wm"], "WM"))
        self.assertEqual((await self.notes("wm"))[0]["email"], "off")  # in-app only
        self.assertEqual(await self.flush(), {})
        r = await self.http.patch("/api/v1/me/preferences", json={"mention_emails": True}, headers=self.session("wm"))
        self.assertTrue(r.json()["mention_emails"])
        # The digest preference alone still works as before.
        r = await self.http.patch("/api/v1/me/preferences", json={"analytics_digest": "off"}, headers=self.session("wm"))
        self.assertEqual(r.json(), {"analytics_digest": "off", "mention_emails": True})
        self.assertEqual((await self.http.patch("/api/v1/me/preferences", json={},
                                                headers=self.session("wm"))).status_code, 422)

        # The email's link: the GET asks, the POST turns emails off; a forged token is refused.
        await self.save(p["slug"], "wa", person(self.uid["wa"], "WA") + " " + person(self.uid["wv"], "WV"))
        await self.flush()
        mail = self.sent[-1]
        off = notifications.off_url(self.uid["wv"])
        self.assertIn(off.replace("&", "&amp;"), mail["html"])
        self.assertEqual(mail["headers"]["List-Unsubscribe"], f"<{off}>")
        path = off.split("https://api.markdrop.in", 1)[1]
        r = await self.http.get(path)
        self.assertEqual(r.status_code, 200)
        self.assertIn("Turn off mention emails", r.text)
        self.assertIsNot((await self.db["users"].find_one({"_id": ObjectId(self.uid["wv"])})).get("mention_emails"), False)
        r = await self.http.post(path)
        self.assertEqual(r.status_code, 200)
        self.assertIs((await self.db["users"].find_one({"_id": ObjectId(self.uid["wv"])}))["mention_emails"], False)
        r = await self.http.get("/api/v1/me/mentions/off?t=" + self.uid["wv"] + ".forged")
        self.assertEqual(r.status_code, 400)

    async def test_unsubscribed_and_suppressed_addresses_get_no_email(self):
        await self.db["users"].update_one({"_id": ObjectId(self.uid["wm"])}, {"$set": {"unsubscribed_at": now()}})
        await self.db["email_suppressions"].insert_one({"_id": self.email["wa"], "reason": "bounced"})
        p = await self.page()
        await self.save(p["slug"], "owner", person(self.uid["wm"], "WM") + " " + person(self.uid["wa"], "WA"))
        self.assertEqual((await self.notes("wm"))[0]["email"], "off")
        self.assertEqual(await self.flush(), {"suppressed": 1})
        self.assertEqual(self.sent, [])


# ── Share dialog: "Notify people" ─────────────────────────────────────────────


class Withdraw(NotifyWorld):
    """A mention taken out again (owner, 2026-11-06): its unread notification goes, and nothing
    pending about it is sent."""

    async def test_added_and_removed_within_the_minute_sends_nothing(self):
        p = await self.page()
        await self.save(p["slug"], "owner", f"Ping {person(self.uid['wm'], 'WM')} about QA {{#b-qa0001}}")
        self.assertEqual(len(await self.notes("wm")), 1)
        await self.save(p["slug"], "owner", f"Ping {person(self.uid['wa'], 'WA')} about QA {{#b-qa0001}}")  # the right one
        self.assertEqual(await self.notes("wm"), [])                       # the bell entry is gone
        self.assertEqual((await self.listing("wm"))["unread_count"], 0)
        self.assertEqual(await self.flush(), {"sent": 1})                  # WA's email only
        self.assertEqual([m["to"] for m in self.sent], [[self.email["wa"]]])
        self.assertEqual(await self.db[notifications.WITHDRAWN].count_documents({}), 0)  # never delivered
        # Put back later: they're told then (they never were).
        await self.save(p["slug"], "owner", f"Ping {person(self.uid['wm'], 'WM')} about QA {{#b-qa0001}}")
        self.assertEqual(len(await self.notes("wm")), 1)

    async def test_removed_after_the_email_the_unread_bell_entry_goes_and_doesnt_come_back(self):
        p = await self.page()
        text = f"Ping {person(self.uid['wm'], 'WM')} {{#b-qa0001}}\n\nAnd {person(self.uid['wa'], 'WA')} {{#b-qa0002}}"
        await self.save(p["slug"], "owner", text)
        self.assertEqual(await self.flush(), {"sent": 2})
        await self.http.post("/api/v1/notifications/read", json={"all": True}, headers=self.session("wa"))
        await self.save(p["slug"], "owner", "Nobody here now")
        self.assertEqual(await self.notes("wm"), [])                       # unread: gone from the bell
        self.assertEqual(len(await self.notes("wa")), 1)                   # read: stays
        # Put back the same day: the email already went, so no second one (and no bell row).
        await self.save(p["slug"], "owner", text)
        self.assertEqual(await self.notes("wm"), [])
        self.assertEqual(await self.flush(15), {})
        self.assertEqual(len(self.sent), 2)

    async def test_only_the_mention_taken_out(self):
        p = await self.page()
        a = f"A {person(self.uid['wm'], 'WM')} {{#b-aaaa01}}"
        b = f"B {person(self.uid['wm'], 'WM')} {{#b-aaaa02}}"
        await self.save(p["slug"], "owner", a)
        await self.save(p["slug"], "owner", a + "\n\n" + b)
        self.assertEqual([r["block_id"] for r in await self.notes("wm")], ["b-aaaa01", "b-aaaa02"])
        await self.save(p["slug"], "owner", b)
        self.assertEqual([r["block_id"] for r in await self.notes("wm")], ["b-aaaa02"])
        # Moved, or its block got an anchor: not taken out.
        await self.save(p["slug"], "owner", "Intro\n\n" + b)
        self.assertEqual(len(await self.notes("wm")), 1)

    async def test_a_signoff_request_taken_out(self):
        p = await self.page()
        await self.save(p["slug"], "owner", f':::signoff{{#b-so0001 person="{self.uid["wm"]}" label="Go live"}}\n:::\n')
        self.assertEqual([r["kind"] for r in await self.notes("wm")], ["signoff_requested"])
        await self.save(p["slug"], "owner", "# Plan\n")
        self.assertEqual(await self.notes("wm"), [])
        self.assertEqual(await self.flush(), {})

    async def test_send_time_recheck(self):
        # The row was made, then the mention left the page without the save hook seeing it (another
        # writer, a race): the email flush checks the page as it is now.
        p = await self.page()
        await self.save(p["slug"], "owner", f"Ping {person(self.uid['wm'], 'WM')} and {person(self.uid['wa'], 'WA')}")
        await self.db["documents"].update_one({"_id": p["_id"]}, {"$set": {"content": f"Ping {person(self.uid['wa'], 'WA')}"}})
        self.assertEqual(await self.flush(), {"withdrawn": 1, "sent": 1})
        self.assertEqual([m["to"] for m in self.sent], [[self.email["wa"]]])
        self.assertEqual((await self.notes("wm"))[0]["email"], "withdrawn")

    async def test_quiet_writes_still_withdraw(self):
        p = await self.page()
        await self.save(p["slug"], "owner", f"Ping {person(self.uid['wm'], 'WM')}")
        before = await self.db["documents"].find_one({"_id": p["_id"]})
        after = {**before, "content": "Ping nobody"}
        with notifications.quiet():
            self.assertEqual(await notifications.on_page_saved(self.db, before, after, None), 0)
        self.assertEqual(await self.notes("wm"), [])

    def test_removed_mentions(self):
        wm, wa = self.uid["wm"], self.uid["wa"]
        a, b = f"A {person(wm, 'WM')} {{#b-aaaa01}}", f"B {person(wm, 'WM')} {{#b-aaaa02}}"
        rm = notifications.removed_mentions
        self.assertEqual(rm(a + "\n\n" + b, b), [{"kind": "mention", "user": wm, "block": "b-aaaa01", "gone": False}])
        self.assertEqual(rm(a, "nothing"), [{"kind": "mention", "user": wm, "block": "b-aaaa01", "gone": True}])
        self.assertEqual(rm(a, "Intro\n\n" + a), [])                       # moved
        self.assertEqual(rm(f"A {person(wm, 'WM')}", a), [])                # got an anchor
        self.assertEqual(rm(a, a + f" {person(wa, 'WA')}"), [])             # added, not removed
        self.assertEqual(rm(None, a), [])


class Share(NotifyWorld):
    async def test_notify_people_emails_and_notifies_with_the_message(self):
        p = await self.page("P")
        r = await self.http.post(f"/api/v1/documents/{p['slug']}/access/people",
                                 json={"email": self.email["stranger"], "role": "viewer", "notify": True,
                                       "message": "Please review section 2"}, headers=self.session("owner"))
        self.assertEqual(r.status_code, 201, r.text)
        self.assertTrue(r.json()["notified"])
        self.assertEqual(len(self.sent), 1)
        self.assertIn("Please review section 2", self.sent[0]["html"])
        self.assertIn("shared a page with you", self.sent[0]["html"])
        rows = await self.notes("stranger")
        self.assertEqual([(x["kind"], x["extra"]["message"], x["email"]) for x in rows],
                         [("shared", "Please review section 2", "off")])  # its email already went
        item = (await self.listing("stranger"))["items"][0]
        self.assertEqual((item["text"], item["message"]), (f"OWNER shared “{p['title']}” with you", "Please review section 2"))

    async def test_without_notify_nobody_is_told(self):
        p = await self.page("P")
        r = await self.http.post(f"/api/v1/documents/{p['slug']}/access/people",
                                 json={"email": self.email["stranger"], "notify": False}, headers=self.session("owner"))
        self.assertFalse(r.json()["notified"])
        self.assertEqual((self.sent, await self.notes("stranger")), ([], []))

    async def test_an_address_without_an_account_gets_the_email_only(self):
        p = await self.page("P")
        r = await self.http.post(f"/api/v1/documents/{p['slug']}/access/people",
                                 json={"email": "new@example.org"}, headers=self.session("owner"))
        self.assertTrue(r.json()["notified"])
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(await self.db[N].count_documents({}), 0)


# ── MCP ───────────────────────────────────────────────────────────────────────


class Mcp(NotifyWorld):
    async def test_mcp_page_writes_notify_with_the_mcp_user_as_author(self):
        p = await self.page()
        await self.mcp("wa", "append_blocks", {"document": p["slug"], "markdown": f"Over to {person(self.uid['wm'], 'WM')}"})
        rows = await self.notes("wm")
        self.assertEqual([(r["actor_id"], r["via"]) for r in rows], [(self.uid["wa"], "mcp")])
        raw = await self.doc(p["slug"])
        await self.mcp("wa", "update_page", {"document": p["slug"], "base_rev": raw["rev"],
                                             "markdown": raw["content"] + "\n\n" + person(self.uid["wv"], "WV")})
        self.assertEqual(len(await self.notes("wv")), 1)
        self.assertEqual(len(await self.notes("wm")), 1)  # still there: not new
        self.assertEqual(await self.notes("wa"), [])
        out = await self.mcp("wa", "create_page", {"title": "Kickoff", "workspace": self.ws["W1"],
                                                   "content": f"# Kickoff\n\n{person(self.uid['wo'], 'WO')} hosts"})
        self.assertEqual(len(await self.notes("wo")), 1)
        self.assertTrue(out["slug"])
        self.assertTrue((await self.listing("wm"))["items"][0]["via_ai"])

    async def test_list_and_mark_notifications(self):
        p = await self.page()
        await self.save(p["slug"], "owner", f"{person(self.uid['wm'], 'WM')} please {{#b-mcp001}}")
        out = await self.mcp("wm", "list_notifications", {}, write=False)  # a read-only token can list
        self.assertEqual(out["unread_count"], 1)
        n = out["notifications"][0]
        self.assertEqual((n["kind"], n["actor"], n["block"], n["page"]["slug"]), ("mention", "OWNER", "b-mcp001", p["slug"]))
        self.assertTrue(n["url"].endswith(f"/{p['slug']}#b-mcp001"))
        status, _ = await self.mcp_call(await self.mcp_token("wm", write=False), "mark_notifications_read", {"all": True})
        self.assertEqual(status, 403)  # marking needs documents:write
        status, res = await self.mcp_call(await self.mcp_token("wm"), "mark_notifications_read", {})
        self.assertTrue(res["isError"])
        out = await self.mcp("wm", "mark_notifications_read", {"ids": [n["id"]]})
        self.assertEqual(out, {"marked": 1, "unread_count": 0})
        out = await self.mcp("wm", "list_notifications", {"unread_only": True})
        self.assertEqual(out["notifications"], [])
        # Someone else's ids do nothing.
        self.assertEqual((await self.mcp("wa", "mark_notifications_read", {"ids": [n["id"]]}))["marked"], 0)

    async def test_share_with_people(self):
        p = await self.page("P")
        out = await self.mcp("owner", "share_with_people", {
            "document": p["slug"], "emails": [self.email["stranger"], self.email["gv"], self.email["owner"]],
            "role": "editor", "message": "Your review, please"})
        people = {x["email"]: x for x in out["people"]}
        self.assertEqual((people[self.email["stranger"]]["added"], people[self.email["stranger"]]["notified"],
                          people[self.email["stranger"]]["role"]), (True, True, "editor"))
        self.assertIsNotNone(people[self.email["owner"]]["error"])  # the owner
        self.assertEqual(len(self.sent), 2)  # stranger + gv's role went up (owner changed it)
        self.assertEqual([x["kind"] for x in await self.notes("stranger")], ["shared"])
        # A member who can't share a private page is refused; a read-only token can't.
        status, res = await self.mcp_call(await self.mcp_token("owner", write=False), "share_with_people",
                                          {"document": p["slug"], "emails": ["x@example.org"]})
        self.assertEqual(status, 403)
        status, res = await self.mcp_call(await self.mcp_token("stranger"), "share_with_people",
                                          {"document": p["slug"], "emails": ["x@example.org"], "notify": False,
                                           "message": "hi"})
        self.assertTrue(res["isError"])
        out = await self.mcp("owner", "share_with_people", {"document": p["slug"], "emails": ["quiet@example.org"],
                                                            "notify": False})
        self.assertEqual((out["people"][0]["added"], out["people"][0]["notified"]), (True, False))
        self.assertEqual(len(self.sent), 2)
