"""Workspace and personal page templates (services/page_user_templates.py,
routers/pages.py, MCP save_page_as_template / list_page_templates / create_page).

Who can see, use and manage them; hidden from every listing, search, tree,
folder page and MCP list/search; placeholders; page images copied so the new
page owns them; sub-pages.

The access-policy world (tests/_access_env.py): the test MongoDB (or
mongomock), an in-memory R2 (FakeR2). Never backend/.env.
"""

from __future__ import annotations

from datetime import datetime, timezone

from tests._access_env import HOSTS, now  # noqa: F401  (pins settings first)

from tests.test_pages import PageWorld, png

from app.services import page_user_templates


class TemplateWorld(PageWorld):
    async def page_with_image(self, who: str = "wm", **body) -> tuple[dict, str]:
        """A W1 page by ``who`` with an image, a {{title}} / {{author}} / {{date}} line."""
        body.setdefault("workspace", self.ws["W1"])
        body.setdefault("title", "Retro")
        page = await self.create(who, **body)
        r = await self.upload(page["slug"], self.session(who))
        self.assertEqual(r.status_code, 201, r.text)
        aid = r.json()["id"]
        md = (f"---\nicon: 🧭\n---\n\nTeam **{{{{title}}}}** by {{{{author}}}} on {{{{date}}}}.\n\n"
              f"![chart](asset:{aid})\n")
        r = await self.http.put(f"/api/v1/documents/{page['slug']}",
                                json={"title": page["title"], "content": md, "base_rev": page["rev"]},
                                headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        return page, aid

    async def save(self, slug: str, who: str = "wm", expect: int = 201, **body) -> dict:
        r = await self.http.post(f"/api/v1/documents/{slug}/save-as-template", json=body,
                                 headers=self.session(who))
        self.assertEqual(r.status_code, expect, r.text)
        return r.json()

    async def listing(self, who: str, ws: str | None = "W1") -> dict:
        params = {"workspace": self.ws[ws]} if ws else {}
        r = await self.http.get("/api/v1/page-templates/all", params=params, headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def folder(self, name: str, parent: str | None = None, who: str = "wa") -> str:
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/folders",
                                 json={"name": name, "parent_id": parent}, headers=self.session(who))
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["id"]

    async def mcp_ok(self, who: str, name: str, args: dict) -> dict:
        status, res = await self.mcp_call(await self.mcp_token(who, write=True), name, args)
        self.assertEqual(status, 200)
        self.assertFalse(res["isError"], res["content"][0]["text"])
        return res["structuredContent"]

    async def mcp_err(self, who: str, name: str, args: dict) -> str:
        status, res = await self.mcp_call(await self.mcp_token(who, write=True), name, args)
        self.assertEqual(status, 200)
        self.assertTrue(res["isError"], res)
        return res["content"][0]["text"]

    async def use(self, tid: str, who: str, expect: int = 201, **body) -> dict:
        body.setdefault("title", "Q4 retro")
        r = await self.http.post("/api/v1/pages", json={"template": tid, **body}, headers=self.session(who))
        self.assertEqual(r.status_code, expect, r.text)
        return r.json().get("document") if expect == 201 else r.json()


# ── Saving, listing, the permission matrix ────────────────────────────────────


class Matrix(TemplateWorld):
    async def test_save_list_use_matrix(self):
        page, _aid = await self.page_with_image("wm")
        t = await self.save(page["slug"], "wm", name="Team retro", description="Every two weeks", icon="🔁")
        self.assertEqual(t["scope"], "workspace")
        self.assertEqual(t["workspace_id"], self.ws["W1"])
        self.assertEqual((t["name"], t["description"], t["icon"]), ("Team retro", "Every two weeks", "🔁"))
        raw = await self.db["documents"].find_one({"slug": t["slug"]})
        self.assertTrue(raw["template"])
        self.assertEqual(raw["access_level"], "workspace")
        self.assertIsNone(raw["folder_id"])
        self.assertEqual(raw["owner_id"], self.uid["wm"])

        # Members, admins and the owner of W1 see it; a viewer, another
        # workspace's member and a stranger never do.
        for who in ("wm", "owner", "wa", "wo"):
            ids = [x["id"] for x in (await self.listing(who))["workspace"]]
            self.assertEqual(ids, [t["id"]], who)
        for who in ("wv", "wm2", "stranger"):
            body = await self.listing(who)
            self.assertEqual(body["workspace"], [], who)
            self.assertFalse(body["can_save_workspace"], who)
            self.assertEqual(body["personal"], [], who)
        self.assertTrue((await self.listing("wm"))["can_save_workspace"])
        self.assertFalse((await self.listing("wm"))["can_reorder_workspace"])
        self.assertTrue((await self.listing("wa"))["can_reorder_workspace"])
        # The built-ins come along.
        self.assertEqual((await self.listing("wm"))["builtin"][-1]["id"], "blank")

        # The preview: members only.
        for who, code in (("owner", 200), ("wa", 200), ("wv", 404), ("wm2", 404), ("stranger", 404)):
            r = await self.http.get(f"/api/v1/page-templates/{t['id']}", headers=self.session(who))
            self.assertEqual(r.status_code, code, who)
        r = await self.http.get(f"/api/v1/page-templates/{t['id']}", headers=self.session("owner"))
        self.assertIn("{{title}}", r.json()["content"])
        self.assertEqual(len(r.json()["assets"]), 1)

        # Using it: members+ only (the viewer can't, nor anyone outside W1).
        for who in ("wv", "wm2", "stranger"):
            await self.use(t["id"], who, expect=404)
        made = await self.use(t["id"], "owner")
        self.assertEqual(made["template_id"], t["id"])
        self.assertIsNone(made["template"])
        made_ws = await self.use(t["id"], "wa", workspace=self.ws["W1"])
        self.assertEqual(made_ws["workspace_id"], self.ws["W1"])
        # Signed out: 401.
        r = await self.http.post("/api/v1/pages", json={"title": "x", "template": t["id"]})
        self.assertEqual(r.status_code, 401)
        r = await self.http.get("/api/v1/page-templates/all")
        self.assertEqual(r.status_code, 401)

    async def test_who_can_save(self):
        page = await self.create("owner", workspace=self.ws["W1"], title="Plan")
        await self.set_level(page["slug"], "workspace", "owner")
        # A viewer reads the page but can't save it to the workspace.
        r = await self.http.post(f"/api/v1/documents/{page['slug']}/save-as-template", json={},
                                 headers=self.session("wv"))
        self.assertEqual(r.status_code, 403, r.text)
        # …but may keep a personal copy (copy = read).
        mine = await self.save(page["slug"], "wv", scope="personal")
        self.assertEqual(mine["scope"], "personal")
        # Someone who can't read the page: as if it didn't exist.
        await self.save(page["slug"], "wm2", expect=404, scope="personal")
        await self.save(page["slug"], "stranger", expect=404)
        # Not to a workspace they aren't in.
        await self.save(page["slug"], "wm", expect=404, workspace=self.ws["W2"])
        # Signed out.
        r = await self.http.post(f"/api/v1/documents/{page['slug']}/save-as-template", json={})
        self.assertEqual(r.status_code, 401)
        # A personal page is a personal template by default; scope workspace needs one.
        solo = await self.create("stranger", title="Solo")
        t = await self.save(solo["slug"], "stranger")
        self.assertEqual(t["scope"], "personal")
        await self.save(solo["slug"], "stranger", expect=422, scope="workspace")
        # Encrypted documents and files can't be templates.
        enc = await self.mkdoc("UL", owner="stranger", encrypted=True, content="ciphertext")
        await self.save(enc["slug"], "stranger", expect=422)
        art = await self.mkdoc("UL", owner="stranger", kind="artifact")
        await self.save(art["slug"], "stranger", expect=422)
        # A template isn't saved as a template again.
        await self.save(t["slug"], "stranger", expect=422)

    async def test_manage_matrix(self):
        page = await self.create("wm", workspace=self.ws["W1"], title="Plan")
        t = await self.save(page["slug"], "wm")
        t2 = await self.save(page["slug"], "wm", name="Second")
        path = f"/api/v1/page-templates/{t['id']}"
        # Rename: whoever saved it and the admins; another member can't; outsiders get 404.
        for who, code in (("owner", 403), ("wv", 404), ("wm2", 404), ("stranger", 404),
                          ("wm", 200), ("wa", 200), ("wo", 200)):
            r = await self.http.patch(path, json={"name": f"By {who}"}, headers=self.session(who))
            self.assertEqual(r.status_code, code, (who, r.text))
        self.assertEqual((await self.db["documents"].find_one({"slug": t["slug"]}))["title"], "By wo")
        # Icon must be an emoji; empty clears it.
        r = await self.http.patch(path, json={"icon": "<b>"}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 422)
        r = await self.http.patch(path, json={"icon": "📋", "description": "  Weekly   plan "},
                                  headers=self.session("wa"))
        self.assertEqual((r.json()["icon"], r.json()["description"]), ("📋", "Weekly plan"))
        r = await self.http.patch(path, json={"icon": ""}, headers=self.session("wa"))
        self.assertIsNone(r.json()["icon"])
        # Name can't be blank.
        r = await self.http.patch(path, json={"name": "   "}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 422)

        # Reorder: admins only.
        body = {"workspace": self.ws["W1"], "ids": [t2["id"], t["id"]]}
        for who, code in (("wm", 403), ("wv", 403), ("wm2", 404), ("stranger", 404)):
            r = await self.http.put("/api/v1/page-templates/order", json=body, headers=self.session(who))
            self.assertEqual(r.status_code, code, who)
        r = await self.http.put("/api/v1/page-templates/order", json=body, headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([x["id"] for x in r.json()["templates"]], [t2["id"], t["id"]])
        self.assertEqual([x["id"] for x in (await self.listing("wm"))["workspace"]], [t2["id"], t["id"]])

        # Delete: another member can't; an admin can.
        r = await self.http.delete(path, headers=self.session("owner"))
        self.assertEqual(r.status_code, 403)
        r = await self.http.delete(path, headers=self.session("wm2"))
        self.assertEqual(r.status_code, 404)
        r = await self.http.delete(path, headers=self.session("wa"))
        self.assertEqual(r.status_code, 204)
        self.assertIsNone(await self.db["documents"].find_one({"slug": t["slug"]}))
        # The page it was saved from is untouched.
        self.assertIsNotNone(await self.doc(page["slug"]))
        # Gone for everyone.
        await self.use(t["id"], "wm", expect=404)

    async def test_personal_templates_are_the_owners(self):
        page = await self.create("stranger", title="Diary")
        t = await self.save(page["slug"], "stranger", icon="📓")
        raw = await self.db["documents"].find_one({"slug": t["slug"]})
        self.assertEqual(raw["access_level"], "private")
        self.assertIsNone(raw["workspace_id"])
        self.assertEqual([x["id"] for x in (await self.listing("stranger", None))["personal"]], [t["id"]])
        for who in ("owner", "wm", "wa", "wo"):
            self.assertEqual((await self.listing(who, None))["personal"], [], who)
            await self.use(t["id"], who, expect=404)
            r = await self.http.delete(f"/api/v1/page-templates/{t['id']}", headers=self.session(who))
            self.assertEqual(r.status_code, 404, who)
        # The template page itself is private: nobody else can open it by its address.
        r = await self.get(t["slug"], self.session("wa"))
        self.assertEqual(r.status_code, 404)
        made = await self.use(t["id"], "stranger")
        self.assertEqual(made["access_level"], "link")  # a personal page, like any other
        r = await self.http.put("/api/v1/page-templates/order", json={"workspace": None, "ids": [t["id"]]},
                                headers=self.session("stranger"))
        self.assertEqual(r.status_code, 200)

    async def test_unknown_ids(self):
        await self.use("0123456789abcdef01234567", "wm", expect=404)
        await self.use("nope", "wm", expect=422)
        r = await self.http.get("/api/v1/page-templates/zzz", headers=self.session("wm"))
        self.assertEqual(r.status_code, 404)


# ── Hidden from every listing ─────────────────────────────────────────────────


class Hidden(TemplateWorld):
    async def test_hidden_everywhere(self):
        page = await self.create("wm", workspace=self.ws["W1"], title="Zebra plan")
        await self.set_level(page["slug"], "link", "wm")
        await self.sub(page["slug"], "wm", title="Zebra child")
        t = await self.save(page["slug"], "wm", name="Zebra template", include_subpages=True)
        mine = await self.create("wm", title="Zebra solo")
        tp = await self.save(mine["slug"], "wm", name="Zebra personal")
        tslugs = {t["slug"], tp["slug"]}
        sub_slugs = {d["slug"] async for d in self.db["documents"].find({"template": True, "parent_id": {"$ne": None}})}
        self.assertEqual(len(sub_slugs), 1)
        hidden = tslugs | sub_slugs
        # A template's address opens it (for those who may), so readers in the
        # workspace — and admins — see it nowhere in a list.
        for who in ("wm", "wa", "wo", "owner"):
            h = self.session(who)
            ws = self.ws["W1"]
            seen: set = set()
            r = await self.http.get(f"/api/v1/workspaces/{ws}/documents", params={"limit": 100}, headers=h)
            seen |= {d["slug"] for d in r.json()["documents"]}
            r = await self.http.get(f"/api/v1/workspaces/{ws}/documents", params={"q": "Zebra"}, headers=h)
            seen |= {d["slug"] for d in r.json()["documents"]}
            r = await self.http.get(f"/api/v1/workspaces/{ws}/items", params={"limit": 100}, headers=h)
            seen |= {i.get("slug") for i in r.json()["items"]}
            r = await self.http.get(f"/api/v1/workspaces/{ws}/items", params={"q": "Zebra"}, headers=h)
            seen |= {i.get("slug") for i in r.json()["items"]}
            r = await self.http.get(f"/api/v1/workspaces/{ws}/tree", headers=h)
            self.assertEqual(r.status_code, 200)
            seen |= set(_slugs_in(r.json()))
            r = await self.http.get("/api/v1/search/quick", params={"q": "Zebra"}, headers=h)
            seen |= set(_slugs_in(r.json()))
            r = await self.http.get("/api/v1/me/documents", params={"q": "Zebra"}, headers=h)
            seen |= {d["slug"] for d in r.json()["documents"]}
            r = await self.http.get("/api/v1/me/documents", headers=h)
            seen |= {d["slug"] for d in r.json()["documents"]}
            self.assertFalse(seen & hidden, (who, seen & hidden))
            # The real page shows up in the same lists (the filters do work).
            if who == "wm":
                self.assertIn(page["slug"], seen)
        # Counts exclude them.
        r = await self.http.get("/api/v1/me/documents", headers=self.session("wm"))
        self.assertEqual(r.json()["total"], 3)  # the page, its sub-page and the solo page
        # Opened by its owner, it isn't in Recent either.
        await self.get(t["slug"], self.session("wm"))
        r = await self.http.get("/api/v1/me/recent", headers=self.session("wm"))
        self.assertFalse(set(_slugs_in(r.json())) & hidden)
        # The workspace's public folder page on its domain.
        r = await self.http.get("/api/v1/host/folder", params={"host": HOSTS["W1"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse({d["slug"] for d in r.json()["documents"]} & hidden)
        self.assertIn(page["slug"], {d["slug"] for d in r.json()["documents"]})
        # Nor are they the page's backlinks.
        target = await self.create("wm", workspace=self.ws["W1"], title="Linked")
        r = await self.http.put(f"/api/v1/documents/{t['slug']}",
                                json={"title": "Zebra template", "content": f":markdrop[]{{src=\"{target['slug']}\"}}\n"},
                                headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        r = await self.http.get(f"/api/v1/documents/{target['slug']}/backlinks", headers=self.session("wm"))
        if r.status_code == 200:
            self.assertFalse(set(_slugs_in(r.json())) & hidden)

    async def test_mcp_list_and_search_hide_them(self):
        page = await self.create("wm", workspace=self.ws["W1"], title="Walrus plan")
        t = await self.save(page["slug"], "wm", name="Walrus template")
        mine = await self.create("wm", title="Walrus solo", content="walrus body text")
        tp = await self.save(mine["slug"], "wm", name="Walrus personal")
        token = await self.mcp_token("wm", write=False)
        seen: set = set()
        for scope in ("mine", "workspaces", "all"):
            _s, res = await self.mcp_call(token, "list_documents", {"scope": scope, "limit": 50})
            seen |= set(_slugs_in(res["structuredContent"]))
            _s, res = await self.mcp_call(token, "search", {"query": "Walrus", "scope": scope})
            seen |= set(_slugs_in(res["structuredContent"]))
        _s, res = await self.mcp_call(token, "search", {"query": "walrus body"})
        seen |= set(_slugs_in(res["structuredContent"]))
        self.assertFalse(seen & {t["slug"], tp["slug"]}, seen)
        self.assertIn(mine["slug"], seen)


def _slugs_in(obj) -> list[str]:
    """Every value of a "slug" or "id" key anywhere in a JSON body."""
    out: list[str] = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in ("slug", "id") and isinstance(v, str):
                out.append(v)
            else:
                out.extend(_slugs_in(v))
    elif isinstance(obj, list):
        for v in obj:
            out.extend(_slugs_in(v))
    return out


# ── Placeholders, images, sub-pages ───────────────────────────────────────────


class Instantiate(TemplateWorld):
    def test_fill(self):
        when = datetime(2026, 11, 4, tzinfo=timezone.utc)
        out = page_user_templates.fill("{{title}} · {{author}} · {{date}} · {{other}}", title="Q4",
                                       author="Riya", now=when)
        self.assertEqual(out, "Q4 · Riya · November 4, 2026 · {{other}}")

    async def test_placeholders_and_images_copied(self):
        page, aid = await self.page_with_image("wm")
        t = await self.save(page["slug"], "wm")
        traw = await self.db["documents"].find_one({"slug": t["slug"]})
        # Saving copied the image into the template (the page's own stays).
        tassets = await self.db["page_assets"].find({"doc_id": str(traw["_id"])}).to_list(length=10)
        self.assertEqual(len(tassets), 1)
        self.assertNotEqual(tassets[0]["_id"], aid)
        self.assertTrue(tassets[0]["key"].startswith(f"pa/{traw['_id']}/"))
        self.assertIn(tassets[0]["key"], self.r2.objects)
        self.assertIn(f"asset:{tassets[0]['_id']}", traw["content"])
        self.assertIn("{{title}}", traw["content"])  # placeholders stay in the template

        made = await self.use(t["id"], "owner", title="Q4 retro")
        raw = await self.doc(made["slug"])
        self.assertIn("Team **Q4 retro** by OWNER on ", raw["content"])
        self.assertNotIn("{{", raw["content"])
        today = datetime.now(timezone.utc)
        self.assertIn(f"{today:%B} {today.day}, {today:%Y}", raw["content"])
        # Its own copy of the image: a new id, under its own prefix, owned by the new page's owner.
        rows = await self.db["page_assets"].find({"doc_id": str(raw["_id"])}).to_list(length=10)
        self.assertEqual(len(rows), 1)
        new = rows[0]
        self.assertNotIn(new["_id"], (aid, tassets[0]["_id"]))
        self.assertEqual(new["owner_id"], self.uid["owner"])
        self.assertTrue(new["key"].startswith(f"pa/{raw['_id']}/"))
        self.assertEqual(self.r2.objects[new["key"]]["data"], self.r2.objects[tassets[0]["key"]]["data"])
        self.assertIn(f"asset:{new['_id']}", raw["content"])
        self.assertIn(new["_id"], made["assets"])
        # It follows the new page's access: a personal link page is public…
        self.assertTrue(self.r2.objects[new["key"]]["public"])
        # …and the template's (workspace-only) stays closed.
        self.assertFalse(self.r2.objects[tassets[0]["key"]]["public"])
        # Deleting the template leaves the page and its image alone.
        r = await self.http.delete(f"/api/v1/page-templates/{t['id']}", headers=self.session("wm"))
        self.assertEqual(r.status_code, 204)
        self.assertIn(new["key"], self.r2.objects)
        self.assertNotIn(tassets[0]["key"], self.r2.objects)
        self.assertEqual(await self.db["page_assets"].count_documents({"doc_id": str(traw["_id"])}), 0)

    async def test_private_page_gets_closed_image(self):
        page, _aid = await self.page_with_image("wm")
        t = await self.save(page["slug"], "wm")
        made = await self.use(t["id"], "wm", workspace=self.ws["W1"])
        await self.set_level(made["slug"], "private", "wm")
        raw = await self.doc(made["slug"])
        row = await self.db["page_assets"].find_one({"doc_id": str(raw["_id"])})
        self.assertFalse(self.r2.objects[row["key"]]["public"])

    async def test_locked_property_dropped(self):
        page = await self.create("wm", workspace=self.ws["W1"], title="Locked",
                                 content="---\nlocked: true\n---\n\nHello\n")
        t = await self.save(page["slug"], "wm")
        made = await self.use(t["id"], "owner")
        self.assertFalse(made["page"]["locked"])
        self.assertIn("Hello", made["content"])

    async def test_subpages(self):
        root = await self.create("wm", workspace=self.ws["W1"], title="Onboarding")
        a = await self.sub(root["slug"], "wm", title="Week 1 for {{title}}", content="Day one: {{author}}\n")
        await self.sub(a["slug"], "wm", title="Checklist", content="- [ ] laptop\n")
        # One the saver can't open stays out.
        other = await self.sub(root["slug"], "owner", title="Owner's secret")
        r = await self.http.put(f"/api/v1/documents/{other['slug']}/access/level", json={"level": "private"},
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 204, r.text)
        # Without include_subpages: just the page.
        t0 = await self.save(root["slug"], "wm")
        self.assertEqual(t0["subpages"], 0)
        t = await self.save(root["slug"], "wm", include_subpages=True)
        self.assertEqual(t["subpages"], 1)
        traw = await self.db["documents"].find_one({"slug": t["slug"]})
        below = await self.db["documents"].find({"template": True, "parent_id": {"$ne": None}}).to_list(length=10)
        self.assertEqual(sorted(d["title"] for d in below), ["Checklist", "Week 1 for {{title}}"])
        self.assertNotIn("Owner's secret", [d["title"] for d in below])
        for d in below:
            self.assertEqual(d["workspace_id"], self.ws["W1"])
        # A sub-page can be added inside a template: it's part of the template.
        extra = await self.sub(t["slug"], "wm", title="Week 2")
        self.assertTrue((await self.doc(extra["slug"]))["template"])
        self.assertEqual(extra["template"], {"part_of": True})
        # A normal page can't be moved into a template.
        loose = await self.create("wm", workspace=self.ws["W1"], title="Loose")
        r = await self.http.put(f"/api/v1/documents/{loose['slug']}/parent", json={"parent": t["slug"]},
                                headers=self.session("wm"))
        self.assertEqual(r.status_code, 422, r.text)

        made = await self.use(t["id"], "wa", title="Ana", workspace=self.ws["W1"])
        self.assertEqual(made["children_count"], 2)
        kids = await self.db["documents"].find({"parent_id": (await self.doc(made["slug"]))["_id"]}).to_list(10)
        titles = sorted(k["title"] for k in kids)
        self.assertEqual(titles, ["Week 1 for Ana", "Week 2"])
        week1 = next(k for k in kids if k["title"] == "Week 1 for Ana")
        self.assertIn("Day one: WA", week1["content"])
        self.assertFalse(week1.get("template"))
        grand = await self.db["documents"].find({"parent_id": week1["_id"]}).to_list(10)
        self.assertEqual([g["title"] for g in grand], ["Checklist"])
        self.assertTrue(all(not k.get("template") for k in [*kids, *grand]))
        self.assertTrue(all(k["owner_id"] == self.uid["wa"] for k in [*kids, *grand]))
        # The template page itself says it's a template.
        g = await self.get(t["slug"], self.session("wm"))
        self.assertEqual(g.json()["template"]["id"], t["id"])
        self.assertEqual(g.json()["template"]["scope"], "workspace")
        # Deleting the template takes its sub-pages, not the made pages.
        r = await self.http.delete(f"/api/v1/page-templates/{t['id']}", headers=self.session("wa"))
        self.assertEqual(r.status_code, 204)
        self.assertEqual(await self.db["documents"].count_documents({"parent_id": traw["_id"]}), 0)
        self.assertEqual(len(kids), 2)
        self.assertIsNotNone(await self.doc(made["slug"]))


# ── MCP ───────────────────────────────────────────────────────────────────────


class Mcp(TemplateWorld):
    async def ok(self, who: str, name: str, args: dict, *, write: bool = True) -> dict:
        status, res = await self.mcp_call(await self.mcp_token(who, write=write), name, args)
        self.assertEqual(status, 200)
        self.assertFalse(res["isError"], res["content"][0]["text"])
        return res["structuredContent"]

    async def err(self, who: str, name: str, args: dict) -> str:
        status, res = await self.mcp_call(await self.mcp_token(who, write=True), name, args)
        self.assertEqual(status, 200)
        self.assertTrue(res["isError"], res)
        return res["content"][0]["text"]

    async def test_save_list_create(self):
        page, _aid = await self.page_with_image("wm")
        out = await self.ok("wm", "save_page_as_template", {"document": page["slug"], "name": "Retro",
                                                           "description": "Fortnightly", "icon": "🔁"})
        self.assertEqual(out["scope"], "workspace")
        tid = out["id"]
        for who in ("wm", "owner", "wa"):
            ids = [t["id"] for t in (await self.ok(who, "list_page_templates", {}, write=False))["templates"]]
            self.assertIn(tid, ids, who)
            self.assertIn("prd", ids)
        for who in ("wv", "wm2", "stranger"):
            ids = [t["id"] for t in (await self.ok(who, "list_page_templates", {}, write=False))["templates"]]
            self.assertNotIn(tid, ids, who)
        made = await self.ok("owner", "create_page", {"title": "From MCP", "template": tid})
        raw = await self.doc(made["slug"])
        self.assertIn("Team **From MCP** by OWNER", raw["content"])
        self.assertEqual(raw["template_id"], tid)
        self.assertEqual(await self.db["page_assets"].count_documents({"doc_id": str(raw["_id"])}), 1)
        self.assertIn("Template not found", await self.err("wm2", "create_page", {"title": "x", "template": tid}))
        self.assertIn("Unknown template", await self.err("wm", "create_page", {"title": "x", "template": "zz"}))
        # Viewers can't save to the workspace; a read-only token can't save at all.
        self.assertIn("Viewers", await self.err("wv", "save_page_as_template",
                                                {"document": page["slug"], "scope": "workspace"}))
        status, _ = await self.mcp_call(await self.mcp_token("wm", write=False), "save_page_as_template",
                                        {"document": page["slug"]})
        self.assertEqual(status, 403)
        # Personal, with a workspace page as the source.
        mine = await self.ok("wm", "save_page_as_template", {"document": page["slug"], "scope": "personal"})
        self.assertEqual(mine["scope"], "personal")
        ids = [t["id"] for t in (await self.ok("wa", "list_page_templates", {}, write=False))["templates"]]
        self.assertNotIn(mine["id"], ids)


# ── Senseloaf deltas: slugs, {{folder}}, folder defaults, in place, no propagation ──


class Deltas(TemplateWorld):
    async def test_done_when_prd_in_product_hub(self):
        """The customer's check: New page in product-hub/02-prds → "PRD" → a filled page in that
        folder with today's date and the author's name; the same through create_page."""
        hub = await self.folder("product-hub")
        prds = await self.folder("02-prds", hub)
        src = await self.create("wm", workspace=self.ws["W1"], title="PRD",
                                content="**{{title}}** · {{author}} · {{date}} · filed in {{folder}}\n\n## Problem\n")
        prd = await self.save(src["slug"], "wm", name="PRD", icon="📄")
        today = datetime.now(timezone.utc)
        day = f"{today:%B} {today.day}, {today:%Y}"

        def check(doc: dict, title: str, author: str):
            # (After the front matter: the page may have its auto cover by now.)
            from app.services import page_props

            self.assertEqual(page_props.split(doc["content"])[1].strip().splitlines()[0],
                             f"**{title}** · {author} · {day} · filed in 02-prds")
            self.assertEqual(doc["template_id"], prd["id"])
            self.assertEqual(doc["editor"], "blocks")

        # Picking it in New page (the gallery sends its id).
        picked = await self.use(prd["id"], "wm", title="Search v2", workspace=self.ws["W1"],
                                folder="product-hub/02-prds")
        check(picked, "Search v2", "WM")
        self.assertEqual((await self.doc(picked["slug"]))["folder_id"], prds)
        # The folder's default: no template named at all.
        r = await self.http.put(f"/api/v1/workspaces/{self.ws['W1']}/folders/{prds}/default-template",
                                json={"template": prd["slug"]}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["default_template"], prd["id"])
        r = await self.http.post("/api/v1/pages", json={"title": "Billing", "workspace": self.ws["W1"],
                                                         "folder": "product-hub/02-prds"}, headers=self.session("owner"))
        self.assertEqual(r.status_code, 201, r.text)
        check(r.json()["document"], "Billing", "OWNER")
        # "blank" opts out.
        r = await self.http.post("/api/v1/pages", json={"title": "Scratch", "workspace": self.ws["W1"],
                                                         "folder": "product-hub/02-prds", "template": "blank"},
                                 headers=self.session("wm"))
        self.assertEqual(r.json()["document"]["content"].strip(), "")
        # Elsewhere, no default.
        r = await self.http.post("/api/v1/pages", json={"title": "Other", "workspace": self.ws["W1"],
                                                         "folder": "product-hub"}, headers=self.session("wm"))
        self.assertEqual(r.json()["document"]["content"].strip(), "")
        # The same through MCP: by slug, and by the folder's default.
        out = await self.mcp_ok("wm", "create_page", {"title": "Exports", "workspace": self.ws["W1"],
                                                      "folder": "product-hub/02-prds", "template": prd["slug"]})
        check(await self.doc(out["slug"]), "Exports", "WM")
        self.assertEqual((await self.doc(out["slug"]))["folder_id"], prds)
        out = await self.mcp_ok("wa", "create_page", {"title": "Alerts", "workspace": self.ws["W1"],
                                                      "folder": "product-hub/02-prds",
                                                      "properties": {"full_width": True}})
        raw = await self.doc(out["slug"])
        self.assertIn("**Alerts** · WA · ", raw["content"])
        self.assertIn("full_width: true", raw["content"])
        self.assertEqual(out["template_id"], prd["id"])
        # The gallery's listing names the folder's default.
        r = await self.http.get("/api/v1/page-templates/all", params={"workspace": self.ws["W1"], "folder": prds},
                                headers=self.session("wm"))
        self.assertEqual(r.json()["folder"], {"id": prds, "name": "02-prds", "default_template": prd["id"],
                                              "can_set_default": False})

    async def test_folder_default_rules(self):
        f = await self.folder("Specs")
        path = f"/api/v1/workspaces/{self.ws['W1']}/folders/{f}/default-template"
        for who, code in (("wm", 403), ("wv", 403), ("wm2", 404), ("stranger", 404)):
            r = await self.http.put(path, json={"template": "prd"}, headers=self.session(who))
            self.assertEqual(r.status_code, code, who)
        r = await self.http.put(path, json={"template": "prd"}, headers=self.session("wo"))
        self.assertEqual(r.json()["default_template"], "prd")  # a built-in works too
        made = await self.create("wm", workspace=self.ws["W1"], folder=f, title="Spec")
        self.assertEqual(made["template_id"], "prd")
        # Not another workspace's template, nor someone's personal one.
        other = await self.create("wm2", workspace=self.ws["W2"], title="W2 page")
        t2 = await self.save(other["slug"], "wm2")
        mine = await self.save((await self.create("wa", title="Mine"))["slug"], "wa")
        for ref in (t2["id"], mine["id"], "nope"):
            r = await self.http.put(path, json={"template": ref}, headers=self.session("wa"))
            self.assertEqual(r.status_code, 422, ref)
        r = await self.http.put(path, json={"template": None}, headers=self.session("wa"))
        self.assertIsNone(r.json()["default_template"])
        # MCP: admins only.
        self.assertIn("admins", await self.mcp_err("wm", "set_folder_default_template",
                                                   {"workspace": self.ws["W1"], "folder": "Specs", "template": "prd"}))
        out = await self.mcp_ok("wa", "set_folder_default_template",
                                {"workspace": self.ws["W1"], "folder": "Specs", "template": "runbook"})
        self.assertEqual(out["default_template"], "runbook")
        # A deleted default falls back to blank.
        page = await self.create("wm", workspace=self.ws["W1"], title="T")
        t = await self.save(page["slug"], "wm")
        await self.http.put(path, json={"template": t["id"]}, headers=self.session("wa"))
        await self.http.delete(f"/api/v1/page-templates/{t['id']}", headers=self.session("wa"))
        made = await self.create("wm", workspace=self.ws["W1"], folder=f, title="After")
        self.assertIsNone(made["template_id"])

    async def test_slug_refs(self):
        page = await self.create("wm", workspace=self.ws["W1"], title="Retro", content="Hi {{author}}\n")
        t = await self.save(page["slug"], "wm")
        made = await self.use(t["slug"], "owner")
        self.assertEqual(made["template_id"], t["id"])
        self.assertIn("Hi OWNER", made["content"])
        await self.use(t["slug"], "wm2", expect=404)
        await self.use("no-such-template-slug", "wm", expect=422)
        # A page's slug that isn't a template is no template.
        await self.use(page["slug"], "wm", expect=422)

    async def test_in_place(self):
        page = await self.create("wm", workspace=self.ws["W1"], title="Onboarding", content="Welcome {{title}}\n")
        kid = await self.sub(page["slug"], "wm", title="Week 1")
        path = f"/api/v1/documents/{page['slug']}/template"
        # Viewers and outsiders can't; a sub-page can't on its own.
        for who, code in (("wv", 403), ("wm2", 404), ("stranger", 404)):
            r = await self.http.put(path, json={"template": True}, headers=self.session(who))
            self.assertEqual(r.status_code, code, who)
        r = await self.http.put(f"/api/v1/documents/{kid['slug']}/template", json={"template": True},
                                headers=self.session("wm"))
        self.assertEqual(r.status_code, 422)
        r = await self.http.put(path, json={"template": True}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        tid = r.json()["id"]
        self.assertTrue((await self.doc(kid["slug"]))["template"])
        self.assertEqual([x["id"] for x in (await self.listing("owner"))["workspace"]], [tid])
        r = await self.http.get(f"/api/v1/workspaces/{self.ws['W1']}/items", params={"limit": 100},
                                headers=self.session("wm"))
        self.assertFalse({page["slug"], kid["slug"]} & set(_slugs_in(r.json())))
        made = await self.use(tid, "owner", title="Ana")
        self.assertIn("Welcome Ana", made["content"])
        self.assertEqual(made["children_count"], 1)
        # Back to a page: only who may manage it.
        r = await self.http.put(path, json={"template": False}, headers=self.session("owner"))
        self.assertEqual(r.status_code, 403)
        r = await self.http.put(path, json={"template": False}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 200)
        self.assertFalse((await self.doc(kid["slug"]))["template"])
        self.assertEqual((await self.listing("owner"))["workspace"], [])
        r = await self.http.get(f"/api/v1/workspaces/{self.ws['W1']}/items", params={"limit": 100},
                                headers=self.session("wm"))
        self.assertTrue({page["slug"], kid["slug"]} <= set(_slugs_in(r.json())))
        # MCP: set_page_properties(template=…).
        out = await self.mcp_ok("wm", "set_page_properties", {"document": page["slug"], "template": True})
        self.assertTrue(out["template"])
        self.assertEqual(out["template_id"], tid)
        listed = await self.mcp_ok("owner", "list_page_templates", {"workspace": self.ws["W1"]})
        self.assertIn(tid, [x["id"] for x in listed["templates"]])
        self.assertIn(page["slug"], [x.get("slug") for x in listed["templates"]])
        out = await self.mcp_ok("wa", "set_page_properties", {"document": page["slug"], "template": False,
                                                              "full_width": True})
        self.assertFalse(out["template"])
        self.assertTrue(out["properties"]["full_width"])
        # A personal page: only its owner.
        solo = await self.create("stranger", title="Solo")
        await self.http.post(f"/api/v1/documents/{solo['slug']}/access/grants", json={"email": self.email["wm"],
                                                                                      "role": "editor"},
                             headers=self.session("stranger"))
        r = await self.http.put(f"/api/v1/documents/{solo['slug']}/template", json={"template": True},
                                headers=self.session("wm"))
        self.assertIn(r.status_code, (403, 404))
        r = await self.http.put(f"/api/v1/documents/{solo['slug']}/template", json={"template": True},
                                headers=self.session("stranger"))
        self.assertEqual(r.status_code, 200)
        self.assertEqual([x["id"] for x in (await self.listing("stranger", None))["personal"]], [r.json()["id"]])

    async def test_list_by_workspace(self):
        a = await self.save((await self.create("wm", workspace=self.ws["W1"], title="A"))["slug"], "wm")
        await self.add_member("W2", "wm", "member")
        b = await self.save((await self.create("wm", workspace=self.ws["W2"], title="B"))["slug"], "wm")
        mine = await self.save((await self.create("wm", title="Mine"))["slug"], "wm")
        out = await self.mcp_ok("wm", "list_page_templates", {"workspace": self.ws["W1"]})
        ids = [x["id"] for x in out["templates"]]
        self.assertIn(a["id"], ids)
        self.assertNotIn(b["id"], ids)
        self.assertNotIn(mine["id"], ids)
        self.assertIn("prd", ids)
        everything = [x["id"] for x in (await self.mcp_ok("wm", "list_page_templates", {}))["templates"]]
        self.assertTrue({a["id"], b["id"], mine["id"]} <= set(everything))

    async def test_no_propagation(self):
        """Editing (or deleting) a template never changes pages already made from it."""
        page = await self.create("wm", workspace=self.ws["W1"], title="Sync", content="Agenda v1 for {{title}}\n")
        t = await self.save(page["slug"], "wm", include_subpages=False)
        made = await self.use(t["id"], "owner", title="Monday")
        before = await self.doc(made["slug"])
        traw = await self.db["documents"].find_one({"slug": t["slug"]})
        r = await self.http.put(f"/api/v1/documents/{t['slug']}", json={"title": "Sync v2", "content": "Agenda v2\n",
                                                                          "base_rev": traw["rev"]},
                                headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        await self.mcp_ok("wa", "append_blocks", {"document": t["slug"], "markdown": "- one more"})
        after = await self.doc(made["slug"])
        self.assertEqual(after["content"], before["content"])
        self.assertEqual(after["rev"], before["rev"])
        self.assertIn("Agenda v1 for Monday", after["content"])
        # New pages get the new version.
        self.assertIn("Agenda v2", (await self.use(t["id"], "owner", title="Tuesday"))["content"])
        # Renaming or deleting it leaves the made page alone too.
        await self.http.patch(f"/api/v1/page-templates/{t['id']}", json={"name": "Renamed"}, headers=self.session("wa"))
        await self.http.delete(f"/api/v1/page-templates/{t['id']}", headers=self.session("wa"))
        final = await self.doc(made["slug"])
        self.assertEqual((final["content"], final["title"]), (before["content"], "Monday"))


# ── Add a sub-page: the gallery reads the parent's workspace and folder (2026-11-05) ──────


class SubPageGallery(TemplateWorld):
    """``GET /page-templates/all?parent=``: every way to add a sub-page (the page's ⋯ menu,
    Pages inside, the sidebar's /pages/new?parent=, the workspace's own domain) offers the
    parent's workspace templates and its folder's default — to members of that workspace only."""

    async def gallery(self, parent: str, headers: dict, expect: int = 200, **params) -> dict:
        r = await self.http.get("/api/v1/page-templates/all", params={"parent": parent, **params},
                                headers=headers)
        self.assertEqual(r.status_code, expect, r.text)
        return r.json()

    async def world(self) -> None:
        self.f = await self.folder("Specs")
        self.t = await self.save((await self.create("wm", workspace=self.ws["W1"], title="Spec"))["slug"], "wm",
                                 name="Team spec")
        self.mine = await self.save((await self.create("wm", title="Mine"))["slug"], "wm", name="My notes")
        self.assertEqual(self.mine["scope"], "personal")
        await self.add_member("W2", "wm", "member")
        self.t2 = await self.save((await self.create("wm2", workspace=self.ws["W2"], title="Other"))["slug"],
                                  "wm2")
        r = await self.http.put(f"/api/v1/workspaces/{self.ws['W1']}/folders/{self.f}/default-template",
                                json={"template": self.t["id"]}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        self.P = await self.create("wm", workspace=self.ws["W1"], folder=self.f, title="Parent")
        self.C = await self.sub(self.P["slug"], "wm", title="Child")

    async def test_parent_gives_workspace_and_folder(self):
        await self.world()
        for parent in (self.P["slug"], self.C["slug"]):  # a sub-page of a sub-page too
            out = await self.gallery(parent, self.session("wm"))
            self.assertEqual([x["id"] for x in out["workspace"]], [self.t["id"]], parent)
            self.assertEqual((out["workspace_id"], out["workspace_name"]), (self.ws["W1"], "Acme"))
            self.assertEqual(out["folder"], {"id": self.f, "name": "Specs", "default_template": self.t["id"],
                                             "can_set_default": False})
            self.assertEqual([x["id"] for x in out["personal"]], [self.mine["id"]])
        self.assertTrue((await self.gallery(self.P["slug"], self.session("wa")))["folder"]["can_set_default"])
        # The same as naming the workspace and folder (what New page in that folder lists).
        named = await self.http.get("/api/v1/page-templates/all", params={"workspace": self.ws["W1"],
                                                                           "folder": self.f},
                                    headers=self.session("wm"))
        self.assertEqual(named.json()["workspace"], (await self.gallery(self.P["slug"], self.session("wm")))["workspace"])
        # Making the sub-page from it.
        made = await self.use(self.t["id"], "wm", parent=self.P["slug"], title="Search spec")
        self.assertEqual((made["template_id"], made["workspace_id"]), (self.t["id"], self.ws["W1"]))
        # The workspace named too: the parent's is fine, another is not.
        await self.gallery(self.P["slug"], self.session("wm"), workspace=self.ws["W1"])
        await self.gallery(self.P["slug"], self.session("wm"), 422, workspace=self.ws["W2"])

    async def test_no_workspace_templates_for_non_members(self):
        await self.world()
        await self.set_level(self.P["slug"], "link", "wm")
        # Readers who aren't members (a workspace viewer, someone outside it) see no workspace
        # templates, no folder, not even which workspace; their own personal ones still.
        mine2 = await self.save((await self.create("wm2", title="Theirs"))["slug"], "wm2")
        for who in ("wv", "wm2", "stranger"):
            out = await self.gallery(self.P["slug"], self.session(who))
            self.assertEqual((out["workspace"], out["folder"]), ([], None), who)
            self.assertFalse(out["can_save_workspace"], who)
            if who != "wv":
                self.assertIsNone(out["workspace_id"], who)
        self.assertEqual([x["id"] for x in (await self.gallery(self.P["slug"], self.session("wm2")))["personal"]],
                         [mine2["id"]])
        # A page they can't read: 404, as if it weren't there.
        await self.set_level(self.P["slug"], "private", "wm")
        for who in ("wm2", "stranger"):
            await self.gallery(self.P["slug"], self.session(who), 404)
        await self.gallery("no-such-page", self.session("wm"), 404)
        r = await self.http.get("/api/v1/page-templates/all", params={"parent": self.P["slug"]})
        self.assertEqual(r.status_code, 401)

    async def test_personal_parent(self):
        await self.world()
        U = await self.create("wm", title="Personal parent")
        out = await self.gallery(U["slug"], self.session("wm"))
        self.assertEqual((out["workspace"], out["workspace_id"], out["folder"]), ([], None, None))
        self.assertEqual([x["id"] for x in out["personal"]], [self.mine["id"]])
        self.assertEqual(out["builtin"][-1]["id"], "blank")

    async def test_sub_pages_start_blank_without_a_template(self):
        # The folder's default is preselected in the gallery (the app sends it as template); a
        # sub-page made with neither template nor content (the editor's /page block, the API)
        # starts blank, as before.
        await self.world()
        made = await self.sub(self.P["slug"], "wm", title="Blank inside")
        self.assertIsNone(made["template_id"])
        self.assertEqual(made["content"].strip(), "")

    async def test_tenant_domain_pinned(self):
        await self.world()
        h = self.tenant("wm", "W1")
        out = await self.gallery(self.P["slug"], h)
        self.assertEqual([x["id"] for x in out["workspace"]], [self.t["id"]])
        # Its own templates only: no personal ones (they stay on markdrop.in), nothing to manage.
        self.assertEqual(out["personal"], [])
        self.assertFalse(any(x["can_manage"] for x in out["workspace"]))
        self.assertFalse(out["can_save_workspace"] or out["can_reorder_workspace"])
        self.assertEqual(out["folder"]["default_template"], self.t["id"])
        self.assertFalse((await self.gallery(self.P["slug"], self.tenant("wa", "W1")))["folder"]["can_set_default"])
        # A parent of another workspace, or of none: 404. No parent: refused.
        X = await self.create("wm2", workspace=self.ws["W2"], title="W2 page")
        await self.set_level(X["slug"], "link", "wm2")
        U = await self.create("wm", title="Personal")
        for parent in (X["slug"], U["slug"]):
            await self.gallery(parent, h, 404)
        r = await self.http.get("/api/v1/page-templates/all", headers=h)
        self.assertEqual(r.status_code, 403, r.text)
        r = await self.http.get("/api/v1/page-templates/all", params={"workspace": self.ws["W2"]}, headers=h)
        self.assertEqual(r.status_code, 403, r.text)
        # From the wrong origin, or another workspace's token: nothing.
        r = await self.http.get("/api/v1/page-templates/all", params={"parent": self.P["slug"]},
                                headers=self.tenant("wm", "W1", origin="https://evil.test"))
        self.assertEqual(r.status_code, 401)
        await self.gallery(self.P["slug"], self.tenant("wm", "W2"), 404)
        # The preview: this workspace's templates only.
        r = await self.http.get(f"/api/v1/page-templates/{self.t['id']}", headers=h)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["can_manage"])
        for other in (self.t2["id"], self.mine["id"]):
            r = await self.http.get(f"/api/v1/page-templates/{other}", headers=h)
            self.assertEqual(r.status_code, 404, other)
        # Making the sub-page from it on the domain; another workspace's or a personal one: refused.
        r = await self.http.post("/api/v1/pages", json={"title": "On the domain", "parent": self.P["slug"],
                                                         "template": self.t["id"]}, headers=h)
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["document"]["template_id"], self.t["id"])
        self.assertIsNone(r.json()["edit_secret"])
        for other in (self.t2["id"], self.mine["id"], self.t2["slug"]):
            r = await self.http.post("/api/v1/pages", json={"title": "x", "parent": self.P["slug"],
                                                             "template": other}, headers=h)
            self.assertEqual(r.status_code, 403, other)
        # Managing templates stays on markdrop.in.
        for method, path, body in (("PATCH", f"/api/v1/page-templates/{self.t['id']}", {"name": "Taken"}),
                                   ("DELETE", f"/api/v1/page-templates/{self.t['id']}", None),
                                   ("PUT", "/api/v1/page-templates/order", {"workspace": self.ws["W1"],
                                                                            "ids": [self.t["id"]]}),
                                   ("PUT", f"/api/v1/workspaces/{self.ws['W1']}/folders/{self.f}/default-template",
                                    {"template": None})):
            r = await self.http.request(method, path, json=body, headers=self.tenant("wa", "W1"))
            self.assertEqual(r.status_code, 401, (method, path, r.text))

    async def test_mcp_list_for_a_parent(self):
        await self.world()
        out = await self.mcp_ok("wm", "list_page_templates", {"parent": self.P["slug"]})
        ids = [x["id"] for x in out["templates"]]
        self.assertIn(self.t["id"], ids)
        self.assertIn(self.mine["id"], ids)
        self.assertNotIn(self.t2["id"], ids)
        self.assertEqual(out["folder_default"], self.t["id"])
        self.assertIsNone((await self.mcp_ok("wm", "list_page_templates", {}))["folder_default"])
        self.assertIn("parent alone", await self.mcp_err("wm", "list_page_templates",
                                                         {"parent": self.P["slug"], "workspace": self.ws["W1"]}))
        await self.set_level(self.P["slug"], "private", "wm")
        await self.mcp_err("stranger", "list_page_templates", {"parent": self.P["slug"]})
