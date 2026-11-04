"""The in-app workspace listing (fix/ws-listing): who owns each row, folder activity, and who may
see names.

* ``GET /workspaces/{id}/items`` rows carry ``owner {name, picture, is_you}``: the picture only
  when it's an https link; the owners come from ONE users query per page (no N+1).
* ``GET /workspaces/{id}/tree`` folders carry ``updated_at`` (the newest readable change in the
  subtree) and ``people`` (up to three owners of readable items, most recent first) with
  ``people_count``; nothing the caller can't read is counted or named.
* The privacy matrix (the presence rule, services/viewers.py): workspace members (any role) see
  names; an outsider, a grantee who isn't a member and an anonymous caller get no listing and no
  name. Personal lists drop the owner of a row read only through a public link.

Runs in the access-policy world (tests/_access_env.py): the test MongoDB (or mongomock). Never
backend/.env.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from unittest import mock

from bson import ObjectId

from tests.test_pages import PageWorld  # noqa: F401  (pins settings first)

from app.services import workspace_items

PIC = "https://lh3.googleusercontent.com/a/photo=s96"


def ago(days: float) -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=days)


class Listing(PageWorld):
    async def folder(self, name: str, parent: str | None = None) -> str:
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/folders",
                                 json={"name": name, "parent_id": parent}, headers=self.session("wo"))
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["id"]

    async def items(self, who: str | None, folder: str = "root", ws: str = "W1"):
        headers = self.session(who) if who else {}
        return await self.http.get(f"/api/v1/workspaces/{self.ws[ws]}/items?folder={folder}&limit=50",
                                   headers=headers)

    async def tree(self, who: str | None, ws: str = "W1"):
        headers = self.session(who) if who else {}
        return await self.http.get(f"/api/v1/workspaces/{self.ws[ws]}/tree", headers=headers)

    async def name(self, who: str, name: str, picture: str | None = None):
        await self.db["users"].update_one({"_id": ObjectId(self.uid[who])},
                                          {"$set": {"name": name, "picture": picture}})

    async def test_rows_carry_their_owner(self):
        await self.name("wm", "Mira Member", PIC)
        await self.name("wa", "Ash Admin", "http://insecure.example/p.png")  # not https: dropped
        f = await self.folder("Specs")
        mine = await self.mkdoc("W", owner="wm", folder_id=f)
        theirs = await self.mkdoc("W", owner="wa", folder_id=f)
        for who in ("wm", "wv", "wa", "wo"):
            r = await self.items(who, f)
            self.assertEqual(r.status_code, 200, r.text)
            rows = {i["slug"]: i for i in r.json()["items"]}
            self.assertEqual(rows[mine["slug"]]["owner"],
                             {"name": "Mira Member", "picture": PIC, "is_you": who == "wm"})
            self.assertEqual(rows[theirs["slug"]]["owner"],
                             {"name": "Ash Admin", "picture": None, "is_you": who == "wa"})

    async def test_owner_without_a_name_falls_back_to_the_address_name(self):
        await self.db["users"].update_one({"_id": ObjectId(self.uid["wm"])}, {"$unset": {"name": 1}})
        d = await self.mkdoc("W", owner="wm")
        rows = {i["slug"]: i for i in (await self.items("wv")).json()["items"]}
        self.assertEqual(rows[d["slug"]]["owner"]["name"], "wm")

    async def test_one_users_query_per_page(self):
        for i in range(12):
            await self.mkdoc("W", owner=("wm", "wa", "wo")[i % 3])
        calls = []
        real = workspace_items.owner_cards

        async def counted(db, ids):
            calls.append(len(set(i for i in ids if i)))
            return await real(db, ids)

        with mock.patch.object(workspace_items, "owner_cards", counted):
            r = await self.items("wv")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0], 3)

    async def test_rows_never_load_the_body(self):
        d = await self.mkdoc("W", owner="wm")
        seen = []
        real = workspace_items.item_for

        async def spy(db, raw, *a, **k):
            seen.append("content" in raw)
            return await real(db, raw, *a, **k)

        with mock.patch.object(workspace_items, "item_for", spy):
            r = await self.items("wm")
        self.assertIn(d["slug"], [i["slug"] for i in r.json()["items"]])
        self.assertTrue(seen)
        self.assertFalse(any(seen))

    async def test_folder_activity_and_people(self):
        await self.name("wm", "Mira Member", PIC)
        await self.name("wa", "Ash Admin")
        await self.name("wo", "Owen Owner")
        top = await self.folder("Product")
        sub = await self.folder("Specs", top)
        empty = await self.folder("Empty")
        await self.mkdoc("W", owner="wa", folder_id=top, updated_at=ago(5))
        newest = ago(1)
        await self.mkdoc("W", owner="wm", folder_id=sub, updated_at=newest)
        await self.mkdoc("W", owner="wo", folder_id=sub, updated_at=ago(3))
        # Ash's private item, newer than everything: Mira can't read it, so it isn't counted.
        await self.mkdoc("P", owner="wa", folder_id=top, updated_at=ago(0.1), grants=False)

        out = (await self.tree("wm")).json()
        f = {x["id"]: x for x in out["folders"]}
        self.assertEqual([p["name"] for p in f[top]["people"]], ["Mira Member", "Owen Owner", "Ash Admin"])
        self.assertEqual(f[top]["people"][0], {"name": "Mira Member", "picture": PIC, "is_you": True})
        self.assertEqual(f[top]["people_count"], 3)
        self.assertEqual(f[top]["total_count"], 3)
        stamp = datetime.fromisoformat(f[top]["updated_at"]).replace(tzinfo=timezone.utc)
        self.assertLess(abs((stamp - newest).total_seconds()), 2)
        self.assertEqual([p["name"] for p in f[sub]["people"]], ["Mira Member", "Owen Owner"])
        self.assertEqual(f[empty]["people"], [])
        self.assertEqual(f[empty]["people_count"], 0)
        self.assertIsNotNone(f[empty]["updated_at"])  # the folder's own time when it holds nothing

        # Ash reads their own private item: it counts for them, and is the newest change.
        f = {x["id"]: x for x in (await self.tree("wa")).json()["folders"]}
        self.assertEqual(f[top]["people"][0]["name"], "Ash Admin")
        self.assertTrue(f[top]["people"][0]["is_you"])
        self.assertEqual(f[top]["total_count"], 4)

    async def test_at_most_three_people(self):
        top = await self.folder("Busy")
        for i, who in enumerate(("wm", "wa", "wo", "owner")):
            await self.mkdoc("W", owner=who, folder_id=top, updated_at=ago(i + 1))
        f = {x["id"]: x for x in (await self.tree("wv")).json()["folders"]}[top]
        self.assertEqual(len(f["people"]), 3)
        self.assertEqual(f["people_count"], 4)

    async def test_privacy_matrix(self):
        await self.name("wm", "Mira Member", PIC)
        f = await self.folder("Product")
        d = await self.mkdoc("W", owner="wm", folder_id=f)  # granted to gv and ge too
        await self.mkdoc("L", owner="wm", folder_id=f)  # a public link item
        # Members, any role, see names.
        for who in ("wv", "wm", "wa", "wo", "owner", "ownv"):
            r = await self.items(who, f)
            self.assertEqual(r.status_code, 200, (who, r.text))
            self.assertIn("Mira Member", r.text)
            self.assertIn("Mira Member", (await self.tree(who)).text)
        # Outsiders get no listing and no name: a stranger, a grantee who isn't a member, a former
        # member, a member of another workspace, anonymous.
        for who in ("stranger", "gv", "ge", "former", "wm2", None):
            for r in (await self.items(who, f), await self.items(who, "root"), await self.tree(who),
                      await self.http.get(f"/api/v1/workspaces/{self.ws['W1']}/nav",
                                          headers=self.session(who) if who else {})):
                self.assertIn(r.status_code, (401, 403, 404), (who, r.status_code, r.text))
                self.assertNotIn("Mira", r.text)
                self.assertNotIn(PIC, r.text)
        # The custom-domain listing (anonymous visitors) carries no owner at all.
        r = await self.http.get(f"/api/v1/og/w/{self.ws['W1']}/f/{f}.json")
        self.assertNotIn("Mira", r.text)
        self.assertIn(d["slug"], (await self.items("wv", f)).text)

    async def test_personal_lists_name_owners_only_with_a_relationship(self):
        await self.name("wm", "Mira Member", PIC)
        public = await self.mkdoc("UL", owner="wm", grants=False)  # unfiled, anyone with the link
        shared = await self.mkdoc("UP", owner="wm")  # private, granted to gv
        # The stranger reads the public one (signed in): it lands in their Recent, without a name.
        r = await self.http.get(f"/api/v1/documents/{public['slug']}", headers=self.session("stranger"))
        self.assertEqual(r.status_code, 200, r.text)
        r = await self.http.get("/api/v1/me/recent", headers=self.session("stranger"))
        self.assertEqual(r.status_code, 200, r.text)
        rows = {i["slug"]: i for i in r.json()["items"]}
        self.assertIn(public["slug"], rows)
        self.assertEqual(rows[public["slug"]]["owner"], {"name": None, "picture": None, "is_you": False})
        self.assertNotIn("Mira", json.dumps(r.json()))
        # A grantee has a relationship: Shared with me names the owner.
        r = await self.http.get("/api/v1/me/shared", headers=self.session("gv"))
        self.assertEqual(r.status_code, 200, r.text)
        rows = {i["slug"]: i for i in r.json()["items"]}
        self.assertEqual(rows[shared["slug"]]["owner"]["name"], "Mira Member")
        self.assertEqual(rows[shared["slug"]]["owner"]["picture"], PIC)


if __name__ == "__main__":
    import unittest

    unittest.main()
