"""Many uploads at once: one create, one shell block, one complete.

The MCP tools ``create_uploads`` / ``complete_uploads`` (files, up to
``MAX_FILES``) and ``create_page_image_uploads`` / ``complete_page_image_uploads``
(page images, up to ``MAX_IMAGES``), and ``POST /api/v1/files/uploads/batch`` (+
``/batch/complete``) for the CLI. Each file is an ordinary upload session
(services/file_uploads.py, page_asset_uploads.py) with all of its rules — type,
size, quota, workspace, folder and its default access, slug — so a batch is
only a loop with per-file results: one bad file never sinks the others.
"""

from __future__ import annotations

import asyncio
import shlex

from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.services import file_uploads, upload_links

settings = get_settings()

MAX_FILES = 50
MAX_IMAGES = 25


def dedupe(ids: list[str]) -> list[str]:
    seen: set[str] = set()
    return [i for i in ids if not (i in seen or seen.add(i))]


def duplicate_slugs(slugs: list[str | None]) -> dict[int, str]:
    """index → error, for a custom slug already asked for earlier in the batch."""
    seen: dict[str, int] = {}
    out: dict[int, str] = {}
    for i, s in enumerate(slugs):
        if not s:
            continue
        k = s.lower()
        if k in seen:
            out[i] = f"The address {s} is asked for twice in this batch (file {seen[k] + 1} has it)."
        else:
            seen[k] = i
    return out


async def with_links(db: AsyncIOMotorDatabase, session_out: dict) -> dict:
    """A session as a batch reports it: ``url`` (short link when on, else the
    presigned URL) for a one-part file, and ``parts`` with each part's link."""
    out = await upload_links.add_short_urls(db, dict(session_out, parts=[dict(p) for p in session_out["parts"]]))
    parts = [{"part_number": p["part_number"], "url": p.get("short_url") or p["url"]} for p in out["parts"]]
    res = {"upload_id": out["upload_id"], "part_size": int(out["part_size"]), "part_count": len(parts),
           "parts": parts, "expires_at": out["expires_at"]}
    if len(parts) == 1:
        res["url"] = parts[0]["url"]
    if out.get("resumed"):
        res["resumed"] = True
    return res


def script(entries: list[dict], *, finish: str) -> str:
    """One shell block that sends every file: ``entries`` are {path, upload_id,
    part_size, parts:[{part_number, url}]}. One curl per one-part file; a bigger
    file is split into parts of exactly part_size bytes first (storage wants
    every part but the last the same size). ``curl -T`` sends a Content-Length,
    which storage needs: never pipe a file in."""
    lines = ["# Run where the files are (or edit each path). Each curl prints {\"ok\":true,…} when its part is in."]
    for e in entries:
        path = shlex.quote(e["path"])
        parts = e["parts"]
        if len(parts) == 1:
            lines.append(f"curl -sS --fail-with-body -T {path} '{parts[0]['url']}'; echo")
            continue
        prefix = f"/tmp/md-{e['upload_id']}.part."
        lines.append(f"split -b {int(e['part_size'])} -d -a 4 {path} {prefix}")
        for p in parts:
            n = int(p["part_number"])
            lines.append(f"curl -sS --fail-with-body -T {prefix}{n - 1:04d} '{p['url']}'; echo")
        lines.append(f"rm -f {prefix}*")
    lines.append(f"# Then: {finish}")
    return "\n".join(lines)


async def complete_files(db: AsyncIOMotorDatabase, user_id: str, upload_ids: list[str], *,
                         wait: float | None = None) -> list[tuple[str, int, dict]]:
    """Complete every file upload: start all their checks, then wait for them
    together (up to ``file_complete_wait_seconds``). (upload_id, HTTP status,
    body) per id, in order: 200 result, 202 still verifying, else an error."""
    results: dict[str, tuple[int, dict]] = {}
    for uid in upload_ids:
        try:
            missing = await _missing_parts(db, user_id, uid)
            if missing:
                results[uid] = (400, {"state": "uploading", "detail": missing})
                continue
            results[uid] = await file_uploads.complete(db, user_id, uid, None, wait=0)
        except HTTPException as exc:
            results[uid] = (exc.status_code, {"detail": exc.detail})
    running = [file_uploads._RUNNING[u] for u, (st, _b) in results.items()
               if st == 202 and u in file_uploads._RUNNING]
    if running:
        timeout = settings.file_complete_wait_seconds if wait is None else wait
        await asyncio.wait(running, timeout=timeout)
    for uid, (st, _b) in list(results.items()):
        if st == 202:
            sess = await db[file_uploads.SESSIONS].find_one({"_id": uid})
            if sess is not None:
                results[uid] = file_uploads.respond(sess)
    return [(uid, *results[uid]) for uid in upload_ids]


async def _missing_parts(db: AsyncIOMotorDatabase, user_id: str, upload_id: str) -> str | None:
    """Why an upload still waiting for bytes can't be completed yet, or None.
    Completing it anyway would fail the session; this leaves it open, so the
    curl lines can still run and the same call can be made again."""
    sess = await file_uploads.load(db, user_id, upload_id)
    if sess["state"] != "uploading":
        return None
    have = {p["part_number"] for p in await file_uploads._list_parts(sess, db)}
    if sess["state"] != "uploading":  # storage forgot it: complete says so
        return None
    count = int(sess["part_count"])
    if len(have) >= count:
        return None
    gone = [n for n in range(1, count + 1) if n not in have]
    return (f"Waiting for the bytes: {len(have)} of {count} part(s) of {sess['file_name']} have arrived "
            f"(missing part(s) {gone[:10]}). Run its curl line(s), then call this again; the upload stays open.")
