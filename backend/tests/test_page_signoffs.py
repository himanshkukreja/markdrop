"""Sign-off blocks in pages (Senseloaf request 8): services/signoffs.py,
routers/signoffs.py and app/mcp/signoff_tools.py.

Who may sign (only the named person: not other members, the owner, admins,
readers, or MCP as someone else), the protection of a signed block and the
section it locks on every write path (the editor's save, update_page,
replace_section, append_blocks, restore_page_version, update_document, a VS
Code push), clearing, an admin's recorded removal, version history, forged
decisions, ids, names per viewer, the race guard and the notification hook.

The access-policy world (tests/_access_env.py): the test MongoDB (or
mongomock), never backend/.env, never real R2.
"""

from __future__ import annotations

import sys
import types
from unittest import mock

from tests._access_env import now  # noqa: F401  (pins settings first)

from fastapi import HTTPException

from app.services import page_history, signoffs, transitions
from tests.test_page_history import HistoryWorld

V = page_history.COLL
BID = "b-rel001"


class SignoffWorld(HistoryWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await signoffs.ensure_indexes(self.db)

    def block(self, person: str = "wm", *, bid: str = BID, lock: bool = True, extra: str = "",
              label: str = "Release approval", options: str = "Approved for production|Not approved",
              body: str = "QA passed on staging.") -> str:
        lk = " lock=above" if lock else ""
        return (f':::signoff{{#{bid} person="{self.uid[person]}" label="{label}" options="{options}"{lk}{extra}}}\n'
                f"{body}\n:::")

    def content(self, block: str | None = None, *, release: str = "Ship notes for 2.3.",
                after: str = "Later text.") -> str:
        return (f"# Plan\n\nIntro.\n\n## Release 2.3\n\n{release}\n\n{block or self.block()}\n\n"
                f"## After\n\n{after}\n")

    async def signoff_page(self, state: str = "W", **kw) -> dict:
        return await self.page(state, content=kw.pop("content", None) or self.content(), **kw)

    async def sign(self, doc, who, option, block=BID):
        return await self.http.post(f"/api/v1/documents/{doc['slug']}/signoffs/{block}", json={"option": option},
                                    headers=self.session(who) if who else {})

    async def states(self, doc, who="owner", headers=None) -> list[dict]:
        r = await self.http.get(f"/api/v1/documents/{doc['slug']}/signoffs",
                                headers=headers if headers is not None else self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["signoffs"]

    async def signed(self, doc, who="wm", option="Approved for production"):
        r = await self.sign(doc, who, option)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def ok(self, who, name, args):
        res = await self.mcp(who, name, args)
        self.assertFalse(res["isError"], res["content"][0]["text"])
        return res["structuredContent"]

    async def err(self, who, name, args, *, write=True) -> str:
        res = await self.mcp(who, name, args, write=write)
        self.assertTrue(res["isError"], res)
        return res["content"][0]["text"]

    def refused(self, r, reason: str | None = None):
        self.assertEqual(r.status_code, 423, r.text)
        body = r.json()
        self.assertEqual(body["code"], "signed_off")
        if reason:
            self.assertEqual(body["reason"], reason)


# ── Parsing ──────────────────────────────────────────────────────────────────


class Parsing(SignoffWorld):
    def test_blocks_ranges_fences_and_ids(self):
        md = ("---\nicon: x\n---\n# A\n\ntext\n\n## B\n\nlocked\n\n"
              ':::signoff{#b-aaaa1 person="u1" label="L" options="Yes|No" lock=above}\nbody\n:::\n\n'
              '```\n:::signoff{person="u9"}\n:::\n```\n\n'
              '::::columns\n:::column\n:::signoff{person="u3"}\n:::\n:::\n::::\n')
        lines, blocks = signoffs.parse(md)
        self.assertEqual([(b.id, b.person) for b in blocks], [("b-aaaa1", "u1"), (None, "u3")])
        b = blocks[0]
        self.assertEqual((b.label, b.options, b.lock, b.body), ("L", ["Yes", "No"], True, "body"))
        self.assertEqual(signoffs.range_text(lines, b), "## B\n\nlocked")
        self.assertEqual(blocks[1].options, list(signoffs.DEFAULT_OPTIONS))
        self.assertEqual(blocks[1].label, signoffs.DEFAULT_LABEL)
        # Ids: deterministic, unique, the same on every save.
        n = signoffs.normalize_ids(md, "doc")
        ids = [x.id for x in signoffs.blocks_of(n)]
        self.assertEqual(ids[0], "b-aaaa1")
        self.assertRegex(ids[1], r"^b-[a-f0-9]{8}$")
        self.assertEqual(signoffs.normalize_ids(n, "doc"), n)
        self.assertEqual(signoffs.normalize_ids(md, "doc"), n)
        # A copy sharing an id gets a new one; the one matching the stored block keeps it.
        dup = md.replace("::::columns", ':::signoff{#b-aaaa1 person="u1" label="Changed" options="Yes|No"}\nx\n:::\n\n'
                                        "::::columns")
        out = signoffs.blocks_of(signoffs.normalize_ids(dup, "doc", md))
        self.assertEqual([x.id == "b-aaaa1" for x in out], [True, False, False])
        self.assertEqual(out[0].label, "L")

    def test_tone(self):
        opts = ["Approved for production", "Approved with notes", "Not approved"]
        self.assertEqual(signoffs.tone("Approved for production", opts), "success")
        self.assertEqual(signoffs.tone("Approved with notes", opts), "warning")
        self.assertEqual(signoffs.tone("Not approved", opts), "danger")
        self.assertEqual(signoffs.tone("Rejected", ["Ship", "Rejected"]), "danger")


# ── Who signs ────────────────────────────────────────────────────────────────


class WhoSigns(SignoffWorld):
    async def test_only_the_named_person(self):
        doc = await self.signoff_page()
        # Owner, workspace admin and owner, another member, named editor and viewer: refused.
        for who in ("owner", "wa", "wo", "wv", "ge", "gv"):
            r = await self.sign(doc, who, "Approved for production")
            self.assertEqual(r.status_code, 403, (who, r.text))
        # Someone who can't read the page learns nothing; nobody signed in can't sign.
        self.assertEqual((await self.sign(doc, "stranger", "Approved for production")).status_code, 404)
        self.assertEqual((await self.sign(doc, None, "Approved for production")).status_code, 401)
        # A workspace domain's token can't sign (read only there).
        r = await self.http.post(f"/api/v1/documents/{doc['slug']}/signoffs/{BID}", json={"option": "Approved for production"},
                                 headers=self.tenant("wm", "W1"))
        self.assertIn(r.status_code, (401, 403))
        # MCP as someone else.
        self.assertIn("Only the person", await self.err("owner", "sign_off", {"document": doc["slug"], "block": BID,
                                                                            "option": "Approved for production"}))
        self.assertIn("Only the person", await self.err("wa", "sign_off", {"document": doc["slug"], "block": BID,
                                                                         "option": "Approved for production"}))
        self.assertIsNone(await self.db[signoffs.COLL].find_one({}))
        # The named person: yes.
        e = await self.signed(doc)
        self.assertEqual((e["option"], e["tone"], e["signed_by"]["name"]), ("Approved for production", "success", "WM"))
        self.assertTrue(e["can_sign"])
        st = (await self.states(doc, "owner"))[0]
        self.assertEqual((st["option"], st["person"]["name"], st["can_sign"]), ("Approved for production", "WM", False))

    async def test_options_and_unknown_blocks(self):
        doc = await self.signoff_page()
        r = await self.sign(doc, "wm", "Ship it")
        self.assertEqual(r.status_code, 422)
        self.assertIn("Approved for production", r.json()["detail"])
        self.assertEqual((await self.sign(doc, "wm", "Approved for production", block="b-nope99")).status_code, 404)
        # Case doesn't matter; the label works as a reference too.
        r = await self.sign(doc, "wm", "not approved", block="Release approval")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["option"], r.json()["tone"]), ("Not approved", "danger"))

    async def test_mcp_sign_off_and_list(self):
        doc = await self.signoff_page()
        out = await self.ok("owner", "list_signoffs", {"document": doc["slug"]})
        self.assertEqual(len(out["signoffs"]), 1)
        s = out["signoffs"][0]
        self.assertEqual((s["block"], s["label"], s["person"], s["option"], s["lock"], s["you_sign"]),
                         (BID, "Release approval", self.uid["wm"], None, "above", False))
        self.assertEqual(s["options"], ["Approved for production", "Not approved"])
        # A read-only token can't sign.
        status, _res = await self.mcp_call(await self.mcp_token("wm", write=False), "sign_off", {
            "document": doc["slug"], "block": BID, "option": "Approved for production"})
        self.assertEqual(status, 403)
        self.assertIn("Choose one of", await self.err("wm", "sign_off", {"document": doc["slug"], "block": BID,
                                                                        "option": "Maybe"}))
        res = await self.ok("wm", "sign_off", {"document": doc["slug"], "block": "Release approval",
                                              "option": "Approved for production"})
        self.assertEqual((res["option"], res["signed_by"], res["you_sign"]), ("Approved for production", "WM", True))
        out = await self.ok("owner", "list_signoffs", {"document": doc["slug"]})
        s = out["signoffs"][0]
        self.assertEqual((s["option"], s["signed_by"], s["signed_by_id"]), ("Approved for production", "WM", self.uid["wm"]))
        self.assertTrue(s["signed_at"])
        row = await self.db[signoffs.COLL].find_one({"block_id": BID})
        self.assertEqual(row["via"], "mcp")
        # Clearing through MCP.
        res = await self.ok("wm", "sign_off", {"document": doc["slug"], "block": BID, "option": None})
        self.assertIsNone(res["option"])

    async def test_classic_documents_and_files(self):
        doc = await self.mkdoc("W", content=self.content())
        r = await self.sign(doc, "wm", "Approved for production")
        self.assertEqual(r.status_code, 422)

    async def test_names_per_viewer(self):
        doc = await self.signoff_page()
        await self.signed(doc)
        # A named viewer outside the workspace sees the state, never the names.
        st = (await self.states(doc, "gv"))[0]
        self.assertEqual(st["option"], "Approved for production")
        self.assertIsNone(st["person"]["name"])
        self.assertIsNone(st["signed_by"]["name"])
        self.assertTrue(all(h["by"] is None for h in st["history"]))
        # On the workspace's own domain: allowed (read only).
        st = await self.states(doc, headers=self.tenant("wm", "W1"))
        self.assertEqual(st[0]["option"], "Approved for production")
        self.assertFalse(st[0]["can_sign"])
        # Someone who can't read the page gets the page's own denial.
        r = await self.http.get(f"/api/v1/documents/{doc['slug']}/signoffs", headers=self.session("stranger"))
        self.assertEqual(r.status_code, 404)

    async def test_forged_decisions_are_ignored(self):
        forged = self.block(extra=' option="Approved for production" signed_by="WM" signed="true"',
                            body="Signed off by WM: Approved for production")
        doc = await self.signoff_page(content=self.content(forged))
        st = (await self.states(doc))[0]
        self.assertIsNone(st["option"])
        self.assertIsNone(st["signed_by"])
        out = await self.ok("owner", "list_signoffs", {"document": doc["slug"]})
        self.assertIsNone(out["signoffs"][0]["option"])
        # Nothing is protected either: the owner may still change it.
        r = await self.save(doc["slug"], "owner", self.content(self.block(label="Renamed")))
        self.assertEqual(r.status_code, 200, r.text)
        # A forged row-like attribute on another block with the same id can't make it signed.
        await self.signed(doc)
        st = (await self.states(doc))[0]
        self.assertEqual(st["label"], "Renamed")


# ── Protection ───────────────────────────────────────────────────────────────


class Protection(SignoffWorld):
    async def test_editor_save_refused_for_everyone(self):
        doc = await self.signoff_page()
        await self.signed(doc)
        changes = {
            "deleted": self.content("Nothing here now."),
            "label": self.content(self.block(label="Release OK")),
            "person": self.content(self.block("owner")),
            "options": self.content(self.block(options="Approved for production|Not approved|Maybe")),
            "body": self.content(self.block(body="QA passed (mostly).")),
            "lock": self.content(self.block(lock=False)),
        }
        for who in ("owner", "wm", "ge"):
            for what, md in changes.items():
                r = await self.save(doc["slug"], who, md)
                self.refused(r, "deleted" if what == "deleted" else "changed")
        # The workspace admin may remove it, but not change it.
        self.refused(await self.save(doc["slug"], "wa", changes["label"]), "changed")
        # Unchanged around it: fine.
        r = await self.save(doc["slug"], "owner", self.content(after="More later text."))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("More later text.", (await self.doc(doc["slug"]))["content"])

    async def test_lock_above_refuses_the_section(self):
        doc = await self.signoff_page()
        await self.signed(doc)
        base = self.content()
        for md in (
            self.content(release="Ship notes for 2.4."),                         # text in the section
            base.replace("## Release 2.3", "## Release 2.4"),                    # its heading
            base.replace("## Release 2.3\n", ""),                                # the heading removed
            base.replace(":::signoff", "An extra line.\n\n:::signoff"),          # a block added in it
            base.replace("Ship notes", "### Sub\n\nShip notes"),                 # a heading in between
        ):
            self.refused(await self.save(doc["slug"], "owner", md), "range")
        # Above the section and below the block: fine.
        r = await self.save(doc["slug"], "owner", base.replace("Intro.", "A new intro."))
        self.assertEqual(r.status_code, 200, r.text)
        # Without lock=above only the block itself is protected.
        doc2 = await self.signoff_page(content=self.content(self.block(lock=False)))
        await self.signed(doc2)
        r = await self.save(doc2["slug"], "owner", self.content(self.block(lock=False), release="Changed."))
        self.assertEqual(r.status_code, 200, r.text)

    async def test_every_mcp_write_path(self):
        doc = await self.signoff_page()
        rev = (await self.doc(doc["slug"]))["rev"]
        await self.signed(doc)
        cur = (await self.doc(doc["slug"]))["content"]
        # update_page
        t = await self.err("owner", "update_page", {"document": doc["slug"], "markdown": cur.replace(
            "Release approval", "Approval"), "base_rev": rev})
        self.assertIn("signed off by WM", t)
        t = await self.err("owner", "update_page", {"document": doc["slug"], "markdown": "# Gone\n", "base_rev": rev})
        self.assertIn("can't be removed", t)
        # replace_section: the locked section, and the section holding the block.
        self.assertIn("signed off by WM", await self.err("owner", "replace_section", {
            "document": doc["slug"], "heading": "Release 2.3", "markdown": "## Release 2.3\n\nNew.\n"}))
        self.assertIn("is locked", await self.err("owner", "replace_section", {
            "document": doc["slug"], "heading": "Release 2.3",
            "markdown": "## Release 2.3\n\nNew.\n\n" + self.block() + "\n"}))
        ok = await self.ok("owner", "replace_section", {"document": doc["slug"], "heading": "After",
                                                        "markdown": "## After\n\nRewritten.\n"})
        self.assertTrue(ok["rev"])
        # update_document (the generic tool).
        await self.err("owner", "update_document", {"document": doc["slug"], "content": "# Gone\n"})
        # append_blocks: adding after it is fine; a block copying its id gets an id of its own.
        await self.ok("owner", "append_blocks", {"document": doc["slug"], "markdown": self.block(label="Forged")})
        stored = (await self.doc(doc["slug"]))["content"]
        blocks = signoffs.blocks_of(stored)
        self.assertEqual(len(blocks), 2)
        self.assertEqual((blocks[0].id, blocks[0].label), (BID, "Release approval"))
        self.assertNotEqual(blocks[1].id, BID)
        st = {s["block"]: s for s in await self.states(doc)}
        self.assertEqual(st[BID]["option"], "Approved for production")
        self.assertIsNone(st[blocks[1].id]["option"])
        # restore_page_version to a version before the block was signed-and-shaped differently.
        await self.db[V].insert_one({"doc_id": str(doc["_id"]), "slug": doc["slug"], "n": 900, "ts": now(),
                                     "started_at": now(), "author_kind": "system", "sealed": True,
                                     "title": "T", "markdown": "# Old page\n", "sha": "x", "assets": []})
        t = await self.err("owner", "restore_page_version", {"document": doc["slug"], "version": 900})
        self.assertIn("can't be removed", t)
        self.assertIn(":::signoff", (await self.doc(doc["slug"]))["content"])

    async def test_vscode_push_refused(self):
        from app.services import document as doc_service

        doc = await self.signoff_page()
        await self.signed(doc)
        with self.assertRaises(HTTPException) as cm:
            await doc_service.sync_push(self.db, str(doc["_id"]), self.uid["owner"], "# Gone\n", "T",
                                        (await self.doc(doc["slug"]))["rev"])
        self.assertEqual(cm.exception.status_code, 423)

    async def test_clearing_unlocks(self):
        doc = await self.signoff_page()
        await self.signed(doc)
        self.refused(await self.save(doc["slug"], "owner", self.content(self.block(label="v2"))))
        e = (await self.sign(doc, "wm", None)).json()
        self.assertIsNone(e["option"])
        r = await self.save(doc["slug"], "owner", self.content(self.block(label="v2"), release="New notes."))
        self.assertEqual(r.status_code, 200, r.text)
        row = await self.db[signoffs.COLL].find_one({"block_id": BID})
        self.assertEqual([h["action"] for h in row["history"]], ["signed", "cleared"])
        # Signing again, then changing the decision: kept in the history.
        await self.signed(doc)
        await self.signed(doc, option="Not approved")
        row = await self.db[signoffs.COLL].find_one({"block_id": BID})
        self.assertEqual([h["action"] for h in row["history"]], ["signed", "cleared", "signed", "changed"])
        self.assertEqual(row["history"][-1]["was"], "Approved for production")

    async def test_admin_removal_is_recorded(self):
        doc = await self.signoff_page()
        await self.signed(doc)
        gone = self.content("The approval moved elsewhere.")
        # Members and the owner can't remove it.
        self.refused(await self.save(doc["slug"], "wm", gone), "deleted")
        self.refused(await self.save(doc["slug"], "owner", gone), "deleted")
        # The admin's states say they may.
        self.assertTrue((await self.states(doc, "wa"))[0]["can_remove"])
        self.assertFalse((await self.states(doc, "owner"))[0]["can_remove"])
        r = await self.save(doc["slug"], "wa", gone)
        self.assertEqual(r.status_code, 200, r.text)
        row = await self.db[signoffs.COLL].find_one({"block_id": BID})
        self.assertIsNone(row["option"])
        self.assertEqual((row["removed"]["by_name"], row["removed"]["option"]), ("WA", "Approved for production"))
        self.assertEqual(row["history"][-1]["action"], "removed")
        vs = await self.versions(doc)
        self.assertEqual(vs[-1]["author_kind"], "signoff")
        self.assertIn("WA removed the sign-off “Release approval”", vs[-1]["event"]["text"])
        # Put back (a restore of an older version): unsigned, editable.
        r = await self.save(doc["slug"], "owner", self.content())
        self.assertEqual(r.status_code, 200)
        self.assertIsNone((await self.states(doc))[0]["option"])
        # An admin through MCP: also recorded.
        await self.signed(doc)
        cur = await self.doc(doc["slug"])
        await self.ok("wo", "update_page", {"document": doc["slug"], "markdown": gone, "base_rev": cur["rev"]})
        row = await self.db[signoffs.COLL].find_one({"block_id": BID})
        self.assertEqual(row["removed"]["by_name"], "WO")

    async def test_history_entries(self):
        doc = await self.signoff_page()
        await self.signed(doc)
        await self.signed(doc, option="Not approved")
        await self.sign(doc, "wm", None)
        vs = [v for v in await self.versions(doc) if v["author_kind"] == "signoff"]
        self.assertEqual([v["event"]["text"] for v in vs], [
            "Signed off by WM: Approved for production",
            "WM changed their sign-off to: Not approved",
            "WM cleared their sign-off (Not approved)",
        ])
        self.assertTrue(all(v["markdown"] == doc["content"] for v in vs))
        # The list labels them so.
        r = await self.http.get(self.url(doc), headers=self.session("owner"))
        top = r.json()["versions"][0]
        self.assertEqual(top["author"]["kind"], "signoff")
        self.assertEqual(top["author"]["label"], "WM cleared their sign-off (Not approved)")
        self.assertEqual(top["event"]["action"], "cleared")
        # The same sign-off chosen twice is one event.
        await self.signed(doc)
        await self.signed(doc)
        self.assertEqual(len([v for v in await self.versions(doc) if v["author_kind"] == "signoff"]), 4)

    async def test_ids_given_on_save(self):
        doc = await self.signoff_page(content="# P\n")
        md = f'# P\n\n:::signoff{{person="{self.uid["wm"]}" label="Go"}}\n:::\n'
        cur = await self.doc(doc["slug"])
        await self.ok("owner", "update_page", {"document": doc["slug"], "markdown": md, "base_rev": cur["rev"]})
        first = (await self.doc(doc["slug"]))["content"]
        (b,) = signoffs.blocks_of(first)
        self.assertRegex(b.id, r"^b-[a-f0-9]{8}$")
        # The same text (an editor that never saw the id) gets the same id.
        r = await self.save(doc["slug"], "owner", md)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(signoffs.blocks_of((await self.doc(doc["slug"]))["content"])[0].id, b.id)
        # Too many blocks.
        many = "# P\n\n" + "\n\n".join(f':::signoff{{person="x{i}"}}\n:::' for i in range(signoffs.MAX_BLOCKS + 1))
        r = await self.save(doc["slug"], "owner", many)
        self.assertEqual((r.status_code, r.json()["code"]), (422, "too_many_signoffs"))

    async def test_a_save_prepared_before_a_signoff_cant_land_after_it(self):
        doc = await self.signoff_page()
        stale = await self.doc(doc["slug"])
        await self.signed(doc)
        with self.assertRaises(HTTPException) as cm:
            await transitions.change(self.db, stale, sets={"content": "# Gone\n"}, inc={"rev": 1},
                                     cas={"slug": stale["slug"], **signoffs.cas(stale)})
        self.assertEqual(cm.exception.status_code, 409)
        self.assertIn(":::signoff", (await self.doc(doc["slug"]))["content"])


# ── Notifications (item 9's service, when it exists) ─────────────────────────


class Notify(SignoffWorld):
    """Saves don't notify from here: notifications.on_page_saved (item 9) reads the same
    ``person`` / ``label`` attributes. The explicit helper hands on to that service."""

    async def test_helper_calls_the_service_when_present(self):
        calls = []

        async def notify(db, user_id, kind, doc, block_id, actor, extra):
            calls.append((user_id, kind, block_id, extra))

        fake = types.ModuleType("app.services.notifications")
        fake.notify = notify
        import app.services as services_pkg

        doc = await self.signoff_page()
        with mock.patch.dict(sys.modules, {"app.services.notifications": fake}), \
                mock.patch.object(services_pkg, "notifications", fake, create=True):
            self.assertTrue(await signoffs.notify_signoff_requested(self.db, doc, BID, self.uid["wm"], None,
                                                                    label="Release approval"))
        self.assertEqual(calls, [(self.uid["wm"], "signoff_requested", BID, {"label": "Release approval"})])

    async def test_blocks_keep_the_attributes_the_notifier_reads(self):
        # notifications.mentions (item 9) matches `^ {0,3}:{3,}signoff\{…\}` and reads person / label / #b-.
        import re

        doc = await self.signoff_page()
        line = next(ln for ln in doc["content"].split("\n") if ln.startswith(":::signoff"))
        self.assertRegex(line, r"^ {0,3}:{3,}signoff\{[^}\n]*\}")
        attrs = signoffs.parse_attrs(re.search(r"\{.*\}", line).group(0))
        self.assertEqual((attrs["id"], attrs["person"], attrs["label"]), (BID, self.uid["wm"], "Release approval"))
