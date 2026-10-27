"""Access policy §6.1 and §6.2: the generated read matrix (AM-001…AM-144) and
action matrix (AX-001…AX-272, plus delta variants AX-273+), one test per cell.

Each cell builds its own document in the fixture world (tests/_access_env.py)
and asserts the exact status (and gate). "✓" cells assert the effect
happened; denial cells assert the document, its grants, its R2 objects and the
revalidation outbox did not change.
"""

from __future__ import annotations

import hashlib
import secrets

from tests._access_env import ES_SECRET, HOSTS, PASSWORD, AccessWorld

STATES = ["L", "LP", "P", "W", "RL", "RLP", "RW", "RP"]
OK, PW, SI, NF = "ok", "PW", "SI", "NF"

_MEMBER = [OK, OK, NF, OK, OK, OK, OK, NF]
_STRANGER = [OK, PW, NF, NF, NF, NF, NF, NF]
READ_ROWS: list[tuple[str, list[str]]] = [
    ("AN", [OK, PW, SI, SI, SI, SI, SI, SI]),
    ("ST", _STRANGER), ("FM", _STRANGER), ("IN", _STRANGER),
    ("OW", [OK] * 8), ("OWx", [OK] * 8),
    ("GV", [OK] * 8), ("GE", [OK] * 8),
    ("WV", _MEMBER), ("WM", _MEMBER), ("WA", _MEMBER), ("WO", _MEMBER),
    ("TS", _MEMBER), ("TX", [NF] * 8),
    ("ES", [OK] * 8), ("AT", _MEMBER),
]
# Unfiled, for a workspace member (AM-129…136): the stranger row; R· = plain.
UNFILED_WM = [OK, PW, NF, NF, OK, PW, NF, NF]
# MR (a stranger's read-only MCP token) through get_document (AM-137…144).
MR_ROW = [OK, PW, NF, NF, NF, NF, NF, NF]


class ReadMatrix(AccessWorld):
    async def _read_cell(self, actor: str, state: str, expected: str, *, unfiled: bool = False):
        owner = self.owner_for(actor)
        doc = await self.mkdoc(("U" + state) if unfiled else state, owner=owner)
        headers = await self.headers(actor, doc)
        r = await self.get(doc["slug"], headers)
        self._assert_read(r, expected, doc)
        if expected == PW and actor in ("AN", "ST", "FM", "IN"):
            r = await self.get(doc["slug"], {**headers, "X-Read-Password": PASSWORD})
            self.assertEqual(r.status_code, 200, r.text)
            r = await self.get(doc["slug"], {**headers, "X-Read-Password": "wrong"})
            self.assertEqual(r.status_code, 403, r.text)

    def _assert_read(self, r, expected: str, doc: dict):
        if expected == OK:
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["slug"], doc["slug"])
            return
        status, gate = {PW: (401, "password"), SI: (401, "signin"), NF: (404, None)}[expected]
        self.assertEqual(r.status_code, status, r.text)
        self.assertEqual(r.headers.get("X-Markdrop-Gate"), gate)
        self.assertNotIn(doc["title"], r.text)
        self.assertNotIn(doc["content"], r.text)

    async def _mr_cell(self, state: str, expected: str):
        doc = await self.mkdoc(state)
        token = await self.mcp_token("stranger", write=False)
        status, res = await self.mcp_call(token, "get_document", {"document": doc["slug"]})
        self.assertEqual(status, 200)
        if expected == OK:
            self.assertFalse(res["isError"], res)
            self.assertEqual(res["structuredContent"]["slug"], doc["slug"])
        else:
            self.assertTrue(res["isError"])
            text = res["content"][0]["text"]
            self.assertIn("password-protected" if expected == PW else "couldn't find", text)
            self.assertNotIn(doc["content"], text)


def _make_read(actor, state, expected, unfiled=False):
    async def t(self):
        await self._read_cell(actor, state, expected, unfiled=unfiled)
    return t


def _make_mr(state, expected):
    async def t(self):
        await self._mr_cell(state, expected)
    return t


_n = 0
for _actor, _row in READ_ROWS:
    for _state, _exp in zip(STATES, _row):
        _n += 1
        setattr(ReadMatrix, f"test_AM_{_n:03d}_{_actor}_{_state}", _make_read(_actor, _state, _exp))
for _state, _exp in zip(STATES, UNFILED_WM):
    _n += 1
    setattr(ReadMatrix, f"test_AM_{_n:03d}_WM_unfiled_{_state}", _make_read("WM", _state, _exp, True))
for _state, _exp in zip(STATES, MR_ROW):
    _n += 1
    setattr(ReadMatrix, f"test_AM_{_n:03d}_MR_{_state}", _make_mr(_state, _exp))


# ── Action matrix ─────────────────────────────────────────────────────────────

COLS = ["read", "list", "edit", "replace", "bundle", "settings", "resharing", "access", "rename",
        "delete", "share", "grants", "move", "unshare", "stats", "copy"]
F, A, ABS, OWN, RED, SC, ERR, SKIP = 403, 401, "absent", "own", "redacted", "scope", "err", "-"


def _wm_like(unshare):
    return [OK, OK, OK, OK, F, F, F, F, F, F, F, OK, OK, unshare, F, OK]


AX_ROWS: list[tuple[str, list]] = [
    ("AN", [SI, A, SI, A, A, SI, A, A, SI, SI, A, A, A, A, A, A]),
    ("ST", [404] * 16),
    ("OW", [OK] * 16),
    ("OWv", [OK] * 12 + [F, OK, OK, OK]),
    ("OWx", [OK, 404] + [OK] * 10 + [404, OK, OK, OK]),
    ("GV", [OK, 404, F, F, F, F, F, F, F, F, F, OWN, 404, F, F, OK]),
    ("GE", [OK, 404, OK, OK, F, F, F, F, F, F, F, OK, 404, F, F, OK]),
    ("WV", [OK, OK, F, F, F, F, F, F, F, F, F, OWN, F, F, F, OK]),
    ("WM", _wm_like(F)),
    ("WA", _wm_like(OK)),
    ("WO", _wm_like(OK)),
    ("TS", [OK, OK] + [A] * 14),
    ("TX", [404, ABS] + [A] * 14),
    # The table's ES change_access "4" is unreachable over REST: the route
    # needs an account, so it is a 401 (catalogue #53/#64 say the same).
    ("ES", [OK, SKIP, OK, A, A, OK, A, A, OK, OK, A, A, A, A, A, A]),
    ("MR", [OK, OK, SC, SC, SKIP, SC, SKIP, SC, SKIP, SC, SKIP, SKIP, SC, SC, ERR, SKIP]),
    ("MW", [OK, OK, OK, OK, SKIP, ERR, SKIP, ERR, SKIP, ERR, SKIP, SKIP, OK, ERR, ERR, SKIP]),
    ("AT", _wm_like(F)),
]

# Delta sets (§2.5 "Deltas from the W column"), for the actors whose cells change.
_P_MEMBER = [404, ABS] + [404] * 14
_P_ADMIN = [404, RED] + [404] * 11 + [OK, 404, 404]
_L_AN = [OK, A] + [A] * 14
_L_ST = [OK, 404, F, F, F, F, F, F, F, F, F, 404, 404, F, F, OK]
_R_AN = [SI, A, SI, A, A, SI, A, A, SI, SI, A, A, A, A, A, A]
_U_GV = [OK, 404, F, F, F, F, F, F, F, F, OK, OWN, 404, 404, F, OK]
_U_MEMBER = [OK, ABS, F, F, F, F, F, F, F, F, F, 404, 404, 404, F, OK]
DELTA_ROWS: list[tuple[str, str, list]] = [
    ("P", "WV", _P_MEMBER), ("P", "WM", _P_MEMBER), ("P", "WA", _P_ADMIN), ("P", "WO", _P_ADMIN),
    ("P", "GV", [OK, 404, F, F, F, F, F, F, F, F, F, OWN, 404, F, F, OK]),
    ("L", "AN", _L_AN), ("L", "ST", _L_ST),
    ("RW", "AN", _R_AN), ("RW", "ST", [404] * 16),
    # Unfiled: a member is a stranger to it; it isn't in their workspace's list.
    ("UL", "WM", _U_MEMBER), ("UL", "WV", _U_MEMBER), ("UL", "GV", _U_GV),
]


class ActionMatrix(AccessWorld):
    async def _doc_for(self, col: str, state: str, actor: str) -> dict:
        owner = self.owner_for(actor)
        if col == "replace":
            return await self.mkdoc(state, owner=owner, kind="artifact")
        if col == "bundle":
            return await self.mkdoc(state, owner=owner, kind="artifact", bundle=True)
        return await self.mkdoc(state, owner=owner)

    async def _snapshot(self, doc: dict):
        row = await self.db["documents"].find_one({"_id": doc["_id"]})
        if row:
            row.pop("views", None)
        grants = await self.db["document_grants"].count_documents({"document_id": str(doc["_id"])})
        keys = {k: dict(v) for k, v in self.r2.objects.items()
                if k == doc.get("blob_key") or (doc.get("bundle_prefix") and k.startswith(doc["bundle_prefix"]))}
        jobs = {j for j in await self.jobs() if doc["slug"] in j}
        return row, grants, keys, jobs

    # ── REST ──

    async def _rest(self, actor: str, col: str, doc: dict) -> object:
        h = await self.headers(actor, doc)
        slug = doc["slug"]
        ws_id = doc.get("workspace_id") or self.ws["W1"]
        uid = self.uid.get({"OW": "owner", "OWv": "ownv", "OWx": "ownx", "ST": "stranger", "GV": "gv",
                            "GE": "ge", "WV": "wv", "WM": "wm", "WA": "wa", "WO": "wo",
                            "AT": "wm", "TS": "wm", "TX": "wm2"}.get(actor, ""), "anon")
        if col == "read":
            r = await self.get(slug, h)
            return OK if r.status_code == 200 else self._denial(r)
        if col == "list":
            if actor in ("TS", "TX"):
                host = HOSTS["WR" if ws_id == self.ws["WR"] else "W1"]
                r = await self.http.get("/api/v1/host/folder", params={"host": host, "path": ""}, headers=h)
                if r.status_code != 200:
                    return ABS
                return OK if slug in [d["slug"] for d in r.json()["documents"]] else ABS
            r = await self.http.get(f"/api/v1/workspaces/{ws_id}/items", headers=h)
            if r.status_code != 200:
                return r.status_code
            items = r.json()["items"]
            if any(i["slug"] == slug for i in items):
                return OK
            if any(i.get("redacted") for i in items):
                return RED
            return ABS
        if col == "edit":
            r = await self.http.put(f"/api/v1/documents/{slug}", json={"title": "T2", "content": "new body"}, headers=h)
            if r.status_code == 200:
                self.assertEqual((await self.doc(slug))["content"], "new body")
                return OK
            return self._denial(r)
        if col in ("replace", "bundle"):
            key = f"art/{uid}/{secrets.token_hex(5)}.html"
            self.r2.put_bytes(key, b"<h1>new</h1>", "text/html", False)
            r = await self.http.put(f"/api/v1/artifacts/{slug}/file",
                                    json={"blob_key": key, "filename": "new.html"}, headers=h)
            if r.status_code == 200:
                after = await self.doc(slug)
                self.assertEqual(after["blob_key"], key)
                self.assertIsNone(after.get("bundle_prefix"))
                return OK
            return self._denial(r)
        if col == "settings":
            r = await self.http.put(f"/api/v1/documents/{slug}",
                                    json={"title": doc["title"], "content": doc["content"], "expires_in": "7d"},
                                    headers=h)
            if r.status_code == 200:
                self.assertIsNotNone((await self.doc(slug))["expires_at"])
                return OK
            return self._denial(r)
        if col == "resharing":
            r = await self.http.put(f"/api/v1/documents/{slug}/access/resharing", json={"allow": True}, headers=h)
            if r.status_code == 204:
                self.assertTrue((await self.doc(slug))["allow_resharing"])
                return OK
            return self._denial(r)
        if col == "access":
            r = await self.http.put(f"/api/v1/documents/{slug}/access/level", json={"level": "private"}, headers=h)
            if r.status_code == 204:
                self.assertEqual((await self.doc(slug))["access_level"], "private")
                return OK
            return self._denial(r)
        if col == "rename":
            new = f"renamed-{secrets.token_hex(4)}"
            r = await self.http.patch(f"/api/v1/documents/{slug}/slug", json={"new_slug": new}, headers=h)
            if r.status_code == 200:
                self.assertIsNotNone(await self.doc(new))
                return OK
            return self._denial(r)
        if col == "delete":
            r = await self.http.delete(f"/api/v1/documents/{slug}", headers=h)
            if r.status_code == 204:
                self.assertIsNone(await self.doc(slug))
                return OK
            return self._denial(r)
        if col == "share":
            r = await self.http.post(f"/api/v1/documents/{slug}/access/people",
                                     json={"email": "newperson@example.com", "role": "viewer", "notify": False},
                                     headers=h)
            if r.status_code == 201:
                self.assertTrue(await self.db["document_grants"].find_one(
                    {"document_id": str(doc["_id"]), "email": "newperson@example.com"}))
                return OK
            return self._denial(r)
        if col == "grants":
            r = await self.http.get(f"/api/v1/documents/{slug}/access", headers=h)
            if r.status_code == 200:
                body = r.json()
                if body["grants"]:
                    return OK
                self.assertIsNone(body["owner_email"])
                return OWN
            return self._denial(r)
        if col == "move":
            folder = await self.db["folders"].insert_one({
                "workspace_id": ws_id, "name": "Moved", "slug": f"moved-{secrets.token_hex(3)}",
                "parent_id": None, "created_at": doc["created_at"], "updated_at": doc["created_at"]})
            fid = str(folder.inserted_id)
            r = await self.http.post(f"/api/v1/workspaces/{ws_id}/items/move",
                                     json={"slugs": [slug], "folder_id": fid}, headers=h)
            if r.status_code == 200:
                self.assertEqual((await self.doc(slug))["folder_id"], fid)
                return OK
            return self._denial(r)
        if col == "unshare":
            r = await self.http.post(f"/api/v1/workspaces/{ws_id}/items/remove", json={"slugs": [slug]}, headers=h)
            if r.status_code == 200:
                self.assertIsNone((await self.doc(slug))["workspace_id"])
                return OK
            return self._denial(r)
        if col == "stats":
            r = await self.http.get(f"/api/v1/me/documents/{slug}/analytics", headers=h)
            return OK if r.status_code == 200 else self._denial(r)
        if col == "copy":
            r = await self.http.post(f"/api/v1/documents/{slug}/copy", json={}, headers=h)
            return OK if r.status_code == 201 else self._denial(r)
        raise AssertionError(col)

    @staticmethod
    def _denial(r):
        if r.status_code == 401 and r.headers.get("X-Markdrop-Gate") == "signin":
            return SI
        return r.status_code

    # ── MCP ──

    async def _mcp(self, actor: str, col: str, doc: dict) -> object:
        token = await self.mcp_token("wm", write=(actor == "MW"))
        slug = doc["slug"]
        ws_id = doc.get("workspace_id")
        if col == "move":
            await self.db["folders"].insert_one({
                "workspace_id": ws_id, "name": "Moved", "slug": "moved", "parent_id": None,
                "created_at": doc["created_at"], "updated_at": doc["created_at"]})
        calls = {
            "read": ("get_document", {"document": slug}),
            "list": ("list_workspace_items", {"workspace": ws_id}),
            "edit": ("update_document", {"document": slug, "content": "new body"}),
            "replace": ("create_upload", {"file_name": "x.html", "size_bytes": 5,
                                          "sha256": hashlib.sha256(b"hello").hexdigest(),
                                          "target_slug": slug}),
            "settings": ("set_access", {"document": slug, "access": "link", "expires": "7d"}),
            "access": ("set_access", {"document": slug, "access": "private"}),
            "delete": ("delete_document", {"document": slug}),
            "move": ("move_to_folder", {"document": slug, "folder": "moved"}),
            "unshare": ("remove_from_workspace", {"document": slug}),
            "stats": ("get_document_stats", {"document": slug}),
        }
        name, args = calls[col]
        status, res = await self.mcp_call(token, name, args)
        if status == 403:
            return SC
        self.assertEqual(status, 200)
        if res["isError"]:
            return ERR
        if col == "list":
            return OK if slug in [i["slug"] for i in res["structuredContent"]["items"]] else ABS
        return OK

    async def _cell(self, actor: str, col: str, expected, state: str = "W"):
        if expected == SKIP:
            self.skipTest("not applicable to this actor (— in the policy table)")
        doc = await self._doc_for(col, state, actor)
        before = await self._snapshot(doc)
        if actor in ("MR", "MW"):
            got = await self._mcp(actor, col, doc)
        else:
            got = await self._rest(actor, col, doc)
        self.assertEqual(got, expected, f"{actor} {col} on {state}")
        if expected not in (OK, OWN, RED) and col not in ("read", "list", "grants", "stats", "copy"):
            after = await self._snapshot(doc)
            self.assertEqual(after[0], before[0], "denied: the document must not change")
            self.assertEqual(after[1:3], before[1:3], "denied: grants / R2 must not change")
            self.assertEqual(after[3], before[3], "denied: no purge job")


def _make_ax(actor, col, expected, state="W"):
    async def t(self):
        await self._cell(actor, col, expected, state)
    return t


_n = 0
for _actor, _row in AX_ROWS:
    for _col, _exp in zip(COLS, _row):
        _n += 1
        setattr(ActionMatrix, f"test_AX_{_n:03d}_{_actor}_{_col}", _make_ax(_actor, _col, _exp))
assert _n == 272, _n
for _state, _actor, _row in DELTA_ROWS:
    for _col, _exp in zip(COLS, _row):
        _n += 1
        setattr(ActionMatrix, f"test_AX_{_n:03d}_{_state}_{_actor}_{_col}",
                _make_ax(_actor, _col, _exp, _state))
