"""Pages (services/pages.py, services/page_assets.py, routers/pages.py): the block
editor's documents, sub-pages and their inherited access, page images, embeds
resolved for the viewer, the edit lock.

Runs in the access-policy world (tests/_access_env.py): the test MongoDB (or
mongomock), an in-memory R2. Never backend/.env.
"""

from __future__ import annotations

import asyncio
import io
import secrets
from datetime import datetime, timedelta, timezone

from tests._access_env import (  # noqa: F401  (pins settings first)
    ES_SECRET,
    ORIGIN,
    PASSWORD,
    AccessWorld,
    now,
)

import bcrypt
from bson import ObjectId

from app.services import access, lifecycle, live, page_assets, pages, publicity, tickets, viewers


def png(color=(200, 30, 30), size=(3, 2)) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


class PageWorld(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.db["page_assets"].create_index("doc_id")
        viewers.clear()
        # These tests build page trees through the API; per-IP limits aren't what they test.
        from app.limiter import limiter

        limiter.enabled = False
        self.addCleanup(setattr, limiter, "enabled", True)

    async def create(self, who: str = "owner", **body) -> dict:
        body.setdefault("title", "A page")
        r = await self.http.post("/api/v1/pages", json=body, headers=self.session(who))
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["document"]

    async def sub(self, parent: str, who: str = "owner", **body) -> dict:
        return await self.create(who, parent=parent, **body)

    async def upload(self, slug: str, headers: dict, data: bytes | None = None, name: str = "a.png"):
        return await self.http.post(f"/api/v1/documents/{slug}/assets",
                                    files={"file": (name, data if data is not None else png(), "image/png")},
                                    headers=headers)

    async def set_level(self, slug: str, level: str, who: str = "owner"):
        r = await self.http.put(f"/api/v1/documents/{slug}/access/level", json={"level": level},
                                headers=self.session(who))
        self.assertEqual(r.status_code, 204, r.text)

    async def status(self, slug: str, headers: dict) -> tuple[int, str | None]:
        r = await self.get(slug, headers)
        return r.status_code, r.headers.get("x-markdrop-gate")


# ── Creating pages, templates, the editor switch ──────────────────────────────


class Create(PageWorld):
    async def test_templates_listed_with_block_syntax(self):
        r = await self.http.get("/api/v1/page-templates")
        self.assertEqual(r.status_code, 200)
        ids = [t["id"] for t in r.json()]
        self.assertEqual(ids, ["feature-guide", "customer-howto", "qa-test-plan", "prd", "meeting-notes",
                               "runbook", "blank"])
        for t in r.json():
            self.assertEqual(set(t), {"id", "name", "description", "icon", "category", "content"})
        prd = next(t for t in r.json() if t["id"] == "prd")["content"]
        self.assertIn(":::note", prd)
        self.assertIn(":::details{summary=", prd)
        self.assertIn("- [ ]", prd)

    async def test_create_needs_sign_in(self):
        r = await self.http.post("/api/v1/pages", json={"title": "x"})
        self.assertEqual(r.status_code, 401)

    async def test_create_personal_from_template(self):
        r = await self.http.post("/api/v1/pages", json={"title": "Launch", "template": "feature-guide"},
                                 headers=self.session("owner"))
        self.assertEqual(r.status_code, 201, r.text)
        body = r.json()
        doc = body["document"]
        self.assertTrue(body["edit_secret"])
        self.assertEqual(doc["editor"], "blocks")
        self.assertEqual(doc["template_id"], "feature-guide")
        self.assertEqual(doc["title"], "Launch")
        self.assertNotIn("{{date}}", doc["content"])
        self.assertIn("**Launch**", doc["content"])  # {{title}}
        self.assertIsNone(doc["parent"])
        self.assertEqual(doc["children_count"], 0)
        self.assertEqual(doc["breadcrumbs"], [])
        self.assertIsNone(doc["access_inherit"])
        self.assertEqual(doc["access_level"], "link")
        g = await self.get(doc["slug"])
        self.assertEqual(g.status_code, 200)
        self.assertEqual(g.json()["editor"], "blocks")

    async def test_blank_and_content(self):
        blank = await self.create(template="blank")
        self.assertEqual(blank["content"].strip(), "")
        own = await self.create(content="# Hi\n\n:::tip\nyes\n:::\n")
        self.assertIn(":::tip", own["content"])
        self.assertIsNone(own["template_id"])

    async def test_unknown_template_422(self):
        r = await self.http.post("/api/v1/pages", json={"title": "x", "template": "nope"},
                                 headers=self.session("owner"))
        self.assertEqual(r.status_code, 422)

    async def test_create_in_workspace_needs_member(self):
        doc = await self.create("wm", workspace=self.ws["W1"])
        self.assertEqual(doc["workspace_id"], self.ws["W1"])
        raw = await self.doc(doc["slug"])
        self.assertEqual(raw["owner_id"], self.uid["wm"])
        for who, code in (("wv", 403), ("stranger", 404), ("wm2", 404)):
            r = await self.http.post("/api/v1/pages", json={"title": "x", "workspace": self.ws["W1"]},
                                     headers=self.session(who))
            self.assertIn(r.status_code, (403, 404), (who, r.text))
        self.assertEqual(await self.db["documents"].count_documents({"title": "x"}), 0)

    async def test_create_in_folder(self):
        from app.services import folder as folder_service

        fid, _ = await folder_service.ensure_path(self.db, self.ws["W1"], "guides/setup")
        doc = await self.create("wm", workspace=self.ws["W1"], folder="guides/setup")
        raw = await self.doc(doc["slug"])
        self.assertEqual(raw["folder_id"], fid)
        self.assertEqual(doc["folder_path"], ["guides", "setup"])
        self.assertTrue(doc["workspace_url"].endswith(f"/guides/setup/{doc['slug']}"))

    async def test_sub_page_inherits_parent(self):
        from app.services import folder as folder_service

        fid, _ = await folder_service.ensure_path(self.db, self.ws["W1"], "guides")
        parent = await self.create("wm", workspace=self.ws["W1"], folder="guides")
        child = await self.sub(parent["slug"], "wm", title="Child", template="runbook")
        raw = await self.doc(child["slug"])
        self.assertEqual(raw["parent_id"], ObjectId((await self.doc(parent["slug"]))["_id"]))
        self.assertTrue(raw["access_inherit"])
        self.assertEqual(raw["page_path"], [parent["slug"]])
        self.assertEqual(raw["workspace_id"], self.ws["W1"])
        self.assertEqual(raw["folder_id"], fid)
        self.assertEqual(raw["access_level"], (await self.doc(parent["slug"]))["access_level"])
        self.assertEqual(child["parent"], {"slug": parent["slug"], "title": parent["title"]})
        self.assertEqual(child["breadcrumbs"], [{"slug": parent["slug"], "title": parent["title"]}])
        self.assertTrue(child["access_inherit"])
        # Its address on the custom domain: folders, then the parent's slug.
        self.assertEqual(child["folder_path"], ["guides", parent["slug"]])
        self.assertEqual(child["workspace_url"], f"https://docs.acme.test/guides/{parent['slug']}/{child['slug']}")
        g = (await self.get(parent["slug"], self.session("wm"))).json()
        self.assertEqual(g["children_count"], 1)

    async def test_sub_page_needs_edit_on_parent(self):
        parent = await self.mkdoc("P", ws=None)  # gv viewer, ge editor
        r = await self.http.post("/api/v1/pages", json={"title": "x", "parent": parent["slug"]},
                                 headers=self.session("gv"))
        self.assertEqual(r.status_code, 403)
        r = await self.http.post("/api/v1/pages", json={"title": "x", "parent": parent["slug"]},
                                 headers=self.session("stranger"))
        self.assertEqual(r.status_code, 404)
        r = await self.http.post("/api/v1/pages", json={"title": "x", "parent": "no-such-page"},
                                 headers=self.session("owner"))
        self.assertEqual(r.status_code, 404)
        child = await self.sub(parent["slug"], "ge")
        self.assertEqual((await self.doc(child["slug"]))["owner_id"], self.uid["ge"])

    async def test_sub_page_parent_rules(self):
        parent = await self.mkdoc("W")
        r = await self.http.post("/api/v1/pages", json={"title": "x", "parent": parent["slug"],
                                                        "workspace": self.ws["W2"]},
                                 headers=self.session("owner"))
        self.assertEqual(r.status_code, 422)
        enc = await self.mkdoc("UL", encrypted=True, content="mdx1.aaaaaaaaaaaaaaaaaaaa.bbbb")
        r = await self.http.post("/api/v1/pages", json={"title": "x", "parent": enc["slug"]},
                                 headers=self.session("owner"))
        self.assertEqual(r.status_code, 422)
        art = await self.mkdoc("UL", kind="artifact")
        r = await self.http.post("/api/v1/pages", json={"title": "x", "parent": art["slug"]},
                                 headers=self.session("owner"))
        self.assertEqual(r.status_code, 422)
        # A grantee editor who isn't a member can't add to a workspace page.
        r = await self.http.post("/api/v1/pages", json={"title": "x", "parent": parent["slug"]},
                                 headers=self.session("ge"))
        self.assertEqual(r.status_code, 403)

    async def test_depth_limit(self):
        top = await self.create()
        slug = top["slug"]
        for _ in range(access.MAX_PAGE_DEPTH - 1):
            slug = (await self.sub(slug))["slug"]
        r = await self.http.post("/api/v1/pages", json={"title": "x", "parent": slug},
                                 headers=self.session("owner"))
        self.assertEqual(r.status_code, 422)

    async def test_editor_switch(self):
        d = await self.mkdoc("UL")
        url = f"/api/v1/documents/{d['slug']}/editor"
        r = await self.http.put(url, json={"editor": "blocks"}, headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["editor"], "blocks")
        self.assertEqual((await self.doc(d["slug"]))["content"], d["content"])
        r = await self.http.put(url, json={"editor": "classic"}, headers=self.session("owner"))
        self.assertIsNone(r.json()["editor"])
        # An editor may switch; a viewer may not; a stranger learns nothing.
        self.assertEqual((await self.http.put(url, json={"editor": "blocks"}, headers=self.session("ge"))).status_code, 200)
        self.assertEqual((await self.http.put(url, json={"editor": "blocks"}, headers=self.session("gv"))).status_code, 403)
        # A link document: a stranger can read it (so learns it exists) but not switch it.
        self.assertEqual((await self.http.put(url, json={"editor": "blocks"}, headers=self.session("stranger"))).status_code, 403)
        self.assertEqual((await self.http.put(url, json={"editor": "blocks"})).status_code, 401)
        private = await self.mkdoc("UP")
        self.assertEqual((await self.http.put(f"/api/v1/documents/{private['slug']}/editor", json={"editor": "blocks"},
                                              headers=self.session("stranger"))).status_code, 404)
        self.assertEqual((await self.http.put(url, json={"editor": "blocks"},
                                              headers={"X-Edit-Secret": ES_SECRET})).status_code, 200)
        self.assertEqual((await self.http.put(url, json={"editor": "x"}, headers=self.session("owner"))).status_code, 422)

    async def test_editor_switch_refused_for_encrypted_and_files(self):
        enc = await self.mkdoc("UL", encrypted=True, content="mdx1.aaaaaaaaaaaaaaaaaaaa.bbbb")
        r = await self.http.put(f"/api/v1/documents/{enc['slug']}/editor", json={"editor": "blocks"},
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 422)
        art = await self.mkdoc("UL", kind="artifact")
        r = await self.http.put(f"/api/v1/documents/{art['slug']}/editor", json={"editor": "blocks"},
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 422)

    async def test_tenant_token_cannot_create_or_switch(self):
        d = await self.mkdoc("W")
        r = await self.http.put(f"/api/v1/documents/{d['slug']}/editor", json={"editor": "blocks"},
                                headers=self.tenant("wm", "W1"))
        self.assertEqual(r.status_code, 401)
        r = await self.http.post("/api/v1/pages", json={"title": "x"}, headers=self.tenant("wm", "W1"))
        self.assertEqual(r.status_code, 401)


# ── Inherited access: the read matrix ─────────────────────────────────────────

ACTORS = ("OW", "GV", "GE", "WV", "WM", "WA", "WO", "ST", "AN", "FM", "IN", "TS", "TX", "AT")
STATES = ("L", "LP", "P", "W", "RL", "RLP", "RP", "RW", "UL", "ULP", "UP")


class InheritMatrix(PageWorld):
    async def _family(self, state: str) -> tuple[dict, dict, dict]:
        parent = await self.mkdoc(state)
        child = await self.sub(parent["slug"])
        grandchild = await self.sub(child["slug"])
        return parent, child, grandchild

    async def test_read_parity_every_state_and_actor(self):
        """A sub-page (and its sub-page) answers every reader exactly as its parent does."""
        for state in STATES:
            parent, child, grand = await self._family(state)
            for actor in ACTORS:
                h = await self.headers(actor, parent)
                want = await self.status(parent["slug"], h)
                self.assertEqual(await self.status(child["slug"], h), want, (state, actor))
                self.assertEqual(await self.status(grand["slug"], h), want, (state, actor))
                if state.endswith("LP"):
                    hp = {**h, "X-Read-Password": PASSWORD}
                    want = await self.status(parent["slug"], hp)
                    self.assertEqual(await self.status(child["slug"], hp), want, (state, actor, "pw"))
                    self.assertEqual(await self.status(grand["slug"], hp), want, (state, actor, "pw"))

    async def test_edit_parity(self):
        """Editors of the parent (grant or membership) edit its sub-pages; viewers don't."""
        for state in ("P", "W", "UP"):
            parent, child, _g = await self._family(state)
            raw = await self.doc(child["slug"])
            for actor in ("GE", "GV", "WM", "WV", "ST"):
                h = await self.headers(actor, parent)
                pd = await access.can(access.Actor.of(await self._user(actor)), await self.doc(parent["slug"]),
                                      "edit_content", access.Ctx(self.db))
                cd = await access.can(access.Actor.of(await self._user(actor)), raw, "edit_content",
                                      access.Ctx(self.db))
                self.assertEqual((pd.allowed, pd.status), (cd.allowed, cd.status), (state, actor))
                r = await self.http.put(f"/api/v1/documents/{child['slug']}",
                                        json={"title": "t", "content": "# edited"}, headers=h)
                self.assertEqual(r.status_code, 200 if cd.allowed else cd.status, (state, actor, r.text))

    async def _user(self, actor: str):
        from app.services import user as user_service

        name = {"GE": "ge", "GV": "gv", "WM": "wm", "WV": "wv", "ST": "stranger"}[actor]
        return await user_service.get_user_by_id(self.db, self.uid[name])

    async def test_parent_owner_reads_and_edits_childs_owned_by_others(self):
        parent = await self.mkdoc("UP")
        child = await self.sub(parent["slug"], "ge")  # ge owns the child
        r = await self.get(child["slug"], self.session("owner"))
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["can"]["edit"])
        self.assertFalse(r.json()["can"]["delete"])  # the parent's owner isn't the child's owner
        self.assertFalse(r.json()["is_owner"])

    async def test_child_grants_are_additive(self):
        parent = await self.mkdoc("UP", grants=False)
        child = await self.sub(parent["slug"])
        r = await self.http.post(f"/api/v1/documents/{child['slug']}/access/people",
                                 json={"email": self.email["stranger"], "role": "viewer"},
                                 headers=self.session("owner"))
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual((await self.get(child["slug"], self.session("stranger"))).status_code, 200)
        self.assertEqual((await self.get(parent["slug"], self.session("stranger"))).status_code, 404)
        self.assertTrue((await self.doc(child["slug"])).get("access_inherit"))

    async def test_wrong_password_counts_against_the_source(self):
        parent = await self.mkdoc("ULP")
        child = await self.sub(parent["slug"])
        r = await self.get(child["slug"], {"X-Read-Password": "wrong"})
        self.assertEqual(r.status_code, 403)
        for _ in range(10):
            await self.get(child["slug"], {"X-Read-Password": "wrong"})
        # The budget is the parent's: the parent is locked out too.
        self.assertEqual((await self.get(parent["slug"], {"X-Read-Password": PASSWORD})).status_code, 429)

    async def test_dangling_parent_fails_closed(self):
        parent = await self.mkdoc("UL")
        child = await self.sub(parent["slug"])
        await self.db["documents"].delete_one({"_id": parent["_id"]})  # not through destroy
        self.assertEqual((await self.get(child["slug"])).status_code, 401)
        self.assertEqual((await self.get(child["slug"], self.session("stranger"))).status_code, 404)
        self.assertEqual((await self.get(child["slug"], self.session("owner"))).status_code, 200)

    async def test_cycle_and_too_deep_fail_closed(self):
        a = await self.mkdoc("UL")
        b = await self.mkdoc("UL", parent_id=a["_id"], access_inherit=True)
        await self.db["documents"].update_one({"_id": a["_id"]}, {"$set": {"parent_id": b["_id"],
                                                                         "access_inherit": True}})
        self.assertEqual((await self.get(b["slug"])).status_code, 401)
        self.assertEqual((await self.get(b["slug"], self.session("owner"))).status_code, 200)
        # A chain deeper than MAX_PAGE_DEPTH: the bottom page reads as private.
        top = await self.mkdoc("UL")
        prev = top
        for _ in range(access.MAX_PAGE_DEPTH + 1):
            prev = await self.mkdoc("UL", parent_id=prev["_id"], access_inherit=True)
        self.assertEqual((await self.get(prev["slug"])).status_code, 401)

    async def test_tenant_scope_follows_the_source(self):
        parent = await self.mkdoc("W")
        child = await self.sub(parent["slug"])
        self.assertEqual((await self.get(child["slug"], self.tenant("wm", "W1"))).status_code, 200)
        self.assertEqual((await self.get(child["slug"], self.tenant("wm2", "W2"))).status_code, 404)
        self.assertEqual((await self.get(child["slug"], {"X-Markdrop-Workspace": self.ws["W2"]})).status_code, 404)


# ── Changes above a sub-page reach it ─────────────────────────────────────────


class InheritChanges(PageWorld):
    async def test_parent_narrowing_revokes_child_tickets_and_sockets(self):
        parent = await self.mkdoc("UL")
        child = await self.sub(parent["slug"])
        grand = await self.sub(child["slug"])
        old = await self.doc(grand["slug"])
        ticket = (await self.get(grand["slug"])).json()["read_ticket"]
        self.assertTrue(tickets.valid_for(ticket, old))
        q = live.subscribe(grand["slug"])
        try:
            await self.set_level(parent["slug"], "private")
            new = await self.doc(grand["slug"])
            self.assertEqual(new["access_level"], "private")
            self.assertGreater(new["access_epoch"], old["access_epoch"])
            self.assertFalse(tickets.valid_for(ticket, new))
            self.assertIn({"type": "access"}, [q.get_nowait() for _ in range(q.qsize())])
        finally:
            live.unsubscribe(grand["slug"], q)
        self.assertEqual((await self.get(grand["slug"])).status_code, 401)
        self.assertEqual((await self.get(grand["slug"], self.session("gv"))).status_code, 200)  # grant on the top
        await self.set_level(parent["slug"], "link")
        self.assertEqual((await self.get(grand["slug"])).status_code, 200)
        self.assertEqual((await self.doc(grand["slug"]))["access_level"], "link")

    async def test_parent_password_reaches_children(self):
        parent = await self.mkdoc("UL")
        child = await self.sub(parent["slug"])
        r = await self.http.patch(f"/api/v1/documents/{parent['slug']}/settings",
                                  json={"read_password": "s3cret"}, headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        r = await self.get(child["slug"])
        self.assertEqual((r.status_code, r.headers.get("x-markdrop-gate")), (401, "password"))
        self.assertEqual((await self.get(child["slug"], {"X-Read-Password": "s3cret"})).status_code, 200)
        self.assertTrue((await self.get(child["slug"])).status_code == 401)
        r = await self.http.patch(f"/api/v1/documents/{parent['slug']}/settings",
                                  json={"remove_password": True}, headers=self.session("owner"))
        self.assertEqual((await self.get(child["slug"])).status_code, 200)
        self.assertIsNone((await self.doc(child["slug"]))["read_password_hash"])

    async def test_require_auth_reaches_children(self):
        parent = await self.mkdoc("L")
        child = await self.sub(parent["slug"])
        self.assertEqual((await self.get(child["slug"])).status_code, 200)
        await self.db["workspaces"].update_one({"_id": ObjectId(self.ws["W1"])},
                                               {"$set": {"settings.require_auth_to_view": True,
                                                         "require_auth_applied": False}})
        await lifecycle.sync_require_auth(self.db, self.ws["W1"])
        self.assertEqual((await self.get(child["slug"])).status_code, 401)
        self.assertEqual((await self.get(child["slug"], self.session("wv"))).status_code, 200)

    async def test_grant_removal_on_parent_reaches_children(self):
        parent = await self.mkdoc("UP")
        child = await self.sub(parent["slug"])
        self.assertEqual((await self.get(child["slug"], self.session("gv"))).status_code, 200)
        q = live.subscribe(child["slug"])
        try:
            r = await self.http.delete(f"/api/v1/documents/{parent['slug']}/access/people/{self.email['gv']}",
                                       headers=self.session("owner"))
            self.assertEqual(r.status_code, 204)
            self.assertEqual(q.get_nowait(), {"type": "access"})
        finally:
            live.unsubscribe(child["slug"], q)
        self.assertEqual((await self.get(child["slug"], self.session("gv"))).status_code, 404)

    async def test_access_set_on_the_child_stops_inheriting(self):
        parent = await self.mkdoc("UL")
        child = await self.sub(parent["slug"])
        await self.set_level(child["slug"], "private")
        raw = await self.doc(child["slug"])
        self.assertIs(raw["access_inherit"], False)
        self.assertEqual((await self.get(child["slug"])).status_code, 401)
        # The parent's changes no longer reach it.
        await self.set_level(parent["slug"], "private")
        await self.set_level(parent["slug"], "link")
        self.assertEqual((await self.doc(child["slug"]))["access_level"], "private")
        self.assertFalse((await self.get(child["slug"], self.session("owner"))).json()["access_inherit"])

    async def test_password_on_the_child_stops_inheriting(self):
        parent = await self.mkdoc("UL")
        child = await self.sub(parent["slug"])
        r = await self.http.patch(f"/api/v1/documents/{child['slug']}/settings",
                                  json={"read_password": "kid"}, headers=self.session("owner"))
        self.assertEqual(r.status_code, 200)
        self.assertIs((await self.doc(child["slug"]))["access_inherit"], False)
        self.assertEqual((await self.get(child["slug"], {"X-Read-Password": "kid"})).status_code, 200)
        self.assertEqual((await self.get(parent["slug"])).status_code, 200)

    async def test_set_level_same_level_on_inheriting_child_still_takes_ownership(self):
        parent = await self.mkdoc("UL")
        child = await self.sub(parent["slug"])
        await self.set_level(child["slug"], "link")
        self.assertIs((await self.doc(child["slug"]))["access_inherit"], False)
        await self.set_level(parent["slug"], "private")
        self.assertEqual((await self.get(child["slug"])).status_code, 200)

    async def test_non_owner_cannot_set_child_access(self):
        parent = await self.mkdoc("UL")
        child = await self.sub(parent["slug"], "ge")
        r = await self.http.put(f"/api/v1/documents/{child['slug']}/access/level", json={"level": "private"},
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 403)

    async def test_parent_unshared_from_workspace_takes_children_along(self):
        parent = await self.mkdoc("W")
        child = await self.sub(parent["slug"])
        own = await self.sub(parent["slug"])
        await self.set_level(own["slug"], "link")  # own access: link inside W1
        r = await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/documents/{parent['_id']}",
                                   headers=self.session("owner"))
        self.assertIn(r.status_code, (200, 204), r.text)
        c = await self.doc(child["slug"])
        self.assertIsNone(c["workspace_id"])
        self.assertEqual(c["access_level"], "private")  # inherited the parent's conversion
        o = await self.doc(own["slug"])
        self.assertIsNone(o["workspace_id"])
        self.assertEqual(o["access_level"], "link")  # leaving W1 (no sign-in rule) keeps link
        self.assertEqual((await self.get(child["slug"], self.session("wm"))).status_code, 404)

    async def test_sub_page_cannot_be_refiled_alone(self):
        from app.services import folder as folder_service

        await folder_service.ensure_path(self.db, self.ws["W1"], "other")
        parent = await self.mkdoc("W")
        child = await self.sub(parent["slug"])
        fid = (await self.db["folders"].find_one({"workspace_id": self.ws["W1"]}))["_id"]
        raw = await self.doc(child["slug"])
        r = await self.http.put(f"/api/v1/workspaces/{self.ws['W1']}/documents/{raw['_id']}/folder",
                                json={"folder_id": str(fid)}, headers=self.session("owner"))
        self.assertEqual(r.status_code, 409, r.text)

    async def test_parent_refiled_moves_children(self):
        from app.services import folder as folder_service

        fid, _ = await folder_service.ensure_path(self.db, self.ws["W1"], "moved")
        parent = await self.mkdoc("W")
        child = await self.sub(parent["slug"])
        await folder_service.file_document(self.db, await self.doc(parent["slug"]), self.ws["W1"], fid)
        c = await self.doc(child["slug"])
        self.assertEqual(c["folder_id"], fid)
        self.assertEqual(c["folder_path"], ["moved"])

    async def test_rename_parent_updates_child_address(self):
        parent = await self.mkdoc("W")
        child = await self.sub(parent["slug"])
        grand = await self.sub(child["slug"])
        r = await self.http.patch(f"/api/v1/documents/{parent['slug']}/slug", json={"new_slug": "renamed-top"},
                                  headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self.doc(child["slug"]))["page_path"], ["renamed-top"])
        self.assertEqual((await self.doc(grand["slug"]))["page_path"], ["renamed-top", child["slug"]])

    async def test_listings_see_the_inherited_level(self):
        parent = await self.mkdoc("P")
        child = await self.sub(parent["slug"])
        r = await self.http.get(f"/api/v1/workspaces/{self.ws['W1']}/items", headers=self.session("wm"))
        if r.status_code == 200:
            slugs = [i["slug"] for i in r.json()["items"]]
            self.assertNotIn(child["slug"], slugs)
        await self.set_level(parent["slug"], "workspace")
        self.assertEqual((await self.doc(child["slug"]))["access_level"], "workspace")


# ── Children listing, breadcrumbs ─────────────────────────────────────────────


class Tree(PageWorld):
    async def test_children_filtered_to_readable(self):
        parent = await self.mkdoc("UL")
        a = await self.sub(parent["slug"], title="A")
        b = await self.sub(parent["slug"], title="B")
        await self.set_level(b["slug"], "private")
        await self.sub(a["slug"], title="A1")
        r = await self.http.get(f"/api/v1/documents/{parent['slug']}/children")
        self.assertEqual(r.status_code, 200)
        self.assertEqual([c["slug"] for c in r.json()], [a["slug"]])
        self.assertEqual(r.json()[0], {"slug": a["slug"], "title": "A", "editor": "blocks",
                                       "updated_at": r.json()[0]["updated_at"], "has_children": True,
                                       "access_inherit": True})
        r = await self.http.get(f"/api/v1/documents/{parent['slug']}/children", headers=self.session("owner"))
        self.assertEqual([c["slug"] for c in r.json()], [a["slug"], b["slug"]])
        self.assertFalse(r.json()[1]["access_inherit"])
        self.assertEqual((await self.get(parent["slug"])).json()["children_count"], 1)
        self.assertEqual((await self.get(parent["slug"], self.session("owner"))).json()["children_count"], 2)

    async def test_children_of_unreadable_page(self):
        parent = await self.mkdoc("UP")
        await self.sub(parent["slug"])
        self.assertEqual((await self.http.get(f"/api/v1/documents/{parent['slug']}/children")).status_code, 401)
        self.assertEqual((await self.http.get(f"/api/v1/documents/{parent['slug']}/children",
                                              headers=self.session("stranger"))).status_code, 404)
        r = await self.http.get(f"/api/v1/documents/{parent['slug']}/children", headers=self.tenant("wm", "W1"))
        self.assertEqual(r.status_code, 404)  # allowed route, but outside its scope (unfiled)

    async def test_children_tenant_allowed(self):
        parent = await self.mkdoc("W")
        await self.sub(parent["slug"])
        r = await self.http.get(f"/api/v1/documents/{parent['slug']}/children", headers=self.tenant("wm", "W1"))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()), 1)

    async def test_breadcrumbs_only_readable_ancestors(self):
        top = await self.mkdoc("UL")
        mid = await self.sub(top["slug"], title="Mid")
        await self.set_level(top["slug"], "private")
        await self.set_level(mid["slug"], "link")  # mid has its own (link) access now
        leaf = await self.sub(mid["slug"], title="Leaf")
        body = (await self.get(leaf["slug"])).json()
        self.assertEqual(body["breadcrumbs"], [{"slug": mid["slug"], "title": "Mid"}])
        self.assertEqual(body["parent"], {"slug": mid["slug"], "title": "Mid"})
        body = (await self.get(mid["slug"])).json()
        self.assertIsNone(body["parent"])  # the private top isn't named to a stranger
        self.assertEqual(body["breadcrumbs"], [])
        body = (await self.get(leaf["slug"], self.session("owner"))).json()
        self.assertEqual([b["slug"] for b in body["breadcrumbs"]], [top["slug"], mid["slug"]])


# ── Moving ────────────────────────────────────────────────────────────────────


class Move(PageWorld):
    async def put_parent(self, slug, parent, who="owner", **kw):
        return await self.http.put(f"/api/v1/documents/{slug}/parent", json={"parent": parent, **kw},
                                   headers=self.session(who))

    async def test_move_same_audience_needs_no_confirmation(self):
        a = await self.mkdoc("UL", grants=False)
        b = await self.mkdoc("UL", grants=False)
        child = await self.sub(a["slug"])
        grand = await self.sub(child["slug"])
        r = await self.put_parent(child["slug"], b["slug"])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["parent"]["slug"], b["slug"])
        self.assertEqual((await self.doc(grand["slug"]))["page_path"], [b["slug"], child["slug"]])

    async def test_move_that_changes_readers_needs_confirmation(self):
        public = await self.mkdoc("UL", grants=False)
        private = await self.mkdoc("UP", grants=False)
        child = await self.sub(public["slug"])
        grand = await self.sub(child["slug"])
        r = await self.put_parent(child["slug"], private["slug"])
        self.assertEqual(r.status_code, 409)
        body = r.json()
        self.assertEqual(body["code"], "access_change")
        self.assertEqual(body["readers_before"], "anyone with the link")
        self.assertEqual(body["readers_after"], "only its owner")
        self.assertIsNone((await self.doc(child["slug"]))["parent_id"] if False else None)
        self.assertEqual((await self.get(child["slug"])).status_code, 200)  # unchanged
        old_epoch = (await self.doc(grand["slug"]))["access_epoch"]
        r = await self.put_parent(child["slug"], private["slug"], confirm_access_change=True)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self.get(child["slug"])).status_code, 401)
        self.assertEqual((await self.get(grand["slug"])).status_code, 401)
        self.assertGreater((await self.doc(grand["slug"]))["access_epoch"], old_epoch)

    async def test_only_owner_may_change_readers_by_moving(self):
        public = await self.mkdoc("UL")
        private = await self.mkdoc("UP")
        child = await self.sub(public["slug"])  # owned by owner; ge edits it through the parent's grant
        r = await self.put_parent(child["slug"], private["slug"], "ge", confirm_access_change=True)
        self.assertEqual(r.status_code, 403)

    async def test_move_refusals(self):
        a = await self.mkdoc("UL")
        child = await self.sub(a["slug"])
        grand = await self.sub(child["slug"])
        self.assertEqual((await self.put_parent(child["slug"], child["slug"])).status_code, 422)
        self.assertEqual((await self.put_parent(child["slug"], grand["slug"])).status_code, 422)
        w2 = await self.mkdoc("W", owner="wm2", ws="W2")
        self.assertEqual((await self.put_parent(child["slug"], w2["slug"])).status_code, 404)
        w1 = await self.mkdoc("L")
        self.assertEqual((await self.put_parent(child["slug"], w1["slug"])).status_code, 422)  # other workspace
        readonly = await self.mkdoc("UL", owner="wm")
        self.assertEqual((await self.put_parent(child["slug"], readonly["slug"], "gv")).status_code, 403)
        art = await self.mkdoc("UL", kind="artifact")
        self.assertEqual((await self.put_parent(child["slug"], art["slug"])).status_code, 422)
        self.assertEqual((await self.http.put(f"/api/v1/documents/{child['slug']}/parent",
                                              json={"parent": None})).status_code, 401)
        self.assertEqual((await self.put_parent(child["slug"], None, "stranger")).status_code, 403)  # can read
        hidden = await self.sub((await self.mkdoc("UP"))["slug"])
        self.assertEqual((await self.put_parent(hidden["slug"], None, "stranger")).status_code, 404)

    async def test_move_to_top_keeps_access_but_loses_inherited_grants(self):
        parent = await self.mkdoc("UP")  # gv / ge granted on the parent
        child = await self.sub(parent["slug"])
        r = await self.put_parent(child["slug"], None)
        self.assertEqual(r.status_code, 409)
        self.assertIn("2 people", r.json()["readers_before"])
        r = await self.put_parent(child["slug"], None, confirm_access_change=True)
        self.assertEqual(r.status_code, 200, r.text)
        raw = await self.doc(child["slug"])
        self.assertIsNone(raw["parent_id"])
        self.assertEqual(raw["page_path"], [])
        self.assertEqual(raw["access_level"], "private")
        self.assertEqual((await self.get(child["slug"], self.session("gv"))).status_code, 404)

    async def test_move_top_level_page_inside_starts_inheriting(self):
        parent = await self.mkdoc("UP", grants=False)
        page = await self.create()  # link
        r = await self.put_parent(page["slug"], parent["slug"], confirm_access_change=True)
        self.assertEqual(r.status_code, 200)
        self.assertTrue((await self.doc(page["slug"]))["access_inherit"])
        self.assertEqual((await self.get(page["slug"])).status_code, 401)


# ── Deleting a page with sub-pages ────────────────────────────────────────────


class Delete(PageWorld):
    async def test_needs_children_mode(self):
        parent = await self.mkdoc("UL")
        await self.sub(parent["slug"])
        await self.sub(parent["slug"])
        r = await self.http.delete(f"/api/v1/documents/{parent['slug']}", headers=self.session("owner"))
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["code"], "has_children")
        self.assertEqual(r.json()["count"], 2)
        self.assertIsNotNone(await self.doc(parent["slug"]))
        r = await self.http.delete(f"/api/v1/documents/{parent['slug']}?children=nope",
                                   headers=self.session("owner"))
        self.assertEqual(r.status_code, 422)

    async def test_delete_with_children(self):
        parent = await self.mkdoc("UL")
        child = await self.sub(parent["slug"])
        grand = await self.sub(child["slug"])
        r = await self.http.delete(f"/api/v1/documents/{parent['slug']}?children=delete",
                                   headers=self.session("owner"))
        self.assertEqual(r.status_code, 204)
        for d in (parent, child, grand):
            self.assertIsNone(await self.doc(d["slug"]))

    async def test_delete_refused_when_someone_elses_sub_page(self):
        parent = await self.mkdoc("UL")
        theirs = await self.sub(parent["slug"], "ge")
        r = await self.http.delete(f"/api/v1/documents/{parent['slug']}?children=delete",
                                   headers=self.session("owner"))
        self.assertEqual(r.status_code, 403)
        self.assertIsNotNone(await self.doc(theirs["slug"]))
        self.assertIsNotNone(await self.doc(parent["slug"]))

    async def test_lift_keeps_access(self):
        top = await self.mkdoc("UL", grants=False)
        mid = await self.sub(top["slug"])
        await self.set_level(mid["slug"], "private")  # mid is the source for its children
        leaf = await self.sub(mid["slug"])
        leaf2 = await self.sub(leaf["slug"])
        r = await self.http.delete(f"/api/v1/documents/{mid['slug']}?children=lift",
                                   headers=self.session("owner"))
        self.assertEqual(r.status_code, 204)
        raw = await self.doc(leaf["slug"])
        self.assertEqual(raw["parent_id"], top["_id"])
        self.assertIs(raw["access_inherit"], False)
        self.assertEqual(raw["page_path"], [top["slug"]])
        self.assertEqual((await self.doc(leaf2["slug"]))["page_path"], [top["slug"], leaf["slug"]])
        # It stays private (it doesn't start inheriting the link-level top).
        self.assertEqual((await self.get(leaf["slug"])).status_code, 401)
        self.assertEqual((await self.get(leaf2["slug"])).status_code, 401)

    async def test_lift_of_inheriting_page_keeps_inheriting(self):
        top = await self.mkdoc("UP", grants=False)
        mid = await self.sub(top["slug"])
        leaf = await self.sub(mid["slug"])
        r = await self.http.delete(f"/api/v1/documents/{mid['slug']}?children=lift",
                                   headers=self.session("owner"))
        self.assertEqual(r.status_code, 204)
        raw = await self.doc(leaf["slug"])
        self.assertEqual(raw["parent_id"], top["_id"])
        self.assertTrue(raw["access_inherit"])
        await self.set_level(top["slug"], "link")
        self.assertEqual((await self.get(leaf["slug"])).status_code, 200)

    async def test_lift_top_level(self):
        top = await self.mkdoc("UP", grants=False)
        leaf = await self.sub(top["slug"])
        r = await self.http.delete(f"/api/v1/documents/{top['slug']}?children=lift",
                                   headers=self.session("owner"))
        self.assertEqual(r.status_code, 204)
        raw = await self.doc(leaf["slug"])
        self.assertIsNone(raw["parent_id"])
        self.assertEqual(raw["access_level"], "private")
        self.assertEqual((await self.get(leaf["slug"])).status_code, 401)

    async def test_expiry_lifts(self):
        top = await self.mkdoc("UP", grants=False)
        leaf = await self.sub(top["slug"])
        await self.db["documents"].update_one({"_id": top["_id"]},
                                              {"$set": {"expires_at": now() - timedelta(seconds=5)}})
        self.assertEqual(await lifecycle.sweep_expired(self.db), 1)
        raw = await self.doc(leaf["slug"])
        self.assertIsNone(raw["parent_id"])
        self.assertEqual((await self.get(leaf["slug"])).status_code, 401)
        self.assertEqual((await self.get(leaf["slug"], self.session("owner"))).status_code, 200)

    async def test_leaf_delete_needs_nothing(self):
        top = await self.mkdoc("UL")
        leaf = await self.sub(top["slug"])
        r = await self.http.delete(f"/api/v1/documents/{leaf['slug']}", headers=self.session("owner"))
        self.assertEqual(r.status_code, 204)


# ── Page images ───────────────────────────────────────────────────────────────


class Assets(PageWorld):
    def obj(self, key):
        return self.r2.objects.get(key)

    async def test_upload_rules(self):
        page = await self.mkdoc("UP")
        slug = page["slug"]
        r = await self.upload(slug, self.session("owner"))
        self.assertEqual(r.status_code, 201, r.text)
        info = r.json()
        self.assertEqual((info["mime"], info["width"], info["height"]), ("image/png", 3, 2))
        row = await self.db["page_assets"].find_one({"_id": info["id"]})
        self.assertEqual(row["key"], f"pa/{page['_id']}/{info['id']}.png")
        self.assertEqual(row["owner_id"], self.uid["owner"])
        self.assertEqual((await self.upload(slug, self.session("ge"))).status_code, 201)
        self.assertEqual((await self.upload(slug, self.session("gv"))).status_code, 403)
        self.assertEqual((await self.upload(slug, self.session("stranger"))).status_code, 404)
        self.assertEqual((await self.upload(slug, {})).status_code, 401)
        self.assertEqual((await self.upload(slug, self.tenant("wm", "W1"))).status_code, 401)
        self.assertEqual((await self.upload(slug, self.session("owner"), b"<svg onload=alert(1)>", "x.svg")).status_code, 415)
        self.assertEqual((await self.upload(slug, self.session("owner"), b"<html></html>", "x.png")).status_code, 415)
        big = b"\x89PNG\r\n\x1a\n" + b"0" * (page_assets.MAX_BYTES + 1)
        self.assertEqual((await self.upload(slug, self.session("owner"), big)).status_code, 413)
        enc = await self.mkdoc("UL", encrypted=True, content="mdx1.aaaaaaaaaaaaaaaaaaaa.bbbb")
        self.assertEqual((await self.upload(enc["slug"], self.session("owner"))).status_code, 422)
        art = await self.mkdoc("UL", kind="artifact")
        self.assertEqual((await self.upload(art["slug"], self.session("owner"))).status_code, 422)

    async def _page_with_image(self, state: str, **kw):
        page = await self.mkdoc(state, **kw)
        info = (await self.upload(page["slug"], self.session("owner"))).json()
        await self.db["documents"].update_one({"_id": page["_id"]},
                                              {"$set": {"content": f"# P\n\n![pic](asset:{info['id']})\n"}})
        return page, info

    async def test_readers_get_urls_others_get_nothing(self):
        page, info = await self._page_with_image("UP")
        body = (await self.get(page["slug"], self.session("gv"))).json()
        a = body["assets"][info["id"]]
        self.assertIn(f"/r/pa/{page['_id']}/{info['id']}.png?t=", a["url"])
        self.assertIsNotNone(a["expires_at"])
        self.assertFalse(self.obj(f"pa/{page['_id']}/{info['id']}.png")["public"])
        for h in ({}, self.session("stranger")):
            r = await self.get(page["slug"], h)
            self.assertIn(r.status_code, (401, 404))
            self.assertNotIn(info["id"], r.text)
            r = await self.http.get(f"/api/v1/documents/{page['slug']}/assets/urls", headers=h)
            self.assertIn(r.status_code, (401, 404))
            self.assertNotIn(info["id"], r.text)
        r = await self.http.get(f"/api/v1/documents/{page['slug']}/assets/urls", headers=self.session("gv"))
        self.assertEqual(list(r.json()["assets"]), [info["id"]])

    async def test_signed_url_carries_the_page_epoch(self):
        import jwt

        page, info = await self._page_with_image("UP")
        await self.db["documents"].update_one({"_id": page["_id"]}, {"$set": {"access_epoch": 4}})
        url = (await self.get(page["slug"], self.session("owner"))).json()["assets"][info["id"]]["url"]
        claims = jwt.decode(url.split("?t=")[1], "k", algorithms=["HS256"])
        self.assertEqual((claims["k"], claims["e"]), (f"pa/{page['_id']}/{info['id']}.png", 4))

    async def test_public_page_gets_bare_urls_and_follows_toggles(self):
        page, info = await self._page_with_image("UL")
        key = f"pa/{page['_id']}/{info['id']}.png"
        self.assertTrue(self.obj(key)["public"])
        a = (await self.get(page["slug"])).json()["assets"][info["id"]]
        self.assertEqual(a, {"url": f"{ORIGIN}/r/{key}", "expires_at": None})
        await self.set_level(page["slug"], "private")
        self.assertFalse(self.obj(key)["public"])
        self.assertEqual(self.obj(key)["ae"], str((await self.doc(page["slug"]))["access_epoch"]))
        self.assertIn("?t=", (await self.get(page["slug"], self.session("owner"))).json()["assets"][info["id"]]["url"])
        await self.set_level(page["slug"], "link")
        self.assertTrue(self.obj(key)["public"])
        r = await self.http.patch(f"/api/v1/documents/{page['slug']}/settings", json={"read_password": "p"},
                                  headers=self.session("owner"))
        self.assertEqual(r.status_code, 200)
        self.assertFalse(self.obj(key)["public"])

    async def test_require_auth_closes_and_opens_images(self):
        page, info = await self._page_with_image("L")
        key = f"pa/{page['_id']}/{info['id']}.png"
        self.assertTrue(self.obj(key)["public"])
        for on in (True, False):
            await self.db["workspaces"].update_one({"_id": ObjectId(self.ws["W1"])},
                                                   {"$set": {"settings.require_auth_to_view": on,
                                                             "require_auth_applied": not on}})
            await lifecycle.sync_require_auth(self.db, self.ws["W1"])
            self.assertEqual(self.obj(key)["public"], not on)

    async def test_sub_page_images_follow_the_parent(self):
        parent = await self.mkdoc("UL")
        child = await self.sub(parent["slug"])
        info = (await self.upload(child["slug"], self.session("owner"))).json()
        key = f"pa/{(await self.doc(child['slug']))['_id']}/{info['id']}.png"
        self.assertTrue(self.obj(key)["public"])
        await self.set_level(parent["slug"], "private")
        self.assertFalse(self.obj(key)["public"])
        await self.set_level(parent["slug"], "link")
        self.assertTrue(self.obj(key)["public"])

    async def test_narrowing_fails_closed_when_images_cant_be_secured(self):
        page, _info = await self._page_with_image("UL")
        self.r2.fail_set_public = True
        try:
            r = await self.http.put(f"/api/v1/documents/{page['slug']}/access/level", json={"level": "private"},
                                    headers=self.session("owner"))
            self.assertEqual(r.status_code, 502)
        finally:
            self.r2.fail_set_public = False

    async def test_other_pages_assets_are_not_resolved(self):
        a, info = await self._page_with_image("UP")
        b = await self.mkdoc("UL")
        await self.db["documents"].update_one({"_id": b["_id"]},
                                              {"$set": {"content": f"![stolen](asset:{info['id']})"}})
        self.assertEqual((await self.get(b["slug"])).json()["assets"], {})

    async def test_tenant_token_may_refresh(self):
        page, info = await self._page_with_image("W")
        r = await self.http.get(f"/api/v1/documents/{page['slug']}/assets/urls", headers=self.tenant("wm", "W1"))
        self.assertEqual(r.status_code, 200)
        self.assertIn(info["id"], r.json()["assets"])
        r = await self.http.get(f"/api/v1/documents/{page['slug']}/assets/urls", headers=self.tenant("wm2", "W2"))
        self.assertEqual(r.status_code, 404)  # another workspace's domain: outside its scope
        self.assertNotIn(info["id"], r.text)

    async def test_quota_and_delete(self):
        from app.services import artifact as art_service

        page, info = await self._page_with_image("UL")
        used = await art_service.user_usage_bytes(self.db, self.uid["owner"])
        self.assertEqual(used, info["size"])
        r = await self.http.delete(f"/api/v1/documents/{page['slug']}", headers=self.session("owner"))
        self.assertEqual(r.status_code, 204)
        self.assertIsNone(self.obj(f"pa/{page['_id']}/{info['id']}.png"))
        self.assertEqual(await self.db["page_assets"].count_documents({}), 0)

    async def test_quota_refuses(self):
        from app.config import get_settings
        from unittest import mock

        page = await self.mkdoc("UL")
        with mock.patch.object(get_settings(), "artifact_user_quota_bytes", 10):
            self.assertEqual((await self.upload(page["slug"], self.session("owner"))).status_code, 413)


# ── Embeds resolved for the viewer ────────────────────────────────────────────


class Embeds(PageWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.page = await self.mkdoc("L", grants=False)  # anyone can read the page itself
        self.items = {
            "pub_art": await self.mkdoc("L", kind="artifact"),
            "pub_doc": await self.mkdoc("UL"),
            "private": await self.mkdoc("P"),
            "ws": await self.mkdoc("W"),
            "pw": await self.mkdoc("LP"),
            "enc": await self.mkdoc("UL", encrypted=True, content="mdx1.aaaaaaaaaaaaaaaaaaaa.bbbb", title=None),
            "signin_ws": await self.mkdoc("RL"),
            "other_ws": await self.mkdoc("W", owner="wm2", ws="W2", grants=False),
        }
        self.slugs = {k: v["slug"] for k, v in self.items.items()}

    async def resolve(self, headers: dict, slugs=None, page=None):
        r = await self.http.post(f"/api/v1/documents/{(page or self.page)['slug']}/embeds",
                                 json={"slugs": slugs or [*self.slugs.values(), "no-such-slug"]}, headers=headers)
        return r

    def states(self, body):
        inv = {v: k for k, v in self.slugs.items()}
        return {inv.get(s, s): e["state"] for s, e in body["embeds"].items()}

    def assert_no_leak(self, body):
        for slug, e in body["embeds"].items():
            if e["state"] in ("ok", "encrypted"):
                continue
            self.assertEqual(e, {"state": e["state"], "kind": None}, slug)

    async def test_every_state_for_every_viewer(self):
        expect = {
            "owner": dict(pub_art="ok", pub_doc="ok", private="ok", ws="ok", pw="ok", enc="encrypted",
                          signin_ws="ok", other_ws="missing"),
            "wm": dict(pub_art="ok", pub_doc="ok", private="missing", ws="ok", pw="ok", enc="missing",
                       signin_ws="ok", other_ws="missing"),
            "gv": dict(pub_art="ok", pub_doc="ok", private="ok", ws="ok", pw="ok", enc="missing",
                       signin_ws="ok", other_ws="missing"),
            "stranger": dict(pub_art="ok", pub_doc="ok", private="missing", ws="missing", pw="password",
                             enc="missing", signin_ws="missing", other_ws="missing"),
            None: dict(pub_art="ok", pub_doc="ok", private="signin", ws="signin", pw="password",
                       enc="encrypted", signin_ws="signin", other_ws="signin"),
        }
        # The encrypted document is unfiled and link-level: anyone may open it (its key is in the link),
        # so readers get "encrypted"; it's owned by "owner", and gv/ge were granted it.
        expect["wm"]["enc"] = expect["stranger"]["enc"] = expect["gv"]["enc"] = "encrypted"
        for who, want in expect.items():
            r = await self.resolve(self.session(who) if who else {})
            self.assertEqual(r.status_code, 200, r.text)
            body = r.json()
            got = self.states(body)
            self.assertEqual(got.pop("no-such-slug"), "missing")
            self.assertEqual(got, want, who)
            self.assert_no_leak(body)

    async def test_ok_shapes(self):
        body = (await self.resolve(self.session("owner"))).json()["embeds"]
        art = body[self.slugs["pub_art"]]
        self.assertEqual(art["kind"], "artifact")
        self.assertEqual(art["renderer"], "html")
        self.assertTrue(art["artifact_url"].startswith(ORIGIN + "/r/art/"))
        self.assertNotIn("?t=", art["artifact_url"])  # public bytes
        self.assertIsNone(art["expires_at"])
        self.assertEqual(art["url"], f"https://docs.acme.test/{self.slugs['pub_art']}")
        doc = body[self.slugs["pub_doc"]]
        self.assertEqual((doc["kind"], doc["renderer"]), ("document", "markdown"))
        self.assertTrue(doc["preview"]["excerpt"])
        self.assertLessEqual(len(doc["preview"]["excerpt"]), 301)
        self.assertEqual(doc["preview"]["author_name"], "OWNER")
        self.assertEqual(doc["url"], f"https://markdrop.in/{self.slugs['pub_doc']}")
        # A stranger gets the content of what they may open, never the author's name.
        sbody = (await self.resolve(self.session("stranger"))).json()["embeds"]
        self.assertNotIn("author_name", sbody[self.slugs["pub_doc"]]["preview"])

    async def test_guarded_artifact_gets_signed_links(self):
        guarded = await self.mkdoc("W", kind="artifact")
        e = (await self.resolve(self.session("wm"), [guarded["slug"]])).json()["embeds"][guarded["slug"]]
        self.assertEqual(e["state"], "ok")
        self.assertIn("?t=", e["artifact_url"])
        self.assertIsNotNone(e["expires_at"])

    async def test_page_must_be_readable(self):
        hidden = await self.mkdoc("P", grants=False)
        self.assertEqual((await self.resolve({}, page=hidden)).status_code, 401)
        self.assertEqual((await self.resolve(self.session("stranger"), page=hidden)).status_code, 404)
        self.assertEqual((await self.resolve(self.session("owner"), page=hidden)).status_code, 200)

    async def test_password_page_needs_its_password(self):
        page = await self.mkdoc("ULP", grants=False)
        self.assertEqual((await self.resolve({}, page=page)).status_code, 401)
        r = await self.http.post(f"/api/v1/documents/{page['slug']}/embeds",
                                 json={"slugs": [self.slugs["pub_doc"]]}, headers={"X-Read-Password": PASSWORD})
        self.assertEqual(r.status_code, 200)
        # The page's password unlocks the page, not the items.
        r = await self.http.post(f"/api/v1/documents/{page['slug']}/embeds",
                                 json={"slugs": [self.slugs["pw"]]}, headers={"X-Read-Password": PASSWORD})
        self.assertEqual(r.json()["embeds"][self.slugs["pw"]]["state"], "password")

    async def test_tenant_token_allowed_and_scoped(self):
        page = await self.mkdoc("W", grants=False)
        r = await self.resolve(self.tenant("wm", "W1"), [self.slugs["ws"], self.slugs["pub_doc"],
                                                         self.slugs["other_ws"]], page=page)
        self.assertEqual(r.status_code, 200, r.text)
        got = self.states(r.json())
        self.assertEqual(got, {"ws": "ok", "pub_doc": "missing", "other_ws": "missing"})
        self.assert_no_leak(r.json())

    async def test_limits(self):
        r = await self.resolve(self.session("owner"), [f"s{i}" for i in range(101)])
        self.assertEqual(r.status_code, 422)
        r = await self.resolve(self.session("owner"), ["../x", "a b", ""])
        self.assertEqual(set(e["state"] for e in r.json()["embeds"].values()), {"missing"})

    async def test_renamed_item_answers_under_its_new_slug(self):
        d = await self.mkdoc("UL")
        await self.db["documents"].update_one({"_id": d["_id"]}, {"$set": {"slug": "new-name",
                                                                         "old_slugs": [d["slug"]]}})
        e = (await self.resolve(self.session("owner"), [d["slug"]])).json()["embeds"][d["slug"]]
        self.assertEqual((e["state"], e["slug"]), ("ok", "new-name"))

    def test_parse_refs(self):
        md = ('::markdrop{src="abc-1" mode="live"}\n\nSee :markdrop[Q3 plan]{src="q3"} and '
              ':markdrop[x]{src=https://markdrop.in/zz}\n\n```\n::markdrop{src="in-code"}\n```\n'
              '![a](asset:0123456789abcdef01234567)')
        refs = pages.embed_refs(md)
        self.assertEqual([(r["slug"], r["mention"]) for r in refs][:3],
                         [("abc-1", False), ("q3", True), ("zz", True)])
        self.assertEqual(pages.asset_ids(md), ["0123456789abcdef01234567"])


# ── The edit lock ─────────────────────────────────────────────────────────────


class Lock(PageWorld):
    async def lock(self, slug, who):
        return await self.http.post(f"/api/v1/documents/{slug}/lock", headers=self.session(who))

    async def put(self, slug, who_headers, **body):
        body.setdefault("title", "t")
        body.setdefault("content", "# new")
        return await self.http.put(f"/api/v1/documents/{slug}", json=body, headers=who_headers)

    async def test_one_editor_at_a_time(self):
        page = await self.mkdoc("UP")
        r = await self.lock(page["slug"], "ge")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["holder"], {"name": "GE"})
        self.assertTrue(r.json()["expires_at"])
        r = await self.lock(page["slug"], "owner")
        self.assertEqual(r.status_code, 423)
        self.assertEqual((r.json()["code"], r.json()["holder"]), ("locked", {"name": "GE"}))
        # The holder's saves pass; anyone else's are refused with who holds it.
        self.assertEqual((await self.put(page["slug"], self.session("ge"), content="# by ge")).status_code, 200)
        r = await self.put(page["slug"], self.session("owner"))
        self.assertEqual(r.status_code, 423)
        self.assertEqual(r.json()["holder"], {"name": "GE"})
        self.assertEqual((await self.put(page["slug"], {"X-Edit-Secret": ES_SECRET})).status_code, 423)
        self.assertEqual((await self.doc(page["slug"]))["content"], "# by ge")
        # Heartbeat renews; release lets the next person in.
        self.assertEqual((await self.lock(page["slug"], "ge")).status_code, 200)
        r = await self.http.delete(f"/api/v1/documents/{page['slug']}/lock", headers=self.session("ge"))
        self.assertEqual(r.status_code, 204)
        self.assertEqual((await self.lock(page["slug"], "owner")).status_code, 200)

    async def test_base_rev_still_applies_to_the_holder(self):
        page = await self.mkdoc("UP")
        await self.lock(page["slug"], "owner")
        r = await self.put(page["slug"], self.session("owner"), base_rev=1)
        self.assertEqual(r.status_code, 200)
        r = await self.put(page["slug"], self.session("owner"), base_rev=1)
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.headers.get("x-markdrop-rev"), "2")

    async def test_expired_lock_is_free(self):
        page = await self.mkdoc("UP")
        await self.lock(page["slug"], "ge")
        await self.db["documents"].update_one({"_id": page["_id"]},
                                              {"$set": {"edit_lock.expires_at": now() - timedelta(seconds=1)}})
        self.assertEqual((await self.put(page["slug"], self.session("owner"))).status_code, 200)
        self.assertEqual((await self.lock(page["slug"], "owner")).status_code, 200)

    async def test_who_may_lock(self):
        page = await self.mkdoc("UP")
        self.assertEqual((await self.lock(page["slug"], "gv")).status_code, 403)
        self.assertEqual((await self.lock(page["slug"], "stranger")).status_code, 404)
        self.assertEqual((await self.http.post(f"/api/v1/documents/{page['slug']}/lock")).status_code, 401)
        w = await self.mkdoc("W")
        r = await self.http.post(f"/api/v1/documents/{w['slug']}/lock", headers=self.tenant("wm", "W1"))
        self.assertEqual(r.status_code, 401)
        # Releasing someone else's lock does nothing.
        await self.lock(page["slug"], "ge")
        await self.http.delete(f"/api/v1/documents/{page['slug']}/lock", headers=self.session("owner"))
        self.assertEqual((await self.lock(page["slug"], "owner")).status_code, 423)

    async def test_presence_marks_the_holder_editing(self):
        page = await self.mkdoc("UP")
        await self.lock(page["slug"], "ge")
        self.assertEqual(viewers.editor_of(page["slug"]), self.uid["ge"])
        r = viewers._room_for(page["slug"], await self.doc(page["slug"]))
        q = asyncio.Queue()
        c = viewers.connect(q, "1.2.3.4")
        c.joined = c.present = c.named = True
        c.user_id, c.name = self.uid["ge"], "GE"
        r.conns[c.id] = c
        entries = viewers._entries(r)
        self.assertTrue(entries[0].get("editing"))
        await self.http.delete(f"/api/v1/documents/{page['slug']}/lock", headers=self.session("ge"))
        self.assertIsNone(viewers.editor_of(page["slug"]))
        self.assertNotIn("editing", viewers._entries(r)[0])
