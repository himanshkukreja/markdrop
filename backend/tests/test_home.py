"""The signed-in home (services/home.py, routers/home.py; .work/home/SPEC.md).

Access first: the home lists only to-dos in pages the caller can read now (never another person's
private page, never encrypted or password-protected pages), only meetings decided readable on their
page (a restricted meeting stays invisible to members it wasn't shared with), only the caller's own
workspaces, and a tick changes a page only for someone who may edit it, on a to-do that mentions
them. Previews of items anywhere answer "locked" for what the caller can't open. No AI is called.
"""

from __future__ import annotations

from tests.test_ask_markdrop import AskWorld, now  # noqa: F401  (pins settings first)

from app.services import home as home_service


def todo(uid: str, name: str, text: str, block: str, done: bool = False) -> str:
    return f'- [{"x" if done else " "}] :person[{name}]{{id="{uid}"}} {text} {{#{block}}}'


class HomeWorld(AskWorld):
    async def home(self, who: str) -> dict:
        r = await self.http.get("/api/v1/home", headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def tick(self, who: str, slug: str, block: str):
        return await self.http.post("/api/v1/home/actions/tick", headers=self.session(who),
                                    json={"slug": slug, "block": block})


class Actions(HomeWorld):
    async def test_lists_only_readable_todos_that_mention_you(self):
        wm = self.uid["wm"]
        await self.put("launch", "Launch prep", "# Launch prep\n\n" + "\n".join([
            todo(wm, "Bo", "Order the banners :date[2026-11-09]", "b-aaaa1111"),
            todo(wm, "Bo", "Already done", "b-aaaa2222", done=True),
            todo(self.uid["wv"], "Ravi", "Someone else's", "b-aaaa3333"),
            "```", todo(wm, "Bo", "In a code fence", "b-aaaa4444"), "```",
        ]), editor="blocks")
        await self.put("secret", "Private elsewhere", todo(wm, "Bo", "kiwi-9 secret", "b-bbbb1111"),
                       owner="wm2", state="P", ws="W2", editor="blocks")
        await self.put("e2e", "Encrypted", todo(wm, "Bo", "cipher task", "b-cccc1111"), editor="blocks", encrypted=True)
        await self.put("pw", "Password", todo(wm, "Bo", "password task", "b-dddd1111"), state="LP", editor="blocks")
        await self.put("trashed", "Trashed", todo(wm, "Bo", "trashed task", "b-eeee1111"), editor="blocks",
                       deleted_at=now())
        self.fake.calls.clear()
        h = await self.home("wm")
        texts = [a["text"] for a in h["actions"]["items"]]
        self.assertEqual(texts, ["Order the banners 2026-11-09"])
        a = h["actions"]["items"][0]
        self.assertEqual((a["slug"], a["block"], a["title"]), ("launch", "b-aaaa1111", "Launch prep"))
        self.assertEqual(a["url"], "/launch#b-aaaa1111")
        self.assertTrue(a["can_tick"])
        self.assertEqual(a["workspace"]["name"], "Acme")
        self.assertEqual(self.fake.calls, [])                      # no AI anywhere on the home
        # A viewer sees their to-do but can't tick it.
        h = await self.home("wv")
        self.assertEqual([(x["text"], x["can_tick"]) for x in h["actions"]["items"]], [("Someone else's", False)])

    async def test_meeting_action_items(self):
        m = await self.import_meeting()
        h = await self.home("wv")
        mine = [a for a in h["actions"]["items"] if a["slug"] == m["slug"]]
        self.assertTrue(mine)
        self.assertTrue(all(a["meeting"] for a in mine))
        self.assertIn("Email the Senseloaf team", " ".join(a["text"] for a in mine))
        for a in mine:                                      # no transcript citations, a capital first letter
            self.assertNotRegex(a["text"], r"#\d|b-t\d|\]\(")
            self.assertEqual(a["text"][:1], a["text"][:1].upper())


class Tick(HomeWorld):
    async def test_tick_flips_one_line_as_you(self):
        wm, wv = self.uid["wm"], self.uid["wv"]
        content = "# Plan\n\n" + "\n".join([todo(wm, "Bo", "First", "b-t1t1t1t1"), todo(wm, "Bo", "Second", "b-t2t2t2t2"),
                                            todo(wv, "Ravi", "Ravi's", "b-t3t3t3t3")])
        await self.put("plan", "Plan", content, editor="blocks")
        r = await self.tick("wm", "plan", "b-t2t2t2t2")
        self.assertEqual(r.status_code, 200, r.text)
        doc = await self.doc("plan")
        self.assertIn(todo(wm, "Bo", "First", "b-t1t1t1t1"), doc["content"])
        self.assertIn(todo(wm, "Bo", "Second", "b-t2t2t2t2", done=True), doc["content"])
        self.assertEqual(doc["rev"], 2)                              # the normal save path
        self.assertEqual((await self.tick("wm", "plan", "b-t2t2t2t2")).status_code, 409)
        h = await self.home("wm")
        self.assertEqual([a["text"] for a in h["actions"]["items"]], ["First"])
        # Not yours: refused, page untouched.
        self.assertEqual((await self.tick("wm", "plan", "b-t3t3t3t3")).status_code, 403)
        # A viewer can't edit: refused.
        self.assertEqual((await self.tick("wv", "plan", "b-t3t3t3t3")).status_code, 403)
        # Unknown block, unknown page.
        self.assertEqual((await self.tick("wm", "plan", "b-nope0000")).status_code, 404)
        self.assertEqual((await self.tick("wm", "no-such-page", "b-t1t1t1t1")).status_code, 404)
        self.assertEqual((await self.doc("plan"))["rev"], 2)

    async def test_unreadable_page_is_404(self):
        wm = self.uid["wm"]
        await self.put("theirs", "Theirs", todo(wm, "Bo", "x", "b-p1p1p1p1"), owner="wm2", state="P", ws="W2",
                       editor="blocks")
        r = await self.tick("wm", "theirs", "b-p1p1p1p1")
        self.assertEqual(r.status_code, 404)
        self.assertEqual((await self.doc("theirs"))["content"], todo(wm, "Bo", "x", "b-p1p1p1p1"))

    async def test_bad_block_is_422(self):
        r = await self.tick("wm", "plan", "not-a-block")
        self.assertEqual(r.status_code, 422)


class Meetings(HomeWorld):
    async def test_meetings_across_workspaces_respect_restriction(self):
        open_m = await self.import_meeting()
        restricted = await self.import_meeting(sources=[{"name": "Board call.txt", "text": "Ada: hush.\nBo: ok."}],
                                               title="Board call", restricted=True)
        # Ada and Bo were there; Priya (an admin who wasn't) and Ravi weren't.
        for who in ("wa", "wv"):
            h = await self.home(who)
            ids = [m["id"] for m in h["meetings"]["items"]]
            self.assertIn(open_m["id"], ids, who)
            self.assertNotIn(restricted["id"], ids, who)
            self.assertNotIn("Board call", str(h), who)
            mine = next(m for m in h["meetings"]["items"] if m["id"] == open_m["id"])
            self.assertEqual(mine["workspace_name"], "Acme")
            self.assertIn("slug", mine)
        self.assertIn(restricted["id"], [m["id"] for m in (await self.home("wm"))["meetings"]["items"]])
        # The importer sees both; someone outside the workspace sees none.
        self.assertIn(restricted["id"], [m["id"] for m in (await self.home("owner"))["meetings"]["items"]])
        self.assertEqual((await self.home("stranger"))["meetings"]["items"], [])


class Workspaces(HomeWorld):
    async def test_only_yours_with_counts_and_people(self):
        await self.put("one", "One", "x")
        await self.put("priv", "Private of Ada", "x", state="P")          # owner's private: not counted for wm
        h = await self.home("wm")
        names = sorted(w["name"] for w in h["workspaces"])
        self.assertEqual(names, ["Acme", "Acme Private"])
        acme = next(w for w in h["workspaces"] if w["name"] == "Acme")
        self.assertEqual(acme["role"], "member")
        self.assertTrue(acme["can_import"])
        self.assertEqual(acme["item_count"], 1)
        self.assertEqual(acme["member_count"], 6)
        self.assertLessEqual(len(acme["people"]), home_service.PEOPLE_SHOWN)
        self.assertEqual(acme["people"][0]["name"], "WO")                  # the owner first
        self.assertEqual((await self.home("stranger"))["workspaces"], [])
        viewer = next(w for w in (await self.home("wv"))["workspaces"] if w["name"] == "Acme")
        self.assertFalse(viewer["can_import"])


class Attention(HomeWorld):
    async def test_unread_mentions(self):
        from app.services import notifications

        raw = await self.put("ping", "Ping page", "hello", editor="blocks")
        await notifications.notify(self.db, self.uid["wm"], "mention", raw, "b-zzzz0000", self.uid["owner"])
        h = await self.home("wm")
        self.assertEqual(h["attention"]["unread"], 1)
        self.assertEqual(h["attention"]["notifications"][0]["page"]["slug"], "ping")
        self.assertEqual((await self.home("wv"))["attention"]["notifications"], [])


class Previews(HomeWorld):
    async def test_previews_anywhere_but_locked_when_unreadable(self):
        await self.put("mine-doc", "Mine", "# Hello\n\nWorld", state="UP")
        await self.put("their-doc", "Theirs", "# Secret\n\nmoth", owner="wm2", state="P", ws="W2")
        r = await self.http.post("/api/v1/me/previews", headers=self.session("owner"),
                                 json={"slugs": ["mine-doc", "their-doc", "nope"]})
        self.assertEqual(r.status_code, 200, r.text)
        p = r.json()["previews"]
        self.assertEqual(p["mine-doc"]["state"], "ok")
        self.assertEqual(p["their-doc"]["state"], "locked")
        self.assertEqual(p["nope"]["state"], "locked")
        self.assertNotIn("moth", r.text)


class Tenant(HomeWorld):
    async def test_not_on_a_workspace_domain(self):
        r = await self.http.get("/api/v1/home", headers=self.tenant("wm", "W1"))
        self.assertIn(r.status_code, (401, 403))


if __name__ == "__main__":
    import unittest

    unittest.main()

