"""MCP tools that add many images to a page at once: ``create_page_image_uploads``
and ``complete_page_image_uploads`` (up to 25). The file batch tools,
``create_uploads`` / ``complete_uploads``, live next to create_upload in tools.py.

Each image is an ordinary page-image upload (services/page_asset_uploads.py):
the same checks at create (type, size, the page's room) and at complete (size,
sha256, the bytes are an image, the caller may still edit the page). Per-image
results: one bad image never sinks the others.
"""

from __future__ import annotations

from fastapi import HTTPException

from app.mcp.auth import WRITE
from app.mcp.page_tools import _actx, _alt_of, _image_out, _image_page
from app.mcp.tools import _DOC_REF, Context, Tool, ToolError, _ann, _out, actor_of, http_message, jsonable
from app.services import access as access_service
from app.services import page_asset_uploads, pages, upload_batch

_SHA = {"type": "string", "pattern": "^[0-9a-fA-F]{64}$",
        "description": "Hex sha256 of the file; the upload is verified against it."}


async def create_page_image_uploads(ctx: Context, args: dict) -> tuple[str, dict]:
    images = args.get("images") or []
    if not images:
        raise ToolError("Pass images: a list of {file_name, size_bytes, sha256, …}, at most 25.")
    if len(images) > upload_batch.MAX_IMAGES:
        raise ToolError(f"At most {upload_batch.MAX_IMAGES} images per call; split the list.")
    raw = await _image_page(ctx, args["document"])
    results, entries = [], []
    for i, im in enumerate(images):
        name = (im.get("file_name") or "").strip().replace("\\", "/").rsplit("/", 1)[-1][:255]
        row = {"index": i, "file_name": name}
        if im.get("path"):
            row["path"] = im["path"]
        try:
            if not name:
                raise ToolError("file_name is missing (the image's name with its extension).")
            size = im.get("size_bytes", im.get("size"))
            if not isinstance(size, int) or size < 1:
                raise ToolError("size_bytes must be the image's exact size in bytes.")
            sess = await page_asset_uploads.create(
                ctx.db, ctx.user, raw, file_name=name, size_bytes=size, sha256=im.get("sha256") or "",
                content_type=im.get("content_type"), alt=(im.get("alt") or "").strip() or None)
            row.update(ok=True, **jsonable(await upload_batch.with_links(ctx.db, sess)))
            entries.append({"path": im.get("path") or name, **row})
        except HTTPException as exc:
            row.update(ok=False, error=http_message(exc))
        except ToolError as exc:
            row.update(ok=False, error=str(exc))
        results.append(row)
    ok = [r for r in results if r["ok"]]
    out = {"slug": raw["slug"], "uploads": results, "count": len(ok), "failed": len(results) - len(ok)}
    lines = [f"{len(ok)} of {len(results)} image upload(s) opened for {raw['slug']}."]
    lines += [f"- {r['file_name'] or '#' + str(r['index'] + 1)}: {r['error']}" for r in results if not r["ok"]]
    if ok:
        ids = ", ".join(f'"{r["upload_id"]}"' for r in ok)
        finish = f"complete_page_image_uploads with upload_ids [{ids}]"
        out["upload_ids"] = [r["upload_id"] for r in ok]
        out["script"] = upload_batch.script(entries, finish=finish)
        lines += [f"Run this shell block (each link works once, for 60 minutes), then call {finish}:", "",
                  out["script"]]
    return "\n".join(lines), out


async def complete_page_image_uploads(ctx: Context, args: dict) -> tuple[str, dict]:
    ids = upload_batch.dedupe([str(i) for i in (args.get("upload_ids") or [])])
    if not ids:
        raise ToolError("Pass upload_ids: the ids create_page_image_uploads returned.")
    if len(ids) > upload_batch.MAX_IMAGES:
        raise ToolError(f"At most {upload_batch.MAX_IMAGES} images per call; split the list.")
    actor, actx = actor_of(ctx), _actx(ctx)

    async def authorize(page: dict) -> None:
        d = await access_service.can(actor, page, "edit_content", actx)
        if not d.allowed:
            raise HTTPException(status_code=403, detail=(
                f"You can no longer add images to {page['slug']}; the image was discarded."))
        await pages.check_page_lock(page, actor, actx)

    results, lines = [], []
    for uid in ids:
        try:
            info = await page_asset_uploads.complete(ctx.db, ctx.user.id, uid, None, authorize=authorize)
        except HTTPException as exc:
            results.append({"upload_id": uid, "state": "error", "error": http_message(exc)})
            lines.append(f"- {uid}: {http_message(exc)}")
            continue
        alt = _alt_of(info.get("file_name"), info.get("alt"))
        r = {"state": "done", "upload_id": uid, **_image_out(info, info["slug"], alt)}
        results.append(r)
        lines.append(f"- {info.get('file_name') or uid}: {r['markdown']}")
    done = sum(1 for r in results if r["state"] == "done")
    out = {"results": results, "done": done, "failed": len(results) - done}
    head = (f"{done} of {len(results)} image(s) added. Put each markdown in the page where it belongs "
            "(update_page, replace_section or append_blocks), or pass an asset to set_page_properties as "
            "cover or icon:")
    return head + "\n" + "\n".join(lines), out


UPLOAD_BATCH_TOOLS = [
    Tool(
        name="create_page_image_uploads",
        title="Start many page image uploads",
        description=(
            "Add several image files (up to 25; PNG, JPEG, GIF or WebP, each up to "
            f"{page_asset_uploads.MAX_BYTES // (1024 * 1024)} MB) to one page from the machine you run shell "
            "commands on: one call here, one shell block, then one complete_page_image_uploads. Give each "
            "image's name, exact size in bytes and sha256, and optionally its local path (used in the shell "
            "block) and alt text. Returns per image upload_id and short upload link(s) (each works once, "
            "for 60 minutes), and script: the curl lines that send them all. An image that can't be added "
            "is reported with its error; the others go ahead."
        ),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": {**_DOC_REF,
                         "description": "The page to add the images to (slug or link). The user must be able to edit it."},
            "images": {"type": "array", "minItems": 1, "maxItems": 25, "description": "The images, at most 25.",
                       "items": {"type": "object", "properties": {
                           "file_name": {"type": "string", "minLength": 1, "maxLength": 255,
                                         "description": "The image's name with its extension, e.g. 'arch.png'."},
                           "size_bytes": {"type": "integer", "minimum": 1, "description": "Exact size in bytes."},
                           "size": {"type": "integer", "minimum": 1, "description": "Same as size_bytes."},
                           "sha256": _SHA,
                           "path": {"type": "string", "maxLength": 1024,
                                    "description": "Optional: its path where the shell block runs (default: file_name)."},
                           "content_type": {"type": "string", "maxLength": 100,
                                            "description": "Optional: image/png, image/jpeg, image/gif or image/webp."},
                           "alt": {"type": "string", "maxLength": 200, "description": "Optional alt text."},
                       }, "required": ["file_name", "sha256"]}},
        }, "required": ["document", "images"]},
        output_schema=_out({
            "slug": {"type": "string"},
            "uploads": {"type": "array", "items": {"type": "object", "properties": {
                "index": {"type": "integer"}, "ok": {"type": "boolean"}, "file_name": {"type": "string"},
                "upload_id": {"type": "string"}, "url": {"type": "string"}, "error": {"type": "string"},
                "parts": {"type": "array", "items": {"type": "object"}}, "expires_at": {"type": "string"},
            }, "required": ["index", "ok", "file_name"]}},
            "count": {"type": "integer"}, "failed": {"type": "integer"},
            "upload_ids": {"type": "array", "items": {"type": "string"}}, "script": {"type": "string"},
        }, ["slug", "uploads", "count", "failed"]),
        annotations=_ann(False, False, False),
        handler=create_page_image_uploads,
    ),
    Tool(
        name="complete_page_image_uploads",
        title="Finish many page image uploads",
        description=(
            "Finish image uploads started with create_page_image_uploads (or create_page_image_upload), "
            "once the shell block ran: each image's size, sha256 and type are checked and it is added to "
            "its page. Returns per image asset (asset:<id>) and markdown (![alt](asset:<id>)) to put in the "
            "page, or an error (the others are not affected). Safe to call again."
        ),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "upload_ids": {"type": "array", "minItems": 1, "maxItems": 25,
                           "items": {"type": "string", "minLength": 1, "maxLength": 64,
                                     "pattern": "^up_[A-Za-z0-9_-]+$"},
                           "description": "The upload_ids create_page_image_uploads returned (at most 25)."},
        }, "required": ["upload_ids"]},
        output_schema=_out({
            "results": {"type": "array", "items": {"type": "object", "properties": {
                "upload_id": {"type": "string"}, "state": {"type": "string"}, "asset": {"type": "string"},
                "markdown": {"type": "string"}, "error": {"type": "string"}, "slug": {"type": "string"},
            }, "required": ["upload_id", "state"]}},
            "done": {"type": "integer"}, "failed": {"type": "integer"},
        }),
        annotations=_ann(False, False, True),
        handler=complete_page_image_uploads,
    ),
]
