"""Who a page's editor can @-mention: GET /api/v1/documents/{slug}/mentionable (2026-11-04).

The page editor's `@` and "/person" picker reads it once per editor. It lists the members of the
page's workspace for someone who can edit the page; addresses only for a signed-in member on
markdrop.in, never through a workspace domain's session (as /auth/me), and never for an edit-link
editor with no account. On the workspace's own domain it is pinned like every allowed route: a
token of that domain, from that Origin, for that workspace's pages only.
"""

from __future__ import annotations

from tests._access_env import ES_SECRET, HOSTS, AccessWorld  # noqa: F401  (pins settings first)

from app.limiter import limiter
from app.utils.auth import create_tenant_token


class Mentionable(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        limiter.enabled = False
        self.addCleanup(setattr, limiter, "enabled", True)
        self.W = await self.mkdoc("W", editor="blocks")            # W1, workspace-visible
        self.X = await self.mkdoc("W", ws="W2", owner="wm2")      # W2
        self.U = await self.mkdoc("UL", owner="wm")               # wm's own, in no workspace

    async def get(self, doc: dict | str, headers: dict):
        slug = doc if isinstance(doc, str) else doc["slug"]
        return await self.http.get(f"/api/v1/documents/{slug}/mentionable", headers=headers)

    async def test_a_member_gets_everyone_with_addresses(self):
        r = await self.get(self.W, self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["state"], "ok")
        ids = {p["id"] for p in body["people"]}
        # The workspace's members (its owner, admin, members, viewers): nobody else.
        for who in ("wo", "wa", "wm", "wv", "owner", "ownv"):
            self.assertIn(self.uid[who], ids, who)
        for who in ("stranger", "gv", "ge", "wm2", "invitee"):
            self.assertNotIn(self.uid[who], ids, who)
        by = {p["id"]: p for p in body["people"]}
        self.assertEqual(by[self.uid["wa"]]["email"], self.email["wa"])
        self.assertTrue(by[self.uid["wm"]]["you"])
        self.assertFalse(by[self.uid["wa"]]["you"])
        names = [p["name"] for p in body["people"]]
        self.assertEqual(names, sorted(names, key=str.casefold))

    async def test_the_owner_and_an_admin_too(self):
        for who in ("owner", "wa", "wo"):
            r = await self.get(self.W, self.session(who))
            self.assertEqual((r.status_code, r.json()["state"]), (200, "ok"), who)
            self.assertGreaterEqual(len(r.json()["people"]), 6)

    async def test_readers_and_strangers_get_nothing(self):
        for who, code in (("wv", 403), ("gv", 403), ("ownv", 403), ("stranger", 404)):
            r = await self.get(self.W, self.session(who))
            self.assertEqual(r.status_code, code, (who, r.text))
            self.assertNotIn("@example.com", r.text)
        r = await self.get(self.W, {})
        self.assertIn(r.status_code, (401, 404))
        self.assertNotIn("@example.com", r.text)

    async def test_an_editor_who_isnt_a_member_gets_no_list(self):
        # ge edits the page through a grant but isn't in W1.
        r = await self.get(self.W, self.session("ge"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"state": "not_member", "people": []})

    async def test_an_edit_link_editor_with_no_account_gets_no_list(self):
        r = await self.get(self.W, {"X-Edit-Secret": ES_SECRET})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"state": "signin", "people": []})
        # A wrong secret is no editor at all.
        r = await self.get(self.W, {"X-Edit-Secret": "nope"})
        self.assertIn(r.status_code, (401, 403, 404))
        self.assertNotIn("@example.com", r.text)

    async def test_a_personal_page_has_no_one_to_mention(self):
        r = await self.get(self.U, self.session("wm"))
        self.assertEqual((r.status_code, r.json()), (200, {"state": "personal", "people": []}))

    async def test_on_the_workspace_domain_names_only(self):
        r = await self.get(self.W, self.tenant("wm", "W1"))
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["state"], "ok")
        self.assertIn(self.uid["wa"], {p["id"] for p in body["people"]})
        self.assertTrue(all(p["email"] is None for p in body["people"]))
        self.assertNotIn("@example.com", r.text)
        # A reader on the domain: no.
        self.assertEqual((await self.get(self.W, self.tenant("wv", "W1"))).status_code, 403)

    async def test_the_domain_session_is_pinned(self):
        # Another workspace's page through W1's domain: the same 404 as a missing page.
        r = await self.get(self.X, self.tenant("wm", "W1"))
        missing = await self.get("no-such-page", self.tenant("wm", "W1"))
        self.assertEqual((r.status_code, r.content), (missing.status_code, missing.content))
        self.assertEqual(r.status_code, 404)
        # A personal page through the domain: 404 too.
        self.assertEqual((await self.get(self.U, self.tenant("wm", "W1"))).status_code, 404)
        # The wrong Origin, or none: refused.
        for h in (self.tenant("wm", "W1", origin="https://evil.test"),
                  self.tenant("wm", "W1", origin="https://markdrop.in")):
            self.assertEqual((await self.get(self.W, h)).status_code, 401, h.get("Origin"))
        token, _ = create_tenant_token(self.uid["wm"], self.email["wm"], self.ws["W1"], HOSTS["W1"])
        self.assertEqual((await self.get(self.W, {"Authorization": f"Bearer {token}"})).status_code, 401)
        # A dead domain takes its tokens with it.
        await self.db["domains"].update_one({"host": HOSTS["W1"]}, {"$set": {"status": "lapsed"}})
        self.assertEqual((await self.get(self.W, self.tenant("wm", "W1"))).status_code, 401)

    async def test_an_account_that_is_gone_isnt_listed(self):
        await self.db["users"].delete_one({"email": self.email["wa"]})
        r = await self.get(self.W, self.session("wm"))
        self.assertNotIn(self.uid["wa"], {p["id"] for p in r.json()["people"]})

    async def test_only_https_avatars(self):
        from bson import ObjectId

        await self.db["users"].update_one({"_id": ObjectId(self.uid["wa"])}, {"$set": {"picture": "https://img.test/a.png"}})
        await self.db["users"].update_one({"_id": ObjectId(self.uid["wo"])}, {"$set": {"picture": "javascript:alert(1)"}})
        by = {p["id"]: p for p in (await self.get(self.W, self.session("wm"))).json()["people"]}
        self.assertEqual(by[self.uid["wa"]]["avatar_url"], "https://img.test/a.png")
        self.assertIsNone(by[self.uid["wo"]]["avatar_url"])
