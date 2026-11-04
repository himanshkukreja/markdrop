"""duplicate_page, list_workspace_members and ``:person[Name]`` resolved by name
(Senseloaf requests 5 and 6): app/services/page_copy.py, page_people.py and
their MCP tools.

The access-policy world (tests/_access_env.py): the test MongoDB (or
mongomock), an in-memory R2. Never backend/.env.
"""

from __future__ import annotations

import base64
import re
import unittest

from tests._access_env import AccessWorld, now  # noqa: F401  (pins settings first)

from app.services import page_people, viewers
from tests.test_pages import png


class World(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        from app.limiter import limiter

        limiter.enabled = False
        self.addCleanup(setattr, limiter, "enabled", True)
        viewers.clear()

    async def call(self, who: str, name: str, args: dict, *, write: bool = True):
        status, res = await self.mcp_call(await self.mcp_token(who, write=write), name, args)
        self.assertEqual(status, 200)
        return res

    async def ok(self, who: str, name: str, args: dict) -> dict:
        res = await self.call(who, name, args)
        self.assertFalse(res["isError"], res["content"][0]["text"])
        return res["structuredContent"]

    async def text(self, who: str, name: str, args: dict) -> str:
        res = await self.call(who, name, args)
        self.assertFalse(res["isError"], res["content"][0]["text"])
        return res["content"][0]["text"]

    async def err(self, who: str, name: str, args: dict) -> str:
        res = await self.call(who, name, args)
        self.assertTrue(res["isError"], res)
        return res["content"][0]["text"]

    async def image(self, slug: str, who: str = "owner", color=(200, 30, 30)) -> str:
        out = await self.ok(who, "upload_page_image", {
            "document": slug, "filename": "a.png", "content_base64": base64.b64encode(png(color)).decode()})
        return out["id"]

    async def page(self, state: str = "W", *, content: str | None = None, **kw) -> dict:
        return await self.mkdoc(state, editor="blocks", **kw) if content is None else \
            await self.mkdoc(state, editor="blocks", content=content, **kw)

    async def set_content(self, page: dict, content: str) -> None:
        await self.db["documents"].update_one({"_id": page["_id"]}, {"$set": {"content": content}})

    def key_of(self, doc_id, asset_id: str) -> str:
        return f"pa/{doc_id}/{asset_id}.png"


# ── duplicate_page ────────────────────────────────────────────────────────────


class Duplicate(World):
    async def _locked_page(self, state: str = "W", **kw) -> tuple[dict, str, str]:
        page = await self.page(state, **kw)
        body_img = await self.image(page["slug"])
        cover_img = await self.image(page["slug"], color=(10, 200, 10))
        await self.set_content(page, (f"---\nicon: 🚀\ncover: asset:{cover_img}\nfull_width: true\nlocked: true\n---\n"
                                      f"# Plan\n\nSome text.\n\n![Diagram](asset:{body_img})\n"))
        return page, body_img, cover_img

    async def test_member_duplicates_a_locked_page_next_to_it(self):
        page, body_img, cover_img = await self._locked_page("W")
        out = await self.ok("wm", "duplicate_page", {"document": page["slug"]})
        copy = await self.doc(out["slug"])
        self.assertNotEqual(copy["_id"], page["_id"])
        # Owned by the caller, unlocked, beside the original (same workspace and folder).
        self.assertEqual(copy["owner_id"], self.uid["wm"])
        self.assertEqual((copy["workspace_id"], copy.get("folder_id")), (self.ws["W1"], page.get("folder_id")))
        self.assertEqual(copy["editor"], "blocks")
        self.assertEqual(out["placed"], "workspace")
        self.assertEqual(out["title"], f"Copy of {page['title']}")
        self.assertTrue(out["url"].startswith("https://docs.acme.test/"), out["url"])
        self.assertNotIn("locked", copy["content"])
        self.assertIn("icon: 🚀", copy["content"])
        self.assertIn("full_width: true", copy["content"])
        # The images are the copy's own: new ids, stored under the copy, references rewritten.
        self.assertEqual(out["images_copied"], 2)
        self.assertEqual(out["images_missing"], [])
        ids = re.findall(r"asset:([0-9a-f]{24})", copy["content"])
        self.assertEqual(len(ids), 2)
        self.assertFalse({body_img, cover_img} & set(ids))
        for new in ids:
            row = await self.db["page_assets"].find_one({"_id": new})
            self.assertEqual((row["doc_id"], row["owner_id"]), (str(copy["_id"]), self.uid["wm"]))
            self.assertIn(self.key_of(copy["_id"], new), self.r2.objects)
        self.assertEqual(self.r2.objects[self.key_of(copy["_id"], ids[1])]["data"],
                         self.r2.objects[self.key_of(page["_id"], body_img)]["data"])
        # The original is untouched, still locked; the copy can be edited by its new owner.
        self.assertIn("locked: true", (await self.doc(page["slug"]))["content"])
        await self.ok("wm", "append_blocks", {"document": out["slug"], "markdown": "mine now"})
        self.assertIn("locked", await self.err("wm", "append_blocks", {"document": page["slug"], "markdown": "x"}))
        # get_page of the copy lists its own images.
        got = await self.ok("wm", "get_page", {"document": out["slug"]})
        self.assertEqual(sorted(a["id"] for a in got["assets"]), sorted(ids))

    async def test_reader_without_rights_there_gets_a_private_personal_copy(self):
        # gv can read the page (a viewer grant) but isn't a member of its workspace.
        page, _b, _c = await self._locked_page("UP")
        out = await self.ok("gv", "duplicate_page", {"document": page["slug"], "title": "My notes"})
        copy = await self.doc(out["slug"])
        self.assertEqual((out["placed"], out["access"], out["title"]), ("personal", "private", "My notes"))
        self.assertEqual(copy["owner_id"], self.uid["gv"])
        self.assertIsNone(copy.get("workspace_id"))
        self.assertNotIn("locked", copy["content"])
        self.assertEqual((await self.get(out["slug"], self.session("stranger"))).status_code, 404)
        self.assertEqual((await self.get(out["slug"], self.session("owner"))).status_code, 404)
        self.assertEqual((await self.get(out["slug"], self.session("gv"))).status_code, 200)
        for new in re.findall(r"asset:([0-9a-f]{24})", copy["content"]):
            self.assertFalse(self.r2.objects[self.key_of(copy["_id"], new)]["public"])
        # A plainly public page gives a link copy.
        public = await self.page("UL", owner="stranger", grants=False)
        out = await self.ok("gv", "duplicate_page", {"document": public["slug"]})
        self.assertEqual((out["placed"], out["access"]), ("personal", "link"))

    async def test_copy_images_follow_the_copys_access(self):
        public = await self.page("UL")
        img = await self.image(public["slug"])
        await self.set_content(public, f"# P\n\n![x](asset:{img})\n")
        self.assertTrue(self.r2.objects[self.key_of(public["_id"], img)]["public"])
        out = await self.ok("wm", "duplicate_page", {"document": public["slug"], "workspace": "Acme"})
        copy = await self.doc(out["slug"])
        self.assertEqual((out["placed"], out["access"]), ("workspace", "workspace"))
        (new,) = re.findall(r"asset:([0-9a-f]{24})", copy["content"])
        self.assertFalse(self.r2.objects[self.key_of(copy["_id"], new)]["public"])
        self.assertTrue(self.r2.objects[self.key_of(public["_id"], img)]["public"])
        # Readers of the copy get its image; a stranger gets nothing, though the original is public.
        r = await self.http.get(f"/api/v1/documents/{out['slug']}/assets/urls", headers=self.session("wv"))
        self.assertEqual(list(r.json()["assets"]), [new])
        r = await self.http.get(f"/api/v1/documents/{out['slug']}/assets/urls", headers=self.session("stranger"))
        self.assertIn(r.status_code, (401, 404))
        self.assertNotIn(new, r.text)

    async def test_no_create_rights_in_the_target(self):
        page = await self.page("W")
        parent = await self.page("UP")
        before = await self.db["documents"].count_documents({})
        # A workspace viewer can read the page but can't add pages to the workspace.
        self.assertIn("viewer", await self.err("wv", "duplicate_page", {"document": page["slug"], "workspace": "Acme"}))
        self.assertIn("viewer", await self.err("wv", "duplicate_page", {"document": page["slug"], "folder": "nope"}))
        # A page the caller can only read can't be the parent.
        self.assertIn("can edit", await self.err("gv", "duplicate_page", {"document": page["slug"],
                                                                         "parent": parent["slug"]}))
        # Not a member of the page's workspace: folder alone names nothing of theirs.
        self.assertIn("member", await self.err("gv", "duplicate_page", {"document": page["slug"], "folder": "x"}))
        # A workspace the caller isn't in.
        self.assertIn("isn't in a workspace", await self.err("wm", "duplicate_page", {"document": page["slug"],
                                                                                     "workspace": "Other"}))
        self.assertIn("parent alone", await self.err("wm", "duplicate_page", {
            "document": page["slug"], "parent": parent["slug"], "workspace": "Acme"}))
        self.assertEqual(await self.db["documents"].count_documents({}), before)

    async def test_refusals(self):
        private = await self.page("UP", grants=False)
        self.assertIn("couldn't find", await self.err("stranger", "duplicate_page", {"document": private["slug"]}))
        self.assertIn("couldn't find", await self.err("gv", "duplicate_page", {"document": private["slug"]}))
        enc = await self.mkdoc("UL", encrypted=True, content="mdx1.aaaaaaaaaaaaaaaaaaaa.bbbb")
        self.assertIn("encrypted", await self.err("owner", "duplicate_page", {"document": enc["slug"]}))
        art = await self.mkdoc("UL", kind="artifact")
        self.assertIn("file", await self.err("owner", "duplicate_page", {"document": art["slug"]}))
        pw = await self.page("ULP", owner="stranger", grants=False)
        self.assertIn("password", await self.err("wm", "duplicate_page", {"document": pw["slug"]}))
        status, _ = await self.mcp_call(await self.mcp_token("owner", write=False), "duplicate_page",
                                        {"document": private["slug"]})
        self.assertEqual(status, 403)
        # A document in the classic editor gives a classic copy.
        classic = await self.mkdoc("W")
        out = await self.ok("wm", "duplicate_page", {"document": classic["slug"]})
        self.assertIsNone((await self.doc(out["slug"])).get("editor"))
        self.assertEqual((await self.doc(out["slug"]))["content"], classic["content"])

    async def test_into_a_parent_and_a_folder(self):
        await self.ok("wm", "create_folder", {"workspace": "Acme", "path": "product-hub/templates"})
        src = await self.page("W")
        out = await self.ok("wm", "duplicate_page", {"document": src["slug"], "folder": "product-hub/templates",
                                                     "title": "PRD"})
        copy = await self.doc(out["slug"])
        self.assertEqual(copy["folder_path"][-1:], ["templates"])
        self.assertTrue(out["url"].startswith("https://docs.acme.test/product-hub/templates/"), out["url"])
        host = await self.ok("wm", "create_page", {"title": "Host", "workspace": "Acme"})
        out = await self.ok("wm", "duplicate_page", {"document": src["slug"], "parent": host["slug"]})
        copy = await self.doc(out["slug"])
        self.assertEqual((out["placed"], out["parent"]), ("parent", host["slug"]))
        self.assertEqual(copy["page_path"], [host["slug"]])
        self.assertTrue(copy["access_inherit"])

    async def test_a_subpage_is_copied_beside_it(self):
        top = await self.ok("wm", "create_page", {"title": "Top", "workspace": "Acme"})
        kid = await self.ok("wm", "create_page", {"title": "Kid", "parent": top["slug"]})
        out = await self.ok("wm", "duplicate_page", {"document": kid["slug"]})
        self.assertEqual((out["placed"], out["parent"]), ("parent", top["slug"]))
        self.assertEqual(out["title"], "Copy of Kid")

    async def test_subpages(self):
        top = await self.ok("owner", "create_page", {"title": "Top", "workspace": "Acme"})
        a = await self.ok("owner", "create_page", {"title": "A", "parent": top["slug"]})
        b = await self.ok("owner", "create_page", {"title": "B", "parent": top["slug"]})
        a2 = await self.ok("owner", "create_page", {"title": "A2", "parent": a["slug"]})
        img = await self.image(a2["slug"])
        await self.set_content(await self.doc(a2["slug"]), f"![x](asset:{img})\n")
        await self.set_content(await self.doc(top["slug"]), f"# Top\n\n::page{{src=\"{a['slug']}\"}}\n\n"
                                                            f"::page{{src={b['slug']}}}\n")
        r = await self.http.put(f"/api/v1/documents/{b['slug']}/access/level", json={"level": "private"},
                                headers=self.session("owner"))
        self.assertIn(r.status_code, (200, 204), r.text)
        # Without include_subpages: the page alone.
        out = await self.ok("wm", "duplicate_page", {"document": top["slug"]})
        self.assertEqual(out["pages"], 1)
        self.assertEqual(await self.db["documents"].count_documents({"parent_id": (await self.doc(out["slug"]))["_id"]}), 0)
        # With it: A and A2 (with its image); B has its own access: skipped and named.
        res = await self.call("owner", "duplicate_page", {"document": top["slug"], "include_subpages": True})
        out = res["structuredContent"]
        self.assertEqual((out["pages"], out["skipped_subpages"], out["images_copied"]), (3, ["B"], 1))
        self.assertIn("B", res["content"][0]["text"])
        copy = await self.doc(out["slug"])
        kids = await self.db["documents"].find({"parent_id": copy["_id"]}).to_list(length=10)
        self.assertEqual([k["title"] for k in kids], ["A"])
        self.assertIn(f'::page{{src="{kids[0]["slug"]}"}}', copy["content"])
        self.assertIn(f"::page{{src={b['slug']}}}", copy["content"])  # not copied: still the original
        grand = await self.db["documents"].find_one({"parent_id": kids[0]["_id"]})
        self.assertEqual(grand["title"], "A2")
        self.assertEqual(grand["page_path"], [copy["slug"], kids[0]["slug"]])
        (new,) = re.findall(r"asset:([0-9a-f]{24})", grand["content"])
        self.assertNotEqual(new, img)
        self.assertEqual((await self.db["page_assets"].find_one({"_id": new}))["doc_id"], str(grand["_id"]))
        # A reader who can't open B doesn't learn its title.
        res = await self.call("wm", "duplicate_page", {"document": top["slug"], "include_subpages": True})
        self.assertEqual(res["structuredContent"]["skipped_subpages"], [])
        self.assertEqual(res["structuredContent"]["pages"], 3)

    async def test_reader_copy_leaves_out_what_they_cant_see(self):
        hidden = await self.mkdoc("UP", owner="wm", grants=False, title="Secret plan")
        page = await self.page("UP", content=(f"# P\n\nSee :markdrop[Secret plan]{{src=\"{hidden['slug']}\"}} "
                                              f"with :person[WM]{{id=\"{self.uid['wm']}\"}}.\n"))
        out = await self.ok("gv", "duplicate_page", {"document": page["slug"]})
        content = (await self.doc(out["slug"]))["content"]
        self.assertNotIn("Secret plan", content)
        self.assertIn(":person[]{", content)


# ── list_workspace_members ────────────────────────────────────────────────────


class Members(World):
    async def test_member_sees_names_ids_and_roles_no_addresses(self):
        out = await self.ok("wm", "list_workspace_members", {"workspace": "Acme"})
        self.assertEqual(out["workspace_id"], self.ws["W1"])
        rows = {r["id"]: r for r in out["members"]}
        self.assertEqual(rows[self.uid["wo"]], {"name": "WO", "id": self.uid["wo"], "role": "owner"})
        self.assertEqual(rows[self.uid["wa"]]["role"], "admin")
        self.assertEqual(rows[self.uid["wv"]]["role"], "viewer")
        self.assertEqual(set(rows), {self.uid[n] for n in ("wo", "wa", "wm", "wv", "owner", "ownv")})
        self.assertNotIn("invitee", str(out))  # a pending invitation isn't a member
        self.assertNotIn("@", str(out))
        self.assertEqual(out["members"][0]["role"], "owner")
        # A viewer may list them too.
        self.assertEqual(len((await self.ok("wv", "list_workspace_members", {"workspace": self.ws["W1"]}))["members"]), 6)

    async def test_admins_and_owner_see_addresses(self):
        for who in ("wa", "wo"):
            out = await self.ok(who, "list_workspace_members", {"workspace": "docs.acme.test"})
            rows = {r["id"]: r for r in out["members"]}
            self.assertEqual(rows[self.uid["wm"]]["email"], self.email["wm"])
            self.assertTrue(all("email" in r for r in out["members"]))

    async def test_non_members_are_refused(self):
        for who in ("stranger", "gv", "wm2", "former", "invitee"):
            text = await self.err(who, "list_workspace_members", {"workspace": self.ws["W1"]})
            self.assertNotIn("WO", text, who)
            self.assertNotIn(self.uid["wm"], text, who)
        # Their own workspace answers; Acme, by name, isn't one of theirs.
        self.assertIn("isn't in a workspace", await self.err("wm2", "list_workspace_members", {"workspace": "Acme"}))
        out = await self.ok("wm2", "list_workspace_members", {"workspace": "Other"})
        self.assertEqual([r["id"] for r in out["members"]], [self.uid["wm2"]])

    async def test_read_only_token_is_enough(self):
        status, res = await self.mcp_call(await self.mcp_token("wm", write=False), "list_workspace_members",
                                          {"workspace": "Acme"})
        self.assertEqual(status, 200)
        self.assertFalse(res["isError"])


# ── :person[Name] by name ─────────────────────────────────────────────────────


class PersonByName(World):
    async def test_unique_name_gets_the_id(self):
        page = await self.page("W")
        res = await self.call("wm", "update_page", {
            "document": page["slug"], "base_rev": 1,
            "markdown": "Ask :person[wa] and :person[ Wv ] or :person[WA]{id=\"keep\"}.\n"})
        self.assertFalse(res["isError"])
        self.assertNotIn("unresolved_people", res["structuredContent"])
        wa, wv = self.uid["wa"], self.uid["wv"]
        self.assertEqual((await self.doc(page["slug"]))["content"],
                         f'Ask :person[wa]{{id="{wa}"}} and :person[ Wv ]{{id="{wv}"}} or :person[WA]{{id="keep"}}.\n')

    async def test_ambiguous_and_unknown_names_stay_and_are_reported(self):
        for email in ("sam1@example.com", "sam2@example.com"):
            uid = await self.make_user(email, "Sam Lee")
            await self.db["memberships"].insert_one({"workspace_id": self.ws["W1"], "user_id": uid,
                                                     "role": "member", "created_at": now()})
        outsider = await self.make_user("solo@example.com", "Solo Outsider")  # in no workspace
        self.assertTrue(outsider)
        page = await self.page("W")
        md = "Hi :person[Sam Lee], :person[Solo Outsider], :person[Nobody] and :person[WM].\n"
        res = await self.call("wm", "update_page", {"document": page["slug"], "base_rev": 1, "markdown": md})
        self.assertFalse(res["isError"])
        self.assertEqual(res["structuredContent"]["unresolved_people"], ["Sam Lee", "Solo Outsider", "Nobody"])
        self.assertIn("plain text: Sam Lee, Solo Outsider, Nobody", res["content"][0]["text"])
        self.assertEqual((await self.doc(page["slug"]))["content"],
                         md.replace(":person[WM]", f":person[WM]{{id=\"{self.uid['wm']}\"}}"))

    async def test_a_writer_outside_the_workspace_resolves_nothing(self):
        # ge can edit the page (an editor grant) but isn't a member: no lookup, so no oracle.
        page = await self.page("W")
        md = "Ping :person[WM] and :person[Nobody].\n"
        res = await self.call("ge", "update_page", {"document": page["slug"], "base_rev": 1, "markdown": md})
        self.assertFalse(res["isError"], res)
        self.assertEqual(res["structuredContent"]["unresolved_people"], ["WM", "Nobody"])
        self.assertEqual((await self.doc(page["slug"]))["content"], md)
        # A personal page (no workspace) resolves nothing either.
        mine = await self.page("UL")
        res = await self.call("owner", "append_blocks", {"document": mine["slug"], "markdown": ":person[WM]"})
        self.assertEqual(res["structuredContent"]["unresolved_people"], ["WM"])
        self.assertNotIn("{id=", (await self.doc(mine["slug"]))["content"])

    async def test_names_never_reach_non_members(self):
        page = await self.page("UL")  # anyone with the link reads it
        await self.db["documents"].update_one({"_id": page["_id"]}, {"$set": {"workspace_id": self.ws["W1"]}})
        await self.ok("wm", "update_page", {"document": page["slug"], "base_rev": 1, "markdown": "By :person[WA].\n"})
        self.assertIn(self.uid["wa"], (await self.doc(page["slug"]))["content"])
        got = await self.ok("stranger", "get_page", {"document": page["slug"]})
        self.assertEqual(got["markdown"], f"By :person[]{{id=\"{self.uid['wa']}\"}}.\n")
        body = (await self.get(page["slug"], self.session("stranger"))).json()
        self.assertNotIn("WA]", body["content"])

    async def test_every_write_path(self):
        # create_page (in a workspace and inside a page), append_blocks, replace_section, and an editor save.
        out = await self.ok("wm", "create_page", {"title": "T", "workspace": "Acme", "content": "# T\n\nBy :person[WO]\n"})
        self.assertIn(f":person[WO]{{id=\"{self.uid['wo']}\"}}", (await self.doc(out["slug"]))["content"])
        kid = await self.ok("wm", "create_page", {"title": "K", "parent": out["slug"], "content": ":person[wv]"})
        self.assertIn(f"{{id=\"{self.uid['wv']}\"}}", (await self.doc(kid["slug"]))["content"])
        await self.ok("wm", "append_blocks", {"document": out["slug"], "markdown": "- [ ] :person[WA] reviews"})
        self.assertIn(f":person[WA]{{id=\"{self.uid['wa']}\"}} reviews", (await self.doc(out["slug"]))["content"])
        await self.ok("wm", "replace_section", {"document": out["slug"], "heading": "T", "markdown": "Lead :person[WM]"})
        self.assertIn(f"Lead :person[WM]{{id=\"{self.uid['wm']}\"}}", (await self.doc(out["slug"]))["content"])
        raw = await self.doc(out["slug"])
        r = await self.http.put(f"/api/v1/documents/{out['slug']}", headers=self.session("wa"),
                                json={"title": "T", "content": "Now :person[owner].\n", "base_rev": raw["rev"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self.doc(out["slug"]))["content"],
                         f"Now :person[owner]{{id=\"{self.uid['owner']}\"}}.\n")

    async def test_code_and_classic_documents_are_left_alone(self):
        page = await self.page("W")
        md = "```\n:person[WM]\n```\n\nInline `:person[WM]` and :person[WM].\n"
        await self.ok("wm", "update_page", {"document": page["slug"], "base_rev": 1, "markdown": md})
        self.assertEqual((await self.doc(page["slug"]))["content"],
                         md.replace("and :person[WM].", f"and :person[WM]{{id=\"{self.uid['wm']}\"}}."))
        classic = await self.mkdoc("W")
        await self.ok("wm", "update_page", {"document": classic["slug"], "base_rev": 1, "markdown": ":person[WM]"})
        self.assertEqual((await self.doc(classic["slug"]))["content"], ":person[WM]")


class PersonNames(unittest.TestCase):
    def test_bare_names(self):
        md = ("A :person[Ada]{id=\"1\"}, :person[Ben], :person[Ben], ::person[x], \\:person[y], "
              ":person[], :person[C \\] d]\n```\n:person[Code]\n```\n`:person[Span]`")
        self.assertEqual(page_people.bare_names(md), ["Ben", "C \\] d"])
        self.assertEqual(page_people.bare_names(None), [])
        self.assertEqual(page_people._norm("  ada   LOVELACE "), "ada lovelace")
        self.assertIsNone(page_people.warning([]))
