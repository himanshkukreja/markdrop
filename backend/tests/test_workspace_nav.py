"""The app rail's outline (GET /workspaces/{id}/nav) and the listings it leans on: one request
for a workspace's top-level pages, documents and files, filtered to what the caller can read;
``has_children`` without a query per row (items, children).

Runs in the access-policy world (tests/_access_env.py): the test MongoDB (or mongomock). Never
backend/.env.
"""

from __future__ import annotations

from unittest import mock

from tests.test_pages import PageWorld  # noqa: F401  (pins settings first)

from app.services import workspace_items


class Nav(PageWorld):
    async def folder(self, name: str, parent: str | None = None) -> str:
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/folders",
                                 json={"name": name, "parent_id": parent}, headers=self.session("wo"))
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["id"]

    def url(self, ws: str = "W1") -> str:
        return f"/api/v1/workspaces/{self.ws[ws]}/nav"

    async def nav(self, who: str, ws: str = "W1") -> dict:
        r = await self.http.get(self.url(ws), headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def test_outline_grouped_ordered_and_filtered(self):
        W = self.ws["W1"]
        eng = await self.folder("Engineering")
        # Pages in the order they were made; documents and files after them, by title.
        p1 = await self.create("wm", title="Zeta page", workspace=W, folder=eng, content="---\nicon: 🚀\n---\n# Z\n")
        p2 = await self.create("wm", title="Alpha page", workspace=W, folder=eng)
        kid = await self.sub(p1["slug"], "wm", title="Child")
        md = await self.mkdoc("W", owner="wm", folder_id=eng, title="Beta notes")
        art = await self.mkdoc("W", owner="wm", folder_id=eng, kind="artifact", title="Aardvark")
        top = await self.create("wm", title="Home", workspace=W)
        secret = await self.mkdoc("P", owner="wa", folder_id=eng, title="Admin's private", grants=False)

        out = await self.nav("wm")
        self.assertEqual(out["more"], {})
        rows = {i["slug"]: i for i in out["items"]}
        eng_rows = [i["slug"] for i in out["items"] if i["folder_id"] == eng]
        self.assertEqual(eng_rows, [p1["slug"], p2["slug"], art["slug"], md["slug"]])
        self.assertNotIn(kid["slug"], rows)  # sub-pages load when their page opens
        self.assertNotIn(secret["slug"], rows)
        self.assertEqual(rows[top["slug"]]["folder_id"], None)
        self.assertEqual(rows[p1["slug"]], {"slug": p1["slug"], "title": "Zeta page", "kind": "page",
                                            "folder_id": eng, "has_children": True, "icon": "🚀"})
        self.assertFalse(rows[p2["slug"]]["has_children"])
        self.assertEqual((rows[md["slug"]]["kind"], rows[art["slug"]]["kind"], rows[art["slug"]]["renderer"],
                          rows[art["slug"]]["filename"]), ("markdown", "artifact", "html", "page.html"))

        # An admin sees no redacted placeholders here (the folder view has those).
        self.assertNotIn(None, [i["slug"] for i in (await self.nav("wa"))["items"]])
        # The private document's owner sees it.
        self.assertIn(secret["slug"], [i["slug"] for i in (await self.nav("wa"))["items"]])

    async def test_has_children_counts_only_readable_sub_pages(self):
        W = self.ws["W1"]
        parent = await self.create("wo", title="Parent", workspace=W)
        only = await self.sub(parent["slug"], "wo", title="Only child")
        await self.set_level(only["slug"], "private", who="wo")
        self.assertTrue({i["slug"]: i for i in (await self.nav("wo"))["items"]}[parent["slug"]]["has_children"])
        self.assertFalse({i["slug"]: i for i in (await self.nav("wm"))["items"]}[parent["slug"]]["has_children"])

    async def test_cap_per_folder(self):
        W = self.ws["W1"]
        f = await self.folder("Many")
        for i in range(4):
            await self.mkdoc("W", owner="wm", folder_id=f, title=f"Doc {i}")
        for i in range(3):
            await self.mkdoc("W", owner="wm", title=f"Top {i}")
        with mock.patch.object(workspace_items, "NAV_PER_PLACE", 2):
            out = await self.nav("wm")
        self.assertEqual(out["more"], {f: 2, "root": 1})
        self.assertEqual([i["title"] for i in out["items"] if i["folder_id"] == f], ["Doc 0", "Doc 1"])

    async def test_who_can_ask(self):
        await self.mkdoc("W", owner="wm", title="Team doc")
        for who, status in (("stranger", 404), ("gv", 404), ("wm2", 404)):
            r = await self.http.get(self.url(), headers=self.session(who))
            self.assertEqual(r.status_code, status, who)
        self.assertEqual((await self.http.get(self.url())).status_code, 401)
        # A viewer reads the outline (the folder view is theirs too).
        self.assertEqual([i["title"] for i in (await self.nav("wv"))["items"]], ["Team doc"])


class NoQueryPerRow(PageWorld):
    """``has_children`` comes from one ``distinct`` per listing, not a ``find_one`` per row."""

    async def count_find_one(self, coro):
        coll = type(self.db["documents"])
        calls = {"n": 0}
        real = coll.find_one

        async def counting(this, flt=None, *a, **kw):
            if isinstance(flt, dict) and "parent_id" in flt and set(flt) == {"parent_id"}:
                calls["n"] += 1
            return await real(this, flt, *a, **kw)

        with mock.patch.object(coll, "find_one", counting):
            r = await coro
        return r, calls["n"]

    async def test_items_and_children(self):
        W = self.ws["W1"]
        parent = await self.create("wm", title="Parent", workspace=W)
        for i in range(4):
            await self.sub(parent["slug"], "wm", title=f"Kid {i}")
        leaf = await self.create("wm", title="Leaf", workspace=W)
        r, n = await self.count_find_one(self.http.get(f"/api/v1/workspaces/{W}/items", headers=self.session("wm")))
        self.assertEqual(r.status_code, 200)
        rows = {i["slug"]: i for i in r.json()["items"]}
        self.assertEqual((rows[parent["slug"]]["has_children"], rows[leaf["slug"]]["has_children"]), (True, False))
        self.assertEqual(n, 0)
        kid = (await self.http.get(f"/api/v1/documents/{parent['slug']}/children", headers=self.session("wm"))).json()[0]
        await self.sub(kid["slug"], "wm", title="Grandkid")
        r, n = await self.count_find_one(self.http.get(f"/api/v1/documents/{parent['slug']}/children",
                                                       headers=self.session("wm")))
        self.assertEqual([k["has_children"] for k in r.json()], [True, False, False, False])
        self.assertEqual(n, 0)
