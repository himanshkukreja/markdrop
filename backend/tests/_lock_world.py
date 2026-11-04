"""A realistic workspace for the require-sign-in (Locked) speed work.

``seed(world, n)`` files ``n`` documents into W1 — markdown, pages with
images, HTML files (single and zipped sites), PDFs and videos with posters —
about three in four of them open to anyone with the link, plus a few old
slugs. ``SlowR2`` is the in-memory R2 with production-like latency on every
network call (50–150 ms by default; ``set_public`` is two calls, a HEAD and a
self-copy, as in services/r2.py), and it leaves ``r2.set_public_prefix`` real
so a zipped site costs what it costs in production. ``slow_post`` is the
frontend's revalidate endpoint with the same latency.
"""

from __future__ import annotations

import asyncio
import random
import secrets
import threading
import time
from unittest import mock

from app.services import r2
from tests._files_env import FakeR2

# The real one (lists the prefix, then set_public per object), captured before any test patches r2.
_REAL_SET_PUBLIC_PREFIX = r2.set_public_prefix


class SlowR2(FakeR2):
    def __init__(self, lo: float = 0.05, hi: float = 0.15, seed: int = 7):
        super().__init__()
        self.lo, self.hi = lo, hi
        self._rng = random.Random(seed)
        self._lock = threading.Lock()
        self.calls = 0
        self.in_flight = 0
        self.max_in_flight = 0

    def _wait(self, n: int = 1) -> None:
        with self._lock:
            self.calls += n
            self.in_flight += 1
            self.max_in_flight = max(self.max_in_flight, self.in_flight)
            d = sum(self._rng.uniform(self.lo, self.hi) for _ in range(n))
        try:
            time.sleep(d)
        finally:
            with self._lock:
                self.in_flight -= 1

    def patches(self) -> list:
        names = ("is_configured", "head", "delete", "set_public", "list_prefix", "delete_prefix",
                 "put_bytes", "get_bytes", "copy_object", "presign_put", "presign_get", "presign_upload_part",
                 "create_multipart", "list_parts", "complete_multipart", "abort_multipart", "sha256_of")
        return [mock.patch.object(r2, n, getattr(self, n)) for n in names] + [
            mock.patch.object(r2, "set_public_prefix", _REAL_SET_PUBLIC_PREFIX)]

    def set_public(self, key, public, content_type=None, epoch=None):
        if self.fail_set_public:
            return False
        self._wait(2)  # HEAD + copy onto itself
        return super().set_public(key, public, content_type, epoch)

    def list_prefix(self, prefix, limit=1000):
        self._wait(1)
        return [k for k in list(self.objects) if k.startswith(prefix)][:limit]


def slow_post_factory(posted: list, lo: float = 0.05, hi: float = 0.15, status: int = 200, seed: int = 11):
    rng = random.Random(seed)
    state = {"in_flight": 0, "max": 0}

    async def slow_post(payload):
        state["in_flight"] += 1
        state["max"] = max(state["max"], state["in_flight"])
        try:
            await asyncio.sleep(rng.uniform(lo, hi))
        finally:
            state["in_flight"] -= 1
        posted.append(payload)
        return status

    slow_post.state = state
    return slow_post


PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32

# kind, share of the workspace
MIX = (("markdown", 0.30), ("page", 0.20), ("html", 0.12), ("site", 0.05), ("pdf", 0.16), ("video", 0.17))


async def seed(world, n: int = 300, *, ws: str = "W1", link_share: float = 0.75, images_per_page: int = 3,
               site_files: int = 6, rng_seed: int = 3) -> list[dict]:
    """``n`` documents in ``world.ws[ws]`` (an AccessWorld). Returns the rows."""
    rng = random.Random(rng_seed)
    out: list[dict] = []
    kinds: list[str] = []
    for kind, share in MIX:
        kinds += [kind] * round(n * share)
    kinds = (kinds + ["markdown"] * n)[:n]
    rng.shuffle(kinds)
    for i, kind in enumerate(kinds):
        r = rng.random()
        state = "L" if r < link_share else ("LP" if r < link_share + 0.05 else "W")
        extra: dict = {}
        if rng.random() < 0.1:
            extra["old_slugs"] = [f"old-{secrets.token_hex(4)}"]
        if kind in ("markdown", "page"):
            d = await world.mkdoc(state, ws=ws, grants=False, **extra)
            if kind == "page":
                pub = state == "L"
                for _ in range(images_per_page):
                    aid = secrets.token_hex(12)
                    key = f"pa/{d['_id']}/{aid}.png"
                    world.r2.put_bytes(key, PNG, "image/png", pub)
                    await world.db["page_assets"].insert_one({
                        "_id": aid, "doc_id": str(d["_id"]), "key": key, "mime": "image/png", "size": len(PNG),
                        "owner_id": d.get("owner_id"), "created_by": d.get("owner_id")})
        elif kind == "site":
            d = await world.mkdoc(state, ws=ws, kind="artifact", bundle=True, grants=False, **extra)
            for j in range(site_files - 2):  # mkdoc wrote index.html + app.js
                world.r2.put_bytes(f"{d['bundle_prefix']}a{j}.css", b"x", "text/css", state == "L")
        else:
            d = await world.mkdoc(state, ws=ws, kind="artifact", grants=False, **extra)
            if kind in ("pdf", "video"):
                old = d["blob_key"]
                mime = "application/pdf" if kind == "pdf" else "video/mp4"
                key = old.rsplit(".", 1)[0] + (".pdf" if kind == "pdf" else ".mp4")
                world.r2.objects[key] = {**world.r2.objects.pop(old), "content_type": mime}
                sets = {"blob_key": key, "mime": mime}
                if kind == "video":
                    poster = key + ".poster.jpg"
                    world.r2.put_bytes(poster, b"jpg", "image/jpeg", state == "L")
                    sets["poster_key"] = poster
                await world.db["documents"].update_one({"_id": d["_id"]}, {"$set": sets})
                d.update(sets)
        d["_kind"] = kind
        out.append(d)
    return out


def public_keys(world, rows: list[dict]) -> list[str]:
    """Every object of ``rows`` that the artifact Worker would serve without a token."""
    keys: list[str] = []
    ids = {str(d["_id"]) for d in rows}
    for k, o in world.r2.objects.items():
        if not o.get("public"):
            continue
        if k.startswith("pa/") and k.split("/")[1] in ids:
            keys.append(k)
            continue
        for d in rows:
            if k == d.get("blob_key") or k == d.get("poster_key") or (
                    d.get("bundle_prefix") and k.startswith(d["bundle_prefix"])):
                keys.append(k)
                break
    return keys
