"""Review comments on Guides pages (routers/docs_site_editor.py, services/docs_page_comments.py):
who sees and writes them, anchoring fields and the page rev, replies, resolve and reopen,
delete (author or admin), the per-page and per-comment caps and the open-count summary."""

from __future__ import annotations

from unittest import mock

from bson import ObjectId

from tests._docs_sites_env import DocsSitesCase

from app.services import docs_page_comments


class Comments(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.site = await self.create("acme")
        self.sid = self.site["id"]
        self.page = await self.home(self.sid)
        self.base = f"/{self.sid}/pages/{self.page['id']}/comments"

    async def comment(self, who="editor", expect=201, **body) -> dict:
        body.setdefault("quote", "Welcome")
        body.setdefault("body", "Say hello instead?")
        return await self.call("POST", self.base, who, expect, json=body)

    async def test_add_list_and_who_can(self):
        c = await self.comment(prefix="# ", suffix=" to the docs", body="  Say hello instead?  ")
        self.assertEqual({k: c[k] for k in ("page_id", "rev", "quote", "prefix", "suffix", "body", "by", "by_name",
                                            "replies", "resolved", "resolved_by", "resolved_by_name", "resolved_at",
                                            "can_delete")},
                         {"page_id": self.page["id"], "rev": self.page["rev"], "quote": "Welcome", "prefix": "# ",
                          "suffix": " to the docs", "body": "Say hello instead?", "by": self.uid["editor"],
                          "by_name": "Editor", "replies": [], "resolved": False, "resolved_by": None,
                          "resolved_by_name": None, "resolved_at": None, "can_delete": True})
        self.assertTrue(c["id"] and c["at"])
        await self.comment("viewer", 403)
        await self.comment("stranger", 404)
        await self.get(self.base, "viewer", 403)
        await self.get(f"/{self.sid}/comments/summary", "viewer", 403)
        await self.grant("viewer", "reviewer")
        await self.comment("viewer", body="From a reviewer")
        listing = await self.get(self.base, "admin")
        self.assertEqual(listing["open"], 2)
        self.assertEqual([x["body"] for x in listing["comments"]], ["Say hello instead?", "From a reviewer"])
        self.assertEqual([x["can_delete"] for x in listing["comments"]], [True, True])  # an admin may delete any
        mine = await self.get(self.base, "editor")
        self.assertEqual([x["can_delete"] for x in mine["comments"]], [True, False])

    async def test_input_checks_and_page_scope(self):
        for body in ({"quote": "", "body": "x"}, {"quote": "q" * 501, "body": "x"}, {"quote": "q", "body": ""},
                     {"quote": "q", "body": "b" * 4001}, {"quote": "q", "body": "x", "prefix": "p" * 121},
                     {"quote": "q", "body": "x", "suffix": "s" * 121}, {"quote": "q", "body": "x", "extra": 1}):
            await self.call("POST", self.base, "editor", 422, json=body)
        await self.call("POST", self.base, "editor", 422, json={"quote": "q", "body": "   "})
        await self.call("POST", self.base, "editor", 422, json={"quote": "   ", "body": "x"})
        await self.get(f"/{self.sid}/pages/{ObjectId()}/comments", expect=404)
        # A page of another guide isn't reachable through this one.
        other = await self.create("other")
        other_home = await self.home(other["id"])
        await self.get(f"/{self.sid}/pages/{other_home['id']}/comments", expect=404)
        c = await self.comment()
        await self.call("POST", f"/{other['id']}/pages/{other_home['id']}/comments/{c['id']}/replies",
                        expect=404, json={"body": "x"})
        await self.call("POST", f"{self.base}/nope/replies", expect=404, json={"body": "x"})

    async def test_rev_is_the_draft_rev_at_the_time(self):
        first = await self.comment()
        saved = await self.call("PUT", f"/{self.sid}/pages/{self.page['id']}", "editor",
                                json={"base_rev": self.page["rev"], "markdown": "# Welcome back\n"})
        second = await self.comment(quote="Welcome back")
        self.assertEqual((first["rev"], second["rev"]), (self.page["rev"], saved["rev"]))
        self.assertEqual(saved["rev"], self.page["rev"] + 1)

    async def test_replies_and_resolve(self):
        c = await self.comment()
        r = await self.call("POST", f"{self.base}/{c['id']}/replies", "admin", json={"body": "Agreed."})
        self.assertEqual([(x["body"], x["by"], x["by_name"]) for x in r["replies"]],
                         [("Agreed.", self.uid["admin"], "Admin")])
        self.assertTrue(r["replies"][0]["id"] and r["replies"][0]["at"])
        await self.call("POST", f"{self.base}/{c['id']}/replies", "viewer", 403, json={"body": "x"})
        await self.call("POST", f"{self.base}/{c['id']}/replies", "editor", 422, json={"body": " "})

        done = await self.call("POST", f"{self.base}/{c['id']}/resolve", "admin", json={"resolved": True})
        self.assertEqual((done["resolved"], done["resolved_by"], done["resolved_by_name"]),
                         (True, self.uid["admin"], "Admin"))
        self.assertIsNotNone(done["resolved_at"])
        # Resolving again keeps who did it first.
        again = await self.call("POST", f"{self.base}/{c['id']}/resolve", "editor", json={"resolved": True})
        self.assertEqual(again["resolved_by"], self.uid["admin"])
        self.assertEqual((await self.get(self.base))["open"], 0)
        self.assertEqual(await self.get(f"/{self.sid}/comments/summary"), {"pages": {}})
        reopened = await self.call("POST", f"{self.base}/{c['id']}/resolve", "editor", json={"resolved": False})
        self.assertEqual((reopened["resolved"], reopened["resolved_by"], reopened["resolved_at"]), (False, None, None))
        self.assertEqual((await self.get(self.base))["open"], 1)

    async def test_delete(self):
        c = await self.comment()
        await self.call("DELETE", f"{self.base}/{c['id']}", "viewer", 403)
        await self.grant("viewer", "editor")
        await self.call("DELETE", f"{self.base}/{c['id']}", "viewer", 403)  # not theirs
        self.assertEqual(await self.call("DELETE", f"{self.base}/{c['id']}", "editor"), {"deleted": True})
        await self.call("DELETE", f"{self.base}/{c['id']}", "editor", 404)
        d = await self.comment()
        await self.call("DELETE", f"{self.base}/{d['id']}", "admin")  # an admin may delete anyone's
        self.assertEqual((await self.get(self.base))["comments"], [])

    async def test_caps(self):
        with mock.patch.object(docs_page_comments, "MAX_COMMENTS_PER_PAGE", 2), \
                mock.patch.object(docs_page_comments, "MAX_REPLIES", 2):
            c = await self.comment()
            await self.comment()
            r = await self.comment(expect=409)
            self.assertIn("at most 2 comments", r["detail"])
            for _ in range(2):
                await self.call("POST", f"{self.base}/{c['id']}/replies", json={"body": "x"})
            r = await self.call("POST", f"{self.base}/{c['id']}/replies", expect=409, json={"body": "x"})
            self.assertIn("at most 2 replies", r["detail"])

    async def test_summary_counts_open_per_live_page(self):
        p2 = await self.call("POST", f"/{self.sid}/pages", "editor", 201, json={"path": "/two", "title": "Two"})
        p3 = await self.call("POST", f"/{self.sid}/pages", "editor", 201, json={"path": "/three", "title": "Three"})
        await self.comment()
        await self.comment()
        await self.call("POST", f"/{self.sid}/pages/{p2['id']}/comments", json={"quote": "q", "body": "b"}, expect=201)
        resolved = await self.call("POST", f"/{self.sid}/pages/{p3['id']}/comments", json={"quote": "q", "body": "b"},
                                   expect=201)
        await self.call("POST", f"/{self.sid}/pages/{p3['id']}/comments/{resolved['id']}/resolve",
                        json={"resolved": True})
        self.assertEqual(await self.get(f"/{self.sid}/comments/summary", "editor"),
                         {"pages": {self.page["id"]: 2, p2["id"]: 1}})
        await self.call("DELETE", f"/{self.sid}/pages/{p2['id']}", "editor")
        self.assertEqual(await self.get(f"/{self.sid}/comments/summary"), {"pages": {self.page["id"]: 2}})
        # A deleted page's comments can't be reached either.
        await self.get(f"/{self.sid}/pages/{p2['id']}/comments", expect=404)
