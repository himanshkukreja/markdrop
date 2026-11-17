"""Short upload links (services/upload_links.py).

    PUT /u/{token}    the bytes of one part of an upload: `curl -T FILE <link>`

No sign-in: the link itself is the permission, as the presigned URL it stands
for is. Handed out by the MCP tools create_uploads, create_upload,
create_page_image_upload(s) and by POST /api/v1/files/uploads/batch.
"""

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.routers.artifacts import _require_configured
from app.services import upload_links

router = APIRouter(tags=["files"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


@router.put(
    "/u/{token}",
    summary="Upload one part to a short upload link",
    responses={
        200: {"description": "Stored. Body: {ok, upload_id, file_name, part_number, part_count, size, etag}; "
                             "the ETag header carries the part's ETag too."},
        400: {"description": "Fewer bytes than the part's size arrived."},
        404: {"description": "No such link."},
        409: {"description": "The link is in use by another request."},
        410: {"description": "The link expired or was already used, or its upload ended."},
        411: {"description": "No Content-Length (a chunked or piped body)."},
        413: {"description": "More bytes than the part's size."},
        422: {"description": "A one-part upload whose bytes don't match its declared sha256."},
    },
)
@limiter.limit("600/minute")
async def put_upload_part(token: str, request: Request, db: AsyncIOMotorDatabase = Depends(get_db)):
    """The request body is the part's exact bytes, with a Content-Length (no
    chunked bodies). A link takes one part, once, within 60 minutes."""
    _require_configured()
    out = await upload_links.put(db, token[:64], request)
    return JSONResponse(out, headers={"ETag": f'"{out["etag"]}"'})
