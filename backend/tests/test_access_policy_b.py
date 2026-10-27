"""Access policy test catalogue §6.8–§6.13 (cases 86–180): listings, folders
and folder shares, tenant tokens, domains, membership and workspace lifecycle."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from bson import ObjectId

from tests._access_env import HOSTS, AccessWorld

from app.services import access, folder as folder_service, lifecycle, transitions


def now():
    return datetime.now(timezone.utc)


class Listings(AccessWorld):
    async def _items(self, who, ws="W1", **params):
        r = await self.http.get(f"/api/v1/workspaces/{self.ws[ws]}/items", params=params, headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["items"]

    async def test_c086_private_absent_and_total(self):
        p = await self.mkdoc("P")
        w = await self.mkdoc("W")
        r = await self.http.get(f"/api/v1/workspaces/{self.ws['W1']}/documents", headers=self.session("wm"))
        body = r.json()
        slugs = [d["slug"] for d in body["documents"]]
        self.assertNotIn(p["slug"], slugs)
        self.assertIn(w["slug"], slugs)
        self.assertEqual(body["total"], 1)

    async def test_c087_search_never_sees_private(self):
        p = await self.mkdoc("P")
        r = await self.http.get(f"/api/v1/workspaces/{self.ws['W1']}/documents", params={"q": p["title"]},
                                headers=self.session("wm"))
        self.assertEqual(r.json()["total"], 0)
        self.assertEqual(await self._items("wm", q=p["title"]), [])

    async def test_c088_counts_and_tree_exclude_private(self):
        f = await folder_service.create_folder(self.db, self.ws["W1"], "Docs", None)
        await self.mkdoc("P", folder_id=f.id)
        await self.mkdoc("W", folder_id=f.id)
        counts = (await self.http.get(f"/api/v1/workspaces/{self.ws['W1']}/documents/counts",
                                      headers=self.session("wm"))).json()
        self.assertEqual(counts.get(f.id), 1)
        tree = (await self.http.get(f"/api/v1/workspaces/{self.ws['W1']}/tree", headers=self.session("wm"))).json()
        node = next(n for n in tree["folders"] if n["id"] == f.id)
        self.assertEqual((node["item_count"], node["total_count"]), (1, 1))
        tree = (await self.http.get(f"/api/v1/workspaces/{self.ws['W1']}/tree", headers=self.session("owner"))).json()
        self.assertEqual(next(n for n in tree["folders"] if n["id"] == f.id)["item_count"], 2)

    async def test_c089_admin_sees_redacted_row(self):
        p = await self.mkdoc("P", grants=False)
        items = await self._items("wa")
        red = [i for i in items if i["redacted"]]
        self.assertEqual(len(red), 1)
        row = red[0]
        self.assertIsNone(row["title"])
        self.assertIsNone(row["slug"])
        self.assertIsNone(row["url"])
        self.assertIsNone(row["size_bytes"])
        self.assertEqual(row["owner"]["name"], "OWNER")
        self.assertEqual(row["can"], {"edit": False, "move": False, "unshare": True, "delete": False, "share": False})
        self.assertNotIn(p["slug"], str(row))
        # …and the handle is enough to remove it from the workspace.
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/items/remove",
                                 json={"handles": [row["id_token"]]}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["items"], [{"slug": None, "access_after": "private"}])
        self.assertIsNone((await self.doc(p["slug"]))["workspace_id"])

    async def test_c090_grant_makes_private_row_full(self):
        p = await self.mkdoc("P", grants=False)
        await self.add_member("W1", "gv", "viewer")
        await self.db["document_grants"].insert_one({"document_id": str(p["_id"]), "email": self.email["gv"],
                                                     "role": "viewer", "created_at": now()})
        items = await self._items("gv")
        self.assertEqual([i["slug"] for i in items], [p["slug"]])
        self.assertFalse(items[0]["redacted"])

    async def test_c091_no_id_or_google_link_for_others(self):
        await self.mkdoc("W", google_doc_url="https://docs.google.com/x", google_doc_id="g")
        r = await self.http.get(f"/api/v1/workspaces/{self.ws['W1']}/documents", headers=self.session("wm"))
        for row in r.json()["documents"]:
            self.assertIsNone(row["id"])
            self.assertIsNone(row["google_doc_url"])
        for row in await self._items("wm"):
            self.assertNotIn("id", row)

    async def test_c092_encrypted_row_has_no_title(self):
        await self.mkdoc("W", encrypted=True, title="mdx1.cipher")
        row = (await self._items("wm"))[0]
        self.assertIsNone(row["title"])
        r = await self.http.get(f"/api/v1/workspaces/{self.ws['W1']}/documents", headers=self.session("wm"))
        self.assertEqual(r.json()["documents"][0]["content_preview"], "")

    async def test_c093_expired_absent_everywhere(self):
        from datetime import timedelta

        d = await self.mkdoc("W", expires_at=now() - timedelta(seconds=1))
        self.assertEqual(await self._items("wm"), [])
        self.assertEqual(await self._items("owner"), [])
        r = await self.http.get("/api/v1/me/documents", headers=self.session("owner"))
        self.assertNotIn(d["slug"], [x["slug"] for x in r.json()["documents"]])

    async def test_c094_cannot_move_unreadable(self):
        f = await folder_service.create_folder(self.db, self.ws["W1"], "Docs", None)
        p = await self.mkdoc("P")
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/documents/move",
                                 json={"slug": p["slug"], "folder_id": f.id}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 404)
        self.assertIsNone((await self.doc(p["slug"]))["folder_id"])

    async def test_c095_member_moves_readable(self):
        f = await folder_service.create_folder(self.db, self.ws["W1"], "Docs", None)
        d = await self.mkdoc("W")
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/documents/move",
                                 json={"slug": d["slug"], "folder_id": f.id}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 204, r.text)
        self.assertEqual((await self.doc(d["slug"]))["folder_path"], ["docs"])
        self.assertIn(f"doc:{d['slug']}", await self.jobs())

    async def test_c096_viewer_cannot_move(self):
        f = await folder_service.create_folder(self.db, self.ws["W1"], "Docs", None)
        d = await self.mkdoc("W")
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/items/move",
                                 json={"slugs": [d["slug"]], "folder_id": f.id}, headers=self.session("wv"))
        self.assertEqual(r.status_code, 403)

    async def test_c097_folder_delete_counts_readable(self):
        f = await folder_service.create_folder(self.db, self.ws["W1"], "Docs", None)
        for state, owner in (("W", "owner"), ("W", "owner"), ("P", "wm")):
            await self.mkdoc(state, owner=owner, folder_id=f.id, grants=False)
        r = await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/folders/{f.id}", headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["unfiled_documents"], 2)

    async def test_c098_me_documents_owned_only(self):
        mine = await self.mkdoc("W")
        await self.mkdoc("W", owner="wm")
        r = await self.http.get("/api/v1/me/documents", headers=self.session("owner"))
        self.assertEqual([d["slug"] for d in r.json()["documents"]], [mine["slug"]])

    async def test_c099_mcp_list_scope_workspaces(self):
        p = await self.mkdoc("P")
        w = await self.mkdoc("W")
        token = await self.mcp_token("wm", write=False)
        _s, res = await self.mcp_call(token, "list_documents", {"scope": "workspaces"})
        slugs = [i["slug"] for i in res["structuredContent"]["items"]]
        self.assertIn(w["slug"], slugs)
        self.assertNotIn(p["slug"], slugs)
        self.assertEqual(res["structuredContent"]["items"][0]["url"], f"https://docs.acme.test/{w['slug']}")

    async def test_c100_mcp_search_all_no_unreadable_title(self):
        p = await self.mkdoc("P", title="Secret roadmap")
        await self.mkdoc("W", title="Public roadmap")
        token = await self.mcp_token("wm", write=False)
        _s, res = await self.mcp_call(token, "search", {"query": "roadmap", "scope": "all"})
        self.assertNotIn("Secret roadmap", str(res))
        self.assertIn("Public roadmap", str(res))

    async def _host_folder(self, headers=None, host="docs.acme.test", path=""):
        return await self.http.get("/api/v1/host/folder", params={"host": host, "path": path}, headers=headers or {})

    async def test_c101_anonymous_host_root(self):
        l = await self.mkdoc("L")
        lp, w, p = await self.mkdoc("LP"), await self.mkdoc("W"), await self.mkdoc("P")
        e = await self.mkdoc("L", encrypted=True)
        r = await self._host_folder()
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual([d["slug"] for d in body["documents"]], [l["slug"]])
        self.assertEqual(set(body), {"folder", "trail", "folders", "documents", "workspace"})
        self.assertIsNone(body["folder"])
        self.assertEqual(body["documents"][0]["url"], f"https://docs.acme.test/{l['slug']}")
        self.assertEqual(r.headers["Cache-Control"], "public, max-age=60")
        for d in (lp, w, p, e):
            self.assertNotIn(d["slug"], r.text)

    async def test_c102_require_auth_host_signin(self):
        await folder_service.create_folder(self.db, self.ws["WR"], "Secret Folder", None)
        r = await self._host_folder(host="docs-r.acme.test")
        self.assertEqual((r.status_code, r.headers.get("X-Markdrop-Gate")), (401, "signin"))
        self.assertNotIn("Secret Folder", r.text)
        self.assertEqual(r.json()["workspace"]["name"], "Acme Private")

    async def test_c103_folder_with_only_members_docs(self):
        f = await folder_service.create_folder(self.db, self.ws["W1"], "Team", None)
        await self.mkdoc("W", folder_id=f.id, folder_path=["team"])
        r = await self._host_folder(path="team")
        self.assertEqual(r.status_code, 404)
        r = await self._host_folder(self.tenant("wm", "W1"), path="team")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len(r.json()["documents"]), 1)
        # …and the anonymous root doesn't list the folder either.
        self.assertEqual((await self._host_folder()).json()["folders"], [])


class Folders(AccessWorld):
    async def test_c104_member_cannot_rename_folder(self):
        f = await folder_service.create_folder(self.db, self.ws["W1"], "Docs", None)
        url = f"/api/v1/workspaces/{self.ws['W1']}/folders/{f.id}"
        self.assertEqual((await self.http.patch(url, json={"name": "X"}, headers=self.session("wm"))).status_code, 403)
        self.assertEqual((await self.http.put(url, json={"name": "X"}, headers=self.session("wm"))).status_code, 403)
        r = await self.http.patch(url, json={"name": "Renamed"}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["path"], ["renamed"])

    async def _chain(self, depth, base="c"):
        parent, ids = None, []
        for i in range(depth):
            f = await folder_service.create_folder(self.db, self.ws["W1"], f"{base}{i}", parent)
            ids.append(f.id)
            parent = f.id
        return ids

    async def test_c105_move_depth_counts_subtree(self):
        deep = await self._chain(6, "deep")           # target at depth 6
        sub = await self._chain(3, "sub")             # a folder with a subtree of height 3
        r = await self.http.patch(f"/api/v1/workspaces/{self.ws['W1']}/folders/{sub[0]}",
                                  json={"parent_id": deep[-1]}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 422, r.text)

    async def test_c106_concurrent_moves_no_cycle(self):
        from unittest import mock

        a = await folder_service.create_folder(self.db, self.ws["W1"], "A", None)
        b = await folder_service.create_folder(self.db, self.ws["W1"], "B", None)
        rev = await folder_service.folders_rev(self.db, self.ws["W1"])
        # Both admins validated against the same snapshot (no cycle yet): the
        # second validates against the stale tree, and the folder lock (CAS on
        # folders_rev) is what refuses it.
        stale = await folder_service.list_folders(self.db, self.ws["W1"])
        with mock.patch.object(folder_service, "list_folders", mock.AsyncMock(return_value=stale)):
            results = await asyncio.gather(
                folder_service.update_folder(self.db, self.ws["W1"], a.id, parent_id=b.id, reparent=True,
                                             expected_rev=rev),
                folder_service.update_folder(self.db, self.ws["W1"], b.id, parent_id=a.id, reparent=True,
                                             expected_rev=rev),
                return_exceptions=True)
        errors = [r for r in results if isinstance(r, Exception)]
        self.assertEqual(len(errors), 1, results)
        self.assertEqual(getattr(errors[0], "status_code", None), 409)
        rows = {str(r["_id"]): r.get("parent_id") for r in await self.db["folders"].find({}).to_list(10)}
        self.assertFalse(rows[a.id] == b.id and rows[b.id] == a.id)

    async def test_c107_rename_reindexes_and_purges(self):
        f = await folder_service.create_folder(self.db, self.ws["W1"], "Old", None)
        child = await folder_service.create_folder(self.db, self.ws["W1"], "Child", f.id)
        d1 = await self.mkdoc("W", folder_id=f.id, folder_path=["old"])
        d2 = await self.mkdoc("W", folder_id=child.id, folder_path=["old", "child"])
        r = await self.http.patch(f"/api/v1/workspaces/{self.ws['W1']}/folders/{f.id}", json={"name": "Fresh"},
                                  headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self.doc(d1["slug"]))["folder_path"], ["fresh"])
        self.assertEqual((await self.doc(d2["slug"]))["folder_path"], ["fresh", "child"])
        jobs = await self.jobs()
        self.assertTrue({f"doc:{d1['slug']}", f"doc:{d2['slug']}", f"tag:wsl:{self.ws['W1']}"} <= jobs)

    async def test_c108_old_path_points_to_new_canonical(self):
        # The 307 itself is the frontend's; the API gives the current path.
        f = await folder_service.create_folder(self.db, self.ws["W1"], "Old", None)
        d = await self.mkdoc("L", folder_id=f.id, folder_path=["old"])
        await self.http.patch(f"/api/v1/workspaces/{self.ws['W1']}/folders/{f.id}", json={"name": "Fresh"},
                              headers=self.session("wa"))
        r = await self.get(d["slug"], {"X-Markdrop-Workspace": self.ws["W1"]})
        self.assertEqual(r.json()["folder_path"], ["fresh"])
        self.assertEqual(r.json()["workspace_url"], f"https://docs.acme.test/fresh/{d['slug']}")

    async def test_c109_stack_old_folder_page_404(self):
        self.skipTest("[S] #109: tenant chrome 404 page (frontend)")

    async def _share(self, who, fid, level="link"):
        return await self.http.put(f"/api/v1/workspaces/{self.ws['W1']}/folders/{fid}/share",
                                   json={"level": level}, headers=self.session(who))

    async def test_c110_share_hidden_lists_what_caller_can_read(self):
        f = await folder_service.create_folder(self.db, self.ws["W1"], "Shared", None)
        l = await self.mkdoc("L", folder_id=f.id)
        lp = await self.mkdoc("LP", folder_id=f.id)
        w = await self.mkdoc("W", folder_id=f.id)
        p = await self.mkdoc("P", folder_id=f.id, grants=False)
        r = await self._share("wa", f.id)
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        hidden = {h["slug"] for h in body["hidden"]}
        self.assertEqual(hidden, {lp["slug"], w["slug"]})
        self.assertEqual(body["hidden_count"], 2)
        self.assertEqual(body["total_count"], 3)
        self.assertTrue(all(set(h) >= {"slug", "title", "access", "is_yours", "has_password"} for h in body["hidden"]))
        self.assertTrue(body["url"].endswith(f"/f/{body['share_id']}"))
        self.assertNotIn(p["slug"], r.text)
        g = await self.http.get(f"/api/v1/workspaces/{self.ws['W1']}/folders/{f.id}/share", headers=self.session("wa"))
        self.assertEqual(g.json()["share_id"], body["share_id"])
        self.assertNotIn(l["slug"], {h["slug"] for h in body["hidden"]})

    async def _shared(self, share_id, headers=None, path=""):
        return await self.http.get(f"/api/v1/folders/shared/{share_id}", params={"path": path},
                                   headers=headers or {})

    async def _shared_setup(self, level="link"):
        f = await folder_service.create_folder(self.db, self.ws["W1"], "Shared", None)
        docs = {s: await self.mkdoc(s, folder_id=f.id) for s in ("L", "LP", "W", "P")}
        share = (await self._share("wa", f.id, level)).json()
        return f, docs, share["share_id"]

    async def test_c111_link_share_anonymous_sees_link_docs(self):
        _f, docs, sid = await self._shared_setup()
        r = await self._shared(sid)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([i["slug"] for i in r.json()["items"]], [docs["L"]["slug"]])

    async def test_c112_link_share_grantee_sees_their_doc(self):
        _f, docs, sid = await self._shared_setup()
        slugs = {i["slug"] for i in (await self._shared(sid, self.session("gv"))).json()["items"]}
        self.assertEqual(slugs, {docs[s]["slug"] for s in ("L", "LP", "W", "P")})  # gv holds a grant on each
        await self.db["document_grants"].delete_many({"email": self.email["gv"],
                                                      "document_id": {"$in": [str(docs["LP"]["_id"]), str(docs["P"]["_id"])]}})
        slugs = {i["slug"] for i in (await self._shared(sid, self.session("gv"))).json()["items"]}
        self.assertEqual(slugs, {docs["L"]["slug"], docs["W"]["slug"]})

    async def test_c113_workspace_share_needs_member(self):
        _f, _docs, sid = await self._shared_setup("workspace")
        self.assertEqual((await self._shared(sid, self.session("stranger"))).status_code, 404)
        r = await self._shared(sid)
        self.assertEqual((r.status_code, r.headers.get("X-Markdrop-Gate")), (401, "signin"))
        self.assertEqual((await self._shared(sid, self.session("wv"))).status_code, 200)

    async def test_c114_share_survives_move_breadcrumbs_relative(self):
        parent = await folder_service.create_folder(self.db, self.ws["W1"], "Parent", None)
        f, docs, sid = await self._shared_setup()
        sub = await folder_service.create_folder(self.db, self.ws["W1"], "Sub", f.id)
        await self.mkdoc("L", folder_id=sub.id)
        await folder_service.update_folder(self.db, self.ws["W1"], f.id, parent_id=parent.id, reparent=True)
        r = await self._shared(sid)
        self.assertEqual([i["slug"] for i in r.json()["items"]], [docs["L"]["slug"]])
        self.assertEqual(r.json()["folder"]["breadcrumbs"], [{"name": "Shared", "path": ""}])
        r = await self._shared(sid, path="sub")
        self.assertEqual(r.json()["folder"]["breadcrumbs"], [{"name": "Shared", "path": ""}, {"name": "Sub", "path": "sub"}])

    async def test_c115_deleted_shared_folder_404(self):
        f, _docs, sid = await self._shared_setup()
        await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/folders/{f.id}", headers=self.session("wa"))
        self.assertEqual((await self._shared(sid)).status_code, 404)

    async def test_c116_subfolder_with_only_members_docs_hidden(self):
        f, _docs, sid = await self._shared_setup()
        sub = await folder_service.create_folder(self.db, self.ws["W1"], "Team", f.id)
        await self.mkdoc("W", folder_id=sub.id)
        r = await self._shared(sid)
        self.assertEqual(r.json()["subfolders"], [])
        self.assertEqual((await self._shared(sid, path="team")).status_code, 404)

    async def test_c117_members_cannot_share_when_off(self):
        f = await folder_service.create_folder(self.db, self.ws["W1"], "Docs", None)
        self.assertEqual((await self._share("wm", f.id)).status_code, 200)
        await self.db["workspaces"].update_one({"_id": ObjectId(self.ws["W1"])},
                                               {"$set": {"settings.members_can_share_folders": False}})
        self.assertEqual((await self._share("wm", f.id)).status_code, 403)
        self.assertEqual((await self._share("wa", f.id)).status_code, 200)

    async def test_c118_share_changes_no_document(self):
        f = await folder_service.create_folder(self.db, self.ws["W1"], "Docs", None)
        d = await self.mkdoc("W", folder_id=f.id, kind="artifact")
        before = await self.doc(d["slug"])
        grants = await self.db["document_grants"].count_documents({})
        calls = len(self.r2.public_calls)
        await self._share("wa", f.id)
        self.assertEqual(await self.doc(d["slug"]), before)
        self.assertEqual(await self.db["document_grants"].count_documents({}), grants)
        self.assertEqual(len(self.r2.public_calls), calls)

    async def test_c119_share_id_shape_stable(self):
        import re

        f = await folder_service.create_folder(self.db, self.ws["W1"], "Docs", None)
        sid = (await self._share("wa", f.id)).json()["share_id"]
        self.assertTrue(re.fullmatch(r"[A-Za-z0-9_-]{10,12}", sid), sid)
        await self.http.patch(f"/api/v1/workspaces/{self.ws['W1']}/folders/{f.id}", json={"name": "Renamed"},
                              headers=self.session("wa"))
        self.assertEqual((await self._share("wa", f.id)).json()["share_id"], sid)

    async def test_c120_require_auth_share_signin_branding_only(self):
        f = await folder_service.create_folder(self.db, self.ws["WR"], "Docs", None)
        await self.mkdoc("RL", folder_id=f.id)
        r = await self.http.put(f"/api/v1/workspaces/{self.ws['WR']}/folders/{f.id}/share", json={"level": "link"},
                                headers=self.session("wa"))
        r = await self._shared(r.json()["share_id"])
        self.assertEqual((r.status_code, r.headers.get("X-Markdrop-Gate")), (401, "signin"))
        self.assertEqual(set(r.json()), {"detail", "gate", "workspace"})


class Tenants(AccessWorld):
    async def test_c121_tenant_origin_mismatch(self):
        self.skipTest("#121 Origin == claim host lives in routers/auth.py _tenant_scope_ok (tenant workstream)")

    async def test_c122_tenant_cannot_write(self):
        d = await self.mkdoc("W")
        r = await self.http.put(f"/api/v1/documents/{d['slug']}", json={"title": "x", "content": "y"},
                                headers=self.tenant("wm", "W1"))
        self.assertEqual(r.status_code, 401)

    async def test_c123_tenant_cannot_list_me(self):
        r = await self.http.get("/api/v1/me/documents", headers=self.tenant("wm", "W1"))
        self.assertEqual(r.status_code, 401)

    async def test_c124_tenant_other_workspace_404(self):
        d = await self.mkdoc("W", ws="W2", owner="wm2")
        self.assertEqual((await self.get(d["slug"], self.tenant("wm", "W1"))).status_code, 404)

    async def test_c125_tenant_unfiled_404(self):
        d = await self.mkdoc("L", ws=None)
        self.assertEqual((await self.get(d["slug"], self.tenant("wm", "W1"))).status_code, 404)

    async def test_c126_c128_tenant_host_liveness(self):
        self.skipTest("#126-#128 tenant token dies with its host: routers/auth.py (tenant workstream)")

    async def test_c129_tenant_me_name_only(self):
        self.skipTest("#129 /auth/me for tenant tokens (S5): routers/auth.py (tenant workstream)")

    async def test_c130_header_narrows(self):
        d = await self.mkdoc("L")
        r = await self.get(d["slug"], {**self.session("owner"), "X-Markdrop-Workspace": self.ws["W2"]})
        self.assertEqual(r.status_code, 404)

    async def test_c131_header_never_widens(self):
        d = await self.mkdoc("W")
        r = await self.get(d["slug"], {"X-Markdrop-Workspace": self.ws["W1"]})
        self.assertEqual((r.status_code, r.headers.get("X-Markdrop-Gate")), (401, "signin"))

    async def test_c132_c134_mint_and_cors(self):
        self.skipTest("#132-#134 tenant mint / CORS: services/domain.py, middleware/tenant_cors.py (tenant workstream)")

    async def test_c135_invalid_api_token_401(self):
        d = await self.mkdoc("L", ws=None)
        r = await self.get(d["slug"], {"Authorization": "Bearer mdk_not_a_real_token"})
        self.assertEqual(r.status_code, 401)

    async def test_c136_expired_session_is_anonymous(self):
        import jwt

        from app.config import get_settings

        d = await self.mkdoc("L", ws=None)
        token = jwt.encode({"sub": self.uid["owner"], "email": "x", "typ": "access",
                            "exp": datetime(2000, 1, 1, tzinfo=timezone.utc)}, get_settings().auth_secret)
        r = await self.get(d["slug"], {"Authorization": f"Bearer {token}"})
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["is_owner"])

    async def test_c137_mcp_token_on_rest(self):
        d = await self.mkdoc("L", ws=None)
        token = await self.mcp_token("owner")
        h = {"Authorization": f"Bearer {token}"}
        r = await self.http.put(f"/api/v1/documents/{d['slug']}", json={"title": "x", "content": "y"}, headers=h)
        self.assertEqual(r.status_code, 401)
        r = await self.get(d["slug"], h)
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["is_owner"])

    async def test_c138_c140_stack_tenant_routing(self):
        self.skipTest("[S] #138-#140: /h/* rewrite and #mdt= handling (frontend)")


class Domains(AccessWorld):
    async def test_c141_c146_domain_lifecycle(self):
        self.skipTest("#141-#146 domain verify/lapse lifecycle: services/domain.py (tenant workstream)")

    async def test_c147_primary_change_moves_canonical(self):
        d = await self.mkdoc("L")
        await self.add_domain("W1", "docs2.acme.test", is_primary=False)
        r = await self.get(d["slug"])
        self.assertEqual(r.json()["workspace_url"], f"https://docs.acme.test/{d['slug']}")
        await self.db["domains"].update_many({"workspace_id": self.ws["W1"]}, {"$set": {"is_primary": False}})
        await self.db["domains"].update_one({"host": "docs2.acme.test"}, {"$set": {"is_primary": True}})
        r = await self.get(d["slug"])
        self.assertEqual(r.json()["workspace_url"], f"https://docs2.acme.test/{d['slug']}")
        self.assertEqual(r.json()["url"], f"https://markdrop.in/{d['slug']}")
        # A lapsed / detached host is never canonical.
        await self.db["domains"].update_one({"host": "docs2.acme.test"}, {"$set": {"lapsed": True}})
        r = await self.get(d["slug"])
        self.assertEqual(r.json()["workspace_url"], f"https://docs.acme.test/{d['slug']}")

    async def test_c148_c152_og_host_and_resolve(self):
        self.skipTest("#148-#152 OG host branding / re-check lease / resolve_host: og.py, domain.py (tenant workstream)")


class Membership(AccessWorld):
    async def test_c153_removed_member_404_immediately(self):
        d = await self.mkdoc("W")
        self.assertEqual((await self.get(d["slug"], self.session("wm"))).status_code, 200)
        await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/members/{self.uid['wm']}", headers=self.session("wa"))
        self.assertEqual((await self.get(d["slug"], self.session("wm"))).status_code, 404)

    async def test_c154_owner_who_left_can_unshare(self):
        d = await self.mkdoc("W", owner="ownx")
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/items/remove", json={"slugs": [d["slug"]]},
                                 headers=self.session("ownx"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["items"], [{"slug": d["slug"], "access_after": "private"}])
        r = await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/documents/{d['_id']}",
                                   headers=self.session("ownx"))
        self.assertEqual(r.status_code, 404)  # already out

    async def test_c155_owx_cannot_move(self):
        f = await folder_service.create_folder(self.db, self.ws["W1"], "Docs", None)
        d = await self.mkdoc("W", owner="ownx")
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/items/move",
                                 json={"slugs": [d["slug"]], "folder_id": f.id}, headers=self.session("ownx"))
        self.assertEqual(r.status_code, 404)

    async def test_c156_owx_reads_and_edits(self):
        d = await self.mkdoc("W", owner="ownx")
        h = self.session("ownx")
        self.assertEqual((await self.get(d["slug"], h)).status_code, 200)
        r = await self.http.put(f"/api/v1/documents/{d['slug']}", json={"title": "t", "content": "x"}, headers=h)
        self.assertEqual(r.status_code, 200)

    async def _role(self, who, target, role):
        return await self.http.put(f"/api/v1/workspaces/{self.ws['W1']}/members/{self.uid[target]}",
                                   json={"role": role}, headers=self.session(who))

    async def test_c157_only_owner_demotes_admin(self):
        await self.add_member("W1", "wm2", "admin")
        self.assertEqual((await self._role("wa", "wm2", "member")).status_code, 403)
        self.assertEqual((await self._role("wo", "wm2", "member")).status_code, 204)
        self.assertEqual((await self._role("wa", "wm", "admin")).status_code, 403)

    async def test_c158_admin_cannot_remove_admin(self):
        await self.add_member("W1", "wm2", "admin")
        r = await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/members/{self.uid['wm2']}",
                                   headers=self.session("wa"))
        self.assertEqual(r.status_code, 403)

    async def test_c159_admin_invites(self):
        from unittest import mock

        from app.services import mailer

        url = f"/api/v1/workspaces/{self.ws['W1']}/invitations"
        r = await self.http.post(url, json={"email": "n@example.com", "role": "admin"}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 403)
        with mock.patch.object(mailer, "is_configured", lambda: True), \
                mock.patch.object(mailer, "send_invite_email", mock.AsyncMock()):
            r = await self.http.post(url, json={"email": "n@example.com", "role": "member"}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 201, r.text)

    async def test_c160_transfer_ownership(self):
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/transfer", json={"user_id": self.uid["wm"]},
                                 headers=self.session("wo"))
        self.assertEqual(r.status_code, 200, r.text)
        ws = await self.db["workspaces"].find_one({"_id": ObjectId(self.ws["W1"])})
        self.assertEqual(ws["owner_id"], self.uid["wm"])
        roles = {m["user_id"]: m["role"] for m in await self.db["memberships"].find({"workspace_id": self.ws["W1"]}).to_list(50)}
        self.assertEqual((roles[self.uid["wm"]], roles[self.uid["wo"]]), ("owner", "admin"))
        self.assertEqual(list(roles.values()).count("owner"), 1)

    async def test_c161_transfer_to_non_member(self):
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/transfer", json={"user_id": self.uid["stranger"]},
                                 headers=self.session("wo"))
        self.assertEqual(r.status_code, 404)
        ws = await self.db["workspaces"].find_one({"_id": ObjectId(self.ws["W1"])})
        self.assertEqual(ws["owner_id"], self.uid["wo"])
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/transfer", json={"user_id": self.uid["wm"]},
                                 headers=self.session("wa"))
        self.assertEqual(r.status_code, 403)

    async def test_c162_invitee_reads_after_accept(self):
        from app.services import invitation

        d = await self.mkdoc("W")
        self.assertEqual((await self.get(d["slug"], self.session("invitee"))).status_code, 404)
        await self.db["invitations"].delete_many({})
        inv, token = await invitation.create_invitation(self.db, self.ws["W1"], self.email["invitee"], "member",
                                                        await self._user("wa"))
        r = await self.http.post(f"/api/v1/invites/{token}/accept", headers=self.session("invitee"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self.get(d["slug"], self.session("invitee"))).status_code, 200)

    async def _user(self, who):
        from app.services import user as user_service

        return await user_service.get_user_by_id(self.db, self.uid[who])

    async def test_c163_invite_other_address_403(self):
        from app.services import invitation

        _inv, token = await invitation.create_invitation(self.db, self.ws["W1"], "someone@example.com", "member",
                                                         await self._user("wa"))
        r = await self.http.post(f"/api/v1/invites/{token}/accept", headers=self.session("stranger"))
        self.assertEqual(r.status_code, 403)

    async def test_c164_viewer_invite_keeps_admin(self):
        import secrets
        from datetime import timedelta

        from app.services import invitation

        # Sent while they weren't a member; they became admin before accepting.
        token = secrets.token_urlsafe(24)
        await self.db["invitations"].insert_one({
            "workspace_id": self.ws["W1"], "email": self.email["wa"], "role": "viewer", "status": "pending",
            "token_hash": invitation._hash(token), "created_at": now(),
            "expires_at": now() + timedelta(days=7), "invited_by_name": "WO"})
        r = await self.http.post(f"/api/v1/invites/{token}/accept", headers=self.session("wa"))
        self.assertEqual(r.status_code, 200)
        m = await self.db["memberships"].find_one({"workspace_id": self.ws["W1"], "user_id": self.uid["wa"]})
        self.assertEqual(m["role"], "admin")

    async def test_c165_demoted_member_cannot_edit(self):
        d = await self.mkdoc("W")
        await self._role("wa", "wm", "viewer")
        r = await self.http.put(f"/api/v1/documents/{d['slug']}", json={"title": "t", "content": "x"},
                                headers=self.session("wm"))
        self.assertEqual(r.status_code, 403)

    async def test_c166_promoted_viewer_edits(self):
        d = await self.mkdoc("W")
        await self._role("wa", "wv", "member")
        r = await self.http.put(f"/api/v1/documents/{d['slug']}", json={"title": "t", "content": "x"},
                                headers=self.session("wv"))
        self.assertEqual(r.status_code, 200)

    async def test_c167_owner_cannot_leave(self):
        r = await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/members/{self.uid['wo']}",
                                   headers=self.session("wo"))
        self.assertEqual(r.status_code, 422)

    async def test_c168_removed_member_socket_ticket(self):
        from app.routers import live as live_router
        from app.services import tickets

        d = await self.mkdoc("W")
        raw = await self.doc(d["slug"])
        ticket = tickets.mint(str(raw["_id"]), 0)
        self.assertTrue(await live_router._admitted(d["slug"], ticket))
        expired = tickets.mint(str(raw["_id"]), 0, ttl=__import__("datetime").timedelta(seconds=-1))
        self.assertFalse(await live_router._admitted(d["slug"], expired))


class WorkspaceLifecycle(AccessWorld):
    async def _remove(self, who, slug, ws="W1"):
        return await self.http.post(f"/api/v1/workspaces/{self.ws[ws]}/items/remove", json={"slugs": [slug]},
                                    headers=self.session(who))

    async def test_c169_admin_unshares_workspace_doc(self):
        d = await self.mkdoc("W")
        r = await self._remove("wa", d["slug"])
        self.assertEqual(r.json()["items"][0]["access_after"], "private")
        raw = await self.doc(d["slug"])
        self.assertEqual((raw["access_level"], raw["workspace_id"]), ("private", None))

    async def test_c170_rl_unshare_private(self):
        d = await self.mkdoc("RL", kind="artifact")
        await self._remove("owner", d["slug"], "WR")
        self.assertEqual((await self.doc(d["slug"]))["access_level"], "private")
        self.assertFalse(self.r2.objects[d["blob_key"]]["public"])

    async def test_c171_l_unshare_stays_link(self):
        d = await self.mkdoc("L")
        await self._remove("owner", d["slug"])
        self.assertEqual((await self.doc(d["slug"]))["access_level"], "link")

    async def _delete_ws(self, key):
        name = (await self.db["workspaces"].find_one({"_id": ObjectId(self.ws[key])}))["name"]
        return await self.http.request("DELETE", f"/api/v1/workspaces/{self.ws[key]}",
                                       json={"confirm_name": name}, headers=self.session("wo"))

    async def test_c172_workspace_delete_conversions(self):
        w, l = await self.mkdoc("W"), await self.mkdoc("L")
        rl = await self.mkdoc("RL")
        self.assertEqual((await self._delete_ws("W1")).status_code, 200)
        self.assertEqual((await self._delete_ws("WR")).status_code, 200)
        self.assertEqual((await self.doc(w["slug"]))["access_level"], "private")
        self.assertEqual((await self.doc(l["slug"]))["access_level"], "link")
        self.assertEqual((await self.doc(rl["slug"]))["access_level"], "private")
        for d in (w, l, rl):
            self.assertIsNone((await self.doc(d["slug"]))["workspace_id"])

    async def test_c173_workspace_delete_cleans_up(self):
        f = await folder_service.create_folder(self.db, self.ws["W1"], "Docs", None)
        share = await folder_service.set_share(self.db, self.ws["W1"], f.id, "link", self.uid["wa"])
        d = await self.mkdoc("W", grants=False, allow_resharing=True)
        await self.db["document_grants"].insert_one({"document_id": str(d["_id"]), "email": "x@example.com",
                                                     "role": "viewer", "granted_via": self.ws["W1"],
                                                     "created_at": now()})
        await self._delete_ws("W1")
        self.assertEqual((await self.http.get(f"/api/v1/folders/shared/{share['id']}")).status_code, 404)
        r = await self.http.get("/api/v1/host/folder", params={"host": HOSTS["W1"]})
        self.assertEqual(r.status_code, 404)
        self.assertIsNone(await self.db["document_grants"].find_one({"granted_via": self.ws["W1"]}))
        self.assertIn(f"tag:host:{HOSTS['W1']}", await self.jobs())

    async def test_c174_workspace_deleted_during_upload_commit(self):
        import hashlib

        data = b"<h1>race</h1>"
        r = await self.http.post("/api/v1/files/uploads", headers=self.session("wm"), json={
            "file_name": "r.html", "size_bytes": len(data), "content_type": "text/html",
            "sha256": hashlib.sha256(data).hexdigest(), "workspace": self.ws["W1"], "access": "link"})
        self.assertEqual(r.status_code, 200, r.text)
        await self._delete_ws("W1")
        sess = await self.db["file_uploads"].find_one({"_id": r.json()["upload_id"]})
        etag = self.r2.put_part(sess["r2_upload_id"], 1, data)
        r = await self.http.post(f"/api/v1/files/uploads/{sess['_id']}/complete",
                                 json={"parts": [{"part_number": 1, "etag": etag}]}, headers=self.session("wm"))
        res = r.json()
        raw = await self.doc(res["slug"])
        self.assertIsNone(raw.get("workspace_id"))
        self.assertEqual(raw["access_level"], "private")
        self.assertTrue(res["workspace_error"])

    async def test_c175_dangling_reads_unfiled_and_reconciled(self):
        d = await self.mkdoc("W", workspace_id=str(ObjectId()))
        await self.db["documents"].update_one({"_id": d["_id"]}, {"$set": {"access_dirty": True}})
        self.assertEqual((await self.get(d["slug"], self.session("wm"))).status_code, 404)
        self.assertEqual((await self.get(d["slug"], self.session("owner"))).status_code, 200)
        await lifecycle.reconcile_once(self.db, full=True)
        raw = await self.doc(d["slug"])
        self.assertIsNone(raw["workspace_id"])
        self.assertEqual(raw["access_level"], "private")

    async def test_c176_already_in_other_workspace_409(self):
        d = await self.mkdoc("L")
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['WR']}/items/add", json={"slugs": [d["slug"]]},
                                 headers=self.session("owner"))
        self.assertEqual(r.status_code, 409)

    async def test_c177_admin_cannot_file_someone_elses(self):
        d = await self.mkdoc("L", ws=None)
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/items/add", json={"slugs": [d["slug"]]},
                                 headers=self.session("wa"))
        self.assertEqual(r.status_code, 404)

    async def test_c178_viewer_owner_cannot_file(self):
        d = await self.mkdoc("L", ws=None, owner="ownv")
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/items/add", json={"slugs": [d["slug"]]},
                                 headers=self.session("ownv"))
        self.assertEqual(r.status_code, 403)

    async def test_c179_filing_into_require_auth_guards(self):
        d = await self.mkdoc("L", ws=None, kind="artifact")
        self.assertTrue(self.r2.objects[d["blob_key"]]["public"])
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['WR']}/items/add", json={"slugs": [d["slug"]]},
                                 headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(self.r2.objects[d["blob_key"]]["public"])
        self.assertEqual((await self.doc(d["slug"]))["access_epoch"], 1)

    async def test_c180_set_level_racing_unshare(self):
        d = await self.mkdoc("L")
        stale = await self.doc(d["slug"])
        await lifecycle.release_from_workspace(self.db, stale, self.ws["W1"])
        with self.assertRaises(Exception) as cm:
            await transitions.change(self.db, stale, sets={"access_level": "workspace"},
                                     cas={"workspace_id": self.ws["W1"]}, narrows=True)
        self.assertEqual(getattr(cm.exception, "status_code", None), 409)
        raw = await self.doc(d["slug"])
        self.assertFalse(raw["access_level"] == "workspace" and raw["workspace_id"] is None)
