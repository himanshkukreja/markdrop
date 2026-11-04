"""Link previews of workspace and folder URLs (routers/og.py, services/folder_preview.py).

Crawlers are never signed in: a card or a title names a folder or a workspace
only when a signed-out visitor could already see that name. Everything else
gets the content-free card, and nothing in the response carries a name.
"""

from __future__ import annotations

from io import BytesIO
from unittest import mock

from PIL import Image

from tests._access_env import AccessWorld

from bson import ObjectId

from app.routers import og
from app.services import folder as folder_service
from app.services import og_render

class OgFolders(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        # A workspace with no custom domain: only a link share opens a folder to the public.
        self.ws["W3"] = await self.make_workspace("Nohost Co", "wo", require_auth=False)
        self.cards: list[og_render.Card] = []
        real = og_render.render_og_png

        def spy(card):
            self.cards.append(card)
            return real(card)

        p = mock.patch.object(og_render, "render_og_png", spy)
        p.start()
        self.addCleanup(p.stop)

    async def folder(self, ws: str, name: str, *, share: str | None = None, parent: str | None = None):
        f = await folder_service.create_folder(self.db, self.ws[ws], name, parent)
        if share:
            await folder_service.set_share(self.db, self.ws[ws], f.id, share, self.uid["wo"])
        return f

    async def meta(self, ws: str, folder_id: str | None = None):
        path = f"/api/v1/og/w/{self.ws[ws]}" + (f"/f/{folder_id}" if folder_id else "") + ".json"
        return await self.http.get(path)

    async def card(self, path: str) -> og_render.Card:
        self.cards.clear()
        og._rendered.clear()
        r = await self.http.get(path)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.headers["content-type"], "image/png")
        self.assertIn("max-age=", r.headers["cache-control"])
        self.assertEqual(Image.open(BytesIO(r.content)).size, (1200, 630))
        self.assertLess(len(r.content), 5 * 1024 * 1024)
        return self.cards[-1]

    async def folder_card(self, ws: str, folder_id: str) -> og_render.Card | None:
        return await self.card(f"/api/v1/og/w/{self.ws[ws]}/f/{folder_id}.png")

    def assert_hidden(self, r, card: og_render.Card | None, kind="folder_private"):
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"visible": False})
        if card is not None:
            self.assertEqual(card.kind, kind)
            self.assertEqual((card.title, card.snippet, card.meta, card.brand), ("", "", "", None))

    # ── Folders ──

    async def test_public_folder_shows_names(self):
        f = await self.folder("W3", "Secret Plans", share="link")
        await self.mkdoc("L", ws="W3", folder_id=f.id)
        await self.mkdoc("P", ws="W3", folder_id=f.id)  # not counted: anonymous can't open it
        r = await self.meta("W3", f.id)
        self.assertEqual(r.json(), {"visible": True, "workspace": "Nohost Co", "items": 1, "host": None,
                                    "folder": "Secret Plans"})
        card = await self.folder_card("W3", f.id)
        self.assertEqual((card.kind, card.title, card.meta), ("folder", "Secret Plans", "1 item"))
        self.assertEqual(card.brand.site_name, "Nohost Co")

    async def test_public_empty_link_share_still_names_itself(self):
        # Its share page shows the folder (and the workspace) to anyone, empty or not.
        f = await self.folder("W3", "Secret Plans", share="link")
        self.assertTrue((await self.meta("W3", f.id)).json()["visible"])

    async def test_private_folder_is_generic(self):
        f = await self.folder("W3", "Secret Plans")
        await self.mkdoc("P", ws="W3", folder_id=f.id)
        await self.mkdoc("W", ws="W3", folder_id=f.id)
        self.assert_hidden(await self.meta("W3", f.id), await self.folder_card("W3", f.id))

    async def test_unshared_folder_without_a_domain_is_generic_even_with_link_items(self):
        # No anonymous door lists it: the name stays private even though its items are public.
        f = await self.folder("W3", "Secret Plans")
        await self.mkdoc("L", ws="W3", folder_id=f.id)
        self.assert_hidden(await self.meta("W3", f.id), await self.folder_card("W3", f.id))

    async def test_members_only_folder_is_generic(self):
        f = await self.folder("W3", "Members", share="workspace")
        await self.mkdoc("L", ws="W3", folder_id=f.id)
        self.assert_hidden(await self.meta("W3", f.id), await self.folder_card("W3", f.id))
        share_id = (await self.db["folders"].find_one({"name": "Members"}))["share"]["id"]
        card = await self.card(f"/api/v1/og/f/{share_id}.png")
        self.assertEqual(card.kind, "folder_private")

    async def test_password_folder_is_generic(self):
        # On a workspace with a public domain, a folder holding only password-protected
        # items isn't listed to anonymous visitors, so its name isn't either.
        f = await self.folder("W1", "Pw Folder")
        await self.mkdoc("LP", ws="W1", folder_id=f.id)
        self.assert_hidden(await self.meta("W1", f.id), await self.folder_card("W1", f.id))

    async def test_sign_in_workspace_link_share_is_generic(self):
        f = await self.folder("WR", "Secret Plans", share="link")
        await self.mkdoc("RL", folder_id=f.id)
        self.assert_hidden(await self.meta("WR", f.id), await self.folder_card("WR", f.id))
        share_id = (await self.db["folders"].find_one({"_id": ObjectId(f.id)}))["share"]["id"]
        self.assertEqual((await self.card(f"/api/v1/og/f/{share_id}.png")).kind, "folder_private")

    async def test_deleted_folder_is_404_and_generic_card(self):
        f = await self.folder("W3", "Secret Plans", share="link")
        await self.db["folders"].delete_one({"_id": ObjectId(f.id)})
        r = await self.meta("W3", f.id)
        self.assertEqual(r.status_code, 404)
        self.assertNotIn("Secret", r.text)
        card = await self.folder_card("W3", f.id)
        self.assertEqual(card.kind, "folder_private")
        # A folder id from another workspace is the same as a missing one.
        g = await self.folder("W1", "Secret Plans", share="link")
        self.assertEqual((await self.meta("W3", g.id)).status_code, 404)

    async def test_bad_ids(self):
        self.assertEqual((await self.http.get("/api/v1/og/w/nope/f/zzz.json")).status_code, 404)
        self.assertEqual((await self.card("/api/v1/og/w/nope/f/zzz.png")).kind, "folder_private")
        self.assertEqual((await self.card("/api/v1/og/f/no.png")).kind, "folder_private")

    async def test_folder_on_a_public_domain_with_readable_items_shows_names(self):
        f = await self.folder("W1", "Secret Plans")
        await self.mkdoc("L", ws="W1", folder_id=f.id)
        r = (await self.meta("W1", f.id)).json()
        self.assertEqual((r["visible"], r["folder"], r["host"], r["items"]),
                         (True, "Secret Plans", "docs.acme.test", 1))
        card = await self.folder_card("W1", f.id)
        self.assertEqual((card.kind, card.brand.footer), ("folder", "docs.acme.test"))

    async def test_subfolder_of_a_link_share(self):
        root = await self.folder("W3", "Secret Plans", share="link")
        sub = await self.folder("W3", "Inner", parent=root.id)
        await self.mkdoc("P", ws="W3", folder_id=sub.id)
        self.assert_hidden(await self.meta("W3", sub.id), None)
        await self.mkdoc("L", ws="W3", folder_id=sub.id)
        self.assertEqual((await self.meta("W3", sub.id)).json()["folder"], "Inner")
        share_id = (await self.db["folders"].find_one({"_id": ObjectId(root.id)}))["share"]["id"]
        card = await self.card(f"/api/v1/og/f/{share_id}.png?path={sub.slug}")
        self.assertEqual((card.kind, card.title), ("folder", "Inner"))
        card = await self.card(f"/api/v1/og/f/{share_id}.png")
        self.assertEqual((card.kind, card.title), ("folder", "Secret Plans"))

    async def test_unsharing_hides_it_again(self):
        f = await self.folder("W3", "Secret Plans", share="link")
        self.assertTrue((await self.meta("W3", f.id)).json()["visible"])
        await folder_service.clear_share(self.db, self.ws["W3"], f.id)
        self.assert_hidden(await self.meta("W3", f.id), await self.folder_card("W3", f.id))

    # ── Workspaces ──

    async def test_workspace_with_a_public_domain_shows_its_name(self):
        await self.mkdoc("L", ws="W1")
        r = (await self.meta("W1")).json()
        self.assertEqual((r["visible"], r["workspace"], r["host"]), (True, "Acme", "docs.acme.test"))
        self.assertNotIn("folder", r)
        card = await self.card(f"/api/v1/og/w/{self.ws['W1']}.png")
        self.assertEqual((card.kind, card.title), ("workspace", "Acme"))

    async def test_workspace_without_a_public_door_is_generic(self):
        for key in ("W3", "WR"):
            r = await self.meta(key)
            card = await self.card(f"/api/v1/og/w/{self.ws[key]}.png")
            self.assert_hidden(r, card, kind="workspace_private")

    async def test_unknown_workspace_is_404_and_generic_card(self):
        missing = "0123456789abcdef01234567"
        self.assertEqual((await self.http.get(f"/api/v1/og/w/{missing}.json")).status_code, 404)
        self.assertEqual((await self.card(f"/api/v1/og/w/{missing}.png")).kind, "workspace_private")

    # ── The renderer never draws a name on a content-free card ──

    def test_private_cards_drop_whatever_they_are_handed(self):
        for kind in ("folder_private", "workspace_private"):
            leaky = og_render.Card(kind=kind, title="Secret Plans", snippet="Acme", meta="9 items",
                                   brand=og_render.CardBrand(site_name="Acme", footer="docs.acme.test"))
            self.assertEqual(og_render.render_og_png(leaky), og_render.render_og_png(og_render.Card(kind=kind)))
