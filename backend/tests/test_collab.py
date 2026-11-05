"""Working together on a page (fix/collab-audit): what the server does for people and AI apps
changing the same page, beyond the edit lock (services/pages.py, fix/edit-lock-idle's).

- MCP ``update_document`` takes ``base_rev`` (get_document returns ``rev``): a stale write is
  refused, nothing written (it used to overwrite whatever was saved since).
- Someone removed from a workspace, or given another role there, is told on every page they have
  open (``{"type": "access"}`` on their own sockets only: the page re-checks through the read path).
- Sub-pages added, moved or removed: the parents' open copies hear ``{"type": "children"}``.
- Folder views: a save on a stale ``base_rev`` is a 409 (the page replays its change onto theirs).

Runs in the access-policy world (tests/_access_env.py). Never backend/.env.
"""

from __future__ import annotations

import asyncio
from unittest import mock

from tests._access_env import AccessWorld  # noqa: F401  (pins settings first)
from tests.test_viewers import FakeSocket, settle

from app.routers import live as live_router
from app.services import tickets, viewers


class CollabWorld(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        viewers.clear()
        p = mock.patch.object(viewers, "FLUSH_S", 0.0)
        p.start()
        self.addCleanup(p.stop)
        from app.limiter import limiter

        limiter.enabled = False
        self.addCleanup(setattr, limiter, "enabled", True)
        self.tasks: list[asyncio.Task] = []
        self.addAsyncCleanup(self._close_all)

    async def _close_all(self):
        for t in self.tasks:
            t.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        viewers.clear()

    async def open(self, d: dict, who: str | None = None) -> FakeSocket:
        """A page open in someone's browser: its live socket, said hello (as ``who``)."""
        ws = FakeSocket(tickets.mint(str(d["_id"]), int(d.get("access_epoch") or 0)))
        self.tasks.append(asyncio.create_task(live_router.serve(ws, d["slug"])))
        await settle(2)
        msg = {"type": "hello", "n": f"tab{len(self.tasks):04d}xyz", "anon": False, "state": "active"}
        if who:
            msg["pt"] = tickets.mint_presence(str(d["_id"]), self.uid[who])
        ws.say(**msg)
        await settle()
        return ws

    @staticmethod
    def events(ws: FakeSocket, kind: str) -> list[dict]:
        return [m for m in ws.sent if m.get("type") == kind]

    async def page(self, who: str = "owner", **body) -> dict:
        body.setdefault("title", "A page")
        r = await self.http.post("/api/v1/pages", json=body, headers=self.session(who))
        self.assertEqual(r.status_code, 201, r.text)
        return await self.doc(r.json()["document"]["slug"])


class McpUpdateDocumentBaseRev(CollabWorld):
    async def test_get_document_returns_rev_and_a_stale_update_is_refused(self):
        d = await self.mkdoc("W", content="# Plan\n\nOne.\n")
        tok = await self.mcp_token("owner")
        status, got = await self.mcp_call(tok, "get_document", {"document": d["slug"]})
        self.assertEqual(status, 200)
        rev = got["structuredContent"]["rev"]
        self.assertEqual(rev, 1)
        # Someone saves meanwhile (the website's own path, with base_rev).
        r = await self.http.put(f"/api/v1/documents/{d['slug']}", headers=self.session("wm"),
                                json={"title": d["title"], "content": "# Plan\n\nOne. Ben.\n", "base_rev": rev})
        self.assertEqual(r.status_code, 200, r.text)
        # The AI writes its stale copy: refused, nothing written.
        _s, res = await self.mcp_call(tok, "update_document", {"document": d["slug"], "content": "# Plan\n\nAI.\n",
                                                               "base_rev": rev})
        self.assertTrue(res["isError"])
        self.assertIn("changed since revision 1", res["content"][0]["text"])
        self.assertIn("One. Ben.", (await self.doc(d["slug"]))["content"])
        # On the current rev it writes.
        _s, res = await self.mcp_call(tok, "update_document", {"document": d["slug"], "content": "# Plan\n\nAI.\n",
                                                               "base_rev": 2})
        self.assertFalse(res["isError"], res["content"][0]["text"])
        self.assertEqual(res["structuredContent"]["rev"], 3)

    async def test_without_base_rev_it_still_writes(self):
        d = await self.mkdoc("W", content="# Plan\n")
        _s, res = await self.mcp_call(await self.mcp_token("owner"), "update_document",
                                      {"document": d["slug"], "content": "# Plan v2\n"})
        self.assertFalse(res["isError"], res["content"][0]["text"])

    async def test_the_tool_documents_base_rev(self):
        from app.mcp import tools as mcp_tools

        t = next(t for t in mcp_tools.TOOLS if t.name == "update_document")
        self.assertIn("base_rev", t.input_schema["properties"])
        self.assertIn("base_rev", t.description)


class AccessChangesReachOpenPages(CollabWorld):
    async def test_removed_member_is_told_on_their_open_pages_only(self):
        d = await self.mkdoc("W")
        ben = await self.open(d, "wm")
        wes = await self.open(d, "wa")
        r = await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/members/{self.uid['wm']}",
                                   headers=self.session("wo"))
        self.assertEqual(r.status_code, 204, r.text)
        await settle()
        self.assertEqual(self.events(ben, "access"), [{"type": "access"}])
        self.assertEqual(ben.closed, 4001)
        self.assertEqual(self.events(wes, "access"), [])
        self.assertIsNone(wes.closed)

    async def test_a_new_role_rechecks_too(self):
        d = await self.mkdoc("W")
        ben = await self.open(d, "wm")
        r = await self.http.put(f"/api/v1/workspaces/{self.ws['W1']}/members/{self.uid['wm']}",
                                json={"role": "viewer"}, headers=self.session("wo"))
        self.assertEqual(r.status_code, 204, r.text)
        await settle()
        self.assertEqual(self.events(ben, "access"), [{"type": "access"}])

    async def test_anonymous_sockets_are_never_targeted(self):
        d = await self.mkdoc("L")
        anon = await self.open(d)
        self.assertEqual(viewers.access_changed_for(self.uid["wm"]), 0)
        self.assertEqual(viewers.access_changed_for(None), 0)
        await settle()
        self.assertEqual(self.events(anon, "access"), [])


class ChildrenEvents(CollabWorld):
    async def test_add_move_and_delete_tell_the_parents(self):
        a = await self.page(workspace=self.ws["W1"], title="Parent A")
        b = await self.page(workspace=self.ws["W1"], title="Parent B")
        on_a = await self.open(a, "owner")
        on_b = await self.open(b, "owner")
        kid = await self.page(parent=a["slug"], title="Kid")
        await settle()
        self.assertEqual(len(self.events(on_a, "children")), 1)
        r = await self.http.put(f"/api/v1/documents/{kid['slug']}/parent", json={"parent": b["slug"]},
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        await settle()
        self.assertEqual(len(self.events(on_a, "children")), 2)
        self.assertEqual(len(self.events(on_b, "children")), 1)
        r = await self.http.delete(f"/api/v1/documents/{kid['slug']}", headers=self.session("owner"))
        self.assertIn(r.status_code, (200, 204), r.text)
        await settle()
        self.assertEqual(len(self.events(on_b, "children")), 2)
        # Nothing about the pages themselves rides on it.
        self.assertTrue(all(set(m) == {"type"} for m in self.events(on_b, "children")))


class FolderViews(CollabWorld):
    async def test_a_stale_views_save_is_refused(self):
        fr = await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/folders", json={"name": "Specs"},
                                  headers=self.session("wo"))
        self.assertIn(fr.status_code, (200, 201), fr.text)
        folder = fr.json()["id"]
        path = f"/api/v1/workspaces/{self.ws['W1']}/folders/{folder}"
        db0 = (await self.http.get(f"{path}/database?rows=false", headers=self.session("wo"))).json()
        a = await self.http.put(f"{path}/views", headers=self.session("wo"),
                                json={"views": [{"id": "vaaa", "name": "Ada", "type": "table"}], "base_rev": db0["rev"]})
        self.assertEqual(a.status_code, 200, a.text)
        b = await self.http.put(f"{path}/views", headers=self.session("wa"),
                                json={"views": [{"id": "vbbb", "name": "Wes", "type": "table"}], "base_rev": db0["rev"]})
        self.assertEqual(b.status_code, 409, b.text)
