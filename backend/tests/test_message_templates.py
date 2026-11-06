"""Every email and Slack message, as the message gallery builds them (pure; no database, nothing sent).

Snapshot-style checks on structure rather than exact markup: the parts every email must have, the
size Gmail clips at, the plain-text part, absolute links, escaping of user text (XSS), and Slack's
limits, text fallbacks and buttons.
"""

from __future__ import annotations

import json
import re
import unittest

from tests import _email_env  # noqa: F401  (settings first)

from app.services import email_kit as K
from app.services import mailer, message_gallery as g, notifications as n, slack_blocks as kit, team_extras

EVIL = '<script>alert(1)</script>"><img src=x onerror=alert(2)>'


def emails():
    return [e for e in g.ENTRIES if e.kind == "email"]


def slacks():
    return [e for e in g.ENTRIES if e.kind == "slack"]


class EveryEmail(unittest.TestCase):
    def test_parts_size_and_links(self):
        self.assertGreaterEqual(len(emails()), 20)
        for e in emails():
            with self.subTest(e.id):
                m = e.build()
                html, text = m["html"], m["text"]
                self.assertTrue(m["subject"] and "\n" not in m["subject"])
                self.assertTrue(html.startswith("<!DOCTYPE html>"))
                self.assertIn('name="color-scheme" content="light dark"', html)
                self.assertIn("prefers-color-scheme: dark", html)
                self.assertIn("max-width:600px", html)
                self.assertIn("@media (max-width: 480px)", html)
                self.assertIn("display:none;max-height:0", html)       # the preheader
                self.assertLessEqual(len(html.encode()), K.MAX_BYTES, "Gmail clips past 102 KB")
                self.assertNotIn("<script", html.lower())
                self.assertNotIn("<link ", html)                        # no external CSS
                for href in re.findall(r'href="([^"]*)"', html):
                    self.assertRegex(href, r"^(https?://|mailto:)", f"{e.id}: {href}")
                for img in re.findall(r"<img [^>]*>", html):
                    self.assertIn("alt=", img)
                # The plain-text part: the heading, the main action's URL, the footer.
                self.assertTrue(text and len(text) > 80)
                self.assertIn("Markdrop · ", text)
                self.assertNotIn("<", re.sub(r"<[^>]*@[^>]*>|<https?://[^>]*>", "", text).replace("<b>", ""))
                self.assertIn("markdrop", html)                          # the wordmark is text

    def test_senders(self):
        from unittest import mock

        st = mailer.settings
        with mock.patch.object(st, "email_from_login", "login@markdrop.in"), \
                mock.patch.object(st, "email_from_share", "notifications@markdrop.in"), \
                mock.patch.object(st, "email_from_welcome", "hello@markdrop.in"):
            for e in emails():
                with self.subTest(e.id):
                    frm = e.build()["from"]
                    if e.id in ("email-login", "email-guide-signin"):
                        self.assertIn("login@", frm)
                    elif e.id in ("email-welcome", "email-analytics-weekly"):
                        self.assertIn("hello@", frm)
                    else:
                        self.assertIn("notifications@", frm)

    def test_notification_footer_has_email_me_less_and_turn_off(self):
        for eid in ("email-mention", "email-hourly", "email-daily"):
            m = g.get(eid).build()
            self.assertIn("Email me less", m["html"])
            self.assertIn("Turn off these emails", m["html"])
            self.assertIn("Email me less: https://api.markdrop.in/api/v1/me/emails/less?t=", m["text"])

    def test_page_has_no_preheader(self):
        html = g.get("page-unsubscribed").build()["html"]
        self.assertIn('name="robots" content="noindex"', html)
        self.assertNotIn("display:none;max-height:0", html)


class Escaping(unittest.TestCase):
    """User-chosen text (names, titles, notes, workspace names) never becomes markup."""

    def check(self, html: str):
        self.assertNotIn("<script", html)
        self.assertNotIn("<img src=x", html)
        self.assertIn("&lt;script&gt;", html)

    def test_account_and_sharing_emails(self):
        b = "https://markdrop.in"
        for m in (
            mailer.compose_welcome(EVIL),
            mailer.compose_invite(EVIL, EVIL, "member", f"{b}/invite/x"),
            mailer.compose_share(document_title=EVIL, url=f"{b}/x", sharer_name=EVIL, role="viewer", encrypted=True, message=EVIL),
            mailer.compose_access_request(requester_name=EVIL, requester_email="a@b.c", document_title=EVIL, message=EVIL,
                                          request_id="r1", workspace_name=EVIL),
            mailer.compose_edit_request(requester_name=EVIL, requester_email="a@b.c", document_title=EVIL, message=EVIL,
                                        request_id="r1", as_admin=True, workspace_name=EVIL),
            mailer.compose_access_decision(owner_name=EVIL, document_title=EVIL, url=f"{b}/x", approved=True, role="viewer"),
            mailer.compose_guide_domain(host="docs.acme.com", guide_name=EVIL, live=False, settings_url=f"{b}/g", message=EVIL),
            mailer.compose_guide_signin(to="a@b.c", guide=EVIL, url=f"{b}/s"),
            mailer.compose_guide_access_request(guide=EVIL, email="a@b.c", rule_name=EVIL, note=EVIL, url=f"{b}/g"),
        ):
            self.check(m["html"])
            self.assertIn(EVIL[:20], m["text"])     # the text part keeps it as text

    def test_notification_and_team_emails(self):
        it = [{"kind": "mention", "actor": EVIL, "block": "b-1", "excerpt": EVIL, "label": None},
              {"kind": "signoff_requested", "actor": EVIL, "block": None, "excerpt": None, "label": EVIL}]
        self.check(n.compose_email(user_id=g.UID, title=EVIL, page_url="https://markdrop.in/x", items=it)["html"])
        self.check(n.compose_digest(user_id=g.UID, pages=[{"title": EVIL, "url": "https://markdrop.in/x", "items": it,
                                                           "more": 0}], mode="daily")["html"])
        s = g.weekly_summary()
        s["highlights"][0]["text"] = EVIL
        s["highlights"][0]["person"]["name"] = EVIL
        s["meetings"][0]["title"] = EVIL
        from app.services import workspace_memory as wm

        m = team_extras.compose_email(wm.WsInfo("w1", EVIL, True, True), s)
        self.check(m["html"])
        self.assertNotIn("\n", m["subject"])

    def test_legacy_helpers_keep_escaped_input_escaped(self):
        html = mailer._shell(title="&lt;t&gt;", content=mailer._p("&lt;b&gt;"), footer="", preheader="&lt;p&gt;")
        self.assertIn("<title>&lt;t&gt;</title>", html)
        self.assertNotIn("<b>", html.split("<body")[1].replace("<br>", ""))


class EverySlackMessage(unittest.TestCase):
    def walk(self, msg):
        for b in msg["blocks"]:
            yield b
            if b.get("accessory"):
                yield b["accessory"]
            yield from b.get("elements") or []

    def test_limits_and_fallbacks(self):
        self.assertGreaterEqual(len(slacks()), 15)
        for e in slacks():
            with self.subTest(e.id):
                msg = e.build()["message"]
                self.assertLessEqual(len(msg["blocks"]), 50)
                if "unfurl" not in e.id:   # an unfurl is an attachment to someone's message
                    self.assertTrue((msg.get("text") or "").strip(), "a text fallback for notifications")
                for b in self.walk(msg):
                    t = b.get("type")
                    if t == "section" and b.get("text"):
                        self.assertLessEqual(len(b["text"]["text"]), 3000)
                    if t == "header":
                        self.assertLessEqual(len(b["text"]["text"]), 150)
                    if t == "button":
                        self.assertLessEqual(len(b["text"]["text"]), 75)
                        self.assertTrue(b["action_id"].startswith("md_"))
                        self.assertTrue(b.get("url") or b.get("value"))
                    if t == "context":
                        self.assertLessEqual(len(b["elements"]), 10)
                # One primary button at most.
                self.assertLessEqual(sum(1 for b in self.walk(msg) if b.get("style") == "primary"), 1)
                # Our own words carry no emoji shortcodes.
                self.assertNotRegex(json.dumps(msg), r":(white_large_square|white_check_mark|clipboard|spiral_note_pad):")

    def test_meeting_post(self):
        msg = g.meeting_post()
        self.assertEqual(msg["blocks"][0], {"type": "header", "text": {"type": "plain_text", "text": "Daily Syncup", "emoji": False}})
        meta = msg["blocks"][1]["elements"][0]["text"]
        for part in ("Fri, Nov 7 · 10:00", "32 min", "6 people: Maya, Alex, Sam +3", "|Open notes>"):
            self.assertIn(part, meta)
        self.assertEqual(msg["text"], "Daily Syncup · Nov 7: 3 decisions, 5 action items")
        body = json.dumps(msg, ensure_ascii=False)
        self.assertIn("Read the full notes →", body)          # the long summary was cut
        self.assertIn("*Maya* confirmed", body)               # Markdown bold → Slack bold
        self.assertIn("<@U0MAYA> Update the onboarding docs before the release  ·  _due Tue, Nov 11_", body)
        self.assertIn("~Create read-only Postgres credentials for Jordan~", body)
        self.assertIn("done by Alex Chen", body)
        done = [b for b in msg["blocks"] if b.get("accessory", {}).get("action_id") == "md_done"]
        self.assertEqual(len(done), 4)                         # open items only
        self.assertIn("*Action items*  ·  4 open  ·  1 done", body)

    def test_meeting_post_groups_and_caps(self):
        items = g._meeting_post_busy()["message"]   # 8 open items: all shown
        self.assertFalse(any("more in the notes" in json.dumps(b) for b in items["blocks"]))
        many = [dict(i) for i in g.MEETING_ITEMS] * 2
        for k, i in enumerate(many):
            i["block"] = f"b-{k:08d}"
        msg = g.meeting_post(many)
        rows = [b for b in msg["blocks"] if b.get("accessory", {}).get("action_id") == "md_done"]
        self.assertEqual(len(rows), kit.MAX_ITEMS)
        ctx = [b["elements"][0]["text"] for b in msg["blocks"] if b["type"] == "context"]
        self.assertIn("<@U0MAYA> · 4 items", ctx)            # three or more: under their name
        self.assertIn("<@U0MAYA> · 3 items", json.dumps(items, ensure_ascii=False))
        self.assertTrue(any(c.startswith("+2 more in the notes") for c in ctx), ctx)

    def test_a_post_saved_before_the_redesign_still_renders(self):
        msg = kit.meeting_post("T1", "p1", title="Sync", url="https://markdrop.in/s", when="Fri Nov 7, 2026 · 10:00",
                               summary="Short.", decisions=["A"], items=[
                                   {"block": "b-1", "text": "<@U1> Do it", "done_by": None},
                                   {"block": "b-2", "text": "*Bo* Done thing", "done_by": "Markdrop"}])
        body = json.dumps(msg)
        self.assertIn("<@U1> Do it", body)
        self.assertIn("~*Bo* Done thing~", body)
        self.assertNotIn("done by Markdrop", body)

    def test_user_text_is_escaped(self):
        bad = "<!channel> <http://evil|click> & co"
        for msg in (kit.dm_mention(bad, bad, "https://markdrop.in/x", bad, where=bad),
                    kit.dm_shared(bad, bad, "https://markdrop.in/x", "viewer", bad, where=bad),
                    kit.dm_access_request("T", bad, "a@b.c", bad, "https://markdrop.in/r", "r1", False, bad, True),
                    kit.meeting_post("T", "p", title=bad, url="https://markdrop.in/m", when=bad, summary=bad,
                                     decisions=[bad], items=[], open_questions=[bad], people=[bad])):
            mrkdwn = json.dumps([x for x in re.findall(r'"type": "mrkdwn", "text": "((?:[^"\\\\]|\\\\.)*)"', json.dumps(msg))]
                                + [msg["text"]])
            self.assertNotIn("<!channel>", mrkdwn)
            self.assertNotIn("<http://evil", mrkdwn)
            self.assertIn("&lt;!channel&gt;", mrkdwn)

    def test_weekly_summary_post(self):
        from app.services import workspace_memory as wm

        blocks, text = team_extras.slack_blocks(wm.WsInfo("w1", "Senseloaf", True, True), g.weekly_summary())
        self.assertEqual(blocks[0]["text"]["text"], "This week in Senseloaf")
        self.assertTrue(text.startswith("This week in Senseloaf: 4 highlights"))
        body = json.dumps(blocks)
        for part in ("*Highlights*", "*Decisions*", "*Overdue*", "*Due this week*", "*Blocked*", "*Meetings this week*",
                     "4 days late", "waiting on Alex Chen"):
            self.assertIn(part, body)
        # One person's highlights together.
        hl = next(b["text"]["text"] for b in blocks if b.get("text", {}).get("text", "").startswith("*Highlights*"))
        names = re.findall(r"\*(Maya Patel|Alex Chen|Sam Lee)\*", hl)
        self.assertEqual(names[:2], ["Maya Patel", "Maya Patel"])

    def test_dm_footer_is_last(self):
        for e in ("slack-dm-mention", "slack-dm-shared", "slack-dm-signoff", "slack-dm-access-request"):
            foot = g.get(e).build()["message"]["blocks"][-1]
            self.assertEqual(foot["type"], "context")
            self.assertIn("You turned these on in Markdrop", foot["elements"][0]["text"])


class Gallery(unittest.TestCase):
    def test_every_entry_renders(self):
        ids = [e.id for e in g.ENTRIES]
        self.assertEqual(len(ids), len(set(ids)))
        for e in g.ENTRIES:
            with self.subTest(e.id):
                r = g.render(e)
                if e.kind == "slack":
                    self.assertIn("<!doctype html>", r["html_light"])
                    self.assertIn('class="dark"', r["html_dark"])
                else:
                    self.assertTrue(r["html"] and r["bytes"] > 0)


if __name__ == "__main__":
    unittest.main()
