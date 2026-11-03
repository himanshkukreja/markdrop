"""Page images and covers from a file, never base64 (app/mcp/page_tools.py:
create_page_image_upload, complete_page_image_upload, copy_page_asset;
services/page_asset_uploads.py).

The access-policy world (tests/_access_env.py): the test MongoDB (or
mongomock) and an in-memory R2 (tests._files_env.FakeR2). Never backend/.env,
never a real bucket: a client's PUT to a presigned part URL is
``FakeR2.put_part``.
"""

from __future__ import annotations

import hashlib
import io
import os
from datetime import timedelta

from tests._access_env import now  # noqa: F401  (pins settings first)
from tests.test_pages import PageWorld, png

from app.mcp import tools as mcp_tools
from app.services import file_uploads, page_asset_uploads

MB = 1024 * 1024


def big_png(target: int = 2 * MB) -> bytes:
    """A real PNG of about ``target`` bytes (noise doesn't compress)."""
    from PIL import Image

    side = int((target / 3) ** 0.5)
    buf = io.BytesIO()
    Image.frombytes("RGB", (side, side), os.urandom(side * side * 3)).save(buf, format="PNG", compress_level=0)
    return buf.getvalue()


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class PageImageUpload(PageWorld):
    # ── MCP plumbing ──

    async def call(self, who: str, name: str, args: dict, *, write: bool = True) -> dict:
        status, res = await self.mcp_call(await self.mcp_token(who, write=write), name, args)
        self.assertEqual(status, 200)
        return res

    async def ok(self, who: str, name: str, args: dict) -> dict:
        res = await self.call(who, name, args)
        self.assertFalse(res["isError"], res["content"][0]["text"])
        return res["structuredContent"]

    async def err(self, who: str, name: str, args: dict) -> str:
        res = await self.call(who, name, args)
        self.assertTrue(res["isError"], res)
        return res["content"][0]["text"]

    async def start(self, who: str, slug: str, data: bytes, name: str = "diagram.png", **extra) -> dict:
        args = {"document": slug, "file_name": name, "size_bytes": len(data), "sha256": sha(data), **extra}
        return await self.ok(who, "create_page_image_upload", args)

    async def put(self, upload_id: str, data: bytes, part: int = 1) -> str:
        """What the curl in the instructions does: PUT the bytes to the part URL."""
        sess = await self.db["file_uploads"].find_one({"_id": upload_id})
        return self.r2.put_part(sess["r2_upload_id"], part, data)

    async def upload(self, who: str, slug: str, data: bytes, name: str = "diagram.png", **extra) -> dict:
        up = await self.start(who, slug, data, name, **extra)
        await self.put(up["upload_id"], data)
        return await self.ok(who, "complete_page_image_upload", {"upload_id": up["upload_id"]})

    def obj(self, key: str) -> dict:
        return self.r2.objects[key]

    async def rows(self) -> int:
        return await self.db["page_assets"].count_documents({})

    # ── The flow ──

    def test_catalogue(self):
        names = {t.name: t for t in mcp_tools.TOOLS}
        for n in ("create_page_image_upload", "complete_page_image_upload", "copy_page_asset"):
            self.assertIn(n, names)
            self.assertTrue(names[n].writes)
            self.assertEqual(names[n].scope, "documents:write")
        self.assertIn("create_page_image_upload", names["upload_page_image"].description)
        self.assertIn("copy_page_asset", names["set_page_properties"].description)

    async def test_a_2mb_png_becomes_an_image_and_the_cover(self):
        page = await self.mkdoc("W")
        data = big_png()
        self.assertGreater(len(data), 2 * MB - 64 * 1024)
        up = await self.start("wm", page["slug"], data, "Architecture diagram.png")
        self.assertEqual((len(up["parts"]), up["parts"][0]["part_number"], up["slug"]), (1, 1, page["slug"]))
        self.assertTrue(up["upload_id"].startswith("up_"))
        self.assertIn("curl -sS --fail -X PUT --upload-file", up["instructions"])
        self.assertIn(up["parts"][0]["url"], up["instructions"])
        self.assertIn("complete_page_image_upload", up["instructions"])
        self.assertNotIn("split", up["instructions"])
        sess = await self.db["file_uploads"].find_one({"_id": up["upload_id"]})
        self.assertEqual((sess["purpose"], sess["doc_id"]), ("page_image", str(page["_id"])))
        self.assertTrue(sess["key"].startswith(f"pa/{page['_id']}/") and sess["key"].endswith(".png"))
        # The upload is private until it is complete: no flag, and no row to mint a link from.
        self.assertFalse(self.r2.uploads[sess["r2_upload_id"]]["public"])
        self.assertEqual(await self.rows(), 0)
        # Asked again with the same arguments: the same upload, fresh URLs.
        again = await self.start("wm", page["slug"], data, "Architecture diagram.png")
        self.assertEqual(again["upload_id"], up["upload_id"])

        etag = await self.put(up["upload_id"], data)
        done = await self.ok("wm", "complete_page_image_upload",
                             {"upload_id": up["upload_id"], "parts": [{"part_number": 1, "etag": etag}]})
        aid = done["id"]
        self.assertEqual(done["asset"], f"asset:{aid}")
        self.assertEqual(done["markdown"], f"![Architecture diagram](asset:{aid})")
        self.assertEqual((done["state"], done["mime"], done["size"], done["slug"]),
                         ("done", "image/png", len(data), page["slug"]))
        self.assertEqual(done["width"], done["height"])
        row = await self.db["page_assets"].find_one({"_id": aid})
        self.assertEqual((row["doc_id"], row["key"], row["size"], row["owner_id"]),
                         (str(page["_id"]), sess["key"], len(data), self.uid["owner"]))
        self.assertEqual(self.obj(sess["key"])["data"], data)
        self.assertEqual(self.obj(sess["key"])["content_type"], "image/png")
        self.assertFalse(self.obj(sess["key"])["public"])  # a workspace page: signed links only
        # Safe to call again: the same image, nothing added.
        self.assertEqual((await self.ok("wm", "complete_page_image_upload", {"upload_id": up["upload_id"]}))["id"], aid)
        self.assertEqual(await self.rows(), 1)

        # Into the page, and as its cover.
        await self.ok("wm", "append_blocks", {"document": page["slug"], "markdown": done["markdown"]})
        props = await self.ok("wm", "set_page_properties", {"document": page["slug"], "cover": done["asset"]})
        self.assertEqual(props["properties"]["cover"], done["asset"])
        raw = await self.doc(page["slug"])
        self.assertTrue(raw["content"].startswith(f"---\ncover: asset:{aid}\n---\n"))
        self.assertIn(done["markdown"], raw["content"])
        # A reader gets the cover (and the image) through the Worker, signed for them.
        body = (await self.get(page["slug"], self.session("wv"))).json()
        self.assertEqual(body["page"]["cover"], f"asset:{aid}")
        self.assertIn(f"/r/{sess['key']}?t=", body["page"]["cover_url"])
        self.assertIn(aid, body["assets"])
        got = await self.ok("wv", "get_page", {"document": page["slug"]})
        self.assertIn(aid, [a["id"] for a in got["assets"]])
        # Someone who can't read the page learns nothing of it.
        r = await self.get(page["slug"], self.session("stranger"))
        self.assertIn(r.status_code, (401, 403, 404))
        self.assertNotIn(aid, r.text)

    async def test_public_page_image_is_public_and_jpeg_sniffed(self):
        from PIL import Image

        page = await self.mkdoc("UL")
        buf = io.BytesIO()
        Image.new("RGB", (40, 30), (1, 2, 3)).save(buf, format="JPEG")
        data = buf.getvalue()
        # Named .png, but its bytes are a JPEG: the bytes decide the type it is served with.
        done = await self.upload("owner", page["slug"], data, "photo.png", alt="Team [offsite]")
        self.assertEqual((done["mime"], done["width"], done["height"]), ("image/jpeg", 40, 30))
        self.assertEqual(done["markdown"], f"![Team offsite](asset:{done['id']})")
        key = (await self.db["page_assets"].find_one({"_id": done["id"]}))["key"]
        self.assertEqual(self.obj(key)["content_type"], "image/jpeg")
        self.assertTrue(self.obj(key)["public"])

    async def test_filename_alias_and_editor_grantee(self):
        page = await self.mkdoc("UP")
        data = png()
        up = await self.ok("ge", "create_page_image_upload", {"document": page["slug"], "filename": "x.gif",
                                                              "size_bytes": len(data), "sha256": sha(data),
                                                              "content_type": "image/png"})
        await self.put(up["upload_id"], data)
        done = await self.ok("ge", "complete_page_image_upload", {"upload_id": up["upload_id"]})
        self.assertEqual((done["mime"], done["markdown"]), ("image/png", f"![x](asset:{done['id']})"))

    # ── Refusals ──

    async def test_wrong_sha256_discards_it(self):
        page = await self.mkdoc("W")
        data = png()
        up = await self.ok("wm", "create_page_image_upload", {
            "document": page["slug"], "file_name": "a.png", "size_bytes": len(data), "sha256": sha(b"other")})
        await self.put(up["upload_id"], data)
        self.assertIn("sha256 mismatch", await self.err("wm", "complete_page_image_upload", {"upload_id": up["upload_id"]}))
        sess = await self.db["file_uploads"].find_one({"_id": up["upload_id"]})
        self.assertEqual(sess["state"], "failed")
        self.assertIsNone(self.r2.objects.get(sess["key"]))
        self.assertIn(sess["key"], self.r2.deleted)
        self.assertEqual(await self.rows(), 0)
        # Asked again: the same answer, still nothing.
        self.assertIn("sha256 mismatch", await self.err("wm", "complete_page_image_upload", {"upload_id": up["upload_id"]}))

    async def test_wrong_size_discards_it(self):
        page = await self.mkdoc("W")
        data = png()
        up = await self.start("wm", page["slug"], data, "a.png")
        await self.put(up["upload_id"], data + b"12345")
        self.assertIn(f"{len(data) + 5:,} bytes but {len(data):,} were declared",
                      await self.err("wm", "complete_page_image_upload", {"upload_id": up["upload_id"]}))
        self.assertEqual(await self.rows(), 0)

    async def test_not_an_image(self):
        page = await self.mkdoc("W")
        html = b"<html><script>alert(1)</script></html>"
        up = await self.start("wm", page["slug"], html, "a.png")
        await self.put(up["upload_id"], html)
        self.assertIn("isn't a PNG, JPEG, GIF or WebP", await self.err("wm", "complete_page_image_upload",
                                                                         {"upload_id": up["upload_id"]}))
        sess = await self.db["file_uploads"].find_one({"_id": up["upload_id"]})
        self.assertIsNone(self.r2.objects.get(sess["key"]))
        self.assertEqual(await self.rows(), 0)
        # Refused before a byte moves: an SVG by name or by type, or no image type at all.
        svg = b"<svg/>"
        for extra in ({"file_name": "a.svg"}, {"file_name": "a.png", "content_type": "image/svg+xml"},
                      {"file_name": "notes"}):
            self.assertIn("PNG, JPEG, GIF or WebP", await self.err("wm", "create_page_image_upload", {
                "document": page["slug"], "size_bytes": len(svg), "sha256": sha(svg), **extra}), extra)
        self.assertIn("file_name", await self.err("wm", "create_page_image_upload", {
            "document": page["slug"], "size_bytes": 4, "sha256": sha(b"abcd")}))

    async def test_too_large(self):
        page = await self.mkdoc("W")
        msg = await self.err("wm", "create_page_image_upload", {
            "document": page["slug"], "file_name": "huge.png", "size_bytes": 20 * MB + 1, "sha256": "a" * 64})
        self.assertIn("up to 20 MB", msg)
        self.assertEqual(await self.db["file_uploads"].count_documents({}), 0)
        # Exactly 20 MB is fine.
        await self.ok("wm", "create_page_image_upload", {
            "document": page["slug"], "file_name": "big.png", "size_bytes": 20 * MB, "sha256": "a" * 64})

    async def test_who_may_upload(self):
        page = await self.mkdoc("W", owner="wm", grants=True)
        data = png()
        args = {"document": page["slug"], "file_name": "a.png", "size_bytes": len(data), "sha256": sha(data)}
        self.assertIn("couldn't find", await self.err("stranger", "create_page_image_upload", args))
        self.assertIn("can edit", await self.err("gv", "create_page_image_upload", args))     # a reader
        self.assertIn("can edit", await self.err("wv", "create_page_image_upload", args))     # a workspace viewer
        status, _ = await self.mcp_call(await self.mcp_token("wm", write=False), "create_page_image_upload", args)
        self.assertEqual(status, 403)                                                          # a read-only token
        art = await self.mkdoc("W", kind="artifact")
        self.assertIn("not a Markdown document", await self.err("owner", "create_page_image_upload",
                                                                {**args, "document": art["slug"]}))
        self.assertEqual(await self.db["file_uploads"].count_documents({}), 0)

    async def test_someone_elses_upload_id_and_lost_access(self):
        page = await self.mkdoc("W")
        data = png()
        up = await self.start("wm", page["slug"], data, "a.png")
        await self.put(up["upload_id"], data)
        # Another account can't finish (or learn of) it.
        self.assertIn("not found", await self.err("wa", "complete_page_image_upload", {"upload_id": up["upload_id"]}))
        # Removed from the workspace between create and complete: refused, and the bytes go.
        await self.remove_member("W1", "wm")
        self.assertIn("no longer add images", await self.err("wm", "complete_page_image_upload",
                                                             {"upload_id": up["upload_id"]}))
        sess = await self.db["file_uploads"].find_one({"_id": up["upload_id"]})
        self.assertIsNone(self.r2.objects.get(sess["key"]))
        self.assertEqual(await self.rows(), 0)

    async def test_locked_page(self):
        page = await self.mkdoc("W")
        await self.ok("owner", "set_page_properties", {"document": page["slug"], "locked": True})
        data = png()
        self.assertIn("locked", await self.err("wm", "create_page_image_upload", {
            "document": page["slug"], "file_name": "a.png", "size_bytes": len(data), "sha256": sha(data)}))
        await self.upload("wa", page["slug"], data)   # a workspace admin may

    async def test_expired_upload(self):
        page = await self.mkdoc("W")
        data = png()
        up = await self.start("wm", page["slug"], data, "a.png")
        await self.put(up["upload_id"], data)
        sess = await self.db["file_uploads"].find_one({"_id": up["upload_id"]})
        self.assertAlmostEqual((sess["expires_at"] - sess["created_at"]).total_seconds(), 6 * 3600, delta=5)
        await self.db["file_uploads"].update_one({"_id": up["upload_id"]},
                                                 {"$set": {"expires_at": now() - timedelta(minutes=1)}})
        self.assertIn("expired", await self.err("wm", "complete_page_image_upload", {"upload_id": up["upload_id"]}))
        self.assertIn(sess["r2_upload_id"], self.r2.aborted)
        self.assertEqual(await self.rows(), 0)

    async def test_background_sweep_aborts_lapsed_uploads(self):
        page = await self.mkdoc("W")
        data = png()
        up = await self.start("wm", page["slug"], data, "a.png")
        keep = await self.start("wm", page["slug"], data, "b.png")
        await self.db["file_uploads"].update_one({"_id": up["upload_id"]},
                                                 {"$set": {"expires_at": now() - timedelta(minutes=1)}})
        self.assertEqual(await file_uploads.sweep_all_expired(self.db), 1)
        a = await self.db["file_uploads"].find_one({"_id": up["upload_id"]})
        self.assertEqual(a["state"], "expired")
        self.assertIn(a["r2_upload_id"], self.r2.aborted)
        self.assertEqual((await self.db["file_uploads"].find_one({"_id": keep["upload_id"]}))["state"], "uploading")

    async def test_no_parts_yet(self):
        page = await self.mkdoc("W")
        data = png()
        up = await self.start("wm", page["slug"], data, "a.png")
        self.assertIn("No part of the image", await self.err("wm", "complete_page_image_upload",
                                                             {"upload_id": up["upload_id"]}))
        # Still open: send it and finish.
        await self.put(up["upload_id"], data)
        await self.ok("wm", "complete_page_image_upload", {"upload_id": up["upload_id"]})

    async def test_upload_kinds_dont_mix(self):
        from fastapi import HTTPException

        page = await self.mkdoc("W")
        data = png()
        up = await self.start("wm", page["slug"], data, "a.png")
        with self.assertRaises(HTTPException) as cm:
            await file_uploads.complete(self.db, self.uid["wm"], up["upload_id"], None)
        self.assertEqual(cm.exception.status_code, 409)
        self.assertIn("complete_page_image_upload", cm.exception.detail)
        r = await self.http.get(f"/api/v1/files/uploads/{up['upload_id']}", headers=self.session("wm"))
        self.assertEqual(r.status_code, 409)
        # And the reverse: a file upload is not a page image.
        await self.db["file_uploads"].insert_one({
            "_id": "up_file1", "user_id": self.uid["wm"], "state": "uploading", "key": "art/x", "r2_upload_id": "r",
            "expires_at": now() + timedelta(hours=1), "part_count": 1})
        self.assertIn("complete_upload", await self.err("wm", "complete_page_image_upload", {"upload_id": "up_file1"}))
        self.assertEqual(page_asset_uploads.PURPOSE, "page_image")

    # ── Covers and copies ──

    async def test_cover_from_another_page_is_refused_until_copied(self):
        a = await self.mkdoc("W")
        b = await self.mkdoc("W")
        done = await self.upload("wm", a["slug"], png())
        self.assertIn("isn't an image of this page", await self.err("wm", "set_page_properties", {
            "document": b["slug"], "cover": done["asset"]}))
        self.assertIn("isn't an image of this page", await self.err("wm", "set_page_properties", {
            "document": b["slug"], "icon": done["asset"]}))
        copied = await self.ok("wm", "copy_page_asset", {"from_document": a["slug"], "asset": done["asset"],
                                                         "to_document": b["slug"]})
        self.assertNotEqual(copied["id"], done["id"])
        self.assertEqual((copied["slug"], copied["from_slug"], copied["from_asset"]),
                         (b["slug"], a["slug"], done["asset"]))
        self.assertEqual(copied["markdown"], f"![image](asset:{copied['id']})")
        row = await self.db["page_assets"].find_one({"_id": copied["id"]})
        self.assertTrue(row["key"].startswith(f"pa/{b['_id']}/"))
        self.assertEqual(self.obj(row["key"])["data"], png())
        await self.ok("wm", "set_page_properties", {"document": b["slug"], "cover": copied["asset"]})
        # The id alone works too, and the copy is the target's own (deleting a's image doesn't touch it).
        again = await self.ok("wm", "copy_page_asset", {"from_document": a["slug"], "asset": done["id"],
                                                        "to_document": b["slug"], "alt": "Logo"})
        self.assertEqual(again["markdown"], f"![Logo](asset:{again['id']})")

    async def test_copy_page_asset_permissions(self):
        src = await self.mkdoc("UP", owner="wm", grants=False)            # private to wm
        dst = await self.mkdoc("UP")                                       # owner's; gv reads, ge edits
        img = await self.upload("wm", src["slug"], png())
        # The caller must read the source...
        self.assertIn("couldn't find", await self.err("owner", "copy_page_asset", {
            "from_document": src["slug"], "asset": img["asset"], "to_document": dst["slug"]}))
        # ...and edit the target.
        mine = await self.upload("owner", dst["slug"], png())
        other = await self.mkdoc("UP")
        self.assertIn("can edit", await self.err("gv", "copy_page_asset", {
            "from_document": dst["slug"], "asset": mine["asset"], "to_document": other["slug"]}))
        self.assertIn("couldn't find", await self.err("stranger", "copy_page_asset", {
            "from_document": dst["slug"], "asset": mine["asset"], "to_document": other["slug"]}))
        # An asset of another page isn't the source's.
        self.assertIn("isn't an image of", await self.err("owner", "copy_page_asset", {
            "from_document": dst["slug"], "asset": img["asset"], "to_document": other["slug"]}))
        self.assertIn("asset must be", await self.err("owner", "copy_page_asset", {
            "from_document": dst["slug"], "asset": "not an id!", "to_document": other["slug"]}))
        n = await self.rows()
        # A reader of the source who edits the target may copy.
        await self.ok("ge", "copy_page_asset", {"from_document": dst["slug"], "asset": mine["asset"],
                                                "to_document": other["slug"]})
        self.assertEqual(await self.rows(), n + 1)

    async def test_base64_upload_unchanged(self):
        import base64

        page = await self.mkdoc("UP")
        out = await self.ok("owner", "upload_page_image", {"document": page["slug"], "filename": "shot [1].png",
                                                           "content_base64": base64.b64encode(png()).decode()})
        self.assertEqual(out["markdown"], f"![shot  1](asset:{out['id']})")
        self.assertIn("up to 10 MB", await self.err("owner", "upload_page_image", {
            "document": page["slug"], "filename": "a.png",
            "content_base64": "A" * (page_asset_uploads.page_assets.MAX_BYTES * 4 // 3 + 40)}))
