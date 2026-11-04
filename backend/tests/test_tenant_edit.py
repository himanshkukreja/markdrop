"""Editing on a workspace's own domain, and "Request edit access" (2026-11-04).

A tenant token (a workspace domain's 12 h session, routers/auth.py) may now edit page content,
take the edit lock, upload page images, add sub-pages, use the AI writing tools and the version
history — for documents of ITS workspace only. Everything here is adversarial: each allowed route
is tried with a token of another workspace, on a personal document, from a wrong or missing
Origin, after the domain died, and by someone who may only read. The forbidden actions (delete,
settings, slug, access, tokens, workspace settings) are tried with the owner's own tenant token.

Edit-link holders (no account, the edit secret) on the domain: the same workspace pin and the same
action set, decided from the request's Origin (services/access.py `can`).

Request edit access (services/access_requests.py, role "editor"): who may ask, who decides,
approve = editor on that page only, duplicates and declines rate-limited, emails faked.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
from unittest import mock

from tests._access_env import ES_SECRET, HOSTS, AccessWorld, now  # noqa: F401  (pins settings first)

import tests.test_pages_ai as tai
from bson import ObjectId

from app.limiter import limiter
from app.services import access_requests, live, mailer, tickets, viewers
from app.utils.auth import create_tenant_token


def png() -> bytes:
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (3, 2), (200, 30, 30)).save(buf, format="PNG")
    return buf.getvalue()


class TenantWorld(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.db["page_assets"].create_index("doc_id")
        await access_requests.ensure_indexes(self.db)
        viewers.clear()
        limiter.enabled = False
        self.addCleanup(setattr, limiter, "enabled", True)
        self.mail: list[dict] = []

        async def capture(payload):
            self.mail.append(payload)

        for p in (mock.patch.object(mailer, "is_configured", lambda: True),
                  mock.patch.object(mailer, "_post", capture)):
            p.start()
            self.addCleanup(p.stop)
        # wm is a member of W1 *and* W2: the sharpest cross-workspace case (their session may
        # edit both; their W1 domain token may touch only W1).
        await self.add_member("W2", "wm", "member")
        self.W = await self.mkdoc("W", editor="blocks")            # W1, workspace-visible
        self.L = await self.mkdoc("L", editor="blocks")            # W1, anyone with the link
        self.X = await self.mkdoc("W", ws="W2", owner="wm2")      # W2
        self.U = await self.mkdoc("UL", owner="wm")               # wm's own, in no workspace

    def no_origin(self, who: str, ws_key: str = "W1") -> dict:
        token, _ = create_tenant_token(self.uid[who], self.email[who], self.ws[ws_key], HOSTS[ws_key])
        return {"Authorization": f"Bearer {token}"}

    def secret_on(self, ws_key: str | None = "W1") -> dict:
        h = {"X-Edit-Secret": ES_SECRET}
        if ws_key:
            h["Origin"] = f"https://{HOSTS[ws_key]}"
        return h

    async def put(self, slug: str, headers: dict, **body):
        body.setdefault("title", "Edited")
        body.setdefault("content", "# Edited on the domain")
        return await self.http.put(f"/api/v1/documents/{slug}", json=body, headers=headers)

    async def content(self, doc: dict) -> str:
        return (await self.db["documents"].find_one({"_id": doc["_id"]}))["content"]


# ── Content and title ─────────────────────────────────────────────────────────


class EditContent(TenantWorld):
    async def test_who_edits_own_workspace_page(self):
        # A member, an editor by grant, the owner: yes. Readers: 403.
        for who, code in (("wm", 200), ("ge", 200), ("owner", 200), ("wa", 200),
                          ("gv", 403), ("wv", 403), ("ownv", 403)):
            r = await self.put(self.W["slug"], self.tenant(who, "W1"), content=f"# by {who}")
            self.assertEqual(r.status_code, code, (who, r.text))
        self.assertEqual(await self.content(self.W), "# by wa")
        # A stranger (signed in, not in the circle) learns nothing.
        r = await self.put(self.W["slug"], self.tenant("stranger", "W1"))
        self.assertEqual(r.status_code, 404)
        # The response says what the page offers on the domain: edit, never the rest.
        body = (await self.put(self.W["slug"], self.tenant("owner", "W1"))).json()
        self.assertEqual(body["can"]["edit"], True)
        for flag in ("settings", "access", "rename", "delete", "move", "unshare"):
            self.assertFalse(body["can"][flag], flag)

    async def test_other_workspace_and_personal_documents_are_refused(self):
        # wm may edit X with their session (a W2 member)...
        self.assertEqual((await self.put(self.X["slug"], self.session("wm"))).status_code, 200)
        before = await self.content(self.X)
        # ...but never through W1's domain: the same 404 as a missing page.
        r = await self.put(self.X["slug"], self.tenant("wm", "W1"))
        missing = await self.put("no-such-page", self.tenant("wm", "W1"))
        self.assertEqual((r.status_code, r.content), (missing.status_code, missing.content))
        self.assertEqual(await self.content(self.X), before)
        # Their own personal page: not on any workspace's domain either.
        r = await self.put(self.U["slug"], self.tenant("wm", "W1"))
        self.assertEqual(r.status_code, 404)
        # A WR page through W1's domain (same members, another workspace).
        rw = await self.mkdoc("RW")
        self.assertEqual((await self.put(rw["slug"], self.tenant("wm", "W1"))).status_code, 404)
        self.assertEqual((await self.put(rw["slug"], self.tenant("wm", "WR"))).status_code, 200)

    async def test_origin_must_be_the_tokens_own_host(self):
        for headers in (self.tenant("wm", "W1", origin="https://evil.test"),
                        self.tenant("wm", "W1", origin=f"https://{HOSTS['W2']}"),
                        self.tenant("wm", "W1", origin="https://markdrop.in"),
                        self.tenant("wm", "W1", origin="null"),
                        self.no_origin("wm")):
            r = await self.put(self.W["slug"], headers)
            self.assertEqual(r.status_code, 401, headers.get("Origin"))
        self.assertNotEqual(await self.content(self.W), "# Edited on the domain")

    async def test_dead_domain_takes_its_tokens_with_it(self):
        h = self.tenant("wm", "W1")
        self.assertEqual((await self.put(self.W["slug"], h)).status_code, 200)
        for change in ({"status": "lapsed"}, {"attached": False}, {"workspace_id": self.ws["W2"]}):
            await self.db["domains"].update_one({"host": HOSTS["W1"]}, {"$set": change})
            r = await self.put(self.W["slug"], h, content="# after")
            self.assertEqual(r.status_code, 401, change)
            r = await self.http.post(f"/api/v1/documents/{self.W['slug']}/lock", headers=h)
            self.assertEqual(r.status_code, 401, change)
            await self.db["domains"].update_one(
                {"host": HOSTS["W1"]},
                {"$set": {"status": "verified", "attached": True, "workspace_id": self.ws["W1"]}})
        await self.db["domains"].delete_one({"host": HOSTS["W1"]})
        self.assertEqual((await self.put(self.W["slug"], h)).status_code, 401)

    async def test_settings_fields_in_a_content_save_are_refused_whole(self):
        for extra in ({"read_password": "pw"}, {"remove_password": True}, {"expires_in": "1d"}):
            r = await self.put(self.W["slug"], self.tenant("owner", "W1"), content="# x", **extra)
            self.assertEqual(r.status_code, 401, extra)
        doc = await self.db["documents"].find_one({"_id": self.W["_id"]})
        self.assertEqual((doc["read_password_hash"], doc["expires_at"]), (None, None))
        self.assertNotEqual(doc["content"], "# x")

    async def test_editor_switch(self):
        r = await self.http.put(f"/api/v1/documents/{self.W['slug']}/editor", json={"editor": "classic"},
                                headers=self.tenant("wm", "W1"))
        self.assertEqual(r.status_code, 200, r.text)
        for slug, who, code in ((self.X["slug"], "wm", 404), (self.W["slug"], "gv", 403)):
            r = await self.http.put(f"/api/v1/documents/{slug}/editor", json={"editor": "blocks"},
                                    headers=self.tenant(who, "W1"))
            self.assertEqual(r.status_code, code, who)


# ── Everything that stays on markdrop.in ──────────────────────────────────────


class ForbiddenOnTheDomain(TenantWorld):
    async def test_owner_token_cannot_manage(self):
        h = self.tenant("owner", "W1")
        slug = self.W["slug"]
        wid = self.ws["W1"]
        calls = [
            ("DELETE", f"/api/v1/documents/{slug}", None),
            ("DELETE", f"/api/v1/documents/{slug}?children=delete", None),
            ("PATCH", f"/api/v1/documents/{slug}/settings", {"read_password": "pw"}),
            ("PATCH", f"/api/v1/documents/{slug}/slug", {"new_slug": "taken-over"}),
            ("GET", f"/api/v1/documents/{slug}/slug-check?new_slug=abc", None),
            ("POST", f"/api/v1/documents/{slug}/edit-secret/rotate", None),
            ("PUT", f"/api/v1/documents/{slug}/access/level", {"level": "link"}),
            ("PUT", f"/api/v1/documents/{slug}/access/resharing", {"allow": True}),
            ("PUT", f"/api/v1/documents/{slug}/access/presence", {"show": False}),
            ("POST", "/api/v1/documents/access/level", {"slugs": [slug], "level": "link"}),
            ("PUT", f"/api/v1/documents/{slug}/parent", {"parent": None}),
            ("POST", f"/api/v1/documents/{slug}/copy", {}),
            ("POST", f"/api/v1/documents/{slug}/claim", None),
            ("PUT", f"/api/v1/documents/{slug}/template", {"template": True}),
            ("POST", f"/api/v1/documents/{slug}/save-as-template", {"name": "T"}),
            ("POST", "/api/v1/documents", {"content": "# new", "title": "n"}),
            ("GET", "/api/v1/me/tokens", None),
            ("POST", "/api/v1/me/tokens", {"name": "steal"}),
            ("GET", "/api/v1/me/documents", None),
            ("PUT", f"/api/v1/workspaces/{wid}", {"name": "Owned"}),
            ("DELETE", f"/api/v1/workspaces/{wid}", None),
            ("POST", f"/api/v1/workspaces/{wid}/invitations", {"email": "x@example.com", "role": "admin"}),
            ("PUT", f"/api/v1/workspaces/{wid}/members/{self.uid['wm']}", {"role": "admin"}),
            ("PATCH", "/api/v1/auth/me", {"name": "Renamed"}),
            ("POST", "/api/v1/auth/tenant-token", {"host": HOSTS["W2"]}),
            ("POST", "/api/v1/auth/studio-token", {}),
            ("POST", "/api/v1/ai/pages/notes", {"notes": "x"}),
            ("POST", f"/api/v1/ai/pages/{slug}/translate", {"lang": "Spanish"}),
            ("GET", "/api/v1/me/access-requests", None),
        ]
        for method, path, body in calls:
            r = await self.http.request(method, path, json=body, headers=h)
            self.assertIn(r.status_code, (401, 405), (method, path, r.status_code, r.text))
            self.assertNotEqual(r.status_code // 100, 2, (method, path))
        doc = await self.db["documents"].find_one({"_id": self.W["_id"]})
        self.assertEqual((doc["slug"], doc["access_level"], doc["read_password_hash"]),
                         (slug, "workspace", None))
        self.assertEqual(await self.db["document_grants"].count_documents({"document_id": str(self.W["_id"])}), 2)
        self.assertEqual(await self.db["api_tokens"].count_documents({}), 0)

    async def test_actions_are_refused_in_access_can_too(self):
        # Defence in depth: even a route someone adds to the allowlist by mistake gets nothing
        # from access.can for these actions.
        from app.services import access

        actor = access.Actor(user=await self._user("owner"), cred="tenant", tenant_ws=self.ws["W1"])
        raw = await self.db["documents"].find_one({"_id": self.W["_id"]})
        ctx = access.Ctx(self.db)
        for action in ("delete", "edit_settings", "rename_slug", "change_access", "set_resharing",
                       "move_in_workspace", "unshare", "copy", "claim", "sync", "gdocs_export",
                       "view_stats", "replace_file", "delete_version", "file_into_workspace"):
            d = await access.can(actor, raw, action, ctx)
            self.assertFalse(d.allowed, action)
        # Sharing with specific people is allowed on the domain (owner, 2026-11-04); the access level isn't.
        for action in ("read", "edit_content", "list_versions", "restore_version",
                       "share", "revoke_grant", "see_grants"):
            self.assertTrue((await access.can(actor, raw, action, ctx)).allowed, action)
        x = await self.db["documents"].find_one({"_id": self.X["_id"]})
        for action in ("read", "edit_content", "list_versions", "restore_version",
                       "share", "revoke_grant", "see_grants"):
            self.assertEqual((await access.can(actor, x, action, ctx)).status, 404, action)

    async def _user(self, who):
        from app.services import user as user_service

        return await user_service.get_user_by_id(self.db, self.uid[who])


# ── The edit lock and the live channel ────────────────────────────────────────


class LockAndLive(TenantWorld):
    async def test_lock_take_heartbeat_release(self):
        url = f"/api/v1/documents/{self.W['slug']}/lock"
        h = self.tenant("wm", "W1")
        r = await self.http.post(url, headers=h)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(viewers.editor_of(self.W["slug"]), self.uid["wm"])
        self.assertEqual((await self.http.post(url, headers=h)).status_code, 200)  # heartbeat
        # Someone else (on markdrop.in) is told who holds it, and their save waits.
        self.assertEqual((await self.http.post(url, headers=self.session("ge"))).status_code, 423)
        self.assertEqual((await self.put(self.W["slug"], self.session("ge"))).status_code, 423)
        # The holder's autosaves on the domain go through.
        self.assertEqual((await self.put(self.W["slug"], h)).status_code, 200)
        self.assertEqual((await self.http.delete(url, headers=h)).status_code, 204)
        self.assertEqual((await self.http.post(url, headers=self.session("ge"))).status_code, 200)

    async def test_lock_refused_out_of_scope(self):
        for slug, headers, code in ((self.X["slug"], self.tenant("wm", "W1"), 404),
                                    (self.U["slug"], self.tenant("wm", "W1"), 404),
                                    (self.W["slug"], self.tenant("gv", "W1"), 403),
                                    (self.W["slug"], self.tenant("wm", "W1", origin="https://evil.test"), 401),
                                    (self.W["slug"], self.no_origin("wm"), 401)):
            r = await self.http.post(f"/api/v1/documents/{slug}/lock", headers=headers)
            self.assertEqual(r.status_code, code, (slug, headers.get("Origin")))
        # A lock on X held through wm's session can't be released through W1's domain.
        await self.http.post(f"/api/v1/documents/{self.X['slug']}/lock", headers=self.session("wm"))
        r = await self.http.delete(f"/api/v1/documents/{self.X['slug']}/lock", headers=self.tenant("wm", "W1"))
        self.assertEqual(r.status_code, 404)
        self.assertIsNotNone((await self.db["documents"].find_one({"_id": self.X["_id"]}))["edit_lock"])

    async def test_release_beacon_with_a_tenant_token(self):
        h = self.tenant("wm", "W1")
        token = h["Authorization"][7:]
        url = f"/api/v1/documents/{self.W['slug']}/lock/release"
        await self.http.post(f"/api/v1/documents/{self.W['slug']}/lock", headers=h)
        # Wrong or missing Origin: ignored (204), the lock stays.
        for origin in (None, "https://evil.test", f"https://{HOSTS['W2']}"):
            hdrs = {"Content-Type": "text/plain", **({"Origin": origin} if origin else {})}
            r = await self.http.post(url, content=token, headers=hdrs)
            self.assertEqual(r.status_code, 204)
            self.assertIsNotNone(pages_lock(await self.db["documents"].find_one({"_id": self.W["_id"]})))
        # The holder's token from its own domain lets it go.
        r = await self.http.post(url, content=token,
                                 headers={"Content-Type": "text/plain", "Origin": f"https://{HOSTS['W1']}"})
        self.assertEqual(r.status_code, 204)
        self.assertIsNone(pages_lock(await self.db["documents"].find_one({"_id": self.W["_id"]})))
        # A W1 domain token never releases a W2 page's lock, even its own holder's.
        await self.http.post(f"/api/v1/documents/{self.X['slug']}/lock", headers=self.session("wm"))
        r = await self.http.post(f"/api/v1/documents/{self.X['slug']}/lock/release", content=token,
                                 headers={"Content-Type": "text/plain", "Origin": f"https://{HOSTS['W1']}"})
        self.assertEqual(r.status_code, 204)
        self.assertIsNotNone(pages_lock(await self.db["documents"].find_one({"_id": self.X["_id"]})))
        # A dead domain: ignored.
        await self.http.post(f"/api/v1/documents/{self.W['slug']}/lock", headers=h)
        await self.db["domains"].update_one({"host": HOSTS["W1"]}, {"$set": {"status": "lapsed"}})
        await self.http.post(url, content=token,
                             headers={"Content-Type": "text/plain", "Origin": f"https://{HOSTS['W1']}"})
        self.assertIsNotNone(pages_lock(await self.db["documents"].find_one({"_id": self.W["_id"]})))

    async def test_live_socket_admits_the_domain_reader_and_editor(self):
        # The socket authenticates with the read ticket from the (pinned) read, not the token.
        body = (await self.get(self.W["slug"], self.tenant("wm", "W1"))).json()
        self.assertTrue(body["read_ticket"] and body["presence_ticket"])
        from app.routers import live as live_router

        self.assertIsNotNone(await live_router._admitted(self.W["slug"], body["read_ticket"]))
        # That ticket opens nothing else: another workspace's page isn't admitted with it.
        self.assertIsNone(await live_router._admitted(self.X["slug"], body["read_ticket"]))
        # And the domain token can't fetch a ticket for another workspace's page at all.
        self.assertEqual((await self.get(self.X["slug"], self.tenant("wm", "W1"))).status_code, 404)
        # A save made on the domain reaches the live channel (readers there refresh).
        q = live.subscribe(self.W["slug"])
        try:
            self.assertEqual((await self.put(self.W["slug"], self.tenant("wm", "W1"))).status_code, 200)
            event = await asyncio.wait_for(q.get(), timeout=2)
            self.assertIn(event.get("type") if isinstance(event, dict) else "changed", ("changed",))
        finally:
            live.unsubscribe(self.W["slug"], q)


def pages_lock(doc: dict) -> dict | None:
    from app.services import pages

    return pages.lock_view(doc.get("edit_lock"))


# ── Page images ───────────────────────────────────────────────────────────────


class Assets(TenantWorld):
    async def upload(self, slug: str, headers: dict):
        return await self.http.post(f"/api/v1/documents/{slug}/assets",
                                    files={"file": ("a.png", png(), "image/png")}, headers=headers)

    async def test_upload_scoped(self):
        r = await self.upload(self.W["slug"], self.tenant("wm", "W1"))
        self.assertEqual(r.status_code, 201, r.text)
        row = await self.db["page_assets"].find_one({"_id": r.json()["id"]})
        self.assertEqual(row["doc_id"], str(self.W["_id"]))
        for slug, headers, code in ((self.X["slug"], self.tenant("wm", "W1"), 404),
                                    (self.U["slug"], self.tenant("wm", "W1"), 404),
                                    (self.W["slug"], self.tenant("gv", "W1"), 403),
                                    (self.W["slug"], self.tenant("wm", "W1", origin="https://evil.test"), 401),
                                    (self.W["slug"], self.no_origin("wm"), 401)):
            self.assertEqual((await self.upload(slug, headers)).status_code, code, slug)
        self.assertEqual(await self.db["page_assets"].count_documents({}), 1)
        # Fresh links for the page's images, for a reader there.
        r = await self.http.get(f"/api/v1/documents/{self.W['slug']}/assets/urls", headers=self.tenant("gv", "W1"))
        self.assertEqual(r.status_code, 200)


# ── Sub-pages ─────────────────────────────────────────────────────────────────


class SubPages(TenantWorld):
    async def create(self, headers: dict, **body):
        body.setdefault("title", "Inside")
        return await self.http.post("/api/v1/pages", json=body, headers=headers)

    async def test_member_adds_a_sub_page_on_the_domain(self):
        r = await self.create(self.tenant("wm", "W1"), parent=self.W["slug"])
        self.assertEqual(r.status_code, 201, r.text)
        out = r.json()
        # Never the new page's edit secret on a customer's domain.
        self.assertIsNone(out["edit_secret"])
        raw = await self.db["documents"].find_one({"slug": out["document"]["slug"]})
        self.assertEqual((raw["workspace_id"], raw["parent_id"], raw["owner_id"]),
                         (self.ws["W1"], self.W["_id"], self.uid["wm"]))
        # A built-in template is fine.
        r = await self.create(self.tenant("wm", "W1"), parent=self.W["slug"], template="meeting-notes")
        self.assertIn(r.status_code, (201, 422), r.text)  # 422 only if that id isn't built in

    async def test_only_sub_pages_and_only_in_scope(self):
        cases = [
            (self.tenant("wm", "W1"), {}, 403),                                     # top level
            (self.tenant("wm", "W1"), {"workspace": self.ws["W1"]}, 403),           # filed by id
            (self.tenant("wm", "W1"), {"workspace": self.ws["W2"]}, 403),
            (self.tenant("wm", "W1"), {"parent": self.W["slug"], "workspace": self.ws["W1"]}, 422),
            (self.tenant("wm", "W1"), {"parent": self.W["slug"], "folder": "x"}, 422),
            (self.tenant("wm", "W1"), {"parent": self.X["slug"]}, 404),            # W2 parent
            (self.tenant("wm", "W1"), {"parent": self.U["slug"]}, 404),            # personal parent
            (self.tenant("gv", "W1"), {"parent": self.W["slug"]}, 403),            # a reader
            (self.tenant("wm", "W1"), {"parent": self.W["slug"], "template": "a" * 24}, 403),
            (self.tenant("wm", "W1", origin="https://evil.test"), {"parent": self.W["slug"]}, 401),
            (self.no_origin("wm"), {"parent": self.W["slug"]}, 401),
        ]
        for headers, body, code in cases:
            r = await self.create(headers, **body)
            self.assertEqual(r.status_code, code, (body, r.text))
        self.assertEqual(await self.db["documents"].count_documents({"parent_id": {"$ne": None}}), 0)


# ── Version history ───────────────────────────────────────────────────────────


class History(TenantWorld):
    def url(self, doc, tail=""):
        return f"/api/v1/documents/{doc['slug']}/versions{tail}"

    async def test_list_read_restore_scoped(self):
        h = self.tenant("wm", "W1")
        self.assertEqual((await self.put(self.W["slug"], h, content="# one")).status_code, 200)
        await self.db["documents"].update_one({"_id": self.W["_id"]}, {"$set": {"edit_lock": None}})
        r = await self.http.get(self.url(self.W), headers=h)
        self.assertEqual(r.status_code, 200, r.text)
        versions = r.json()["versions"]
        self.assertTrue(versions)
        oldest = versions[-1]["n"]
        self.assertEqual((await self.http.get(self.url(self.W, f"/{oldest}"), headers=h)).status_code, 200)
        r = await self.http.post(self.url(self.W, f"/{oldest}/restore"), headers=h)
        self.assertEqual(r.status_code, 200, r.text)
        # Another workspace's page, a personal page, a reader, a bad Origin.
        await self.put(self.X["slug"], self.session("wm"), content="# x1")
        for doc, headers, code in ((self.X, h, 404), (self.U, h, 404),
                                   (self.W, self.tenant("gv", "W1"), 403),
                                   (self.W, self.tenant("wm", "W1", origin="https://evil.test"), 401)):
            for method, tail in (("GET", ""), ("GET", "/1"), ("POST", "/1/restore")):
                r = await self.http.request(method, self.url(doc, tail), headers=headers)
                self.assertEqual(r.status_code, code, (doc["slug"], method, tail))


# ── AI writing tools ──────────────────────────────────────────────────────────


class AIWriting(tai.PagesAIWorld):
    async def test_writing_scoped_to_the_domains_workspace(self):
        await self.add_member("W2", "wm", "member")
        other = await self.mkdoc("W", ws="W2", owner="wm2", editor="blocks", slug="other-page")
        self.fake.reply = "Better text."
        ev = await self.stream("transform", None, tai.BODIES["transform"], headers=self.tenant("wm", "W1"))
        self.assertEqual(ev[-1][0], "done", ev)
        calls = len(self.fake.calls)
        for action in ("transform", "write", "action-items", "summary", "meta", "alt-text"):
            body = tai.BODIES.get(action, {"asset_id": "x" * 24})
            # W2's page through W1's domain — wm may edit it with their session.
            r = await self.post(f"/api/v1/ai/pages/{other['slug']}/{action}", self.tenant("wm", "W1"), json=body)
            self.assertEqual(r.status_code, 404, (action, r.text))
            # A reader on the domain.
            r = await self.post(f"{self.url}/{action}", self.tenant("wv", "W1"), json=body)
            self.assertEqual(r.status_code, 403, (action, r.text))
            r = await self.post(f"{self.url}/{action}", self.tenant("wm", "W1", origin="https://evil.test"),
                                json=body)
            self.assertEqual(r.status_code, 401, action)
        self.assertEqual(len(self.fake.calls), calls)
        r = await self.http.get("/api/v1/ai/pages/status?slug=launch-page", headers=self.tenant("wm", "W1"))
        self.assertTrue(r.json()["can_write"])


# ── Edit-link holders (the edit secret) on the domain ────────────────────────


class EditSecretOnTheDomain(TenantWorld):
    async def test_scoped_to_the_page_and_its_workspace(self):
        # The fixture gives every document the same edit secret: the sharpest case.
        self.assertEqual((await self.put(self.W["slug"], self.secret_on("W1"))).status_code, 200)
        # Through W1's domain: not W2's page, not a personal page, even with a valid secret.
        self.assertEqual((await self.put(self.X["slug"], self.secret_on("W1"))).status_code, 404)
        self.assertEqual((await self.put(self.U["slug"], self.secret_on("W1"))).status_code, 404)
        # Through W2's own domain, W2's page.
        self.assertEqual((await self.put(self.X["slug"], self.secret_on("W2"))).status_code, 200)
        # A wrong secret is still nothing.
        r = await self.put(self.W["slug"], {"X-Edit-Secret": "nope", "Origin": f"https://{HOSTS['W1']}"})
        self.assertEqual(r.status_code, 401)
        # On markdrop.in (or with no Origin) the secret works as it always did.
        self.assertEqual((await self.put(self.X["slug"], self.secret_on(None))).status_code, 200)
        r = await self.put(self.X["slug"], {"X-Edit-Secret": ES_SECRET, "Origin": "https://markdrop.in"})
        self.assertEqual(r.status_code, 200)

    async def test_management_stays_on_markdrop_in(self):
        h = self.secret_on("W1")
        slug = self.W["slug"]
        for method, path, body in (("DELETE", f"/api/v1/documents/{slug}", None),
                                   ("PATCH", f"/api/v1/documents/{slug}/settings", {"read_password": "x"}),
                                   ("PATCH", f"/api/v1/documents/{slug}/slug", {"new_slug": "mine-now"}),
                                   ("POST", f"/api/v1/documents/{slug}/edit-secret/rotate", None),
                                   ("PUT", f"/api/v1/documents/{slug}", {"title": "t", "content": "# c",
                                                                         "expires_in": "1h"})):
            r = await self.http.request(method, path, json=body, headers=h)
            self.assertEqual(r.status_code, 401, (method, path, r.text))
        self.assertIsNotNone(await self.db["documents"].find_one({"slug": slug}))
        # The read that unlocks the editor says so.
        body = (await self.get(slug, h)).json()
        self.assertTrue(body["can"]["edit"])
        self.assertFalse(body["can"]["delete"] or body["can"]["settings"] or body["can"]["rename"])
        # The same secret deletes on markdrop.in, as before.
        r = await self.http.delete(f"/api/v1/documents/{slug}", headers={"X-Edit-Secret": ES_SECRET})
        self.assertEqual(r.status_code, 204, r.text)


# ── Request edit access ───────────────────────────────────────────────────────


class RequestEditAccess(TenantWorld):
    def path(self, slug: str) -> str:
        return f"/api/v1/documents/{slug}/access-requests"

    async def ask(self, slug: str, headers: dict, **body):
        body.setdefault("role", "editor")
        return await self.http.post(self.path(slug), json=body, headers=headers)

    async def decide(self, rid: str, who: str, decision: str):
        return await self.http.post(f"/api/v1/access-requests/{rid}/decision", json={"decision": decision},
                                    headers=self.session(who))

    async def test_viewer_grant_asks_owner_approves_page_only(self):
        child = (await self.http.post("/api/v1/pages", json={"title": "Child", "parent": self.W["slug"]},
                                      headers=self.session("owner"))).json()["document"]
        r = await self.ask(self.W["slug"], self.session("gv"), message="Typo in step 3")
        self.assertEqual(r.status_code, 201, r.text)
        rid = r.json()["id"]
        # One email, to the owner, with Approve / Decline.
        self.assertEqual([m["to"] for m in self.mail], [["owner@example.com"]])
        html = self.mail[0]["html"]
        self.assertIn("asked to edit", self.mail[0]["subject"])
        self.assertIn(f"https://markdrop.in/requests/{rid}?action=edit", html)
        self.assertIn(f"https://markdrop.in/requests/{rid}?action=decline", html)
        self.assertNotIn("action=view", html)
        self.assertIn("Typo in step 3", html)
        # Pending, and asking twice is refused.
        mine = (await self.http.get(self.path(self.W["slug"]) + "/mine?role=editor",
                                    headers=self.session("gv"))).json()
        self.assertEqual((mine["can_request_access"], mine["request_pending"]), (True, True))
        self.assertEqual((await self.ask(self.W["slug"], self.session("gv"))).status_code, 409)
        # The owner's dashboard lists it as an edit request.
        lst = (await self.http.get("/api/v1/me/access-requests", headers=self.session("owner"))).json()
        self.assertEqual((lst["pending_count"], lst["requests"][0]["role_requested"]), (1, "editor"))
        # Only the owner decides: not an admin (the owner is reachable), not a member, not the asker.
        for who in ("wa", "wo", "wm", "ge", "gv", "stranger"):
            self.assertEqual((await self.decide(rid, who, "edit")).status_code, 404, who)
        # "Let them view" makes no sense for someone who already views.
        self.assertEqual((await self.decide(rid, "owner", "view")).status_code, 422)
        self.mail.clear()
        r = await self.decide(rid, "owner", "edit")
        self.assertEqual((r.status_code, r.json()["role_granted"]), (200, "editor"), r.text)
        self.assertEqual([m["to"] for m in self.mail], [["gv@example.com"]])
        self.assertIn("You can edit", self.mail[0]["subject"])
        # gv edits that page, on markdrop.in and on the domain...
        self.assertEqual((await self.put(self.W["slug"], self.session("gv"))).status_code, 200)
        self.assertEqual((await self.put(self.W["slug"], self.tenant("gv", "W1"))).status_code, 200)
        # ...but not the page inside it: still a reader there.
        r = await self.get(child["slug"], self.session("gv"))
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["can"]["edit"])
        self.assertEqual((await self.put(child["slug"], self.session("gv"))).status_code, 403)
        # Idempotent; now nothing to ask for.
        self.assertEqual((await self.decide(rid, "owner", "edit")).status_code, 200)
        self.assertEqual((await self.ask(self.W["slug"], self.session("gv"))).status_code, 409)

    async def test_workspace_viewer_on_the_domain(self):
        child = (await self.http.post("/api/v1/pages", json={"title": "Child", "parent": self.W["slug"]},
                                      headers=self.session("owner"))).json()["document"]
        r = await self.ask(self.W["slug"], self.tenant("wv", "W1"))
        self.assertEqual(r.status_code, 201, r.text)
        mine = await self.http.get(self.path(self.W["slug"]) + "/mine?role=editor", headers=self.tenant("wv", "W1"))
        self.assertEqual((mine.status_code, mine.json()["request_pending"]), (200, True))
        rid = r.json()["id"]
        self.assertEqual((await self.decide(rid, "owner", "edit")).status_code, 200)
        self.assertEqual((await self.put(self.W["slug"], self.tenant("wv", "W1"))).status_code, 200)
        # Page only: wv gets nothing new on the sub-page (still the workspace viewer they were).
        self.assertEqual((await self.put(child["slug"], self.tenant("wv", "W1"))).status_code, 403)
        g = await self.db["document_grants"].find_one({"document_id": str(self.W["_id"]),
                                                        "email": "wv@example.com"})
        self.assertEqual((g["role"], g["sub_role"], g["granted_by_user_id"]), ("editor", None, self.uid["owner"]))

    async def test_domain_requests_are_scoped(self):
        h = self.tenant("wv", "W1")
        # Another workspace's page (wm can read X with a session; never through W1's domain).
        self.assertEqual((await self.ask(self.X["slug"], self.tenant("wm", "W1"))).status_code, 404)
        r = await self.http.get(self.path(self.X["slug"]) + "/mine?role=editor", headers=self.tenant("wm", "W1"))
        self.assertEqual(r.status_code, 404)
        # Only edit requests from a domain (asking to open something is markdrop.in's gate).
        self.assertEqual((await self.ask(self.W["slug"], h, role="viewer")).status_code, 401)
        r = await self.http.get(self.path(self.W["slug"]) + "/mine", headers=h)
        self.assertEqual(r.status_code, 401)
        # Bad Origin / no Origin.
        self.assertEqual((await self.ask(self.W["slug"], self.tenant("wv", "W1", origin="https://e.test"))).status_code,
                         401)
        self.assertEqual((await self.ask(self.W["slug"], self.no_origin("wv"))).status_code, 401)
        # Deciding is never possible from a domain.
        rid = (await self.ask(self.W["slug"], self.session("gv"))).json()["id"]
        r = await self.http.post(f"/api/v1/access-requests/{rid}/decision", json={"decision": "edit"},
                                 headers=self.tenant("owner", "W1"))
        self.assertEqual(r.status_code, 401)
        self.assertEqual(await self.db["access_requests"].count_documents({}), 1)

    async def test_who_may_ask_to_edit(self):
        P = await self.mkdoc("P")
        cases = [
            (self.W, "wm", 409),        # already edits (member)
            (self.W, "ge", 409),        # already edits (grant)
            (self.W, "owner", 409),
            (self.W, "stranger", 404),  # can't read it: never learns it exists
            (P, "wv", 404),             # private, not theirs
            (self.L, "stranger", 201),  # a link page's reader
            (self.W, "wv", 201),
        ]
        for doc, who, code in cases:
            r = await self.ask(doc["slug"], self.session(who))
            self.assertEqual(r.status_code, code, (who, doc["access_level"], r.text))
        self.assertEqual((await self.http.post(self.path(self.W["slug"]), json={"role": "editor"})).status_code, 401)

    async def test_declined_cannot_ask_again_for_a_day(self):
        rid = (await self.ask(self.W["slug"], self.session("gv"))).json()["id"]
        self.mail.clear()
        r = await self.decide(rid, "owner", "decline")
        self.assertEqual((r.status_code, r.json()["status"]), (200, "declined"))
        self.assertIn("request to edit", self.mail[0]["subject"])
        self.assertEqual((await self.put(self.W["slug"], self.session("gv"))).status_code, 403)
        r = await self.ask(self.W["slug"], self.session("gv"))
        self.assertEqual(r.status_code, 429)
        await self.db["access_requests"].update_one({"_id": ObjectId(rid)},
                                                    {"$set": {"decided_at": now() - timedelta(days=2)}})
        self.assertEqual((await self.ask(self.W["slug"], self.session("gv"))).status_code, 201)

    async def test_no_reachable_owner_goes_to_the_admins(self):
        # The owner left the workspace: the request goes to its admins (wa, wo).
        await self.remove_member("W1", "owner")
        r = await self.ask(self.W["slug"], self.session("gv"), message="please")
        self.assertEqual(r.status_code, 201, r.text)
        rid = r.json()["id"]
        self.assertEqual(sorted(m["to"][0] for m in self.mail), ["wa@example.com", "wo@example.com"])
        self.assertIn("admins of Acme", self.mail[0]["html"])
        row = await self.db["access_requests"].find_one({"_id": ObjectId(rid)})
        self.assertEqual(row["admin_workspace_id"], self.ws["W1"])
        # In an admin's dashboard; not in a member's.
        lst = (await self.http.get("/api/v1/me/access-requests", headers=self.session("wa"))).json()
        self.assertEqual([x["id"] for x in lst["requests"]], [rid])
        self.assertTrue(lst["requests"][0]["as_admin"])
        lst = (await self.http.get("/api/v1/me/access-requests", headers=self.session("wm"))).json()
        self.assertEqual(lst["requests"], [])
        self.assertEqual((await self.decide(rid, "wm", "edit")).status_code, 404)
        # An admin of another workspace: no.
        await self.add_member("W2", "stranger", "admin")
        self.assertEqual((await self.decide(rid, "stranger", "edit")).status_code, 404)
        self.mail.clear()
        r = await self.decide(rid, "wa", "edit")
        self.assertEqual(r.status_code, 200, r.text)
        g = await self.db["document_grants"].find_one({"document_id": str(self.W["_id"]), "email": "gv@example.com"})
        self.assertEqual((g["role"], g["sub_role"], g["granted_via"], g["granted_by_user_id"]),
                         ("editor", "viewer", self.ws["W1"], self.uid["wa"]))
        self.assertEqual((await self.put(self.W["slug"], self.session("gv"))).status_code, 200)
        self.assertEqual([m["to"] for m in self.mail], [["gv@example.com"]])
        # The grant rests on the admin's role: they leave, it goes.
        await self.remove_member("W1", "wa")
        self.assertEqual((await self.put(self.W["slug"], self.session("gv"))).status_code, 404)

    async def test_owner_reachable_admins_never_decide(self):
        rid = (await self.ask(self.W["slug"], self.session("wv"))).json()["id"]
        self.assertEqual([m["to"] for m in self.mail], [["owner@example.com"]])
        self.assertEqual((await self.decide(rid, "wa", "edit")).status_code, 404)
        self.assertEqual((await self.decide(rid, "wo", "edit")).status_code, 404)
        lst = (await self.http.get("/api/v1/me/access-requests", headers=self.session("wa"))).json()
        self.assertEqual(lst["requests"], [])

    async def test_view_requests_are_unchanged(self):
        P = await self.mkdoc("P", ws=None)
        r = await self.http.post(self.path(P["slug"]), json={}, headers=self.session("stranger"))
        self.assertEqual(r.status_code, 201)
        self.assertIn("asked to open", self.mail[0]["subject"])
        row = await self.db["access_requests"].find_one({})
        self.assertNotIn("role_requested", row)
        # An admin never decides a request to open something.
        self.assertEqual((await self.decide(r.json()["id"], "wa", "view")).status_code, 404)


# ── Sharing with specific people on the domain (owner, 2026-11-04) ────────────


class ShareOnTheDomain(TenantWorld):
    """Who has access, add a person, remove a person: allowed on the workspace's own domain with the
    same answers as on markdrop.in. The general access level, resharing and presence: never."""

    async def _add(self, slug: str, headers: dict, email: str, role: str = "viewer"):
        return await self.http.post(f"/api/v1/documents/{slug}/access/people",
                                    json={"email": email, "role": role, "notify": False}, headers=headers)

    async def test_owner_shares_and_unshares_on_the_domain(self):
        slug, h = self.W["slug"], self.tenant("owner", "W1")
        r = await self.http.get(f"/api/v1/documents/{slug}/access", headers=h)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["can_share"])
        r = await self._add(slug, h, "newcomer@example.com", "editor")
        self.assertEqual(r.status_code, 201, r.text)
        g = await self.db["document_grants"].find_one({"document_id": str(self.W["_id"]), "email": "newcomer@example.com"})
        self.assertIsNotNone(g)
        self.assertEqual(g["role"], "editor")
        r = await self.http.delete(f"/api/v1/documents/{slug}/access/people/newcomer@example.com", headers=h)
        self.assertEqual(r.status_code, 204, r.text)
        self.assertIsNone(await self.db["document_grants"].find_one(
            {"document_id": str(self.W["_id"]), "email": "newcomer@example.com"}))
        # The level never moved.
        self.assertEqual((await self.db["documents"].find_one({"_id": self.W["_id"]}))["access_level"], "workspace")

    async def test_same_answer_as_on_markdrop_in(self):
        # Whoever may (or may not) share on markdrop.in gets the same answer on the domain.
        slug = self.L["slug"]
        for i, who in enumerate(("owner", "wm", "ge", "gv", "wv", "wa")):
            dom = await self._add(slug, self.tenant(who, "W1"), f"d{i}@example.com")
            web = await self._add(slug, self.session(who), f"s{i}@example.com")
            self.assertEqual(dom.status_code, web.status_code, (who, dom.text, web.text))
            ga = await self.http.get(f"/api/v1/documents/{slug}/access", headers=self.tenant(who, "W1"))
            gw = await self.http.get(f"/api/v1/documents/{slug}/access", headers=self.session(who))
            self.assertEqual(ga.status_code, gw.status_code, who)

    async def test_scoped_to_the_domains_workspace(self):
        # wm is in W1 and W2; their W1 domain token can't touch W2's page, nor a personal one.
        h = self.tenant("wm", "W1")
        for doc in (self.X, self.U):
            slug = doc["slug"]
            self.assertEqual((await self.http.get(f"/api/v1/documents/{slug}/access", headers=h)).status_code, 404)
            self.assertEqual((await self._add(slug, h, "x@example.com")).status_code, 404)
            r = await self.http.delete(f"/api/v1/documents/{slug}/access/people/x@example.com", headers=h)
            self.assertEqual(r.status_code, 404)
        self.assertEqual(await self.db["document_grants"].count_documents({"email": "x@example.com"}), 0)

    async def test_origin_and_live_host_still_required(self):
        slug = self.W["slug"]
        r = await self._add(slug, self.no_origin("owner"), "o@example.com")
        self.assertEqual(r.status_code, 401)
        r = await self._add(slug, self.tenant("owner", "W1", origin="https://evil.example"), "o@example.com")
        self.assertEqual(r.status_code, 401)
        self.assertEqual(await self.db["document_grants"].count_documents({"email": "o@example.com"}), 0)

    async def test_general_access_stays_on_markdrop_in(self):
        slug, h = self.W["slug"], self.tenant("owner", "W1")
        for method, path, body in (
            ("PUT", f"/api/v1/documents/{slug}/access/level", {"level": "link"}),
            ("PUT", f"/api/v1/documents/{slug}/access/resharing", {"allow": True}),
            ("PUT", f"/api/v1/documents/{slug}/access/presence", {"show": False}),
            ("POST", "/api/v1/documents/access/level", {"slugs": [slug], "level": "link"}),
            ("PATCH", f"/api/v1/documents/{slug}/settings", {"read_password": "pw"}),
        ):
            r = await self.http.request(method, path, json=body, headers=h)
            self.assertIn(r.status_code, (401, 405), (method, path, r.text))
        doc = await self.db["documents"].find_one({"_id": self.W["_id"]})
        self.assertEqual((doc["access_level"], doc.get("read_password_hash")), ("workspace", None))
