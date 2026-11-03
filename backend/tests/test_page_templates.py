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
